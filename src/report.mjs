/**
 * 报告装配：把采集快照 + 判分结果拼成面板要用的一份数据。
 * 纯函数。不做 IO，不打分（打分在 hardware.mjs / behavior.mjs / quiz.mjs）。
 */

import { runHardware, summarize } from './hardware.mjs';
import { runBehavior } from './behavior.mjs';
import { buildProfile } from './profile.mjs';
import { loadQuiz, scoreQuiz, compareAxes } from './quiz.mjs';
import { buildSummary, buildConsistency } from './summary.mjs';
import { deriveStats, collectTags } from './tags.mjs';
import { DIM_TITLES, DIM_FORMULAS, LEVELS, STATES, pick } from './text.mjs';

/**
 * @param {object} snapshot  collect.mjs 的产物
 * @param {object} opts      { contextWindow, quizResult, language, quizTakenAt, live }
 */
export function buildReport(snapshot, {
  contextWindow = null,
  quizResult = null,
  language = 'zh',
  quizTakenAt = null,
  live = null,
  creativeResult = null,
  now = new Date(),
} = {}) {
  const lang = pick(language);
  const hardware = runHardware(snapshot, { contextWindow });
  const behavior = runBehavior(snapshot);
  const axes = localizeDimensions(hardware.dimensions, lang);
  const level = LEVELS[lang][hardware.levelKey] ?? hardware.level;

  const quiz = quizResult ?? null;
  const selfAxes = quiz?.axes ?? { EI: null, SN: null, TF: null, JP: null };
  const comparison = compareAxes(selfAxes, {
    EI: behavior.axes[0].score,
    SN: behavior.axes[1].score,
    TF: behavior.axes[2].score,
    JP: behavior.axes[3].score,
  });

  const behaviorAxes = {
    EI: behavior.axes[0].score,
    SN: behavior.axes[1].score,
    TF: behavior.axes[2].score,
    JP: behavior.axes[3].score,
  };

  // 趣味标签：人格这块的主菜。十六型不再作为标题，标签才是。
  // 四轴与一致性降级为「依据」——留着可核对，但不再占首屏。
  const tagStats = deriveStats(snapshot, { behavior, quiz, hardware });
  const tagResult = collectTags(tagStats);

  const personality = {
    profile: buildProfile(snapshot?.memory, lang, snapshot?.activity),
    taken: !!quiz,
    takenAt: quizTakenAt,
    letters: quiz?.letters ?? null,
    selfAxes,
    behaviorAxes,
    behaviorNotes: behavior.axes.map((a) => ({ axis: a.axis, note: a.note, evidence: a.evidence })),
    comparison,
    anchors: quiz?.anchors ?? null,
    flags: quiz?.flags ?? [],
    answered: quiz?.answered ?? 0,
    totalItems: quiz?.totalItems ?? 0,
    missing: quiz?.missing ?? behavior.missing,
    behaviorLetters: behavior.letters,
    behaviorUsable: behavior.usable,
    creative: creativeResult ?? { taken: false, responses: [], tags: [], blurb: null },
    // 标签：外号 / 判词 / 稀有度 / 逐条依据
    tags: tagResult,
  };
  // 一致性用「人话版」：不说「平均偏差 16.5」，说哪一轴对不上、怎么对不上。
  personality.consistency = buildConsistency(personality, lang);

  return {
    language: lang,
    collectedAt: snapshot?.collectedAt ?? now.getTime(),
    sampleDays: snapshot?.sampleDays ?? 7,
    problems: snapshot?.problems ?? [],
    hardware: {
      ...hardware,
      dimensions: axes,
      level,
      levelKey: hardware.levelKey,
    },
    // 人话层：一句话结论 + 要紧的三件 + 你可以做的。旧字段一个没动，这层是新增的。
    summary: buildSummary({ ...hardware, dimensions: axes }, lang),
    personality,
    live: live ?? null,
  };
}

function localizeDimensions(dims, lang) {
  if (lang === 'zh') return dims;
  return dims.map((d) => ({
    ...d,
    title: DIM_TITLES.en[d.id] ?? d.title,
    formula: d.formulaEn ?? DIM_FORMULAS.en[d.id] ?? d.formula,
    stateLabel: STATES.en[d.state] ?? d.state,
  }));
}

/**
 * 纯文本报告，给「复制报告」和工具回执用。
 *
 * mode:
 *   'detail'（默认）—— 完整版：六维 + 逐条依据 + 人格四轴，给面板复制、给人细看。
 *   'brief'        —— 口语版：三段，不带原始计数、不带最差日期、不带公式，
 *                     专门给模型读了自己转述给用户。她要能照着说，不能照抄运维日报。
 */
