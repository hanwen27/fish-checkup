/**
 * 人话层：把六维分数压成「一句话结论 + 要紧的三件 + 你可以做的」。
 *
 * 纯函数，只读 runHardware 的产物。不新增任何采集、不调模型。
 * 目的：让首屏第一眼是「她怎么样」，而不是「六个数字」。
 */

import { pick, DIM_TITLES } from './text.mjs';
import { dimensionGuide, simpleHardware } from './hardware-guide.mjs';

/** 这维有多痛：扣掉的分 × 权重。用来排序，不是因为它是「分数」。 */
function severity(dim) {
  if (!Number.isFinite(dim.score)) return -1;
  return (100 - dim.score) * (dim.weight ?? 0.15);
}

/**
 * 趋势：正数=在变好。delta 为 null 表示没得比。小于 5 分算噪声，不写。
 *
 * 措辞跟状态走：一个 41 分的维度写「比之前高 32 分」会让人以为没事，
 * 所以偏弱时改成「在回升」——回升了也还是吃力，两件事都得说。
 */
function trendWord(delta, lang, state) {
  if (!Number.isFinite(delta)) return null;
  const zh = lang === 'zh';
  const abs = Math.round(Math.abs(delta));
  if (abs < 5) return null;
  const weak = state === 'bad' || state === 'warn';
  if (delta > 0) {
    if (weak) return zh ? `近几天在回升 +${abs}` : `recovering +${abs}`;
    return zh ? `比之前高 ${abs} 分` : `+${abs} vs earlier`;
  }
  if (state === 'ok') return zh ? `比之前低 ${abs} 分` : `-${abs} vs earlier`;
  return zh ? `比之前低 ${abs} 分` : `-${abs} vs earlier`;
}

const STATE_WORD = {
  zh: { solid: '状态很好', good: '挺好的', fair: '有几处可以更好', poor: '有点吃力', insufficient: '还看不出来' },
  en: { solid: 'In good shape', good: 'Doing fine', fair: 'A few things could be better', poor: 'Under strain', insufficient: 'Not enough to tell yet' },
};

const TONE = { solid: 'calm', good: 'calm', fair: 'warm', poor: 'strain', insufficient: 'muted' };

/**
 * @param {object} hardware runHardware() 的返回值
 * @param {string} language
 */
export function buildSummary(hardware, language = 'zh') {
  const lang = pick(language);
  const zh = lang === 'zh';
  const dims = hardware?.dimensions ?? [];
  const levelKey = hardware?.levelKey ?? 'insufficient';

  const scored = dims.filter((d) => Number.isFinite(d.score));
  // 按「痛」排序；并列时按权重大的在前（影响面更广）。
  const ranked = [...scored].sort((a, b) => severity(b) - severity(a) || (b.weight ?? 0) - (a.weight ?? 0));

  // 全都没问题时不硬凑三条——只挑最弱的放前面，标注「也还行」。
  const top = ranked.slice(0, 3).map((d) => brief(d, lang));
  const rest = ranked.slice(3).map((d) => brief(d, lang));
  const unknown = dims.filter((d) => !Number.isFinite(d.score)).map((d) => brief(d, lang));

  const stateWord = STATE_WORD[lang][levelKey] ?? STATE_WORD[lang].insufficient;
  const worst = ranked[0] ?? null;

  const sentence = composeSentence({ zh, levelKey, stateWord, worst, scored, unknown });
  const detail = composeDetail({ zh, ranked, scored, unknown });

  // 只在确实偏弱（bad/warn）的维度里给建议，最多三条。
  const care = [...top, ...rest]
    .filter((d) => d.needsAttention)
    .slice(0, 3)
    .map((d) => ({ id: d.id, title: d.title, body: d.suggestion }))
    .filter((c) => c.body);

  return {
    tone: TONE[levelKey] ?? 'muted',
    levelKey,
    stateWord,
    sentence,
    detail,
    top,
    rest,
    unknown,
    care,
    simple: simpleHardware([...top, ...rest, ...unknown], lang),
  };
}

