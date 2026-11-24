/**
 * 装配层冒烟：默认用临时部署和假的 host，把 World 完整跑一遍。
 *
 * 验证的不是「算得对不对」（那是单测的事），而是：
 *   · CHECKUP_WORLD.create() 能构造
 *   · start(host) 不炸
 *   · tools() 按配置出三个（关掉测验就出两个）
 *   · 工具真能被调用并回 JSON
 *   · webUi() 五个灯 / 三个面板结构合法
 *   · invoke('report' | 'text' | 'behavior') 都能回
 *   · 只在 dataDir/self-checkup/ 下落文件
 *
 * 用法：node tools/smoke-world.mjs [--bot <botDir>]
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CHECKUP_WORLD, CheckupWorld } from '../src/world.ts';
import { QUIZ_TOOL, SUBMIT_TOOL, REPORT_TOOL } from '../src/tools.mjs';

const args = process.argv.slice(2);
const botIdx = args.indexOf('--bot');
// 每次验收使用自己的状态目录，真实部署仅作为显式可选的只读输入。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'checkup-smoke-'));
const BOT_DIR = botIdx >= 0 && args[botIdx + 1] ? resolve(args[botIdx + 1]) : join(DATA_DIR, '样例 部署');
if (botIdx < 0 || !args[botIdx + 1]) {
  mkdirSync(join(BOT_DIR, '记忆 工作区'), { recursive: true });
  writeFileSync(join(BOT_DIR, '记忆 工作区', 'CONSTITUTION.md'), '# Fixture');
  writeFileSync(join(BOT_DIR, '记忆 工作区', '散记.md'), '一份基础记忆测试笔记');
  writeFileSync(join(BOT_DIR, 'config.json'), JSON.stringify({ paths: { memory: '记忆 工作区' } }));
}

const problems = [];
const note = (ok, label, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) problems.push(label);
};

/** 假的 WorldHost：把 pushEvent / log 记下来，其它能力如实报告不可用。 */
function makeHost() {
  const events = [];
  const logs = [];
  return {
    events,
    logs,
    log: {
      info: (...a) => logs.push(['info', a]),
      warn: (...a) => logs.push(['warn', a]),
      error: (...a) => logs.push(['error', a]),
      debug: () => {},
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    },
    async pushEvent(e) { events.push(e); return { cursor: events.length }; },
    async pushDeferred() { return { cursor: 0 }; },
    drainPendingEvents() { return []; },
    store: { get: async () => null, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] },
    modelFacts: { model: () => 'qwen3-max', accepts: () => true, contextWindow: () => 262144 },
    async blob() { return null; },
    reportUsage() {},
    cognition: undefined,   // 关键：真实部署里就是这个值
  };
}

console.log(`botDir = ${BOT_DIR}`);
console.log('');

/* ---------------------------------------------------------------- 挂载 */

const ctx = {
  id: 'self-checkup',
  cfg: { ...CHECKUP_WORLD.defaults(), enabled: true },
  timezone: 'Asia/Shanghai',
  botName: 'companion',
  botDir: BOT_DIR,
  packageDir: join(import.meta.dirname, '..'),
  dataDir: DATA_DIR,
  repoRoot: join(import.meta.dirname, '..'),
  secret: () => '',
  storeSecret: () => {},
  persist: () => {},
  restart: () => {},
};

const world = CHECKUP_WORLD.create(ctx);
note(world instanceof CheckupWorld, 'create() 返回 CheckupWorld');

const host = makeHost();
await world.start(host);
note(true, 'start(host) 未抛错');
note(host.cognition === undefined, 'host.cognition 为 undefined（与真实部署一致）');

/* ---------------------------------------------------------------- 工具 */

const tools = world.tools();
const names = tools.map((t) => t.name);
note(tools.length === 3, `tools() 出 ${tools.length} 个`, names.join(','));
for (const want of [QUIZ_TOOL, SUBMIT_TOOL, REPORT_TOOL]) {
  note(names.includes(want), `工具有 ${want}`);
}
note(tools.every((t) => Array.isArray(t.tags) && t.tags.length > 0), '每个工具有 tags');
note(tools.every((t) => typeof t.handler === 'function'), '每个工具有 handler');
note(tools.every((t) => t.parameters && t.parameters.type === 'object'), '每个工具有 object schema');

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const quizOut = JSON.parse((await byName[QUIZ_TOOL].handler({ batch: 1 })).text);
note(quizOut.ok === true, 'quiz 工具回 ok');
note(quizOut.items.length > 0, `quiz 第一批 ${quizOut.items.length} 题`);
note(quizOut.items.every((i) => i.options.every((o) => o.v === undefined)), '题目不含计分值');

