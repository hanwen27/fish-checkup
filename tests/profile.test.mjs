import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRecentActivity } from '../src/recent-fish.mjs';
import { buildProfile, finishDecisions, observeDecision, profileClock, profileDecisions, readProfileCopy } from '../src/profile.mjs';

test('画像按有效影子判断计数，排除观望，并比较群聊点名情境', () => {
  const stats = profileDecisions();
  const clock = profileClock('Asia/Shanghai');
  for (let day = 1; day <= 4; day += 1) {
    const at = Date.UTC(2026, 10, day, 12);
    for (let i = 0; i < 9; i += 1) {
      observeDecision(stats, { chat: 'group:1', addressed: true, act: i < 6 ? 'answer' : 'hold' }, at, clock);
      observeDecision(stats, { chat: 'group:1', addressed: false, act: i < 1 ? 'ask' : 'silent' }, at, clock);
    }
    observeDecision(stats, { chat: 'group:1', addressed: true, act: 'invalid' }, at, clock);
    observeDecision(stats, { chat: 'private:1', addressed: true, act: 'act' }, at, clock);
  }
  const counts = finishDecisions(stats);
  assert.deepEqual(counts.addressed, { total: 36, replies: 24, days: 4 });
  assert.deepEqual(counts.unaddressed, { total: 36, replies: 4, days: 4 });
  assert.deepEqual(counts.night, { total: 76, replies: 28, days: 4 });
  assert.equal(counts.day.total, 0);
  const profile = buildProfile({ profileDays: 14, profileDecisions: counts }, 'zh');
  assert.equal(profile.days, 14);
  assert.deepEqual(profile.recent.filter((row) => !row.empty).map(({ id }) => id), ['speech']);
  assert.match(profile.title, /群里.*叫到名字/);
  assert.match(profile.evidence[0].lines[1], /尚未核对实际发言/);
  assert.match(profile.evidence[0].lines[2], /24\/36.*4\/36/);
});

test('少样本与单日集中可以显示记录，但不生成近期性格结论', () => {
  const stats = profileDecisions();
  const clock = profileClock('UTC');
  for (let i = 0; i < 80; i += 1) {
    observeDecision(stats, { chat: 'group:1', addressed: false, act: 'answer' }, Date.UTC(2026, 10, 21, 12), clock);
  }
  const profile = buildProfile({
    profileDays: 14, profileDecisions: finishDecisions(stats),
    emotions: { count: 100, arousalSd: 0.04, profileDays: 1 },
    entries: { profileCount: 100, profileDays: 1 },
  }, 'zh');
  assert.equal(profile.recent.length, 3);
  assert.ok(profile.recent.every((row) => row.empty));
  assert.match(profile.evidence[0].lines[0], /80 条/);
});

test('提示词返回只有匹配的观察键与短纯文本才被接收', () => {
  const result = { title: '她最近很少接话。', recent: { speech: '她往往选择安静。' } };
  assert.deepEqual(readProfileCopy(JSON.stringify(result), ['speech']), result);
  assert.equal(readProfileCopy(JSON.stringify(result), ['speech', 'emotion']), null);
  assert.equal(readProfileCopy(JSON.stringify({ ...result, title: '<p>文本</p>' }), ['speech']), null);
});

