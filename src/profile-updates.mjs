const SITUATIONS = {
  '安慰担当': ['tender-whale', '同伴提到难处', '常先安慰对方', 'Someone is having a hard time', 'Often offers reassurance first'],
  '暖心派': ['tender-whale', '同伴提到难处', '常先安慰对方', 'Someone is having a hard time', 'Often offers reassurance first'],
  '条理控': ['methodical-train', '有件事需要说明', '习惯拆成几步讲', 'Something needs explaining', 'Breaks it down into steps'],
  '爱追问': ['curious-shell', '话题还有下文', '常用问句接下去', 'The conversation could continue', 'Often follows up with a question'],
  '细节控': ['careful-brush', '说到容易略过的地方', '会顺手补个细节', 'A detail might be overlooked', 'Adds a clarifying detail'],
  '笑声多': ['playful-puppet', '平常聊天的时候', '文字里常带一点笑意', 'Everyday chat', 'Often writes playfully'],
  '爱商量': ['tender-whale', '给建议的时候', '语气里常留个选择', 'Offering advice', 'Leaves room for a choice'],
  '直球派': ['direct-bell', '话题接上以后', '通常很快说到重点', 'Once the conversation starts', 'Gets to the point quickly'],
  '爱看细节': ['careful-brush', '讲起一天的事', '更爱从具体细节讲起', 'Telling a story about her day', 'Prefers starting with details'],
  '联想派': ['playful-puppet', '讲起一天的事', '更爱顺着感受和联想讲', 'Telling a story about her day', 'Prefers following associations'],
  '解题派': ['xiyin-map', '遇到抱怨或难题', '倾向先找问题出在哪', 'A complaint or a difficult problem', 'Tends to look for what went wrong first'],
  '共情派': ['protective-street', '遇到抱怨或难题', '倾向先回应对方的感受', 'A complaint or a difficult problem', 'Tends to acknowledge feelings first'],
  '有安排': ['mianmian-notebook', '计划还没开始', '习惯先排一下顺序', 'Before a plan starts', 'Likes to order the steps first'],
  '随机应变': ['improvise-sail', '计划遇到变动', '倾向边做边调整', 'When a plan changes', 'Prefers adjusting as she goes'],
  '爱接话': ['social-lantern', '群聊刚有话头', '更愿意主动接一句', 'When a group conversation starts', 'More inclined to join in'],
  '先观察': ['focused-book', '群聊刚热闹起来', '倾向先听听再决定', 'When group chat gets lively', 'Prefers listening before joining in'],
  '点名就来': ['patient-pearl', '群聊里有人叫到她', '这时候更常选择回应', 'When directly addressed in a group', 'More inclined to reply'],
  '自己冒泡': ['bold-stage', '群聊里没人特意叫她', '她也常选择接话', 'When nobody addresses her in a group', 'Still inclined to chime in'],
  '话题常客': ['focused-book', '碰上最近关心的事', '会隔几天接着聊', 'A subject she has been interested in', 'Returns to it on different days'],
  '爱记小本本': ['sentimental-attic', '给日常留个记录', '会在不同日子给小本子添一笔', 'Keeping a record of daily life', 'Writes new entries across different days'],
  '夜游派': ['focused-book', '夜里遇到互动机会', '她比白天更常选择接话', 'An opportunity to chat at night', 'More inclined to reply than in daytime'],
  '白天档': ['social-lantern', '白天遇到互动机会', '她比夜间更常选择接话', 'An opportunity to chat in daytime', 'More inclined to reply than at night'],
  '潜水派': ['patient-pearl', '热闹时遇到话头', '多数判断里倾向安静待着', 'An opening in a lively chat', 'Often chooses to stay quiet'],
  '惜字派': ['direct-bell', '少数时候主动开口', '发来的话通常也很短', 'When she does speak', 'Usually keeps it short'],
  '话匣子': ['focused-book', '真的发来消息时', '常把话说得比较完整', 'When she sends a message', 'Often gives a fuller explanation'],
  '短句王': ['direct-bell', '真的发来消息时', '近来更常用短句', 'When she sends a message', 'Recently tends to write short messages'],
};

const SOURCES = {
  '奇遇小测自述': 'Quiz answers',
  '跨天发出消息': 'Sent messages across multiple days',
  '接话判断': 'Reply decisions',
  '接话判断与发出消息': 'Reply decisions and sent messages',
  '分时段接话判断': 'Reply decisions by time of day',
  '跨天记忆记录': 'Memory entries across multiple days',
  '实际发出消息': 'Sent messages',
};