const answers = quizOut.items.map((i, n) => ({ id: i.id, option: i.options[n % i.options.length].key }));
const subOut = JSON.parse((await byName[SUBMIT_TOOL].handler({ batch: 1, answers })).text);
note(subOut.ok === true, 'submit 工具回 ok');
note(subOut.accepted === answers.length, `submit 接受 ${subOut.accepted}/${answers.length}`);

const rep = JSON.parse((await byName[REPORT_TOOL].handler({})).text);
note(typeof rep.text === 'string' && rep.text.length > 100, 'report 工具回文本', `${rep.text.length} 字`);
note(!rep.text.includes('undefined') && !rep.text.includes('NaN'), '报告文本无 undefined/NaN');

const beforeCreativeReport = await world.invoke('persona', 'report', ['zh']);
const typeBeforeCreative = beforeCreativeReport.report.personality.letters;
const creativeBatch = JSON.parse((await byName[QUIZ_TOOL].handler({ batch: 3 })).text);
const creativeItem = creativeBatch.items[0];
const creativeSubmit = JSON.parse((await byName[SUBMIT_TOOL].handler({
  batch: 3,
  answers: [{ id: creativeItem.id, response: '一只鹈鹕骑着自行车穿过小鱼街道，停下分享一朵云。' }],
})).text);
const afterCreative = await world.invoke('persona', 'report', ['zh']);
note(creativeBatch.items.length === 4, 'batch=3 提供四道开放题');
note(creativeSubmit.ok && creativeSubmit.accepted === 1, '创作题提交被接受');
note(afterCreative.report.personality.creative?.taken === true, '创作结果进入面板报告');
note(afterCreative.report.personality.letters === typeBeforeCreative, '创作支线不改变四轴类型');

/* ------------------------------------------------ 配置开关（关测验） */

const offCtx = { ...ctx, cfg: { ...ctx.cfg, quizEnabled: false } };
const world2 = CHECKUP_WORLD.create(offCtx);
await world2.start(makeHost());
const names2 = world2.tools().map((t) => t.name);
note(names2.length === 1, `quizEnabled=false 时只留 ${names2.length} 个工具`, names2.join(','));
note(!names2.includes(QUIZ_TOOL) && names2.includes(REPORT_TOOL), '关掉后没有 quiz，但 report 还在');
await world2.stop();

const world3 = CHECKUP_WORLD.create({ ...ctx, cfg: { ...ctx.cfg, enabled: false } });
await world3.start(makeHost());
note(world3.tools().length === 0, 'enabled=false 时不出任何工具');
await world3.stop();

/* ---------------------------------------------------------------- webUi */

const ui = world.webUi('zh');
note(typeof ui.label === 'string' && ui.label.length > 0, 'webUi 有 label', ui.label);
note(Array.isArray(ui.lamps) && ui.lamps.length <= 7, `lamps ${ui.lamps?.length ?? 0} 盏（上限 7）`);
note(ui.lamps.every((l) => ['online', 'loading', 'error', 'offline'].includes(l.state)), '每盏灯 state 合法');
note(ui.panels.length === 3, `panels ${ui.panels.length} 个`, ui.panels.map((p) => p.id).join(','));
note(ui.panels.every((p) => /^[a-z0-9-]+$/.test(p.id)), 'panel id 符合 [a-z0-9-]');
note(ui.panels.every((p) => typeof p.title === 'string' && p.title), 'panel 都有 title');
note(typeof ui.invoke === 'function', 'webUi 有 invoke');

