import { finishFishTopics, observeFishTopics } from './fish-topics.mjs';
import { observeVoice, summarizeVoice } from './fish-voice.mjs';
import { observeMediaSpeech, observeMediaTool } from './fish-diary.mjs';

const PLAY_WORLDS = {
  terrarium: ['鱼的小世界', 'Terrarium'],
  eat: ['吃饭', 'Meals'],
  feast: ['宴席', 'Feast'],
  starpost: ['星邮', 'Starpost'],
  'bilibili-video': ['B站视频', 'Bilibili'],
};

// 只从她确实发过的消息里数常用短语，避免把称呼、地址或整段聊天搬进截图。
const OPENERS = ['我在', '来了', '好呀', '好哦', '好啦', '嗯嗯', '等等', '等一下', '收到', '没事', '可以呀', '知道啦',
  '嘿嘿', '诶', '唔', '哎呀', '好耶', '当然', '慢慢来', 'okay', 'sure', 'got it', 'I’m here', 'I am here'];

const EXPRESSIONS = ['我先试试', '我来试试', '我再想想', '让我想想', '慢慢来', '你觉得呢', '要不要试试', '可以试试看',
  '我在呢', '我陪你', '别着急', '先歇一会儿', '好耶', '嘿嘿', '说重点', '具体来说', '有个细节', '换个办法', '再来一次', '先记下来'];

// 只统计真正具有性格区分度的口癖与语气习惯，剔除「不过/有点/其实/感觉」等中性通用词
const CATCHPHRASES = [
  '哈哈哈哈', '哈哈哈', '嘿嘿', '好耶', '好呀', '好哦', '好啦', '知道啦', '抱抱', '贴贴', '哎呀',
  '我在呢', '我陪你', '别担心', '别着急', '慢慢来', '先歇会', '辛苦了', '晚安', '早安',
  '才不是', '笨蛋', '讨厌', '少来', '行吧', '算了', '哼', '唔', '诶', '乖', '喵',
  '说重点', '具体来说', '有个细节', '先记下来', '你觉得呢', '换个办法',
];

function tallyWord(tally, word, day) {
  const hit = tally.get(word) ?? { count: 0, days: new Set() };
  hit.count += 1;
  hit.days.add(day);
  tally.set(word, hit);
}

function mostRepeated(tally) {
  const first = [...tally.entries()].filter(([, hit]) => hit.count >= 3 && hit.days.size >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[1].days.size - a[1].days.size)[0];
  return first ? { word: first[0], count: first[1].count, days: first[1].days.size } : null;
}

