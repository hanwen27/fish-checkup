import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CheckupWorld } from '../src/world.ts';

test('World deep endpoints stay isolated from cognition and ordinary report routes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-deep-world-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); rmSync(dir, { recursive: true, force: true }); });
  let invoked = 0;
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: dir, dataDir: dir, memoryDir: dir });
  await world.start({
    modelFacts: { model: () => 'active-model', contextWindow: () => 32000 }, log: { info() {} },
    cognition: { request() { invoked += 1; throw Error('must not run'); } },
    pushEvent() { invoked += 1; throw Error('must not run'); },
  });
  const result = await world.invoke('deep-checkup', 'deepPreflight', [{}]);
  assert.equal(result.ready, false);
  assert.equal(result.capability.model, 'active-model');
  assert.equal((await world.invoke('deep-checkup', 'deepStatus', [])).run, null);
  assert.equal((await world.invoke('deep-checkup', 'deepStart', [{ accepted: true }])).ok, false);
  assert.equal((await world.invoke('deep-checkup', 'report', [])).error, 'unknown-deep-method');
  assert.match((await world.invoke('deep-checkup', 'deepText', [])).text, /尚无/);
  const cooperative = await world.invoke('deep-checkup', 'cooperativeStatus', []);
  assert.equal(cooperative.capability.ready, false);
  assert.equal(cooperative.capability.blocker, 'cooperative-host-unavailable');
  assert.equal((await world.invoke('deep-checkup', 'cooperativePreflight', [{ mode: 'mechanism' }])).ready, false);
  assert.equal((await world.invoke('deep-checkup', 'cooperativeStart', [{ accepted: true }])).ok, false);
  assert.match((await world.invoke('deep-checkup', 'cooperativeText', [])).text, /尚无/);
  assert.equal(invoked, 0);
  await world.stop();
});
