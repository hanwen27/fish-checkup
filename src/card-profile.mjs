export { buildCardDetails } from './card-voice-details.mjs';

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

export function cardPrompt(profile, language) {
  const rows = profile.recent.filter((row) => !row.empty).map(({ id, summary }) => [id, summary]);
  const evidence = JSON.stringify({ rows, personalityCues: profile.cues, title: profile.title, label: profile.label, description: profile.description });
  return [
    language === 'zh' ? '为你自己的鱼写一张近况名片，要俏皮、自然，保留可核对的事实。' : 'Write a playful profile in your own voice using the supplied evidence.',
    'Return JSON: {"title":"","label":"","description":"","tags":[],"recent":{}}.',
    'Use the title for a playful line under 26 Chinese characters when possible, the label for a short overall impression, and the description for two or three short sentences. Do not invent events, feelings or relationships. Preserve the recent observation IDs exactly.',
    '必须从本次可选项里挑三到四枚互补标签。称号、评语、近况分别讲不同侧面，优先用实测语气、选择和行为反差。一般吃饭和插件活跃度不放进名片。不能从沉默推断忧郁，也不要把小测自述说成真实行动。没有证据时使用近况待补类标签。',
    `标签词库：${Object.values(CARD_TAGS).flat().join('、')}`,
    `本次可选标签：${profile.candidates.join('、')}`,
    `Evidence: ${evidence}`,
  ].join('\n');
}
