const LANG = {
  zh: {
    missing: '这次记录还不够，先留待观察。',
    stability: ['大多数调用都能顺利完成。', '有些调用中途没走完，她可能得再试一次。', '先看失败集中在哪个时段或模型。', '失败变多时，先记下时段再翻运行记录。', '等攒够调用记录，再回来看成功与失败的情况。'],
    latency: ['多数时候能比较快等到她回话。', '有些请求等得明显更久。', '先看慢请求是否集中在同一个模型或时段。', '如果又出现等很久的情况，可以先看慢请求的时间。', '等积累更多带时长的请求，再判断她回话快不快。'],
    cache: ['重复内容有一部分能直接复用。', '这次复用重复内容的表现还有余地。', '先检查开头的固定提示词是否经常变动。', '固定提示词保持稳定，后面更容易复用。', '先确认模型有没有记录用量和缓存数据。'],
    context: ['这次能核对的长对话设置都在合理区间。', '长对话的设置里有值得核对的地方。', '先核对面板标出的设置，再结合实际截断情况判断。', '平时照常用，遇到反复断档再回来核对设置。', '先看看宿主有没有读到上下文和轮次配置。'],
    handoff: ['这次抽查的交接记录整体比较平顺。', '交接记录里有几处值得复查。', '先看最近一份异常交接，核对下一段能不能接住前文。', '如果聊着聊着接不上了，先翻最近一份交接记录。', '有了几次可读的交接记录，才能判断这块。'],
    memory: ['这次抽查到的基础记忆访问正常。', '部分基础记忆访问值得复查。', '先从基础记忆工作区的路径和读取权限查起。', '如果有记忆读不到，先检查基础工作区。', '先确认 Coo 基础记忆工作区能打开。'],
  },
  en: {
    missing: 'There are too few records to tell this time.',
    stability: ['Most requests completed smoothly.', 'Some requests did not finish and may have needed a retry.', 'Check when failures happened and which model was in use.', 'If failures increase, check the times in the run log.', 'Collect more request records first.'],
    latency: ['Replies usually did not take long.', 'Some requests took noticeably longer.', 'Check which model or time period had the slow requests.', 'If a reply takes a long time, check when slow requests occurred.', 'Wait for more requests with recorded durations.'],
    cache: ['Some repeated content was reused.', 'There is room to reuse more repeated content.', 'Check whether the fixed prompt prefix changes frequently.', 'A stable fixed prompt helps content get reused.', 'Check whether the model reports usage and cache data.'],
    context: ['The long-conversation settings checked here look reasonable.', 'Some long-conversation settings deserve a look.', 'Review the flagged settings alongside any actual truncation.', 'If conversations repeatedly lose context, check these settings.', 'Check that the context and turn limits can be read.'],
    handoff: ['The handoff records checked here looked steady.', 'Some handoff records deserve a closer look.', 'Check whether the next turn picked up after the latest unusual handoff.', 'If the thread is lost, look at the last handoff.', 'Wait for a few readable handoff records.'],
    memory: ['The base memory files checked here were accessible.', 'Some base memory access deserves a closer look.', 'Start with the base memory workspace path and read permissions.', 'If memory is hard to open, check the base workspace first.', 'Check that the Coo base memory workspace opens.'],
  },
};

const DAILY = new Set(['stability', 'latency', 'cache']);

