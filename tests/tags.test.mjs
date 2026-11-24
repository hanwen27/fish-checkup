/**
 * 标签池的测试。
 * 重点不是「标签够多」，而是三件事：
 *   1. 判定只读数字，不读文本——同输入必须同输出（可复算）；
 *   2. 空数据不崩、不瞎给标签；
 *   3. 稀有度只用能自证的口径，不出现「全网前 N%」这类编造。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveStats, collectTags, TAG_POOL, TIERS, tierBadge, COMBO_POOL } from '../src/tags.mjs';

/** 造一个「什么都没有」的快照。 */
const empty = () => ({ usage: null, config: null, handoffs: null, memory: null });

/** 造一个给定 decisions/entries/retrieve 的 memory 节点。 */
function memoryNode({ decisions = null, entries = null, retrieve = null, emotions = null } = {}) {
  return { ok: true, path: 'memory', decisions, entries, retrieve, emotions, sizes: {} };
}

function decisions({ total = 400, speakRate = 0.1, medianLen = 20, addressedRate = 0.5, blockedRate = 0, hourHistogram = null, hourEntropy = 0.9, kindConcentration = 0.5 } = {}) {
  return {
    total, speakRate, medianLen, addressedRate, blockedRate,
    hourHistogram: hourHistogram ?? new Array(24).fill(total / 24),
    hourEntropy, kindConcentration,
    avgConf: 0.5,
  };
}

function entries({ total = 500, tagCount = 100, tagDiversity = 0.2, invalid = 0, stale = 0, valenceNonZeroRatio = 0.1 } = {}) {
  return { total, invalid, stale, recent: 0, tagCount, tagDiversity, valenceNonZeroRatio, avgWeight: 0.2 };
}

/* ------------------------------------------------------------ 事实表 */

test('deriveStats：空快照不崩，全部给 null 或 0', () => {
  const s = deriveStats(empty());
  assert.equal(s.nightShare, null);
  assert.equal(s.medianLen, null);
  assert.equal(s.entryTotal, 0);
  assert.equal(s.quizTaken, false);
});

test('deriveStats：夜生活占比按小时直方图算，23 点与 0 点都算夜里', () => {
  const hours = new Array(24).fill(0);
  hours[23] = 30;
  hours[0] = 20;
  hours[12] = 50;
  const s = deriveStats({ memory: memoryNode({ decisions: decisions({ total: 100, hourHistogram: hours }) }) });
  assert.equal(s.nightShare, 0.5);
});

test('deriveStats：早起占比取 5–9 点', () => {
  const hours = new Array(24).fill(0);
  hours[6] = 25;
  hours[7] = 25;
  hours[20] = 50;
  const s = deriveStats({ memory: memoryNode({ decisions: decisions({ total: 100, hourHistogram: hours }) }) });
  assert.equal(s.earlyShare, 0.5);
});

/* ------------------------------------------------------------ 判定 */

test('collectTags：全空快照不编数据标签，只诚实说还没做题', () => {
  const r = collectTags(deriveStats(empty()));
  const ids = r.tags.map((t) => t.id);
  // 唯一能成立的只有「还没做过题」——它说的是事实，不是推断。
  assert.deepEqual(ids, ['untested']);
  assert.ok(r.nickname.includes('小鱼'));
  assert.ok(typeof r.verdict === 'string' && r.verdict.length > 0);
});

test('collectTags：夜猫子 + 惜字如金 同时命中，档位高的排前面', () => {
  const hours = new Array(24).fill(0);
  hours[23] = 60;
  hours[1] = 40;
  const s = deriveStats({
    memory: memoryNode({
      decisions: decisions({ total: 100, medianLen: 12, hourHistogram: hours }),
    }),
  });
  const r = collectTags(s);
  const ids = r.tags.map((t) => t.id);
  assert.ok(ids.includes('night-owl'));
  assert.ok(ids.includes('ultra-terse'));
  // 深夜档 3 > 夜行档 2，所以 deep-night 若命中必然排在 night-owl 前
  assert.ok(r.tags[0].tier >= r.tags[r.tags.length - 1].tier);
});

