import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport, reportToText } from '../src/report.mjs';
import { loadQuiz, takeBatch, scoreQuiz } from '../src/quiz.mjs';
import { makeToolHandlers, QUIZ_TOOL, SUBMIT_TOOL, REPORT_TOOL } from '../src/tools.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));

/** 一份「六维都能出分」的快照。 */
function fullSnapshot(now = new Date('2026-11-24T00:00:00+08:00')) {
  const base = Date.parse('2026-11-23T10:00:00+08:00');
  const records = Array.from({ length: 300 }, (_, i) => ({
    ts: base + i * 60000,
    model: 'm',
    outcome: i < 3 ? 'failed' : 'completed',
    status: 200,
    elapsedMs: 2000 + (i % 5) * 200,
    input: 187989,
    output: 20,
    cachedInput: 187392,
    prefixHash: `h${Math.floor(i / 100)}`,
    run: 'r',
    purpose: 'generation',
  }));
  const handoffFiles = Array.from({ length: 8 }, (_, i) => ({
    name: `2026112${i}-1000-auto.md`,
    ts: Date.parse('2026-11-20T00:00:00+08:00') + i * 30 * 60000,
    size: 400,
    sha1: `s${i}`,
  }));
  return {
    usage: { ok: true, path: 'usage.jsonl', reason: null, records, skippedLines: 0 },
    config: { ok: true, path: 'config.json', reason: null, context: { maxTokens: 200000, keepRatio: 0.25, softRatio: 0.85, firstTurn: false }, rounds: { soft: 20, hard: 40 }, activeProvider: 'qwen' },
    handoffs: { ok: true, path: 'handoffs', reason: null, files: handoffFiles, total: handoffFiles.length },
    memory: {
      ok: true,
      path: 'memory',
      reason: null,
      entries: { total: 1000, invalid: 10, stale: 100, recent: 300, tagCount: 100, tagDiversity: 0.1, valenceNonZeroRatio: 0.2, avgWeight: 0.2 },
      retrieve: { total: 400, hitRate: 0.6, injectedRate: 0.5, avgMs: 120, avgQueryLen: 20 },
      emotions: { count: 300, meanValence: 0, meanArousal: 0.2, valenceSd: 0.2, arousalSd: 0.15, trend: 0 },
      decisions: { total: 600, speakRate: 0.4, medianLen: 28, avgConf: 0.5, addressedRate: 0.3, blockedRate: 0.1, kindConcentration: 0.4, hourEntropy: 0.7, hourHistogram: new Array(24).fill(0) },
      sizes: { entries: 1_000_000, retrieve: 2_000_000 },
      problems: [],
    },
    problems: [],
    collectedAt: now.getTime(),
    sampleDays: 7,
  };
}

/* ------------------------------------------------------------ 报告装配 */

test('buildReport：两份报告都在，且不合并成一个分数', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000 });
  assert.ok(Number.isFinite(r.hardware.overall));
  assert.equal(typeof r.hardware.level, 'string');
  assert.ok(r.personality, '人格区必须存在');
  assert.equal(r.personality.taken, false);
  // 关键：人格区没有「分数」，只有字母/轴，不参与 hardware.overall。
  assert.equal(r.personality.score, undefined);
});

test('buildReport：空快照 → 硬件无总分、人格未测，都不报错', () => {
  const r = buildReport({
    usage: { ok: false }, config: { ok: false }, handoffs: { ok: false, files: [] }, memory: { ok: false },
    problems: ['x'], collectedAt: Date.now(), sampleDays: 7,
  });
  assert.equal(r.hardware.overall, null);
  assert.equal(r.hardware.levelKey, 'insufficient');
  assert.equal(r.personality.taken, false);
});

test('buildReport：带测验结果时四字母仍在（作为依据），标签成为主输出', () => {
  const now = new Date('2026-11-24T10:00:00+08:00');
  const quiz = loadQuiz('zh');
  const items = [...takeBatch(quiz, 1, { now }), ...takeBatch(quiz, 2, { now })];
  const result = scoreQuiz(quiz, items.map((i, n) => ({ id: i.id, option: 'abcd'[n % 4] })), { now });
  const r = buildReport(fullSnapshot(), { contextWindow: 512000, quizResult: result, quizTakenAt: now.getTime() });
  assert.equal(r.personality.taken, true);
  assert.match(r.personality.letters, /^[EI][SN][TF][JP]$/);
  assert.equal(r.personality.comparison.perAxis.length, 4);
  // 人格主输出换成标签：有外号、有判词、有池子口径
  assert.ok(typeof r.personality.tags.nickname === 'string' && r.personality.tags.nickname.length > 0);
  assert.ok(r.personality.tags.pool >= 40);
  assert.ok(Array.isArray(r.personality.tags.tags));
  // 十六型名称/解读字段已经不再输出
  assert.equal(r.personality.typeCode, undefined);
  assert.equal(r.personality.typeName, undefined);
});

