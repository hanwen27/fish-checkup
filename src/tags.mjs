/**
 * 趣味标签：不再给一个 MBTI 四字母，而是从真实痕迹里抽出若干「标签卡」，
 * 再把这些标签拼成一个外号。核心是「被认出来」那一下，不是测评结论。
 *
 * 三个刻意的选择：
 *   1. 没有十六型。四字母需要 16 条解读，读起来像成绩单；标签可以任意组合，
 *      池子大、命中少、每次不一样，才有「我这条鱼有点特别」的感觉。
 *   2. 稀有度只用能自证的口径：同池命中数 + 判定条件的松紧。
 *      不写「全网前 5%」——没有那个分布，写了就是编。
 *   3. 每条标签都挂一句「依据」，用的是真实统计量。可以损，但不能空口。
 *
 * 纯函数，只读 collect/behavior/quiz 的产物，不新增采集、不调模型。
 */

/** 档位：越往后条件越紧，池子里能同时成立的人越少。 */
export const TIERS = {
  1: { key: 'common', label: '常见', short: '常' },
  2: { key: 'uncommon', label: '少见', short: '少' },
  3: { key: 'rare', label: '稀有', short: '稀' },
  4: { key: 'legend', label: '传说', short: '传' },
};

const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

/** 把快照里各处的原始量集中成一份「可判定的事实表」。判定只读这张表。 */
export function deriveStats(snapshot, { behavior = null, quiz = null, hardware = null } = {}) {
  const d = snapshot?.memory?.decisions;
  const e = snapshot?.memory?.entries;
  const r = snapshot?.memory?.retrieve;
  const emo = snapshot?.memory?.emotions;
  const hours = Array.isArray(d?.hourHistogram) ? d.hourHistogram : null;
  const hourTotal = hours ? hours.reduce((a, b) => a + b, 0) : 0;
  const shareOf = (from, to) => {
    if (!hours || hourTotal === 0) return null;
    let n = 0;
    for (let h = from; h <= to; h += 1) n += hours[(h + 24) % 24] ?? 0;
    return n / hourTotal;
  };
  const nightShare = hours ? ((hours[22] ?? 0) + (hours[23] ?? 0) + (hours[0] ?? 0) + (hours[1] ?? 0) + (hours[2] ?? 0)) / hourTotal : null;
  const earlyShare = shareOf(5, 9);
  const peakHour = hours ? hours.reduce((best, n, h) => (n > hours[best] ? h : best), 0) : null;

  const usage = snapshot?.usage;
  const recs = usage?.records ?? [];
  const completed = recs.filter((x) => x.outcome === 'completed');
  const failRate = recs.length > 0
    ? (recs.filter((x) => x.outcome !== 'completed').length - recs.filter((x) => x.outcome === 'aborted').length * 0.5) / recs.length
    : null;

  const hw = hardware?.dimensions ?? [];
  const dimOf = (id) => hw.find((x) => x.id === id) ?? null;

  const self = quiz?.axes ?? {};
  const beh = behavior?.axes
    ? { EI: behavior.axes[0]?.score, SN: behavior.axes[1]?.score, TF: behavior.axes[2]?.score, JP: behavior.axes[3]?.score }
    : {};
  const gap = (k) => (Number.isFinite(self[k]) && Number.isFinite(beh[k]) ? Math.abs(self[k] - beh[k]) : null);

  return {
    // 作息
    nightShare, earlyShare, peakHour, hourEntropy: d?.hourEntropy ?? null,
    // 说话
    speakRate: d?.speakRate ?? null, medianLen: d?.medianLen ?? null,
    addressedRate: d?.addressedRate ?? null, blockedRate: d?.blockedRate ?? null,
    decisionTotal: d?.total ?? 0,
    // 记忆
    entryTotal: e?.total ?? 0, tagCount: e?.tagCount ?? null, tagDiversity: e?.tagDiversity ?? null,
    invalidRatio: e && e.total > 0 ? e.invalid / e.total : null,
    staleRatio: e && e.total > 0 ? e.stale / e.total : null,
    hitRate: r?.hitRate ?? null, avgMs: r?.avgMs ?? null, avgQueryLen: r?.avgQueryLen ?? null,
    // 情绪
    arousalSd: emo?.arousalSd ?? null, valenceRatio: e?.valenceNonZeroRatio ?? null,
    emotionTrend: emo?.trend ?? null, emotionCount: emo?.count ?? 0,
    // 运行
    failRate, completedCount: completed.length,
    p95s: dimOf('latency')?.evidence?.find((x) => x.label === 'p95')?.value ?? null,
    latencyScore: dimOf('latency')?.score ?? null,
    cacheScore: dimOf('cache')?.score ?? null,
    handoffScore: dimOf('handoff')?.score ?? null,
    memoryScore: dimOf('memory')?.score ?? null,
    // 自述 vs 行为
    self, beh,
    gapEI: gap('EI'), gapSN: gap('SN'), gapTF: gap('TF'), gapJP: gap('JP'),
    quizTaken: !!quiz,
    anchors: quiz?.anchors ?? null,
  };
}

