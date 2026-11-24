/**
 * 体检报告（World）—— 薄装配层。
 *
 * 两块分开算，永不合并：
 *   · 硬件健康：六维评分，纯本地统计，零模型。
 *   · 人格测试：她自己答题出四字母，再用真实行为痕迹交叉验证。
 *
 * 边界：
 *   · 只读。除 dataDir/self-checkup/ 之外不写任何路径。
 *   · 本地汇总；仅借宿主可选的 Persona 认知接口润色画像，不直连服务或读取凭据。
 */
import type { Language } from 'cortico/core/language.ts';
import type {
  ToolDef, World, WorldHost, WorldWebUiDecl, RunPhase, IncompleteTurnContext,
} from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadBotDefaults } from './deployment.mjs';

import { collectAll } from './collect.mjs';
import { buildReport, reportToText } from './report.mjs';
import { loadQuiz, scoreQuiz } from './quiz.mjs';
import { TOOL_SCHEMAS, makeToolHandlers, QUIZ_TOOL, SUBMIT_TOOL } from './tools.mjs';
import { pick } from './text.mjs';
import { readProfileCopy } from './profile.mjs';
import { cardPrompt } from './card-profile.mjs';

export const CHECKUP_ID = 'self-checkup';

export interface CheckupSection {
  enabled: boolean;
  sampleDays?: number;
  quizEnabled?: boolean;
}

export const CHECKUP_DEFAULTS: CheckupSection = { enabled: false, sampleDays: 7, quizEnabled: true };

type Snapshot = ReturnType<typeof collectAll>;

interface QuizState {
  batch1?: { answers: { id: string; option: string }[]; at: number };
  batch2?: { answers: { id: string; option: string }[]; at: number };
  result?: Record<string, unknown> | null;
  takenAt?: number;
  creative?: Record<string, unknown>;
  creativeAt?: number;
  creativeRequestedAt?: number;
  profileCard?: Partial<Record<'zh' | 'en', { key: string; copy: { title: string; label: string; description: string; tags: string[] } }>>;
}

const CACHE_TTL_MS = 60_000;
const MIN_GAP_MS = 24 * 3600_000;

export class CheckupWorld implements World {
  readonly id = CHECKUP_ID;
  private host: WorldHost | null = null;
  private readonly cfg: CheckupSection;
  private readonly botDir: string;
  private readonly dataDir: string;
  private readonly memoryDir: string;
  private readonly botName: string;
  private readonly packageDir?: string;
  private botDefaults?: { context?: unknown; rounds?: unknown; paths?: unknown };
  private readonly timezone?: string;
  private readonly profileCopyCache = new Map<string, { key: string; copy: Promise<unknown> }>();
  private readonly stateDirOverride: string | null;
  private cache: { snapshot: Snapshot | null; at: number; key: string } = { snapshot: null, at: 0, key: '' };
  private quiz: QuizState = {};
  private creativePending = false;
  private readonly live = {
    phases: 0,
    backoffs: 0,
    handoffs: 0,
    truncations: 0,
    lastState: 'idle',
    lastAt: 0,
    toolCalls: new Map<string, number>(),
  };

  constructor(opts: {
    cfg: CheckupSection;
    botDir: string;
    dataDir: string;
    memoryDir: string;
    botName?: string;
    packageDir?: string;
    timezone?: string;
    /** 覆盖状态目录，仅供测试/冒烟用；正常装配不传，落 dataDir/self-checkup。 */
    stateDirOverride?: string;
  }) {
    this.cfg = opts.cfg;
    this.botDir = opts.botDir;
    this.dataDir = opts.dataDir;
    this.memoryDir = opts.memoryDir;
    this.botName = opts.botName ?? '';
    this.packageDir = opts.packageDir;
    this.timezone = opts.timezone;
    this.stateDirOverride = opts.stateDirOverride ?? null;
  }

