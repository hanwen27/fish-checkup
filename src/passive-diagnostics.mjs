/** Read-only operational diagnostics. Only aggregate, whitelisted fields leave this module. */
import { openSync, closeSync, fstatSync, readSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86400000;
const LIMITS = { bytes: 8 * 1024 * 1024, lines: 20000, runs: 256, toolLines: 1000, toolBytes: 256 * 1024 };
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const label = (v, fallback = '未上报') => typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : fallback;
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const percentile = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] : null; };

export function readBoundedJsonl(file, { bytes = LIMITS.bytes, lines = LIMITS.lines } = {}) {
  let fd;
  try {
    // Do not follow a symlink supplied by a data file.
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return { state: 'unsupported', rows: [], limited: false, bad: 0 };
    fd = openSync(file, 'r'); const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes), buffer = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    let all = text.split(/\r?\n/).filter((x) => x.trim());
    const limited = start > 0 || all.length > lines; all = all.slice(-lines);
    const rows = []; let bad = 0;
    for (const line of all) { try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row); else bad++; } catch { bad++; } }
    return { state: 'ready', rows, limited, bad };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable', rows: [], limited: false, bad: 0 }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function clock(timezone) {
  let tz = timezone;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(); } catch { tz = 'UTC'; }
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  return { timezone: formatter.resolvedOptions().timeZone, at(ts) { const p = Object.fromEntries(formatter.formatToParts(ts).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour }; } };
}

export function normalizeUsage(rows, { since, until }) {
  const records = []; const seen = new Set(); let duplicates = 0, invalidTime = 0, excludedTime = 0;
  for (const row of rows) {
    const attempt = row.attempt;
    const time = row.ts ?? attempt?.startedAt;
    const ts = typeof time === 'string' ? Date.parse(time) : NaN;
    if (!Number.isFinite(ts)) { invalidTime++; continue; }
    if (ts < since || ts > until) { excludedTime++; continue; }
    const keys = [typeof row.recordId === 'string' && row.recordId ? `r:${row.recordId}` : null, typeof attempt?.id === 'string' && attempt.id ? `a:${attempt.id}` : null].filter(Boolean);
    if (keys.some((key) => seen.has(key))) { duplicates++; continue; } for (const key of keys) seen.add(key);
    const meters = attempt?.meters;
    // Explicitly missing v2 meters must never fall back to legacy compatibility zeros.
    const input = num(meters ? meters.input : row.promptTokens);
    const output = num(meters ? meters.output : row.completionTokens);
    const rawCache = num(meters ? meters.cachedInput : row.cacheHitTokens);
    const cached = rawCache !== null && (input === null || rawCache <= input) ? rawCache : null;
    const session = label(row.sessionId, '未上报');
    const world = session.startsWith('worlds.') ? session.slice(7) : null;
    records.push({ ts, input, output, cached, reasoning: num(meters ? meters.reasoning : row.reasoningTokens),
      model: label(attempt?.origin?.model ?? row.model), role: label(row.role), session,
      world, run: typeof row.run === 'string' ? row.run : null,
      purpose: label(attempt?.purpose, '未标注'), outcome: label(attempt?.outcome ?? row.outcome, '未标注'),
      complete: input !== null && output !== null, total: (input ?? 0) + (output ?? 0) });
  }
  return { records, duplicates, invalidTime, excludedTime };
}

function bucket() { return { requests: 0, complete: 0, input: 0, output: 0, cached: 0, cacheKnown: 0, cacheComparableInput: 0, reasoning: 0, reasoningKnown: 0, inputKnown: 0, outputKnown: 0, failedKnown: 0 }; }
function add(to, row) {
  to.requests++; if (row.complete) to.complete++;
  if (row.input !== null) { to.input += row.input; to.inputKnown++; }
  if (row.output !== null) { to.output += row.output; to.outputKnown++; }
  if (row.cached !== null && row.input !== null) { to.cached += row.cached; to.cacheKnown++; to.cacheComparableInput += row.input; }
  if (row.reasoning !== null) { to.reasoning += row.reasoning; to.reasoningKnown++; }
  if (['failed', 'aborted', 'discarded'].includes(row.outcome)) to.failedKnown += row.total;
}
const finish = (b) => ({ ...b, knownTotal: b.inputKnown + b.outputKnown ? b.input + b.output : null, missingInput: b.requests - b.inputKnown, missingOutput: b.requests - b.outputKnown,
  uncachedPaired: b.cacheKnown ? b.cacheComparableInput - b.cached : null, cacheRate: b.cacheComparableInput > 0 ? b.cached / b.cacheComparableInput : null });
