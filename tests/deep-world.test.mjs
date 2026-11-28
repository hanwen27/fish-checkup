import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createBuiltinIsolatedExecutor } from '../src/deep-executor.ts';
import { DeepCheckup } from '../src/deep-checkup.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CheckupWorld } from '../src/world.ts';

test('World deep endpoints stay isolated from cognition and ordinary report routes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-deep-world-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()))); rmSync(dir, { recursive: true, force: true }); });
  let invoked = 0;
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: dir, dataDir: dir, homeDir: dir, memoryDir: dir });
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

function providerFixture(t, baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'coo-builtin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'companion'));
  mkdirSync(join(dir, 'providers', 'fixture'), { recursive: true });
  writeFileSync(join(dir, 'companion', 'config.json'), JSON.stringify({ activeProvider: 'fixture' }));
  const config = { baseUrl, secret: 'fixture-secret', spec: { model: 'fixture-model', contextWindow: 128000, maxTokens: 1024 } };
  const save = () => writeFileSync(join(dir, 'providers', 'fixture', 'config.json'), JSON.stringify(config));
  save();
  return { dir, config, save, executor: createBuiltinIsolatedExecutor({ dataDir: dir, homeDir: dir }) };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('builtin executor performs one isolated HTTP request and preserves actual usage', async (t) => {
  const requests = [];
  const url = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 23, completion_tokens: 7 } }));
  });
  const { executor, dir } = providerFixture(t, url);
  const inspection = executor.inspect();
  assert.equal(inspection.endpoint, '127.0.0.1');
  assert.doesNotMatch(JSON.stringify(inspection), /fixture-secret/);
  const testCase = { messages: [{ role: 'user', content: '合成数据' }], maxOutputTokens: 128 };
  const reservation = executor.reserve(testCase);
  const result = await executor.execute({ runId: 'fixture', testCase, reservation, signal: new AbortController().signal });
  assert.deepEqual(result, { ok: true, text: '{"ok":true}', inputTokens: 23, outputTokens: 7, costCny: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-secret');
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['max_tokens', 'messages', 'model', 'stream']);
  assert.deepEqual(requests[0].body.messages, testCase.messages);
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: dir, dataDir: join(dir, 'bots', 'test', 'data'), memoryDir: dir });
  const plan = await world.invoke('deep-checkup', 'deepPreflight', [{ groups: ['instructions'] }]);
  assert.equal(plan.ready, true);
  assert.equal((await world.invoke('deep-checkup', 'deepStart', [{ planId: plan.plan.id, disclosureHash: plan.plan.disclosureHash, accepted: true }])).ok, true);
  await world.deep.task;
  assert.equal((await world.invoke('deep-checkup', 'deepStatus', [])).run.state, 'completed');
  assert.equal(requests.length, 5);
  await world.stop();
});

test('builtin inspection handles env keys, configuration changes and hard local caps', async (t) => {
  const { executor, config, save, dir } = providerFixture(t, 'https://example.invalid/v1/');
  const first = executor.inspect().fingerprint;
  config.secret = ''; save();
  assert.deepEqual(executor.inspect().blockers, ['provider-key-unavailable']);
  writeFileSync(join(dir, 'providers', 'fixture', '.env'), 'OPENAI_API_KEY="env-secret"\n');
  assert.ok(executor.inspect().fingerprint);
  assert.notEqual(executor.inspect().fingerprint, first);
  assert.doesNotMatch(JSON.stringify(executor.inspect()), /env-secret/);
  const testCase = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 128 };
  assert.throws(() => executor.reserve({ ...testCase, maxOutputTokens: 1025 }));
  assert.throws(() => executor.reserve({ ...testCase, messages: [{ role: 'user', content: 'x'.repeat(128000) }] }));
  const engine = new DeepCheckup({ executor, save() {} });
  const preflight = engine.preflight();
  assert.equal(preflight.ready, true);
  config.spec.model = 'changed-model'; save();
  assert.equal(engine.start({ accepted: true, planId: preflight.plan.id, disclosureHash: preflight.plan.disclosureHash }).error, 'configuration-changed');
});

test('builtin transport normalizes endpoints, does not retry and keeps absent usage unknown', async (t) => {
  let calls = 0;
  const { executor, config, save } = providerFixture(t, 'https://example.invalid/v1/');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url.href, 'https://example.invalid/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ error: { message: 'rejected' } }), { status: 429 });
  });
  const testCase = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 128 };
  for (const baseUrl of ['https://example.invalid/v1/', 'https://example.invalid/v1/chat/completions/']) {
    config.baseUrl = baseUrl; save();
    const result = await executor.execute({ testCase, reservation: executor.reserve(testCase), signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.equal(Number.isNaN(result.inputTokens), true);
  }
  assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executor.execute({ testCase, reservation: executor.reserve(testCase), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 2);
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const active = new AbortController();
  const pending = executor.execute({ testCase, reservation: executor.reserve(testCase), signal: active.signal });
  active.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