  /* ------------------------------------------------------------- 生命周期 */

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    try {
      this.botDefaults = await loadBotDefaults(this.packageDir, this.botDir);
    } catch {
      // 默认值不可用时，部署覆盖和其它报告来源仍能使用。
      this.botDefaults = undefined;
    }
    this.quiz = this.loadQuizState();
    host.log.info('体检报告已挂载', { sampleDays: this.sampleDays(), quizTaken: !!this.quiz.takenAt });
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  /** 契约要求：同步、零耗时。只记内存，不碰磁盘。 */
  onRunPhase(phase: RunPhase): void {
    this.live.phases += 1;
    const prev = this.live.lastState;
    if (phase.state === 'backoff' && prev !== 'backoff') this.live.backoffs += 1;
    if (phase.state === 'handoff' && prev !== 'handoff') this.live.handoffs += 1;
    this.live.lastState = phase.state;
    this.live.lastAt = Date.now();
    for (const name of phase.running ?? []) {
      this.live.toolCalls.set(name, (this.live.toolCalls.get(name) ?? 0) + 1);
    }
  }

  onTurnEnded(context?: IncompleteTurnContext): void {
    if (context?.kind === 'response-incomplete') this.live.truncations += 1;
  }

  /* ------------------------------------------------------------- 采集 */

  private sampleDays(): number {
    const n = Number(this.cfg?.sampleDays);
    return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.round(n) : 7;
  }

  /** 快照按关键文件的 size+mtime 做键，60 秒内或键未变就复用。 */
  private snapshot(): Snapshot {
    const now = Date.now();
    const key = this.cacheKey();
    if (this.cache.snapshot && now - this.cache.at < CACHE_TTL_MS && this.cache.key === key) {
      return this.cache.snapshot;
    }
    const snap = collectAll({
      botDir: this.botDir,
      dataDir: this.dataDir,
      memoryDir: this.memoryDir,
      sampleDays: this.sampleDays(),
      timezone: this.timezone,
      botDefaults: this.botDefaults,
    });
    this.cache = { snapshot: snap, at: now, key };
    return snap;
  }

  private cacheKey(): string {
    const logDir = this.cache.snapshot?.memory?.path ?? join(this.memoryDir, 'memory');
    const paths = [
      join(this.dataDir, 'usage.jsonl'),
      join(logDir, 'entries.jsonl'),
      join(logDir, 'retrieve.jsonl'),
      join(logDir, 'decisions.jsonl'),
      join(logDir, 'emotions.jsonl'),
      join(this.botDir, 'config.json'),
    ];
    return paths.map((p) => {
      try {
        const st = statSync(p);
        return `${st.size}:${Math.round(st.mtimeMs)}`;
      } catch {
        return 'x';
      }
    }).join('|');
  }

  private contextWindow(): number | null {
    try {
      const w = this.host?.modelFacts?.contextWindow?.();
      return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
    } catch {
      return null;
    }
  }

