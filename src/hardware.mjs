/**
 * 硬件健康：六个维度，纯函数，零模型。
 *
 * 每个维度统一产出：
 *   { id, title, weight, state:'ok'|'warn'|'bad'|'unknown', score, headline,
 *     evidence:[{label,value,hint}], formula, meaning }
 *
 * state 映射（score 到 state）由 grade() 统一给，各维度只管算分。
 * 缺数据一律 unknown，绝不用 0 分冒充「很差」。
 */

import { calibrate, apdex, CREDIT, checksScore, mark, CALIBRATION_VERSION } from './scale.mjs';
import { modelCallRecords } from './usage-metrics.mjs';

/**
 * 分数 → 状态。
 *
 * 阈值跟「展示分」的量纲走，不是跟原始比例走。
 * 展示分 78 已经意味着「多数时候没问题」，写成「该看看」会让人白紧张一场。
 */
export function grade(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= 78) return 'ok';
  if (score >= 60) return 'warn';
  return 'bad';
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const pct = (v) => (Number.isFinite(v) ? `${round1(v * 100)}%` : '—');

/** 由阈值对 (x0→s0, x1→s1) 做线性内插，区间外取端点。 */
function lerpScore(x, x0, s0, x1, s1) {
  if (!Number.isFinite(x)) return null;
  if (x <= Math.min(x0, x1)) return x0 < x1 ? s0 : s1;
  if (x >= Math.max(x0, x1)) return x0 < x1 ? s1 : s0;
  const t = (x - x0) / (x1 - x0);
  return s0 + t * (s1 - s0);
}

