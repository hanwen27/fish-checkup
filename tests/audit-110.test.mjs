import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectAll, readMemory, readUsage } from '../src/collect.mjs';
import { cacheHealth, latency, stability } from '../src/hardware.mjs';
import { sampleRecentActivity } from '../src/recent-fish.mjs';

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