  private modelName(): string | null {
    try {
      return this.host?.modelFacts?.model?.() ?? null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- 人格状态 */

  private stateDir(): string {
    if (this.stateDirOverride) return this.stateDirOverride;
    return join(this.dataDir, 'self-checkup');
  }

  private stateFile(): string {
    return join(this.stateDir(), 'results.json');
  }

  private loadQuizState(): QuizState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(), 'utf8')) as QuizState;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private saveQuizState(next: QuizState): void {
    const keep: QuizState = {
      batch1: next.batch1,
      batch2: next.batch2,
      result: next.result ?? null,
      takenAt: next.takenAt,
      creative: next.creative,
      creativeAt: next.creativeAt,
      creativeRequestedAt: next.creativeRequestedAt,
      profileCard: next.profileCard,
    };
    try {
      mkdirSync(this.stateDir(), { recursive: true });
      const tmp = `${this.stateFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify(keep, null, 2), 'utf8');
      renameSync(tmp, this.stateFile());
      this.quiz = keep;
    } catch (err) {
      this.host?.log.warn('体检报告：保存测验结果失败', { err: String(err) });
    }
  }

  /** 两批合起来算一次，结果落盘。 */
  private recompute(next: QuizState): void {
    if (next.batch1 === this.quiz.batch1 && next.batch2 === this.quiz.batch2 && next.creative !== this.quiz.creative) {
      this.saveQuizState(next);
      return;
    }
    const answers = [...(next.batch1?.answers ?? []), ...(next.batch2?.answers ?? [])];
    if (answers.length === 0) {
      this.saveQuizState(next);
      return;
    }
    const result = scoreQuiz(loadQuiz('zh'), answers) as unknown as Record<string, unknown>;
    const stamp = Math.max(next.batch1?.at ?? 0, next.batch2?.at ?? 0) || Date.now();
    this.saveQuizState({ ...next, result, takenAt: stamp });
  }

  /* ------------------------------------------------------------- 契约 */

  /** 不进系统前缀：体检是她需要时去调的东西，不是每轮都要背的常识。 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  tools(): ToolDef[] {
    if (this.cfg?.enabled === false) return [];
    const handlers = this.handlers();
    return TOOL_SCHEMAS
      .filter((s) => ((s.name === QUIZ_TOOL || s.name === SUBMIT_TOOL) ? this.cfg?.quizEnabled !== false : true))
      .map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        tags: schema.tags,
        handler: async (args: Record<string, unknown>) => {
          const fn = handlers[schema.name];
          const out = fn ? fn(args) : { ok: false, error: `no handler for ${schema.name}` };
          return { text: JSON.stringify(out, null, 2) };
        },
      })) as unknown as ToolDef[];
  }

  private handlers() {
    return makeToolHandlers({
      snapshot: () => this.snapshot(),
      contextWindow: () => this.contextWindow(),
      quizState: () => this.quiz as never,
      saveQuizState: (next: never) => this.recompute(next as unknown as QuizState),
      language: () => 'zh',
      now: () => new Date(),
    });
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const lang = pick(language);
    const report = this.report(lang);
    const hw = report.hardware;
    const per = report.personality;
    const problems = report.problems.length;

    return {
      label: lang === 'zh' ? '体检报告' : 'Checkup',
      lamps: [
        {
          label: lang === 'zh' ? '主循环' : 'Loop',
          state: this.live.lastState === 'backoff' ? 'error' : this.live.lastState === 'handoff' ? 'loading' : 'online',
          hint: this.live.lastState,
        },
        {
          label: lang === 'zh' ? '模型' : 'Model',
          state: this.modelName() ? 'online' : 'offline',
          hint: this.modelName() ?? '',
        },
        {
          label: lang === 'zh' ? '数据' : 'Data',
          state: problems === 0 ? 'online' : 'loading',
          hint: problems === 0 ? '' : `${problems} 项读不到`,
        },
        {
          label: lang === 'zh' ? '硬件' : 'Hardware',
          state: hw.overall === null ? 'offline' : hw.levelKey === 'poor' ? 'error' : hw.levelKey === 'solid' ? 'online' : 'loading',
          hint: hw.overall === null ? '' : `${hw.overall} ${hw.level}`,
        },
        {
          label: lang === 'zh' ? '人格' : 'Personality',
          state: per.profile.recent.length ? 'online' : 'offline',
          hint: per.profile.recent.length
            ? (lang === 'zh' ? `${per.profile.recent.length} 条近期观察` : `${per.profile.recent.length} recent observations`)
            : (lang === 'zh' ? '近期记录不足' : 'not enough recent records'),
        },
      ],
      badges: hw.overall !== null
        ? [{ label: lang === 'zh' ? '硬件' : 'HW', value: `${hw.overall} ${hw.level}`, tone: 'plain' }]
        : [],
      panels: [
        {
          id: 'hardware',
          title: lang === 'zh' ? '硬件健康' : 'Hardware',
          description: lang === 'zh' ? '六个维度的运行状态与依据' : 'Six operational dimensions with evidence',
          getMethods: ['report'],
        },
        {
          id: 'persona',
          title: lang === 'zh' ? '心理健康' : 'Wellbeing',
          description: lang === 'zh'
            ? '查看她近期的性格画像、行为依据和奇遇小测'
            : 'Recent personality observations, evidence and a curiosity quiz',
          getMethods: ['report'],
        },
        {
          id: 'method',
          title: lang === 'zh' ? '口径' : 'Method',
          description: lang === 'zh' ? '每个分数怎么来的，以及它不做什么' : 'How each number is produced, and what it does not do',
        },
      ],
      invoke: (panel: string, method: string, args: unknown[]) => this.invoke(panel, method, args),
      config: [{
        id: `world:${CHECKUP_ID}`,
        owner: `world:${CHECKUP_ID}`,
        schema: {
          type: 'object',
          title: lang === 'zh' ? '采样' : 'Sampling',
          description: lang === 'zh' ? '统计窗口决定看最近多少天的数据。' : 'The window controls how many days are summarised.',
          // 键必须是配置里的完整点分路径——框架按这个读取和写回，写短名会落到 config.json 顶层。
          properties: {
            [`worlds.${CHECKUP_ID}.sampleDays`]: {
              type: 'integer',
              title: lang === 'zh' ? '统计窗口（天）' : 'Window (days)',
              minimum: 1,
              maximum: 90,
              multipleOf: 1,
              'x-hot': true,
            },
            [`worlds.${CHECKUP_ID}.quizEnabled`]: {
              type: 'boolean',
              title: lang === 'zh' ? '允许奇遇小测' : 'Allow the curiosity quiz',
              description: lang === 'zh' ? '关掉后她拿不到题，面板也不发起测验。' : 'When off, she cannot fetch items and the panel will not start a test.',
              'x-hot': true,
            },
          },
        },
      }],
    };
  }

  async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (method === 'refresh') {
      this.cache = { snapshot: null, at: 0, key: '' };
      return { ok: true };
    }
    if (method === 'report') {
      const report = this.report(pick(String(args?.[0] ?? 'zh')));
      if (panel === 'persona' && this.host?.cognition && !('custom' in report.personality.profile) && report.personality.profile.recent.some((row) => !row.empty)) {
        Object.assign(report.personality.profile, { canGenerate: true });
      }
      return { ok: true, report };
    }
    if (panel === 'persona' && (method === 'cardPrompt' || method === 'saveProfileCard')) {
      const lang = pick(String(args?.[0] ?? 'zh'));
      const { profile } = this.report(lang).personality;
      const rows = profile.recent.filter((row) => !row.empty);
      const key = JSON.stringify(rows.map(({ id, summary }) => [id, summary]));
      if (method === 'cardPrompt') return { ok: true, key, prompt: cardPrompt(profile, lang) };
      if (!rows.length || key !== args?.[1]) return { ok: false, error: 'stale' };
      const text = args?.[2];
      if (typeof text !== 'string' || text.length > 4000) return { ok: false, error: 'invalid' };
      const copy = readProfileCopy(text, rows.map(({ id }) => id), profile.candidates);
      if (!copy || !('tags' in copy)) return { ok: false, error: 'invalid' };
      this.saveQuizState({ ...this.quiz, profileCard: { ...this.quiz.profileCard, [lang]: { key, copy } } });
      return { ok: this.quiz.profileCard?.[lang]?.copy === copy };
    }
    if (panel === 'persona' && method === 'profileCopy') {
      const lang = pick(String(args?.[0] ?? 'zh'));
      return { ok: true, copy: await this.profileCopy(lang, String(args?.[1] ?? '')) };
    }
    if (method === 'text') {
      return { ok: true, text: reportToText(this.report('zh')) };
    }
    if (panel === 'persona' && method === 'startCreative') {
      if (!this.host) return { ok: false, error: 'world not mounted' };
      if (this.cfg?.quizEnabled === false) return { ok: false, error: 'quiz-disabled' };
      const now = Date.now();
      const lastRequested = this.quiz.creativeRequestedAt ?? 0;
      if (this.creativePending || (lastRequested > 0 && now - lastRequested < 10 * 60_000)) {
        return { ok: false, error: 'already-requested', lastAt: lastRequested };
      }
      const last = this.quiz.creativeAt;
      if (last && now - last < MIN_GAP_MS) return { ok: false, error: 'taken-recently', lastAt: last };
      this.creativePending = true;
      try {
        await this.host.pushEvent({
          type: 'checkup.quiz-request',
          text: `这是小鱼彩蛋邀请，只做创作题：用 ${QUIZ_TOOL} 取 batch=3，按自己的想法自由回答，再用 ${SUBMIT_TOOL} 提交 batch=3，每项填 id 和 response。不要重做 batch=1/2；创作不改变人格四轴。`,
          origin: 'internal',
          tags: ['system'],
        });
        this.saveQuizState({ ...this.quiz, creativeRequestedAt: Date.now() });
        return { ok: true, started: true };
      } finally {
        this.creativePending = false;
      }
    }
    if (method === 'startQuiz') {
      if (!this.host) return { ok: false, error: 'world not mounted' };
      if (this.cfg?.quizEnabled === false) return { ok: false, error: 'quiz-disabled' };
      const last = this.quiz.takenAt ?? 0;
      if (Date.now() - last < MIN_GAP_MS) return { ok: false, error: 'taken-recently', lastAt: last };
      await this.host.pushEvent({
        type: 'checkup.quiz-request',
        text:
          `该做一次人格体检了。先调 ${QUIZ_TOOL} 拿 batch=1 的题，按本心选，别照着自己的档案选；`
          + `答完用 ${SUBMIT_TOOL} 交，然后再取 batch=2。`,
        origin: 'internal',
        tags: ['system'],
      });
      return { ok: true, started: true };
    }
    if (method === 'behavior') {
      return { ok: true, behavior: this.report('zh').personality };
    }
    return { ok: false, error: `unknown method: ${panel}/${method}` };
  }

  shutdownVerification(language: Language = 'zh') {
    return [{
      key: 'read-only',
      label: language === 'zh' ? '只读' : 'Read-only',
      status: 'verified-ended' as const,
      detail: language === 'zh'
        ? `除 ${this.stateDir()} 之外没有写过任何文件`
        : `No writes outside ${this.stateDir()}`,
      manualAction: '',
    }];
  }

  /* ------------------------------------------------------------- 内部 */

  private async profileCopy(lang: 'zh' | 'en', expectedKey: string): Promise<unknown> {
    const cognition = this.host?.cognition;
    if (!cognition) return null;
    const { profile } = this.report(lang).personality;
    const rows = profile.recent.filter((row) => !row.empty).map(({ id, summary }) => [id, summary]);
    const key = JSON.stringify(rows);
    if (key !== expectedKey || !rows.length) return null;
    const cached = this.profileCopyCache.get(lang);
    if (cached?.key === key) return cached.copy;
    const brief = cardPrompt(profile, lang);
    const copy = Promise.resolve().then(() => cognition.request({ brief, tools: [], hint: { rounds: 1 } }))
      .then((result) => 'text' in result ? readProfileCopy(result.text, rows.map(([id]) => id), profile.candidates) : null)
      .catch(() => null);
    this.profileCopyCache.set(lang, { key, copy });
    return copy;
  }

  private report(lang: 'zh' | 'en') {
    const report = buildReport(this.safeSnapshot(), {
      contextWindow: this.contextWindow(),
      quizResult: (this.quiz.result ?? null) as never,
      creativeResult: this.quiz.creative ?? null,
      language: lang,
      quizTakenAt: this.quiz.takenAt ?? null,
      live: {
        phases: this.live.phases,
        backoffs: this.live.backoffs,
        handoffs: this.live.handoffs,
        truncations: this.live.truncations,
        lastState: this.live.lastState,
        lastAt: this.live.lastAt,
        topTools: [...this.live.toolCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      },
    });
    const profile = report.personality.profile;
    const saved = this.quiz.profileCard?.[lang];
    const key = JSON.stringify(profile.recent.filter((row) => !row.empty).map(({ id, summary }) => [id, summary]));
    if (saved?.key === key) Object.assign(profile, {
      title: saved.copy.title, label: saved.copy.label, description: saved.copy.description,
      tags: saved.copy.tags, custom: true,
    });
    Object.assign(profile, { name: this.botName });
    return report;
  }

  private safeSnapshot(): Snapshot {
    try {
      return this.snapshot();
    } catch (err) {
      const reason = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
      return {
        usage: { ok: false, path: '', reason, records: [], skippedLines: 0 },
        config: { ok: false, path: '', reason, context: null, rounds: null, activeProvider: '' },
        handoffs: { ok: false, path: '', reason, files: [] },
        memory: { ok: false, path: '', reason, problems: [] },
        problems: [reason],
        collectedAt: Date.now(),
        sampleDays: this.sampleDays(),
      } as unknown as Snapshot;
    }
  }
}

/** 装配层用这个定义挂载。 */
export const CHECKUP_WORLD: WorldDefinition<CheckupSection> = {
  id: CHECKUP_ID,
  label: '体检报告',
  defaults: () => structuredClone(CHECKUP_DEFAULTS),
  create: (ctx: WorldContext<CheckupSection>) => new CheckupWorld({
    cfg: ctx.cfg,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
    botName: ctx.botName,
    timezone: ctx.timezone,
    packageDir: ctx.packageDir,
    // 保留旧版默认目录，采集时优先使用部署的实际路径。
    memoryDir: join(ctx.botDir, 'workspace'),
  }),
};

export default CHECKUP_WORLD;
