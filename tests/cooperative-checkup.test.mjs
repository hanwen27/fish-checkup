import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { exactJson, makeHandoffScenario } from '../src/cooperative-cases.mjs';
import { CooperativeCheckup } from '../src/cooperative-checkup.mjs';

const source = { id: 'fixture-source', name: '本地 COO 机制夹具', fingerprint: 'sha256-fixture', files: [{ name: 'core.ts', sha256: 'sha256-core' }] };
function mockHost({ cleanup = 'verified', model = false } = {}) {
  const targets = [{ id: 'coo-native', name: '合成工作区接口', version: 'fixture-v1', testLevel: 'storage-api' }];
  return {
    inspect: () => ({ ready: true, modelReady: model, source, runtime: { origin: 'example-policy', stageTokens: 256000, softRatio: .85,
      keepRatio: .25, softTokens: 217600, noteBudgetTokens: 64000, modelInputLimit: model ? 200000 : null,
      maxOutputTokens: model ? 256 : null }, fingerprint: 'fixture-fingerprint', dataScope: model ? '仅合成提示发给测试服务端' : '仅本地测试', memoryTargets: targets }),
    readInventory: async () => ({ status: 'unavailable', rows: [], detail: '清单接口不可用' }),
    countMessages: async (messages) => messages.reduce((n, row) => n + Math.ceil(row.content.length / 3), 6),
    measureHandoff: async (scenario) => ({ beforeMessages: scenario.messages, afterMessages: [{ role: 'user', content: JSON.stringify(scenario.expected) }] }),
    open: async () => ({
      handoff: async (scenario) => ({ afterMessages: [{ role: 'user', content: JSON.stringify(scenario.expected) }], evidence: {
        route: 'fixture-handoff', sourceFingerprint: 'sha256-fixture', resetObserved: true, boundaryObserved: true, injectionCount: 1,
        facts: Object.fromEntries(Object.keys(scenario.expected).map((key) => [key, true])), warningCount: 0, beforeCount: 12, afterCount: 2 } }),
      memoryLifecycle: async () => ({ target: 'coo-native', route: 'fixture-storage', testLevel: 'storage-api',
        steps: ['negative-control', 'write-read', 'reopen-read', 'update-read', 'delete-read'].map((id) => ({ id, pass: true })), cleanupVerified: true }),
      cleanup: async () => ({ status: cleanup, scope: 'fixture-only' }),
    }),
    complete: async ({ messages, signal }) => {
      signal.throwIfAborted();
      const text = messages.map((row) => row.content).join('\n');
      const match = text.match(/\{"goal":"deliver_[a-f0-9]+","constraint":"offline_[a-f0-9]+","pending":"verify_[a-f0-9]+","latest":"new_[a-f0-9]+"\}/);
      const expected = match ? JSON.parse(match[0]) : Object.fromEntries(['begin', 'middle', 'end'].map((key) => [key, text.match(new RegExp(`有效档案 ${key}=([a-z0-9_]+)`))?.[1]]));
      return { ok: true, text: JSON.stringify(expected), inputTokens: messages.reduce((n, row) => n + Math.ceil(row.content.length / 3), 6), outputTokens: 30, attempts: 1 };
    },
  };
}

test('handoff scenarios use fresh synthetic facts and exact JSON scoring', () => {
  const first = makeHandoffScenario('middle'); const second = makeHandoffScenario('middle');
  assert.notDeepEqual(first.expected, second.expected);
  assert.equal(exactJson(JSON.stringify(first.expected), first.expected), true);
  assert.equal(exactJson(`${JSON.stringify(first.expected)} extra`, first.expected), false);
});

test('explicit confirmation runs isolated COO mechanisms and stores no raw synthetic prompts', async () => {
  const engine = new CooperativeCheckup({ host: mockHost(), save() {} });
  const plan = await engine.preflight({ mode: 'mechanism', groups: ['handoff', 'memory'] });
  assert.equal(plan.ready, true);
  assert.equal(engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash }).error, 'consent-required');
  assert.equal(engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true }).ok, true);
  await engine.task;
  assert.equal(engine.run.state, 'completed');
  assert.equal(engine.run.results.every((row) => row.outcome === 'pass'), true);
  assert.deepEqual(engine.run.usage, { requests: 0, inputTokens: 0, outputTokens: 0 });
  const serialized = JSON.stringify(engine.run);
  assert.doesNotMatch(serialized, /虚构任务档案|合成进度|old_[a-f0-9]{6}/);
  assert.equal(engine.run.cleanup.status, 'verified');
});

test('unverified cleanup blocks any subsequent preflight', async () => {
  const engine = new CooperativeCheckup({ host: mockHost({ cleanup: 'unverified' }), save() {} });
  const plan = await engine.preflight({ mode: 'mechanism', groups: ['handoff'] });
  engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true });
  await engine.task;
  assert.equal(engine.run.state, 'paused');
  assert.equal((await engine.preflight({ mode: 'mechanism', groups: ['handoff'] })).error, 'cleanup-unverified');
});