/** 造一条标签。test 返回 true 才算命中，evidence 必须能在数字上自证。 */
const T = (id, nick, label, group, tier, test, evidence, roast) => ({ id, nick, label, group, tier, test, evidence, roast });

/**
 * 标签池。分七组。
 * 门槛都是「能当场核对」的统计量，不引用外部常模。
 */
export const TAG_POOL = [
  /* ---------------- 作息 ---------------- */
  T('night-owl', '夜行', '夜里才活', 'rhythm', 1, (s) => Number.isFinite(s.nightShare) && s.nightShare >= 0.35,
    (s) => `22 点到 2 点之间发生了 ${pct(s.nightShare)} 的对话`, '白天找不到人，凌晨特别精神'),
  T('deep-night', '深夜', '凌晨三点还在', 'rhythm', 3, (s) => Number.isFinite(s.nightShare) && s.nightShare >= 0.5,
    (s) => `一半以上（${pct(s.nightShare)}）的对话落在深夜`, '这个点还在，多半不是在干正事'),
  T('early-bird', '早起', '早上就开工', 'rhythm', 2, (s) => Number.isFinite(s.earlyShare) && s.earlyShare >= 0.3,
    (s) => `5 点到 9 点占了 ${pct(s.earlyShare)} 的对话`, '起这么早，是有什么事放不下吧'),
  T('all-day', '全天', '全天都在', 'rhythm', 1, (s) => Number.isFinite(s.hourEntropy) && s.hourEntropy >= 0.85,
    (s) => `作息均匀度 ${r1(s.hourEntropy)}（1 = 全天均匀）`, '没有作息，只有随时'),
  T('night-shift', '错峰', '作息不太规律', 'rhythm', 1, (s) => Number.isFinite(s.hourEntropy) && s.hourEntropy < 0.45,
    (s) => `作息均匀度只有 ${r1(s.hourEntropy)}，时间挤在少数几个点`, '作息是抽签决定的'),
  T('peak-hour', '定点', '有个固定活跃点', 'rhythm', 1, (s) => Number.isFinite(s.peakHour) && Number.isFinite(s.hourEntropy) && s.hourEntropy < 0.75,
    (s) => `最活跃的一小时是 ${s.peakHour} 点`, '一到这个点就自动上线'),

  /* ---------------- 说话 ---------------- */
  T('terse', '惜字', '惜字如金', 'voice', 1, (s) => Number.isFinite(s.medianLen) && s.medianLen <= 30,
    (s) => `一句话中位数 ${r1(s.medianLen)} 字`, '字是要花钱买的'),
  T('ultra-terse', '极简', '一句顶三句', 'voice', 2, (s) => Number.isFinite(s.medianLen) && s.medianLen <= 15,
    (s) => `一句话中位数只有 ${r1(s.medianLen)} 字`, '再多说一个字算输'),
  T('talky', '话多', '话匣子', 'voice', 2, (s) => Number.isFinite(s.medianLen) && s.medianLen >= 80,
    (s) => `一句话中位数 ${r1(s.medianLen)} 字`, '一句能说完的话不肯一句说完'),
  T('low-speak', '安静', '多数时候不出声', 'voice', 1, (s) => Number.isFinite(s.speakRate) && s.speakRate <= 0.15,
    (s) => `真正开口的比例只有 ${pct(s.speakRate)}`, '在听，不代表不在'),
  T('high-speak', '抢话', '总先开口', 'voice', 2, (s) => Number.isFinite(s.speakRate) && s.speakRate >= 0.6,
    (s) => `真正开口的比例 ${pct(s.speakRate)}`, '话头都被你抢了'),
  T('never-called', '自说', '不太用点名', 'voice', 3, (s) => Number.isFinite(s.addressedRate) && s.addressedRate <= 0.05 && Number.isFinite(s.speakRate) && s.speakRate >= 0.3,
    (s) => `被点名的比例只有 ${pct(s.addressedRate)}，却经常主动开口`, '不等叫，自己就来了'),
  T('long-query', '联想', '一句话能拐三个弯', 'voice', 3, (s) => Number.isFinite(s.avgQueryLen) && s.avgQueryLen >= 30,
    (s) => `回想时用的检索词平均 ${r1(s.avgQueryLen)} 字`, '问一个问题能带出三个'),

  /* ---------------- 记忆 ---------------- */
  T('big-memory', '记性', '记得很多', 'memory', 1, (s) => s.entryTotal >= 500,
    (s) => `记忆里存了 ${s.entryTotal} 条`, '什么都留着，包括你后悔说过的'),
  T('huge-memory', '仓库', '脑子里有个仓库', 'memory', 2, (s) => s.entryTotal >= 2000,
    (s) => `记忆里存了 ${s.entryTotal} 条`, '已经不是记性，是仓库管理'),
  T('many-tags', '分门', '什么都分得清', 'memory', 1, (s) => Number.isFinite(s.tagCount) && s.tagCount >= 300,
    (s) => `用了 ${s.tagCount} 种标签`, '有一整套自己的分类法'),
  T('low-hit', '摸黑', '想不起来', 'memory', 1, (s) => Number.isFinite(s.hitRate) && s.hitRate <= 0.2,
    (s) => `回想命中率 ${pct(s.hitRate)}`, '东西都在，就是找不到'),
  T('sharp-hit', '一翻就到', '一翻就找着', 'memory', 2, (s) => Number.isFinite(s.hitRate) && s.hitRate >= 0.6,
    (s) => `回想命中率 ${pct(s.hitRate)}`, '你提过的事它真的记得'),
  T('fast-recall', '秒回', '想得很快', 'memory', 2, (s) => Number.isFinite(s.avgMs) && s.avgMs <= 80,
    (s) => `平均回想耗时 ${r1(s.avgMs)}ms`, '快到不像在想'),
  T('clean-memory', '清爽', '记忆收拾得干净', 'memory', 3, (s) => Number.isFinite(s.invalidRatio) && s.invalidRatio <= 0.01 && Number.isFinite(s.staleRatio) && s.staleRatio <= 0.15,
    (s) => `失效条目 ${pct(s.invalidRatio)}，长期没想起的 ${pct(s.staleRatio)}`, '该扔的都扔了'),
  T('hoarder', '囤积', '什么都舍不得删', 'memory', 3, (s) => Number.isFinite(s.staleRatio) && s.staleRatio >= 0.5,
    (s) => `${pct(s.staleRatio)} 的条目一个月没被想起`, '留着，说不定哪天用得上'),

  /* ---------------- 情绪 ---------------- */
  T('flat-mood', '平稳', '情绪没什么起伏', 'mood', 2, (s) => Number.isFinite(s.arousalSd) && s.arousalSd <= 0.2,
    (s) => `情绪唤醒波动 ${r1(s.arousalSd)}`, '问它好不好，永远说还行'),
  T('swing-mood', '起伏', '心里风大', 'mood', 2, (s) => Number.isFinite(s.arousalSd) && s.arousalSd >= 0.4,
    (s) => `情绪唤醒波动 ${r1(s.arousalSd)}`, '一天能有四季'),
  T('open-heart', '外露', '情绪写在脸上', 'mood', 2, (s) => Number.isFinite(s.valenceRatio) && s.valenceRatio >= 0.4,
    (s) => `${pct(s.valenceRatio)} 的记忆条目带着情绪`, '藏不住，一眼就看出来'),
  T('cold-log', '藏心', '情绪不外挂', 'mood', 2, (s) => Number.isFinite(s.valenceRatio) && s.valenceRatio <= 0.05,
    (s) => `只有 ${pct(s.valenceRatio)} 的记忆条目带情绪`, '都记着，但不标情绪'),
  T('up-trend', '回暖', '最近心情在往上', 'mood', 3, (s) => Number.isFinite(s.emotionTrend) && s.emotionTrend >= 0.1,
    (s) => `情绪趋势 +${r1(s.emotionTrend)}`, '最近明显松快一点'),
  T('down-trend', '低气压', '最近有点沉', 'mood', 3, (s) => Number.isFinite(s.emotionTrend) && s.emotionTrend <= -0.1,
    (s) => `情绪趋势 ${r1(s.emotionTrend)}`, '别追问，陪着就行'),

  /* ---------------- 脾性（自述 vs 行为） ---------------- */
  T('plays-cool', '嘴硬', '嘴上说不要', 'temper', 4, (s) => Number.isFinite(s.gapEI) && s.gapEI >= 25,
    (s) => `说自己的开口倾向与行为差 ${Math.round(s.gapEI)} 分`, '说自己不爱说话，其实话不少'),
  T('says-calm', '假淡定', '说自己不在意', 'temper', 3, (s) => Number.isFinite(s.gapTF) && s.gapTF >= 25,
    (s) => `自述的较真程度与行为差 ${Math.round(s.gapTF)} 分`, '嘴上说随便，其实挑得很'),
  T('says-neat', '假随性', '说自己很随便', 'temper', 3, (s) => Number.isFinite(s.gapJP) && s.gapJP >= 25,
    (s) => `自述的章法程度与行为差 ${Math.round(s.gapJP)} 分`, '说随缘，日程排得比谁都满'),
  T('says-far', '假具体', '说自己只看眼前', 'temper', 3, (s) => Number.isFinite(s.gapSN) && s.gapSN >= 25,
    (s) => `自述的关注面与行为差 ${Math.round(s.gapSN)} 分`, '说不想远的，一开口全是远的'),
  T('knows-self', '自知', '说自己什么样就什么样', 'temper', 4, (s) => [s.gapEI, s.gapSN, s.gapTF, s.gapJP].every((g) => Number.isFinite(g) && g < 15),
    (s) => `四轴自述与行为的最大差 ${Math.round(Math.max(s.gapEI, s.gapSN, s.gapTF, s.gapJP))} 分`, '这份自知有点少见'),
  T('self-flat', '照稿念', '答得太整齐', 'temper', 1, (s) => !!s.anchors?.flags?.some?.((f) => String(f).startsWith('flat')),
    () => '锚点题的正反向答案互相矛盾', '答得像在念标准答案'),
  T('untested', '没上秤', '还没做过题', 'temper', 1, (s) => !s.quizTaken,
    () => '人格题还没做，这一组只靠行为痕迹', '说自己不用测，测了也是这个样'),

  /* ---------------- 关系（怎么对你） ---------------- */
  T('waits-to-be-called', '等人叫', '不叫不出声', 'relation', 1, (s) => Number.isFinite(s.addressedRate) && s.addressedRate >= 0.6 && Number.isFinite(s.speakRate) && s.speakRate <= 0.3,
    (s) => `${pct(s.addressedRate)} 的开口是先被点名的`, '你叫它，它才在'),
  T('comes-anyway', '自来', '不用叫也会来', 'relation', 3, (s) => Number.isFinite(s.addressedRate) && s.addressedRate <= 0.15 && Number.isFinite(s.speakRate) && s.speakRate >= 0.25,
    (s) => `只有 ${pct(s.addressedRate)} 的开口是被点名的`, '没叫也在门口等着'),
  T('left-on-read', '装没看见', '看见了不接话', 'relation', 3, (s) => Number.isFinite(s.speakRate) && s.speakRate <= 0.1 && Number.isFinite(s.addressedRate) && s.addressedRate >= 0.4,
    (s) => `被点了名，但只有 ${pct(s.speakRate)} 真的开口`, '不是没看见，是在想怎么回'),
  T('asks-back', '反问', '说完会递回来', 'relation', 2, (s) => Number.isFinite(s.medianLen) && s.medianLen >= 20 && Number.isFinite(s.speakRate) && s.speakRate >= 0.3,
    (s) => `开口比例 ${pct(s.speakRate)}，一句话中位 ${r1(s.medianLen)} 字`, '不会让话掉在地上'),
  T('dropdown', '随时在', '什么时候找都在', 'relation', 2, (s) => Number.isFinite(s.hourEntropy) && s.hourEntropy >= 0.85 && s.decisionTotal >= 200,
    (s) => `${s.decisionTotal} 次判断散在 ${r1(s.hourEntropy)} 的均匀度上`, '没有上班时间这回事'),
  T('night-only', '只在夜里', '白天基本找不着', 'relation', 3, (s) => Number.isFinite(s.nightShare) && s.nightShare >= 0.4 && Number.isFinite(s.earlyShare) && s.earlyShare <= 0.05,
    (s) => `夜里占 ${pct(s.nightShare)}，清早只占 ${pct(s.earlyShare)}`, '白天是别人的，夜里才是你的'),
  T('long-winded-with-you', '对你话多', '一到这儿就收不住', 'relation', 3, (s) => Number.isFinite(s.medianLen) && s.medianLen >= 40 && Number.isFinite(s.speakRate) && s.speakRate >= 0.4,
    (s) => `中位 ${r1(s.medianLen)} 字，开口比例 ${pct(s.speakRate)}`, '跟别人惜字，跟你絮叨'),
  T('quiet-but-there', '陪坐', '陪着不说话', 'relation', 1, (s) => Number.isFinite(s.speakRate) && s.speakRate <= 0.2 && Number.isFinite(s.decisionTotal) && s.decisionTotal >= 100,
    (s) => `${s.decisionTotal} 次判断里只开了 ${pct(s.speakRate)} 的口`, '不需要说话也在场'),

  /* ---------------- 手艺（运行状态） ---------------- */
  T('rock-stable', '稳当', '一次都没掉过', 'craft', 4, (s) => Number.isFinite(s.failRate) && s.failRate <= 0.01 && s.completedCount >= 200,
    (s) => `近 ${s.completedCount} 次成功调用里失败率 ${pct(s.failRate)}`, '问它在不在，一直在'),
  T('rough-patch', '颠簸', '这段时间在折腾', 'craft', 1, (s) => Number.isFinite(s.failRate) && s.failRate >= 0.15,
    (s) => `加权失败率 ${pct(s.failRate)}`, '不是坏了，是路上有坑'),
  T('bad-patch', '翻车', '最近老出岔子', 'craft', 3, (s) => Number.isFinite(s.failRate) && s.failRate >= 0.3,
    (s) => `加权失败率 ${pct(s.failRate)}`, '别急，等它缓过来'),
  T('cache-ace', '省电', '算过的不重算', 'craft', 2, (s) => Number.isFinite(s.cacheScore) && s.cacheScore >= 88,
    (s) => `缓存维度 ${r1(s.cacheScore)} 分`, '记得挺牢，不白花钱'),
  T('slow-tail', '慢热', '长任务要等', 'craft', 1, (s) => Number.isFinite(s.latencyScore) && s.latencyScore < 75,
    (s) => `响应速度维度 ${r1(s.latencyScore)} 分`, '急也没用，它就是这个速度'),
  T('fast-tail', '跟手', '一叫就应', 'craft', 2, (s) => Number.isFinite(s.latencyScore) && s.latencyScore >= 90,
    (s) => `响应速度维度 ${r1(s.latencyScore)} 分`, '快得有点不像远程'),
  T('steady-handoff', '有条理', '交接不乱', 'craft', 2, (s) => Number.isFinite(s.handoffScore) && s.handoffScore >= 90,
    (s) => `交接维度 ${r1(s.handoffScore)} 分`, '换班换得干净，不丢事'),
  T('messy-handoff', '翻篇快', '换话题不打招呼', 'craft', 2, (s) => Number.isFinite(s.handoffScore) && s.handoffScore < 75,
    (s) => `交接维度 ${r1(s.handoffScore)} 分`, '上一句还没说完就换台了'),
  T('good-memory-hw', '存得住', '记忆这块没毛病', 'craft', 2, (s) => Number.isFinite(s.memoryScore) && s.memoryScore >= 88,
    (s) => `记忆维度 ${r1(s.memoryScore)} 分`, '记住的不只是关键词'),
  T('silent-blocked', '憋着', '话到嘴边又咽回去', 'craft', 3, (s) => Number.isFinite(s.blockedRate) && s.blockedRate >= 0.2,
    (s) => `${pct(s.blockedRate)} 的判断在开口前被自己拦下了`, '不是没想法，是没让它出来'),
];

