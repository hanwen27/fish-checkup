import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEP_GROUPS, DEEP_METHOD, makeDeepCases, scoreDeepCase } from './deep-cases.mjs';

const ACTIVE = new Set(['running', 'stopping']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = (value) => JSON.parse(JSON.stringify(value));
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const CAPABILITIES = ['isolated', 'noTools', 'noMemoryWrites', 'singleAttempt', 'hardLimits', 'usage', 'abort'];
export const DEEP_DISCLOSURE = [
  '数据发送与隐私：合成测试材料与执行器声明的完整提示内容会发送给所选模型服务方；本版不读取真实对话或用户记忆。请先核对下方发送范围。服务方如何处理和保留数据，以其自身规则为准，本插件不作不留存承诺。',
  'Token 与运行占用：启动后会真实消耗所选模型的 Token 与账号额度，失败或停止的请求也可能有消耗。预检显示的是预留上限，耗时是估计；未回报用量不会记为零。运行中请勿切换模型或配置。',
  '隔离与副作用边界：仅在执行器已声明且能强制执行独立测试、禁止工具及记忆写入、用量上限与停止能力时才允许启动；能力缺失则禁用。本版不写入持久记忆，不调用工具，不自动重试，不测试真实交接。',
  '记忆检测对象：本版未检测 COO 原生记忆，也未识别或检测任何第三方记忆插件；未读取安装与启用清单，不能据此判断用户是否安装了插件。会话内事实更新仅为模型合成消息测试，不代表记忆系统的录入、召回或跨会话保存。',
  '停止与异常：停止只阻止后续请求，已发送的请求可能继续完成并消耗 Token；关闭页面不会停止任务。达到运行保护上限、用量缺失或配置变化时停止后续请求；仍有未回报用量时禁止开始下一轮。',
  '结果用途与记录：结论只描述本次模型、配置和少量合成样本，不保证日常使用表现，不直接推荐修改上下文或记忆插件。字符档不是 Token 窗口。仅在本插件数据目录保留最近一轮题号、判定与运行计量，不保存原始提示、回答或真实用户内容；导出文件请自行妥善保管。',
];

// DC-0.1 sends synthetic messages directly; host inventory is surfaced when available.
export function deepMemoryScope(inventory = null) {
  const rows = Array.isArray(inventory?.rows) ? inventory.rows : [];
  const hasInventory = inventory?.status === 'ready' && rows.length > 0;
  const memRows = rows.filter((r) => /memory|brain|fishtools|fishbrain|continuity|记忆|鱼脑/i.test(`${r.id ?? ''} ${r.name ?? ''} ${r.label ?? ''} ${r.description ?? ''}`));
  const thirdPartyTarget = hasInventory
    ? {
      id: 'third-party',
      name: '已识别记忆相关插件',
      status: memRows.length ? `已发现 ${memRows.length} 个（总扩展 ${rows.length} 个）` : `已扫描 ${rows.length} 个扩展（未发现专用记忆插件）`,
      detail: memRows.length
        ? memRows.map((r) => `${r.label || r.id || r.name}${r.version ? ` v${r.version}` : ''}（${r.enabled === true ? '已启用' : r.enabled === false ? '未启用' : '状态未知'}）`).join('、') + '。深度体检以隔离模式运行，不写入真实记忆。'
        : '已通过本机宿主清单完成扫描；深度体检以隔离模式运行，不读写第三方插件记忆。',
    }
    : {
      id: 'third-party',
      name: '第三方记忆插件',
      status: '未扫描 · 无法判定',
      detail: '当前体检接口没有读取宿主扩展清单，因此不知道已安装或启用哪些插件，也未调用任何插件记忆接口；不能据此判断有没有安装。',
    };
  return {
    testedMemorySystemCount: 0,
    inventoryStatus: hasInventory ? 'ready' : 'not-inspected',
    targets: [
      { id: 'coo-native', name: 'COO 原生记忆', status: hasInventory ? '隔离不写入' : '未检测',
        detail: hasInventory
          ? '深度体检采用纯隔离合成请求，不读写你的真实原生记忆或主会话记录。'
          : '未调用原生记忆读写接口；录入、召回、跨会话保存和清理均未验证。' },
      thirdPartyTarget,
    ],
    explanation: hasInventory
      ? `已通过本机清单识别 ${rows.length} 个扩展（记忆相关 ${memRows.length} 个）。本轮深度体检仅测试隔离上下文与指令保持，不污染真实记忆。`
      : '已检测记忆系统：0 个。会话内事实更新仅检查同一请求中的合成消息，不经过原生或插件记忆链路；该项通过不能证明跨会话能记住。',
  };
}

const GROUP_READINGS = {
  context: {
    name: '上下文保持',
    purpose: '在给定材料中找回指定信息，分别观察信息放在首部、中部和尾部时的表现。',
    pass: '本次测试中，模型找回了各个位置的指定信息；这还不能说明日常长对话一定不会漏掉内容。',
    fail: '本次有指定信息未被正确找回，或回答格式不符合要求；一次未通过还不能断定上下文设置太短。',
    action: '先在相同模型和配置下复测未通过项，再结合实际对话中的遗漏判断；暂不据此调整上下文长度。',
    passAction: '保留当前设置观察即可；若日常仍有遗漏，再用接近实际任务的材料复测。',
  },
  instructions: {
    name: '指令保持',
    purpose: '在预设的干扰消息下，检查回答是否仍遵守指定格式。',
    pass: '本次格式约束在干扰下得到保持；这不代表所有复杂任务中的指令都能被遵守。',
    fail: '本次有回答偏离指定格式，说明这组干扰下出现了指令保持问题；不能由此推断模型整体能力下降。',
    action: '先复测对应场景，再检查实际任务中的指令是否冲突；本项没有验证工具权限或真实交接。',
    passAction: '当前结果未提示必须修改指令；复杂任务仍应检查格式与要求是否得到执行。',
  },
  'working-memory': {
    name: '会话内事实更新',
    purpose: '在同一份合成对话中更正一个事实，检查模型是否使用最新值。',
    pass: '本次模型采用了更正后的信息；这只说明会话内更新成功，不能说明记忆插件已经写入或下次还能记住。',
    fail: '本次有回答没有正确采用更正值，或格式不符合要求；这不是记忆插件丢失数据的证据。',
    action: '在相同条件下复测事实更正；若要检查跨会话记忆，需要另测所用记忆插件的写入和召回。',
    passAction: '本项无需据此修改记忆插件；跨会话能否记住，仍需单独验证。',
  },
  comprehension: {
    name: '逻辑与语义理解',
    purpose: '通过多条件筛选、潜台词识别、逻辑矛盾判断与因果排序，检验日常听懂话与条理清晰度。',
    pass: '本次 4 道逻辑与语义题全部答对，说明模型在常规条件筛选、反话识别与因果推理上表现清醒。',
    fail: '本次有逻辑或语义题未通过，说明在多条件约束、反讽或因果判断上出现偏差，建议复测确认。',
    action: '先查看上方具体失分题，再决定是否需要调整系统提示或更换更强的推理模型。',
    passAction: '日常理解与逻辑清晰度表现良好，保持当前配置即可。',
  },
};
const RESULT_REASONS = {
  'exact-match': '字段及内容与预期一致', 'value-or-format': '字段、内容或格式与预期不一致',
  format: '未返回可判读的 JSON 格式', 'response-unavailable': '响应不可判读',
  'usage-unavailable': '用量未回报，本项不参与能力判定', 'executor-limit-violation': '执行器超出预留上限，本项无效',
  cancelled: '请求被停止，本项无效', 'request-failed': '请求执行失败，本项无效', 'request-timeout': '请求超时，本项无效',
};

export function deepReport(run, inventory = null) {
  if (!run) return null;
  const groups = run.groups.map((group) => {
      const rows = run.results.filter((row) => row.group === group);
      const valid = rows.filter((row) => ['pass', 'fail'].includes(row.outcome));
      const outcome = !valid.length ? 'insufficient' : valid.some((row) => row.outcome === 'fail') ? 'needs-retest'
        : valid.length < (run.plannedByGroup[group] ?? 0) ? 'insufficient' : 'observed-pass';
      const reading = GROUP_READINGS[group];
      return {
        group, planned: run.plannedByGroup[group] ?? 0, valid: valid.length,
        notRun: Math.max((run.plannedByGroup[group] ?? 0) - rows.length, 0),
        pass: valid.filter((row) => row.outcome === 'pass').length,
        fail: valid.filter((row) => row.outcome === 'fail').length,
        invalid: rows.length - valid.length,
        outcome,
        confidence: valid.length ? 'limited' : 'none',
        name: reading.name, purpose: reading.purpose,
        outcomeLabel: { insufficient: '证据不足', 'needs-retest': '需复测', 'observed-pass': '本次样本均通过' }[outcome],
        evidenceLabel: valid.length ? '有限样本' : '暂无有效证据',
        explanation: outcome === 'insufficient' ? rows.length === 0 ? '本项尚未运行，没有结果可以判断；未执行不等于模型能力差。'
          : valid.length === 0 ? '本项已尝试的请求均无有效结果，暂时没有可判读的回答；请求失败不等于模型能力差。'
            : `本项只有 ${valid.length}/${run.plannedByGroup[group] ?? 0} 个计划样本有有效结果，暂时不能作完整判断。未完成或执行失败不等于模型能力差。`
          : outcome === 'observed-pass' ? reading.pass : reading.fail,
        nextStep: outcome === 'insufficient' ? rows.length === 0 ? '确认本项是否应包含在本轮体检中；如需检查，请重新预检并完成本项测试。'
          : '先处理运行中断或无效请求，再完成或重试本项；暂不依据部分结果修改设置。'
          : outcome === 'observed-pass' ? reading.passAction : reading.action,
      };
    });
  const anyFailure = groups.some((row) => row.fail > 0);
  const incomplete = groups.some((row) => row.valid < row.planned);
  const coverageSummary = `本轮覆盖 ${groups.map((row) => row.name).join('、')}，共 ${groups.length} 组；其中“会话内事实更新”是合成对话测试，不是持久记忆检测。`;
  return {
    method: DEEP_METHOD,
    runId: run.id,
    state: run.state,
    groups,
    memoryScope: deepMemoryScope(inventory),
    coverageSummary,
    summary: `${coverageSummary} ${!groups.some((row) => row.valid) ? '本次尚无有效结果，暂时无法判断。'
      : anyFailure ? `本次发现未通过项，建议先复测对应场景。${incomplete ? '部分测试尚无完整有效结果。' : ''}这不等于模型整体能力下降或记忆插件异常。`
        : incomplete ? '已完成的有效样本均通过，但测试尚不完整，暂时不能给出完整结论。'
          : '本次所选项目的合成样本均通过，暂未观察到这些场景中的异常；日常长对话与记忆插件表现仍需另测。'}`,
    evidence: run.results.map(({ id, outcome, reason }) => ({ id,
      outcome: { pass: '通过', fail: '答错', invalid: '无法答题' }[outcome] ?? '未知',
      reason: RESULT_REASONS[reason] ?? '判定原因未知，需核查执行记录',
    })),
    lengths: [...new Set(run.results.filter((row) => row.group === 'context').map((row) => row.lengthLabel))].map((label) => {
      const rows = run.results.filter((row) => row.group === 'context' && row.lengthLabel === label);
      return { label, samples: rows.map(({ position, outcome, reason }) => ({ position, outcome, reason })) };
    }),
    untested: ['COO 原生记忆链路', '第三方持久记忆插件录入/召回/清理', '真实自动交接', '工具流程', '模型普遍智力'],
    limitations: ['每档每位置样本有限，不能据此推荐上下文长度。', '仅适用于当前题集与配置，不能生成硬件或心理健康总分。',
      '合成角色消息由执行器构造，不是实际交接或插件记忆操作。', '未保存原始提示、响应或真实用户内容。'],
  };
}

export function deepReportText(run, inventory = null) {
  if (!run) return '尚无深度体检记录。';
  const report = deepReport(run, inventory);
  const stopText = run.reason ? (run.reasonDetail ? `${run.reason}（${run.reasonDetail}）` : run.reason) : '无';
  return [
    `深度体检 ${DEEP_METHOD} | ${run.id}`, `状态：${run.state}；停止原因：${stopText}`,
    `模型：${run.model}；配置摘要：${run.fingerprint}`,
    '本轮检测项目：', report.coverageSummary,
    '结果速读：', report.summary,
    '记忆检测范围：', report.memoryScope.explanation,
    ...report.memoryScope.targets.map((target) => `${target.name}：${target.status}；${target.detail}`),
    '本次运行条件与消耗：',
    `请求 ${run.requests}/${run.totals.requests}；输入 ${run.usage.inputTokens} Token；输出 ${run.usage.outputTokens} Token`,
    `计量状态：${run.usage.complete && !run.unsettled ? '已回报' : '有未回报用量，不能当作零消耗'}`,
    ...(run.unsettled ? [`未回报请求的预留上限：输入 ${run.unsettled.inputTokens} / 输出 ${run.unsettled.outputTokens} Token；预留不是实耗，不能与已回报用量直接相加。`] : []),
    '分项结果与解读：',
    ...report.groups.flatMap((row) => [
      `${row.name}：${row.outcomeLabel}；有效 ${row.valid}/${row.planned}；通过 ${row.pass}，答错 ${row.fail}，无法答题 ${row.invalid}，未执行 ${row.notRun}；证据强度：${row.evidenceLabel}`,
      `测了什么：${row.purpose}`, `对你意味着什么：${row.explanation}`, `建议下一步：${row.nextStep}`,
    ]),
    '如何读这些结果：有效样本是可完成判分的回答；无效请求不参与能力判定。通过仅代表符合本题预设答案。证据强度描述样本覆盖，不是统计置信度或长期可靠率。',
    '逐项证据（合成测试）：', ...report.evidence.map((row) => `${row.id} | ${row.outcome} | ${row.reason}`),
    `未覆盖：${report.untested.join('、')}`, ...report.limitations,
  ].join('\n');
}

// Local control plane: no provider lookup, cognition or network fallback.
export class DeepCheckup {
  constructor({ executor = null, model = () => null, contextWindow = () => null, stateDir, now = Date.now, save } = {}) {
    this.executor = executor;
    this.model = model;
    this.contextWindow = contextWindow;
    this.directory = stateDir;
    this.now = now;
    this.save = save;
    this.plan = null;
    this.storageError = false;
    this.loadError = false;
    this.run = this.load();
    this.closed = false;
    if (this.run && ACTIVE.has(this.run.state)) {
      this.run.state = 'interrupted';
      this.run.reason = 'process-restarted';
      this.run.usage.complete = false;
      this.run.endedAt = this.now();
      this.persist();
    }
  }

  inspect() {
    if (this.closed) return { ready: false, blockers: ['world-stopped'], model: null, contextWindow: null };
    if (!this.executor) return { ready: false, blockers: ['isolated-executor-unavailable'], model: this.model(), contextWindow: this.contextWindow(), dataScope: null };
    try {
      const value = this.executor.inspect();
      if (Array.isArray(value?.blockers) && value.blockers.length) return { ready: false, blockers: value.blockers,
        model: value.model || this.model(), contextWindow: value.contextWindow || this.contextWindow(), dataScope: value.dataScope ?? null };
      const blockers = [];
      for (const key of CAPABILITIES) if (value?.capabilities?.[key] !== true) blockers.push(`capability-${key}`);
      if (typeof value?.model !== 'string' || !value.model.trim() || value.model.length > 200) blockers.push('model-unavailable');
      if (typeof value?.fingerprint !== 'string' || !value.fingerprint || value.fingerprint.length > 512) blockers.push('fingerprint-unavailable');
      if (!integer(value?.contextWindow) || value.contextWindow < 512) blockers.push('context-window-unavailable');
      if (typeof value?.dataScope !== 'string' || !value.dataScope || value.dataScope.length > 1000) blockers.push('data-scope-unavailable');
      return { ready: !blockers.length, blockers, model: value?.model ?? null, contextWindow: value?.contextWindow ?? null,
        fingerprint: digest(value), endpoint: value?.endpoint ?? null, dataScope: value?.dataScope ?? null };
    } catch {
      return { ready: false, blockers: ['executor-inspection-failed'], model: null, contextWindow: null, dataScope: null };
    }
  }

  preflight(options = {}) {
    this.plan = null;
    if (!options || typeof options !== 'object' || Array.isArray(options)) return { ok: false, error: 'invalid-options' };
    const capability = this.inspect();
    if (!capability.ready) return { ok: true, ready: false, capability, disclosure: DEEP_DISCLOSURE, plan: null };
    if (this.loadError) return { ok: true, ready: false, capability, disclosure: DEEP_DISCLOSURE, plan: null, blockers: ['storage-invalid'] };
    if (ACTIVE.has(this.run?.state)) return { ok: false, error: 'already-running' };
    if (this.run?.unsettled) return { ok: true, ready: false, capability, disclosure: DEEP_DISCLOSURE, plan: null, blockers: ['previous-usage-unsettled'] };
    const groups = options.groups ?? DEEP_GROUPS;
    if (!Array.isArray(groups) || !groups.length || groups.length > DEEP_GROUPS.length || new Set(groups).size !== groups.length || groups.some((group) => !DEEP_GROUPS.includes(group))) return { ok: false, error: 'invalid-groups' };
    const limits = { maxRequests: 20, maxInputTokens: 160000, maxOutputTokens: 16384, maxCostCny: 2, ...options.limits };
    if (!integer(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 40
      || !integer(limits.maxInputTokens) || limits.maxInputTokens < 1 || limits.maxInputTokens > 1000000
      || !integer(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 16384
      || !finite(limits.maxCostCny) || limits.maxCostCny <= 0 || limits.maxCostCny > 100) return { ok: false, error: 'invalid-budget' };
    const seed = randomUUID();
    const cases = makeDeepCases(seed, groups);
    let reservations;
    try {
      reservations = cases.map((testCase) => {
        const row = this.executor.reserve(copy(testCase));
        if (!integer(row?.inputTokens) || row.inputTokens < 1 || !integer(row?.outputTokens) || row.outputTokens !== testCase.maxOutputTokens
          || !finite(row?.maxCostCny) || row.inputTokens + row.outputTokens > capability.contextWindow) throw Error('invalid-reservation');
        return { inputTokens: row.inputTokens, outputTokens: row.outputTokens, maxCostCny: row.maxCostCny,
          durationMs: Array.isArray(row.durationMs) && row.durationMs.length === 2 && row.durationMs.every(finite) && row.durationMs[1] >= row.durationMs[0] ? row.durationMs : null };
      });
    } catch {
      return { ok: true, ready: false, capability, disclosure: DEEP_DISCLOSURE, plan: null, blockers: ['reservation-or-context-unavailable'] };
    }
    const totals = { requests: cases.length, inputTokens: sum(reservations, 'inputTokens'), outputTokens: sum(reservations, 'outputTokens'), maxCostCny: sum(reservations, 'maxCostCny') };
    const fits = totals.requests <= limits.maxRequests && totals.inputTokens <= limits.maxInputTokens && totals.outputTokens <= limits.maxOutputTokens && totals.maxCostCny <= limits.maxCostCny;
    const durations = reservations.every((row) => row.durationMs) ? [sum(reservations.map((row) => ({ ms: row.durationMs[0] })), 'ms'), sum(reservations.map((row) => ({ ms: row.durationMs[1] })), 'ms')] : null;
    const publicPlan = { id: randomUUID(), method: DEEP_METHOD, expiresAt: this.now() + 5 * 60000, groups: [...groups], limits,
      totals, durationMs: durations, model: capability.model, fingerprint: capability.fingerprint, dataScope: capability.dataScope,
      disclosureHash: digest(DEEP_DISCLOSURE), cases: cases.map(({ id, group, lengthLabel, position }) => ({ id, group, lengthLabel, position })) };
    if (fits) this.plan = { public: copy(publicPlan), cases, reservations };
    return { ok: true, ready: fits, capability, disclosure: DEEP_DISCLOSURE, plan: publicPlan, blockers: fits ? [] : ['budget-too-small'] };
  }

  start({ planId, accepted, disclosureHash } = {}) {
    if (this.closed) return { ok: false, error: 'world-stopped' };
    if (ACTIVE.has(this.run?.state)) return { ok: false, error: 'already-running' };
    if (accepted !== true) return { ok: false, error: 'consent-required' };
    const plan = this.plan;
    const cap = this.inspect();
    if (!plan || planId !== plan.public.id || this.now() >= plan.public.expiresAt || disclosureHash !== plan.public.disclosureHash) return { ok: false, error: 'preflight-expired' };
    if (!cap.ready || cap.fingerprint !== plan.public.fingerprint) { this.plan = null; return { ok: false, error: 'configuration-changed' }; }
    this.plan = null;
    const p = plan.public;
    this.run = { schema: 1, id: randomUUID(), method: DEEP_METHOD, state: 'running', reason: null, model: p.model, fingerprint: p.fingerprint,
      startedAt: this.now(), endedAt: null, groups: p.groups, limits: p.limits, totals: p.totals, requests: 0, results: [],
      plannedByGroup: Object.fromEntries(p.groups.map((group) => [group, plan.cases.filter((item) => item.group === group).length])),
      usage: { inputTokens: 0, outputTokens: 0, costCny: 0, complete: true }, unsettled: null, current: null };
    if (!this.persist()) { this.run.state = 'failed'; this.run.reason = 'storage-unavailable'; return { ok: false, error: 'storage-unavailable' }; }
    this.task = this.execute(plan).catch(() => {
      this.run.state = 'failed'; this.run.reason = 'execution-failed'; this.run.endedAt = this.now(); this.persist();
    });
    return { ok: true, runId: this.run.id };
  }

  async execute(plan) {
    let consecutiveFailures = 0;
    for (const [index, testCase] of plan.cases.entries()) {
      if (this.run.state !== 'running' || this.closed) break;
      const cap = this.inspect();
      if (!cap.ready || cap.fingerprint !== plan.public.fingerprint) { this.run.reason = 'configuration-changed'; break; }
      const reservation = plan.reservations[index];
      const { usage, limits } = this.run;
      if (this.run.requests + 1 > limits.maxRequests || usage.inputTokens + reservation.inputTokens > limits.maxInputTokens
        || usage.outputTokens + reservation.outputTokens > limits.maxOutputTokens || usage.costCny + reservation.maxCostCny > limits.maxCostCny + 1e-8) {
        this.run.reason = 'budget-reached'; break;
      }
      this.run.requests += 1;
      this.run.current = testCase.id;
      this.run.unsettled = copy(reservation);
      if (!this.persist()) {
        this.run.requests -= 1; this.run.unsettled = null; this.run.current = null;
        this.run.reason = 'storage-unavailable'; break;
      }
      this.controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; this.controller?.abort(); }, 120000);
      timer.unref?.();
      let response;
      try { response = await this.executor.execute({ runId: this.run.id, testCase: copy(testCase), reservation: copy(reservation), signal: this.controller.signal }); }
      catch { response = null; }
      finally { clearTimeout(timer); this.controller = null; }
      const metered = integer(response?.inputTokens) && integer(response?.outputTokens) && finite(response?.costCny);
      const exceeded = metered && (response.inputTokens > reservation.inputTokens || response.outputTokens > reservation.outputTokens || response.costCny > reservation.maxCostCny + 1e-8);
      const cancelled = this.run.state === 'stopping' || this.closed;
      if (metered) {
        usage.inputTokens += response.inputTokens; usage.outputTokens += response.outputTokens; usage.costCny += response.costCny;
        this.run.unsettled = null;
      } else { usage.complete = false; }
      let score = { outcome: 'invalid', reason: 'usage-unavailable' };
      if (metered) score = exceeded ? { outcome: 'invalid', reason: 'executor-limit-violation' }
        : response.ok !== true ? { outcome: 'invalid', reason: cancelled ? 'cancelled' : 'request-failed' }
          : timedOut ? { outcome: 'invalid', reason: 'request-timeout' } : scoreDeepCase(testCase, response.text);
      const caseDetail = typeof response?.detail === 'string' && response.detail.trim() ? response.detail.trim().slice(0, 180) : undefined;
      this.run.results.push({ id: testCase.id, group: testCase.group, lengthLabel: testCase.lengthLabel ?? null, position: testCase.position ?? null, ...score, ...(caseDetail ? { detail: caseDetail } : {}) });
      if (caseDetail) this.run.reasonDetail = caseDetail;
      const caseIssue = !metered ? 'usage-unavailable'
        : exceeded ? 'executor-limit-violation'
          : timedOut ? 'request-timeout'
            : (response.ok !== true && !cancelled) ? 'request-failed' : null;
      if (caseIssue && !cancelled) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) this.run.reason = caseIssue;
      } else {
        consecutiveFailures = 0;
      }
      if (!this.persist()) this.run.reason = 'storage-unavailable';
      if (this.run.reason) break;
    }
    if (!this.run.reason && this.run.state === 'running') this.run.unsettled = null;
    this.run.current = null;
    this.run.state = this.run.state === 'stopping' || this.closed ? 'stopped' : this.run.reason ? 'paused' : 'completed';
    this.run.endedAt = this.now();
    this.persist();
  }

  stop(reason = 'user-stopped') {
    if (!this.run || !ACTIVE.has(this.run.state)) return { ok: true, stopped: false };
    this.run.state = 'stopping'; this.run.reason = reason;
    this.controller?.abort();
    this.persist();
    return { ok: true, stopped: true, inFlight: !!this.controller };
  }

  open() { this.closed = false; }
  close() { this.stop('world-stopped'); this.closed = true; this.plan = null; }
  status() { return { ok: true, capability: this.inspect(), memoryScope: deepMemoryScope(), run: copy(this.run), report: deepReport(this.run), storageError: this.storageError, loadError: this.loadError }; }
  stateDir() { return this.directory; }

  persist() {
    try {
      if (this.save) this.save(copy(this.run));
      else if (this.stateDir()) {
        mkdirSync(this.stateDir(), { recursive: true });
        const path = join(this.stateDir(), 'deep-checkup.json');
        writeFileSync(`${path}.tmp`, JSON.stringify(this.run), { encoding: 'utf8', mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      } else throw Error('no-storage');
      this.storageError = false;
      return true;
    } catch { this.storageError = true; return false; }
  }

  load() {
    if (!this.stateDir()) return null;
    try {
      const path = join(this.stateDir(), 'deep-checkup.json');
      if (statSync(path).size > 128000) throw Error('invalid-state');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value?.schema !== 1 || typeof value.id !== 'string' || !Array.isArray(value.results) || value.results.length > 40
        || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > DEEP_GROUPS.length || value.groups.some((group) => !DEEP_GROUPS.includes(group)) || !value.plannedByGroup
        || !['running', 'stopping', 'stopped', 'completed', 'paused', 'failed', 'interrupted'].includes(value.state)
        || typeof value.model !== 'string' || typeof value.fingerprint !== 'string' || !finite(value.startedAt)
        || !value.totals || !integer(value.totals.requests) || value.totals.requests > 40 || !integer(value.requests) || value.requests > 40
        || value.groups.some((group) => !integer(value.plannedByGroup[group]))
        || value.results.some((row) => typeof row?.id !== 'string' || !DEEP_GROUPS.includes(row.group) || !['pass', 'fail', 'invalid'].includes(row.outcome) || typeof row.reason !== 'string')
        || !value.limits || !integer(value.limits.maxRequests) || !integer(value.limits.maxInputTokens) || !integer(value.limits.maxOutputTokens) || !finite(value.limits.maxCostCny)
        || !value.usage || typeof value.usage.complete !== 'boolean' || !finite(value.usage.costCny) || !integer(value.usage.inputTokens) || !integer(value.usage.outputTokens)
        || (value.unsettled != null && (!integer(value.unsettled.inputTokens) || !integer(value.unsettled.outputTokens) || !finite(value.unsettled.maxCostCny)))) throw Error('invalid-state');
      return Object.fromEntries(['schema', 'id', 'method', 'state', 'reason', 'reasonDetail', 'model', 'fingerprint', 'startedAt', 'endedAt', 'groups', 'limits', 'totals', 'requests', 'results', 'plannedByGroup', 'usage', 'unsettled', 'current']
        .map((key) => [key, value[key]]));
    } catch (error) { this.loadError = error?.code !== 'ENOENT'; return null; }
  }
}
