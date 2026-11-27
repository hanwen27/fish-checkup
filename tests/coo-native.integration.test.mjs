import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CooperativeCheckup } from '../src/cooperative-checkup.mjs';
import { createCooNativeHost, loadCooNativeBindings } from '../src/coo-native-host.mjs';

const root = process.env.COO_SOURCE_ROOT;
test('COO Cormini handoff and native isolated memory lifecycle run against source', { skip: !root && 'Set COO_SOURCE_ROOT to run the COO source integration check.' }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'coo-checkup-integration-'));
  try {
    const Native = await loadCooNativeBindings(resolve(root));
    const host = createCooNativeHost({ Native, dataDir: scratch,
      runtime: () => ({ stageTokens: 256000, softRatio: .85, keepRatio: .25, origin: 'example-policy' }) });
    const engine = new CooperativeCheckup({ host, save() {} });
    const plan = await engine.preflight({ mode: 'mechanism', groups: ['handoff', 'memory'] });
    assert.equal(plan.ready, true, JSON.stringify(plan));
    assert.equal(engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true }).ok, true);
    await engine.task;
    assert.equal(engine.run.state, 'completed');
    assert.deepEqual(engine.run.results.map((item) => item.outcome), ['pass', 'pass', 'pass', 'pass']);
    assert.equal(engine.run.results.every((item) => item.evidence.sourceFingerprint === Native.source.fingerprint
      || item.evidence.steps.every((step) => step.pass)), true);
    assert.equal(engine.run.cleanup.status, 'verified');
    assert.equal(engine.run.usage.requests, 0);
  } finally { assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + '\\') || resolve(scratch).startsWith(resolve(tmpdir()) + '/')); rmSync(scratch, { recursive: true, force: true }); }
});

test('COO host refuses unsafe ownership and only projects inventory metadata', { skip: !root }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'coo-checkup-isolation-'));
  try {
    const Native = await loadCooNativeBindings(resolve(root));
    const host = createCooNativeHost({ Native, dataDir: scratch,
      runtime: () => ({ stageTokens: 128000, softRatio: .85, keepRatio: .25, origin: 'example-policy' }),
      inventory: async () => [{ id: 'example', name: '合成插件', version: '1', kind: 'world', enabled: true, password: 'never-return', memory: 'private' }] });
    const inventory = await host.readInventory();
    assert.doesNotMatch(JSON.stringify(inventory), /never-return|private|password/);
    await assert.rejects(host.open('../formal-memory'));
    const session = await host.open('owned-test');
    const parent = join(scratch, 'self-checkup', 'cooperative-scratch');
    const dir = join(parent, readdirSync(parent)[0]);
    const ownership = JSON.parse(readFileSync(join(dir, '.checkup-owner.json')));
    writeFileSync(join(dir, '.checkup-owner.json'), JSON.stringify({ ...ownership, nonce: 'tampered' }));
    await assert.rejects(session.cleanup(), /sandbox-ownership-lost/);
    assert.equal(existsSync(dir), true);
    writeFileSync(join(dir, '.checkup-owner.json'), JSON.stringify(ownership));
    assert.equal((await session.cleanup()).status, 'verified');
    assert.equal(existsSync(dir), false);
  } finally { assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + '\\') || resolve(scratch).startsWith(resolve(tmpdir()) + '/')); rmSync(scratch, { recursive: true, force: true }); }
});

test('third-party isolated adapter cleanup failure is not hidden by local directory deletion', { skip: !root }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'coo-checkup-adapter-'));
  try {
    const Native = await loadCooNativeBindings(resolve(root));
    const host = createCooNativeHost({ Native, dataDir: scratch,
      runtime: () => ({ stageTokens: 128000, softRatio: .85, keepRatio: .25, origin: 'example-policy' }),
      memoryAdapters: [{ id: 'fixture-memory', name: '测试夹具', version: 'test-only', createIsolated: async ({ namespace }) => {
        const values = new Map();
        return { verifyIsolation: async () => ({ verified: true, namespace, formalMemoryAccessible: false }),
          write: async (k, v) => values.set(k, v), read: async (k) => values.get(k) ?? null,
          remove: async (k) => values.delete(k), reconnect: async () => {},
          cleanup: async () => ({ verified: false, namespace }) };
      } }] });
    const engine = new CooperativeCheckup({ host, save() {} });
    const plan = await engine.preflight({ mode: 'mechanism', groups: ['memory'] });
    engine.start({ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true });
    await engine.task;
    assert.equal(engine.run.state, 'paused');
    assert.equal(engine.run.cleanup.status, 'unverified');
    assert.equal(engine.run.cleanup.adapterReceipts['fixture-memory'], false);
    assert.equal((await engine.preflight({ mode: 'mechanism', groups: ['memory'] })).error, 'cleanup-unverified');
  } finally { assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + '\\') || resolve(scratch).startsWith(resolve(tmpdir()) + '/')); rmSync(scratch, { recursive: true, force: true }); }
});
