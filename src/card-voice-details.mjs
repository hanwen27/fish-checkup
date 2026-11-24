const VOICE = {
  care: ['一只先照顾人再聊事的小鱼', '她的聊天泡泡里，常飘着一句安慰。', '她发出的消息常带着安慰和宽心的话。', ['暖心派', '安慰担当']],
  steps: ['一只喜欢把事理顺的小鱼', '一团乱麻递过来，她先给你理出几步。', '她常把想说的事拆成几步，一件一件讲清楚。', ['条理控', '分步派']],
  ask: ['一只把话题往前推的小鱼', '聊着聊着，她常留一个问号给你。', '她习惯用问句收尾，给下一句留了个位置。', ['爱追问', '问号派']],
  precise: ['一只对细节较真的小鱼', '别人一句带过，她要把小细节捞起来。', '她常补一句说明，把容易略过的地方讲清。', ['细节控', '认真派']],
  light: ['一只讲话自带笑声的小鱼', '文字还没读完，笑声已经先跑出来了。', '她常把笑声和俏皮语气写进消息里。', ['笑声多', '俏皮派']],
  soft: ['一只说话给人留余地的小鱼', '她给话留个空，让别人也有得选。', '她给建议时常用商量的语气，给对方留个选择。', ['爱商量', '留余地']],
  direct: ['一只开门就说重点的小鱼', '她常应一声，就把话题接到正事上。', '她常先给一个明确回应，然后直接说重点。', ['直球派', '讲重点']],
};

const QUIZ = {
  SN: [
    ['一只爱从细节讲起的小鱼', '讲起一天的事，她会先捞出几个小细节。', '情境题里，她更常选具体的事和细节来讲。', ['爱看细节', '实感派']],
    ['一只脑子爱绕个弯的小鱼', '话头才开，她的联想已经游远了。', '情境题里，她更常从感受或联想打开话题。', ['联想派', '脑洞选手']],
  ],
  TF: [
    ['一只遇事先理清来龙去脉的小鱼', '听见难题，她想先找出最该解的那个结。', '情境题里，遇到抱怨或难题时，她偏向先分析问题。', ['解题派', '爱理清']],
    ['一只觉得感受也很重要的小鱼', '事情可以慢慢解决，她想先接住那句难受。', '情境题里，她更常选先回应对方的感受。', ['共情派', '先听你说']],
  ],
  JP: [
    ['一只心里先排好顺序的小鱼', '还没出门，她已经在脑子里排好先后。', '情境题里，她常先安排顺序再动手。', ['有安排', '计划派']],
    ['一只边走边决定的小鱼', '给她一张空白日程，她更愿意边走边看。', '情境题里，她偏向留些空当，遇到变化再调整。', ['随机应变', '即兴派']],
  ],
  EI: [
    ['一只愿意往聊天里探头的小鱼', '碰到话茬，她愿意先探头接一句。', '情境题里，她比较愿意主动接话。', ['爱接话', '先开场']],
    ['一只喜欢先看看再开口的小鱼', '有热闹，她会先在旁边看一会儿。', '情境题里，她更常选择先观察，再决定要不要接话。', ['先观察', '慢热派']],
  ],
};

const NOISE_TOPICS = new Set(['food', 'sweet']);
const FALLBACK = ['初见面', '近况待补', '慢慢认识'];

