import { buildCardDetails } from './card-profile.mjs';
import { recentFacts } from './recent-fish.mjs';

const MIN_DECISIONS = 50;
const MIN_GROUP = 12;
const MIN_DAYS = 3;
const REASONS = new Set(['answer', 'ask', 'act', 'hold', 'silent']);
const count = () => ({ total: 0, replies: 0, days: new Set() });

export function profileDecisions() {
  return { all: count(), addressed: count(), unaddressed: count(), day: count(), night: count() };
}

export function observeDecision(stats, row, at, clock) {
  if (!REASONS.has(row.act)) return;
  const { day, hour } = clock(new Date(at));
  const buckets = [stats.all, hour >= 18 || hour < 6 ? stats.night : stats.day];
  if (typeof row.addressed === 'boolean' && typeof row.chat === 'string' && row.chat.startsWith('group:')) {
    buckets.push(row.addressed ? stats.addressed : stats.unaddressed);
  }
  for (const bucket of buckets) {
    bucket.total += 1;
    if (row.act === 'answer' || row.act === 'ask') bucket.replies += 1;
    bucket.days.add(day);
  }
}

export function finishDecisions(stats) {
  return Object.fromEntries(Object.entries(stats).map(([key, bucket]) => [
    key, { total: bucket.total, replies: bucket.replies, days: bucket.days.size },
  ]));
}

export function profileClock(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  });
  return (date) => {
    const parts = formatter.formatToParts(date);
    return {
      day: parts.filter(({ type }) => ['year', 'month', 'day'].includes(type)).map(({ value }) => value).join('-'),
      hour: Number(parts.find(({ type }) => type === 'hour').value),
    };
  };
}

const ready = (bucket, min) => bucket?.total >= min && bucket.days >= MIN_DAYS;
const rate = (bucket) => bucket.replies / bucket.total;
const percent = (value) => Math.round(value * 100);
const strongContrast = (a, b) => ready(a, MIN_GROUP) && ready(b, MIN_GROUP) && Math.abs(rate(a) - rate(b)) >= 0.2;

