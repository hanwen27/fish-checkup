/**
 * 报告装配：把采集快照 + 判分结果拼成面板要用的一份数据。
 * 纯函数。不做 IO，不打分（打分在 hardware.mjs / behavior.mjs / quiz.mjs）。
 */

import { runHardware, summarize } from './hardware.mjs';
import { runBehavior } from './behavior.mjs';
import { buildProfile } from './profile.mjs';
import { loadQuiz, scoreQuiz, compareAxes } from './quiz.mjs';
import { buildSummary, buildConsistency } from './summary.mjs';
import { dimensionGuide } from './hardware-guide.mjs';
import { explainCalibration } from './scale.mjs';
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
  const axes = localizeDimensions(hardware.dimensions, lang).map((dimension) => ({
    ...dimension, ...dimensionGuide(dimension, lang),
  }));
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
    profile: buildProfile(snapshot?.memory, lang, snapshot?.activity, quiz),
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
      scoring: explainCalibration(lang).split('\n'),
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
  const dimensions = report.hardware.dimensions ?? [];
  if (dimensions.length) {
    if (sum?.simple) {
      lines.push([sum.simple.overall, sum.simple.priority, sum.simple.scope].filter(Boolean).join(' '));
      lines.push(sum.simple.next);
    }
    lines.push(zh ? `【运行健康】${report.hardware.overall ?? '—'} ${report.hardware.level}` : `[Operational health] ${report.hardware.overall ?? '—'} ${report.hardware.level}`);
    for (const d of dimensions) {
      const trend = Number.isFinite(d.delta) && Math.round(Math.abs(d.delta)) >= 5
        ? `（${d.delta > 0 ? '+' : ''}${Math.round(d.delta)}）`
        : (d.trendStatus ? `（${d.trendStatus}）` : '');
      lines.push(`  ${d.title}  ${d.checkLabel ?? d.score ?? '—'}${trend}  ${d.takeaway ?? d.headline}`);
      for (const e of d.evidence ?? []) lines.push(`    · ${e.label}: ${e.value}${e.hint ? ` (${e.hint})` : ''}`);
      if (d.suggestion) lines.push(`    · ${d.suggestion}`);
    }
    lines.push('');
  }
  const p = report.personality;
  if (p.profile?.character) {
    lines.push(zh ? '【性格分析】' : '[Personality observations]');
    lines.push(p.profile.character.conclusion, p.profile.character.basis);
    for (const item of p.profile.situations ?? []) {
      lines.push(`  · ${item.context}，${item.choice}（${item.source}）`);
      for (const line of item.lines) lines.push(`    ${line}`);
    }
    lines.push('');
  }
  if (p.profile?.diary?.length) {
    lines.push(zh ? '【最近的她】' : '[Her lately]');
    for (const item of p.profile.diary) lines.push(`  · ${item.title}：${item.summary}`);
    lines.push('');
  }
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
  if (dimensions.length && report.hardware.scoring?.length) {
    lines.push(zh ? '【评分细则】' : '[Scoring rules]', ...report.hardware.scoring);
    for (const d of dimensions) lines.push(`  · ${d.title}：${d.formula}`);
    lines.push('');
  }
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
  const dimensions = report.hardware?.dimensions ?? [];
  if (dimensions.length) {
    const { overall, priority, scope, next } = (report.summary?.simple ?? buildSummary(report.hardware, lang).simple);
    lines.push(zh ? '【运行近况】' : '[How things are running]');
    lines.push([overall, priority || scope].filter(Boolean).join(' '));
    if (priority && scope) lines.push(scope);
    lines.push(next);
    const stability = dimensions.find(({ id }) => id === 'stability');
    if (Number.isFinite(stability?.score)) lines.push(zh
      ? '稳定性只统计模型请求结果；这份报告没有核实失败根因，不能单凭分数归因于机器、网络或服务端。'
      : 'Stability reflects model-request outcomes only. This report does not verify root causes or attribute failures to the machine, network, or service.');
  }
  const profile = report.personality?.profile;
  if (profile) {
    lines.push(zh ? '【性格近况】' : '[Personality lately]');
    if (profile.character) {
      lines.push(profile.character.conclusion + (zh ? '。' : '.'));
      lines.push(profile.character.basis + (zh ? '。' : '.'));
    } else {
      lines.push(zh ? '关于性格，这次还需要多一点日常记录。' : 'There are too few recent observations for a personality conclusion.');
    }
    const note = profile.diary?.[0];
    if (note) lines.push(note.summary);
  }
  return lines.join('\n');
}
function fmt(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export { summarize };
