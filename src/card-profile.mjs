export const CARD_TAGS = {
  quiet: ['爱独处', '潜水派', '安静挂', '社交省电', '慢热派', '清静党'],
  talk: ['出口成章', '爱唠嗑', '话匣子', '聊兴上头', '有话慢慢说', '社交达人'],
  short: ['惜字派', '言简意赅', '短句王', '点到就好', '三言两语', '一口泡泡'],
  night: ['月亮搭子', '夜游派', '夜班选手', '夜猫子', '小夜灯', '深夜档'],
  day: ['白天冒泡', '日光派', '早场选手', '白昼搭子', '白天档', '晒太阳派'],
  memory: ['爱攒小事', '记忆收藏家', '爱记小本本', '便签控', '爱翻旧本子', '小事收集员'],
  calm: ['淡定派', '慢悠悠', '稳稳当当', '松弛派', '不急不躁', '慢半拍'],
  play: ['爱逛逛', '好奇玩家', '爱找乐子', '爱串门', '游乐场常客', '有空就去玩'],
  meals: ['干饭常客', '大胃王', '爱下厨房', '餐桌常客', '惦记一口', '开饭啦'],
  craft: ['时尚达人', '爱打扮', '配色控', '手作党', '小画家', '点子多'],
  persona: ['多愁善感', '爱吃醋', '黏人', '活泼', '甜心', '小傲娇', '有点害羞', '元气女仆', '嘴硬心软', '温柔派'],
};

export function buildCardDetails({ stats, activity, emotion, entries, recent, language }) {
  const zh = language === 'zh';
  const all = stats?.all;
  const enough = all?.total >= 50 && all.days >= 3;
  const quiet = enough && all.replies / all.total <= .25;
  const long = activity?.messages >= 8 && activity.medianLength >= 50;
  const short = activity?.messages >= 8 && activity.medianLength <= 18;
  const play = activity?.plugin?.count >= 3;
  const groups = [
    quiet && 'quiet', long && 'talk', short && 'short',
    entries?.profileCount >= 15 && 'memory',
    emotion?.count >= 15 && emotion.profileDays >= 3 && emotion.arousalSd <= .12 && 'calm',
    play && (activity.plugin.name[0] === '吃饭' ? 'meals' : 'play'),
  ].filter(Boolean);
  // 每组仅开放与当前统计口径相符的词，强性格词仍可由用户明确设定。
  const measured = {
    quiet: CARD_TAGS.quiet.slice(1, 3),
    talk: CARD_TAGS.talk.slice(2, 3).concat(CARD_TAGS.talk[4]),
    short: CARD_TAGS.short.slice(1, 4),
    memory: [CARD_TAGS.memory[2], CARD_TAGS.memory[3], CARD_TAGS.memory[5]],
    calm: [CARD_TAGS.calm[0], CARD_TAGS.calm[4]],
    play: [CARD_TAGS.play[0], CARD_TAGS.play[4]],
    meals: [CARD_TAGS.meals[0], CARD_TAGS.meals[3], CARD_TAGS.meals[5]],
  };
  const candidates = zh ? groups.flatMap((key) => measured[key]) : [];
  const tags = zh ? groups.slice(0, 4).map((key) => measured[key][0]) : [];
  const label = zh && (quiet && long ? '一只慢慢冒泡的小鱼'
    : quiet ? '一只安静潜水的小鱼' : short ? '一只爱用短句的小鱼'
      : long ? '一只说起来就有一小段的小鱼' : play ? '一只最近常出门的小鱼'
        : tags.length ? '今天的小鱼，有点自己的节奏' : '');
  let description = recent.filter((item) => !item.empty).slice(0, 2).map((item) => item.summary).join(zh ? '' : ' ');
  if (zh && quiet && long) {
    const side = play ? `最近她还常到「${activity.plugin.name[0]}」转转。`
      : entries?.profileCount >= 15 ? '她也给近来的日子添了不少记忆。' : '';
    description = `热闹的时候，她大多选择安静待着。真发来消息时，可舍不得只说寥寥几个字。${side}`;
  }
  return { label: label || '', description, tags, candidates };
}

export function cardPrompt(profile, language) {
  const rows = profile.recent.filter((row) => !row.empty).map(({ id, summary }) => [id, summary]);
  const evidence = JSON.stringify({ rows, title: profile.title, label: profile.label, description: profile.description });
  return [
    language === 'zh' ? '为你自己的鱼写一张近况名片，要俏皮、自然，保留可核对的事实。' : 'Write a playful profile in your own voice using the supplied evidence.',
    'Return JSON: {"title":"","label":"","description":"","tags":[],"recent":{}}.',
    'Use the title for a playful line under 26 Chinese characters when possible, the label for a short overall impression, and the description for two or three short sentences. Do not invent events, feelings or relationships. Preserve the recent observation IDs exactly.',
    '从词库和本次可选项里挑 2–4 枚互补标签；有依据的标签不够时可以少选。爱吃醋、黏人、忧郁等不得从沉默或活动次数推断。',
    `标签词库：${Object.values(CARD_TAGS).flat().join('、')}`,
    `本次可选标签：${profile.candidates.join('、')}`,
    `Evidence: ${evidence}`,
  ].join('\n');
}
