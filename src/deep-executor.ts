import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readJsonFile } from './deployment.mjs';
export interface DeepExecutor {
  /** Local inspection only: no model requests, secrets, user history or writes. */
  inspect(): {
    model: string;
    endpoint?: string;
    blockers?: string[];
    /** Must cover provider, model, effective prompts, pricing and adapter configuration. */
    fingerprint: string;
    contextWindow: number;
    capabilities: {
      isolated: true;
      noTools: true;
      noMemoryWrites: true;
      singleAttempt: true;
      hardLimits: true;
      usage: true;
      abort: true;
    };
    /** Complete, user-readable description including any adapter-added system prompts. */
    dataScope: string;
  };
  /** No network/model calls. Include all provider overhead; reject cases that cannot fit. */
  reserve(testCase: unknown): {
    inputTokens: number;
    outputTokens: number;
    maxCostCny: number;
    /** Optional latency estimate from matching real samples, never a fabricated default. */
    durationMs?: [number, number];
  };
  /** One billable attempt only. Honor caps, isolation and cancellation, including SDK retries. */
  execute(input: {
    runId: string;
    testCase: unknown;
    reservation: { inputTokens: number; outputTokens: number; maxCostCny: number };
    signal: AbortSignal;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costCny: number;
    /** Include failed attempts in accounting. False means transport/provider failure, not a wrong answer. */
    ok: boolean;
  }>;
}

export function resolveCheckupHome(dataDir: string, homeDir?: string): string {
  const hasCfg = (dir: string) => {
    try { return Boolean(dir) && existsSync(join(dir, 'companion', 'config.json')); } catch { return false; }
  };
  if (homeDir && hasCfg(resolve(homeDir))) return resolve(homeDir);
  for (let dir = resolve(dataDir); ; dir = dirname(dir)) {
    if (hasCfg(dir)) return dir;
    const siblingHome = join(dirname(dir), 'home');
    if (siblingHome !== dir && hasCfg(siblingHome)) return siblingHome;
    if (dirname(dir) === dir) break;
  }
  const envCandidates = [process.env.COO_HOME, process.env.CORTICO_HOME].filter((d): d is string => Boolean(d)).map((d) => resolve(d));
  const osCandidates = [
    join(homedir(), '.coo'),
    join(homedir(), '.cortico'),
    join(homedir(), 'Library', 'Application Support', 'Coopanion', 'home'),
    join(homedir(), 'Library', 'Application Support', 'Cortico', 'home'),
    join(homedir(), '.config', 'coopanion', 'home'),
    join(homedir(), '.local', 'share', 'coopanion', 'home'),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'Coopanion', 'home'), join(process.env.APPDATA, 'Cortico', 'home')] : []),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Coopanion', 'home')] : []),
  ];
  const found = [...envCandidates, ...osCandidates].find(hasCfg);
  if (found) return resolve(found);
  return resolve(homeDir || process.env.COO_HOME || process.env.CORTICO_HOME || dataDir);
}

type IsolatedCase = { messages: Array<{ role: string; content: string }>; maxOutputTokens: number };

