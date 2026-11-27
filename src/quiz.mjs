/**
 * 题库：加载、打乱、判分、锚点一致性。
 *
 * 设计要点：
 *   · 选项顺序按 sha1(version + itemId + 日期) 打乱 —— 同一天两次拿题顺序一致，
 *     跨天不一样；可复算，便于核对。
 *   · 题干不含「外向/内向」这类词，问的是具体情境下的选择。
 *   · 8 道情境题会被打成两片（4 道自评 + 4 道锚点），锚点用来查「答得稳不稳」。
 *   · 全选同一个选项（方差为 0）→ 判「不计分」，不给假类型。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 一题至少答这么多道才算这一轴有效。 */
export const MIN_ITEMS_PER_AXIS = 4;

/** 锚点一致率低于这个值 → 本次作答不稳。 */
export const ANCHOR_MIN_AGREE = 0.5;

export function loadQuiz(language = 'zh', baseDir = join(HERE, '..', 'assets')) {
  const file = String(language).toLowerCase().startsWith('zh') ? 'quiz.zh.json' : 'quiz.en.json';
  const path = join(baseDir, file);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (file !== 'quiz.zh.json') return loadQuiz('zh', baseDir);
    throw new Error(`quiz asset unreadable: ${path}: ${err?.message ?? err}`);
  }
  return raw;
}