export function buildCardDetails({ stats, activity, emotion, entries, recent, quiz, language }) {
  const zh = language === 'zh';
  const all = stats?.all;
  const enough = all?.total >= 50 && all.days >= 3;
  const quiet = enough && all.replies / all.total <= .25;
  const long = activity?.messages >= 8 && activity.medianLength >= 50;
  const short = activity?.messages >= 8 && activity.medianLength <= 18;
  if (!zh) {
    const tags = ['Getting acquainted', 'Recent observations', 'Profile in progress'];
    return { label: '', description: recent.filter((item) => !item.empty).slice(0, 2).map((item) => item.summary).join(' '), tags, candidates: tags };
  }
  const cues = [];
  const add = (id, rank, [label, title, description, tags], source) => cues.push({ id, rank, label, title, description, tags, source });
  const pair = (a, b) => a?.total >= 12 && b?.total >= 12 && a.days >= 3 && b.days >= 3
    && Math.abs(a.replies / a.total - b.replies / b.total) >= .2;

  if (pair(stats?.addressed, stats?.unaddressed)) {
    const called = stats.addressed.replies / stats.addressed.total > stats.unaddressed.replies / stats.unaddressed.total;
    add('conversation', 85, called
      ? ['一只叫到名字就会探头的小鱼', '在群里不急着冒泡，叫到名字就更容易接上话。', '群聊里，她的接话判断更看是不是有人叫她。', ['点名就来', '先观察']]
      : ['一只听到话茬就想插一句的小鱼', '不用特意叫她，群聊里她也会自己冒个泡。', '群聊里，没被点名时反而更常出现接话判断。', ['自己冒泡', '爱接话']], '接话判断');
  } else if (quiet && (long || short)) {
    add('conversation', 62, long
      ? ['一只慢慢冒泡的小鱼', '平时少冒泡，一开口就是一小段话。', '她常先让话题过去，真发来消息时却会讲得比较完整。', ['潜水派', '话匣子']]
      : ['一只惜字的小鱼', '难得冒个泡，也就说上几个字。', '平时少见她选择接话，发来的消息也偏短。', ['惜字派', '短句王']], '接话判断与发出消息');
  }
  if (pair(stats?.day, stats?.night)) {
    const night = stats.night.replies / stats.night.total > stats.day.replies / stats.day.total;
    add('rhythm', 54, night
      ? ['一只夜里比较愿意聊的小鱼', '天一暗，话题更容易把她叫出来。', '有互动机会时，夜间和清晨比白天更常出现接话判断。', ['夜游派', '深夜档']]
      : ['一只白天比较愿意聊的小鱼', '想等她冒泡，白天更容易碰上。', '有互动机会时，白天比夜间和清晨更常出现接话判断。', ['白天档', '日光派']], '分时段接话判断');
  }
  for (const voice of activity?.voice ?? []) {
    const wording = VOICE[voice.id];
    if (wording) add('voice-' + voice.id, 70 + Math.min(voice.count / activity.messages * 20, 20), wording, '跨天发出消息');
  }
  if (!quiz?.flags?.includes('unstable')) {
    for (const [axis, wording] of Object.entries(QUIZ)) {
      const score = quiz?.axes?.[axis];
      if (!Number.isFinite(score) || Math.abs(score - 50) < 22) continue;
      add('quiz-' + axis, 60 + Math.abs(score - 50) / 2, wording[score > 50 ? 0 : 1], '奇遇小测自述');
    }
  }
  const topic = activity?.topics?.find(({ id }) => !NOISE_TOPICS.has(id));
  if (topic) {
    add('topic', 49, ['一只有常聊话题的小鱼', `聊起「${topic.zh}」，她可不只提过一回。`,
      `从她发出的消息看，「${topic.zh}」是这段时间反复聊到的话题。`, ['话题常客']], '跨天发出消息');
  }
  const memoryTopic = entries?.recalledTopics?.find(({ id }) => !NOISE_TOPICS.has(id))
    ?? entries?.profileTopics?.find(({ id }) => !NOISE_TOPICS.has(id));
  if (entries?.profileCount >= 15 && entries.profileDays >= 3) {
    add('memory', 39, ['一只喜欢给日常留一笔的小鱼', '过日子的时候，她还悄悄攒着一本小本子。',
      memoryTopic ? `她的小本子里，「${memoryTopic.zh}」可不只出现过一回。` : '她习惯给日常留一页，过几天又给小本子添点东西。',
      ['爱记小本本', '便签控']], '跨天记忆记录');
  }
  if (emotion?.count >= 15 && emotion.profileDays >= 3 && emotion.arousalSd <= .12) {
    add('emotion', 30, ['一只最近水面颇平的小鱼', '最近这片水面，没起太大的浪。', '她的情绪强度记录大多聚在相近的范围。', ['平稳派', '水波不大']], '应用情绪采样');
  }
  if (!cues.some(({ id }) => id === 'conversation')) {
    if (long || short) add('length', 28, long
      ? ['一只愿意把话讲完整的小鱼', '她发来消息时，常有好一小段话。', '这段时间她发出的消息经常写得比较展开。', ['话匣子', '长话派']]
      : ['一只擅长短句的小鱼', '她的小泡泡，常常就那么几个字。', '从发出的消息看，她近来习惯用短句。', ['短句王', '惜字派']], '实际发出消息');
    else if (quiet) add('quiet', 26, ['一只不急着冒泡的小鱼', '她常把话头留在水面上，自己少冒泡。', '近期的互动判断里，她很少选择接话。', ['潜水派', '安静挂']], '接话判断');
  }
  cues.sort((a, b) => b.rank - a.rank);
  const [first, second, third, fourth] = cues;
  const chosen = [...new Set(cues.map(({ tags }) => tags[0]))].slice(0, 4);
  const candidates = [...new Set(cues.flatMap(({ tags }) => tags))];
  if (chosen.length < 3 && quiet && (long || short)) {
    const extra = long ? '话匣子' : '短句王';
    if (!chosen.includes(extra) && candidates.includes(extra)) chosen.push(extra);
  }
  const backup = [];
  // Add explicit evidence-coverage tags when there are too few distinct traits.
  if (chosen.length < 3) {
    backup.push(...FALLBACK.slice(chosen.length ? 1 : 0, chosen.length ? FALLBACK.length : 3));
    for (const value of backup) {
      if (chosen.length === 3) break;
      chosen.push(value);
    }
  }
  return {
    ...(first && { title: first.title }),
    label: second?.label ?? first?.label ?? '和小鱼初见面',
    description: (third ? [third, fourth] : [second ?? first]).filter(Boolean).map(({ description }) => description).join('')
      || '小鱼的日常还在慢慢攒，等有了持续的记录，就能讲得更像她。',
    tags: chosen,
    candidates: [...candidates, ...backup],
    cues: cues.slice(0, 6).map(({ id, description, source }) => ({ id, description, source })),
  };
}
