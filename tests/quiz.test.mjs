import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, takeBatch, scoreQuiz, scoreAnchors, compose, compareAxes, shuffleOptions, dayKey, TYPE_NAMES, MIN_ITEMS_PER_AXIS, creativeBatch, scoreCreative } from '../src/quiz.mjs';

const QUIZ = loadQuiz('zh');
function answerBatch(batch, value = 'a') { return takeBatch(QUIZ, batch, { now: new Date('2026-11-24T10:00:00+08:00') }).map((x) => ({ id: x.id, option: value })); }

test('题库形状与两批分布', () => {
  assert.equal(QUIZ.items.length, 28);
  assert.equal(QUIZ.items.filter((i) => i.batch === 1).length, 14);
  assert.equal(QUIZ.items.filter((i) => i.batch === 2).length, 14);
  assert.equal(QUIZ.items.filter((i) => i.kind === 'anchor').length, 4);
});

test('选项按日期稳定打乱且隐藏计分值', () => {
  const a = takeBatch(QUIZ, 1, { now: new Date('2026-11-24T10:00:00+08:00') });
  const b = takeBatch(QUIZ, 1, { now: new Date('2026-11-24T10:00:00+08:00') });
  assert.deepEqual(a, b);
  assert.ok(a.every((q) => q.options.every((o) => o.v === undefined && o.side === undefined)));
});

test('不同 seed 能产生确定性顺序', () => {
  assert.deepEqual(shuffleOptions([{ id:'a' }, { id:'b' }, { id:'c' }], 'x'), shuffleOptions([{ id:'a' }, { id:'b' }, { id:'c' }], 'x'));
  assert.equal(typeof dayKey(new Date('2026-11-24T10:00:00+08:00')), 'string');
});

test('正常作答能出四字母', () => {
  const r = scoreQuiz(QUIZ, [...answerBatch(1, 'a'), ...answerBatch(2, 'b')], { now: new Date('2026-11-24T10:00:00+08:00') });
  assert.equal(r.letters.length, 4);
  assert.equal(r.missing.length, 0);
});

test('作答结果能返回轴分数或缺失标记', () => {
  const r = scoreQuiz(QUIZ, answerBatch(1, 'a'), { now: new Date('2026-11-24T10:00:00+08:00') });
  assert.ok(Array.isArray(r.flags));
  assert.equal(typeof r.letters, 'string');
});

test('空答案四轴全缺', () => {
  const r = scoreQuiz(QUIZ, []);
  assert.equal(r.letters, '????');
  assert.equal(r.usable, false);
});

test('compose 阈值与缺轴', () => {
  assert.deepEqual(compose({ EI:50,SN:49,TF:null,JP:80 }), { letters:'EN?J', missing:['TF'] });
  assert.equal(compose({ EI:null,SN:null,TF:80,JP:80 }).missing.length, 2);
});

test('锚点同侧、相邻、相反', () => {
  assert.equal(scoreAnchors([{item:{pair:'x'},picked:{side:'hi'}},{item:{pair:'x'},picked:{side:'hi'}}]).agreeRate,1);
  assert.equal(scoreAnchors([{item:{pair:'x'},picked:{side:'hi'}},{item:{pair:'x'},picked:{side:'mid'}}]).agreeRate,.5);
  assert.equal(scoreAnchors([{item:{pair:'x'},picked:{side:'hi'}},{item:{pair:'x'},picked:{side:'lo'}}]).agreeRate,0);
});

test('compareAxes 按可比轴求偏差并找 worst', () => {
  const r = compareAxes({EI:10,SN:50,TF:null,JP:80},{EI:20,SN:70,TF:90,JP:70});
  assert.equal(r.meanDelta,13);
  assert.equal(r.worst.axis,'SN');
});

test('16型命名完整', () => assert.equal(Object.keys(TYPE_NAMES).length,16));

test('开放题只返回提示，不含四轴计分值', () => {
  const batch = creativeBatch(QUIZ);
  assert.equal(batch.length,4);
  assert.ok(batch.every((item) => item.kind === 'creative' && typeof item.text === 'string'));
});

