/** Loopback-only synthetic preview. Never reads the user's COO directories. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CheckupWorld } from '../src/world.ts';
const directory = mkdtempSync(join(tmpdir(), 'checkup-passive-preview-'));
const now = Date.now(); const rows = [], tools = [];
for (let day = 1; day <= 7; day++) for (let n = 0; n < 8; n++) {
  const ts = new Date(now - day * 86400000 + n * 1800000).toISOString();
  const input = day === 1 ? 48000 + n * 5000 : 16000 + n * 2200;
  rows.push({ recordId: `r-${day}-${n}`, ts, role: 'main', sessionId: 'main', model: '示例模型 A', run: `run-${day}`, promptTokens: input, completionTokens: 800 + n * 30, cacheHitTokens: Math.floor(input * .45), outcome: day === 2 && n === 0 ? 'failed' : undefined });
  tools.push({ ts, mod: n % 2 ? 'example-search' : 'example-memory', tool: 'example', durMs: 45 + n * 30, chars: 900 + n * 400, args: null, failed: day === 3 && n === 1 ? true : undefined });
}
rows.push({ ts: new Date(now - 100000).toISOString(), role: 'worlds.example-media', sessionId: 'worlds.example-media', model: '示例模型 B', promptTokens: 4000, completionTokens: 900 });
rows.push({ ts: new Date(now - 80000).toISOString(), role: 'main', sessionId: 'main', model: '示例模型 A', promptTokens: 0, completionTokens: 0, attempt: { purpose: 'generation', outcome: 'failed', meters: { input: null, output: null } } });
writeFileSync(join(directory, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
mkdirSync(join(directory, 'runs', 'preview-run'), { recursive: true });
writeFileSync(join(directory, 'runs', 'preview-run', 'toolcalls.jsonl'), tools.map((r) => JSON.stringify(r)).join('\n') + '\n');
mkdirSync(join(directory, 'handoffs'));
for (let i = 1; i <= 4; i++) { const stamp = new Date(now - i * 86400000).toISOString().slice(0, 19).replaceAll(':', '-'); writeFileSync(join(directory, 'handoffs', `${stamp}.md`), 'Synthetic preview handoff; not user memory.'); }
writeFileSync(join(directory, 'config.json'), JSON.stringify({ context: { maxTokens: 128000, softRatio: .85, keepRatio: .25 } }));
const world = new CheckupWorld({ cfg: { enabled: true }, botDir: directory, dataDir: directory, memoryDir: directory,
  cooperativeHost: { inspect: () => ({ ready: false, blocker: 'cooperative-host-unavailable' }), readInventory: async () => ({ status: 'read', rows: [{ id: 'example-memory', name: '示例记忆插件（合成）', kind: 'world', version: 'fixture-1', enabled: true }], detail: 'Synthetic inventory only.' }) } });
await world.start({ modelFacts: { contextWindow: () => 256000, model: () => '示例模型 A' }, log: { info() {} } });
const token = randomUUID();
const port = Number(process.env.COO_CHECKUP_PORT ?? 18795);
const server = createServer(async (request, response) => {
  const u = new URL(request.url, `http://127.0.0.1:${port}`);
  const send = (status, value, type = 'application/json') => { response.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); response.end(typeof value === 'string' ? value : JSON.stringify(value)); };
  if (request.method === 'GET') {
    const file = ({ '/': './passive-preview.html', '/webui.js': '../dist/webui.js', '/webui.css': '../dist/webui.css' })[u.pathname];
    if (file) return send(200, readFileSync(new URL(file, import.meta.url), 'utf8'), file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css');
    if (u.pathname === '/preview-info') return send(200, { token, synthetic: true });
    return send(404, { error: 'not-found' });
  }
  if (request.method !== 'POST' || request.headers['x-preview-token'] !== token || request.headers['content-type'] !== 'application/json' || request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${port}`)) return send(403, { error: 'forbidden' });
  if (u.pathname === '/shutdown') { send(200, { ok: true }); return stop(); }
  const match = /^\/api\/(tokens|memory-coverage|context-fit|deep-checkup)\/(passiveReport|passiveText|passiveInventory|deepStatus|deepPreflight|cooperativeStatus)$/.exec(u.pathname);
  if (!match) return send(404, { error: 'not-found' });
  try { let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 4096) return send(413, { error: 'too-large' }); } const args = JSON.parse(body || '[]'); send(200, await world.invoke(match[1], match[2], Array.isArray(args) ? args : [])); }
  catch { send(500, { error: 'preview-failed' }); }
});
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await world.stop(); server.close(); if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw Error('Unsafe scratch cleanup'); rmSync(directory, { recursive: true, force: true }); }
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
server.listen(port, '127.0.0.1', () => console.log(`Synthetic preview only: http://127.0.0.1:${port}/`));