test('近况优先用实际发言、娱乐和记忆补满三条，失败调用不计入', () => {
  const activity = sampleRecentActivity([
    ...[1, 2, 3].map((day) => ({ ts: `2026-11-0${day}T08:00:00Z`, mod: 'qqbot', tool: 'qq_send', args: { text: '好呀，我来看看。', to: 'private' } })),
    { mod: 'qqbot', tool: 'qq_send', args: { text: '好呀。' }, failed: true },
    { ts: '2026-11-02T09:00:00Z', mod: 'terrarium' },
    { ts: '2026-11-02T09:00:00Z', mod: 'terrarium', failed: true },
  ]);
  assert.equal(activity.messages, 3);
  assert.deepEqual(activity.opener, { word: '好呀', count: 3 });
  assert.equal(activity.plugin.count, 1);
  const profile = buildProfile({ profileDays: 14, entries: { profileCount: 8, profileDays: 4, profileTopics: [{ id: 'drawing', zh: '画画', en: 'drawing', count: 4, days: 2 }] } }, 'zh', activity);
  assert.deepEqual(profile.recent.map(({ id }) => id), ['opener', 'plugin', 'memory-drawing']);
  assert.match(profile.recent[1].summary, /鱼的小世界/);
  assert.ok(!JSON.stringify(profile).includes('我来看看'));
});

test('画像首句用真实发言长度与接话倾向写出反差', () => {
  const memory = { profileDays: 14, profileDecisions: { ...finishDecisions(profileDecisions()), all: { total: 100, replies: 10, days: 5 } } };
  const long = buildProfile(memory, 'zh', { messages: 12, medianLength: 76 });
  const short = buildProfile(memory, 'zh', { messages: 12, medianLength: 9 });
  assert.equal(long.title, '平时少冒泡，一开口就是一小段话。');
  assert.equal(short.title, '难得冒个泡，也就说上几个字。');
  assert.notEqual(buildProfile(memory, 'zh').title, long.title);
});

test('重复话题按消息计数，且需要跨天出现', () => {
  const make = (day, text) => ({ ts: `2026-11-${day}T08:00:00Z`, mod: 'qqbot', tool: 'qq_send', args: { text } });
  const activity = sampleRecentActivity([
    make('10', '画画，画画，画画。'), make('10', '配色很好看。'), make('11', '画一张新的。'),
    make('11', '浇花。'), make('11', '浇水。'), make('11', '盆栽。'),
  ]);
  assert.deepEqual(activity.topics.map(({ id, count, days }) => [id, count, days]), [['drawing', 3, 2]]);
});

test('同样常吃饭的鱼，按各自语气与小测生成不同的称号、评语和描述', () => {
  const chat = (kind) => sampleRecentActivity(Array.from({ length: 8 }, (_, i) => ({
    ts: `2026-11-${i < 4 ? '10' : '11'}T08:00:00Z`, mod: 'console', tool: 'console_send',
    args: { text: kind === 'care' ? '辛苦了，别着急，我陪你慢慢来。' : '先整理材料，再分成三步把任务讲清楚。' },
  })));
  const food = { name: ['吃饭', 'Meals'], count: 20 };
  const gentle = buildProfile({}, 'zh', { ...chat('care'), plugin: food }, { axes: { TF: 20 }, flags: [] });
  const organized = buildProfile({}, 'zh', { ...chat('steps'), plugin: food }, { axes: { JP: 90 }, flags: [] });
  for (const key of ['label', 'title', 'description']) {
    assert.notEqual(gentle[key], organized[key], key);
    assert.doesNotMatch(gentle[key] + organized[key], /吃饭/);
  }
  assert.ok(gentle.tags.includes('暖心派'));
  assert.ok(organized.tags.includes('条理控'));
  assert.ok(gentle.tags.length >= 3 && organized.tags.length >= 3);
  assert.equal(buildProfile({}, 'zh', null).tags.length, 3);
});

test('AI 名片要求三个不同标签，并允许四个', () => {
  const choices = ['一', '二', '三', '四'];
  const draft = { title: '有话慢慢说', label: '从容派', description: '说话喜欢有来有往。', recent: {} };
  const read = (tags) => readProfileCopy(JSON.stringify({ ...draft, tags }), [], choices);
  assert.equal(read(choices.slice(0, 2)), null);
  assert.equal(read(['一', '一', '三']), null);
  assert.equal(read(choices.slice(0, 3)).tags.length, 3);
  assert.equal(read(choices).tags.length, 4);
});
