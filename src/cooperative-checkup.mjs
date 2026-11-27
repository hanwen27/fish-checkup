import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COOPERATIVE_METHOD, COOPERATIVE_GROUPS, CONTEXT_RATIOS, OUTPUT_CAP, TEST_SYSTEM, makeContextCase, makeHandoffScenario, exactJson, fieldEvidence } from './cooperative-cases.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
const ACTIVE = new Set(['running', 'stopping']);
export const COOPERATIVE_DISCLOSURE = [
  '机制验证仅在独立本地目录运行 COO 真实交接代码和已适配的记忆接口；不操作正在使用的主会话、正式记忆或外部工具。',
  '模型回答对照只使用合成系统前缀，不包含正式部署提示、扩展提示或正式记忆；因此不会覆盖正式前缀对模型表现的影响。启用后，合成任务和预检列出的完整提示会发送给所选模型服务方并消耗 Token；不自动重试。',
  '模型模式的本地预检会在独立目录渲染并清理一次合成交接材料，用于核算请求 Token，不调用模型。单个交接请求预留 2% 或 128 Token 的计数余量，执行前再次核对。',
  '停止只阻止后续步骤并请求取消在途调用；已经发生的消耗和已经发送的数据无法由本地撤销。用量不明时停止后续模型请求。',
  '记忆测试范围以名称、版本、实际接口及执行证据为准。清理失败会保留异常状态并阻止开始下一轮；本地清理不证明远端所有副本已删除。',
  '测试使用合成内容与隔离前缀，和日常真实会话有差异。机制通过不代表模型自主召回通过；手动交接通过不代表自动阈值策略已验证。',
];

export function cooperativeReportText(run) {
  if (!run) return '尚无 COO 协作体检记录。';
  const lines = [`COO 协作深度体检 ${COOPERATIVE_METHOD}`, `运行 ${run.id}；状态 ${run.state}；原因 ${run.reason ?? '无'}`,
    `模式：${run.mode === 'model' ? '模型协作 + 本地机制' : '本地机制验证（未测试模型回答）'}`,
    `策略来源：${run.runtime.origin}；阶段预算 ${run.runtime.stageTokens}；软线 ${run.runtime.softTokens}；交接笔记预算 ${run.runtime.noteBudgetTokens}`,
    `源码指纹：${run.source.fingerprint}`, '结果速读：'];
  for (const row of run.results) {
    lines.push(`${row.id}：${row.outcome}；${row.explanation}`);
    if (row.model) lines.push(`模型前后对照：基线 ${row.model.baseline ? '通过' : '未通过'}，交接后 ${row.model.after ? '通过' : '未通过'}；${row.model.attribution}`,
      `模型字段证据：${JSON.stringify({ baseline: row.model.baselineFields, after: row.model.afterFields })}`);
    if (row.evidence) lines.push(`证据：${JSON.stringify(row.evidence)}`);
  }
  lines.push(`消耗：请求 ${run.usage.requests}；已回报输入 ${run.usage.inputTokens} / 输出 ${run.usage.outputTokens} Token；${run.unsettled ? '有未回报请求，不能视作零消耗' : '当前无未回报请求'}`,
    `清理：${run.cleanup.status}；${run.cleanup.scope ?? ''}`, '未覆盖：当前主会话、正式记忆、真实私人数据、模型自主选择记忆工具、软阈值自动触发、外部动作。',
    '结果仅描述本次隔离实例、代码和策略，不生成总分，不据此建议最佳上下文长度。原始提示、回答和合成事实不保存在报告中。');
  return lines.join('\n');
}