function brief(dim, lang) {
  const zh = lang === 'zh';
  return {
    id: dim.id,
    title: DIM_TITLES[lang]?.[dim.id] ?? dim.title,
    score: Number.isFinite(dim.score) ? dim.score : null,
    state: dim.state,
    headline: dim.headline,
    ...dimensionGuide(dim, lang),
    // 详情跟着走：点开要能看到依据/公式/意义，不能只剩一个标题。
    evidence: dim.evidence ?? [],
    formula: dim.formula ?? '',
    meaning: dim.meaning ?? '',
    // 稀疏序列：null 表示那天样本不够，画的时候断线，不假装连上。
    series: Array.isArray(dim.series) ? dim.series : [],
    delta: Number.isFinite(dim.delta) ? dim.delta : null,
    comparison: dim.comparison ?? null,
    trend: trendWord(dim.delta, lang, dim.state),
    trendUp: Number.isFinite(dim.delta) ? dim.delta > 0 : null,
    sparkHint: zh ? '近几天（点开看依据）' : 'Recent days (open for evidence)',
  };
}

/** 维度标题按语言取；配置里只有中文，英文环境回落到 DIM_TITLES。 */
function titleOf(dim, lang) {
  return DIM_TITLES[lang]?.[dim.id] ?? dim.title;
}

/** 一句话结论：点出最该看的那一件。状态词已经单独显示了，句子里不再重复。 */
function composeSentence({ zh, levelKey, stateWord, worst, scored, unknown }) {
  if (!worst) {
    if (unknown.length > 0) {
      return zh
        ? '这次几乎没读到数据，暂时给不出结论。'
        : 'Almost no data this time, so no verdict yet.';
    }
    return zh ? '一切正常。' : 'All clear.';
  }
  const name = titleOf(worst, zh ? 'zh' : 'en');
  const lead = levelKey === 'solid' || levelKey === 'good'
    ? (zh ? '' : '')
    : '';

  // 掉得厉害就直说在往下掉——「变坏」比「现在多少」更该被看见。
  const falling = Number.isFinite(worst.delta) && worst.delta <= -8;
  if (falling) {
    const abs = Math.round(Math.abs(worst.delta));
    return zh
      ? `${name}在往下掉，比之前低了 ${abs} 分${worstNote(worst, zh)}`
      : `${name} is sliding — ${abs} points below where it was${worstNote(worst, false)}`;
  }

  if (levelKey === 'solid' || levelKey === 'good') {
    return zh
      ? `最弱的一项是${name}（${Math.round(worst.score)} 分），也在正常范围里。`
      : `The weakest area is ${name} (${Math.round(worst.score)}), still within range.`;
  }

  // 英文版没有本地化的 headline（那是在 hardware.mjs 里按中文生成的），别把中文漏出来。
  if (!zh) {
    return `The weak spot is ${name}, at ${Math.round(worst.score)}.`;
  }
  return `${lead}${name}这块还能再顺一点：${stripPeriod(worst.headline)}。`;
}

function worstNote(dim, zh) {
  if (dim.state !== 'bad') return zh ? '。' : '.';
  return zh ? '，已经到「有问题」那档。' : ', now in issue territory.';
}