function grouped(records, key) {
  const map = new Map(); for (const row of records) { const id = key(row); if (!map.has(id)) map.set(id, bucket()); add(map.get(id), row); }
  return [...map].map(([name, value]) => ({ name, ...finish(value) })).sort((a, b) => b.knownTotal - a.knownTotal);
}

export function buildTokenReport(records, { timezone, since, until, source = {} } = {}) {
  const c = clock(timezone); const sum = bucket(); for (const row of records) add(sum, row);
  const days = grouped(records, (r) => c.at(r.ts).day).sort((a, b) => a.name.localeCompare(b.name));
  const hours = grouped(records, (r) => `${c.at(r.ts).hour}:00`);
  const worlds = records.filter((r) => r.world !== null);
  const comparisons = [];
  const today = c.at(until).day;
  for (const group of grouped(records, (r) => `${r.model} · ${r.role}`).slice(0, 30)) {
    const eligible = records.filter((r) => `${r.model} · ${r.role}` === group.name && r.complete && c.at(r.ts).day < today);
    const dayGroups = new Map(); for (const row of eligible) { const day = c.at(row.ts).day; if (!dayGroups.has(day)) dayGroups.set(day, []); dayGroups.get(day).push(row.total); }
    const samples = [...dayGroups].filter(([, values]) => values.length >= 5).sort(([a], [b]) => a.localeCompare(b));
    if (samples.length < 4) continue;
    const [day, values] = samples.at(-1); const baseline = median(samples.slice(0, -1).map(([, xs]) => xs.reduce((a, b) => a + b, 0) / xs.length));
    const average = values.reduce((a, b) => a + b, 0) / values.length;
    if (baseline > 0) comparisons.push({ name: group.name, day, average, baseline, ratio: average / baseline,
      state: average / baseline >= 1.5 ? 'higher' : 'within-reference', baselineDays: samples.length - 1, samples: values.length });
  }
  const summary = !records.length ? '本期没有可用用量记录，无法判断消耗。'
    : sum.complete < sum.requests ? `本期 ${sum.requests} 条用量记录中，${sum.requests - sum.complete} 条输入或输出未完整上报；显示值是已知消耗，实际总量可能更高。`
      : comparisons.some((x) => x.state === 'higher') ? '部分同模型、同角色的单次用量较历史参考升高。请结合任务变化检查；这不是故障结论。'
        : comparisons.length ? '可比较组的单次用量未达到本页“历史参考的 1.5 倍”提示线；这不代表所有插件或任务均正常。'
          : '已汇总本期消耗；同模型、同角色的完整历史样本不足，暂不判定消耗是否异常。';
  return { ...finish(sum), state: source.state, source, since, until, timezone: c.timezone, summary, days, hours,
    byModel: grouped(records, (r) => r.model), byRole: grouped(records, (r) => r.role), byPurpose: grouped(records, (r) => r.purpose),
    worldReported: grouped(worlds, (r) => r.world), shared: finish(records.filter((r) => r.world === null).reduce((b, r) => { add(b, r); return b; }, bucket())), comparisons,
    limits: '仅本机 usage.jsonl 中可读窗口；失败、取消、丢弃、诊断与非主会话的已知用量均计入。插件绕过 COO 的调用可能缺失。推理 Token 通常是输出子集，不与输入/输出重复相加。缓存只在有输入与缓存计量的配对样本计算。' };
}

