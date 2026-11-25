const SPEECH_MEDIA = [
  ['video', /^我(?:最近|刚刚|刚|之前|这几天|已经)?(?:看过|看完|看了|追完)(?:了)?(?:一个|一部|一期)?(?:视频|纪录片|电影|番剧|动画)?\s*《([^》\r\n]+)》/u],
  ['game', /^我(?:最近|刚刚|刚|之前|这几天|已经)?(?:玩过|玩了|打过|打了|通关了)(?:一会儿)?(?:游戏)?\s*《([^》\r\n]+)》/u],
];
const VOICE_WORDS = {
  care: ['用安慰的说法', 'used reassuring wording'],
  steps: ['分成几步讲', 'explained in steps'],
  ask: ['用问句接下去', 'ended with a follow-up question'],
  precise: ['主动补充细节', 'added a clarifying detail'],
  light: ['带笑声或俏皮语气', 'used laughter or playful phrasing'],
  soft: ['用商量的口吻', 'used suggestive wording'],
  direct: ['很快说到重点', 'got directly to the point'],
};

function mediaTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.normalize('NFKC').trim();
  const length = Array.from(title).length;
  if (length < 2 || length > 40 || /[<>\r\n@\\]|https?:|www\.|\b\d{6,}\b/iu.test(title)) return null;
  return title;
}

function recordMedia(tally, kind, value, source, at) {
  const title = mediaTitle(value);
  if (!title || !Number.isFinite(at)) return;
  const key = kind + ':' + title.toLowerCase();
  const before = tally.get(key);
  if (!before || at >= before.at || (source === 'play' && before.source !== 'play')) {
    tally.set(key, { kind, title, source: before?.source === 'play' ? 'play' : source, at: Math.max(at, before?.at ?? at) });
  }
}

export function observeMediaSpeech(tally, text, at) {
  for (const [kind, matcher] of SPEECH_MEDIA) {
    const hit = matcher.exec(text);
    if (hit) recordMedia(tally, kind, hit[1], 'speech', at);
  }
}

export function observeMediaTool(tally, row, videos) {
  if (row.mod !== 'bilibili-video' || row.tool !== 'bilibili_video_play') return;
  videos.started += 1;
  const outcome = row.receipt?.text ?? row.receipt ?? row.result?.text ?? row.result ?? row.output?.text ?? row.output;
  if (typeof outcome !== 'string') return;
  const hit = outcome.match(/^开始看《([^》\r\n]+)》/u);
  if (hit) recordMedia(tally, 'video', hit[1], 'play', Date.parse(row.ts));
}

export function freshDiary(facts, activity, language, baseMemory) {
  const zh = language === 'zh';
  const result = [];
  const add = (id, icon, label, summary, theme) => {
    result.push({ id, icon, title: label, summary, theme });
  };
  for (const kind of ['video', 'game']) {
    const media = activity?.media?.find((event) => event.kind === kind);
    if (kind === 'video' && !media && activity?.videoStarts) {
      add('video', 'play', zh ? '最近看过的视频' : 'Recent videos', zh
        ? `最近有 ${activity.videoStarts} 次视频播放记录。`
        : `${activity.videoStarts} video playback starts were recorded.`);
    } else if (media) {
      const { title, source } = media;
      if (kind === 'video') {
        add('video', 'play', zh ? '最近看过的视频' : 'Recent videos', zh
          ? (source === 'play' ? `她点开播放了《${title}》。` : `她在聊天里说看过《${title}》。`)
          : (source === 'play' ? `She started playing “${title}”.` : `She said she watched “${title}”.`));
      } else {
        add('game', 'play', zh ? '最近玩过的游戏' : 'Recent games', zh
          ? `她在聊天里说玩过《${title}》。` : `She said she played “${title}”.`);
      }
    }
  }
  const published = new Set();
  const distinctive = activity?.topics?.find(({ id }) => id !== 'food' && id !== 'sweet');
  for (const id of ['plugin', 'conversation-topic']) {
    let base = facts.find((item) => item.id === id);
    if (!base) continue;
    if (id === 'conversation-topic' && distinctive && distinctive.id !== base.theme) {
      base = { ...base, theme: distinctive.id, summary: zh
        ? `这阵子她在 ${distinctive.days} 天聊过「${distinctive.zh}」，共 ${distinctive.count} 条消息。`
        : `She mentioned ${distinctive.en} in ${distinctive.count} sent messages across ${distinctive.days} days.` };
    }
    result.push(base);
    if (base.theme) published.add(base.theme);
  }
  for (const prefix of ['memory-', 'recalled-']) {
    const base = facts.find(({ id, theme }) => id.startsWith(prefix) && !published.has(theme));
    if (!base) continue;
    result.push(base);
    if (base.theme) published.add(base.theme);
  }
  if (!result.some(({ icon }) => icon === 'memory')) {
    const noted = baseMemory?.profileTopics?.find(({ id }) => !published.has(id));
    if (noted) add('native-memory-topic', 'memory', zh ? '最近记下的事' : 'Recent memories',
      zh ? `Coo 基础记忆里，「${noted.zh}」出现在 ${noted.days} 天的日常记录中。`
        : `Coo base memory mentions ${noted.en} on ${noted.days} different days.`, noted.id);
  }
  const phrase = activity?.phrase ?? activity?.opener;
  if (phrase) {
    const { word, count, days } = phrase;
    add('opener', 'speech', zh ? '常挂在嘴边' : 'A familiar expression',
      zh ? `「${word}」出现在她发出的 ${count} 条消息里，分布在 ${days ?? 2} 天。`
        : `“${word}” appeared in ${count} sent messages across ${days ?? 2} days.`);
  }
  const voice = activity?.voice?.find(({ id }) => VOICE_WORDS[id]);
  if (voice) {
    const words = VOICE_WORDS[voice.id];
    add('voice-sample', 'speech', zh ? '最近怎么说话' : 'How she has been speaking',
      zh ? `她发出的消息中，有 ${voice.count} 条${words[0]}，分布在 ${voice.days} 天。`
        : `She ${words[1]} in ${voice.count} messages across ${voice.days} days.`);
  }
  return result;
}
