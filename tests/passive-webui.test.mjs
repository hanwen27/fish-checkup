import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, makeCtx } from './_fake-dom.mjs';
import { collectPassiveDiagnostics } from '../src/passive-diagnostics.mjs';
import panels from '../dist/webui.js';

for (const [panel, headline] of [['tokens', 'Token 消耗'], ['memory-coverage', '记忆状态'], ['context-fit', '上下文适配']]) {
  test(`${panel} mounts unknown states without invented measurements or plugin claims`, async () => {
    globalThis.document = new FakeDocument(); const ctx = makeCtx({});
    const empty = collectPassiveDiagnostics({ dataDir: 'a-path-that-does-not-exist', snapshot: {}, now: Date.parse('2026-11-27T10:00:00Z') });
    ctx.invoke = async (method) => method === 'passiveReport' ? { ok: true, report: empty } : { ok: false, error: 'unavailable' };
    await panels.panels[panel].mount(ctx);
    assert.match(ctx.root.textContent, new RegExp(headline)); assert.match(ctx.root.textContent, /未知|未核实|不可测/);
    assert.doesNotMatch(ctx.root.textContent, /已检测.*鱼脑|记忆准确率|总体健康.*100/); ctx._abort();
  });
}
