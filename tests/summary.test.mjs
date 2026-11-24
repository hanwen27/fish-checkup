import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSummary } from '../src/summary.mjs';

/** 造一个维度。 */
function d(id, title, score, weight, { state, headline, delta = null, series = [] } = {}) {
  return {
    id,
    title,
    weight,
    score,
    state: state ?? (score === null ? 'unknown' : score >= 80 ? 'ok' : score >= 55 ? 'warn' : 'bad'),
    headline: headline ?? `${title} 的结论。`,
    delta,
    series,
    evidence: [],
    formula: '',
    meaning: '',
  };
}

function hw(dims, extra = {}) {
  const scored = dims.filter((x) => Number.isFinite(x.score));
  const wSum = scored.reduce((a, x) => a + x.weight, 0);
  const overall = scored.length && dims.length - scored.length < 2
    ? Math.round(scored.reduce((a, x) => a + x.score * x.weight, 0) / (wSum || 1))
    : null;
  const levelKey = overall === null ? 'insufficient'
    : overall >= 85 ? 'solid' : overall >= 70 ? 'good' : overall >= 55 ? 'fair' : 'poor';
  return { overall, levelKey, dimensions: dims, unknownCount: dims.length - scored.length, scoredCount: scored.length, ...extra };
}

const SIX = (scores, opts = {}) => hw([
  d('stability', '稳定性', scores[0], 0.22, { delta: opts.stabDelta ?? null, headline: '近 3694 次里 1098 次失败，出错有点频繁。' }),
  d('latency', '响应速度', scores[1], 0.15),
  d('cache', '缓存与成本', scores[2], 0.18),
  d('context', '上下文配置', scores[3], 0.15),
  d('handoff', '交接健康', scores[4], 0.15),
  d('memory', '记忆健康', scores[5], 0.15),
]);

/* ------------------------------------------------------------ 一句话结论 */

test('summary：句子里点最痛的那一项，且不重复状态词', () => {
  const s = buildSummary(SIX([0, 41, 80, 80, 75, 60]), 'zh');
  // 状态词单独显示（stateWord），句子里不再重复它，否则首屏会出现「有点吃力。有点吃力。」
  assert.equal(s.stateWord, '有点吃力');
  assert.equal(s.sentence.includes('有点吃力'), false, `句子不该重复状态词: ${s.sentence}`);
  assert.ok(s.sentence.includes('稳定性'), `应点出最弱项，实际: ${s.sentence}`);
  assert.equal(/^\d/.test(s.sentence), false, '不能一上来就是裸分数');
});

test('summary：始终没有句号叠句号', () => {
  for (const scores of [[0, 41, 80, 80, 75, 60], [100, 100, 100, 100, 100, 100], [70, 72, 71, 73, 74, 75]]) {
    const s = buildSummary(SIX(scores), 'zh');
    assert.equal(s.sentence.includes('。。'), false, s.sentence);
    assert.equal(s.sentence.includes('，。'), false, s.sentence);
  }
});

test('summary：明显下滑时直说在掉，不只报现值', () => {
  const s = buildSummary(SIX([60, 60, 80, 80, 75, 60], { stabDelta: -28 }), 'zh');
  assert.ok(s.sentence.includes('往下掉'), `实际: ${s.sentence}`);
  assert.ok(s.sentence.includes('28'), '要带上具体掉了几分');
});

test('summary：全绿时也点一个最弱的，但说它也在范围里', () => {
  const s = buildSummary(SIX([100, 100, 100, 100, 100, 88]), 'zh');
  assert.equal(s.levelKey, 'solid');
  assert.ok(s.sentence.includes('正常范围') || s.sentence.includes('最弱'), s.sentence);
});

test('summary：全 unknown 时给「看不出来」，不编结论', () => {
  const s = buildSummary(hw([
    d('stability', '稳定性', null, 0.22), d('latency', '响应速度', null, 0.15),
    d('cache', '缓存与成本', null, 0.18), d('context', '上下文配置', null, 0.15),
    d('handoff', '交接健康', null, 0.15), d('memory', '记忆健康', null, 0.15),
  ]), 'zh');
  assert.equal(s.levelKey, 'insufficient');
  assert.ok(s.sentence.includes('没读到') || s.sentence.includes('给不出'), s.sentence);
  assert.equal(s.top.length, 0, '没有分就没有候选');
});

/* ------------------------------------------------------------ 要紧的三件 */

test('summary：top 恰好三条，按「扣分 × 权重」排序', () => {
  const s = buildSummary(SIX([0, 41, 80, 80, 75, 60]), 'zh');
  assert.equal(s.top.length, 3);
  assert.equal(s.top[0].id, 'stability');    // (100-0)*0.22 = 22.0
  assert.equal(s.top[1].id, 'latency');      // (100-41)*0.15 = 8.85
  assert.equal(s.top[2].id, 'memory');       // (100-60)*0.15 = 6.0
  assert.equal(s.rest.length, 3);
  assert.ok(s.rest.every((r) => !s.top.some((t) => t.id === r.id)), 'top 与 rest 不重叠');
});

test('summary：权重大的排前面（同样 50 分时）', () => {
  const s = buildSummary(hw([
    d('stability', '稳定性', 50, 0.22),
    d('latency', '响应速度', 50, 0.15),
    d('cache', '缓存与成本', 50, 0.18),
  ]), 'zh');
  assert.equal(s.top[0].id, 'stability');
  assert.equal(s.top[1].id, 'cache');
  assert.equal(s.top[2].id, 'latency');
});