export function profileSituations(cues, language, evidence, activity, quiz) {
  const zh = language === 'zh';
  const supported = cues.filter(({ trait }) => SITUATIONS[trait]);
  const situations = supported.slice(0, 3).map((cue) => {
    const [, context, choice, enContext, enChoice] = SITUATIONS[cue.trait];
    const metric = cue.id === 'rhythm' ? 'rhythm' : cue.id === 'memory' ? 'memory' : 'speech';
    const lines = cue.id.startsWith('quiz-') ? [] : evidence.find(({ id }) => id === metric)?.lines ?? [];
    const observation = activity?.voice?.find(({ id }) => cue.id === 'voice-' + id);
    const answered = quiz?.counts?.[cue.id.slice(5)];
    const confirmed = observation
      ? [zh ? `相应表达出现在 ${observation.count} 条发出消息中，分布在 ${observation.days} 天。`
        : `This expression appeared in ${observation.count} sent messages across ${observation.days} days.`]
      : cue.id.startsWith('quiz-') && Number.isInteger(answered) && answered > 0
        ? [zh ? `这类情境共采到了 ${answered} 个有效回答。` : `${answered} valid answers covered these situations.`]
        : lines.slice(0, 2);
    return { id: cue.id, context: zh ? context : enContext, choice: zh ? choice : enChoice,
      source: zh ? cue.source : SOURCES[cue.source],
      lines: [...new Set([zh ? cue.description : enChoice, ...confirmed])] };
  });
  const traits = new Set(supported.map(({ trait }) => trait));
  const first = supported[0]?.trait;
  let scene = SITUATIONS[first]?.[0] ?? null;
  // Combinations let the illustration follow the strongest supported trait and a second cue.
  if (first === '随机应变' && traits.has('直球派')) scene = 'nimble-bakery';
  if (first === '随机应变' && traits.has('联想派')) scene = 'independent-cave';
  if (first === '解题派' && traits.has('爱追问')) scene = 'determined-kite';
  if (first === '有安排' && traits.has('暖心派')) scene = 'earnest-greenhouse';
  if (first === '直球派' && traits.has('爱商量')) scene = 'principled-shell';
  if (first === '爱商量' && traits.has('暖心派')) scene = 'mianmian-notebook';
  return { situations, scene };
}

export function collectProfileSignals(activity, entries) {
  const distinctive = ({ id, days }) => days >= 3 && id !== 'food' && id !== 'sweet';
  const sent = activity?.topics?.find(distinctive);
  const remembered = entries?.profileTopics?.find(distinctive);
  const voice = activity?.voice?.find(({ days }) => days >= 3);
  const signal = (kind, topic) => ({ kind, key: topic.id, label: [topic.zh, topic.en] });
  const signals = [];
  if (sent) signals.push(signal('conversation', sent));
  if (remembered) signals.push(signal('memory', remembered));
  if (voice) {
    const labels = {
      care: ['常说安慰的话', 'often reassuring'], steps: ['喜欢分几步讲', 'explaining in steps'],
      ask: ['常用问句继续聊', 'asking follow-up questions'], precise: ['会补充细节', 'adding precise details'],
      light: ['语气里常带笑意', 'using a playful tone'], soft: ['爱用商量的语气', 'leaving room for suggestions'],
      direct: ['开口容易切到重点', 'getting to the point'],
    };
    if (labels[voice.id]) signals.push({ kind: 'voice', key: voice.id, label: labels[voice.id] });
  }
  return signals;
}

export function compareProfileSignals(previous, current, language) {
  if (!Array.isArray(previous?.signals)) return null;
  const zh = language === 'zh';
  const categories = {
    conversation: ['聊天里的关注点', 'Conversation topics'],
    memory: ['反复记下的事', 'Recurring memories'],
    voice: ['开口方式', 'Speaking style'],
  };
  const discoveries = [];
  for (const signal of current) {
    const earlier = previous.signals.find((record) => record?.kind === signal.kind);
    if (earlier?.key === signal.key) continue;
    const label = signal.label[zh ? 0 : 1];
    const before = earlier?.label?.[zh ? 0 : 1];
    discoveries.push({
      title: categories[signal.kind][zh ? 0 : 1],
      now: label,
      before: before ?? (zh ? '上次还没有持续出现的线索' : 'No recurring signal at the previous visit'),
      observedAt: previous.observedAt,
    });
  }
  const [first, ...others] = discoveries;
  return first ? { ...first, ...(others.length ? { others } : {}) } : null;
}