/** 分位数（nearest-rank，抗单点异常）。 */
export function percentile(xs, q) {
  if (!xs || xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}

/** 按本地日分桶，用于逐日对比。 */
export function dayKeyOf(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MIN_SAMPLE = 50;

/** 一天之内至少这么多条，才给那天算一个点；不够就留 null（图上断线，不假装）。 */
const MIN_DAY_SAMPLE = 5;

/**
 * 按天把记录打分，产出稀疏序列。
 *   bucketFn(recs) → 该天的「原子值」（失败率、p95 毫秒、命中率…）
 *   scoreFn(atom)  → 0..100
 * 返回 { series:[{day,n,score}], delta, recent }。
 *
 * delta 的算法很关键：不能拿「后半段均值 vs 前半段均值」——
 * 中间炸一天、最后一天又好了，会被算成「在好转」，把真正的坑抹掉。
 * 这里改成「最近 3 个点 vs 更早所有点的中位数」：中位数抗单日异常，
 * 最近点用均值是为了让「昨天刚坏」能被看见。点数不足 4 个就明说没得比。
 */
function dailySeries(recs, bucketFn, scoreFn) {
  const perDay = new Map();
  for (const r of recs) {
    if (!Number.isFinite(new Date(r.ts).getTime())) continue;
    const day = dayKeyOf(r.ts);
    const list = perDay.get(day) ?? [];
    list.push(r);
    perDay.set(day, list);
  }
  const loggedDays = [...perDay.keys()].sort();
  const firstDay = Date.parse(loggedDays[0]);
  const lastDay = Date.parse(loggedDays.at(-1));
  const span = Math.round((lastDay - firstDay) / 86400000) + 1;
  const days = span > 0 && span <= 90
    ? Array.from({ length: span }, (_, i) => new Date(firstDay + i * 86400000).toISOString().slice(0, 10))
    : loggedDays;
  const series = days.map((day) => {
    const list = perDay.get(day) ?? [];
    if (list.length < MIN_DAY_SAMPLE) return { day, n: list.length, score: null };
    const atom = bucketFn(list);
    const s = Number.isFinite(atom) ? scoreFn(atom) : null;
    return { day, n: list.length, score: Number.isFinite(s) ? round1(clamp(s)) : null };
  });
  const points = series.filter((p) => Number.isFinite(p.score));

  const mean = (arr) => arr.reduce((a, p) => a + p.score, 0) / arr.length;
  const medianOf = (arr) => {
    const s = arr.map((p) => p.score).sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const recent = points.length > 0 ? points[points.length - 1] : null;

  let delta = null;
  let comparison = null;
  if (points.length >= 4) {
    const win = Math.min(3, Math.floor(points.length / 2));
    const late = points.slice(points.length - win);
    const early = points.slice(0, points.length - win);
    delta = mean(late) - medianOf(early);
    const windowOf = (items) => ({ start: items[0].day, end: items.at(-1).day, days: items.length });
    comparison = { earlier: windowOf(early), recent: windowOf(late) };
  }
  return { series, delta, comparison, recent };
}


/* ---------------------------------------------------------------- 稳定性 */

/**
 * 失败率 → 原始分（还没上量表曲线）。
 *
 * 两段阈值是有意分开的：
 *   2% 以内是正常波动；2→10% 是轻度；10→30% 值得看一眼；30% 以上确实频繁。
 * 下限 30：全部失败也只到 30，不再压到 0——「一个都不成」和「零分」是两件事，
 * 后者只会让人以为这页坏了。真正要表达的严重程度写在证据与状态里。
 */
function stabilityRaw(rate) {
  if (!Number.isFinite(rate)) return null;
  if (rate <= 0.02) return 100;
  if (rate <= 0.10) return lerpScore(rate, 0.02, 100, 0.10, 80);
  if (rate <= 0.30) return lerpScore(rate, 0.10, 80, 0.30, 60);
  return clamp(60 - Math.min(30, (rate - 0.30) * 100), 30, 100);
}

export function stability(usage) {
  const all = usage?.records ?? [];
  const recs = modelCallRecords(usage);
  const excluded = all.length - recs.length;
  if (!usage?.ok || recs.length < MIN_SAMPLE) {
    return dim('stability', '稳定性', 0.22, {
      state: 'unknown',
      score: null,
      headline: recs.length === 0 ? '还没有用量记录，没法判断稳不稳。' : `只有 ${recs.length} 次调用，样本太少，先不下结论。`,
      evidence: [
        { label: '样本条数', value: String(recs.length), hint: `门槛 ${MIN_SAMPLE} 条` },
        { label: '排除记录', value: String(excluded), hint: '诊断、非主会话及已丢弃响应不计入模型稳定性' },
        { label: '数据文件', value: usage?.path ?? '—', hint: usage?.reason ?? '' },
      ],
      formula: '失败率 ≤2% 得满分；2%→10% 线性降到 80；10%→30% 线性降到 60；超过 30% 每多 1% 再扣 1.5 分，下限 45。被中断（aborted）按半次失败计。',
      meaning: '这里看的是模型调用有没有频繁出错——出错多她会反复重试，你能直接感觉到她「卡」。',
    });
  }
  const total = recs.length;
  let failed = 0;
  let aborted = 0;
  let completed = 0;
  const perDay = new Map();
  for (const r of recs) {
    const day = dayKeyOf(r.ts);
    const slot = perDay.get(day) ?? { n: 0, bad: 0 };
    slot.n += 1;
    if (r.outcome === 'completed') completed += 1;
    else if (r.outcome === 'aborted') { aborted += 1; slot.bad += 0.5; }
    else { failed += 1; slot.bad += 1; }
    perDay.set(day, slot);
  }
  // 逐日失败率：能从「某几天集中坏」和「持续坏」里分辨出来——这两种该看的地方不一样。
  const daily = [...perDay.entries()]
    .map(([day, s]) => ({ day, n: s.n, bad: s.bad, rate: s.n > 0 ? s.bad / s.n : 0 }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const worstDay = daily.filter((d) => d.n >= 10).sort((a, b) => b.rate - a.rate)[0] ?? null;
  const weightedFail = failed + aborted * 0.5;
  const rate = weightedFail / total;
  const raw = stabilityRaw(rate);
  const score = calibrate(raw);
  // 逐日曲线用同一套映射：原始分 → 量表曲线，跟总分保持同一条口径。
  const dayScore = (r) => calibrate(stabilityRaw(r));
  const { series, delta, comparison } = dailySeries(
    recs,
    (list) => {
      let bad = 0;
      for (const r of list) {
        if (r.outcome === 'aborted') bad += 0.5;
        else if (r.outcome !== 'completed') bad += 1;
      }
      return bad / list.length;
    },
    dayScore,
  );
  // 一次成功的比例（Apdex 的思路：把成功当「满意」、中断当「勉强」）。
  const apdexRate = apdex(recs.map((r) => (r.outcome === 'completed' ? 1 : r.outcome === 'aborted' ? 5 : 99)));
  return dim('stability', '稳定性', 0.22, {
    state: grade(score),
    score: round1(score),
    series,
    delta,
    comparison,
    // 首屏那行只讲「体感」，不摆原始计数——3675 次里 1074 次失败这种句子只让人紧张，
    // 真正的数字留在下面的依据里，想核对的人点开就能看到。
    headline:
      rate <= 0.02 ? '这段时间调用几乎没出错。'
        : rate <= 0.10 ? '调用基本顺畅，偶尔有一次没成。'
          : rate <= 0.30 ? '这几天失败偏多，她可能会反复重试。'
            : '这段时间折腾得比较厉害，有不少调用没成。',
    evidence: [
      { label: '总调用', value: String(total) },
      { label: '排除记录', value: String(excluded), hint: '诊断、非主会话及已丢弃响应' },
      { label: '成功', value: String(completed) },
      { label: '失败', value: String(failed) },
      { label: '被中断', value: String(aborted), hint: '按半次失败计' },
      { label: '加权失败率', value: pct(rate) },
      ...(Number.isFinite(apdexRate) ? [{ label: '体感达成度（调用体验有多顺）', value: `${round1(apdexRate)} / 100`, hint: '成功算满意、中断算勉强，Apdex（响应满意度指标）口径' }] : []),
      ...(worstDay
        ? [{
          label: '最差一天',
          value: `${worstDay.day} · ${pct(worstDay.rate)}`,
          hint: `${Math.round(worstDay.bad)} / ${worstDay.n} 次`,
        }]
        : []),
      ...daily.filter((d) => d.n >= 10).slice(-3).map((d) => ({
        label: d.day,
        value: pct(d.rate),
        hint: `${Math.round(d.bad)} / ${d.n} 次`,
      })),
    ],
    formula: '失败率 ≤2% 得原始满分；2%→10% 线性降到 80；10%→30% 线性降到 60；超过 30% 继续降但下限 30。原始分再按缺口曲线映射（按离满分的差距换算）成展示分（100 → 100，80 → 88，60 → 70）。被中断（aborted）按半次失败计。逐日数据也列出，便于分辨「某几天集中坏」和「长期折腾」。',
    meaning: '这里看的是模型调用有没有频繁出错——出错多她会反复重试，你能直接感觉到她「卡」。逐日那几行能看出是某几天出问题，还是长期如此。',
  });
}

/* ---------------------------------------------------------------- 速度 */

/**
 * p95（秒）→ 原始分。p95 用来描述「最慢那一撮」，
 * 但展示分要反映多数体感，所以这里给一个宽松的原始曲线，
 * 再由量表曲线（scale.mjs）压紧低分段。
 */
function latencyRaw(p95s) {
  if (!Number.isFinite(p95s)) return null;
  if (p95s <= 8) return 100;
  if (p95s <= 25) return lerpScore(p95s, 8, 100, 25, 78);
  if (p95s <= 60) return lerpScore(p95s, 25, 78, 60, 58);
  return clamp(58 - Math.min(28, (p95s - 60) / 15), 30, 100);
}

export function latency(usage) {
  const all = usage?.records ?? [];
  const recs = modelCallRecords(usage).filter((r) => r.outcome === 'completed' && Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0);
  const excluded = all.length - recs.length;
  if (!usage?.ok || recs.length < MIN_SAMPLE) {
    return dim('latency', '响应速度', 0.15, {
      state: 'unknown',
      score: null,
      headline: `只有 ${recs.length} 条成功调用带耗时，样本不够。`,
      evidence: [
        { label: '成功调用样本', value: String(recs.length), hint: `门槛 ${MIN_SAMPLE} 条` },
        { label: '失败/中断未计入', value: String(excluded), hint: '不代表模型响应速度' },
      ],
      formula: '只统计 outcome=completed 的调用。p95：≤8 秒原始满分；8→25 秒降到 78；25→60 秒降到 58；超过 60 秒继续降但下限 30。原始分再按缺口曲线映射（按离满分的差距换算）成展示分。',
      meaning: '失败和中断通常会很快返回，把它们混进来会让越坏的日子看起来越快。这里刻意只看成功调用。',
    });
  }
  const xs = recs.map((r) => r.elapsedMs);
  const p95 = percentile(xs, 0.95) / 1000;
  const p50 = percentile(xs, 0.5) / 1000;
  const maxMs = xs.reduce((max, value) => Math.max(max, value), -Infinity);
  const maxS = maxMs / 1000;
  const over60 = xs.filter((v) => v > 60000).length;
  const raw = latencyRaw(p95);
  const score = calibrate(raw);
  const dayScore = (v) => calibrate(latencyRaw(v));
  const { series, delta, comparison } = dailySeries(
    recs,
    (list) => percentile(list.map((r) => r.elapsedMs), 0.95) / 1000,
    dayScore,
  );
  // Apdex 口径的体感：10 秒内算满意，40 秒内算勉强（业界惯例容忍线取 4 倍）。
  const apdexScore = apdex(recs.map((r) => r.elapsedMs / 1000), { satisfied: 10, tolerance: 4 });
  return dim('latency', '响应速度', 0.15, {
    state: grade(score),
    score: round1(score),
    series,
    delta,
    comparison,
    headline:
      p95 <= 8 ? `九成五的调用在 ${round1(p95)} 秒内回来，很跟手。`
        : p95 <= 25 ? `最慢的那 5% 要 ${round1(p95)} 秒，大部分时候是跟手的。`
          : `最慢的那 5% 要 ${round1(p95)} 秒，赶上长任务会等一会儿。`,
    evidence: [
      { label: '样本条数', value: String(recs.length), hint: '只含成功调用' },
      { label: '失败/中断未计入', value: String(excluded), hint: '避免快速失败污染 p95' },
      { label: '中位数', value: `${round1(p50)} 秒` },
      { label: 'p95', value: `${round1(p95)} 秒` },
      { label: '最慢一条', value: `${round1(maxS)} 秒` },
      { label: '超过 60 秒', value: `${over60} 条` },
      ...(Number.isFinite(apdexScore) ? [{ label: '体感达成度（调用体验有多顺）', value: `${round1(apdexScore)} / 100`, hint: '10 秒内算满意、40 秒内算勉强，Apdex（响应满意度指标）口径' }] : []),
    ],
    formula: '只统计成功调用。p95：≤8 秒原始满分；8→25 秒降到 78；25→60 秒降到 58；超过 60 秒继续降但下限 30。原始分再按缺口曲线映射（按离满分的差距换算）成展示分。',
    meaning: 'p95 是「最慢的那 5% 有多慢」。它只看成功调用，避免快速失败把坏日子伪装成更快；而最终分数还会把长尾压一压，因为多数调用其实是快的。',
  });
}

/* ---------------------------------------------------------------- 缓存 */

/**
 * 命中率 → 原始分（不含前缀变化的额外扣分）。
 *
 * 门槛按「自用个人项目」定：缓存命中本来就达不到企业级，
 * 85% 以上算很好了，不必等到 90% 才给满分。
 */
function cacheBaseScore(ratio) {
  if (!Number.isFinite(ratio)) return null;
  if (ratio >= 0.85) return 100;
  if (ratio >= 0.60) return lerpScore(ratio, 0.60, 68, 0.85, 100);
  return lerpScore(ratio, 0, 30, 0.60, 68);
}

function prefixChanges(records) {
  let changes = 0;
  const lastByScope = new Map();
  for (const record of records) {
    const hash = record.prefixHash;
    if (!hash) continue;
    const scope = `${record.model ?? ''}\u0000${record.sessionId ?? record.run ?? ''}`;
    const last = lastByScope.get(scope);
    if (last !== undefined && hash !== last) changes += 1;
    lastByScope.set(scope, hash);
  }
  return changes;
}

function cacheScore(ratio, changes, count) {
  const base = cacheBaseScore(ratio);
  if (base === null) return null;
  const changeRate = count > 0 ? (changes * 1000) / count : 0;
  return { score: clamp(base - Math.min(18, changeRate * 1.6)), changeRate };
}

export function cacheHealth(usage) {
  const tokenRecords = (usage?.records ?? []).filter((r) => Number.isFinite(r.input) && r.input > 0);
  const recs = tokenRecords.filter((r) => Number.isFinite(r.cachedInput));
  if (!usage?.ok || recs.length < MIN_SAMPLE) {
    return dim('cache', '缓存与成本', 0.18, {
      state: 'unknown',
      score: null,
      headline: tokenRecords.length > 0 && recs.length === 0 ? '服务方没有上报缓存用量，暂时算不出命中率。' : `只有 ${recs.length} 条上报缓存用量的记录，样本太少。`,
      evidence: [
        { label: '已上报缓存样本', value: String(recs.length), hint: `门槛 ${MIN_SAMPLE} 条` },
        { label: '未上报缓存样本', value: String(tokenRecords.length - recs.length) },
      ],
      formula: '加权命中率 = Σ缓存命中 / Σ输入 token；≥90% 满分，70→90% 线性降到 60 分。前缀变化按每千条记录计，每次变化扣 2 分，最多扣 20。',
      meaning: '命中率高说明大部分上下文不用重算；但前缀一变就要重算，账单和延迟都会涨，所以还要看前缀变化频率。',
    });
  }
  let hit = 0;
  let prompt = 0;
  for (const r of recs) {
    prompt += r.input;
    hit += Number.isFinite(r.cachedInput) ? Math.min(r.cachedInput, r.input) : 0;
  }
  const ratio = prompt > 0 ? hit / prompt : 0;

  const changes = prefixChanges(recs);
  const { score: rawScore, changeRate } = cacheScore(ratio, changes, recs.length);
  const score = calibrate(rawScore);
  const base = cacheBaseScore(ratio) ?? 0;
  const penalty = Math.max(0, base - (rawScore ?? base));
  const { series, delta, comparison } = dailySeries(
    recs,
    (list) => {
      let h = 0;
      let p = 0;
      for (const r of list) {
        p += r.input;
        h += Number.isFinite(r.cachedInput) ? Math.min(r.cachedInput, r.input) : 0;
      }
      const dailyRatio = p > 0 ? h / p : NaN;
      const dailyScore = cacheScore(dailyRatio, prefixChanges(list), list.length);
      return dailyScore?.score ?? NaN;
    },
    (v) => calibrate(v),
  );
  return dim('cache', '缓存与成本', 0.18, {
    state: grade(score),
    score: round1(score),
    series,
    delta,
    comparison,
    headline:
      ratio >= 0.85 && penalty < 6 ? `缓存命中 ${pct(ratio)}，前缀相当稳。`
        : ratio >= 0.85 ? `缓存命中 ${pct(ratio)}，前缀换得勤（每千条 ${round1(changeRate)} 次，扣 ${round1(penalty)} 分），还能再省点。`
          : ratio >= 0.60 ? `缓存命中 ${pct(ratio)}，大半上下文复用上了，还有空间。`
            : `缓存命中 ${pct(ratio)}，上下文多数在重算，账单会比需要的贵。`,
    evidence: [
      { label: '样本条数', value: String(recs.length) },
      { label: '输入 token 合计', value: String(prompt) },
      { label: '其中命中缓存', value: String(hit) },
      { label: '加权命中率', value: pct(ratio) },
      { label: '未上报缓存样本', value: String(tokenRecords.length - recs.length) },
      { label: '前缀哈希变化', value: `${changes} 次`, hint: `${round1(changeRate)} 次 / 千条，扣 ${round1(penalty)} 分` },
    ],
    formula: '加权命中率 = Σ缓存命中 / Σ输入 token；85% 以上原始满分，60→85% 线性降到 68。前缀变化按每千条记录计，每次扣 1.6 分、最多扣 18。原始分再按缺口曲线映射（按离满分的差距换算）成展示分。',
    meaning: '命中率高说明大部分上下文不用重算；前缀一变就要重算，账单和延迟都会涨，所以还要看前缀变化频率。这里对个人自用的门槛放得比生产系统宽，85% 就算很好了。',
  });
}

/* ---------------------------------------------------------------- 上下文配置 */

export function contextConfig(config, contextWindow) {
  const ctx = config?.context;
  const rounds = config?.rounds;
  const win = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  if (!config?.ok || !ctx || !rounds) {
    return dim('context', '上下文配置', 0.15, {
      state: 'unknown',
      score: null,
      headline: '上下文或轮次配置不完整，展开可查看配置来源。',
      evidence: [
        { label: '配置文件', value: config?.path ?? '—', hint: config?.reason ?? '' },
      ],
      formula: '五条各 20 分：①maxTokens ≤ 窗口×0.9 ②softRatio ∈ [0.70,0.92] ③keepRatio ∈ [0.15,0.40] ④hard ≥ soft×1.5 且 ≤60 ⑤firstTurn 与 keepRatio 不冲突。',
      meaning: '这几项决定她多快忘事、什么时候被强制交接。配得太紧会频繁交接，配得太松会一次塞到爆。',
    });
  }
  const maxTokens = numOr(ctx?.maxTokens);
  const keepRatio = numOr(ctx?.keepRatio);
  const softRatio = numOr(ctx?.softRatio);
  const soft = numOr(rounds?.soft);
  const hard = numOr(rounds?.hard);
  const firstTurn = typeof ctx?.firstTurn === 'boolean' ? ctx.firstTurn : null;
  const checks = [];

  const effWin = win ?? 128000;
  // 每条都分三档：达标 / 勉强（还能用但没配到最佳）/ 不行。
  // 二值判定会把「差一点点」和「完全错」算成一样，那才是真的传播恐慌。
  checks.push({
    name: 'maxTokens 不超过窗口九成',
    // 窗口未知时这条判不出来，记 unknown 而不是判差——缺数据不等于配错了。
    state: !Number.isFinite(maxTokens) || !win
      ? 'unknown'
      : maxTokens <= effWin * 0.9 ? 'ok' : maxTokens <= effWin ? 'near' : 'bad',
    detail: `${maxTokens ?? '—'} / ${win ? effWin : '窗口未知'}`,
  });
  checks.push({
    name: 'softRatio 在 0.70–0.92',
    state: !Number.isFinite(softRatio)
      ? 'unknown'
      : softRatio >= 0.70 && softRatio <= 0.92 ? 'ok' : softRatio >= 0.60 && softRatio <= 1 ? 'near' : 'bad',
    detail: String(softRatio ?? '—'),
  });
  checks.push({
    name: 'keepRatio 在 0.15–0.40',
    state: !Number.isFinite(keepRatio)
      ? 'unknown'
      : keepRatio >= 0.15 && keepRatio <= 0.40 ? 'ok' : keepRatio >= 0.10 && keepRatio <= 0.55 ? 'near' : 'bad',
    detail: String(keepRatio ?? '—'),
  });
  checks.push({
    name: 'hard ≥ soft×1.5 且 ≤60',
    state: !Number.isFinite(soft) || !Number.isFinite(hard)
      ? 'unknown'
      : hard >= soft * 1.5 && hard <= 60 ? 'ok' : hard >= soft * 1.2 && hard <= 80 ? 'near' : 'bad',
    detail: `soft ${soft ?? '—'} / hard ${hard ?? '—'}`,
  });
  checks.push({
    name: 'firstTurn 与 keepRatio 不冲突',
    // firstTurn=true 时首轮就参与保留比例裁剪，keepRatio 太大会让首轮之后一直很挤。
    state: !Number.isFinite(keepRatio) || firstTurn === null
      ? 'unknown'
      : !(firstTurn && keepRatio > 0.40) ? 'ok' : keepRatio <= 0.55 ? 'near' : 'bad',
    detail: `firstTurn ${firstTurn} / keepRatio ${keepRatio ?? '—'}`,
  });

  const known = checks.filter((c) => c.state !== 'unknown');
  if (known.length === 0) {
    return dim('context', '上下文配置', 0.15, {
      state: 'unknown',
      score: null,
      headline: '配置字段能读到，但五项都缺值，这项跳过。',
      evidence: checks.map((c) => ({ label: c.name, value: '?', hint: `${c.detail} · 缺值` })),
      formula: '五项分三档计分：达标 1、勉强 0.6、不行 0。①maxTokens ≤ 窗口×0.9 ②softRatio ∈ [0.70,0.92] ③keepRatio ∈ [0.15,0.40] ④hard ≥ soft×1.5 且 ≤60 ⑤firstTurn 与 keepRatio 不冲突。缺值项从分母里剔除。',
      meaning: '这几项决定她多快忘事、什么时候被强制交接。配得太紧会频繁交接，配得太松会一次塞到爆。',
    });
  }
  const full = known.filter((c) => c.state === 'ok').length;
  const near = known.filter((c) => c.state === 'near').length;
  const score = calibrate(checksScore(checks));
  const unknown = checks.length - known.length;
  return dim('context', '上下文配置', 0.15, {
    state: grade(score),
    score: round1(score),
    checks: { passed: full, sampled: known.length, total: checks.length },
    headline: full === known.length
      ? (unknown > 0 ? `能判的 ${known.length} 项都在合理区间，${unknown} 项缺值没算。` : '五项配置都在合理区间。')
      : near === known.length
        ? `五项都能用，${near} 项还有调优空间${unknown > 0 ? `，另有 ${unknown} 项缺值` : ''}。`
        : `${known.length - full} 项没配到最佳${unknown > 0 ? `，另有 ${unknown} 项缺值` : ''}。`,
    evidence: checks.map((c) => ({
      label: c.name,
      value: mark(c.state),
      hint: c.state === 'unknown' ? `${c.detail} · 缺值未计` : c.detail,
    })),
    formula: '五项分三档计分：达标 1、勉强 0.6、不行 0。①maxTokens ≤ 窗口×0.9（≤窗口算勉强）②softRatio ∈ [0.70,0.92] ③keepRatio ∈ [0.15,0.40] ④hard ≥ soft×1.5 且 ≤60 ⑤firstTurn 与 keepRatio 不冲突。缺值项从分母剔除，不用缺数据冒充差评。',
    meaning: '这几项决定她多快忘事、什么时候被强制交接。配得太紧会频繁交接，配得太松会一次塞到爆。',
  });
}

function numOr(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ---------------------------------------------------------------- 交接 */

function handoffGapLabel(minutes) {
  if (minutes >= 1) return `${round1(minutes)} 分钟`;
  const seconds = minutes * 60;
  return seconds < 1 ? '不到 1 秒' : `${round1(seconds)} 秒`;
}

export function handoffHealth(handoffs) {
  const files = handoffs?.files ?? [];
  if (!handoffs?.ok || files.length < 4) {
    const possibleIntervals = Math.max(0, (handoffs?.total ?? files.length) - 1);
    return dim('handoff', '交接健康', 0.15, {
      state: 'unknown',
      score: null,
      headline: files.length === 0 ? '本期没有足够的带日期交接记录。' : `只有 ${files.length} 份本期交接，样本不够。`,
      evidence: [
        { label: '平均间隔', value: '—', hint: `可核验 0/${possibleIntervals} 段` },
        { label: '间隔不短于 10 分钟', value: '—', hint: '暂不判断频率' },
        { label: '交接目录', value: handoffs?.path ?? '—', hint: handoffs?.reason ?? '' },
      ],
      formula: '至少 4 份交接笔记和 2 段可核验的时间间隔才评分。',
      meaning: '按交接笔记的时间和内容检查近期交接记录。',
    });
  }
  const gaps = [];
  for (let i = 1; i < files.length; i += 1) {
    const prior = files[i - 1];
    const current = files[i];
    if (prior.timeSource === 'mtime' || current.timeSource === 'mtime') continue;
    const g = (current.ts - prior.ts) / 60000;
    if (Number.isFinite(g) && g > 0) gaps.push(g);
  }
  const unavailable = files.length - 1 - gaps.length;
  const enoughTiming = gaps.length >= 2;
  const timingHint = `可核验 ${gaps.length}/${files.length - 1} 段${unavailable ? '，同一时间戳和仅有文件修改时间的间隔未计入' : ''}。`;
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const sdGap = gaps.length > 1 ? Math.sqrt(gaps.reduce((a, b) => a + (b - avgGap) ** 2, 0) / (gaps.length - 1)) : null;
  const cv = avgGap && avgGap > 0 && sdGap !== null ? sdGap / avgGap : null;

  const checks = [];
  // 三档：正常节奏 / 略密但仍可用 / 明显不对。个人使用本来就忽快忽慢，别把波动当病。
  checks.push({
    name: '间隔稳定（CV ≤0.5）',
    state: cv === null ? 'unknown' : cv <= 0.5 ? 'ok' : cv <= 1.0 ? 'near' : 'bad',
    detail: cv === null ? '可核验的间隔不足' : `CV ${round1(cv)}，平均间隔 ${handoffGapLabel(avgGap)}`,
  });
  const thin = files.filter((f) => f.size < 200);
  checks.push({
    name: '单份体量 ≥200 字节',
    state: thin.length === 0 ? 'ok' : thin.length <= Math.ceil(files.length * 0.25) ? 'near' : 'bad',
    detail: thin.length === 0 ? `最小 ${Math.min(...files.map((f) => f.size))} 字节` : `${thin.length} 份偏薄`,
  });
  let dupes = 0;
  for (let i = 1; i < files.length; i += 1) {
    if (files[i].sha1 && files[i].sha1 === files[i - 1].sha1) dupes += 1;
  }
  checks.push({
    name: '相邻两份内容不重复',
    state: dupes === 0 ? 'ok' : dupes <= Math.max(1, Math.floor(files.length * 0.1)) ? 'near' : 'bad',
    detail: dupes === 0 ? '没有重复' : `${dupes} 对内容相同`,
  });
  const tooClose = gaps.filter((g) => g < 10).length;
  checks.push({
    name: '间隔不短于 10 分钟',
    state: !enoughTiming ? 'unknown' : tooClose === 0 ? 'ok' : tooClose <= Math.max(1, Math.floor(gaps.length * 0.15)) ? 'near' : 'bad',
    detail: !enoughTiming ? '可核验的间隔不足，暂不判断频率'
      : tooClose === 0 ? `最短 ${handoffGapLabel(Math.min(...gaps))}` : `${tooClose}/${gaps.length} 段短于 10 分钟`,
  });

  const full = checks.filter((c) => c.state === 'ok').length;
  const near = checks.filter((c) => c.state === 'near').length;
  const score = enoughTiming ? calibrate(checksScore(checks)) : null;
  return dim('handoff', '交接健康', 0.15, {
    state: grade(score),
    score: round1(score),
    timing: { verifiedGaps: gaps.length, unavailable },
    headline: !enoughTiming ? '交接笔记可以检查，可核验的时间太少，暂不给交接分。'
      : full === checks.length
      ? `已核验的 ${gaps.length} 段交接间隔正常。`
      : near === checks.length
        ? `${files.length} 次交接都能用，节奏略不匀。`
        : `${checks.length - full} 项没到最佳，其余还好。`,
    evidence: [
      { label: '样本份数', value: String(files.length), hint: `总共存 ${handoffs.total ?? files.length} 份` },
      { label: '平均间隔', value: avgGap === null ? '—' : handoffGapLabel(avgGap), hint: timingHint },
      ...checks.map((c) => ({ label: c.name, value: mark(c.state), hint: c.detail })),
    ],
    formula: '至少 4 份笔记、2 段可核验间隔。只用文件名中的事件时间，跳过相同时间戳和只有文件修改时间的间隔。四项检查包括间隔变异系数 ≤0.5、笔记 ≥200 字节、相邻笔记不重复、间隔 ≥10 分钟。达标记 1，勉强记 0.6，未达标记 0。',
    formulaEn: 'Requires four notes and two verifiable gaps. Uses event timestamps from filenames and skips identical timestamps and modification times. Checks gap variation, note size, neighbouring duplicates and spacing of at least ten minutes.',
    meaning: '间隔用于判断交接是否密集。笔记体量和重复情况可辅助定位需要复查的记录。',
  });
}

/* ---------------------------------------------------------------- 记忆 */

/**
 * 记忆维度的降级 headline。
 * 不写「N 项没到最佳」——纯计数既没方向也不说原因，读完只知道「有几项不好」。
 * 先指出卡在哪一类，再给一句中性的解释。
 */
function memoryHeadline(checks) {
  const weak = checks.filter((c) => c.state === 'bad' || c.state === 'near');
  const names = weak.map((c) => c.name).join('、');
  const hitBad = weak.some((c) => c.name.includes('命中率'));
  return hitBad
    ? `${weak.length} 项还能再顺一点，主要卡在检索命中——不是记性差，是取回来的没被用上。`
    : `${weak.length} 项还能再顺一点：${names}。`;
}

function baseMemoryHealth(memory) {
  const base = memory.base;
  const known = [];
  if (base.constitution !== null) known.push(base.constitution ? 1 : 0);
  if (base.sampled) known.push(base.readable / base.sampled);
  if (base.blockedDirs) known.push(0);
  const score = known.length ? round1(known.reduce((sum, value) => sum + value, 0) / known.length * 100) : null;
  const workspaceState = {
    ready: '可列出工作区文件', missing: '目录不存在', unreadable: '没有权限或无法列出文件', 'not-directory': '配置位置不是目录',
  };
  const evidence = [
    { label: 'Coo 基础记忆工作区', value: base.path ?? '—', hint: workspaceState[base.state] },
    { label: '基础设定文件', value: base.constitution === null ? '未找到' : base.constitution ? '可读取' : '无法读取', hint: 'CONSTITUTION.md' },
    { label: '日常文本文件抽查', value: base.sampled ? `${base.readable}/${base.sampled} 可读取` : '暂无可抽查的文本文件', hint: base.limited ? '达到采样上限' : '' },
  ];
  if (base.blockedDirs) evidence.push({ label: '未能列出的子目录', value: String(base.blockedDirs) });
  if (Number.isFinite(memory.entries?.total)) evidence.push({ label: '额外记忆统计', value: `${memory.entries.total} 条`, hint: '独立日志' });
  if (Number.isFinite(memory.retrieve?.hitRate)) evidence.push({ label: '额外检索命中率', value: pct(memory.retrieve.hitRate), hint: '独立日志' });
  const headline = base.state !== 'ready' ? 'Coo 基础记忆工作区暂时无法读取，展开可看具体原因。'
    : score === null ? '工作区已找到，暂时没有能抽查的记忆文件。'
      : score < 100 || base.blockedDirs ? '工作区可打开，部分记忆文件或子目录读不到。'
        : base.sampled ? 'Coo 基础记忆可读取，抽查的记忆文件都能打开。'
          : 'Coo 基础记忆可读取，暂时没有日常文本可抽查。';
  return dim('memory', '记忆健康', 0.15, {
    state: grade(score), score, headline, evidence,
    fileCheck: { readable: base.readable, sampled: base.sampled, settings: base.constitution },
    formula: '基础设定文件能否打开，与抽查文本的可读取比例，按有依据的项目等权计算。抽查到无法读取的子目录时另计一项。额外检索统计只作参考。',
    formulaEn: 'Checks whether the base settings file and sampled text files can be opened. An inaccessible sampled subdirectory adds a failing check. Optional retrieval statistics are informational.',
    meaning: '这一项检查基础记忆的文件访问。扩展提供了检索统计时，可以额外查看其命中率。',
  });
}

export function memoryHealth(memory) {
  if (memory?.base) return baseMemoryHealth(memory);
  const e = memory?.entries;
  const r = memory?.retrieve;
  if (!memory?.ok || (!e && !r)) {
    return dim('memory', '记忆健康', 0.15, {
      state: 'unknown',
      score: null,
      headline: memory?.workspaceExists
        ? '已找到记忆工作区，但缺少可用于体检的记忆条目或检索日志。'
        : '没有找到可用于体检的记忆日志，展开可查看位置。',
      evidence: [
        { label: '记忆工作区', value: memory?.workspacePath ?? '—', hint: memory?.workspaceExists ? '目录存在' : '未找到目录' },
        { label: '日志位置', value: memory?.path ?? '—', hint: '需要 entries.jsonl 或 retrieve.jsonl' },
        ...(memory?.problems ?? []).map((problem) => ({ label: '读取提示', value: problem })),
      ],
      formula: '五项各 20 分：①检索命中率 ≥40% ②平均检索耗时 ≤300ms ③失效条目 ≤5% ④retrieve 与 entries 体积比 ≤3 倍 ⑤长期没被想起来的条目 ≤60%。',
      meaning: '记忆是她的「想得起来」。命中率低是存了却找不到，体积膨胀是每次检索都在翻一堆账。',
    });
  }
  const checks = [];
  // 同样是三档：这条本来就没有「必须 100%」的道理，差一点不算坏。
  checks.push({
    name: '检索命中率 ≥40%',
    state: !Number.isFinite(r?.hitRate) ? 'unknown' : r.hitRate >= 0.4 ? 'ok' : r.hitRate >= 0.15 ? 'near' : 'bad',
    detail: Number.isFinite(r?.hitRate) ? pct(r.hitRate) : '无数据',
  });
  checks.push({
    name: '平均检索耗时 ≤300ms',
    state: !Number.isFinite(r?.avgMs) ? 'unknown' : r.avgMs <= 300 ? 'ok' : r.avgMs <= 600 ? 'near' : 'bad',
    detail: Number.isFinite(r?.avgMs) ? `${round1(r.avgMs)}ms` : '无数据',
  });
  const invalidRatio = e && e.total > 0 ? e.invalid / e.total : null;
  checks.push({
    name: '失效条目 ≤5%',
    state: !Number.isFinite(invalidRatio) ? 'unknown' : invalidRatio <= 0.05 ? 'ok' : invalidRatio <= 0.12 ? 'near' : 'bad',
    detail: Number.isFinite(invalidRatio) ? pct(invalidRatio) : '无数据',
  });
  const sizes = memory.sizes ?? {};
  const ratio = sizes.entries > 0 && sizes.retrieve > 0 ? sizes.retrieve / sizes.entries : null;
  checks.push({
    name: '检索日志不超过条目库 3 倍',
    state: !Number.isFinite(ratio) ? 'unknown' : ratio <= 3 ? 'ok' : ratio <= 6 ? 'near' : 'bad',
    detail: Number.isFinite(ratio) ? `${round1(ratio)} 倍` : '无数据',
  });
  const staleRatio = e && e.total > 0 ? e.stale / e.total : null;
  checks.push({
    name: '长期没被想起来的 ≤60%',
    state: !Number.isFinite(staleRatio) ? 'unknown' : staleRatio <= 0.6 ? 'ok' : staleRatio <= 0.78 ? 'near' : 'bad',
    detail: Number.isFinite(staleRatio) ? pct(staleRatio) : '无数据',
  });

  const full = checks.filter((c) => c.state === 'ok').length;
  const near = checks.filter((c) => c.state === 'near').length;
  const score = calibrate(checksScore(checks));
  return dim('memory', '记忆健康', 0.15, {
    state: grade(score),
    score: round1(score),
    headline: score === null ? '已找到记忆日志，暂时没有足够的有效样本。'
      : full === checks.length
      ? '记忆存得进、想得起。'
      : near === checks.length
        ? '记忆读得动，几项还能调。'
        : memoryHeadline(checks),
    evidence: [
      { label: '条目总数', value: String(e?.total ?? '—'), hint: `近两周新增 ${e?.recent ?? '—'} 条` },
      { label: '标签种类', value: String(e?.tagCount ?? '—') },
      { label: '检索次数', value: String(r?.total ?? '—') },
      ...checks.map((c) => ({ label: c.name, value: mark(c.state), hint: c.detail })),
    ],
    formula: '五项分三档计分（达标 1、勉强 0.6、不行 0）：①检索命中率 ≥40% ②平均检索耗时 ≤300ms ③失效条目 ≤5% ④retrieve 与 entries 体积比 ≤3 倍 ⑤长期没被想起来的条目 ≤60%。差一点算「勉强」，不按失败算。',
    meaning: '记忆是她的「想得起来」。命中率算的是「取回来的有没有被用上」，跟存了多少无关，所以低不代表记性差——更可能是存的和问的对不上，或者检索放得太保守。体积膨胀才是「每次检索都在翻一堆账」。这几项没有「必须满」的道理，够用就行。',
  });
}

/* ---------------------------------------------------------------- 汇总 */

/**
 * 统一补齐可选字段：series / delta。
 * 逐日序列只有能从用量记录按天切出来的维度才有（稳定/速度/缓存）；
 * 上下文、交接、记忆是结构性检查，给空数组，UI 那边自然不画线。
 */
function dim(id, title, weight, body) {
  return {
    id,
    title,
    weight,
    series: [],
    delta: null,
    ...body,
  };
}

export const HARDWARE_DIMENSIONS = [
  ['stability', stability],
  ['latency', latency],
  ['cache', cacheHealth],
  ['context', contextConfig],
  ['handoff', handoffHealth],
  ['memory', memoryHealth],
];

/**
 * 跑完六个维度并汇总。只听快照，不碰磁盘。
 * contextWindow 由调用方从 host.modelFacts.contextWindow() 取；取不到传 null。
 */
export function runHardware(snapshot, { contextWindow = null } = {}) {
  const dims = [
    stability(snapshot?.usage),
    latency(snapshot?.usage),
    cacheHealth(snapshot?.usage),
    contextConfig(snapshot?.config, contextWindow),
    handoffHealth(snapshot?.handoffs),
    memoryHealth(snapshot?.memory),
  ];
  return { ...summarize(dims), dimensions: dims };
}

/**
 * 汇总：权重覆盖不足时不给总分，避免关键维度缺失却显示稳。
 *
 * 两点是刻意的：
 *   1. 只有「某一维掉到 50 以下」才把总分封顶，封在「良好」下沿之上一点，
 *      意思是「别的地方都好，但这块确实得看看」——不把整页打成不及格。
 *   2. 输出带上量表版本号，方便以后回头对账「这个分数是哪套口径算的」。
 */
export function summarize(dims) {
  const scored = dims.filter((d) => Number.isFinite(d.score));
  const unknownCount = dims.length - scored.length;
  const coverage = scored.reduce((a, d) => a + (Number.isFinite(d.weight) ? d.weight : 0), 0);
  const COVERAGE_FLOOR = 0.75;
  if (scored.length === 0 || coverage < COVERAGE_FLOOR) {
    return { overall: null, level: '样本不足', levelKey: 'insufficient', unknownCount, scoredCount: scored.length, coverage: round1(coverage), calibration: CALIBRATION_VERSION };
  }
  const wSum = coverage;
  const raw = scored.reduce((a, d) => a + d.score * d.weight, 0) / (wSum || 1);
  const crippled = scored.some((d) => d.score < 50);
  const stabilityDimension = dims.find(({ id }) => id === 'stability');
  const stabilityNeedsAttention = stabilityDimension && (!Number.isFinite(stabilityDimension.score) || stabilityDimension.score < 78);
  const ceiling = crippled ? 75 : stabilityNeedsAttention ? 84 : 99;
  const overall = Math.min(Math.round(raw), ceiling);
  return { overall, ...levelOf(overall), unknownCount, scoredCount: scored.length, coverage: round1(coverage),
    crippled, scoreLimit: Math.round(raw) > ceiling ? ceiling : null, calibration: CALIBRATION_VERSION };
}

/**
 * 总分 → 档位。
 * 阈值按「小体检」定，不按学校评级定：76 以上算良好，
 * 58–76 才是「有几处可以更好」，58 以下才说「有明确问题」。
 */
export function levelOf(score) {
  if (!Number.isFinite(score)) return { level: '样本不足', levelKey: 'insufficient' };
  if (score >= 85) return { level: '稳', levelKey: 'solid' };
  if (score >= 76) return { level: '良好', levelKey: 'good' };
  if (score >= 58) return { level: '有几处可以更好', levelKey: 'fair' };
  return { level: '有明确问题', levelKey: 'poor' };
}
