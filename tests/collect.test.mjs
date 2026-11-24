import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUsage, readRuntimeConfig, readHandoffs, readMemory, collectAll } from '../src/collect.mjs';

function tempTree() {
  const root = mkdtempSync(join(tmpdir(), 'sc-collect-'));
  const botDir = join(root, 'bot');
  const dataDir = join(botDir, 'data');
  const memoryDir = join(botDir, 'workspace');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(memoryDir, 'memory'), { recursive: true });
  mkdirSync(join(memoryDir, 'handoffs'), { recursive: true });
  return { root, botDir, dataDir, memoryDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const nowMs = Date.parse('2026-11-24T00:00:00+08:00');
const now = new Date(nowMs);

function usageLine({ ts, outcome = 'completed', elapsedMs = 2000, input = 1000, cached = 900, hash = 'h1' }) {
  return JSON.stringify({
    version: 2,
    attempt: {
      id: 'a', generationId: 'g', ordinal: 0,
      origin: { instance: 'deepseek', module: 'coo', model: 'deepseek-flash' },
      startedAt: new Date(ts).toISOString(), elapsedMs, outcome, status: 200, purpose: 'generation',
      meters: { input, output: 10, total: input + 10, cachedInput: cached, uncachedInput: input - cached, reasoning: null },
    },
    ts: new Date(ts).toISOString(),
    sessionId: 's', role: 'x', label: 'x', model: 'deepseek-flash',
    promptTokens: input, completionTokens: 10, cacheHitTokens: cached, cacheMissTokens: input - cached,
    prefixHash: hash, run: 'r', round: 1, recordId: 'rid',
  });
}

/* ------------------------------------------------------------ usage */

test('readUsage：文件不存在返回 ok=false，不抛错', () => {
  const t = tempTree();
  try {
    const r = readUsage(t.dataDir, { sampleDays: 7, now });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
    assert.deepEqual(r.records, []);
  } finally { t.cleanup(); }
});

test('readUsage：正常解析出字段', () => {
  const t = tempTree();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => usageLine({ ts: nowMs - i * 60000 }));
    writeFileSync(join(t.dataDir, 'usage.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const r = readUsage(t.dataDir, { sampleDays: 7, now });
    assert.equal(r.ok, true);
    assert.equal(r.records.length, 10);
    const rec = r.records[0];
    assert.equal(rec.outcome, 'completed');
    assert.equal(rec.elapsedMs, 2000);
    assert.equal(rec.input, 1000);
    assert.equal(rec.cachedInput, 900);
    assert.equal(rec.prefixHash, 'h1');
  } finally { t.cleanup(); }
});

test('readUsage：末行是写一半的 JSON → 跳过并计入 skippedLines', () => {
  const t = tempTree();
  try {
    const body = `${usageLine({ ts: nowMs })}\n{"version":2,"attempt":{"id":"broken`;
    writeFileSync(join(t.dataDir, 'usage.jsonl'), body, 'utf8');
    const r = readUsage(t.dataDir, { sampleDays: 7, now });
    assert.equal(r.records.length, 1);
    assert.ok(r.skippedLines >= 1, `skipped=${r.skippedLines}`);
  } finally { t.cleanup(); }
});

test('readUsage：窗口外的旧记录被排除', () => {
  const t = tempTree();
  try {
    const lines = [
      usageLine({ ts: nowMs - 20 * 86400000 }),
      usageLine({ ts: nowMs - 3600000 }),
    ];
    writeFileSync(join(t.dataDir, 'usage.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const r = readUsage(t.dataDir, { sampleDays: 7, now });
    assert.equal(r.records.length, 1);
  } finally { t.cleanup(); }
});

test('readUsage：大文件只读尾部，不整读', () => {
  const t = tempTree();
  try {
    // 造 5000 行；maxLines 默认 20000，所以全都在尾部窗口里。
    const lines = Array.from({ length: 5000 }, (_, i) => usageLine({ ts: nowMs - i * 1000 }));
    writeFileSync(join(t.dataDir, 'usage.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    const r = readUsage(t.dataDir, { sampleDays: 7, now });
    assert.equal(r.ok, true);
    assert.equal(r.records.length, 5000);
    assert.equal(r.skippedLines, 0);
  } finally { t.cleanup(); }
});

/* ------------------------------------------------------------ config */

test('readRuntimeConfig：只取 context / rounds / activeProvider', () => {
  const t = tempTree();
  try {
    writeFileSync(join(t.botDir, 'config.json'), JSON.stringify({
      displayName: 'x',
      activeProvider: 'qwen',
      context: { maxTokens: 256000, keepRatio: 0.25, softRatio: 0.85, firstTurn: false },
      rounds: { soft: 20, hard: 40 },
      worlds: { secret: { token: 'should-not-be-read' } },
    }), 'utf8');
    const r = readRuntimeConfig(t.botDir);
    assert.equal(r.ok, true);
    assert.equal(r.activeProvider, 'qwen');
    assert.equal(r.context.maxTokens, 256000);
    assert.equal(r.rounds.hard, 40);
    assert.equal(r.worlds, undefined, '不应带出其他字段');
  } finally { t.cleanup(); }
});

test('readRuntimeConfig：缺文件 → ok=false', () => {
  const t = tempTree();
  try {
    const r = readRuntimeConfig(t.botDir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
  } finally { t.cleanup(); }
});

test('readRuntimeConfig：坏 JSON → ok=false 且带错误信息，不抛错', () => {
  const t = tempTree();
  try {
    writeFileSync(join(t.botDir, 'config.json'), '{ not json', 'utf8');
    const r = readRuntimeConfig(t.botDir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /unreadable/);
  } finally { t.cleanup(); }
});

/* ------------------------------------------------------------ handoffs */

test('readHandoffs：按文件名时间排序，取最近 N 份', () => {
  const t = tempTree();
  try {
    const dir = join(t.memoryDir, 'handoffs');
    for (const stamp of ['20261120-1000', '20261121-1000', '20261122-1000', '20261123-1000', '20261124-0000']) {
      writeFileSync(join(dir, `${stamp}-auto.md`), `body ${stamp}\n`.repeat(30), 'utf8');
    }
    const r = readHandoffs(t.memoryDir, { limit: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.files.length, 3);
    assert.equal(r.files[0].name, '20261122-1000-auto.md');
    assert.equal(r.files[2].name, '20261124-0000-auto.md');
    assert.equal(r.total, 5);
  } finally { t.cleanup(); }
});

test('readHandoffs：目录不存在 → ok=false', () => {
  const t = tempTree();
  try {
    rmSync(join(t.memoryDir, 'handoffs'), { recursive: true, force: true });
    const r = readHandoffs(t.memoryDir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
  } finally { t.cleanup(); }
});

test('readHandoffs：带 sha1，内容相同的两份指纹一样', () => {
  const t = tempTree();
  try {
    const dir = join(t.memoryDir, 'handoffs');
    writeFileSync(join(dir, '20261122-1000-auto.md'), 'same body', 'utf8');
    writeFileSync(join(dir, '20261123-1000-auto.md'), 'same body', 'utf8');
    const r = readHandoffs(t.memoryDir);
    assert.equal(r.files[0].sha1, r.files[1].sha1);
  } finally { t.cleanup(); }
});

/* ------------------------------------------------------------ memory */

function writeMemory(dir, name, rows) {
  writeFileSync(join(dir, name), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

test('readMemory：entries / retrieve / emotions / decisions 都能聚合', () => {
  const t = tempTree();
  try {
    const dir = join(t.memoryDir, 'memory');
    writeMemory(dir, 'entries.jsonl', [
      { id: 'e1', t: new Date(nowMs - 3600000).toISOString(), tags: ['a', 'b'], valence: 0.2, weight: 0.3, invalid: false, lastHitAt: new Date(nowMs).toISOString() },
      { id: 'e2', t: new Date(nowMs - 7200000).toISOString(), tags: ['a'], valence: 0, weight: 0.1, invalid: true, lastHitAt: '' },
    ]);
    writeMemory(dir, 'retrieve.jsonl', [
      { at: new Date(nowMs - 60000).toISOString(), query: '今天吃什么', hits: [{ id: 'e1' }], injected: true, ms: 120 },
      { at: new Date(nowMs - 120000).toISOString(), query: '你好', hits: [], injected: false, ms: 80 },
    ]);
    writeMemory(dir, 'emotions.jsonl', [
      { at: new Date(nowMs - 60000).toISOString(), valence: 0.3, arousal: 0.4 },
      { at: new Date(nowMs - 120000).toISOString(), valence: -0.1, arousal: 0.2 },
    ]);
    writeMemory(dir, 'decisions.jsonl', [
      { at: new Date(nowMs - 60000).toISOString(), act: 'speak', len: 30, conf: 0.8, kind: 'statement', addressed: true, blocks: [] },
      { at: new Date(nowMs - 120000).toISOString(), act: 'silent', len: 0, conf: 0.3, kind: 'statement', addressed: false, blocks: ['low-confidence'] },
    ]);

    const r = readMemory(t.memoryDir, { sampleDays: 7, now });
    assert.equal(r.ok, true);
    assert.equal(r.entries.total, 2);
    assert.equal(r.entries.invalid, 1);
    assert.equal(r.entries.tagCount, 2);
    assert.equal(r.retrieve.total, 2);
    assert.equal(r.retrieve.hitRate, 0.5);
    assert.equal(r.retrieve.avgMs, 100);
    assert.equal(r.emotions.count, 2);
    assert.equal(r.decisions.total, 2);
    assert.equal(r.decisions.speakRate, 0.5);
    assert.equal(r.decisions.medianLen, 15);
  } finally { t.cleanup(); }
});

test('readMemory：目录里没有可识别文件 → ok=false', () => {
  const t = tempTree();
  try {
    const r = readMemory(t.memoryDir, { sampleDays: 7, now });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-recognised-files');
  } finally { t.cleanup(); }
});

test('readMemory：坏行被跳过，不打断聚合', () => {
  const t = tempTree();
  try {
    const dir = join(t.memoryDir, 'memory');
    writeFileSync(join(dir, 'entries.jsonl'), `${JSON.stringify({ id: 'e1', t: new Date(nowMs).toISOString(), tags: ['a'], invalid: false })}\n{oops\n`, 'utf8');
    const r = readMemory(t.memoryDir, { sampleDays: 7, now });
    assert.equal(r.ok, true);
    assert.equal(r.entries.total, 1);
  } finally { t.cleanup(); }
});

/* ------------------------------------------------------------ collectAll */

test('collectAll：四类都缺也返回结构完整、problems 有记录', () => {
  const t = tempTree();
  try {
    const snap = collectAll({ botDir: t.botDir, dataDir: t.dataDir, memoryDir: t.memoryDir, sampleDays: 7, now });
    assert.equal(snap.usage.ok, false);
    assert.equal(snap.config.ok, false);
    // handoffs 目录存在但为空：读得到，只是没内容——由打分侧判 unknown。
    assert.equal(snap.handoffs.ok, true);
    assert.deepEqual(snap.handoffs.files, []);
    assert.equal(snap.memory.ok, false);
    assert.ok(snap.problems.length >= 3);
    assert.equal(snap.sampleDays, 7);
    assert.ok(Number.isFinite(snap.collectedAt));
  } finally { t.cleanup(); }
});

test('collectAll：只读，不写任何文件到被扫描的目录', () => {
  const t = tempTree();
  try {
    writeFileSync(join(t.dataDir, 'usage.jsonl'), `${usageLine({ ts: nowMs })}\n`, 'utf8');
    const before = readdirSync(t.dataDir).sort();
    collectAll({ botDir: t.botDir, dataDir: t.dataDir, memoryDir: t.memoryDir, sampleDays: 7, now });
    const after = readdirSync(t.dataDir).sort();
    assert.deepEqual(after, before);
    // 也不该在 botDir 下新建 self-checkup（采集层不负责落盘）。
    assert.equal(readdirSync(t.botDir).includes('self-checkup'), false);
  } finally { t.cleanup(); }
});
