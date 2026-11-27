import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => { const rel = relative(parent, child); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
const plainMessage = (row) => ({ role: row.role, content: row.content });
const positive = (value) => Number.isSafeInteger(value) && value > 0;
function assertOwnedTree(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !within(root, realpathSync(path))) throw Error('sandbox-linked-entry');
    if (stat.isDirectory()) assertOwnedTree(path);
  }
}

/** Read only the named program modules, not the user's deployment or memory. */
export async function loadCooNativeBindings(sourceRoot) {
  const root = realpathSync(sourceRoot);
  const paths = ['bots/cormini/persona/persona.ts', 'bots/cormini/persona/memory.ts', 'bots/cormini/persona/handoffNote.ts',
    'src/core/loop.ts', 'src/core/session.ts', 'src/protocol/open-responses/context.ts', 'src/core/util.ts'];
  const files = paths.map((name) => ({ name, sha256: hash(readFileSync(join(root, name))) }));
  const load = (name) => import(pathToFileURL(join(root, name)).href);
  const [{ Cormini }, { MainLoop }, { SessionLog }, { message }, { textOf }, { estimateMessagesTokens }] = await Promise.all([
    load(paths[0]), load(paths[3]), load(paths[4]), load(paths[5]), load('src/protocol/open-responses/context-helpers.ts'), load(paths[6]),
  ]);
  if (![Cormini, MainLoop, SessionLog, message, textOf, estimateMessagesTokens].every((item) => typeof item === 'function')) throw Error('native-bindings-unavailable');
  return { Cormini, MainLoop, SessionLog, message, textOf, estimateMessagesTokens,
    source: { id: 'coo-cormini-source', name: 'COO 原生 Cormini / MainLoop', fingerprint: hash(JSON.stringify(files)), files } };
}