export function dimensionGuide(dim, lang) {
  const zh = lang === 'zh';
  const copy = LANG[lang] ?? LANG.en;
  const [fine, weak, fix, watch, gather] = copy[dim.id] ?? [];
  const known = Number.isFinite(dim.score);
  const drift = Number.isFinite(dim.delta) ? Math.round(Math.abs(dim.delta)) : null;
  const falling = drift >= 5 && dim.delta < 0;
  const weakNow = dim.state === 'warn' || dim.state === 'bad';
  const needsAttention = known && (falling || weakNow);
  const hasDaily = DAILY.has(dim.id);
  const days = (dim.series ?? []).filter(({ score }) => Number.isFinite(score)).length;
  let trendStatus = null;
  if (!hasDaily) trendStatus = zh ? '当前检查' : 'Current checks';
  else if (days < 2) trendStatus = zh ? '逐日样本不足' : 'Too few days to chart';
  else if (drift === null) trendStatus = zh ? '已有趋势，比较样本不足' : 'Trend shown, too few days to compare';
  else if (drift < 5) trendStatus = zh ? '变化不到 5 分' : 'Change under 5 points';

  let takeaway = !known ? copy.missing : needsAttention ? weak : fine;
  if (known && drift >= 5) {
    if (dim.id === 'stability' && falling) takeaway = zh ? '这阵子比前阵子更容易遇到调用失败。' : 'Requests failed more often than in the earlier period.';
    if (dim.id === 'latency' && !falling) takeaway = zh ? '最慢的那批请求，最近等得短了一些。' : 'The slowest requests have taken less time recently.';
  }
  if (known && dim.id === 'stability' && dim.state === 'bad') {
    takeaway = zh ? '这段时间有不少调用没完成，值得优先排查。' : 'Many requests did not finish in this period. Check this first.';
  }
  let checkLabel = null;
  if (dim.checks && dim.score === 100) {
    const { passed, total } = dim.checks;
    checkLabel = zh ? `通过 ${passed}/${total}` : `${passed}/${total} passed`;
  }
  if (dim.fileCheck && dim.score === 100) {
    const { readable, sampled, settings } = dim.fileCheck;
    if (sampled > 0) checkLabel = zh ? `${readable}/${sampled} 可读` : `${readable}/${sampled} readable`;
    else if (settings === true) {
      checkLabel = zh ? '设定可读' : 'Settings readable';
      takeaway = zh ? '基础设定能打开，暂时还没有日常文本可抽查。' : 'The base settings open. No daily files were available to check.';
    }
  }
  if (dim.id === 'handoff' && dim.timing && !known) {
    takeaway = zh ? '交接笔记读得到，发生时间还不足以判断频率。'
      : 'The handoff notes are readable, with too few verifiable timestamps to assess frequency.';
    trendStatus = zh ? '间隔样本不足' : 'Too few verifiable gaps';
  }
  return { takeaway: takeaway ?? '', suggestion: (!known ? gather : needsAttention ? fix : watch) ?? '',
    trendStatus, needsAttention, checkLabel, days };
}

export function simpleHardware(rows, lang) {
  const zh = lang === 'zh';
  const known = rows.filter(({ score }) => Number.isFinite(score));
  const missing = rows.filter(({ score }) => !Number.isFinite(score));
  const concern = known.find((row) => row.needsAttention);
  const attention = concern ?? missing[0];
  const overall = !known.length
    ? (zh ? '这次能读到的运行记录还太少。' : 'There are too few operating records this time.')
    : missing.length
      ? (zh ? '这次只能看已读到的几项。' : 'This checkup can cover only the areas with records.')
      : concern
        ? (concern.state === 'bad'
          ? (zh ? '这次有个运行问题需要优先处理。' : 'An operating issue needs prompt attention.')
          : (zh ? '有一处值得先看看。' : 'One area is worth checking first.'))
        : (zh ? '这次检查的项目整体平稳。' : 'The areas checked looked steady.');
  const priority = concern?.takeaway ?? (!missing.length
    ? ''
    : (zh ? `${missing.map(({ title }) => title).join('、')}这次还缺记录。` : `Records were missing for ${missing.map(({ title }) => title).join(', ')}.`));
  const scope = concern && missing.length
    ? (zh ? `${missing.map(({ title }) => title).join('、')}这次还缺记录。` : `Records were missing for ${missing.map(({ title }) => title).join(', ')}.`)
    : '';
  const next = attention?.suggestion || (zh ? '按现在的用法，留意下次体检的变化就好。' : 'Keep using it as usual and check for changes next time.');
  return { overall, priority, scope, next };
}
