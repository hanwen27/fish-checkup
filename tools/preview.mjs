/**
 * 对这台机器的真实数据只读跑一遍，控制台打印两份报告。
 * 不依赖 Coo 运行、不写任何文件（连缓存都不写）。
 *
 * 用法：
 *   node tools/preview.mjs                       # 用默认部署路径
 *   node tools/preview.mjs --bot <dir> --data <dir>
 *   node tools/preview.mjs --json                # 只输出 JSON
 */

import { collectAll } from '../src/collect.mjs';
import { buildReport, reportToText } from '../src/report.mjs';
import { loadQuiz, scoreQuiz, takeBatch } from '../src/quiz.mjs';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const botDir = arg('bot', 'E:/Coopanion/data/home/companion');
const dataDir = arg('data', `${botDir}/data`);
const memoryDir = arg('memory', `${botDir}/workspace`);
const sampleDays = Number(arg('days', 7));
const wantJson = argv.includes('--json');

const t0 = Date.now();
const snap = collectAll({ botDir, dataDir, memoryDir, sampleDays });
const tRead = Date.now() - t0;

const report = buildReport(snap, { contextWindow: null, quizResult: null, language: 'zh' });
const behavior = report.personality;

if (wantJson) {
  console.log(JSON.stringify({ report, collectMs: tRead }, null, 2));
} else {
  console.log(reportToText(report));
  console.log('');
  console.log('—— 行为侧写（人格测试的通道二，不需要她开口）——');
  for (const a of behavior.behaviorNotes) {
    const axes = behavior.behaviorAxes ?? {};
    const score = axes[a.axis];
    console.log(`  ${a.axis} ${score === null || score === undefined ? '?' : Math.round(score)}  ${a.note}`);
    for (const e of a.evidence ?? []) console.log(`      · ${e.label}: ${e.value}${e.hint ? ` (${e.hint})` : ''}`);
  }
  console.log(`  合成字母（行为）：${behavior.behaviorLetters}`);
  if (behavior.missing.length) console.log(`  缺：${behavior.missing.join(', ')}`);
  console.log('');
  console.log(`采集耗时 ${tRead} ms · 读不到 ${snap.problems.length} 项`);
  for (const p of snap.problems) console.log(`  · ${p}`);
}

// 顺便验证一遍题库能被解析、判分不炸（不写入任何状态）。
try {
  const quiz = loadQuiz('zh');
  const items = quiz.items ?? [];
  const axesCount = items.filter((i) => (i.kind ?? 'axis') === 'axis').length;
  const anchors = items.filter((i) => i.kind === 'anchor').length;
  const axisItems = items.filter((i) => (i.kind ?? 'axis') === 'axis');
  // 用「取题 + 位置字母」这条真实链路试判：id 与 key 都来自 takeBatch，
  // 全选同一位置会被判 flat（设计上的防护），交替选位才出字母。
  const served = [...takeBatch(quiz, 1), ...takeBatch(quiz, 2)].filter((i) => (i.kind ?? 'axis') === 'axis');
  const alternate = served.map((i, n) => ({ id: i.id, option: i.options[n % i.options.length].key }));
  const demo = scoreQuiz(quiz, alternate);
  const perAxis = demo.axes ? Object.entries(demo.axes).map(([k, v]) => `${k} ${v}`).join(' / ') : '';
  const flat = scoreQuiz(quiz, served.map((i) => ({ id: i.id, option: i.options[0].key })));
  if (!wantJson) {
    console.log('');
    console.log(`题库：${items.length} 题（情境 ${axesCount}，锚点 ${anchors}），版本 ${quiz.version}`);
    console.log(`  交替选位试判：${demo.letters}（${perAxis}），answered ${demo.answered}/${demo.totalItems}`);
    console.log(`  全选同一位置会被判 flat：${flat.letters}（flags: ${(flat.flags ?? []).join(',') || '无'}）`);
  }
} catch (err) {
  console.error('题库加载失败：', err?.message ?? err);
  process.exitCode = 1;
}