export function reportToText(report, { language = report.language, mode = 'detail' } = {}) {
  if (mode === 'brief') return briefText(report, { language });
  const lang = pick(language);
  const zh = lang === 'zh';
  const lines = [];
  lines.push(zh ? `体检报告 · 采集于 ${fmt(report.collectedAt)} · 样本 ${report.sampleDays} 天` : `Checkup · collected ${fmt(report.collectedAt)} · ${report.sampleDays} day window`);
  lines.push('');
  // 先给一句话结论，再上数字——顺序本身就是「体检报告」和「仪表盘」的区别。
  const sum = report.summary;
  if (sum?.sentence) {
    lines.push(sum.sentence);
    if (sum.detail) lines.push(sum.detail);
    lines.push('');
  }
  lines.push(zh ? `【硬件健康】${report.hardware.overall ?? '—'} ${report.hardware.level}` : `[Hardware] ${report.hardware.overall ?? '—'} ${report.hardware.level}`);
  for (const d of report.hardware.dimensions) {
    // 小于 5 分的变动不标：风噪比信号大，写了只会让人反复追问。
    const trend = Number.isFinite(d.delta) && Math.abs(d.delta) >= 5
      ? `（${d.delta > 0 ? '+' : ''}${Math.round(d.delta)}）`
      : '';
    lines.push(`  ${d.title}  ${d.score ?? '—'}${trend}  ${d.headline}`);
    for (const e of d.evidence ?? []) lines.push(`    · ${e.label}: ${e.value}${e.hint ? ` (${e.hint})` : ''}`);
  }
  if (sum?.care?.length) {
    lines.push('');
    lines.push(zh ? '可以先做的：' : 'What you can do:');
    for (const c of sum.care) lines.push(`  · ${c.title}：${c.body}`);
  }
  lines.push('');
  const p = report.personality;
  const hasTags = !!(p.tags && p.tags.tags);
  // area=hardware 时人格这半被清空，连标题都不该出现——空标题会让人以为数据丢了。
  if (hasTags || p.taken) {
    lines.push(zh ? '【人格标签】' : '[Trait tags]');
  }
  if (hasTags) {
    const tags = p.tags;
    lines.push(`  ${tags.nickname}`);
    if (tags.verdict) lines.push(`  ${tags.verdict}`);
    for (const t of tags.tags ?? []) {
      lines.push(`  [${t.tierLabel}] ${t.label} —— ${t.evidence}`);
    }
    lines.push(`  池子 ${tags.pool} 条，这条鱼命中 ${tags.hitCount} 条（常见 ${tags.rarity[1]} / 少见 ${tags.rarity[2]} / 稀有 ${tags.rarity[3]} / 传说 ${tags.rarity[4]}）。`);
    if (tags.combos?.length) {
      lines.push(`  ${zh ? '组合彩蛋' : 'Combos'}：`);
      for (const c of tags.combos) {
        lines.push(`  [${c.tierLabel}] ${c.title} —— ${c.blurb}`);
        lines.push(`     （${c.need.join(' + ')}）`);
      }
    }
  }
  if (p.creative?.taken && p.creative.blurb) lines.push(`  ${zh ? '创作彩蛋' : 'Creative'}: ${p.creative.blurb}`);
  if (!p.taken && hasTags) {
    lines.push(`  ${zh ? '人格题还没做，上面这些只来自行为痕迹。' : 'No questionnaire yet; tags come from behaviour traces only.'}`);
  } else if (p.taken) {
    lines.push('');
    const fmtAxis = (v) => (v === null || v === undefined ? '?' : Math.round(v));
    const s = p.selfAxes ?? {};
    const b = p.behaviorAxes ?? {};
    lines.push(`  ${zh ? '依据 · 自述' : 'Evidence · self'}  E${fmtAxis(s.EI)} S${fmtAxis(s.SN)} T${fmtAxis(s.TF)} J${fmtAxis(s.JP)}`);
    lines.push(`  ${zh ? '依据 · 行为' : 'Evidence · behav'} E${fmtAxis(b.EI)} S${fmtAxis(b.SN)} T${fmtAxis(b.TF)} J${fmtAxis(b.JP)}`);
    if (p.comparison?.verdict) {
      const delta = p.comparison.meanDelta;
      const suffix = delta === null || delta === undefined ? '' : ` (${zh ? '平均偏差' : 'mean delta'} ${delta})`;
      lines.push(`  ${zh ? '一致性' : 'Consistency'}: ${p.comparison.verdict.text}${suffix}`);
    }
    if (p.anchors?.agreeRate !== null && p.anchors?.agreeRate !== undefined) {
      lines.push(`  ${zh ? '锚点一致率' : 'Anchor agreement'}: ${Math.round(p.anchors.agreeRate * 100)}%`);
    }
    if (p.flags?.length) lines.push(`  ${zh ? '备注' : 'Notes'}: ${p.flags.join(', ')}`);
  }
  if (report.problems?.length) {
    lines.push('');
    lines.push(zh ? '读不到的部分：' : 'Unreadable:');
    for (const pr of report.problems) lines.push(`  · ${pr}`);
  }
  lines.push('');
  lines.push(zh ? '只读取，不修改。' : 'Reads only. Writes nothing.');
  return lines.join('\n');
}