function composeDetail({ zh, ranked, scored, unknown }) {
  const lang = zh ? 'zh' : 'en';
  const parts = [];
  if (unknown.length > 0) {
    parts.push(zh
      ? `${unknown.map((d) => d.title).join('、')} 这次没读到足够数据，没算进来。`
      : `${unknown.map((d) => d.title).join(', ')} lacked data and were excluded.`);
  }
  const weak = scored.filter((d) => d.state !== 'ok');
  const strong = scored.filter((d) => d.state === 'ok');
  // 有问题的项数必须一直说出来——只写「谁还稳」会让人以为没别的事了。
  if (weak.length > 0) {
    parts.push(zh
      ? `${weak.length} 项还能更好，具体依据见下方。`
      : `${weak.length} areas could improve. See the evidence below.`);
  }
  if (strong.length > 0) {
    if (weak.length > 0) {
      parts.push(zh
        ? `${strong.map((d) => titleOf(d, lang)).join('、')} 还稳。`
        : `${strong.map((d) => titleOf(d, lang)).join(', ')} remain steady.`);
    } else if (scored.length > 0) {
      parts.push(zh
        ? `共 ${scored.length} 项，全部在可接受范围。`
        : `All ${scored.length} areas are acceptable.`);
    }
  } else if (weak.length === 0 && ranked.length === 0) {
    parts.push(zh ? '这次没有可判的维度。' : 'No scored dimensions this time.');
  }
  return parts.join(' ');
}

function stripPeriod(s) {
  return String(s ?? '').replace(/[。.]$/, '');
}

/* ------------------------------------------------------------ 人格：一致性人话 */

/** 每根轴两个端点各自的人话说法。 */
const AXIS_WORDS = {
  zh: {
    EI: { hi: '爱主动开口', lo: '先听着、不太出声' },
    SN: { hi: '讲具体的事', lo: '爱往远里联想' },
    TF: { hi: '较真、讲道理', lo: '先顾着情绪' },
    JP: { hi: '按章法来', lo: '随性、走到哪算哪' },
  },
  en: {
    EI: { hi: 'speaks up first', lo: 'listens before talking' },
    SN: { hi: 'sticks to concrete things', lo: 'ranges far and wide' },
    TF: { hi: 'argues the point', lo: 'reads the mood first' },
    JP: { hi: 'keeps a plan', lo: 'goes with the flow' },
  },
};

const AXIS_PAIRS = [
  ['EI', 'E', 'I'],
  ['SN', 'S', 'N'],
  ['TF', 'T', 'F'],
  ['JP', 'J', 'P'],
];

const AXIS_NAMES = { zh: { EI: '开口', SN: '关注面', TF: '较真', JP: '章法' }, en: { EI: 'speaking', SN: 'focus', TF: 'judgement', JP: 'structure' } };

export function buildPersonalityConclusion(personality, language) {
  if (personality?.profile?.character) return personality.profile.character;
  const lang = pick(language);
  const zh = lang === 'zh';
  const scoredAxes = (axes) => AXIS_PAIRS.map(([id]) => ({ id, score: axes?.[id] }))
    .filter(({ score }) => Number.isFinite(score));
  const self = scoredAxes(personality?.selfAxes);
  const behavior = scoredAxes(personality?.behaviorAxes);
  const quizReady = personality?.taken && !personality.flags?.includes('unstable') && self.length >= 3;
  if (quizReady || behavior.length === AXIS_PAIRS.length) {
    const axes = quizReady ? self : behavior;
    const strongest = axes.filter(({ score }) => Math.abs(score - 50) >= 10)
      .sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50))[0];
    const basis = quizReady
      ? (zh ? '来自她的情境小测自述' : 'Based on her quiz answers')
      : (zh ? '来自近期行为记录' : 'Based on recent behaviour records');
    if (!strongest) {
      return { conclusion: zh ? '她在有结果的性格维度上总体偏均衡' : 'Her measured traits are generally balanced', basis };
    }
    const trait = AXIS_WORDS[lang][strongest.id][strongest.score >= 50 ? 'hi' : 'lo'];
    return { conclusion: zh ? `她${trait}` : `She ${trait}`, basis };
  }

  const tags = (personality?.tags?.tags ?? []).filter(({ group, id }) => group !== 'craft' && id !== 'untested');
  if (tags.length < 2) return null;
  const labels = tags.slice(0, 2).map(({ label }) => label);
  return zh
    ? { conclusion: `她近期有两个比较明显的特点：${labels.join('、')}`, basis: '来自体检标签的记录依据' }
    : { conclusion: `Two traits stand out in her recent records (${labels.join(', ')})`, basis: 'Based on the trait evidence in this report' };
}

