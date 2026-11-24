/**
 * 量表层：把各维度的「原始分」压成给人看的分数。
 *
 * 为什么单独一层：
 *   原始分是「离理想值多远」，直接乘 100 会得到一串 40、60 的吓人数字，
 *   而实际情况往往是「多数时候都好，只是尾巴长」。
 *   这里借用三套成熟做法，把原始分重新映射一遍，规则固定、可复算、可解释：
 *
 *   ① Apdex（Application Performance Index，开放标准，AWS CloudWatch RUM 等都用它报响应体验）
 *      把样本分成 satisfied / tolerating / frustrated 三档，
 *      score = (satisfied + tolerating × 0.5) / total。
 *      好处是它描述「多数人的体感」，不会被最慢的 5% 整条拉死。
 *
 *   ② SLO / Error Budget（Google SRE）
 *      先划一个「允许出错的额度」，额度内不算问题；超了才开始扣。
 *      小体检不是生产系统，额度按个人自用定得宽一些，不做告警式羞辱。
 *
 *   ③ T-score / percentile rank（心理量表常模化，如 SQ-48 的 T = 10θ + 50）
 *      原始分与分数之间用单调曲线相连，保证「谁更差」的顺序不变，
 *      但把低分段的间距压紧——这样 60 分不会看起来像「不及格」。
 *
 * 一句话：扣分是单调的，措辞不是恐吓的。
 */

/** 曲线指数。1.0 = 不调整；>1 = 只压紧低分段，排序不变。 */
export const CURVE_EXPONENT = 1.32;

/** 本量表版本号。改了曲线或阈值就换号，方便旧报告对账。 */
export const CALIBRATION_VERSION = '2026-11-24.2';

/**
 * 原始分 → 展示分。单调递增：raw 越高，结果一定越高，绝不颠倒。
 * 数学上就是把「缺口」开方式的压缩一次：deficit' = 100 × (deficit/100)^1.32
 *
 *   raw 100 → 100     raw 80 → 88     raw 60 → 70
 *   raw 40 → 50       raw 20 → 27     raw 0  → 0
 */
export function calibrate(raw) {
  if (!Number.isFinite(raw)) return null;
  const deficit = Math.max(0, Math.min(100, 100 - raw));
  const curved = 100 * Math.pow(deficit / 100, CURVE_EXPONENT);
  return Math.max(0, Math.min(100, 100 - curved));
}

/**
 * Apdex：满意度指数。
 *   satisfied  响应时间 ≤ T
 *   tolerating T < 响应时间 ≤ 4T（业界惯例是 4 倍容忍线）
 *   frustrated 超过 4T
 * 返回 0..100；无样本回 null（不拿 0 冒充「很差」）。
 */
export function apdex(samples, { satisfied = 10, tolerance = 4 } = {}) {
  const xs = (samples ?? []).filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  const hi = satisfied * tolerance;
  let sat = 0;
  let tol = 0;
  for (const v of xs) {
    if (v <= satisfied) sat += 1;
    else if (v <= hi) tol += 1;
  }
  return ((sat + tol * 0.5) / xs.length) * 100;
}

/**
 * 三档判定（Apdex 的 satisfied / tolerating / frustrated 落到单条检查上）。
 * 传 full 为「达标线」，tol 为「还能忍的线」；lower=true 表示越小越好。
 *
 * 之所以不用「过/不过」二值：一条检查差一点点就把整维打掉 20 分，
 * 会让人误以为整项不能用，而实际只是这一条没配到最佳。
 */
export function band(value, { full, tol, lower = true } = {}) {
  if (!Number.isFinite(value) || !Number.isFinite(full) || !Number.isFinite(tol)) return 'unknown';
  if (lower) {
    if (value <= full) return 'ok';
    if (value <= tol) return 'near';
    return 'bad';
  }
  if (value >= full) return 'ok';
  if (value >= tol) return 'near';
  return 'bad';
}

/** 三档对应的学分：达标 1、勉强 0.6、不行 0。unknown 不进分母。 */
export const CREDIT = { ok: 1, near: 0.6, bad: 0, unknown: null };

/** 一组检查 → 0..100。unknown 从分母剔除，缺数据不判差。 */
export function checksScore(checks) {
  let got = 0;
  let max = 0;
  for (const c of checks) {
    const credit = CREDIT[c.state ?? 'unknown'];
    if (credit === null || credit === undefined) continue;
    got += credit;
    max += 1;
  }
  if (max === 0) return null;
  return (got / max) * 100;
}

/** 证据里三档的记号。 */
export function mark(state) {
  if (state === 'ok') return '✓';
  if (state === 'near') return '~';
  if (state === 'bad') return '✗';
  return '?';
}

/** 口径页要展示的说明（跟着语言走）。 */
export function explainCalibration(language = 'zh') {
  if (language !== 'zh') {
    return [
      'Scores are not raw ratios. Three established methods shape them:',
      '1) Apdex — samples split into satisfied / tolerating / frustrated, score = (satisfied + 0.5 × tolerating) / total. It describes what most calls feel like instead of being dragged down by the slowest 5%.',
      '2) SLO error budget — every dimension gets an allowance for normal noise; nothing is deducted while inside it.',
      `3) Deficit curve (exponent ${CURVE_EXPONENT}) — keeps the ranking between dimensions but compresses the low band, so 60 does not read as a failing grade.`,
      'Checks are graded in three bands (✓ met, ~ marginal, ✗ off). A marginal check still earns 0.6, because "slightly off" is not "unusable".',
    ].join('\n');
  }
  return [
    '分数不是原始比例，经过三层成熟方法映射：',
    '① Apdex（应用性能指数，开放标准）：样本按 满意 / 勉强 / 受不了 三档统计，得分 =（满意 + 勉强 × 0.5）/ 总数。它描述「多数调用是什么体感」，不会被最慢的 5% 拖死。',
    '② SLO 错误预算（Google SRE 做法）：每一维都先留出一段正常波动的额度，额度里不扣分——小体检不是生产告警，不做羞辱式判定。',
    `③ 缺口曲线（指数 ${CURVE_EXPONENT}）：只压紧低分段的间距，维度之间的高低顺序完全不变，但 60 分不会再被读成「不及格」。`,
    '单条检查分三档：✓ 达标、~ 勉强、✗ 不行。勉强仍拿 0.6 学分——「差一点」不等于「不能用」。',
  ].join('\n');
}