test('model mode is unavailable without a safe model transport', async () => {
  const engine = new CooperativeCheckup({ host: mockHost(), save() {} });
  assert.equal((await engine.preflight({ mode: 'model', groups: ['handoff'] })).error, 'model-transport-unavailable');
});

test('long-context full-request targets follow the smaller input limit; model evidence stays separate', async () => {
  const engine = new CooperativeCheckup({ host: mockHost({ model: true }), save() {} });
  const preflight = await engine.preflight({ mode: 'model', groups: ['context', 'handoff'] });
  assert.equal(preflight.ready, true, JSON.stringify(preflight));
  assert.deepEqual(preflight.plan.items.filter((r) => r.group === 'context').map((r) => r.targetInputTokens), [50000, 100000, 150000]);
  assert.equal(preflight.plan.totals.requests, 9);
  engine.start({ planId: preflight.plan.id, disclosureHash: preflight.plan.disclosureHash, accepted: true });
  await engine.task;
  assert.equal(engine.run.state, 'completed');
  assert.equal(engine.run.usage.requests, 9);
  assert.equal(engine.run.results.every((row) => row.outcome === 'pass'), true);
  assert.equal(engine.run.results.filter((row) => row.group === 'handoff').every((row) => row.model.baseline && row.model.after), true);
  assert.doesNotMatch(JSON.stringify(engine.run), /虚构任务档案|有效档案|日程记录/);
});

test('unknown provider usage pauses further model calls and blocks another run', async () => {
  const host = mockHost({ model: true });
  let called = 0;
  host.complete = async () => { called++; return { ok: false, attempts: 1 }; };
  const engine = new CooperativeCheckup({ host, save() {} });
  const plan = await engine.preflight({ mode: 'model', groups: ['handoff'] });
  engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true });
  await engine.task;
  assert.equal(called, 1);
  assert.equal(engine.run.reason, 'usage-unavailable');
  assert.ok(engine.run.unsettled);
  assert.equal(engine.run.cleanup.status, 'verified');
  assert.equal((await engine.preflight({ mode: 'model', groups: ['handoff'] })).error, 'usage-unavailable');
});

test('model configuration changing after preflight prevents launch', async () => {
  const host = mockHost();
  const engine = new CooperativeCheckup({ host, save() {} });
  const plan = await engine.preflight({ mode: 'mechanism', groups: ['handoff'] });
  const inspect = host.inspect;
  host.inspect = () => ({ ...inspect(), fingerprint: 'changed-provider' });
  assert.equal(engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true }).error, 'configuration-changed');
});

test('out-of-budget long-context test never acquires a test session or sends requests', async () => {
  const host = mockHost({ model: true }); let opened = 0;
  host.open = async () => { opened++; throw Error('must not open'); };
  const engine = new CooperativeCheckup({ host, save() {} });
  const plan = await engine.preflight({ mode: 'model', groups: ['context'], limits: { maxInputTokens: 50000 } });
  assert.equal(plan.ready, false);
  assert.equal(plan.error, 'budget-too-small');
  assert.equal(opened, 0);
});

test('stopping during a model call prevents subsequent requests and still verifies cleanup', async () => {
  const host = mockHost({ model: true }); let started, requests = 0;
  const entered = new Promise((resolve) => { started = resolve; });
  host.complete = async ({ signal }) => {
    requests++; started();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, text: '', inputTokens: 42, outputTokens: 0, attempts: 1 };
  };
  const engine = new CooperativeCheckup({ host, save() {} });
  const plan = await engine.preflight({ mode: 'model', groups: ['handoff'] });
  engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true });
  await entered;
  engine.stop(); await engine.task;
  assert.equal(requests, 1);
  assert.equal(engine.run.state, 'stopped');
  assert.equal(engine.run.usage.inputTokens, 42);
  assert.equal(engine.run.unsettled, null);
  assert.equal(engine.run.cleanup.status, 'verified');
});

test('persisted records survive restart without raw messages or silently resuming work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cooperative-state-'));
  try {
    const engine = new CooperativeCheckup({ host: mockHost(), stateDir: directory });
    const plan = await engine.preflight({ mode: 'mechanism', groups: ['memory'] });
    engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true }); await engine.task;
    assert.deepEqual(readdirSync(join(directory, 'cooperative')), ['cooperative-checkup.json']);
    assert.doesNotMatch(readFileSync(join(directory, 'cooperative', 'cooperative-checkup.json'), 'utf8'), /messages|first-[a-f0-9-]{8}|updated-[a-f0-9-]{8}/);
    const next = new CooperativeCheckup({ host: mockHost(), stateDir: directory });
    assert.equal(next.run.state, 'completed');
    assert.equal(next.task, undefined);
    assert.equal(next.run.cleanup.status, 'verified');
  } finally {
    assert.equal(relative(tmpdir(), directory).startsWith('..'), false);
    rmSync(directory, { recursive: true, force: true });
  }
});

