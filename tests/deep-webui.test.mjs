import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, makeCtx } from './_fake-dom.mjs';
import { DeepCheckup } from '../src/deep-checkup.mjs';
import { makeDeepCheckupPanel } from '../src/deep-webui.mjs';
const panels = { panels: { 'deep-checkup': makeDeepCheckupPanel() } };

function all(node) { return [node, ...node.children.flatMap(all)]; }
function control(root, label) { return all(root).find((item) => item.tagName === 'BUTTON' && item.textContent === label); }
function setup(engine) {
  globalThis.document = new FakeDocument();
  const ctx = makeCtx({});
  ctx.invoke = async (method, args = []) => {
    if (method === 'deepStatus') return engine.status();
    if (method === 'deepPreflight') return engine.preflight(args[0]);
    if (method === 'deepStart') return engine.start(args[0]);
    if (method === 'deepStop') return engine.stop();
    throw Error(`unexpected: ${method}`);
  };
  return ctx;
}

test('unavailable native executor renders an honest blocker and disables model launch', async () => {
  const engine = new DeepCheckup({ model: () => 'native-model', save() {} });
  const ctx = setup(engine);
  await panels.panels['deep-checkup'].mount(ctx);
  assert.match(ctx.root.textContent, /当前 COO 未提供隔离执行器/);
  assert.match(ctx.root.textContent, /持久记忆/);
  assert.equal(control(ctx.root, '开始深度体检').disabled, true);
  await control(ctx.root, '结果报告').listeners.click[0]();
  assert.match(ctx.root.textContent, /尚无深度体检报告/);
  assert.doesNotMatch(ctx.root.textContent, /¥|费用|人民币|价格/);
  ctx._abort();
});

test('report explains results before evidence and keeps prices out of every visible stage', async () => {
  const executor = {
    inspect: () => ({ model: 'fixture', fingerprint: 'v1', dataScope: '合成数据', contextWindow: 128000,
      capabilities: Object.fromEntries(['isolated', 'noTools', 'noMemoryWrites', 'singleAttempt', 'hardLimits', 'usage', 'abort'].map((key) => [key, true])) }),
    reserve: () => ({ inputTokens: 500, outputTokens: 128, maxCostCny: .001 }),
    execute: async ({ testCase }) => ({ ok: true, text: JSON.stringify(testCase.expected), inputTokens: 100, outputTokens: 10, costCny: .001 }),
  };
  const engine = new DeepCheckup({ executor, save() {} });
  const plan = engine.preflight().plan;
  engine.start({ planId: plan.id, disclosureHash: plan.disclosureHash, accepted: true });
  await engine.task;
  const ctx = setup(engine);
  await panels.panels['deep-checkup'].mount(ctx);
  for (const tab of ['启动前', '运行中', '结果报告']) {
    control(ctx.root, tab).listeners.click[0]();
    assert.doesNotMatch(ctx.root.textContent, /¥|费用|人民币|价格/);
  }
  assert.ok(ctx.root.textContent.indexOf('结果速读') < ctx.root.textContent.indexOf('分项结果与证据'));
  assert.match(ctx.root.textContent, /对你意味着什么/);
  assert.match(ctx.root.textContent, /记忆检测范围/);
  assert.match(ctx.root.textContent, /COO 原生记忆 · (?:未检测|隔离不写入)/);
  assert.match(ctx.root.textContent, /第三方记忆插件 · 未扫描 · 无法判定/);
  assert.match(ctx.root.textContent, /本轮覆盖/);
  assert.match(ctx.root.textContent, /建议下一步/);
  assert.match(ctx.root.textContent, /不代表所有复杂任务/);
  assert.match(ctx.root.textContent, /不能说明记忆插件/);
  assert.match(ctx.root.textContent, /证据强度/);
  assert.match(ctx.root.textContent, /无效请求/);
  ctx._abort();
});

test('quote enables consent, and changing a selected group invalidates it', async () => {
  const executor = {
    inspect: () => ({ model: 'fixture', fingerprint: 'v1', dataScope: '合成数据', contextWindow: 128000,
      capabilities: Object.fromEntries(['isolated', 'noTools', 'noMemoryWrites', 'singleAttempt', 'hardLimits', 'usage', 'abort'].map((key) => [key, true])) }),
    reserve: () => ({ inputTokens: 500, outputTokens: 128, maxCostCny: .001 }),
    execute: async () => { throw Error('not launched'); },
  };
  const engine = new DeepCheckup({ executor, save() {} });
  const ctx = setup(engine);
  await panels.panels['deep-checkup'].mount(ctx);
  const checks = all(ctx.root).filter((item) => item.tagName === 'INPUT' && item.type === 'checkbox');
  const consent = checks.at(-1);
  assert.equal(consent.disabled, false);
  assert.equal(control(ctx.root, '开始深度体检').disabled, true);
  consent.checked = true; consent.listeners.change[0]();
  assert.equal(control(ctx.root, '开始深度体检').disabled, false);
  checks[0].checked = false; checks[0].listeners.change[0]();
  assert.equal(control(ctx.root, '开始深度体检').disabled, true);
  assert.match(ctx.root.textContent, /待预检/);
  ctx._abort();
});