export function collectToolActivity(dataDir, { since, until }) {
  const items = []; let files = 0, limited = false, unreadable = 0, bad = 0;
  try {
    const directory = join(dataDir, 'runs');
    if (lstatSync(directory).isSymbolicLink()) return { state: 'unsupported', rows: [], files: 0, limited: false };
    const dirs = readdirSync(directory, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).sort((a, b) => b.name.localeCompare(a.name));
    limited = dirs.length > LIMITS.runs;
    for (const entry of dirs.slice(0, LIMITS.runs)) {
      const result = readBoundedJsonl(join(directory, entry.name, 'toolcalls.jsonl'), { bytes: LIMITS.toolBytes, lines: LIMITS.toolLines });
      if (result.state === 'missing') continue; files++; if (result.state !== 'ready') unreadable++;
      limited ||= result.limited; bad += result.bad;
      for (const row of result.rows) {
        const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
        if (!Number.isFinite(ts) || ts < since || ts > until) continue;
        items.push({ ts, mod: label(row.mod, 'Persona／归属未上报'), chars: num(row.chars), ms: num(row.durMs), failed: row.failed === true });
      }
    }
  } catch (e) { return { state: e.code === 'ENOENT' ? 'missing' : 'unreadable', rows: [], files, limited, unreadable, bad }; }
  const groups = new Map(); for (const row of items) {
    if (!groups.has(row.mod)) groups.set(row.mod, { id: row.mod, calls: 0, chars: 0, charsKnown: 0, failures: 0, durations: [], hours: new Map() });
    const g = groups.get(row.mod); g.calls++; g.failures += Number(row.failed);
    if (row.chars !== null) { g.chars += row.chars; g.charsKnown++; } if (row.ms !== null) g.durations.push(row.ms);
    g.hours.set(Math.floor(row.ts / 3600000) * 3600000, (g.hours.get(Math.floor(row.ts / 3600000) * 3600000) ?? 0) + 1);
  }
  return { state: 'ready', files, limited, unreadable, bad, rows: [...groups.values()].map((g) => ({ id: g.id, calls: g.calls, chars: g.chars, charsKnown: g.charsKnown, failures: g.failures,
    medianMs: median(g.durations), peakAt: [...g.hours].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null })).sort((a, b) => b.chars - a.chars).slice(0, 30) };
}

export function buildContextReport(records, snapshot, { contextWindow = null, since, until } = {}) {
  const cfg = snapshot?.config?.context ?? {};
  const configured = num(cfg.maxTokens); const window = num(contextWindow);
  const softRatio = num(cfg.softRatio); const keepRatio = num(cfg.keepRatio);
  // Input usage includes request overhead and is not a live context gauge or an effective input limit.
  const primary = records.filter((r) => r.role === 'main' && r.purpose !== 'diagnostic' && !r.world);
  const inputs = primary.filter((r) => r.input !== null).map((r) => r.input);
  const handoffs = snapshot?.handoffs;
  const files = Array.isArray(handoffs?.files) ? handoffs.files.filter((f) => f.timeSource && f.timeSource !== 'mtime' && Number.isFinite(f.ts) && f.ts >= since && f.ts <= until) : [];
  const runs = new Set(primary.map((r) => r.run).filter(Boolean)).size;
  const incompatible = configured > 0 && window > 0 && configured > window;
  const headline = incompatible ? '配置的上下文目标超过当前模型标称窗口，建议先核对配置与提供方限制。'
    : inputs.length ? '已有请求输入和交接记录，可观察运行负担；这些数据不能证明是否忘事或注意力下降。'
      : '缺少主会话输入计量，暂不能判断上下文在日常使用中是否够用。';
  return { configured, modelWindow: window, softRatio, keepRatio, softTarget: configured && softRatio !== null ? Math.round(configured * softRatio) : null,
    estimatedMedianInput: median(inputs), p90Input: percentile(inputs, .9), maxObservedInput: inputs.length ? Math.max(...inputs) : null, inputSamples: inputs.length,
    currentOccupancy: null, effectiveInputLimit: null, samplesNearTarget: configured > 0 ? inputs.filter((x) => x >= configured * .85).length : null,
    handoffs: files.length, handoffSource: handoffs?.ok ? 'ready' : 'unavailable', handoffLimited: files.length >= 30,
    activeRuns: runs, handoffsPer100Runs: null,
    summary: headline, source: '主会话请求输入计量 + 有日期的交接笔记（最多 30 份） + 配置目标',
    limitations: ['请求输入并非实时上下文占用，含系统提示、工具、记忆和历史，当前无法拆分。', '没有可关联的完整交接事件与轮次，不能将笔记数除以运行次数冒充交接率；前后 Token、触发原因与交接开销尚不可核验。', '当前模型窗口是本次宿主信息；历史输入可能来自其它模型或旧配置，不据此计算统一占用百分比。', '上下文短不等于必然忘事，长不等于必然降智。长度、任务、记忆召回和模型利用需主动检测及真实日常证据。'],
    advice: incompatible ? '先核对上下文目标、模型窗口与输出预留；页面不自动修改设置。' : '先看输入高位与交接是否伴随实际任务中断；没有任务失败证据时，不建议仅凭 128K／256K 数字调大或调小。' };
}