test('collectTags：同输入两次结果完全一致（可复算）', () => {
  const build = () => deriveStats({
    memory: memoryNode({
      decisions: decisions({ total: 200, medianLen: 25 }),
      entries: entries({ total: 800, tagCount: 400 }),
      retrieve: { total: 100, hitRate: 0.05, avgMs: 60, avgQueryLen: 35, injectedRate: 0.5 },
    }),
  });
  const a = collectTags(build());
  const b = collectTags(build());
  assert.deepEqual(a.tags.map((t) => t.id), b.tags.map((t) => t.id));
  assert.equal(a.nickname, b.nickname);
});

test('collectTags：外号用「主标签 · 异组标签」拼，避免三条堆在一起念不通', () => {
  const s = deriveStats({
    memory: memoryNode({
      entries: entries({ total: 3000, tagCount: 600 }),
      retrieve: { total: 100, hitRate: 0.7, avgMs: 50, avgQueryLen: 10, injectedRate: 0.5 },
    }),
  });
  const r = collectTags(s);
  assert.ok(r.tags.length >= 2);
  const head = r.tags[0];
  const partner = r.tags.find((t) => t.group !== head.group);
  const expected = partner ? `${head.nick} · ${partner.nick}小鱼` : `${head.nick}小鱼`;
  assert.equal(r.nickname, expected);
});

test('collectTags：全部命中同一组时外号退化成单标签', () => {
  const hours = new Array(24).fill(0);
  hours[23] = 100;
  const s = deriveStats({ memory: memoryNode({ decisions: decisions({ total: 100, hourHistogram: hours, hourEntropy: 0.3 }) }) });
  const r = collectTags(s);
  const groups = new Set(r.tags.map((t) => t.group));
  if (groups.size === 1) assert.equal(r.nickname, `${r.tags[0].nick}小鱼`);
});

test('collectTags：嘴上说不要只在自述与行为差 ≥25 时命中', () => {
  const far = deriveStats(
    { memory: memoryNode({ decisions: decisions({ total: 200, speakRate: 0.05 }) }) },
    { behavior: { axes: [{ score: 10 }, { score: 50 }, { score: 50 }, { score: 50 }] }, quiz: { axes: { EI: 90, SN: 50, TF: 50, JP: 50 } } },
  );
  assert.ok(collectTags(far).tags.some((t) => t.id === 'plays-cool'));

  const near = deriveStats(
    { memory: memoryNode({ decisions: decisions({ total: 200, speakRate: 0.05 }) }) },
    { behavior: { axes: [{ score: 88 }, { score: 50 }, { score: 50 }, { score: 50 }] }, quiz: { axes: { EI: 90, SN: 50, TF: 50, JP: 50 } } },
  );
  assert.equal(collectTags(near).tags.some((t) => t.id === 'plays-cool'), false);
});

test('collectTags：没做测验时给「还没做过题」，不给自述对比类标签', () => {
  const s = deriveStats({ memory: memoryNode({ decisions: decisions({ total: 200 }) }) });
  const r = collectTags(s);
  assert.ok(r.tags.some((t) => t.id === 'untested'));
  assert.equal(r.tags.some((t) => t.id === 'knows-self'), false);
  assert.equal(r.tags.some((t) => t.id === 'plays-cool'), false);
});

