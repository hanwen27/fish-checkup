import test from 'node:test';
import assert from 'node:assert/strict';
import panels from '../dist/webui.js';
import { FakeDocument, makeCtx } from './_fake-dom.mjs';

const walk = (node) => [node, ...node.children.flatMap(walk)];
const button = (ctx, text) => walk(ctx.root).find((node) => node.tagName === 'BUTTON' && node.textContent === text);
test('COO chain UI hides unavailable bridge tab without invoking ordinary cognition or fabricating plugin results', async () => {
  globalThis.document = new FakeDocument();
  const ctx = makeCtx({});
  const calls = [];
  ctx.invoke = async (method) => {
    calls.push(method);
    if (method === 'deepStatus') return { ok: true, capability: {}, run: null };
    if (method === 'deepPreflight') return { ok: true, ready: false, blockers: ['isolated-executor-unavailable'] };
    if (method === 'cooperativeStatus') return { ok: true, capability: { ready: false, memoryTargets: [] }, run: null };
    throw Error('unexpected-method');
  };
  await panels.panels['deep-checkup'].mount(ctx);
  assert.equal(button(ctx, 'COO 链路验证'), undefined);
  assert.doesNotMatch(ctx.root.textContent, /已安装.*鱼脑|第三方.*通过/);
  assert.deepEqual(calls, ['deepStatus', 'deepPreflight', 'cooperativeStatus']);
  ctx._abort();
});

test('COO chain report separates mechanism coverage, model results, usage and cleanup', async () => {
  globalThis.document = new FakeDocument();
  const ctx = makeCtx({});
  ctx.invoke = async (method) => {
    if (method === 'deepStatus') return { ok: true, capability: {}, run: null };
    if (method === 'deepPreflight') return { ok: true, ready: false, blockers: [] };
    return { ok: true, capability: { ready: true, runtime: { origin: 'example-policy', stageTokens: 256000, softTokens: 217600, noteBudgetTokens: 64000 }, source: { name: 'COO源代码', fingerprint: 'fixture-fingerprint' } },
      run: { state: 'completed', mode: 'mechanism', runtime: { origin: 'example-policy' }, usage: { inputTokens: 0, outputTokens: 0 }, cleanup: { status: 'verified' },
        results: [{ id: 'memory-coo-native', outcome: 'pass', explanation: '仅存储接口通过，未验证模型自主检索。', evidence: { route: 'native-storage' } }] } };
  };
  await panels.panels['deep-checkup'].mount(ctx);
  await button(ctx, 'COO 链路验证').listeners.click[0]();
  assert.match(ctx.root.textContent, /不是当前配置/);
  assert.match(ctx.root.textContent, /仅存储接口通过，未验证模型自主检索/);
  assert.match(ctx.root.textContent, /累计 Token/);
  assert.match(ctx.root.textContent, /已验证/);
  assert.equal(walk(ctx.root).filter((node) => node.className === 'sc-deep-fact').length, 6);
  assert.doesNotMatch(ctx.root.textContent, /¥|人民币|费用/);
  ctx._abort();
});
