/**
 * 行为侧写：不用她开口，只从真实痕迹里读四根轴。
 *
 * 四轴与自评完全同一套，便于逐轴对比：
 *   E/I  主动性：判断时选择非静默回应的比例，以及记录的消息长度
 *   S/N  关注面：说的是具体事还是拉得开
 *   T/F  情绪外露：情绪起伏大不大、判断偏理还是偏感
 *   J/P  章法：作息与话题是否有秩序
 *
 * 每个轴 0..100（高分端 = 前一个字母：E / S / T / J）。
 * 样本不足就返回 null，不猜、不外推。
 */

import { DECISION_LENGTH_LABEL } from './text.mjs';

const MIN_DECISIONS = 50;
const MIN_ENTRIES = 50;

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

/** 把 0..1 的比率映射到 0..100，并按阈值给证据。 */
function scale01(x) {
  return Number.isFinite(x) ? Math.max(0, Math.min(100, x * 100)) : null;
}

/**
 * E/I：说话倾向。
 * 代理指标：未被系统拦截的判断里，非静默决定比例（speakRate）和记录长度。
 * 这是接话倾向的代理值，不代表每条消息都已成功发出。
 */
export function axisEI(memory) {
  const d = memory?.decisions;
  if (!d || d.total < MIN_DECISIONS) {
    const effective = d?.total ?? 0;
    return {
      axis: 'EI', score: null,
      note: `有效判断样本只有 ${effective} 次，不够。`,
      evidence: [
        { label: '有效判断', value: String(effective) },
        { label: '全部判断', value: String(d?.judgedTotal ?? effective) },
        { label: '系统拦截', value: String(d?.blockedCount ?? 0), hint: '不作为性格依据' },
      ],
    };
  }
  const speak = Number.isFinite(d.speakRate) ? d.speakRate : null;
  const len = Number.isFinite(d.medianLen) ? d.medianLen : null;
  if (speak === null || len === null) {
    return { axis: 'EI', score: null, note: '缺少接话判断比例或长度数据。', evidence: [] };
  }
  // 非静默判断比例 0..0.8 → 0..100；记录长度 0..80 字 → 0..100；各占一半。
  const sSpeak = Math.max(0, Math.min(1, speak / 0.8));
  const sLen = Math.max(0, Math.min(1, len / 80));
  const score = (sSpeak * 0.6 + sLen * 0.4) * 100;
  return {
    axis: 'EI',
    score: r1(score),
    note: `非静默判断占比 ${Math.round(speak * 100)}%，${DECISION_LENGTH_LABEL} ${r1(len)} 字。`,
    evidence: [
      { label: '有效判断', value: String(d.total) },
      { label: '全部判断', value: String(d.judgedTotal ?? d.total) },
      { label: '系统拦截', value: String(d.blockedCount ?? 0), hint: '已从性格判断样本中排除' },
      { label: '非静默判断占比', value: `${Math.round(speak * 100)}%`, hint: '未核验每条消息是否成功发出' },
      { label: DECISION_LENGTH_LABEL, value: `${r1(len)} 字` },
      { label: '群聊判断被点名比例', value: Number.isFinite(d.addressedRate) ? `${Math.round(d.addressedRate * 100)}%` : '—' },
    ],
  };
}

/**
 * S/N：关注面。
 * 代理指标：entries 的标签多样性（越集中越 S） + 检索词平均长度（越长越 N）。
 * 这两项都是「她实际记了什么、想问什么」，不看她自称。
 */
export function axisSN(memory) {
  const e = memory?.entries;
  const r = memory?.retrieve;
  if (!e || e.total < MIN_ENTRIES) {
    return { axis: 'SN', score: null, note: `记忆条目只有 ${e?.total ?? 0} 条，不够。`, evidence: [] };
  }
  const div = Number.isFinite(e.tagDiversity) ? e.tagDiversity : null;
  const qlen = Number.isFinite(r?.avgQueryLen) ? r.avgQueryLen : null;
  if (div === null) {
    return { axis: 'SN', score: null, note: '缺少标签多样性数据。', evidence: [] };
  }
  // 多样性 0..0.5 → 0..100（越高越 N）；检索词 0..40 字 → 0..100（越长越 N）。
  const sDiv = Math.max(0, Math.min(1, div / 0.5));
  const sQ = qlen === null ? sDiv : Math.max(0, Math.min(1, qlen / 40));
  // 注意：这两项都是「越 N 越高」，所以最终要反过来变成「S 高分端」。
  const nLean = sDiv * 0.6 + sQ * 0.4;
  const score = (1 - nLean) * 100;
  return {
    axis: 'SN',
    score: r1(score),
    note: `标签多样性 ${r1(div)}，检索词平均 ${qlen === null ? '—' : r1(qlen)} 字。`,
    evidence: [
      { label: '记忆条目', value: String(e.total) },
      { label: '标签种类', value: String(e.tagCount ?? '—') },
      { label: '标签多样性', value: String(r1(div)) },
      { label: '检索词平均长度', value: qlen === null ? '—' : `${r1(qlen)} 字` },
    ],
  };
}

/**
 * T/F：情绪外露。
 * 代理指标：emotions 的 arousal 标准差（起伏大 → F） + entries 里 valence 非零比例（爱带情绪 → F）
 *          + decisions 的平均置信度（越高越像「先算再答」→ T）。
 */