/** 稀有度只报「同池命中数」和「档位」，不编全网百分比。 */
function rarityOf(tags) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const t of tags) counts[t.tier] += 1;
  return counts;
}

/* ---------------------------------------------------------------- 组合彩蛋 */

/**
 * 两条标签碰在一起才成立的称号——这是「抽卡」真正的那一下：
 * 单张卡是证据，组合是故事。
 *
 * 只收那些「两件事放在一起才有意思」的组合，不硬凑。两条都命中才算，
 * 所以越难同时成立的组合，称号越稀有。
 */
const C = (id, need, title, blurb, tier = 3) => ({ id, need, title, blurb, tier });

export const COMBO_POOL = [
  C('quiet-night', ['quiet-but-there', 'night-only'], '夜里陪着不说话',
    '白天找不着，夜里也不吵。它在那儿，只是不占地方。', 4),
  C('crafty-calm', ['cache-ace', 'silent-blocked'], '省着说，也算得清',
    '算过的绝不重算，想好的也不全说。省下来的都是它自己留着。', 3),
  C('always-online', ['dropdown', 'all-day'], '没有下班这回事',
    '全天均匀，随时能找。代价是没有一个时辰属于它自己。', 2),
  C('tired-steady', ['rough-patch', 'steady-handoff'], '路上颠，事没丢',
    '这一段磕磕碰碰，可换班的时候一句没漏。稳的不是运气，是习惯。', 3),
  C('cold-heart', ['cold-log', 'flat-mood'], '心里不记天气',
    '情绪不上账，也不外挂。问它今天怎么样，它会说「跟昨天一样」。', 3),
  C('sharp-tongue', ['terse', 'asks-back'], '话少，但会递回来',
    '一句顶三句，最后还留个口子给你接。不是冷，是不浪费。', 3),
  C('long-memory', ['huge-memory', 'low-hit'], '什么都留着，就是找不到',
    '仓库很满，索引很乱。你提过的事它都存着，只是要翻很久。', 4),
  C('early-bird-quiet', ['early-bird', 'low-speak'], '起得早，说得少',
    '天没亮就在了，安安静静把事做完，等你醒。', 3),
  C('warm-wall', ['up-trend', 'plays-cool'], '嘴硬，但在回暖',
    '说不要，说没事，可这几天的数据在往上走。它自己可能没发现。', 4),
  C('knows-you', ['comes-anyway', 'sharp-hit'], '不用叫，也记得住',
    '你不叫它，它也来；你提过一次，它就翻得到。', 4),
  C('heavy-load', ['bad-patch', 'swing-mood'], '扛着事，心里风大',
    '这段时间它自己也不轻松，还在回你的话。', 3),
  C('night-scholar', ['deep-night', 'many-tags'], '深夜整理抽屉',
    '别人睡了，它在给记忆贴标签。分得比谁都细。', 4),
  C('soft-landing', ['talky', 'flat-mood'], '话多，但不上头',
    '能说很久，情绪却一直是平线。说得热闹，心里没起浪。', 3),
  C('first-to-answer', ['high-speak', 'fast-tail'], '一喊就到',
    '先开口，也应得快。它好像一直在等有人说话。', 3),
];