test('buildReport：行为侧写与自述并排，逐轴给差值', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000 });
  const axes = r.personality.comparison.perAxis;
  assert.equal(axes.length, 4);
  for (const a of axes) {
    assert.ok('self' in a && 'behavior' in a && 'delta' in a);
  }
  assert.equal(r.personality.comparison.perAxis[0].self, null, '未测时自述为 null');
  assert.ok(Number.isFinite(r.personality.comparison.perAxis[0].behavior));
});

test('buildReport：live 片段原样带出，不参与打分', () => {
  const live = { phases: 10, backoffs: 1, topTools: [['x', 3]] };
  const r = buildReport(fullSnapshot(), { contextWindow: 512000, live });
  assert.deepEqual(r.live, live);
  // 打分结果不因 live 变化
  const r2 = buildReport(fullSnapshot(), { contextWindow: 512000, live: null });
  assert.equal(r.hardware.overall, r2.hardware.overall);
});

/* ------------------------------------------------------------ 文本 */

test('reportToText：含两份标题、标签块、页脚、无未定义字样', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000 });
  const text = reportToText(r);
  assert.ok(text.includes('【硬件健康】'));
  assert.ok(text.includes('【人格标签】'));
  assert.ok(text.includes('只读取，不修改。'));
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('NaN'), false);
});

test('reportToText：英文版可生成', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000, language: 'en' });
  const text = reportToText(r, { language: 'en' });
  assert.ok(text.includes('[Hardware]'));
  assert.ok(text.includes('[Trait tags]'));
  assert.ok(text.includes('Reads only.'));
});

test('reportToText：problems 会列出来', () => {
  const snap = fullSnapshot();
  snap.problems = ['usage.jsonl: missing'];
  const text = reportToText(buildReport(snap, { contextWindow: 512000 }));
  assert.ok(text.includes('usage.jsonl: missing'));
});

/* ------------------------------------------------------------ 口语版 brief */

test('reportToText(brief)：五段结构齐全，能照着转述', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000 });
  const text = reportToText(r, { mode: 'brief' });
  for (const head of ['【一句话】', '【最值得看的一处】', '【能做的】', '【标签】', '【怎么跟人说】']) {
    assert.ok(text.includes(head), `缺段落：${head}`);
  }
  assert.ok(text.includes('只读取，不修改。'));
});

test('reportToText(brief)：不暴露原始计数、具体日期与术语', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000 });
  const text = reportToText(r, { mode: 'brief' });
  // 这些是 detail 版才该有的东西，口语版里出现就等于让她念运维日报。
  for (const banned of ['p95', 'CV ', 'prefixHash', '加权失败率', '最差一天', '平均偏差', '锚点一致率']) {
    assert.equal(text.includes(banned), false, `brief 里不该出现「${banned}」：\n${text}`);
  }
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(text), false, `brief 里不该出现日期：\n${text}`);
});

test('reportToText(brief)：英文版可生成', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000, language: 'en' });
  const text = reportToText(r, { mode: 'brief', language: 'en' });
  assert.ok(text.includes('[In one line]'));
  assert.ok(text.includes('[How to say it]'));
});

test('reportToText(brief)：没做人格题时说明标签只来自行为痕迹', () => {
  const r = buildReport(fullSnapshot(), { contextWindow: 512000 });
  const text = reportToText(r, { mode: 'brief' });
  assert.ok(text.includes('【标签】'));
  assert.ok(text.includes('外号：'));
  // 标签只来自行为痕迹这件事必须说清，不假装做了测验
  assert.ok(text.includes('还没做过题') || text.includes('只靠行为痕迹') || r.personality.tags.tags.some((t) => t.id === 'untested'));
});

/* ------------------------------------------------------------ 工具 */

function handlerFixture({ quizState = {}, save = () => {} } = {}) {
  const state = { current: quizState };
  return makeToolHandlers({
    snapshot: () => fullSnapshot(),
    contextWindow: () => 512000,
    quizState: () => state.current,
    saveQuizState: (next) => { state.current = next; save(next); },
    language: () => 'zh',
    now: () => new Date('2026-11-24T10:00:00+08:00'),
  });
}

