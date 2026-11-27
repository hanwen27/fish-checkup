import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CheckupWorld } from '../src/world.ts';

test('three passive panels read the actual data path, refresh, export and fail closed on missing inventory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'checkup-passive-world-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); rmSync(dir, { recursive: true, force: true }); });
  let modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: dir, dataDir: dir, homeDir: dir, memoryDir: dir });
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

test('memory view automatically discovers localhost extensions and falls back to readonly manifests', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'checkup-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'companion'));
  writeFileSync(join(dir, 'companion', 'config.json'), JSON.stringify({ web: { port: 18789 } }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:18789/api/extensions');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ extensions: [
      { worldId: 'fish-brain', name: 'fishtools', version: '1.2.3', loaded: true, label: '鱼脑', kind: 'world', description: 'memory' },
      { name: 'cortico-bot-continuity', version: '2.0.0', loaded: false, kind: 'bot' },
    ] }));
  });
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: dir, dataDir: dir, homeDir: dir, memoryDir: dir });
  t.after(() => world.stop());
  const report = (await world.invoke('hardware', 'passiveReport', [])).report.memory;
  assert.equal(report.inventoryState, 'ready');
  assert.equal(report.rows.find((row) => row.id === 'fish-brain').name, '鱼脑');
  assert.equal(report.rows.find((row) => row.id === 'fish-brain').enabled, true);
  assert.equal(report.rows.find((row) => row.id === 'cortico-bot-continuity').enabled, false);
  await world.invoke('memory-coverage', 'passiveReport', []);
  assert.equal(calls, 1);
  assert.equal((await world.invoke('memory-coverage', 'passiveInventory', [])).ok, true);
  assert.equal(calls, 2);
  mkdirSync(join(dir, 'extensions'));
  writeFileSync(join(dir, 'extensions', 'package.json'), JSON.stringify({ dependencies: { fishtools: '^1.2.0', 'cortico-bot-continuity': '^2' } }));
  writeFileSync(join(dir, 'extensions', 'world-owners.json'), JSON.stringify({ 'fish-brain': 'fishtools' }));
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  const fallback = await world.invoke('deep-checkup', 'cooperativeInventory', []);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.inventory.rows.length, 2);
  assert.equal(fallback.inventory.rows[0].id, 'fish-brain');
  assert.equal(fallback.inventory.rows[0].enabled, null);
  assert.equal(fallback.inventory.rows[0].version, null);
});
