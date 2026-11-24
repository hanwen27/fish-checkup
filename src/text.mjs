/**
 * 文案表：zh / en。
 * 中文的 headline / meaning 在 hardware.mjs 与 report.mjs 里就地生成；
 * 这里补齐英文的标题、公式与面板 UI 文案，避免中文硬编码在浏览器端。
 */

export const DIM_TITLES = {
  zh: {
    stability: '稳定性', latency: '响应速度', cache: '缓存与成本',
    context: '上下文配置', handoff: '交接健康', memory: '记忆健康',
  },
  en: {
    stability: 'Stability', latency: 'Latency', cache: 'Cache & cost',
    context: 'Context config', handoff: 'Handoffs', memory: 'Memory',
  },
};

export const DIM_FORMULAS = {
  en: {
    stability: 'Fail rate ≤2% scores a raw 100; 2→10% drops to 80; 10→30% drops to 60; above 30% keeps dropping but floors at 30. The raw score is then mapped through the deficit curve (100→100, 80→88, 60→70). Aborted calls count as half a failure.',
    latency: 'p95 of successful calls only: ≤8s raw 100; 8→25s down to 78; 25→60s down to 58; above 60s keeps dropping but floors at 30, then mapped through the deficit curve.',
    cache: 'Weighted hit rate = cached input / total input. ≥85% raw 100, 60→85% down to 68. Each prefix change per 1000 records costs 1.6 points, capped at 18. Raw score then goes through the deficit curve.',
    context: 'Five checks in three bands (met 1 / marginal 0.6 / off 0): maxTokens ≤ 90% of the window; softRatio in 0.70–0.92; keepRatio in 0.15–0.40; hard ≥ soft×1.5 and ≤60; firstTurn does not conflict with keepRatio. Missing values are dropped from the denominator.',
    handoff: 'Four checks in three bands: gap CV ≤0.5; every file ≥200 bytes; no two adjacent files identical; gaps not shorter than 10 minutes. A few outliers count as marginal, not failed.',
    memory: 'Five checks in three bands: retrieval hit rate ≥40%; average retrieval ≤300ms; invalid entries ≤5%; retrieve log ≤3× the entry file; stale entries ≤60%. Slightly off counts as marginal.',
  },
};

export const STATES = {
  zh: { ok: '正常', warn: '还可以更好', bad: '有问题', unknown: '数据不足' },
  en: { ok: 'OK', warn: 'Could improve', bad: 'Issue', unknown: 'No data' },
};

export const LEVELS = {
  zh: { solid: '稳', good: '良好', fair: '有几处可以更好', poor: '有明确问题', insufficient: '样本不足' },
  en: { solid: 'Solid', good: 'Good', fair: 'A few things', poor: 'Clear issues', insufficient: 'Not enough data' },
};

export const UI = {
  zh: {
    appTitle: '体检报告',
    tabHardware: '硬件',
    tabPersona: '人格',
    tabMethod: '口径',
    refresh: '刷新',
    copy: '复制报告',
    copied: '已复制',
    overall: '总分',
    noOverall: '样本不足，暂不给总分',
    unknownDims: (n) => `${n} 项数据不足，其余照算`,
    evidence: '依据',
    formula: '怎么算的',
    meaning: '这意味着什么',
    footer: '只读取，不修改。',
    personaTitle: '人格测试',
    personaType: '人格类型',
    selfPortrait: '自述画像',
    behaviorPortrait: '行为画像',
    consistency: '一致性',
    notTaken: '还没做过测验',
    notTakenHint: '她需要自己在对话里答，我不能代填。',
    startQuiz: '让她做一次人格测验',
    starting: '正在通知她…',
    started: '已经通知她了，等她自己来答题。',
    lastTaken: '上次测验',
    anchors: '锚点一致率',
    flags: '备注',
    flagFlat: '有轴答得过于整齐，已排除',
    flagPartial: '只答了一部分',
    flagUnstable: '前后作答不太一致，仅供参考',
    noAxes: '四轴都没有足够数据。',
    lettersNote: '这是从她的选择和她的行为里读出来的，不是临床量表。',
    measuredAt: '采集时间',
    samples: '样本',
    dimSourceHint: '数据来自本机文件，路径见「口径」。',
    missing: '缺',
    none: '—',
    methodIntro: '两份报告分开算，任何时候都不合成一个总分：硬件是「运行状态」，人格是「她是谁」。',
    methodHardware: '硬件六维',
     methodHardwarePrinciples: '评价原则：只看有足够样本的记录；按失败率、分位耗时和结构性检查分段计分；极端单点用分位数和每日最小样本门槛抑制；低分代表需要排查，不等于服务完全不可用。原始数量、最差日期和计算公式始终保留在维度详情里。',
    methodPersona: '人格测试',
    methodPersonaBody: '自评 28 题（24 道情境题 + 4 道锚点），分两批；题干不含人格词，选项顺序按日期打乱。再用 memory 里真实的行为痕迹映射同一套四轴，逐轴比对。缺数据就不给该轴，绝不外推。',
    methodSources: '数据来源',
    methodReadOnly: '它不做什么',
    methodReadOnlyBody: '不改任何文件、不发网络请求、不调模型、不配 key；除自己的 data/self-checkup/ 之外不写一个字节。',
  },
  en: {
    appTitle: 'Checkup',
    tabHardware: 'Hardware',
    tabPersona: 'Personality',
    tabMethod: 'Method',
    refresh: 'Refresh',
    copy: 'Copy report',
    copied: 'Copied',
    overall: 'Overall',
    noOverall: 'Not enough data for a total',
    unknownDims: (n) => `${n} dimension(s) lacked data and were excluded`,
    evidence: 'Evidence',
    formula: 'How it is computed',
    meaning: 'What it means',
    footer: 'Reads only. Writes nothing.',
    personaTitle: 'Personality test',
    personaType: 'Type',
    selfPortrait: 'Self-report',
    behaviorPortrait: 'Behaviour',
    consistency: 'Consistency',
    notTaken: 'No test yet',
    notTakenHint: 'She has to answer it herself in conversation; nothing can be filled in for her.',
    startQuiz: 'Ask her to take the test',
    starting: 'Notifying her…',
    started: 'She has been notified; wait for her to answer.',
    lastTaken: 'Last taken',
    anchors: 'Anchor agreement',
    flags: 'Notes',
    flagFlat: 'One axis answered too uniformly and was dropped',
    flagPartial: 'Only partially answered',
    flagUnstable: 'Answers were inconsistent; treat as indicative only',
    noAxes: 'No axis had enough data.',
    lettersNote: 'Read from her choices and her behaviour, not a clinical instrument.',
    measuredAt: 'Collected',
    samples: 'Sample',
    dimSourceHint: 'Numbers come from local files; paths are listed under Method.',
    missing: 'missing',
    none: '—',
    methodIntro: 'Two separate reports, never merged into one score: hardware is how it runs, personality is who she is.',
    methodHardware: 'Hardware',
    methodPersona: 'Personality',
    methodPersonaBody: '28 self-report items (24 situational + 4 anchors) in two batches. No personality vocabulary in the prompts; option order is shuffled by date. The same four axes are then mapped from real traces in memory and compared axis by axis. Missing data yields no score, never an extrapolation.',
    methodSources: 'Data sources',
    methodReadOnly: 'What it does not do',
    methodReadOnlyBody: 'No writes outside its own data/self-checkup/, no network, no model calls, no keys.',
  },
};

export function pick(language) {
  const zh = String(language ?? 'zh').toLowerCase().startsWith('zh');
  return zh ? 'zh' : 'en';
}
