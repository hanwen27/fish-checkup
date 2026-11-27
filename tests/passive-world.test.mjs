import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CheckupWorld } from '../src/world.ts';

test('three passive panels read the actual data path, refresh, export and fail closed on missing inventory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'checkup-passive-world-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); rmSync(dir, { recursive: true, force: true }); });
  let modelCalls = 0;
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: dir, dataDir: dir, memoryDir: dir });
  await world.start({ modelFacts: { contextWindow: () => 256000, model: () => 'test-model' }, log: { info() {} }, cognition: { request() { modelCalls++; throw Error('must not run'); } } });
  t.after(() => world.stop());
  writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ ts: new Date().toISOString(), model: 'test-model', role: 'main', promptTokens: 100, completionTokens: 20 }) + '\n');
  assert.deepEqual(world.webUi('zh').panels.map((p) => p.id), ['hardware', 'persona', 'deep-checkup']);
  for (const panel of ['tokens', 'memory-coverage', 'context-fit']) {
    const result = await world.invoke(panel, 'passiveReport', [true]); assert.equal(result.ok, true); assert.equal(result.report.usage.knownTotal, 120);
  }
  assert.equal((await world.invoke('hardware', 'passiveReport', [])).report.usage.knownTotal, 120);
  const inventory = await world.invoke('memory-coverage', 'passiveInventory', []); assert.equal(inventory.ok, false);
  assert.equal((await world.invoke('memory-coverage', 'passiveReport', [])).report.memory.inventoryState, 'unavailable');
  assert.match((await world.invoke('tokens', 'passiveText', [])).text, /120/);
  assert.equal(modelCalls, 0);
});