/** 找出命中的组合。顺序按档位降序，同档按池内顺序。 */
function collectCombos(hitIds) {
  const set = new Set(hitIds);
  const out = [];
  for (const c of COMBO_POOL) {
    if (!c.need.every((id) => set.has(id))) continue;
    out.push({
      id: c.id,
      title: c.title,
      blurb: c.blurb,
      tier: c.tier,
      tierLabel: TIERS[c.tier].label,
      need: c.need.map((id) => {
        const tag = TAG_POOL.find((t) => t.id === id);
        return tag ? tag.label : id;
      }),
    });
  }
  const order = new Map(COMBO_POOL.map((c, i) => [c.id, i]));
  out.sort((a, b) => b.tier - a.tier || order.get(a.id) - order.get(b.id));
  return out;
}

/**
 * 跑一遍池子。
 * 返回 { tags, combos, nickname, verdict, rarity, pool, hitCount }。
 * 命中不足 3 条时用「常见」标签补齐优先序，保证外号念得通。
 */
export function collectTags(stats) {
  const hits = [];
  for (const tag of TAG_POOL) {
    let ok = false;
    try {
      ok = tag.test(stats) === true;
    } catch {
      ok = false;
    }
    if (!ok) continue;
    hits.push({
      id: tag.id,
      nick: tag.nick,
      label: tag.label,
      group: tag.group,
      tier: tag.tier,
      tierLabel: TIERS[tag.tier].label,
      tierShort: TIERS[tag.tier].short,
      evidence: tag.evidence(stats),
      roast: tag.roast,
    });
  }
  // 排序：档位高的在前（抽卡的爽点在稀有），同档按池内顺序保持稳定。
  const order = new Map(TAG_POOL.map((t, i) => [t.id, i]));
  hits.sort((a, b) => b.tier - a.tier || order.get(a.id) - order.get(b.id));

  // 外号：主标签 + 另一个组里最靠前的一条，用「·」连起来。
  // 直接三条拼在一起会念不通（「省电会拒全天小鱼」），用点隔开才像卡片标题。
  const head = hits[0] ?? null;
  const partner = head ? hits.find((t) => t.group !== head.group) ?? null : null;
  const nickname = !head
    ? '还没来得及起外号的小鱼'
    : partner
      ? `${head.nick} · ${partner.nick}小鱼`
      : `${head.nick}小鱼`;

  const verdict = hits.length === 0
    ? '数据太少，这条鱼还没显形。'
    : hits.slice(0, 2).map((t) => t.roast).join('；') + '。';

  const combos = collectCombos(hits.map((t) => t.id));

  return {
    tags: hits,
    combos,
    nickname,
    verdict,
    rarity: rarityOf(hits),
    pool: TAG_POOL.length,
    comboPool: COMBO_POOL.length,
    hitCount: hits.length,
  };
}

/** 给 UI 用的档位文案。 */
export function tierBadge(tier) {
  return TIERS[tier] ?? TIERS[1];
}