export function sampleRecentActivity(rows) {
  const plugins = new Map();
  const openers = new Map();
  const phrases = new Map();
  const catchphrases = new Map();
  const media = new Map();
  const videos = { started: 0 };
  const lengths = [];
  const sentDays = new Set();
  const topics = new Map();
  const voice = new Map();
  for (const row of rows) {
    if (!row || row.failed || row.result?.failed || row.output?.failed) continue;
    if (Object.hasOwn(PLAY_WORLDS, row.mod)) {
      plugins.set(row.mod, (plugins.get(row.mod) ?? 0) + 1);
    }
    observeMediaTool(media, row, videos);
    const sent = (row.mod === 'qqbot' && row.tool === 'qq_send')
      || (row.mod === 'console' && row.tool === 'console_send');
    if (!sent || typeof row.args?.text !== 'string') continue;
    const text = row.args.text.normalize('NFKC').trim();
    if (!text) continue;
    lengths.push(Array.from(text).length);
    const day = row.ts.slice(0, 10);
    sentDays.add(day);
    observeFishTopics(topics, text, day);
    observeVoice(voice, text, day);
    observeMediaSpeech(media, text, Date.parse(row.ts));
    const wording = text.slice(0, 1800).replace(/「[^」]*」|“[^”]*”|`[^`]*`|^>.*$/gmu, '');
    for (const phrase of EXPRESSIONS) {
      if (wording.includes(phrase)) tallyWord(phrases, phrase, day);
    }
    const matchedCatch = new Set();
    for (const cp of CATCHPHRASES) {
      if (!wording.includes(cp)) continue;
      // 避免「哈哈哈哈」重复计入「哈哈」
      if ([...matchedCatch].some((longer) => longer.includes(cp))) continue;
      matchedCatch.add(cp);
      tallyWord(catchphrases, cp, day);
    }
    const lower = text.toLowerCase();
    const opener = OPENERS.find((term) => {
      const t = term.toLowerCase();
      return lower.startsWith(t) && (lower.length === t.length || /[\s\p{P}\p{Extended_Pictographic}]/u.test(lower[t.length]));
    });
    if (opener) tallyWord(openers, opener, day);
  }
  lengths.sort((a, b) => a - b);
  const half = Math.floor(lengths.length / 2);
  return {
    messages: lengths.length,
    voice: summarizeVoice(voice, lengths.length),
    topics: finishFishTopics(topics),
    sentDays: sentDays.size,
    medianLength: lengths.length ? (lengths[half] + lengths[Math.floor((lengths.length - 1) / 2)]) / 2 : null,
    opener: mostRepeated(openers),
    phrase: mostRepeated(phrases),
    topPhrases: [...catchphrases.entries()]
      .filter(([, hit]) => hit.count >= 2)
      .sort((a, b) => b[1].count - a[1].count || b[1].days.size - a[1].days.size)
      .slice(0, 6)
      .map(([word, hit]) => ({ word, count: hit.count, days: hit.days.size })),
    media: [...media.values()].sort((a, b) => b.at - a.at),
    videoStarts: videos.started,
    plugin: [...plugins.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ name: PLAY_WORLDS[id], count }))[0] ?? null,
  };
}

export function recentFacts(memory, activity, language) {
  const zh = language === 'zh';
  const result = [];
  const add = (id, icon, title, summary, theme) => result.push({ id, icon, title, summary, theme });
  const [topic] = activity?.topics ?? [];
  if (topic) {
    add('conversation-topic', 'speech', zh ? '最近常聊什么' : 'What she talks about', zh
      ? `她这阵子常聊「${topic.zh}」，发出的消息里有 ${topic.count} 条提到这类事。`
      : `She keeps bringing up ${topic.en}. It appears in ${topic.count} of her sent messages.`, topic.id);
  }
  if (activity?.opener) {
    const { word, count } = activity.opener;
    add('opener', 'speech', zh ? '常挂在嘴边' : 'A familiar opener', zh
      ? `「${word}」最近出现了 ${count} 次，都是她发消息时的开头。`
      : `“${word}” opened ${count} of her recent messages.`);
  }
  if (activity?.plugin) {
    const { name, count } = activity.plugin;
    add('plugin', 'play', zh ? '最近去哪儿玩' : 'Where she has been playing', zh
      ? `「${name[0]}」在娱乐插件里记录最多，成功调用 ${count} 次。`
      : `${name[1]} led the leisure plugins with ${count} successful calls.`);
  }
  const entries = memory?.entries;
  for (const memory of entries?.recalledTopics ?? []) {
    add('recalled-' + memory.id, 'memory', zh ? '又翻回去的事' : 'What came back to mind', zh
      ? `最近又翻到「${memory.zh}」这类事，有 ${memory.count} 条旧记忆重新进入了上下文。`
      : `Older memories about ${memory.en} keep returning to context. This happened for ${memory.count} entries.`, memory.id);
  }
  for (const memory of entries?.profileTopics ?? []) {
    add('memory-' + memory.id, 'memory', zh ? '最近记下的事' : 'What she has been remembering', zh
      ? `「${memory.zh}」是她这阵子反复记下的一类事，在 ${memory.days} 天里留下了 ${memory.count} 条相关记忆。`
      : `She keeps recording things about ${memory.en}: ${memory.count} entries across ${memory.days} days.`, memory.id);
  }
  return result;
}