test('标签池：每条都有 nick / roast / 可调用的判定与依据', () => {
  assert.ok(TAG_POOL.length >= 40, `池子只有 ${TAG_POOL.length} 条`);
  const ids = new Set();
  const stats = deriveStats(empty());
  for (const tag of TAG_POOL) {
    assert.ok(!ids.has(tag.id), `id 重复：${tag.id}`);
    ids.add(tag.id);
    assert.ok(tag.nick && tag.nick.length <= 4, `${tag.id} 的 nick 太长或为空`);
    assert.ok(tag.roast && tag.roast.length > 4, `${tag.id} 缺判词`);
    assert.equal(typeof tag.test, 'function');
    assert.equal(typeof tag.evidence, 'function');
    // 空数据下判定不该抛错
    assert.doesNotThrow(() => tag.test(stats));
    assert.doesNotThrow(() => tag.evidence(stats));
    assert.ok(TIERS[tag.tier], `${tag.id} 档位非法`);
  }
});

test('稀有度：口径是同池命中数，不出现全网百分比', () => {
  const s = deriveStats({
    memory: memoryNode({ decisions: decisions({ total: 200, medianLen: 10 }) }),
  });
  const r = collectTags(s);
  assert.equal(typeof r.hitCount, 'number');
  assert.equal(r.pool, TAG_POOL.length);
  const counted = Object.values(r.rarity).reduce((a, b) => a + b, 0);
  assert.equal(counted, r.hitCount);
  const text = JSON.stringify(r);
  assert.equal(/前\s*\d+%|top\s*\d+%/.test(text), false, '不该出现编造的全网排名');
});

test('tierBadge：未知档位回落到常见，不返回 undefined', () => {
  assert.equal(tierBadge(1).label, '常见');
  assert.equal(tierBadge(99).label, '常见');
});

/* ------------------------------------------------------------ 组合彩蛋 */

test('组合：空数据不给任何组合', () => {
  const r = collectTags(deriveStats(empty()));
  assert.deepEqual(r.combos, []);
  assert.equal(r.comboPool, COMBO_POOL.length);
});

test('组合：两条都命中才解锁', () => {
  const both = deriveStats({
    memory: memoryNode({ retrieve: { total: 300, hitRate: 0.7, avgMs: 60, avgQueryLen: 12, injectedRate: 0.5 }, entries: entries({ total: 3000 }) }),
  });
  const ids = collectTags(both).tags.map((t) => t.id);
  // 「不用叫，也记得住」要 comes-anyway + sharp-hit 同时成立
  const got = collectTags(both).combos.map((c) => c.id);
  const expect = ids.includes('comes-anyway') && ids.includes('sharp-hit');
  assert.equal(got.includes('knows-you'), expect);
});

test('组合：need 里的 id 都能在池子里找到，标题与说明不为空', () => {
  const poolIds = new Set(TAG_POOL.map((t) => t.id));
  const seen = new Set();
  for (const c of COMBO_POOL) {
    assert.ok(!seen.has(c.id), `组合 id 重复：${c.id}`);
    seen.add(c.id);
    assert.ok(c.need.length >= 2, `${c.id} 至少要两条标签`);
    for (const id of c.need) assert.ok(poolIds.has(id), `${c.id} 引用了不存在的标签：${id}`);
    assert.ok(c.title && c.title.length >= 3, `${c.id} 缺标题`);
    assert.ok(c.blurb && c.blurb.length > 10, `${c.id} 缺说明`);
  }
});

test('组合：按档位降序，且不回带未命中的标签名', () => {
  const s = deriveStats({
    memory: memoryNode({
      decisions: decisions({ total: 400, medianLen: 15, speakRate: 0.05, hourHistogram: (() => { const h = new Array(24).fill(0); h[1] = 200; h[23] = 200; return h; })() }),
    }),
  });
  const r = collectTags(s);
  for (let i = 1; i < r.combos.length; i += 1) {
    assert.ok(r.combos[i - 1].tier >= r.combos[i].tier, '组合应按档位降序');
  }
  const hitLabels = new Set(r.tags.map((t) => t.label));
  for (const c of r.combos) {
    for (const label of c.need) assert.ok(hitLabels.has(label), `组合 ${c.id} 的 need 出现了未命中的标签：${label}`);
  }
});
