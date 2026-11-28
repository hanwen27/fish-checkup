import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DeepCheckup, deepReport, deepReportText } from '../src/deep-checkup.mjs';
import { makeDeepCases, scoreDeepCase } from '../src/deep-cases.mjs';

function fixture(overrides = {}) {
  let count = 0;
  let saved;
  const info = {
    model: 'fixture-model', fingerprint: 'fixture-v1', contextWindow: 128000,
    dataScope: '合成消息；固定隔离提示；无真实用户内容。',
    capabilities: Object.fromEntries(['isolated', 'noTools', 'noMemoryWrites', 'singleAttempt', 'hardLimits', 'usage', 'abort'].map((key) => [key, true])),
  };
  const executor = {
    inspect: () => structuredClone(info),
    reserve: (item) => ({ inputTokens: Buffer.byteLength(JSON.stringify(item.messages)) + 512, outputTokens: item.maxOutputTokens, maxCostCny: .005 }),
    execute: async ({ testCase }) => { count += 1; return { ok: true, text: JSON.stringify(testCase.expected), inputTokens: 100, outputTokens: 10, costCny: .001 }; },
    ...overrides,
  };
  const engine = new DeepCheckup({ executor, save: (value) => { saved = value; } });
  return { engine, executor, info, count: () => count, saved: () => saved };
}
function launch(engine, options) {
  const preflight = engine.preflight(options);
  assert.equal(preflight.ready, true, JSON.stringify(preflight));
  return engine.start({ planId: preflight.plan.id, accepted: true, disclosureHash: preflight.plan.disclosureHash });
}

test('synthetic checks distinguish in-request facts from persistent memory and score exact JSON', () => {
  const cases = makeDeepCases('stable-test-seed');
  assert.equal(cases.length, 20);
  assert.equal(cases.filter((item) => item.group === 'context').length, 9);
  for (const item of cases) assert.equal(scoreDeepCase(item, JSON.stringify(item.expected)).outcome, 'pass');
  assert.equal(scoreDeepCase(cases[0], '```json\n{}\n```').outcome, 'fail');
  assert.equal(scoreDeepCase(cases[0], JSON.stringify({ ...cases[0].expected, extra: true })).outcome, 'fail');
  assert.equal(scoreDeepCase(cases[0], null).outcome, 'invalid');
});

test('native cognition alone never authorizes a paid request', () => {
  const engine = new DeepCheckup({ model: () => 'current-model', save: () => {} });
  const preflight = engine.preflight();
  assert.equal(preflight.ready, false);
  assert.equal(preflight.plan, null);
  assert.deepEqual(preflight.capability.blockers, ['isolated-executor-unavailable']);
  assert.equal(engine.start({ accepted: true }).ok, false);
});

test('missing hard cap, isolation or usage capability prevents startup', () => {
  const { engine, info, count } = fixture();
  for (const key of ['singleAttempt', 'usage', 'noMemoryWrites', 'hardLimits', 'abort']) {
    info.capabilities[key] = false;
    assert.equal(engine.preflight().ready, false);
    info.capabilities[key] = true;
  }
  assert.equal(count(), 0);
});

test('preflight is free, quotes only selected groups and never invents a duration', () => {
  const { engine, count } = fixture();
  const result = engine.preflight({ groups: ['instructions'] });
  assert.equal(result.ready, true);
  assert.equal(result.plan.totals.requests, 4);
  assert.equal(result.plan.durationMs, null);
  assert.equal(count(), 0);
});

test('invalid options, context fit and an insufficient budget cannot start', () => {
  const { engine, info, count } = fixture();
  assert.equal(engine.preflight({ groups: ['fishbrain'] }).ok, false);
  assert.equal(engine.preflight(null).ok, false);
  assert.equal(engine.preflight([]).ok, false);
  assert.equal(engine.preflight({ groups: [] }).ok, false);
  assert.equal(engine.preflight({ limits: { maxCostCny: -1 } }).ok, false);
  assert.equal(engine.preflight({ limits: { maxCostCny: '2' } }).ok, false);
  assert.equal(engine.preflight({ limits: { maxRequests: 2 } }).ready, false);
  info.contextWindow = 1000;
  assert.equal(engine.preflight().ready, false);
  assert.equal(count(), 0);
});

