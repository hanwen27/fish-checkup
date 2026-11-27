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
export const CURVE_EXPONENT = 1.15;

/** 本量表版本号。改了曲线或阈值就换号，方便旧报告对账。 */
export const CALIBRATION_VERSION = '1.0.9';

/**
 * 原始分 → 展示分。单调递增：raw 越高，结果一定越高，绝不颠倒。
 * 将缺口从 100 × (deficit/100)^1.32 收紧到 100 × (deficit/100)^1.15。
 *
 *   raw 100 → 100     raw 80 → 84     raw 60 → 65
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
      `Scoring rules ${CALIBRATION_VERSION}. Most raw scores use 100 − 100 × (1 − raw/100)^${CURVE_EXPONENT}. Base memory uses the mean of the checks it could read.`,
      'Weights: stability 22%, latency 15%, cache and cost 18%, context 15%, handoffs 15%, memory 15%. Overall scoring requires at least 75% weight coverage.',
      'A scored dimension below 50 caps the total at 75. Missing stability or stability below 78 caps it at 84. The overall display is capped at 99 while live handoff and retrieval evidence is incomplete.',
      'Daily charts need at least five observations on a day and two valid days. Four valid days are needed for comparison. The mean of the latest two or three valid days is compared with the median of earlier days.',
      'Apdex is supplementary evidence. Configuration and file checks report their observed scope separately.',
    ].join('\n');
  }
  return [
    `评分口径 ${CALIBRATION_VERSION}。多数维度使用 100 − 100 × (1 − 原始分/100)^${CURVE_EXPONENT}。基础记忆按已观测的可读性检查取平均。`,
    '稳定性权重 22%，响应速度 15%，缓存与成本 18%，上下文 15%，交接 15%，记忆 15%。权重覆盖达到 75% 才显示总分。',
    '任一已评分维度低于 50，总分最高 75。稳定性缺项或低于 78，总分最高 84。现有数据对实际接续和召回的覆盖有限，总分暂以 99 为上限。',
    '每日至少 5 条有效记录、至少 2 个有效日才显示折线。至少 4 个有效日才比较，取最近两到三个有效日的平均分，与更早有效日的中位数对比。',
    'Apdex（响应满意度指标）是辅助依据。配置和文件的检查结果单独显示通过范围。',
  ].join('\n');
}