export function axisTF(memory) {
  const emo = memory?.emotions;
  const e = memory?.entries;
  const d = memory?.decisions;
  const hasEmo = emo && emo.count >= 20 && Number.isFinite(emo.arousalSd);
  const hasVal = (e?.valenceCount ?? e?.total) >= MIN_ENTRIES && Number.isFinite(e?.valenceNonZeroRatio);
  if (!hasEmo && !hasVal) {
    return { axis: 'TF', score: null, note: '情绪序列与条目都不够，判不了。', evidence: [] };
  }
  // arousal sd 0..0.35 → 0..1；valence 非零比例 0..1 直接用。
  const sArousal = hasEmo ? Math.max(0, Math.min(1, emo.arousalSd / 0.35)) : null;
  const sVal = hasVal ? Math.max(0, Math.min(1, e.valenceNonZeroRatio)) : null;
  const parts = [];
  if (sArousal !== null) parts.push({ v: sArousal, w: 0.5 });
  if (sVal !== null) parts.push({ v: sVal, w: 0.5 });
  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const fLean = parts.reduce((a, p) => a + p.v * p.w, 0) / (wSum || 1);
  // T 是高分端：越「先算再答」分越高。
  let score = (1 - fLean) * 100;
  const conf = Number.isFinite(d?.avgConf) ? d.avgConf : null;
  if (conf !== null) score = score * 0.8 + Math.max(0, Math.min(1, conf)) * 20;
  const nonNeutral = hasVal ? `${Math.round(e.valenceNonZeroRatio * 100)}%` : null;
  const notes = [hasEmo && `情绪唤醒波动 ${r1(emo.arousalSd)}`, nonNeutral && `已标注情绪的记忆中，非中性占 ${nonNeutral}`];
  return {
    axis: 'TF',
    score: r1(Math.max(0, Math.min(100, score))),
    note: `${notes.filter(Boolean).join('，')}。`,
    evidence: [
      { label: '情绪采样', value: String(emo?.count ?? 0), hint: '近两周' },
      { label: '唤醒波动', value: hasEmo ? String(r1(emo.arousalSd)) : '—' },
      { label: '非中性记忆（仅已标注情绪）', value: nonNeutral ?? '—' },
      { label: '平均判断置信', value: conf === null ? '—' : String(r1(conf)) },
    ],
  };
}

/**
 * J/P：章法。
 * 代理指标：活跃小时的分布熵（越均匀 → P） + 判断类型集中度（越集中 → J）。
 */
export function axisJP(memory) {
  const d = memory?.decisions;
  if (!d || d.total < MIN_DECISIONS) {
    return { axis: 'JP', score: null, note: `判断样本只有 ${d?.total ?? 0} 次，不够。`, evidence: [] };
  }
  const ent = Number.isFinite(d.hourEntropy) ? d.hourEntropy : null;
  const conc = Number.isFinite(d.kindConcentration) ? d.kindConcentration : null;
  if (ent === null && conc === null) {
    return { axis: 'JP', score: null, note: '缺少作息或类型数据。', evidence: [] };
  }
  // 熵 1 = 全天均匀（P），0 = 全挤一个点（J）；反过来就是 J 分。
  const sEnt = ent === null ? null : 1 - ent;
  const sConc = conc === null ? null : conc;
  const parts = [];
  if (sEnt !== null) parts.push({ v: sEnt, w: 0.55 });
  if (sConc !== null) parts.push({ v: sConc, w: 0.45 });
  const wSum = parts.reduce((a, p) => a + p.w, 0);
  const score = (parts.reduce((a, p) => a + p.v * p.w, 0) / (wSum || 1)) * 100;
  return {
    axis: 'JP',
    score: r1(Math.max(0, Math.min(100, score))),
    note: `作息均匀度 ${ent === null ? '—' : r1(ent)}，话题集中度 ${conc === null ? '—' : r1(conc)}。`,
    evidence: [
      { label: '判断次数', value: String(d.total) },
      { label: '作息熵', value: ent === null ? '—' : String(r1(ent)), hint: '1 = 全天均匀' },
      { label: '话题集中度', value: conc === null ? '—' : String(r1(conc)), hint: '前两类占比' },
    ],
  };
}

/**
 * 跑完四轴。
 * 返回 { axes:[...], letters, missing:[...] }。
 * 缺轴时 letters 对应位置用 '?'，缺 ≥2 轴则不给代号（只在 UI 上说明缺什么）。
 */
export function runBehavior(snapshot) {
  const axes = [axisEI(snapshot?.memory), axisSN(snapshot?.memory), axisTF(snapshot?.memory), axisJP(snapshot?.memory)];
  return { ...composeLetters(axes), axes };
}

const LETTER_PAIRS = [
  ['E', 'I'],
  ['S', 'N'],
  ['T', 'F'],
  ['J', 'P'],
];

/**
 * 由四轴分数合成字母。
 * score ≥50 取前一个字母，<50 取后一个字母，null 取 '?'。
 */
export function composeLetters(axes) {
  let letters = '';
  const missing = [];
  axes.forEach((a, i) => {
    if (Number.isFinite(a?.score)) {
      letters += a.score >= 50 ? LETTER_PAIRS[i][0] : LETTER_PAIRS[i][1];
    } else {
      letters += '?';
      missing.push(a?.axis ?? `axis${i}`);
    }
  });
  return { letters, missing, complete: missing.length === 0, usable: missing.length <= 1 };
}