test('summary：每条都带 trend 文案，null delta 就说没得比', () => {
  const s = buildSummary(SIX([0, 41, 80, 80, 75, 60], { stabDelta: -12 }), 'zh');
  const stab = s.top.find((t) => t.id === 'stability');
  assert.ok(stab.trend.includes('低 12'), stab.trend);
  const lat = s.top.find((t) => t.id === 'latency');
  assert.equal(lat.trend, null, '没有 delta 就不造趋势');
  assert.equal(lat.trendUp, null);
});

test('summary：偏弱维度在回升时不写成「比之前高」（41 分高 32 还是 41 分）', () => {
  const dims = [
    d('stability', '稳定性', 0, 0.22),
    d('latency', '响应速度', 41.4, 0.15, { delta: 32 }),
    d('memory', '记忆健康', 60, 0.15),
  ];
  const s = buildSummary(hw(dims), 'zh');
  const lat = s.top.find((t) => t.id === 'latency');
  assert.ok(lat.trend.includes('回升'), `偏弱项该说「回升」，实际: ${lat.trend}`);
  assert.equal(lat.trend.includes('比之前高'), false);
  assert.ok(lat.trend.includes('32'), '仍要给出幅度');
});

test('summary：正常维度上升就说「比之前高」', () => {
  const dims = [
    d('stability', '稳定性', 90, 0.22, { delta: 12 }),
    d('latency', '响应速度', 20, 0.15),
  ];
  const s = buildSummary(hw(dims), 'zh');
  const stab = s.top.find((t) => t.id === 'stability');
  assert.ok(stab.trend.includes('高 12'), stab.trend);
});

test('summary：小于 5 分的变动不写趋势（风噪）', () => {
  const s = buildSummary(SIX([0, 41, 80, 80, 75, 60], { stabDelta: -3 }), 'zh');
  const stab = s.top.find((t) => t.id === 'stability');
  assert.equal(stab.trend, null, '3 分是噪声，不该写');
});

test('summary：series 原样带出，供画线', () => {
  const series = [{ day: '2026-11-20', n: 10, score: 90 }, { day: '2026-11-21', n: 10, score: 40 }];
  const s = buildSummary(hw([d('stability', '稳定性', 40, 0.22, { series, delta: -50 })]), 'zh');
  assert.deepEqual(s.top[0].series, series);
});

/* ------------------------------------------------------------ 你可以做的 */

test('summary：只给偏弱项建议，最多三条', () => {
  const s = buildSummary(SIX([0, 41, 80, 80, 75, 60]), 'zh');
  assert.ok(s.care.length >= 1 && s.care.length <= 3);
  for (const c of s.care) {
    assert.ok(c.body.length > 5, `${c.id} 的建议不能是空的`);
    const dim = s.top.concat(s.rest).find((x) => x.id === c.id);
    assert.ok(dim.state === 'bad' || dim.state === 'warn', '只对偏弱项给建议');
  }
});

test('summary：全绿时不给建议（没事就别啰嗦）', () => {
  const s = buildSummary(SIX([100, 100, 100, 100, 100, 100]), 'zh');
  assert.deepEqual(s.care, []);
});

/* ------------------------------------------------------------ 英文 & 边界 */

test('summary：英文版有对应文案', () => {
  const s = buildSummary(SIX([0, 41, 80, 80, 75, 60]), 'en');
  assert.ok(s.sentence.length > 0);
  assert.equal(/[\u4e00-\u9fa5]/.test(s.sentence), false, `英文版不该出现中文: ${s.sentence}`);
  assert.ok(s.care.every((c) => !/[\u4e00-\u9fa5]/.test(c.body)));
});

test('summary：同时有弱项和稳项时，先说几项还能更好，再说谁还稳', () => {
  const s = buildSummary(hw([
    d('stability', '稳定性', 60, 0.22),
    d('context', '上下文配置', 100, 0.15),
    d('memory', '记忆健康', 90, 0.15),
  ]), 'zh');
  assert.ok(s.detail.includes('1 项还能更好'), `实得：${s.detail}`);
  assert.ok(s.detail.includes('还稳'), '稳项也要提');
  assert.ok(s.detail.indexOf('还能更好') < s.detail.indexOf('还稳'), '先说要注意的');
});

test('summary：空输入不崩', () => {
  const s = buildSummary({}, 'zh');
  assert.equal(s.top.length, 0);
  assert.equal(s.care.length, 0);
  assert.ok(typeof s.sentence === 'string' && s.sentence.length > 0);
});

test('summary：只缺一维时还能出结论，并说明那维没算', () => {
  const s = buildSummary(hw([
    d('stability', '稳定性', 80, 0.22), d('latency', '响应速度', 80, 0.15),
    d('cache', '缓存与成本', null, 0.18), d('context', '上下文配置', 80, 0.15),
    d('handoff', '交接健康', 80, 0.15), d('memory', '记忆健康', 80, 0.15),
  ]), 'zh');
  assert.ok(Number.isFinite(1) && s.unknown.length === 1);
  assert.equal(s.unknown[0].id, 'cache');
  assert.ok(s.detail.includes('缓存与成本'), `detail 要提到被排除的维度: ${s.detail}`);
});