test('consent is tied to a fresh single-use quote and effective configuration', async () => {
  const { engine, info, count } = fixture();
  const p = engine.preflight().plan;
  assert.equal(engine.start({ planId: p.id, disclosureHash: p.disclosureHash }).error, 'consent-required');
  assert.equal(engine.start({ planId: p.id, disclosureHash: 'old', accepted: true }).error, 'preflight-expired');
  info.fingerprint = 'changed';
  assert.equal(engine.start({ planId: p.id, disclosureHash: p.disclosureHash, accepted: true }).error, 'configuration-changed');
  assert.equal(count(), 0);
  assert.equal(launch(engine).ok, true);
  await engine.task;
  assert.equal(engine.start({ planId: p.id, disclosureHash: p.disclosureHash, accepted: true }).ok, false);
});

test('quote expiry rejects without billing', () => {
  const { engine, count } = fixture();
  let now = 10;
  engine.now = () => now;
  const p = engine.preflight().plan;
  now = p.expiresAt;
  assert.equal(engine.start({ planId: p.id, disclosureHash: p.disclosureHash, accepted: true }).error, 'preflight-expired');
  assert.equal(count(), 0);
});

test('completed run persists only redacted evidence and keeps untested memory explicit', async () => {
  const { engine, count, saved } = fixture();
  assert.equal(launch(engine).ok, true);
  await engine.task;
  assert.equal(count(), 20);
  assert.equal(engine.run.state, 'completed');
  assert.equal(engine.run.usage.inputTokens, 2000);
  assert.equal(engine.run.usage.outputTokens, 200);
  assert.equal(engine.run.unsettled, null);
  const serialized = JSON.stringify(saved());
  assert.doesNotMatch(serialized, /archive_code|唯一有效记录|rule_fixture|messages|"text"/);
  const report = deepReport(engine.run);
  assert.equal(report.groups.length, 4);
  assert.ok(report.groups.every((item) => item.outcome === 'observed-pass' && item.confidence === 'limited'));
  assert.ok(report.untested.some((item) => item.includes('持久记忆')));
  assert.equal(report.memoryScope.testedMemorySystemCount, 0);
  assert.equal(report.memoryScope.inventoryStatus, 'not-inspected');
  assert.deepEqual(report.memoryScope.targets.map((item) => item.status), ['未检测', '未扫描 · 无法判定']);
  assert.match(report.coverageSummary, /上下文保持、指令保持、会话内事实更新/);
  assert.match(report.summary, /不是持久记忆检测/);
  assert.match(deepReportText(engine.run), /COO 原生记忆：未检测/);
  assert.match(deepReportText(engine.run), /第三方记忆插件：未扫描 · 无法判定/);
  assert.match(deepReportText(engine.run), /不.*总分/);
});

test('report explains observed failures and incomplete evidence without diagnosing configuration', async () => {
  const { engine } = fixture();
  launch(engine); await engine.task;
  engine.run.results.find((item) => item.id === 'context-16384-middle').outcome = 'fail';
  let report = deepReport(engine.run);
  assert.match(report.summary, /发现未通过项/);
  assert.match(report.groups[0].explanation, /不能断定上下文设置太短/);
  assert.match(report.groups[0].nextStep, /相同模型和配置/);
  assert.match(report.groups[2].explanation, /不能说明记忆插件/);
  const text = deepReportText(engine.run);
  assert.match(text, /结果速读|对你意味着什么/);
  assert.match(text, /证据强度/);
  assert.doesNotMatch(text, /¥|费用|costCny|maxCostCny|置信度 limited/);

  engine.run.results = engine.run.results.filter((item) => item.group === 'context' && item.outcome === 'pass');
  engine.run.state = 'stopped';
  report = deepReport(engine.run);
  assert.match(report.summary, /尚不完整/);
  assert.ok(report.groups.every((item) => item.outcome === 'insufficient'));
  assert.match(report.groups[1].explanation, /尚未运行/);
  assert.equal(report.groups[1].notRun, 4);
  assert.match(report.groups[1].nextStep, /重新预检并完成/);
  engine.run.results = [];
  assert.match(deepReport(engine.run).summary, /尚无有效结果/);
});