export function buildProfile(memory, language, activity, quiz) {
  const zh = language === 'zh';
  const days = memory?.profileDays ?? null;
  const stats = memory?.profileDecisions;
  const emotion = memory?.emotions;
  const entries = memory?.entries;
  const finding = (id, title, lines, summary = '', rank = 0) => ({ id, title, lines, summary, rank });
  const speech = [];
  const rhythm = [];
  let speechSummary = '';
  let speechRank = 0;
  let rhythmSummary = '';
  let rhythmRank = 0;

  if (stats?.all.total) {
    const { all, addressed, unaddressed, day, night } = stats;
    speech.push(zh ? `${all.total} 条判断里，有 ${all.replies} 次倾向接话（${percent(rate(all))}%）。`
      : `${all.replies} of ${all.total} decisions favoured replying (${percent(rate(all))}%).`);
    speech.push(zh ? '记录的是接话判断，尚未核对实际发言。' : 'These are reply decisions. Sent messages have not been verified.');
    if (ready(all, MIN_DECISIONS)) {
      if (strongContrast(addressed, unaddressed)) {
        speech.push(zh ? `群聊中，被点名时 ${addressed.replies}/${addressed.total} 次倾向接话，没被点名时是 ${unaddressed.replies}/${unaddressed.total} 次。`
          : `In groups: ${addressed.replies}/${addressed.total} when addressed and ${unaddressed.replies}/${unaddressed.total} otherwise.`);
        const addressedMore = rate(addressed) > rate(unaddressed);
        speechSummary = zh
          ? addressedMore ? '平时未必接话，在群里被叫到时更常选择回应。' : '在群里没被点名时，她反而更常选择接话。'
          : addressedMore ? 'She is more inclined to reply when addressed in a group.' : 'In groups, she is more inclined to chime in when she is not addressed.';
        speechRank = 4;
      } else {
        const value = rate(all);
        speechSummary = zh ? value <= 0.25 ? '多数判断里，她较少选择接话。'
          : value >= 0.65 ? '有互动时，她常常会选择接话。' : '她有时会选择接话，也常选择略过。'
          : value <= 0.25 ? 'Most of the time her reply decision is to stay quiet.'
          : value >= 0.65 ? 'She often chooses to reply when there is an interaction.' : 'She sometimes joins in and sometimes lets the conversation pass.';
        speechRank = 2;
      }
    }
    rhythm.push(zh ? `06:00–18:00 有 ${day.total} 条判断，其他时段有 ${night.total} 条。`
      : `There were ${day.total} decisions from 06:00 to 18:00 and ${night.total} outside those hours.`);
    if (ready(all, MIN_DECISIONS) && strongContrast(day, night)) {
      rhythm.push(zh ? `白天 ${day.replies}/${day.total} 次倾向接话，夜间与清晨 ${night.replies}/${night.total} 次。`
        : `Reply decisions: ${day.replies}/${day.total} during the day and ${night.replies}/${night.total} overnight.`);
      const overnightMore = rate(night) > rate(day);
      rhythmSummary = zh ? overnightMore ? '夜间和清晨碰到互动时，她比白天更常选择接话。' : '碰到互动时，她白天比夜间和清晨更常选择接话。'
        : overnightMore ? 'When there is an interaction, she is more inclined to reply overnight.' : 'When there is an interaction, she is more inclined to reply during the day.';
      rhythmRank = 3;
    }
  }

  const emotionLines = [];
  let emotionSummary = '';
  if (emotion?.count && Number.isFinite(emotion.arousalSd)) {
    const spread = emotion.arousalSd;
    emotionLines.push(zh ? `情绪强度有 ${emotion.count} 次采样，标准差为 ${spread.toFixed(2)}。`
      : `${emotion.count} emotion-intensity readings, with a standard deviation of ${spread.toFixed(2)}.`);
    if (emotion.count >= 15 && emotion.profileDays >= MIN_DAYS && spread <= 0.12) {
      emotionSummary = zh ? '近来的情绪强度记录，大多在相近的范围。' : 'Her recent emotion-intensity readings tend to stay close together.';
    }
  }

  const memoryLines = [];
  const base = memory?.base;
  if (base?.state === 'ready') {
    memoryLines.push(zh ? '已找到 Coo 基础记忆工作区。' : 'The Coo base memory workspace is available.');
    if (base.sampled) memoryLines.push(zh ? `基础记忆文本抽查：${base.readable}/${base.sampled} 份可读取。`
      : `Base memory text sampled: ${base.readable}/${base.sampled} readable files.`);
  }
  let memorySummary = '';
  if (entries?.profileCount > 0) {
    memoryLines.push(zh ? `新增 ${entries.profileCount} 条带日期的记忆，分布在 ${entries.profileDays} 天。`
      : `${entries.profileCount} dated memories were added across ${entries.profileDays} days.`);
    if (entries.profileCount >= 15 && entries.profileDays >= MIN_DAYS) {
      memorySummary = zh ? `这段时间，她在 ${entries.profileDays} 天留下了新的记忆。`
        : `She added new memories on ${entries.profileDays} days in this period.`;
    }
  }

  const evidence = [
    finding('speech', zh ? '开口习惯' : 'Reply habits', speech, speechSummary, speechRank),
    finding('memory', zh ? '记忆线索' : 'Memory traces', memoryLines, memorySummary, 1),
    finding('emotion', zh ? '情绪起伏' : 'Emotion readings', emotionLines, emotionSummary, 1),
    finding('rhythm', zh ? '日常节奏' : 'Daily rhythm', rhythm, rhythmSummary, rhythmRank),
  ];
  if (activity?.messages) {
    speech.unshift(zh ? `采样到 ${activity.messages} 条成功发出的对话消息，单条长度中位数 ${activity.medianLength} 字。`
      : `${activity.messages} sampled messages sent successfully, with a median length of ${activity.medianLength} characters.`);
  }
  if (activity?.opener) {
    const { word, count } = activity.opener;
    speech.push(zh ? `「${word}」作为消息开头出现 ${count} 次，跨至少两天。`
      : `“${word}” opened ${count} messages across at least two days.`);
  }
  if (entries?.profileRecalled) {
    memoryLines.push(zh ? `${entries.profileRecalled} 条较早的记忆在窗口内又有命中记录。`
      : `${entries.profileRecalled} older memories had a hit in this window.`);
  }
  const metrics = [
    {
      value: activity?.messages ? (zh ? `${activity.medianLength} 字` : `${activity.medianLength} chars`)
        : stats?.all?.total ? `${percent(rate(stats.all))}%` : null,
      formula: zh ? '发言长度取成功发送的 Coo 对话或 QQ 消息字数中位数。接话率另用影子判断里选择回应或追问的次数除以有效判断次数。'
        : 'Median length of successfully sent Coo console or QQ messages. Reply tendency is counted separately from eligible shadow decisions.',
      meaning: zh ? '一起看说了多长、何时倾向接话，能分清她是否少开口却常常说得详细。'
        : 'Length and reply tendency show different sides of how she communicates.',
    },
    {
      value: entries?.profileCount ? (zh ? `${entries.profileCount} 条` : `${entries.profileCount} entries`) : null,
      formula: zh ? '统计观察窗内有效且带日期的新增记忆。旧记忆以近期命中时间另计。'
        : 'Counts valid dated entries added in the window. Older entries revisited recently are counted separately.',
      meaning: zh ? '反映近期留下多少记忆，以及哪些旧记录重新进入了上下文。'
        : 'Shows how much new memory was retained and whether older memory returned to context.',
    },
    {
      value: emotion?.count && Number.isFinite(emotion.arousalSd) ? emotion.arousalSd.toFixed(2) : null,
      formula: zh ? '用情绪强度采样的标准差看波动大小，样本数量和分布天数一起判断。'
        : 'Uses the standard deviation of sampled emotion intensity, together with the number of samples and dates.',
      meaning: zh ? '数值较小表示记录聚得较近。也要结合采样发生在哪些天看。'
        : 'Lower values mean readings clustered closer together. Consider which dates were sampled.',
    },
    {
      value: stats?.all?.total ? (zh ? `${stats.all.total} 条` : `${stats.all.total} records`) : null,
      formula: zh ? '按设置时区分为 06:00–18:00 和其他时段，分别计算判断数和接话比例。'
        : 'Counts decisions and calculates reply tendencies in daytime and overnight in the configured timezone.',
      meaning: zh ? '分别看她遇到多少次互动机会，以及在这些机会里有多常选择接话。'
        : 'Separates the number of opportunities from how often she inclined to respond.',
    },
  ];
  evidence.forEach((item, i) => Object.assign(item, metrics[i]));
  if (activity?.plugin) {
    const { name, count } = activity.plugin;
    evidence.push(finding('play', zh ? '探索活动' : 'Leisure activity', [
      zh ? `${name[0]}：采样到 ${count} 次成功调用。` : `${name[1]}: ${count} sampled successful calls.`,
    ]));
    Object.assign(evidence.at(-1), {
      value: zh ? `${count} 次` : `${count} calls`,
      formula: zh ? '从近期运行的主会话采样工具记录，按娱乐插件汇总成功调用。'
        : 'Samples recent main-session tool logs and groups successful calls by leisure plugin.',
      meaning: zh ? '表示她最近常去哪里活动。' : 'Shows where recent activity was concentrated.',
    });
  }
  const observations = evidence.filter(({ summary }) => summary).sort((a, b) => b.rank - a.rank);
  const facts = recentFacts(memory, activity, language);
  const eligible = [...facts, ...observations.filter(({ id }) => id !== 'memory')];
  const recent = [];
  const themes = new Set();
  const icons = new Set();
  for (const candidate of eligible) {
    if (recent.length === 3) break;
    const icon = candidate.icon ?? candidate.id;
    if (icons.has(icon) || (candidate.theme && themes.has(candidate.theme))) continue;
    recent.push(candidate);
    icons.add(icon);
    if (candidate.theme) themes.add(candidate.theme);
  }
  // 主题线索稀薄时先用已证实的行为特征；再考虑同话题的不同证据。
  if (recent.length < 3) {
    for (const candidate of eligible) {
      const icon = candidate.icon ?? candidate.id;
      if (recent.length === 3) break;
      if (icons.has(icon)) continue;
      recent.push(candidate);
      icons.add(icon);
    }
  }
  const emptyRows = [
    ['speech', zh ? '说话方式' : 'How she speaks'],
    ['memory', zh ? '记忆线索' : 'Memory traces'],
    ['play', zh ? '去哪里玩' : 'Where she plays'],
    ['rhythm', zh ? '日常节奏' : 'Daily rhythm'],
    ['emotion', zh ? '情绪起伏' : 'Emotion readings'],
  ];
  const used = new Set(recent.map((item) => item.icon ?? item.id));
  for (const [icon, title] of emptyRows) {
    if (recent.length === 3) break;
    if (used.has(icon)) continue;
    recent.push({ id: `missing-${icon}`, title, icon, empty: true,
      summary: zh ? '这段时间的记录还不够。' : 'Not enough records in this period.' });
  }
  const main = observations[0]?.summary ?? facts[0]?.summary;
  const additional = observations.find((item) => item.id !== observations[0]?.id)?.summary
    ?? facts.find(({ summary }) => summary !== main)?.summary;
  const title = zh ? '再等几个泡泡，就能多认识她一点。'
    : main && additional ? `${main.replace(/\.$/u, '')}, and ${additional[0].toLowerCase()}${additional.slice(1)}`
      : main ?? 'There are too few recent records to describe her habits.';
  const card = buildCardDetails({ stats, activity, emotion, entries, recent, quiz, language });
  const profile = { days, evidence, recent, title, ...card };
  const rows = recent.filter((row) => !row.empty).map(({ id, summary }) => [id, summary]);
  return { ...profile, copyKey: JSON.stringify([rows, profile.title, profile.label, profile.description, card.candidates]) };
}

export function readProfileCopy(text, ids, candidates) {
  try {
    const parsed = JSON.parse(text);
    const valid = (line, max) => typeof line === 'string' && line.trim().length > 0
      && line.length <= max && !/[\r\n<>]/u.test(line);
    if (!valid(parsed.title, 90) || /[\d%％]/u.test(parsed.title) || !parsed.recent || typeof parsed.recent !== 'object'
      || Object.keys(parsed.recent).length !== ids.length
      || !ids.every((id) => Object.hasOwn(parsed.recent, id) && valid(parsed.recent[id], 120))) return null;
    const copy = { title: parsed.title.trim(), recent: Object.fromEntries(ids.map((id) => [id, parsed.recent[id].trim()])) };
    if (!candidates) return copy;
    if (!valid(parsed.label, 35) || !valid(parsed.description, 200) || !Array.isArray(parsed.tags)
      || parsed.tags.length < 3 || parsed.tags.length > 4 || new Set(parsed.tags).size !== parsed.tags.length
      || !parsed.tags.every((tag) => candidates.includes(tag))) return null;
    return { ...copy, label: parsed.label.trim(), description: parsed.description.trim(), tags: parsed.tags };
  } catch {
    return null;
  }
}