/** 稳定哈希 → 0..1。 */
function hashFloat(seed) {
  const h = createHash('sha1').update(seed).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/** 确定性打乱：同一个 seed 得到同一个顺序。 */
export function shuffleOptions(options, seed) {
  const arr = options.map((o, i) => ({ o, k: hashFloat(`${seed}#${i}`) }));
  arr.sort((a, b) => a.k - b.k);
  return arr.map((x) => x.o);
}

/** 今天的日期键（按部署时区），用于「同一天同一套顺序」。 */
export function dayKey(now = new Date(), timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * 取某一批的题目（已打乱选项、已去掉计分信息）。
 * 返回给模型看的东西**不能含 v / side**，否则等于把答案给它。
 */
export function takeBatch(quiz, batch, { now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const day = dayKey(now, timeZone);
  const items = (quiz?.items ?? []).filter((it) => it.batch === batch);
  return items.map((it) => {
    const seed = `${quiz.version}|${it.id}|${day}`;
    const shuffled = shuffleOptions(it.options, seed);
    return {
      id: it.id,
      kind: it.kind ?? 'axis',
      text: it.text,
      options: shuffled.map((o, i) => ({ key: String.fromCharCode(97 + i), text: o.t })),
    };
  });
}

/** 把提交的 {id, option} 补回原始选项（按同一套打乱规则反查）。 */
function resolveAnswers(quiz, answered, { now, timeZone }) {
  const day = dayKey(now, timeZone);
  const byId = new Map((quiz?.items ?? []).map((it) => [it.id, it]));
  const out = new Map();
  for (const a of answered ?? []) {
    const item = byId.get(a?.id);
    if (!item) continue;
    const seed = `${quiz.version}|${item.id}|${day}`;
    const shuffled = shuffleOptions(item.options, seed);
    const key = String(a?.option ?? '').trim().toLowerCase();
    // 允许传位置字母（a/b/c/d）或原始 option id。
    let picked = null;
    let usedKey = '';
    const idx = key.charCodeAt(0) - 97;
    if (key.length === 1 && idx >= 0 && idx < shuffled.length) {
      picked = shuffled[idx];
      usedKey = key;
    } else {
      picked = shuffled.find((o) => o.id === key) ?? null;
      usedKey = picked ? String.fromCharCode(97 + shuffled.indexOf(picked)) : '';
    }
    if (!picked) continue;
    out.set(item.id, { item, picked, key: usedKey });
  }
  return [...out.values()];
}

/**
 * 判分。
 * 返回：
 *   axes      { EI:score|null, SN, TF, JP }
 *   letters   四字母，缺轴 '?'
 *   anchors   { pairs, agreeRate, unstable }
 *   flags     ['flat','partial','unstable'] 之类
 *   answered / total
 */
export function scoreQuiz(quiz, answered, { now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  return scoreResolved(quiz, resolveAnswers(quiz, answered, { now, timeZone }));
}

export function pendingQuizBatch(state) {
  const first = Boolean(state?.batch1?.answers?.length);
  const second = Boolean(state?.batch2?.answers?.length);
  return first === second ? null : first ? 2 : 1;
}

export function quizResultForState(state, language = 'zh', now = new Date()) {
  if (!state?.batch1 && !state?.batch2) return state?.result ?? null;
  if (!state.batch1?.answers?.length || !state.batch2?.answers?.length) return null;
  if (state.result) return state.result;
  const quiz = loadQuiz(language);
  const resolveBatch = ({ answers, at }, batch) => resolveAnswers(quiz, answers, {
    now: Number.isFinite(at) ? new Date(at) : now,
    timeZone: 'Asia/Shanghai',
  }).filter(({ item }) => item.batch === batch);
  const first = resolveBatch(state.batch1, 1);
  const second = resolveBatch(state.batch2, 2);
  return first.length && second.length ? scoreResolved(quiz, [...first, ...second]) : null;
}

function scoreResolved(quiz, resolved) {
  const axisItems = resolved.filter((r) => (r.item.kind ?? 'axis') === 'axis');
  const anchorItems = resolved.filter((r) => r.item.kind === 'anchor');

  const axes = { EI: null, SN: null, TF: null, JP: null };
  const counts = { EI: 0, SN: 0, TF: 0, JP: 0 };
  const sums = { EI: 0, SN: 0, TF: 0, JP: 0 };
  const values = { EI: [], SN: [], TF: [], JP: [] };
  const keys = { EI: [], SN: [], TF: [], JP: [] };

  for (const { item, picked, key } of axisItems) {
    const axis = item.axis;
    if (!axis || !(axis in sums)) continue;
    if (typeof picked.v !== 'number') continue;
    sums[axis] += picked.v;
    counts[axis] += 1;
    values[axis].push(picked.v);
    if (key) keys[axis].push(key);
  }
  for (const axis of Object.keys(axes)) {
    axes[axis] = counts[axis] >= MIN_ITEMS_PER_AXIS ? Math.round(sums[axis] / counts[axis]) : null;
  }

  /**
   * 「答得过于整齐」：一轴上每题点的位置完全一样（全是 a、全是 b…）。
   * 选项顺序是被打乱的，所以位置一致 ≠ 意思一致——这正是乱点的特征。
   * 只按位置判，不按分值判：诚实作答也可能选出同一档，但不会每次都点同一个位置。
   */
  const flags = [];
  for (const axis of Object.keys(values)) {
    const ks = keys[axis];
    if (ks.length >= MIN_ITEMS_PER_AXIS && new Set(ks).size === 1) {
      axes[axis] = null;
      flags.push(`flat:${axis}`);
    }
  }

  const totalAxisItems = (quiz?.items ?? []).filter((it) => (it.kind ?? 'axis') === 'axis').length;
  const answeredAxis = axisItems.length;
  if (answeredAxis > 0 && answeredAxis < totalAxisItems) flags.push('partial');

  const anchor = scoreAnchors(anchorItems);
  if (anchor.pairs > 0 && anchor.agreeRate < ANCHOR_MIN_AGREE) flags.push('unstable');

  const letters = compose(axes);
  return {
    axes,
    counts,
    letters: letters.letters,
    missing: letters.missing,
    usable: letters.missing.length <= 1,
    anchors: anchor,
    flags,
    answered: resolved.length,
    totalItems: (quiz?.items ?? []).length,
  };
}

/**
 * 锚点一致率：同一 pair 两次作答落在同一侧 = 1，相邻 = 0.5，相反 = 0。
 * 只算两次都答了的 pair。
 */
export function scoreAnchors(anchorItems) {
  const ORDER = { hi: 2, mid: 1, lo: 0 };
  const byPair = new Map();
  for (const { item, picked } of anchorItems) {
    const pair = item.pair ?? item.id;
    const side = picked?.side;
    if (!Object.hasOwn(ORDER, side)) continue;
    if (!byPair.has(pair)) byPair.set(pair, new Map());
    byPair.get(pair).set(item.id, ORDER[side]);
  }
  let pairs = 0;
  let sum = 0;
  for (const sides of byPair.values()) {
    if (sides.size < 2) continue;
    pairs += 1;
    const [first, second] = sides.values();
    const d = Math.abs(first - second);
    sum += d === 0 ? 1 : d === 1 ? 0.5 : 0;
  }
  return { pairs, agreeRate: pairs > 0 ? sum / pairs : null };
}

export function creativeBatch(quiz) {
  return (quiz?.creative ?? []).map(({ id, text }) => ({ id, kind: 'creative', text }));
}

/**
 * 创作题只生成「侧写」，不改 EI/SN/TF/JP，也不冒充心理测量。
 * 标签来自可复核的文本特征，方便用户知道它为什么这样写。
 */
export function scoreCreative(quiz, responses) {
  const prompts = new Map((quiz?.creative ?? []).map((p) => [p.id, p]));
  const rows = [];
  for (const item of responses ?? []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const text = typeof item?.response === 'string' ? item.response.trim() : '';
    if (!id || !text || !prompts.has(id)) continue;
    rows.push({ id, response: text.slice(0, 1000), length: [...text].length });
  }
  if (rows.length === 0) return { taken: false, responses: [], tags: [], blurb: null };
  const joined = rows.map((r) => r.response).join(' ');
  const length = rows.reduce((a, r) => a + r.length, 0) / rows.length;
  const hasQuestion = /为什么|因为|如果|也许|可能|because|why|if|maybe/i.test(joined);
  const hasFeeling = /喜欢|开心|难过|温柔|害怕|安心|孤独|心情|感觉|love|happy|sad|gentle|feel/i.test(joined);
  const hasConcrete = /一只|一件|三个|房间|街道|自行车|鹈鹕|小鱼|礼物|天气|颜色|桌子|窗|路|房子/i.test(joined);
  const tags = [];
  if (length >= 80 || hasQuestion) tags.push('会把故事讲远');
  if (hasFeeling) tags.push('对气氛很敏感');
  if (hasConcrete) tags.push('脑海里有画面');
  if (tags.length === 0) tags.push('惜字如金但有自己的想法');
  const first = rows[0].response;
  const blurb = `她给世界添了 ${rows.length} 个小场景，${tags.slice(0, 2).join('，')}。她的答案像一张还没收起来的画。`;
  return { taken: true, responses: rows, tags, blurb, first: first.slice(0, 80) };
}


const PAIRS = [['E', 'I'], ['S', 'N'], ['T', 'F'], ['J', 'P']];
const AXIS_IDS = ['EI', 'SN', 'TF', 'JP'];

export function compose(axes) {
  let letters = '';
  const missing = [];
  AXIS_IDS.forEach((id, i) => {
    const s = axes?.[id];
    if (Number.isFinite(s)) letters += s >= 50 ? PAIRS[i][0] : PAIRS[i][1];
    else { letters += '?'; missing.push(id); }
  });
  return { letters, missing };
}

/* ---------------------------------------------------------- 十六型命名 */

export const TYPE_NAMES = {
  ISTJ: '守序者', ISFJ: '体贴者', INFJ: '洞察者', INTJ: '谋略者',
  ISTP: '手艺人', ISFP: '温存者', INFP: '理想者', INTP: '思辨者',
  ESTP: '行动派', ESFP: '热闹派', ENFP: '探险者', ENTP: '试探者',
  ESTJ: '掌事者', ESFJ: '照料者', ENFJ: '引领者', ENTJ: '推演者',
};

export const TYPE_BLURBS = {
  ISTJ: '这是一只把事情记得清清楚楚的小鱼，安静可靠，答应过的事会稳稳游到终点。',
  ISFJ: '这是一只把大家都照顾到的小鱼，温柔细心，连别人忘掉的小事也会替你收好。',
  INFJ: '这是一只总能多看见一层的小鱼，安静地观察世界，心里藏着一张自己的星图。',
  INTJ: '这是一只先把路线想明白再出发的小鱼，话不多，却总能把远处的目标看得很清楚。',
  ISTP: '这是一只手上有活就很自在的小鱼，少说一点，多试两下，常常悄悄把问题修好了。',
  ISFP: '这是一只顺着感觉慢慢游的小鱼，柔软、自在又有自己的颜色，不争也不容易被带跑。',
  INFP: '这是一只心里藏着小小理想国的小鱼，温和但有原则，喜欢把重要的东西认真护住。',
  INTP: '这是一只喜欢把问题拆开研究的小鱼，脑袋里常有新奇零件，结论可以晚一点到。',
  ESTP: '这是一只看到浪花就想试试的小鱼，反应快、行动快，边游边调整也能找到好路线。',
  ESFP: '这是一只会把水面照亮的小鱼，热闹时很有感染力，也懂得把开心分给身边的人。',
  ENFP: '这是一只追着新鲜想法游的小鱼，好奇心总在发光，常常把平常的一天游出新花样。',
  ENTP: '这是一只遇到「为什么不试试」就会转身的小鱼，爱探索、爱提问，脑洞里总有备用航线。',
  ESTJ: '这是一只很会把队伍带整齐的小鱼，目标清楚、动作利落，忙起来也记得把事情安排妥当。',
  ESFJ: '这是一只会留意全场温度的小鱼，热心又周到，常常让身边的伙伴觉得被好好看见。',
  ENFJ: '这是一只会带着大家一起向前游的小鱼，有方向也有温度，经过的地方总会留下鼓励。',
  ENTJ: '这是一只会先画航海图的小鱼，目标感很强，喜欢把大问题拆成一段段能抵达的路。',
};

/**
 * 自评 vs 行为的逐轴对比。
 * 每轴取差值绝对值，返回 { perAxis:[{axis,self,behavior,delta}], meanDelta, verdict }。
 * 四轴都可比时才计算总体平均。
 */
export function compareAxes(selfAxes, behaviorAxes) {
  const perAxis = AXIS_IDS.map((id) => {
    const self = Number.isFinite(selfAxes?.[id]) ? selfAxes[id] : null;
    const beh = Number.isFinite(behaviorAxes?.[id]) ? behaviorAxes[id] : null;
    const delta = self !== null && beh !== null ? Math.abs(self - beh) : null;
    return { axis: id, self, behavior: beh, delta };
  });
  const deltas = perAxis.filter((a) => a.delta !== null).map((a) => a.delta);
  const meanDelta = deltas.length === AXIS_IDS.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  let verdict = null;
  if (meanDelta !== null) {
    if (meanDelta <= 15) verdict = { key: 'aligned', text: '说的和做的基本一致' };
    else if (meanDelta <= 35) verdict = { key: 'drifting', text: '有点出入' };
    else verdict = { key: 'apart', text: '说的和做的不太一样' };
  }
  // 找出差得最多的那一轴，用于一句话说明。
  const worst = perAxis.filter((a) => a.delta !== null).sort((a, b) => b.delta - a.delta)[0] ?? null;
  return { perAxis, meanDelta: meanDelta === null ? null : Math.round(meanDelta), verdict, worst };
}