/**
 * 自述 vs 行为，逐轴说人话。
 * 不只报「平均偏差 16.5」——那是个数字，读了不知道该想什么。
 * 真正有意思的是「哪一轴对不上、怎么对不上」。
 */
export function buildConsistency(personality, language = 'zh') {
  const lang = pick(language);
  const zh = lang === 'zh';
  const per = personality?.comparison?.perAxis ?? [];

  const rows = per.map((a) => {
    const [, hi, lo] = AXIS_PAIRS.find((p) => p[0] === a.axis) ?? [a.axis, '?', '?'];
    const selfLetter = Number.isFinite(a.self) ? (a.self >= 50 ? hi : lo) : null;
    const behavLetter = Number.isFinite(a.behavior) ? (a.behavior >= 50 ? hi : lo) : null;
    const agree = selfLetter !== null && behavLetter !== null ? selfLetter === behavLetter : null;
    const words = AXIS_WORDS[lang][a.axis];
    let text = null;
    if (agree === true) {
      text = zh ? `她说自己${words[selfLetter === hi ? 'hi' : 'lo']}，行为上也是。`
        : `She says she ${words[selfLetter === hi ? 'hi' : 'lo']}, and behaves that way.`;
    } else if (agree === false) {
      text = zh ? `她说自己${words[selfLetter === hi ? 'hi' : 'lo']}，行为上更像${words[behavLetter === hi ? 'hi' : 'lo']}。`
        : `She says she ${words[selfLetter === hi ? 'hi' : 'lo']}, but behaves more like someone who ${words[behavLetter === hi ? 'hi' : 'lo']}.`;
    }
    return {
      axis: a.axis,
      label: AXIS_NAMES[lang][a.axis],
      self: a.self,
      behavior: a.behavior,
      delta: a.delta,
      agree,
      text,
    };
  });

  const comparable = rows.filter((r) => r.agree !== null);
  const agreeCount = comparable.filter((r) => r.agree).length;
  if (comparable.length < AXIS_PAIRS.length) {
    const behaviorMissing = rows.filter(({ behavior }) => Number.isFinite(behavior)).length < AXIS_PAIRS.length;
    const sentence = behaviorMissing
      ? (zh ? '暂无法比较（行为维度样本不足）' : 'Comparison unavailable (insufficient behaviour samples)')
      : (zh ? '暂无法比较（小测维度样本不足）' : 'Comparison unavailable (insufficient self-report samples)');
    return { sentence, detail: null, rows, agreeCount, total: comparable.length };
  }
  // 取偏差最大的一轴作为那句话的重点——差异才是可读的部分。
  const widest = [...comparable].sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))[0];
  const same = comparable.filter((r) => r.agree).map((r) => r.label);
  const diff = comparable.filter((r) => !r.agree).map((r) => r.label);

  let sentence;
  if (agreeCount === comparable.length) {
    sentence = zh
      ? `${same.join('、')}都对得上——她怎么说的，就怎么做。`
      : `All axes line up: ${same.join(', ')}. She does what she says.`;
  } else if (agreeCount === 0) {
    sentence = zh
      ? `四轴全对不上。她对自己的描述，和行为里的她不是同一个人。`
      : 'None of the axes line up. How she describes herself is not how she behaves.';
  } else {
    sentence = zh
      ? `${same.join('、')}对得上；${diff.join('、')}对不上——${stripPeriod(widest.text)}`
      : `${same.join(', ')} line up; ${diff.join(', ')} do not — ${stripPeriod(widest.text)}`;
  }

  const detail = zh
    ? `${comparable.length} 根可比轴里 ${agreeCount} 根一致。差得最多的是${widest.label}（${Math.round(widest.delta ?? 0)} 分）。`
    : `${agreeCount} of ${comparable.length} comparable axes agree. The widest gap is ${widest.label} (${Math.round(widest.delta ?? 0)}).`;

  return { sentence, detail, rows, agreeCount, total: comparable.length };
}