export function buildMemoryReport(snapshot, { inventory = null, activity = null } = {}) {
  const base = snapshot?.memory?.base;
  const rows = [];
  rows.push({ id: 'workspace-storage', name: '本地工作区记忆文件', kind: '原生存储', installed: true, enabled: base?.state === 'ready', active: null, tested: false,
    status: base?.state === 'ready' ? 'observed' : base?.state ?? 'unknown',
    evidence: base?.state === 'ready' ? `可读文件 ${base.readable ?? 0} 个${base.limited ? '（已达单次采样上限）' : ''}` : '工作区目录缺失或不可读',
    detail: base?.state === 'ready' ? '本机工作区记忆目录读写正常（只读统计，不写入记忆）。' : '请检查配置的工作区记忆路径。' });
  const inventoryReady = ['read', 'ready'].includes(inventory?.status);
  const allExtensions = inventoryReady && Array.isArray(inventory.rows) ? inventory.rows.slice(0, 100) : [];
  const memoryRe = /memory|brain|fishtools|fishbrain|continuity|记忆|鱼脑/i;
  const memExtensions = allExtensions.filter((item) => {
    const id = String(item.id ?? '');
    const pkg = String(item.name ?? '');
    if (id === 'self-checkup' || pkg === 'cortico-world-self-checkup') return false;
    return memoryRe.test(`${id} ${pkg} ${item.label ?? ''} ${item.description ?? ''}`);
  });
  const cleanDesc = (raw, fallback) => {
    const t = String(raw ?? '').split(/\s*\/\s*Fish-brain:/i)[0].replace(/\s+/g, ' ').trim();
    if (!t) return fallback;
    return t.length > 56 ? `${t.slice(0, 56)}…` : t;
  };
  let pluginCalls = 0, pluginFailures = 0;
  for (const item of memExtensions) {
    const id = label(item.id, 'unknown');
    const found = activity?.rows?.find((r) => r.id === id);
    const calls = found?.calls ?? 0;
    const failures = found?.failures ?? 0;
    if (item.enabled === true) { pluginCalls += calls; pluginFailures += failures; }
    rows.push({ id, name: label(item.label, label(item.name, id)), packageName: label(item.name, id), description: label(item.description, ''), kind: label(item.kind, '记忆插件'), version: label(item.version), installed: true,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : null, active: null, tested: false, status: 'listed', calls, failures, medianMs: found?.medianMs ?? null,
      evidence: found ? `近窗口调用 ${found.calls} 次${found.failures ? `（失败 ${found.failures} 次）` : ''}` : '近窗口无工具调用记录',
      detail: cleanDesc(item.description, '已从本机宿主扩展清单识别。') });
  }
  const m = snapshot?.memory;
  const compatible = m?.ok && (m.entries || m.retrieve);
  const telemetry = compatible ? { name: '记忆检索日志统计', sourceVerified: false, count: m.entries?.total ?? null,
    retrievals: m.retrieve?.total ?? null, hitRate: m.retrieve?.hitRate ?? null, injectedRate: m.retrieve?.injectedRate ?? null, avgMs: m.retrieve?.avgMs ?? null,
    detail: '来自本机记忆日志（至少 14 天窗口），展示记忆条目数、检索次数、命中率与平均耗时。' } : null;
  const enabledMem = memExtensions.filter((item) => item.enabled === true);
  const enabledMemCount = enabledMem.length;
  const enabledNames = enabledMem.map((item) => label(item.label, label(item.name, item.id)));
  const handoffFiles = Array.isArray(snapshot?.handoffs?.files) ? snapshot.handoffs.files : [];
  const workspaceReady = base?.state === 'ready';
  const modeLabel = enabledNames.length ? `原生记忆 + ${enabledNames.join(' / ')}` : 'Coo 原生工作区记忆';
  const headline = !workspaceReady
    ? '本地工作区记忆目录未就绪，请先检查配置路径。'
    : enabledNames.length
      ? `当前由「${modeLabel}」协同维持记忆，本地读写正常${pluginCalls > 0 ? `，近期记忆插件活跃 ${pluginCalls} 次` : ''}。`
      : `当前由「Coo 原生工作区记忆」维持记忆，本地已可读 ${base?.readable ?? 0} 个记忆文件，运行正常。`;
  return { inventoryState: inventoryReady ? 'ready' : inventory?.status ?? 'not-read', rows, telemetry,
    workspace: { readable: workspaceReady, files: base?.readable ?? 0, limited: Boolean(base?.limited) },
    overview: {
      tone: workspaceReady ? 'ok' : 'warn',
      badge: workspaceReady ? '记忆状态正常' : '需检查目录',
      headline,
      modeLabel,
      totalExtensions: allExtensions.length,
      memPluginCount: memExtensions.length,
      enabledPluginCount: enabledMemCount,
      enabledNames,
      pluginCalls,
      pluginFailures,
      handoffsCount: handoffFiles.length,
      entriesTotal: m?.entries?.total ?? null,
    },
    summary: inventoryReady
      ? `已扫描 ${allExtensions.length} 个扩展，识别到 ${memExtensions.length} 个记忆相关插件（已启用 ${enabledMemCount} 个）。`
      : '宿主清单尚未提供，无法确认已安装的记忆插件；当前仅展示本地工作区记忆文件与兼容日志。',
    testedImplementations: 0, limitations: ['此页为只读观察，不写入测试记忆、不额外调用模型。'] };
}

