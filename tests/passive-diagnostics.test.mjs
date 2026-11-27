import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeUsage, buildTokenReport, buildContextReport, buildMemoryReport, readBoundedJsonl, collectPassiveDiagnostics, passiveReportText } from '../src/passive-diagnostics.mjs';

const until = Date.parse('2026-11-27T15:00:00Z'), since = until - 7 * 86400000;
const record = (overrides = {}) => ({ ts: '2026-11-26T14:00:00Z', model: 'model-A', role: 'main', sessionId: 'main', run: 'r1', promptTokens: 100, completionTokens: 20, ...overrides });
const normal = (rows) => normalizeUsage(rows, { since, until });
const report = (rows) => buildTokenReport(normal(rows).records, { since, until, timezone: 'Asia/Shanghai', source: { state: 'ready' } });
const temporary = (t) => { const dir = mkdtempSync(join(tmpdir(), 'checkup-passive-')); t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); rmSync(dir, { recursive: true, force: true }); }); return dir; };

test('usage v2 unknown meters do not fall back to compatibility zeros; explicit zero remains known', () => {
  const x = report([record({ promptTokens: 0, completionTokens: 0, attempt: { meters: { input: null, output: null } } }), record({ promptTokens: 0, completionTokens: 0 })]);
  assert.equal(x.requests, 2); assert.equal(x.complete, 1); assert.equal(x.inputKnown, 1); assert.equal(x.knownTotal, 0); assert.equal(x.missingInput, 1);
  assert.equal(report([record({ attempt: { meters: { input: null, output: null } } })]).knownTotal, null);
});
test('all billable categories count; World meters stay disjoint from shared requests', () => {
  const x = report([record({ outcome: 'failed' }), record({ outcome: 'discarded' }), record({ role: 'fork' }), record({ attempt: { purpose: 'diagnostic', meters: { input: 10, output: 2 } } }), record({ sessionId: 'worlds.plugin-X', role: 'worlds.plugin-X' })]);
  assert.equal(x.knownTotal, 492); assert.equal(x.failedKnown, 240); assert.equal(x.worldReported[0].knownTotal, 120); assert.equal(x.shared.knownTotal, 372); assert.equal(x.requests, 5);
});
test('invalid, future and out-of-window records are excluded; explicit IDs alone deduplicate', () => {
  const x = normal([record({ recordId: 'same' }), record({ recordId: 'same' }), record(), record(), record({ ts: 'bad' }), record({ ts: '2027-01-01' }), record({ ts: '2026-10-01' })]);
  assert.equal(x.records.length, 3); assert.equal(x.duplicates, 1); assert.equal(x.invalidTime, 1); assert.equal(x.excludedTime, 2);
  const repeated = normal([record({ recordId: 'record1', attempt: { id: 'attempt1' } }), record({ recordId: 'record2', attempt: { id: 'attempt1' } })]);
  assert.equal(repeated.records.length, 1); assert.equal(repeated.duplicates, 1);
});
test('cache denominator only uses paired reports; invalid caches excluded; reasoning is not added', () => {
  const x = report([record({ cacheHitTokens: 50, reasoningTokens: 5 }), record(), record({ cacheHitTokens: 200 })]);
  assert.equal(x.knownTotal, 360); assert.equal(x.cacheRate, .5); assert.equal(x.cacheKnown, 1); assert.equal(x.cached, 50); assert.equal(x.uncachedPaired, 50); assert.equal(x.reasoning, 5);
});
test('hourly and daily aggregation obey the deployment timezone', () => {
  const x = report([record({ ts: '2026-11-26T18:00:00Z' })]);
  assert.equal(x.days[0].name, '2026-11-27'); assert.equal(x.hours[0].name, '02:00');
});
test('historical reference requires four qualified complete dates and no partial current date', () => {
  const rows = []; for (const day of [22, 23, 24, 25]) for (let i = 0; i < 5; i++) rows.push(record({ ts: `2026-11-${day}T04:00:00Z`, promptTokens: day === 25 ? 400 : 100 }));
  for (let i = 0; i < 6; i++) rows.push(record({ ts: '2026-11-27T02:00:00Z', promptTokens: 90000 }));
  const x = report(rows); assert.equal(x.comparisons.length, 1); assert.equal(x.comparisons[0].day, '2026-11-25'); assert.equal(x.comparisons[0].state, 'higher'); assert.equal(x.comparisons[0].baseline, 120);
  assert.equal(report(rows.slice(0, 15)).comparisons.length, 0);
});
test('bounded tail reader discards incomplete prefix and reports sample limits and malformed lines', (t) => {
  const dir = temporary(t), file = join(dir, 'usage.jsonl');
  writeFileSync(file, JSON.stringify(record()) + '\nBAD\n' + JSON.stringify(record({ promptTokens: 12 })) + '\n');
  const x = readBoundedJsonl(file, { lines: 2 }); assert.equal(x.limited, true); assert.equal(x.bad, 1); assert.equal(x.rows.length, 1);
  const y = readBoundedJsonl(file, { bytes: Buffer.byteLength(JSON.stringify(record({ promptTokens: 12 }))) + 2 }); assert.equal(y.limited, true); assert.equal(y.rows[0].promptTokens, 12);
});
test('memory records never equate installation or tool activity to a tested active memory chain', () => {
  const m = buildMemoryReport({ memory: { base: { state: 'ready', readable: 7 } } }, { inventory: { status: 'read', rows: [{ id: 'plugin-X', name: '任意记忆插件', enabled: false, version: 'v1', kind: 'world', secret: 'PRIVATE' }] }, activity: { rows: [{ id: 'plugin-X', calls: 3 }] } });
  assert.equal(m.inventoryState, 'ready'); assert.equal(m.rows[1].enabled, false); assert.equal(m.rows[1].active, null); assert.equal(m.testedImplementations, 0); assert.equal(m.rows[1].tested, false);
  assert.doesNotMatch(JSON.stringify(m), /PRIVATE/); assert.match(m.rows[1].evidence, /3 次/);
});
test('memory without a host inventory never claims no plugins or successful native testing', () => {
  const m = buildMemoryReport({ memory: { base: { state: 'missing' } } }); assert.match(m.summary, /无法确认/); assert.equal(m.rows.length, 1); assert.equal(m.testedImplementations, 0);
});
test('context excludes mtime-only handoff dates and diagnostics, and never invents live occupancy', () => {
  const s = { config: { context: { maxTokens: 128000, softRatio: .85, keepRatio: .25 } }, handoffs: { ok: true, files: [{ ts: until - 1000, timeSource: 'mtime' }, { ts: until - 1000, timeSource: 'filename' }] } };
  const x = buildContextReport(normal([record(), record({ attempt: { purpose: 'diagnostic', meters: { input: 50000, output: 1 } } })]).records, s, { contextWindow: 256000, since, until });
  assert.equal(x.inputSamples, 1); assert.equal(x.handoffs, 1); assert.equal(x.configured, 128000); assert.equal(x.modelWindow, 256000); assert.equal(x.currentOccupancy, null); assert.equal(x.effectiveInputLimit, null); assert.equal(x.handoffsPer100Runs, null);
});
test('real collector projects tool metadata without args, receipts, keys, memory contents or raw errors', (t) => {
  const dir = temporary(t); mkdirSync(join(dir, 'runs', 'run-1'), { recursive: true });
  writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify(record({ secret: 'HIDDEN_KEY' })) + '\n');
  writeFileSync(join(dir, 'runs', 'run-1', 'toolcalls.jsonl'), JSON.stringify({ ts: record().ts, mod: 'plugin-X', durMs: 12, chars: 600, failed: true, args: { password: 'HIDDEN_ARGS' }, receipt: 'HIDDEN_RECEIPT' }) + '\n');
  const x = collectPassiveDiagnostics({ dataDir: dir, snapshot: { memory: { base: { state: 'ready', readable: 1 } } }, contextWindow: 128000, timezone: 'Asia/Shanghai', now: until });
  assert.equal(x.activity.rows[0].chars, 600); assert.equal(x.activity.rows[0].calls, 1); assert.equal(x.usage.knownTotal, 120);
  assert.doesNotMatch(JSON.stringify(x) + passiveReportText(x), /HIDDEN_|password|receipt/);
  assert.match(passiveReportText(x), /不能按工具调用次数|不等于 Token/);
});
test('missing source is unknown rather than zero or healthy', (t) => {
  const x = collectPassiveDiagnostics({ dataDir: temporary(t), snapshot: {}, now: until });
  assert.equal(x.usage.state, 'missing'); assert.equal(x.usage.knownTotal, null); assert.equal(x.context.p90Input, null); assert.match(x.usage.summary, /无法判断/);
});