const invoke = async (panel, method, ...a) => ui.invoke(panel, method, a);
const hwReport = await invoke('hardware', 'report', 'zh');
note(hwReport?.ok === true && hwReport.report?.hardware, 'invoke report 回硬件');
if (botIdx < 0) {
  const memory = hwReport.report.hardware.dimensions.find(({ id }) => id === 'memory');
  note(memory?.score === 100 && memory.headline.includes('基础记忆'), '仅 Coo 基础工作区即可完成记忆检查');
}
const txt = await invoke('hardware', 'text');
note(typeof txt?.text === 'string' && txt.text.includes('【硬件健康】'), 'invoke text 回完整报告');
const beh = await invoke('persona', 'behavior');
note(beh?.ok === true && beh.behavior, 'invoke behavior 回人格区');

const cfgGroup = ui.config?.[0];
const cfgKeys = Object.keys(cfgGroup?.schema?.properties ?? {});
note(cfgGroup?.owner === 'world:self-checkup', `config owner = ${cfgGroup?.owner}`);
note(
  cfgKeys.includes('worlds.self-checkup.sampleDays'),
  'config 键是完整点分路径（写短名会落到 config.json 顶层）',
  cfgKeys.join(' | '),
);
note(cfgGroup?.schema?.properties?.['worlds.self-checkup.sampleDays']?.['x-hot'] === true, 'sampleDays 是 x-hot');

/* ---------------------------------------------------- 事件（发起测验） */

const before = host.events.length;
// 刚交过 batch1，takenAt 是刚才——所以应该被判成 24 小时内。
const start1 = await invoke('persona', 'startQuiz');
note(start1?.ok === false || start1?.ok === true, `startQuiz 返回 ${start1?.ok}`);
note(host.events.length === before, '冷却期内不推事件');

world.quiz = { ...world.quiz, batch1: { answers: [], at: Date.now() - 5 * 86400_000 }, takenAt: Date.now() - 5 * 86400_000 };
const start2 = await invoke('persona', 'startQuiz');
note(start2?.ok === true, '超过 24 小时后可以发起');
note(host.events.length === before + 1, '发起后推了一个事件');
note(host.events.at(-1)?.type === 'checkup.quiz-request', `事件类型 ${host.events.at(-1)?.type}`);

const creativeStartCount = host.events.length;
world.quiz = { ...world.quiz, creativeAt: Date.now() - 5 * 86400_000 };
const creativeStart = await invoke('persona', 'startCreative');
const duplicateCreativeStart = await invoke('persona', 'startCreative');
note(creativeStart?.ok === true, 'startCreative 可发起独立创作支线');
note(host.events.length === creativeStartCount + 1, '创作邀请只推送一次');
note(host.events.at(-1)?.text.includes(`用 ${QUIZ_TOOL} 取 batch=3`) && !host.events.at(-1)?.text.includes(`取 batch=1`), '创作邀请只取 batch=3');
note(duplicateCreativeStart?.error === 'already-requested', '重复邀请在节流窗口内被挡');

const restartedWorld = CHECKUP_WORLD.create(ctx);
await restartedWorld.start(makeHost());
const afterRestart = await restartedWorld.invoke('persona', 'report', ['zh']);
note(afterRestart.report.personality.creative?.taken === true, 'creative 结果重载后仍保存');
note(afterRestart.report.personality.letters === typeBeforeCreative, '重载后主类型仍未被创作覆盖');
const eventCountBeforeRestartInvite = host.events.length;
const restartDuplicate = await restartedWorld.invoke('persona', 'startCreative', []);
note(restartDuplicate?.error === 'already-requested', '重载后仍抑制重复邀请');
note(host.events.length === eventCountBeforeRestartInvite, '重载重复点击未发第二个事件');
await restartedWorld.stop();

/* ------------------------------------------------------------ 只写自己 */

await world.stop();
const stateDir = join(DATA_DIR, 'self-checkup');
let stateFiles = [];
try { stateFiles = readdirSync(stateDir); } catch { /* 还没写过 */ }
note(true, 'stateDir 内容', stateFiles.join(',') || '（空）');

/* ---------------------------------------------------------------- 结论 */

console.log('');
if (problems.length) {
  console.log(`失败 ${problems.length} 项：`);
  for (const p of problems) console.log(`  · ${p}`);
  process.exitCode = 1;
} else {
  console.log('装配层冒烟全部通过。');
}
console.log(`host 日志 ${host.logs.length} 条，事件 ${host.events.length} 个。`);

// 临时状态目录用完就收，别在 %TEMP% 里堆。
try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 收不掉也无所谓 */ }
