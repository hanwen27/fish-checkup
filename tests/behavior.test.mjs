import test from 'node:test';
import assert from 'node:assert/strict';

import { axisEI, axisSN, axisTF, axisJP, runBehavior, composeLetters } from '../src/behavior.mjs';

/** 造一份 memory 快照；任何字段传 undefined 就保持默认。 */
function memory(over = {}) {
  return {
    ok: true,
    entries: {
      total: 1000, invalid: 10, stale: 100, recent: 300, tagCount: 200,
      tagDiversity: 0.2, valenceNonZeroRatio: 0.3, avgWeight: 0.2,
      ...(over.entries ?? {}),
    },
    retrieve: { total: 500, hitRate: 0.6, injectedRate: 0.4, avgMs: 120, avgQueryLen: 20, ...(over.retrieve ?? {}) },
    emotions: { count: 300, meanValence: 0, meanArousal: 0.2, valenceSd: 0.2, arousalSd: 0.15, trend: 0, ...(over.emotions ?? {}) },
    decisions: {
      total: 800, speakRate: 0.35, medianLen: 30, avgConf: 0.5,
      addressedRate: 0.3, blockedRate: 0.1, kindConcentration: 0.5,
      hourEntropy: 0.8, hourHistogram: new Array(24).fill(0),
      ...(over.decisions ?? {}),
    },
    ...(over.root ?? {}),
  };
}

/* ------------------------------------------------------------ EI */

test('EI：回应率高且话长 → 偏 E', () => {
  const r = axisEI(memory({ decisions: { speakRate: 0.75, medianLen: 70 } }));
  assert.ok(r.score > 80, `got ${r.score}`);
});

test('EI：基本不出声且话短 → 偏 I', () => {
  const r = axisEI(memory({ decisions: { speakRate: 0.08, medianLen: 23 } }));
  assert.ok(r.score < 25, `got ${r.score}`);
});

test('EI：样本不足 50 → null，不猜', () => {
  const r = axisEI(memory({ decisions: { total: 30 } }));
  assert.equal(r.score, null);
  assert.ok(r.note.includes('30'));
});

test('EI：证据里带开口率与中位长度', () => {
  const r = axisEI(memory());
  const labels = r.evidence.map((e) => e.label);
  assert.ok(labels.includes('真正开口'));
  assert.ok(labels.includes('中位长度'));
});

/* ------------------------------------------------------------ SN */

test('SN：标签多样性低且检索词短 → 偏 S（高分端）', () => {
  const r = axisSN(memory({ entries: { tagDiversity: 0.05 }, retrieve: { avgQueryLen: 5 } }));
  assert.ok(r.score > 80, `got ${r.score}`);
});

test('SN：标签分散且检索词长 → 偏 N（低分端）', () => {
  const r = axisSN(memory({ entries: { tagDiversity: 0.45 }, retrieve: { avgQueryLen: 38 } }));
  assert.ok(r.score < 20, `got ${r.score}`);
});

test('SN：条目不足 50 → null', () => {
  const r = axisSN(memory({ entries: { total: 20 } }));
  assert.equal(r.score, null);
});

/* ------------------------------------------------------------ TF */

test('TF：情绪平稳且条目不带情绪 → 偏 T（高分端）', () => {
  const r = axisTF(memory({
    emotions: { arousalSd: 0.02 },
    entries: { valenceNonZeroRatio: 0.02 },
    decisions: { avgConf: 0.8 },
  }));
  assert.ok(r.score > 80, `got ${r.score}`);
});

test('TF：情绪波动大且条目常带情绪 → 偏 F（低分端）', () => {
  const r = axisTF(memory({
    emotions: { arousalSd: 0.34 },
    entries: { valenceNonZeroRatio: 0.9 },
    decisions: { avgConf: 0.1 },
  }));
  assert.ok(r.score < 20, `got ${r.score}`);
});

test('TF：情绪序列与条目都太少 → null', () => {
  const r = axisTF(memory({ emotions: { count: 5 }, entries: { total: 10 } }));
  assert.equal(r.score, null);
});

/* ------------------------------------------------------------ JP */

test('JP：作息规律且话题集中 → 偏 J（高分端）', () => {
  const r = axisJP(memory({ decisions: { hourEntropy: 0.05, kindConcentration: 1 } }));
  assert.ok(r.score > 85, `got ${r.score}`);
});

test('JP：全天均匀且话题分散 → 偏 P（低分端）', () => {
  const r = axisJP(memory({ decisions: { hourEntropy: 1, kindConcentration: 0.2 } }));
  assert.ok(r.score < 20, `got ${r.score}`);
});

test('JP：判断样本不足 → null', () => {
  const r = axisJP(memory({ decisions: { total: 10 } }));
  assert.equal(r.score, null);
});

/* ------------------------------------------------------------ 组合 */

test('runBehavior：四轴齐 → 完整四字母', () => {
  const r = runBehavior({ memory: memory() });
  assert.match(r.letters, /^[EI][SN][TF][JP]$/);
  assert.equal(r.complete, true);
  assert.equal(r.axes.length, 4);
});

test('runBehavior：空快照 → 全缺，usable=false', () => {
  const r = runBehavior({});
  assert.equal(r.letters, '????');
  assert.equal(r.usable, false);
  assert.equal(r.missing.length, 4);
});

test('runBehavior：缺一轴仍 usable（三字母 + 一个 ?）', () => {
  const r = runBehavior({ memory: memory({ decisions: { total: 10 } }) }); // EI 与 JP 都会缺
  assert.ok(r.missing.length >= 1);
  assert.equal(r.letters.length, 4);
});

test('composeLetters：50 取前一个字母', () => {
  const r = composeLetters([
    { axis: 'EI', score: 50 }, { axis: 'SN', score: 50 },
    { axis: 'TF', score: 50 }, { axis: 'JP', score: 50 },
  ]);
  assert.equal(r.letters, 'ESTJ');
});

test('composeLetters：49 取后一个字母', () => {
  const r = composeLetters([
    { axis: 'EI', score: 49 }, { axis: 'SN', score: 49 },
    { axis: 'TF', score: 49 }, { axis: 'JP', score: 49 },
  ]);
  assert.equal(r.letters, 'INFP');
});