export function collectPassiveDiagnostics({ dataDir, snapshot, contextWindow, inventory, timezone, now = Date.now(), sampleDays = 7 }) {
  const until = now; const since = until - Math.min(90, Math.max(1, sampleDays)) * DAY;
  const source = readBoundedJsonl(join(dataDir, 'usage.jsonl'));
  const { records, ...quality } = normalizeUsage(source.rows, { since, until });
  const activity = collectToolActivity(dataDir, { since, until });
  const usage = buildTokenReport(records, { timezone, since, until, source: { state: source.state, limited: source.limited, bad: source.bad, ...quality } });
  const pluginLabels = {};
  if (['read', 'ready'].includes(inventory?.status) && Array.isArray(inventory?.rows)) {
    for (const row of inventory.rows) {
      if (row?.id && row?.label) pluginLabels[String(row.id)] = String(row.label);
      if (row?.name && row?.label) pluginLabels[String(row.name)] = String(row.label);
    }
  }
  return { version: '1.2.0', method: 'passive-1', generatedAt: now, sampleDays, usage, activity, pluginLabels,
    memory: buildMemoryReport(snapshot, { inventory, activity }), context: buildContextReport(records, snapshot, { contextWindow, since, until }),
    disclosure: '本页只读本机已有记录，不额外调用模型，不写入正式记忆。所展示的是采样范围内的已知统计；缺报、读取失败和范围上限均披露，页面不自动调整配置。' };
}

export function passiveReportText(report) {
  const { usage: u, context: c, memory: m, activity: a } = report;
  return ['鱼鱼体检 1.2.0 · 日常被动诊断', report.disclosure,
    `窗口：${new Date(u.since).toISOString()} — ${new Date(u.until).toISOString()}；时区 ${u.timezone}`,
    `Token：${u.summary}`, `已知输入 ${u.inputKnown ? u.input : '未知'}；已知输出 ${u.outputKnown ? u.output : '未知'}；已知合计 ${u.inputKnown + u.outputKnown ? u.knownTotal : '未知'}；记录 ${u.requests}；完整计量 ${u.complete}`,
    `读取状态 ${u.state}；采样截断 ${u.source.limited ? '是' : '否'}；坏行 ${u.source.bad}；时间无效 ${u.source.invalidTime}；去重 ${u.source.duplicates}`, u.limits,
    '按日已知输入+输出：', ...u.days.map((d) => `${d.name}：${d.knownTotal} Token / ${d.requests} 条；完整 ${d.complete}`),
    '插件独立上报（只限 worlds.<id> 仪表项，不代表调用者归因）：', ...u.worldReported.map((r) => `${r.name}：${r.knownTotal} 已知 Token / ${r.requests} 条`),
    `共享／未归因：${u.shared.knownTotal} 已知 Token。工具调用和回执字符不等于 Token 账单。`,
    '工具活动：', ...a.rows.map((r) => `${r.id}：${r.calls} 次、${r.charsKnown ? r.chars : '未知'} 回执字符、${r.failures} 失败`),
    `上下文：${c.summary}`, `配置目标 ${c.configured ?? '未知'}；当前模型窗口 ${c.modelWindow ?? '未知'}；主会话输入 P90 ${c.p90Input ?? '未知'}；实时占用／有效输入上限未知。`,
    `有日期交接笔记 ${c.handoffs}，来源 ${c.handoffSource}；达到 30 份 ${c.handoffLimited ? '是' : '否'}；不作为完整交接次数或频率。`, c.advice, ...c.limitations,
    `记忆：${m.summary}`, ...m.rows.map((r) => `${r.name}：${r.status}；启用 ${r.enabled === null ? '未知' : r.enabled ? '是' : '否'}；当前使用未知；主动测试未执行。${r.evidence}。${r.detail}`),
    ...(m.telemetry ? [`${m.telemetry.name}：条目 ${m.telemetry.count ?? '未知'}，检索 ${m.telemetry.retrievals ?? '未知'}，命中比 ${m.telemetry.hitRate ?? '未知'}；${m.telemetry.detail}`] : []), ...m.limitations].join('\n');
}
