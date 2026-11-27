import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectAll, readMemory, readUsage } from '../src/collect.mjs';
import { cacheHealth, latency, stability } from '../src/hardware.mjs';
import { axisEI, axisSN, axisTF } from '../src/behavior.mjs';
import { buildProfile } from '../src/profile.mjs';
import { collectTags, deriveStats } from '../src/tags.mjs';
import { sampleRecentActivity } from '../src/recent-fish.mjs';
import { reportToText } from '../src/report.mjs';

const now = new Date('2026-11-25T12:00:00Z');
const timestamp = '2026-11-25T11:00:00Z';

function withData(run) {
  const dir = mkdtempSync(join(tmpdir(), 'checkup-110-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function row(attempt = {}, extra = {}) {
  return {
    ts: timestamp, role: 'main', sessionId: 'session-a', model: 'model-a',
    attempt: { outcome: 'completed', elapsedMs: 2000, meters: { input: 1000, cachedInput: 0 }, ...attempt },
    ...extra,
  };
}

function readRows(dir, rows) {
  writeFileSync(join(dir, 'usage.jsonl'), `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`);
  return readUsage(dir, { now });
}

test('Long usage logs retain all 12,000 in-window records', () => withData((dir) => {
  const records = Array.from({ length: 12_000 }, (_, i) => row({}, { prefixHash: `${'x'.repeat(560)}${i}` }));
  assert.equal(readRows(dir, records).records.length, 12_000);
}));

test('Cache metrics distinguish missing reports from explicit zero and scope prefixes', () => withData((dir) => {
  const missing = Array.from({ length: 60 }, () => row({ meters: { input: 1000 } }));
  const explicitZero = Array.from({ length: 60 }, () => row());
  const models = Array.from({ length: 60 }, (_, i) => {
    const model = i % 2 ? 'model-a' : 'model-b';
    return row({ origin: { model }, meters: { input: 1000, cachedInput: 900 } }, { model, prefixHash: model });
  });
  assert.equal(cacheHealth(readRows(dir, missing)).score, null);
  assert.equal(cacheHealth(readRows(dir, explicitZero)).score, 33.6);
  assert.equal(cacheHealth(readRows(dir, models)).evidence.find(({ label }) => label === '前缀哈希变化').value, '0 次');
}));

test('Stability excludes discarded, diagnostic, and non-main rows', () => withData((dir) => {
  const actual = Array.from({ length: 60 }, (_, i) => row({ outcome: i < 24 ? 'failed' : 'completed' }));
  const probes = Array.from({ length: 120 }, () => row({ purpose: 'diagnostic' }));
  const dimension = stability(readRows(dir, [...actual, ...probes]));
  assert.equal(dimension.evidence.find(({ label }) => label === '加权失败率').value, '40%');
  const discarded = Array.from({ length: 60 }, () => row({ outcome: 'discarded' }));
  assert.equal(stability(readRows(dir, discarded)).score, null);
}));

test('Future events and invalid durations do not enter the report window', () => withData((dir) => {
  assert.equal(readRows(dir, [row({}, { ts: '2026-12-25T11:00:00Z' })]).records.length, 0);
  const invalid = Array.from({ length: 60 }, () => row({ elapsedMs: -20 }));
  assert.equal(latency(readRows(dir, invalid)).score, null);
}));

test('Undated retrievals are excluded and native video receipts supply their title', () => withData((dir) => {
  mkdirSync(join(dir, 'memory'));
  writeFileSync(join(dir, 'memory', 'retrieve.jsonl'), `${JSON.stringify({ at: 'invalid', hits: ['entry'] })}\n`);
  assert.equal(readMemory(dir, { now }).retrieve.total, 0);
  const activity = sampleRecentActivity([{
    role: 'main', mod: 'bilibili-video', tool: 'bilibili_video_play', ts: timestamp,
    receipt: '开始看《测试片名》,从 0:00 起',
  }]);
  assert.equal(activity.videoStarts, 1);
  assert.equal(activity.media[0].title, '测试片名');
}));

test('Old handoffs stay outside the period while old-mtime logs retain current events', () => withData((dir) => {
  const handoffs = join(dir, 'handoffs');
  mkdirSync(handoffs);
  for (const stamp of ['00-00', '00-30', '01-00', '01-30']) {
    writeFileSync(join(handoffs, `2026-10-01T${stamp}-00Z.md`), 'old handoff');
  }
  const run = join(dir, 'runs', 'r-20261125-110000-test');
  mkdirSync(run, { recursive: true });
  const calls = join(run, 'toolcalls.jsonl');
  writeFileSync(calls, `${JSON.stringify({ ts: timestamp, role: 'main', mod: 'console', tool: 'console_send', args: { text: '本期对话记录' } })}\n`);
  utimesSync(calls, new Date('2026-10-01'), new Date('2026-10-01'));

  const snapshot = collectAll({ botDir: dir, dataDir: dir, memoryDir: dir, now, sampleDays: 7 });
  assert.equal(snapshot.handoffs.files.length, 0);
  assert.equal(snapshot.activity.messages, 1);
}));

test('System-blocked decisions are excluded from speech traits and reported separately', () => withData((dir) => {
  const memoryDir = join(dir, 'memory');
  mkdirSync(memoryDir);
  const eligible = Array.from({ length: 60 }, (_, i) => ({
    at: timestamp, act: i < 30 ? 'answer' : 'silent', len: 24, conf: 0.8,
    chat: i < 30 ? 'group:sample' : 'dm:sample', addressed: i < 10 || i >= 30,
  }));
  const blocked = Array.from({ length: 40 }, () => ({
    at: timestamp, act: 'silent', len: 24, blocks: ['qq-topic-auto-close'],
  }));
  const future = Array.from({ length: 20 }, () => ({
    at: '2026-12-25T11:00:00Z', act: 'answer', len: 32,
  }));
  writeFileSync(join(memoryDir, 'decisions.jsonl'), [...eligible, ...blocked, ...future].map(JSON.stringify).join('\n'));

  const memory = readMemory(dir, { now });
  assert.equal(memory.decisions.total, 60);
  assert.equal(memory.decisions.judgedTotal, 100);
  assert.equal(memory.decisions.blockedCount, 40);
  assert.equal(memory.decisions.speakRate, 0.5);
  assert.equal(memory.decisions.groupDecisionCount, 30);
  assert.equal(memory.decisions.addressedRate, 1 / 3);
  assert.equal(axisEI(memory).score > 0, true);
  assert.equal(memory.profileDecisions.all.total, 60);
  assert.equal(memory.profileDecisions.blocked.total, 40);
  const speech = buildProfile(memory, 'zh').evidence.find(({ id }) => id === 'speech');
  assert.ok(speech.lines.some((line) => line.includes('系统拦截')));
}));

test('Missing emotion annotations stay unknown instead of producing zero-percent personality tags', () => withData((dir) => {
  const memoryDir = join(dir, 'memory');
  mkdirSync(memoryDir);
  const entries = Array.from({ length: 60 }, () => ({ t: timestamp, text: 'A dated memory without emotion labels', tags: [] }));
  writeFileSync(join(memoryDir, 'entries.jsonl'), entries.map(JSON.stringify).join('\n'));

  const memory = readMemory(dir, { now });
  assert.equal(memory.entries.valenceCount, 0);
  assert.equal(memory.entries.valenceNonZeroRatio, null);
  assert.equal(memory.entries.tagDiversity, null);
  assert.equal(axisSN(memory).score, null);
  assert.equal(axisTF(memory).score, null);
  const stats = deriveStats({ memory });
  assert.equal(stats.valenceRatio, null);
  assert.equal(deriveStats({ memory: { entries: { ...memory.entries, valenceNonZeroRatio: 0 } } }).valenceRatio, null);
  const ids = collectTags(stats).tags.map(({ id }) => id);
  assert.ok(!ids.includes('cold-log'));
  assert.deepEqual(buildProfile(memory, 'zh').evidence.find(({ id }) => id === 'emotion').lines, ['记忆未标注情绪字段。']);
}));

test('Emotion ratio excludes unlabelled entries while retaining explicit neutral annotations', () => withData((dir) => {
  const memoryDir = join(dir, 'memory');
  mkdirSync(memoryDir);
  const file = join(memoryDir, 'entries.jsonl');
  const base = { t: timestamp, text: 'A dated memory' };
  const writeEntries = (annotations) => writeFileSync(file, annotations.map((annotation) => JSON.stringify({ ...base, ...annotation })).join('\n'));
  const neutral = [{ emotion: '平静' }, { emotion: { valence: 0 } }, { valence: 0 }];
  writeEntries([{}, { emotion: '' }, { emotion: null }, ...neutral]);
  let memory = readMemory(dir, { now });
  assert.equal(memory.entries.valenceCount, 3);
  assert.equal(memory.entries.valenceNonZeroRatio, 0);
  const tag = collectTags(deriveStats({ memory })).tags.find(({ id }) => id === 'cold-log');
  assert.match(tag.evidence, /已标注情绪.*非中性占 0%/);
  assert.ok(!buildProfile(memory, 'zh').evidence.find(({ id }) => id === 'emotion').lines.includes('记忆未标注情绪字段。'));

  writeEntries([{}, { emotion: 'unknown' }, ...neutral, { emotion: { valence: 0.8 } }, { emotion: '开心' }]);
  memory = readMemory(dir, { now });
  assert.equal(memory.entries.valenceCount, 5);
  assert.equal(memory.entries.valenceNonZeroRatio, 2 / 5);
  const ids = collectTags(deriveStats({ memory })).tags.map(({ id }) => id);
  assert.ok(ids.includes('open-heart'));
  assert.ok(!ids.includes('cold-log'));
}));

test('Personality stability tags share the model-call filter and ignore platform blocks', () => {
  const actual = Array.from({ length: 60 }, (_, i) => ({
    outcome: i < 24 ? 'failed' : 'completed', role: 'main', purpose: 'chat',
  }));
  const diagnostics = Array.from({ length: 120 }, () => ({
    outcome: 'failed', role: 'main', purpose: 'diagnostic',
  }));
  const stats = deriveStats({
    usage: { records: [...actual, ...diagnostics] },
    memory: { decisions: { blockedRate: 0.93 } },
  });
  assert.equal(stats.failRate, 0.4);
  const diagnosticOnly = deriveStats({ usage: { records: diagnostics } });
  assert.equal(diagnosticOnly.failRate, null);
  const ids = collectTags({ ...stats, blockedRate: 0.93 }).tags.map(({ id }) => id);
  assert.ok(!ids.includes('silent-blocked'));
  assert.ok(ids.includes('bad-patch'));
  assert.ok(!ids.includes('rough-patch'));
  const diagnosticIds = collectTags(diagnosticOnly).tags.map(({ id }) => id);
  assert.ok(!diagnosticIds.includes('rough-patch'));
  assert.ok(!diagnosticIds.includes('bad-patch'));
});

test('Near-synonymous tags keep one representative per metric and combos use the displayed evidence', () => {
  const result = collectTags({ failRate: 0.38, speakRate: 1, medianLen: 25, handoffScore: 95,
    entryTotal: 3000, nightShare: 0.6, earlyShare: 0.02, quizTaken: true });
  const ids = result.tags.map(({ id }) => id);
  for (const group of [
    ['bad-patch', 'rough-patch'], ['high-speak', 'asks-back'], ['huge-memory', 'big-memory'], ['deep-night', 'night-owl', 'night-only'],
  ]) assert.deepEqual(ids.filter((id) => group.includes(id)), [group[0]]);
  assert.equal(result.hitCount, result.tags.length);
  assert.equal(Object.values(result.rarity).reduce((a, b) => a + b, 0), result.hitCount);
  assert.deepEqual(result.combos.find(({ id }) => id === 'tired-steady').need, ['最近老出岔子', '交接不乱']);
  assert.ok(!collectTags({ failRate: 0.2 }).tags.some(({ id }) => id === 'bad-patch'));
  assert.ok(collectTags({ failRate: 0.2 }).tags.some(({ id }) => id === 'rough-patch'));
});

test('Brief reports do not assign a root cause to model-request failures', () => {
  const report = {
    language: 'zh',
    hardware: { dimensions: [{ id: 'stability', score: 64 }] },
    summary: { simple: { overall: '有几处可以更好', priority: '稳定性需要留意', next: '看看近期请求记录。' } },
    personality: {},
  };
  const brief = reportToText(report, { mode: 'brief' });
  assert.match(brief, /没有核实失败根因/);
});