export function createBuiltinIsolatedExecutor({ dataDir, homeDir }: { dataDir: string; homeDir?: string }): DeepExecutor {
  const home = resolveCheckupHome(dataDir, homeDir);
  const capabilities = { isolated: true, noTools: true, noMemoryWrites: true, singleAttempt: true, hardLimits: true, usage: true, abort: true } as const;
  const dataScope = '仅发送本次合成测试消息；无附加系统提示、工具、主会话或持久化记忆读写；单次请求，无重试。Token 按 UTF-8 字节保守预留；费用未知，0 仅为记账占位，不代表免费或费用上限。';
  function config() {
    let companion;
    try { companion = readJsonFile(join(home, 'companion', 'config.json')); } catch { throw Error('companion-config-unavailable'); }
    const provider = companion?.activeProvider;
    if (typeof provider !== 'string' || !provider || !/^[\w.-]+$/.test(provider) || provider === '.' || provider === '..') throw Error('provider-unavailable');
    const dir = join(home, 'providers', provider);
    let value;
    try { value = readJsonFile(join(dir, 'config.json')); } catch { throw Error('provider-config-unavailable'); }
    const model = value?.spec?.model;
    if (typeof model !== 'string' || !model.trim()) throw Error('provider-model-unavailable');
    let endpoint: URL;
    try {
      endpoint = new URL(value.baseUrl);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error();
      const rawPath = endpoint.pathname.replace(/\/+$/, '');
      const kind = String(value.kind ?? '').toLowerCase();
      if (kind === 'anthropic' || /anthropic\.com$/i.test(endpoint.hostname) || (/\/v1beta$/i.test(rawPath) && !/openai/i.test(rawPath))) {
        throw Error('provider-protocol-unsupported');
      }
      endpoint.pathname = /\/chat\/completions$/.test(rawPath) ? rawPath : `${rawPath || '/v1'}/chat/completions`;
    } catch (e) {
      if (e instanceof Error && e.message === 'provider-protocol-unsupported') throw e;
      throw Error('provider-endpoint-unavailable');
    }
    let secret = typeof value.secret === 'string' ? value.secret.trim() : '';
    const readEnvKey = (filePath: string, keyName: string): string => {
      try {
        const env = readFileSync(filePath, 'utf8');
        const match = env.match(new RegExp(`^\\s*(?:export\\s+)?${keyName}\\s*=\\s*(.*)$`, 'm'));
        const raw = match?.[1]?.trim() ?? '';
        return (raw.startsWith('"') || raw.startsWith("'")) ? raw.match(/^(["'])(.*?)\1(?:\s*#.*)?$/)?.[2] ?? '' : raw.replace(/\s+#.*$/, '').trim();
      } catch { return ''; }
    };
    const resolveEnvName = (keyName: string): string =>
      readEnvKey(join(dir, '.env'), keyName) || readEnvKey(join(home, 'companion', '.env'), keyName) || (process.env[keyName]?.trim() ?? '');
    if (secret && /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(secret)) {
      const resolved = resolveEnvName(secret);
      if (resolved) secret = resolved;
    }
    if (!secret) {
      for (const key of ['API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
        secret = resolveEnvName(key);
        if (secret) break;
      }
    }
    if (!secret || /[\r\n]/.test(secret)) throw Error('provider-key-unavailable');
    const rawWindow = value.spec.contextWindow ?? companion?.context?.targetTokens ?? companion?.context?.maxTokens ?? companion?.context?.budget ?? 128000;
    const contextWindow = Number(rawWindow);
    const maxTokens = Number(value.spec.maxTokens ?? 8192);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 512) throw Error('context-window-unavailable');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw Error('provider-output-limit-unavailable');
    const fingerprint = createHash('sha256').update(JSON.stringify({ provider, model, endpoint: endpoint.href, contextWindow, maxTokens, secret, dataScope })).digest('hex');
    return { model, endpoint, secret, contextWindow, maxTokens, fingerprint };
  }
  function reserve(testCase: unknown, settings = config()) {
    const value = testCase as IsolatedCase;
    if (!Array.isArray(value?.messages) || !value.messages.length || value.messages.some((row) => !['system', 'user', 'assistant'].includes(row.role) || typeof row.content !== 'string')) throw Error('invalid-test-case');
    const outputTokens = value.maxOutputTokens;
    const inputTokens = 32 + value.messages.reduce((total, row) => total + 16 + Buffer.byteLength(row.role + row.content, 'utf8'), 0);
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > settings.maxTokens || inputTokens + outputTokens > settings.contextWindow) throw Error('reservation-or-context-unavailable');
    return { inputTokens, outputTokens, maxCostCny: 0 };
  }
  return {
    inspect() {
      try {
        const value = config();
        return { model: value.model, endpoint: value.endpoint.hostname, contextWindow: value.contextWindow, fingerprint: value.fingerprint, capabilities, dataScope };
      } catch (error) {
        return { model: '', contextWindow: 0, fingerprint: '', capabilities, dataScope,
          blockers: [error instanceof Error ? error.message : 'provider-config-unavailable'] };
      }
    },
    reserve,
    async execute({ testCase, reservation, signal }) {
      const settings = config();
      const required = reserve(testCase, settings);
      if (required.inputTokens > reservation.inputTokens || required.outputTokens !== reservation.outputTokens || reservation.maxCostCny < 0) throw Error('reservation-or-context-unavailable');
      signal.throwIfAborted();
      const response = await fetch(settings.endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.secret}` },
        body: JSON.stringify({ model: settings.model, messages: (testCase as IsolatedCase).messages.map(({ role, content }) => ({ role, content })), max_tokens: required.outputTokens, stream: false }),
      });
      let value;
      try { value = await response.json(); } catch { throw Error('provider-response-invalid'); }
      const usage = value?.usage;
      const text = value?.choices?.[0]?.message?.content;
      const clientRejected = !response.ok && [400, 401, 403, 404].includes(response.status);
      const inTok = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : (clientRejected ? 0 : NaN);
      const outTok = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : (clientRejected ? 0 : NaN);
      return { ok: response.ok && typeof text === 'string', text: typeof text === 'string' ? text : '',
        inputTokens: inTok, outputTokens: outTok, costCny: 0 };
    },
  };
}
