import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FakeDocument, makeCtx } from './_fake-dom.mjs';
import { makeGroupedPanel } from '../src/grouped-webui.mjs';
import { CheckupWorld } from '../src/world.ts';
import { QUIZ_TOOL, SUBMIT_TOOL } from '../src/tools.mjs';
import ui from '../dist/webui.js';

const nodes = (root) => [root, ...root.children.flatMap(nodes)];
const button = (root, text) => nodes(root).find(node => node.tagName === 'BUTTON' && node.textContent === text);
const click = async (node) => {
  assert.ok(node, 'button exists');
  for (const fn of node.listeners.click ?? []) await fn({ type: 'click', target: node });
};
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'checkup-grouped-release-'));
  let modelCalls = 0;
  const world = new CheckupWorld({ cfg: { enabled: true }, botDir: directory, dataDir: directory, memoryDir: directory });
  await world.start({ modelFacts: { model: () => 'fixture-model', contextWindow: () => 128000 }, log: { info() {} }, cognition: { request() { modelCalls++; throw Error('No model calls in navigation checks'); } } });
  t.after(async () => {
    await world.stop();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'usage.jsonl'), JSON.stringify({ ts: new Date().toISOString(), role: 'main', model: 'fixture-model', promptTokens: 100, completionTokens: 20 }) + '\n');
  return { world, modelCalls: () => modelCalls };
}

test('COO exposes three main categories and routes passive views through operational health', async t => {
  const { world, modelCalls } = await fixture(t);
  const declaration = world.webUi('zh');
  assert.deepEqual(declaration.panels.map(panel => [panel.id, panel.title]), [
    ['hardware', '运行健康'], ['persona', '心理健康'], ['deep-checkup', '深度体检']
  ]);
  assert.ok(declaration.panels[0].getMethods.includes('passiveReport'));
  const report = await declaration.invoke('hardware', 'passiveReport', [true]);
  assert.equal(report.report.usage.knownTotal, 120);
  assert.match((await declaration.invoke('hardware', 'passiveText', [])).text, /120/);
  const inv = await declaration.invoke('hardware', 'passiveInventory', []);
  assert.equal(typeof inv.ok, 'boolean');
  assert.equal((await declaration.invoke('hardware', 'report', ['zh'])).ok, true);
  assert.equal(modelCalls(), 0);
});

test('method help works from all three parent panels without invoking deep tests', async t => {
  const { world, modelCalls } = await fixture(t);
  for (const panel of ['hardware', 'persona', 'deep-checkup']) {
    assert.equal((await world.invoke(panel, 'methodReport', ['zh'])).ok, true);
    assert.match((await world.invoke(panel, 'methodText', ['zh'])).text, /运行健康/);
    assert.equal((await world.invoke(panel, 'methodRefresh', [])).ok, true);
  }
  assert.equal((await world.invoke('deep-checkup', 'report', [])).error, 'unknown-deep-method');
  assert.equal((await world.invoke('deep-checkup', 'deepStatus', [])).run, null);
  assert.equal(modelCalls(), 0);
});

test('installed operational panel mounts real backend data in its three subpages and returns from help', async t => {
  const { world, modelCalls } = await fixture(t);
  globalThis.document = new FakeDocument();
  const ctx = makeCtx({}); t.after(() => ctx._abort());
  ctx.invoke = (method, args = []) => world.invoke('hardware', method, args);
  await ui.panels.hardware.mount(ctx);
  assert.match(ctx.root.textContent, /稳定性/);
  for (const [label, expected] of [['Token 消耗', /120/], ['记忆状态', /记忆来源与近期活跃|宿主清单/]]) {
    await click(button(ctx.root, label));
    assert.match(ctx.root.textContent, expected);
    assert.doesNotMatch(ctx.root.textContent, /读取失败:|页面暂时无法加载|undefined|NaN/);
  }
  await click(button(ctx.root, '方法说明'));
  assert.match(ctx.root.textContent, /性格分析与奇遇小测/);
  assert.equal(nodes(ctx.root).find(node => node.className === 'sc-group-tabs').hidden, true);
  await click(button(ctx.root, '返回体检'));
  assert.equal(button(ctx.root, '上下文适配'), undefined);
  assert.deepEqual(nodes(ctx.root).filter(node => node.className === 'sc-group-tab').map(node => node.textContent), ['总览', 'Token 消耗', '记忆状态']);
  assert.equal(modelCalls(), 0);
});

test('original mental health panel still renders its profile and quiz with the grouped shell', async t => {
  const { world, modelCalls } = await fixture(t);
  globalThis.document = new FakeDocument(); const ctx = makeCtx({}); t.after(() => ctx._abort());
  ctx.invoke = (method, args = []) => world.invoke('persona', method, args);
  const tools = world.tools();
  const call = async (name, args) => JSON.parse((await tools.find((tool) => tool.name === name).handler(args)).text);
  const { items } = await call(QUIZ_TOOL, { batch: 1 });
  const { accepted } = await call(SUBMIT_TOOL, { batch: 1, answers: [{ id: items[0].id, option: items[0].options[0].key }] });
  assert.equal(accepted, 1);
  await ui.panels.persona.mount(ctx);
  assert.match(ctx.root.textContent, /性格/); assert.match(ctx.root.textContent, /奇遇/);
  assert.match(ctx.root.textContent, /等第二批收齐/);
  assert.doesNotMatch(ctx.root.textContent, /读取失败:|页面暂时无法加载|undefined|NaN/);
  await click(button(ctx.root, '方法说明')); assert.ok(button(ctx.root, '返回体检'));
  await click(button(ctx.root, '返回体检')); assert.match(ctx.root.textContent, /性格/);
  assert.equal(modelCalls(), 0);
});

test('changing internal pages aborts the previous page and cancels its timers', async t => {
  globalThis.document = new FakeDocument(); const ctx = makeCtx({}); t.after(() => ctx._abort());
  const contexts = []; let ticks = 0;
  const panels = Object.fromEntries(['hardware', 'tokens', 'memory-coverage', 'context-fit', 'method'].map(key => [key, { async mount(child) {
    contexts.push({ key, child }); if (key === 'tokens') child.interval(() => ticks++, 10);
  } }]));
  const grouped = makeGroupedPanel('hardware', panels);
  await grouped.mount(ctx);
  await click(button(ctx.root, 'Token 消耗'));
  const tokenPage = contexts.at(-1).child;
  await click(button(ctx.root, '记忆状态'));
  assert.equal(tokenPage.signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(ticks, 0);
  ctx._abort(); assert.equal(contexts.at(-1).child.signal.aborted, true);
});