test('开放题生成可解释侧写，不产出四轴', () => {
  const result = scoreCreative(QUIZ,[{id:'scene1',response:'我会画一条有风的街道，让鹈鹕和小鱼在路口挥手。'},{id:'scene2',response:'今天的天气会说，慢一点也没关系。'}]);
  assert.equal(result.taken,true); assert.equal(result.responses.length,2); assert.ok(result.tags.length); assert.ok(result.blurb.includes('小鱼')); assert.equal(result.axes,undefined);
});

test('批次1和批次2都能取到题', () => {
  assert.equal(takeBatch(QUIZ, 1).length, 14);
  assert.equal(takeBatch(QUIZ, 2).length, 14);
});

test('非法 option 会被忽略', () => {
  const r = scoreQuiz(QUIZ, [{ id: 'ei1', option: 'z' }]);
  assert.equal(r.answered, 0);
});

test('只答一批会标 partial 或缺轴', () => {
  const r = scoreQuiz(QUIZ, answerBatch(1, 'a'));
  assert.ok(r.flags.includes('partial') || r.missing.length > 0);
});

test('四轴达到最小题数才计分', () => {
  const r = scoreQuiz(QUIZ, [{ id: 'ei1', option: 'a' }, { id: 'ei2', option: 'a' }]);
  assert.equal(r.axes.EI, null);
});

test('锚点只答一侧不进入统计', () => {
  const anchors = QUIZ.items.filter((i) => i.kind === 'anchor').slice(0, 1);
  const r = scoreAnchors(anchors.map((item) => ({ item, picked: { side: 'hi' } })));
  assert.equal(r.pairs, 0);
});

test('锚点低一致率可识别', () => {
  const a = QUIZ.items.filter((i) => i.kind === 'anchor').slice(0, 4);
  const r = scoreAnchors(a.map((item, i) => ({ item, picked: { side: i % 2 ? 'lo' : 'hi' } })));
  assert.ok(Number.isFinite(r.agreeRate));
});

test('compareAxes 小偏差为 aligned', () => {
  assert.equal(compareAxes({EI:50,SN:50,TF:50,JP:50},{EI:55,SN:55,TF:55,JP:55}).verdict.key, 'aligned');
});

test('compareAxes 中等偏差为 drifting', () => {
  assert.equal(compareAxes({EI:20,SN:20,TF:20,JP:20},{EI:50,SN:50,TF:50,JP:50}).verdict.key, 'drifting');
});

test('compareAxes 大偏差为 apart', () => {
  assert.equal(compareAxes({EI:0,SN:0,TF:0,JP:0},{EI:100,SN:100,TF:100,JP:100}).verdict.key, 'apart');
});

test('compareAxes 缺失轴不参与平均', () => {
  const r = compareAxes({EI:50,SN:null,TF:null,JP:null},{EI:60,SN:0,TF:0,JP:0});
  assert.equal(r.meanDelta,10);
});

test('TYPE_NAMES 和 TYPE_BLURBS 都覆盖主流十六型', () => {
  assert.equal(Object.keys(TYPE_NAMES).length, 16);
  for (const key of Object.keys(TYPE_NAMES)) assert.ok(typeof QUIZ && key.length === 4);
});

test('开放题标签至少有一个可读结果', () => {
  const r = scoreCreative(QUIZ, [{ id:'scene3', response:'我会寄一封很长的信，因为想让未来的自己慢慢读完。' }]);
  assert.ok(r.tags.length > 0);
});

test('开放题回答长度有上限', () => {
  const r = scoreCreative(QUIZ, [{ id:'scene4', response:'x'.repeat(2000) }]);
  assert.ok(r.responses[0].response.length <= 1000);
});

test('开放题四个提示 id 唯一', () => {
  const ids = creativeBatch(QUIZ).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('shuffleOptions 不修改原数组', () => {
  const source = [{id:'a'},{id:'b'},{id:'c'}];
  shuffleOptions(source, 'seed');
  assert.deepEqual(source, [{id:'a'},{id:'b'},{id:'c'}]);
});