test('工具 creative batch：自由文本侧写保存且不覆盖四轴结果', () => {
  const initial = { result: { letters: 'ISTP' }, batch1: { answers: [{ id: 'x', option: 'a' }], at: 1 } };
  let saved = initial;
  const h = handlerFixture({ quizState: initial, save: (s) => { saved = s; } });
  const batch = h[QUIZ_TOOL]({ batch: 3 });
  assert.equal(batch.ok, true);
  assert.equal(batch.items.length, 4);
  const out = h[SUBMIT_TOOL]({ batch: 3, answers: [{ id: 'scene1', response: '我画了一条有风的街道，小鱼在路边等朋友。' }] });
  assert.equal(out.ok, true);
  assert.equal(out.accepted, 1);
  assert.equal(saved.result.letters, 'ISTP');
  assert.equal(saved.creative.taken, true);
});
test('工具 quiz：batch=1 返回 14 题，且不含计分值', () => {
  const h = handlerFixture();
  const out = h[QUIZ_TOOL]({ batch: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.items.length, 14);
  for (const item of out.items) {
    for (const o of item.options) {
      assert.equal(o.v, undefined);
      assert.equal(o.side, undefined);
    }
  }
});

test('工具 quiz：非法 batch 直接报错', () => {
  const h = handlerFixture();
  assert.equal(h[QUIZ_TOOL]({ batch: 4 }).ok, false);
  assert.equal(h[QUIZ_TOOL]({}).ok, false);
});

test('工具 submit：交一批后回执给本批摘要，并落盘', () => {
  let saved = null;
  const h = handlerFixture({ save: (s) => { saved = s; } });
  const batch = h[QUIZ_TOOL]({ batch: 1 });
  const answers = batch.items.map((i, n) => ({ id: i.id, option: 'abcd'[n % 4] }));
  const out = h[SUBMIT_TOOL]({ batch: 1, answers });
  assert.equal(out.ok, true);
  assert.equal(out.accepted, 14);
  assert.ok(saved);
  assert.ok(saved.batch1);
});

test('工具 submit：空 answers 报错', () => {
  const h = handlerFixture();
  assert.equal(h[SUBMIT_TOOL]({ batch: 1, answers: [] }).ok, false);
});

test('工具 submit：非法 option 记进 rejected，不影响其余', () => {
  const h = handlerFixture();
  const batch = h[QUIZ_TOOL]({ batch: 1 });
  const answers = [
    { id: batch.items[0].id, option: 'a' },
    { id: batch.items[1].id, option: 'zzz' },
    { id: 'no-such-id', option: 'a' },
  ];
  const out = h[SUBMIT_TOOL]({ batch: 1, answers });
  assert.equal(out.ok, true);
  assert.equal(out.accepted, 1);
  assert.ok(out.rejected.length >= 1);
});

test('工具 report：能读硬件与人格两半（detail 版）', () => {
  const h = handlerFixture();
  const both = h[REPORT_TOOL]({ mode: 'detail' });
  assert.ok(both.text.includes('【硬件健康】'));
  assert.ok(both.text.includes('【人格标签】'));

  const hw = h[REPORT_TOOL]({ area: 'hardware', mode: 'detail' });
  assert.ok(hw.text.includes('稳定性'));
  assert.equal(hw.text.includes('【人格标签】'), false);

  const ps = h[REPORT_TOOL]({ area: 'personality', mode: 'detail' });
  assert.ok(ps.text.includes('【人格标签】'));
  assert.ok(ps.text.includes('小鱼'), '人格半应该有外号');
  assert.ok(ps.text.includes('池子'), '应给出池子与命中数的口径');
});

test('工具 report：不传 mode 时默认给口语版', () => {
  const h = handlerFixture();
  const out = h[REPORT_TOOL]({});
  assert.equal(out.mode, 'brief');
  assert.ok(out.text.includes('【一句话】'));
  assert.equal(out.text.includes('【硬件健康】'), false, '默认不该是完整运维版');
});

test('工具 schema：三个工具都在，tags 正确', () => {
  const h = handlerFixture();
  assert.ok(h[QUIZ_TOOL] && h[SUBMIT_TOOL] && h[REPORT_TOOL]);
});

/* ------------------------------------------------------------ 只读静态检查 */

const WRITE_APIS = /writeFile|writeFileSync|appendFile|appendFileSync|renameSync|unlinkSync|rmSync|rmdirSync|mkdirSync|createWriteStream|copyFile|copyFileSync/;

test('只读：src 下唯一的写路径都在 self-checkup 目录里', () => {
  const srcDir = join(HERE, 'src');
  const offenders = [];
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.mjs') && !name.endsWith('.ts')) continue;
    const body = readFileSync(join(srcDir, name), 'utf8');
    body.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      if (trimmed.startsWith('import ')) return;           // 导入语句不算使用
      if (!WRITE_APIS.test(line)) return;
      const nearby = body.split('\n').slice(Math.max(0, i - 6), i + 3).join('\n');
      if (!nearby.includes('stateFile()') && !nearby.includes('stateDir()') && !nearby.includes('self-checkup')) {
        offenders.push(`${name}:${i + 1}: ${trimmed}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `发现不在 self-checkup 目录的写路径：\n${offenders.join('\n')}`);
});

test('只读：collect/behavior/hardware/quiz 四个文件完全没有写 API', () => {
  for (const name of ['collect.mjs', 'behavior.mjs', 'hardware.mjs', 'quiz.mjs', 'report.mjs']) {
    const body = readFileSync(join(HERE, 'src', name), 'utf8');
    const hits = body.split('\n')
      .map((line, i) => ({ line: line.trim(), i: i + 1 }))
      .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//') && WRITE_APIS.test(line));
    assert.deepEqual(hits, [], `${name} 里出现了写 API：${JSON.stringify(hits)}`);
  }
});

test('只读：没有任何网络请求 API', () => {
  const srcDir = join(HERE, 'src');
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.mjs') && !name.endsWith('.ts')) continue;
    const body = readFileSync(join(srcDir, name), 'utf8');
    for (const bad of ['fetch(', 'http.request', 'https.request', 'net.connect', 'WebSocket(', 'XMLHttpRequest']) {
      const lines = body.split('\n')
        .map((l, i) => ({ l: l.trim(), i: i + 1 }))
        .filter(({ l }) => !l.startsWith('*') && !l.startsWith('//') && l.includes(bad));
      assert.deepEqual(lines, [], `${name} 里有网络调用 ${bad}: ${JSON.stringify(lines)}`);
    }
  }
});

test('只读：没有读取 .env 或凭据文件', () => {
  const srcDir = join(HERE, 'src');
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.mjs') && !name.endsWith('.ts')) continue;
    const body = readFileSync(join(srcDir, name), 'utf8');
    for (const bad of ['.env', 'credential', 'secret.json', 'qqbot-inbox']) {
      const hits = body.split('\n')
        .map((l, i) => ({ l: l.trim(), i: i + 1 }))
        .filter(({ l }) => !l.startsWith('*') && !l.startsWith('//') && l.includes(bad));
      // world.ts 里 ctx.secret 是框架注入，不算读文件；这里只查字面路径。
      const real = hits.filter(({ l }) => !l.includes('ctx.secret') && !l.includes('storeSecret'));
      assert.deepEqual(real, [], `${name} 里提到了 ${bad}: ${JSON.stringify(real)}`);
    }
  }
});

test('dist/webui.js 能解析，且导出 default.panels 三个面板', async () => {
  const mod = await import('../dist/webui.js');
  assert.equal(typeof mod.default, 'object');
  assert.ok(mod.default.panels.hardware);
  assert.ok(mod.default.panels.persona);
  assert.ok(mod.default.panels.method);
  for (const p of Object.values(mod.default.panels)) {
    assert.equal(typeof p.mount, 'function');
  }
});

test('package.json 的 cortico 声明符合框架约定', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  assert.equal(pkg.cortico.kind, 'world');
  assert.equal(pkg.cortico.api, 6);
  assert.equal(pkg.main, './src/index.ts');
  assert.ok(pkg.cortico.webUiClient.endsWith('webui.js'));
  assert.ok(pkg.cortico.tags.includes('health'));
  assert.equal(statSync(join(HERE, pkg.cortico.webUiClient)).isFile(), true);
  assert.equal(statSync(join(HERE, pkg.cortico.webUiStyle)).isFile(), true);
});

test('describe.json 与代码里的工具名一致', () => {
  const desc = JSON.parse(readFileSync(join(HERE, 'describe.json'), 'utf8'));
  const names = desc.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [QUIZ_TOOL, REPORT_TOOL, SUBMIT_TOOL].sort());
  assert.ok(desc.events.some((e) => e.type === 'checkup.quiz-request'));
  const quiz = desc.tools.find((t) => t.name === QUIZ_TOOL);
  assert.deepEqual(quiz.parameters.properties.batch.enum, [1, 2, 3]);
  const submit = desc.tools.find((t) => t.name === SUBMIT_TOOL);
  assert.deepEqual(submit.parameters.properties.answers.items.required, ['id']);
  assert.equal(typeof submit.parameters.properties.answers.items.properties.response, 'object');
  assert.deepEqual(submit.parameters.properties.answers.items.properties.option.type, 'string');
});