/** Dedicated controller-owned storage. No method accepts a deployment or formal memory path. */
export function createCooNativeHost({ Native, dataDir, runtime, transport = null, inventory = null, memoryAdapters = [] }) {
  if (!Native?.source?.fingerprint || !dataDir || typeof runtime !== 'function') throw Error('invalid-native-host');
  const dataRoot = realpathSync(dataDir);
  const checkupRoot = resolve(dataRoot, 'self-checkup');
  if (existsSync(checkupRoot) && lstatSync(checkupRoot).isSymbolicLink()) throw Error('scratch-root-is-link');
  mkdirSync(checkupRoot, { recursive: true });
  const configuredRoot = resolve(checkupRoot, 'cooperative-scratch');
  mkdirSync(configuredRoot, { recursive: true });
  if (lstatSync(configuredRoot).isSymbolicLink()) throw Error('scratch-root-is-link');
  const parent = realpathSync(configuredRoot);
  if (memoryAdapters.some((a) => !a?.id || a.id === 'coo-native' || typeof a.createIsolated !== 'function')) throw Error('invalid-memory-adapter');
  const adapterIds = memoryAdapters.map((a) => a.id);
  if (new Set(adapterIds).size !== adapterIds.length) throw Error('duplicate-memory-adapter');
  let cleanupFault = false;

  function inspect() {
    const raw = runtime();
    const policy = { stageTokens: raw?.stageTokens, softRatio: raw?.softRatio, keepRatio: raw?.keepRatio };
    if (!positive(policy.stageTokens) || policy.stageTokens > 2_000_000
      || !(policy.softRatio > 0 && policy.softRatio < 1) || !(policy.keepRatio > 0 && policy.keepRatio <= 1)) throw Error('runtime-policy-unavailable');
    const model = transport?.inspect?.() ?? null;
    const modelReady = !!model && typeof model.model === 'string' && !!model.model && positive(model.contextWindow) && positive(model.maxOutputTokens)
      && model.contextWindow > model.maxOutputTokens && typeof model.fingerprint === 'string' && !!model.fingerprint
      && model.counting === 'exact' && typeof model.dataScope === 'string' && !!model.dataScope
      && model.singleAttempt === true && model.noTools === true && model.noImplicitPrompts === true
      && typeof transport.countMessages === 'function' && typeof transport.complete === 'function';
    const publicRuntime = { ...policy, origin: raw.origin === 'live-host' ? 'live-host' : 'example-policy',
      softTokens: Math.floor(policy.stageTokens * policy.softRatio), noteBudgetTokens: Math.floor(policy.stageTokens * policy.keepRatio),
      model: modelReady ? String(model.model).slice(0, 100) : '未接入模型执行器',
      modelInputLimit: modelReady ? model.contextWindow - model.maxOutputTokens : null,
      maxOutputTokens: modelReady ? model.maxOutputTokens : null };
    return { ready: !cleanupFault, blocker: cleanupFault ? 'cleanup-unverified' : null, modelReady, runtime: publicRuntime, source: Native.source,
      fingerprint: hash(JSON.stringify({ publicRuntime, source: Native.source.fingerprint, model: model?.fingerprint ?? null,
        adapters: memoryAdapters.map(({ id, name, version }) => ({ id, name, version })) })),
      inventoryAvailable: typeof inventory === 'function',
      dataScope: modelReady ? String(model.dataScope ?? '').slice(0, 1600) : '仅本机合成测试，无模型请求。',
      isolation: { dedicatedStorage: true, formalSessionAccess: false, externalTools: false },
      memoryTargets: [{ id: 'coo-native', name: 'COO 原生工作区记忆', version: Native.source.fingerprint.slice(0, 12),
        testLevel: 'storage-api', scope: '独立工作区内的存储接口生命周期；不证明模型自主检索。' },
      ...memoryAdapters.map(({ id, name, version }) => ({ id, name: String(name ?? id).slice(0, 100), version: String(version ?? 'unknown').slice(0, 50),
        testLevel: 'adapter-api', scope: '仅适配器的隔离测试空间；不推断当前主会话正在使用。' }))] };
  }

  async function readInventory() {
    if (!inventory) return { status: 'unavailable', rows: [], detail: 'COO 未向此桥接提供扩展清单接口；无法判断安装情况。' };
    const rows = await inventory();
    if (!Array.isArray(rows) || rows.length > 500) throw Error('invalid-inventory');
    // Fixed projection: never return settings, paths, raw manifests or memory bodies.
    return { status: 'read', rows: rows.map((r) => ({ id: String(r.id ?? '').slice(0, 100), name: String(r.name ?? r.id ?? '').slice(0, 100),
      kind: String(r.kind ?? 'unknown').slice(0, 40), version: String(r.version ?? 'unknown').slice(0, 50),
      enabled: typeof r.enabled === 'boolean' ? r.enabled : null })), detail: '安装、启用、当前使用及实际测试是不同事实；清单不能证明记忆调用链。' };
  }

  async function open(runId) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw Error('invalid-run-id');
    const dir = mkdtempSync(join(parent, 'coo-test-'));
    const ownership = { runId, nonce: randomUUID() };
    writeFileSync(join(dir, '.checkup-owner.json'), JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
    let closed = false;
    function guard() {
      if (closed || !within(parent, dir) || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) throw Error('sandbox-ownership-lost');
      const current = JSON.parse(readFileSync(join(dir, '.checkup-owner.json'), 'utf8'));
      if (current.nonce !== ownership.nonce || current.runId !== runId) throw Error('sandbox-ownership-lost');
    }
    const policy = inspect().runtime;
    const adapterCleanup = new Map();
    const makePersona = (memoryDir) => new Native.Cormini({ memoryDir, orientation: '隔离合成体检角色；没有真实用户资料。',
      seedConstitution: '# 隔离合成测试\n仅用于本次测试。', worlds: [], context: () => ({ maxTokens: policy.stageTokens,
        softRatio: policy.softRatio, keepRatio: policy.keepRatio, firstTurn: false }) });
    return {
      async handoff(scenario, { signal } = {}) {
        guard(); signal?.throwIfAborted();
        if (!/^handoff-(begin|middle|end)$/.test(scenario.id)) throw Error('invalid-scenario');
        const caseDir = join(dir, scenario.id); mkdirSync(caseDir, { recursive: false });
        const persona = makePersona(join(caseDir, 'memory'));
        const session = new Native.SessionLog(caseDir, 'session-test.jsonl');
        const pending = [], boundaries = [], warnings = [];
        const log = { warn: (name) => warnings.push(String(name).slice(0, 120)), error: (name) => warnings.push(String(name).slice(0, 120)), emit() {}, info() {}, debug() {} };
        persona.attach({ toolsTagged: () => new Set(), injectInternal: (text) => pending.push(Native.message('user', text)),
          injectExternal: (text) => pending.push(Native.message('user', text)), log });
        const records = scenario.messages.map((m) => Native.message(m.role, m.content));
        session.reset([Native.message('system', '隔离体检合成任务；不调用任何工具。'), ...records]);
        const before = session.records.length;
        const state = { data: {}, save() {} };
        const loop = new Native.MainLoop({ cfg: { timezone: 'UTC', context: { keepPastThinking: false } }, persona,
          decl: { tools: () => [] }, spec: () => ({ model: 'mechanism-only' }),
          context: { hardTokens: () => null, estimateTokens: Native.estimateMessagesTokens },
          worlds: { all: () => [], visible: () => [] }, session, state, log,
          transcript: { boundary: (type, summary) => boundaries.push({ type, summary }) }, onWorldFailed() {},
          // A handoff must never invoke the model or external bus in this harness.
          llm: { generate() { throw Error('unexpected-native-model-call'); } } });
        await loop.handoffContext();
        signal?.throwIfAborted(); guard();
        const resetObserved = session.records.length < before;
        for (const entry of pending) session.append(entry);
        const after = session.records.map((entry) => ({ role: entry.item.role ?? 'user', content: Native.textOf(entry) }));
        const text = after.map((entry) => entry.content).join('\n');
        const checks = Object.fromEntries(Object.entries(scenario.expected).map(([key, value]) => [key, text.includes(value)]));
        return { beforeMessages: scenario.messages.map(plainMessage), afterMessages: after,
          evidence: { route: 'MainLoop.handoffContext → Cormini.onHandoff → SessionLog.reset', sourceFingerprint: Native.source.fingerprint,
            resetObserved, boundaryObserved: boundaries.some((r) => r.type === 'handoff'), injectionCount: pending.length,
            facts: checks, warningCount: warnings.length, trigger: 'explicit-test-handoff', automaticThresholdTested: false,
            beforeCount: before, afterCount: session.records.length,
            counting: 'COO 原生估算，仅用于机制观察，不是模型服务计量。' } };
      },
      async memoryLifecycle(targetId, { signal } = {}) {
        guard(); signal?.throwIfAborted();
        const target = inspect().memoryTargets.find((r) => r.id === targetId);
        if (!target) throw Error('unknown-memory-target');
        const itemDir = join(dir, `memory-${hash(targetId).slice(0, 16)}`); mkdirSync(itemDir);
        const key = `synthetic-${randomUUID()}.txt`, first = `first-${randomUUID()}`, second = `updated-${randomUUID()}`;
        let adapter, cleanup = false;
        const steps = [];
        try {
          if (targetId === 'coo-native') {
            let persona = makePersona(itemDir);
            adapter = { write: (k, v) => persona.memory.writeFileAtomic(k, v), read: (k) => persona.memory.walkFiles().includes(k) ? persona.memory.readFile(k) : null,
              remove: (k) => persona.memory.deleteFile(k), reconnect: () => { persona = makePersona(itemDir); },
              cleanup: () => { if (persona.memory.walkFiles().includes(key)) persona.memory.deleteFile(key); } };
          } else {
            const spec = memoryAdapters.find((r) => r.id === targetId);
            adapterCleanup.set(targetId, false);
            adapter = await spec.createIsolated({ directory: itemDir, namespace: runId, signal });
            if (!adapter || !['write', 'read', 'remove', 'reconnect', 'cleanup', 'verifyIsolation'].every((k) => typeof adapter[k] === 'function')) throw Error('memory-isolation-unavailable');
            const isolation = await adapter.verifyIsolation();
            if (isolation?.verified !== true || isolation.namespace !== runId || isolation.formalMemoryAccessible !== false) throw Error('memory-isolation-unavailable');
          }
          steps.push({ id: 'negative-control', pass: await adapter.read(key) === null });
          signal?.throwIfAborted(); await adapter.write(key, first);
          steps.push({ id: 'write-read', pass: await adapter.read(key) === first });
          await adapter.reconnect();
          steps.push({ id: 'reopen-read', pass: await adapter.read(key) === first });
          signal?.throwIfAborted(); await adapter.write(key, second); await adapter.reconnect();
          const updated = await adapter.read(key);
          steps.push({ id: 'update-read', pass: updated === second && updated !== first });
          await adapter.remove(key); await adapter.reconnect();
          steps.push({ id: 'delete-read', pass: await adapter.read(key) === null });
        } finally {
          if (adapter) {
            const receipt = await adapter.cleanup();
            cleanup = await adapter.read(key) === null && (targetId === 'coo-native' || receipt?.verified === true && receipt.namespace === runId);
            if (targetId !== 'coo-native') adapterCleanup.set(targetId, cleanup);
          }
        }
        return { target: targetId, route: targetId === 'coo-native' ? 'Cormini.memory / GitWorkspaceMemory' : 'explicit-isolated-adapter',
          steps, cleanupVerified: cleanup, testLevel: target.testLevel, autonomousModelRetrievalTested: false };
      },
      async cleanup() {
        guard();
        assertOwnedTree(dir);
        // Exact owned directory only; verify absolute path and owner before recursive deletion.
        rmSync(dir, { recursive: true, force: false });
        closed = true;
        const adaptersVerified = [...adapterCleanup.values()].every((value) => value === true);
        return { status: existsSync(dir) || !adaptersVerified ? 'unverified' : 'verified', adapterReceipts: Object.fromEntries(adapterCleanup),
          scope: '本次独立本地测试目录及适配器本次命名空间的清理回执；不代表远端副本已全局删除。' };
      },
    };
  }

  async function measureHandoff(scenario) {
    const session = await open(`preflight-${randomUUID()}`);
    try {
      const result = await session.handoff(scenario);
      return { beforeMessages: [...scenario.messages.map(plainMessage), { role: 'user', content: scenario.question }],
        afterMessages: [...result.afterMessages.map(plainMessage), { role: 'user', content: scenario.question }],
        evidence: { route: result.evidence.route, sourceFingerprint: result.evidence.sourceFingerprint, noteTokens: result.evidence.counting } };
    } finally {
      try { const result = await session.cleanup(); if (result.status !== 'verified') { cleanupFault = true; throw Error('cleanup-unverified'); } }
      catch (failure) { cleanupFault = true; throw failure; }
    }
  }

  return { inspect, open, readInventory, measureHandoff,
    countMessages: async (messages) => {
      if (!inspect().modelReady) throw Error('model-transport-unavailable');
      return transport.countMessages(messages.map(plainMessage));
    },
    complete: async ({ messages, maxOutputTokens, inputTokenCap, signal, requestId }) => {
      const status = inspect();
      if (!status.modelReady || !status.dataScope || !positive(maxOutputTokens) || maxOutputTokens > status.runtime.maxOutputTokens) throw Error('model-transport-unavailable');
      const clean = messages.map((m) => {
        if (!['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw Error('invalid-model-message');
        return plainMessage(m);
      });
      const counted = await transport.countMessages(clean);
      if (!positive(counted) || counted > inputTokenCap || counted > status.runtime.modelInputLimit) throw Error('request-input-limit');
      signal.throwIfAborted();
      // Deliberately no tool schemas, conversation IDs, real memory access, or retry loop.
      return transport.complete({ messages: clean, maxOutputTokens, inputTokenCap, signal, requestId });
    },
  };
}