test('text report separates unknown Token usage from reservation without leaking monetary fields', async () => {
  const { engine } = fixture();
  launch(engine); await engine.task;
  engine.run.usage.complete = false;
  engine.run.unsettled = { inputTokens: 456, outputTokens: 128, maxCostCny: 2 };
  const text = deepReportText(engine.run);
  assert.match(text, /有未回报用量，不能当作零消耗/);
  assert.match(text, /输入 456 \/ 输出 128 Token/);
  assert.match(text, /预留不是实耗/);
  assert.doesNotMatch(text, /¥|费用|costCny|maxCostCny/);
});

test('stop retains the in-flight reservation, accounts it, and never issues a second request', async () => {
  let settle;
  let attempts = 0;
  const { engine } = fixture({ execute: () => { attempts += 1; return new Promise((resolveResult) => { settle = resolveResult; }); } });
  launch(engine);
  assert.equal(attempts, 1);
  assert.equal(engine.stop().inFlight, true);
  assert.equal(engine.run.state, 'stopping');
  assert.ok(engine.status().run.unsettled);
  assert.equal(engine.start({ accepted: true }).error, 'already-running');
  settle({ ok: false, text: '', inputTokens: 71, outputTokens: 1, costCny: .002 });
  await engine.task;
  assert.equal(attempts, 1);
  assert.equal(engine.run.state, 'stopped');
  assert.equal(engine.run.reason, 'user-stopped');
  assert.equal(engine.run.usage.inputTokens, 71);
});

test('a single failed billable attempt does not abort remaining cases, while 3 consecutive failures circuit-break', async () => {
  let calls = 0;
  const { engine: single } = fixture({
    execute: async ({ testCase }) => {
      calls += 1;
      if (calls === 2) return { ok: false, text: 'private provider error', inputTokens: 80, outputTokens: 0, costCny: .002 };
      return { ok: true, text: JSON.stringify(testCase.expected), inputTokens: 100, outputTokens: 10, costCny: .001 };
    },
  });
  launch(single); await single.task;
  assert.equal(calls, 20);
  assert.equal(single.run.state, 'completed');
  assert.equal(single.run.results[1].outcome, 'invalid');
  assert.equal(single.run.results[2].outcome, 'pass');
  assert.doesNotMatch(deepReportText(single.run), /private provider error/);

  let streakCalls = 0;
  const { engine: streak } = fixture({ execute: async () => { streakCalls += 1; return { ok: false, text: 'private provider error', inputTokens: 80, outputTokens: 0, costCny: .002 }; } });
  launch(streak); await streak.task;
  assert.equal(streakCalls, 3);
  assert.equal(streak.run.state, 'paused');
  assert.equal(streak.run.usage.inputTokens, 240);
  assert.equal(streak.run.results[0].outcome, 'invalid');
});

test('unknown usage is not zero and 3 consecutive unknown-usage failures pause the run', async () => {
  let calls = 0;
  const { engine } = fixture({ execute: async () => { calls += 1; throw Error('secret-token-in-provider-error'); } });
  launch(engine); await engine.task;
  assert.equal(calls, 3);
  assert.equal(engine.run.reason, 'usage-unavailable');
  assert.equal(engine.run.usage.complete, false);
  assert.ok(engine.run.unsettled.maxCostCny > 0);
  assert.equal(deepReport(engine.run).groups[0].outcome, 'insufficient');
  assert.equal(engine.preflight().ready, false);
  assert.doesNotMatch(JSON.stringify(engine.status()), /secret-token/);
});