/** The controller never uses ordinary cognition, scans user files, or selects a provider. */
export class CooperativeCheckup {
  constructor({ host = null, stateDir = null, now = Date.now, requestTimeoutMs = 180000, save = null } = {}) {
    this.host = host; this.now = now; this.requestTimeoutMs = requestTimeoutMs; this.save = save;
    this.directory = stateDir ? join(stateDir, 'cooperative') : null;
    this.file = this.directory ? join(this.directory, 'cooperative-checkup.json') : null;
    this.plan = null; this.run = null; this.session = null; this.closed = false; this.planning = false; this.inventory = { status: 'not-read', rows: [] };
    if (this.file && existsSync(this.file)) {
      try {
        const previous = JSON.parse(readFileSync(this.file, 'utf8'));
        if (previous?.method !== COOPERATIVE_METHOD || typeof previous.id !== 'string' || !previous.usage
          || !Array.isArray(previous.results) || previous.results.length > 100 || !previous.cleanup || !previous.runtime || !previous.source) throw Error('invalid-state');
        this.run = previous;
        if (ACTIVE.has(previous.state)) { this.run.state = 'interrupted'; this.run.reason = 'process-restarted'; this.persist(); }
      } catch { this.storageError = true; }
    }
  }
  persist() {
    try {
      if (this.save) this.save(clone(this.run));
      else if (this.file) {
        mkdirSync(this.stateDir(), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.run), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
      }
      this.storageError = false; return true;
    } catch { this.storageError = true; return false; }
  }
  stateDir() { return this.directory; }
  inspect() {
    if (this.closed) return { ready: false, blocker: 'world-stopped' };
    if (!this.host) return { ready: false, blocker: 'cooperative-host-unavailable', modelReady: false, memoryTargets: [] };
    try { return this.host.inspect(); } catch { return { ready: false, blocker: 'cooperative-inspection-failed', modelReady: false, memoryTargets: [] }; }
  }
  status() { return clone({ ok: true, method: COOPERATIVE_METHOD, capability: this.inspect(), run: this.run, inventory: this.inventory, storageError: !!this.storageError }); }
  async readInventory() {
    if (!this.host || ACTIVE.has(this.run?.state) || this.planning) return { ok: false, error: 'inventory-unavailable' };
    try { this.inventory = await this.host.readInventory(); return { ok: true, inventory: clone(this.inventory) }; }
    catch { return { ok: false, error: 'inventory-read-failed' }; }
  }
  async preflight({ mode = 'mechanism', groups = COOPERATIVE_GROUPS, limits = {} } = {}) {
    this.plan = null;
    const capability = this.inspect();
    const fail = (error) => ({ ok: true, ready: false, capability, error, disclosure: COOPERATIVE_DISCLOSURE, plan: null });
    if (this.planning || ACTIVE.has(this.run?.state)) return fail('already-running');
    if (!capability.ready) return fail(capability.blocker);
    if (this.storageError) return fail('storage-unavailable');
    if (this.run?.unsettled) return fail('usage-unavailable');
    if (this.run && this.run.cleanup?.status !== 'verified') return fail('cleanup-unverified');
    if (!['mechanism', 'model'].includes(mode) || !Array.isArray(groups) || !groups.length || new Set(groups).size !== groups.length || groups.some((g) => !COOPERATIVE_GROUPS.includes(g))) return fail('invalid-selection');
    if (mode === 'model' && (!capability.modelReady || !capability.dataScope)) return fail('model-transport-unavailable');
    const caps = { maxRequests: limits.maxRequests ?? 12, maxInputTokens: limits.maxInputTokens ?? 600000, maxOutputTokens: limits.maxOutputTokens ?? 4096 };
    if (Object.values(caps).some((x) => !integer(x)) || caps.maxRequests > 64 || caps.maxInputTokens > 6_000_000 || caps.maxOutputTokens > 32768) return fail('invalid-budget');
    this.planning = true;
    try {
      const operations = [], modelReservations = [];
      const addCall = (inputTokens) => {
        if (!integer(inputTokens) || inputTokens < 1 || inputTokens > capability.runtime.modelInputLimit) throw Error('request-input-limit');
        modelReservations.push({ inputTokens, outputTokens: Math.min(OUTPUT_CAP, capability.runtime.maxOutputTokens) });
      };
      if (groups.includes('context') && mode === 'model') {
        const effective = Math.min(capability.runtime.stageTokens, capability.runtime.modelInputLimit);
        for (const ratio of CONTEXT_RATIOS) {
          const item = await makeContextCase(ratio, effective, (messages) => this.host.countMessages(messages));
          operations.push(item); addCall(item.inputTokens);
        }
      }
      if (groups.includes('handoff')) {
        for (const position of ['begin', 'middle', 'end']) {
          const scenario = { group: 'handoff', ...makeHandoffScenario(position) };
          if (mode === 'model') {
            if (typeof this.host.measureHandoff !== 'function') return fail('handoff-reservation-unavailable');
            const measured = await this.host.measureHandoff(scenario);
            const beforeMessages = [{ role: 'system', content: TEST_SYSTEM }, ...measured.beforeMessages];
            const afterMessages = [{ role: 'system', content: TEST_SYSTEM }, ...measured.afterMessages];
            const baselineTokens = await this.host.countMessages(beforeMessages);
            const afterTokens = await this.host.countMessages(afterMessages);
            if (!integer(baselineTokens) || !integer(afterTokens)) return fail('token-count-unavailable');
            const margin = (n) => n + Math.max(128, Math.ceil(n * .02));
            scenario.measure = { before: beforeMessages, after: afterMessages,
              beforeTokens: margin(baselineTokens), afterTokens: margin(afterTokens), evidence: measured.evidence };
            addCall(scenario.measure.beforeTokens); addCall(scenario.measure.afterTokens);
          }
          operations.push(scenario);
        }
      }
      if (groups.includes('memory')) for (const target of capability.memoryTargets) operations.push({ id: `memory-${target.id}`, group: 'memory', target: clone(target) });
      if (!operations.length) return fail('no-executable-items');
      const totals = modelReservations.reduce((a, r) => ({ requests: a.requests + 1, inputTokens: a.inputTokens + r.inputTokens, outputTokens: a.outputTokens + r.outputTokens }), { requests: 0, inputTokens: 0, outputTokens: 0 });
      const ready = totals.requests <= caps.maxRequests && totals.inputTokens <= caps.maxInputTokens && totals.outputTokens <= caps.maxOutputTokens;
      const disclosed = [...COOPERATIVE_DISCLOSURE, `本次发送范围：${capability.dataScope}`, `本次策略来源：${capability.runtime.origin}`,
        `本次记忆对象：${capability.memoryTargets.map((r) => `${r.id}@${r.version}:${r.testLevel}`).join('；')}`];
      const plan = { id: randomUUID(), method: COOPERATIVE_METHOD, mode, groups: [...groups], limits: caps, totals, fingerprint: capability.fingerprint,
        runtime: capability.runtime, source: capability.source, expiresAt: this.now() + 300000, disclosureHash: hash(disclosed),
        durationMs: null, modelTested: mode === 'model', contextSkipped: groups.includes('context') && mode !== 'model',
        items: operations.map(({ id, group, ratio, targetInputTokens, target }) => ({ id, group, ratio, targetInputTokens, target })), dataScope: capability.dataScope };
      if (ready && this.inspect().fingerprint === capability.fingerprint && !this.closed) this.plan = { public: clone(plan), operations, modelReservations };
      return { ok: true, ready: ready && !!this.plan, capability, plan, disclosure: disclosed, error: ready ? null : 'budget-too-small' };
    } catch { return fail('preflight-preparation-failed'); }
    finally { this.planning = false; }
  }
  start({ planId, disclosureHash, accepted } = {}) {
    if (this.closed || ACTIVE.has(this.run?.state) || this.run?.unsettled || this.storageError || this.run && this.run.cleanup?.status !== 'verified') return { ok: false, error: 'run-blocked' };
    if (accepted !== true) return { ok: false, error: 'consent-required' };
    const plan = this.plan;
    if (!plan || plan.public.id !== planId || disclosureHash !== plan.public.disclosureHash || this.now() >= plan.public.expiresAt) return { ok: false, error: 'preflight-expired' };
    if (this.inspect().fingerprint !== plan.public.fingerprint) { this.plan = null; return { ok: false, error: 'configuration-changed' }; }
    this.plan = null;
    this.run = { ...clone(plan.public), id: randomUUID(), state: 'running', reason: null, startedAt: this.now(), current: null,
      results: [], cleanup: { status: 'pending' }, usage: { requests: 0, inputTokens: 0, outputTokens: 0 }, unsettled: null, finishedAt: null };
    if (!this.persist()) { this.run.state = 'failed'; return { ok: false, error: 'storage-unavailable' }; }
    this.abort = new AbortController();
    this.task = this.execute(plan);
    return { ok: true, runId: this.run.id };
  }
  async modelCall(messages, reservation, fingerprint) {
    if (this.abort.signal.aborted) throw Error('user-stopped');
    if (this.inspect().fingerprint !== fingerprint) throw Error('configuration-changed');
    const used = this.run.usage, cap = this.run.limits;
    if (this.run.unsettled || used.requests + 1 > cap.maxRequests || used.inputTokens + reservation.inputTokens > cap.maxInputTokens
      || used.outputTokens + reservation.outputTokens > cap.maxOutputTokens) throw Error('budget-reached');
    const request = { id: randomUUID(), ...reservation };
    used.requests++; this.run.unsettled = request;
    if (!this.persist()) throw Error('storage-unavailable');
    let settled = false, timeout;
    const account = (result) => {
      if (!this.run?.unsettled || this.run.unsettled.id !== request.id) return;
      if (integer(result?.inputTokens) && integer(result?.outputTokens)) {
        used.inputTokens += result.inputTokens; used.outputTokens += result.outputTokens; this.run.unsettled = null;
      }
      this.persist();
    };
    const attempt = Promise.resolve().then(() => this.host.complete({ messages, maxOutputTokens: reservation.outputTokens,
      inputTokenCap: reservation.inputTokens, signal: this.abort.signal, requestId: request.id }));
    const observed = attempt.then((response) => { settled = true; account(response); return response; }, () => { settled = true; return null; });
    const result = await Promise.race([observed, new Promise((resolve) => {
      timeout = setTimeout(() => { this.abort.abort(); resolve(null); }, this.requestTimeoutMs); timeout.unref?.();
    })]);
    clearTimeout(timeout);
    if (!settled || this.run.unsettled) throw Error('usage-unavailable');
    if (result.inputTokens > request.inputTokens || result.outputTokens > request.outputTokens || result.attempts !== 1) throw Error('executor-limit-violation');
    if (this.abort.signal.aborted) throw Error('user-stopped');
    if (result.ok !== true || typeof result.text !== 'string') throw Error('model-request-failed');
    return result.text;
  }
  async execute(plan) {
    let reservationIndex = 0;
    const call = (messages) => this.modelCall(messages, plan.modelReservations[reservationIndex++], plan.public.fingerprint);
    try {
      this.session = await this.host.open(this.run.id);
      for (const item of plan.operations) {
        this.abort.signal.throwIfAborted();
        if (this.inspect().fingerprint !== plan.public.fingerprint) throw Error('configuration-changed');
        this.run.current = item.id;
        if (!this.persist()) throw Error('storage-unavailable');
        if (item.group === 'context') {
          const response = await call(item.messages);
          this.run.results.push({ id: item.id, group: item.group, outcome: exactJson(response, item.expected) ? 'pass' : 'fail',
            explanation: `${Math.round(item.ratio * 100)}% 长度档的首中尾合成档案检查；单次请求内检查点相关。`,
            evidence: { targetInputTokens: item.targetInputTokens, countedInputTokens: item.inputTokens, checkCount: 3, independentRequests: 1,
              answer: fieldEvidence(response, item.expected) } });
        } else if (item.group === 'handoff') {
          const question = { role: 'user', content: item.question };
          let baseline = null, baselineFields = null;
          if (this.run.mode === 'model') {
            const response = await call(item.measure.before); baseline = exactJson(response, item.expected); baselineFields = fieldEvidence(response, item.expected);
          }
          const result = await this.session.handoff(item, { signal: this.abort.signal });
          const pass = result.evidence.resetObserved && result.evidence.boundaryObserved && !result.evidence.warningCount && Object.values(result.evidence.facts).every((x) => x === true);
          const row = { id: item.id, group: item.group, outcome: pass ? 'pass' : 'fail', evidence: result.evidence,
            explanation: pass ? '真实 Core 交接事务完成，重置后注入材料保留了本题四项合成任务信息。' : '交接机制或合成信息保留检查未通过，需查看逐项证据。' };
          if (this.run.mode === 'model') {
            const afterMessages = [{ role: 'system', content: TEST_SYSTEM }, ...result.afterMessages, question];
            const afterInputTokens = await this.host.countMessages(afterMessages);
            if (!integer(afterInputTokens) || afterInputTokens > item.measure.afterTokens) throw Error('reservation-or-context-unavailable');
            const response = await call(afterMessages), after = exactJson(response, item.expected);
            row.model = { baseline, after, baselineFields, afterFields: fieldEvidence(response, item.expected),
              attribution: baseline ? after ? '本题交接前后均答对。' : '本题交接后答错；需要复测，不直接归因给记忆插件。' : '基线未通过，无法把后续表现归因于交接。' };
          }
          // Do not persist raw synthetic conversations or model replies.
          delete result.beforeMessages; delete result.afterMessages;
          this.run.results.push(row);
        } else {
          const evidence = await this.session.memoryLifecycle(item.target.id, { signal: this.abort.signal });
          const pass = evidence.steps.every((r) => r.pass === true) && evidence.cleanupVerified === true;
          this.run.results.push({ id: item.id, group: item.group, target: item.target, outcome: pass ? 'pass' : 'fail', evidence,
            explanation: pass ? '此隔离存储接口的阴性对照、写入、重开读取、更正和删除检查通过；未验证模型自主检索。' : '此隔离记忆接口的生命周期检查未全部通过。' });
        }
        if (!this.persist()) throw Error('storage-unavailable');
      }
    } catch (failure) {
      const known = ['configuration-changed', 'storage-unavailable', 'budget-reached', 'usage-unavailable', 'executor-limit-violation', 'model-request-failed'];
      this.run.reason = this.abort.signal.aborted && failure?.message !== 'usage-unavailable' ? 'user-stopped'
        : known.includes(failure?.message) ? failure.message : 'cooperative-execution-failed';
    } finally {
      if (this.session) {
        try { this.run.cleanup = await this.session.cleanup(); } catch { this.run.cleanup = { status: 'unverified', scope: '本次独立目录清理未能验证；需处理后再运行。' }; }
      } else this.run.cleanup = { status: 'unverified', scope: '未取得测试空间，无法验证是否创建了部分资源。' };
      this.run.current = null; this.run.finishedAt = this.now();
      this.run.state = this.run.reason === 'user-stopped' ? 'stopped' : this.run.reason || this.run.cleanup.status !== 'verified' ? 'paused' : 'completed';
      this.persist();
    }
  }
  stop() { if (!ACTIVE.has(this.run?.state)) return { ok: true, stopped: false }; this.run.state = 'stopping'; this.abort?.abort(); this.persist(); return { ok: true, stopped: true }; }
  close() { this.closed = true; this.stop(); }
  text() { return { ok: true, text: cooperativeReportText(this.run) }; }
}