/**
 * 口语版：给模型读，让她能照着向用户转述。
 *
 * 刻意删掉三样东西：
 *   · 原始计数（「3675 次里 1074 次失败」）——用户听不出大小，只会被数字吓到；
 *   · 具体日期（「最差的一天是 11-23，78.7%」）——翻旧账没有用，还会让人以为现在就是那天；
 *   · 公式与术语（p95、CV、prefixHash）——她照读会像机翻。
 *
 * 留下的是：现在怎么样、哪一块最值得看、能做什么、人格是什么，以及一句转述纪律。
 */
function briefText(report, { language = report.language } = {}) {
  const lang = pick(language);
  const zh = lang === 'zh';
  const lines = [];
  const hw = report.hardware ?? {};
  const sum = report.summary ?? {};
  const p = report.personality ?? {};

  lines.push(zh ? '【一句话】' : '[In one line]');
  if (Number.isFinite(hw.overall)) {
    lines.push(zh
      ? `硬件 ${hw.overall} 分，${hw.level}。${sum.sentence ?? ''}`.trim()
      : `Hardware ${hw.overall}/100, ${hw.level}. ${sum.sentence ?? ''}`.trim());
  } else {
    lines.push(zh ? '这次数据不够，暂时给不出硬件分。' : 'Not enough data for a hardware score this time.');
  }
  lines.push('');

  lines.push(zh ? '【最值得看的一处】' : '[Worth a look]');
  const weak = (hw.dimensions ?? [])
    .filter((d) => d.state === 'bad' || d.state === 'warn')
    .sort((a, b) => (100 - a.score) * a.weight - (100 - b.score) * b.weight)
    .pop();
  if (weak) {
    lines.push(zh
      ? `${weak.title}：${weak.headline}`
      : `${weak.title}: ${weak.headline}`);
  } else if ((hw.dimensions ?? []).length > 0) {
    lines.push(zh ? '六项都在正常范围，没有特别要吃力的地方。' : 'All six areas are within range.');
  } else {
    lines.push(zh ? '这块没有可判的数据。' : 'Nothing scorable here.');
  }
  lines.push('');

  lines.push(zh ? '【能做的】' : '[What can be done]');
  if (sum.care?.length) {
    for (const c of sum.care) lines.push(`· ${c.body}`);
  } else {
    lines.push(zh ? '不用做什么，保持现在的用法就行。' : 'Nothing needed — keep using it as you do.');
  }
  lines.push('');

  lines.push(zh ? '【标签】' : '[Tags]');
  const tags = p.tags;
  if (tags) {
    lines.push(zh ? `外号：${tags.nickname}` : `Nickname: ${tags.nickname}`);
    if (tags.verdict) lines.push(tags.verdict);
    // 只给前四条：口语稿是给她转述的，不是清单。剩下的在 detail 版里。
    for (const t of (tags.tags ?? []).slice(0, 4)) lines.push(`· ${t.label}（${t.tierLabel}）——${t.roast}`);
    if (tags.hitCount > 4) lines.push(zh ? `（还有 ${tags.hitCount - 4} 条，面板上能看到）` : `(${tags.hitCount - 4} more on the panel)`);
    // 组合彩蛋单独一句：这是「抽到了」的地方，转述时最值得提。
    if (tags.combos?.length) {
      const top = tags.combos[0];
      lines.push(zh ? `还凑出一个组合：「${top.title}」——${top.blurb}` : `Combo unlocked: "${top.title}" — ${top.blurb}`);
    }
  }
  if (p.creative?.taken && p.creative.blurb) lines.push(p.creative.blurb);
  if (p.consistency?.sentence && p.taken) lines.push(p.consistency.sentence);
  lines.push('');

  lines.push(zh
    ? '【怎么跟人说】照上面的意思用自己的话说，别念数字、别提具体哪天最差；用「现在怎么样、哪块值得看看、要不要做点什么」这个顺序。'
    : '[How to say it] Paraphrase in your own words. Do not recite raw counts or name the worst day. Order: how it is now, what to look at, what to do.');
  lines.push(zh ? '只读取，不修改。' : 'Reads only. Writes nothing.');
  return lines.join('\n');
}

function fmt(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export { summarize };