test('config changes between requests pause before any additional charge', async () => {
  const f = fixture();
  f.executor.execute = async ({ testCase }) => {
    f.info.fingerprint = 'changed-during-run';
    return { ok: true, text: JSON.stringify(testCase.expected), inputTokens: 100, outputTokens: 10, costCny: .001 };
  };
  launch(f.engine); await f.engine.task;
  assert.equal(f.engine.run.requests, 1);
  assert.equal(f.engine.run.reason, 'configuration-changed');
});

test('single executor cap violation skips only that case unless total budget is exceeded or 3 consecutive fail', async () => {
  let calls = 0;
  const { engine: isolated } = fixture({
    execute: async ({ testCase }) => {
      calls += 1;
      if (calls === 1) return { ok: true, text: '{}', inputTokens: 100, outputTokens: 600, costCny: .001 };
      return { ok: true, text: JSON.stringify(testCase.expected), inputTokens: 100, outputTokens: 10, costCny: .001 };
    },
  });
  launch(isolated); await isolated.task;
  assert.equal(calls, 20);
  assert.equal(isolated.run.state, 'completed');
  assert.equal(isolated.run.results[0].outcome, 'invalid');
  assert.equal(isolated.run.results[0].reason, 'executor-limit-violation');
  assert.equal(isolated.run.results[1].outcome, 'pass');

  const { engine: overBudget } = fixture({ execute: async () => ({ ok: true, text: '{}', inputTokens: 1000000, outputTokens: 10, costCny: 10 }) });
  launch(overBudget); await overBudget.task;
  assert.equal(overBudget.run.requests, 1);
  assert.equal(overBudget.run.reason, 'budget-reached');
  assert.equal(overBudget.run.usage.costCny, 10);
  assert.equal(overBudget.run.results[0].outcome, 'invalid');
});

test('journal failure prevents any model request', () => {
  const { engine, count } = fixture();
  engine.save = () => { throw Error('disk full'); };
  assert.equal(launch(engine).error, 'storage-unavailable');
  assert.equal(count(), 0);
  assert.equal(engine.run.state, 'failed');
});

test('restart marks an active run interrupted and never silently resumes', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'coo-deep-test-'));
  t.after(() => { assert.ok(resolve(stateDir).startsWith(resolve(tmpdir()))); rmSync(stateDir, { recursive: true, force: true }); });
  const { engine } = fixture();
  launch(engine); await engine.task;
  const record = structuredClone(engine.run);
  record.state = 'running'; record.unsettled = { inputTokens: 999, outputTokens: 128, maxCostCny: .01 };
  writeFileSync(join(stateDir, 'deep-checkup.json'), JSON.stringify(record));
  const restored = new DeepCheckup({ stateDir });
  assert.equal(restored.run.state, 'interrupted');
  assert.equal(restored.run.usage.complete, false);
  assert.ok(restored.run.unsettled);
  assert.equal(restored.task, undefined);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'deep-checkup.json'), 'utf8')).state, 'interrupted');
});

test('unreadable saved state blocks a new paid run instead of silently discarding old accounting', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'coo-deep-corrupt-'));
  t.after(() => { assert.ok(resolve(stateDir).startsWith(resolve(tmpdir()))); rmSync(stateDir, { recursive: true, force: true }); });
  writeFileSync(join(stateDir, 'deep-checkup.json'), '{broken');
  const { executor, count } = fixture();
  const engine = new DeepCheckup({ executor, stateDir });
  assert.equal(engine.status().loadError, true);
  assert.equal(engine.preflight().ready, false);
  assert.deepEqual(engine.preflight().blockers, ['storage-invalid']);
  assert.equal(count(), 0);
});
