import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBaseMemory } from '../src/base-memory.mjs';
import { dimensionGuide } from '../src/hardware-guide.mjs';
import { stability, summarize } from '../src/hardware.mjs';
import { buildProfile } from '../src/profile.mjs';
import { compareAxes, loadQuiz, scoreAnchors } from '../src/quiz.mjs';
import { sampleRecentActivity } from '../src/recent-fish.mjs';
import { buildReport, reportToText } from '../src/report.mjs';
import { calibrate } from '../src/scale.mjs';
import { makeToolHandlers, QUIZ_TOOL, REPORT_TOOL, SUBMIT_TOOL } from '../src/tools.mjs';

const sent = (day, text) => ({ mod: 'console', tool: 'console_send', ts: `2026-11-${day}T12:00:00Z`, args: { text } });
const plugin = (day, tool, result) => ({ mod: 'bilibili-video', tool, ts: `2026-11-${day}T13:00:00Z`, result });

test('Activity notes maintain playback, game self-report and wording provenance', () => {
  const activity = sampleRecentActivity([
    plugin(20, 'bilibili_video_open', { text: '已打开视频页，没有播放。《已经打开》' }),
    plugin(21, 'bilibili_video_play', { text: '开始看《颜色旅行》,从 0:00 起' }),
    { ...plugin(22, 'bilibili_video_play', { text: '开始看《无效结果》' }), failed: true },
    sent(20, '我没玩过《旧地图》'),
    sent(21, '我玩过游戏《星星小镇》。'),
    sent(21, '我先试试这里的配色。'),
    sent(22, '我先试试新的配色。'),
    sent(23, '这个配色我先试试。'),
    sent(23, '你说的「我先试试」我记着了。'),
    sent(23, '要不要试试另一种配色？'),
  ]);
  const profile = buildProfile(null, 'zh', activity);
  assert.equal(activity.videoStarts, 1);
  assert.deepEqual(new Set(activity.media.map(({ title }) => title)), new Set(['颜色旅行', '星星小镇']));
  assert.match(profile.diary.find(({ id }) => id === 'video').summary, /点开播放.*颜色旅行/);
  assert.match(profile.diary.find(({ id }) => id === 'game').summary, /在聊天里说玩过.*星星小镇/);
  assert.match(profile.diary.find(({ id }) => id === 'opener').summary, /我先试试.*3 条.*3 天/);
  assert.ok(profile.diary.some(({ id }) => id === 'conversation-topic'));
  assert.ok(!profile.diary.some(({ summary }) => /无效结果|已经打开|旧地图/.test(summary)));
});

test('Native dated notes contribute topic facts, and observations produce a plain personality conclusion', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'checkup-108-'));
  try {
    const dir = join(workspace, 'memory');
    mkdirSync(dir);
    for (const day of [19, 20, 21]) {
      writeFileSync(join(dir, `2026-11-${day}.md`), '继续琢磨画画和配色。不会把这一整句抄到报告。');
    }
    writeFileSync(join(dir, 'manual.md'), '游戏和火锅');
    const base = readBaseMemory(workspace, { now: new Date('2026-11-23') });
    const recent = buildProfile({ base }, 'zh');
    assert.match(recent.diary[0].summary, /基础记忆.*画画和配色.*3 天/);
    assert.ok(!recent.diary.some(({ summary }) => summary.includes('整句')));
    assert.equal(recent.character, null);
    const voiced = buildProfile({ base }, 'zh', {
      messages: 14, medianLength: 20, voice: [{ id: 'care', count: 9, days: 3 }],
    }, { flags: [], axes: { JP: 82 }, counts: { JP: 5 } });
    assert.equal(voiced.character.conclusion, '说话温和，做事有条理');
    assert.match(voiced.character.basis, /观察和小测/);
    assert.equal(voiced.situations.length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Daily trends retain gaps and state why a score delta is unavailable', () => {
  const records = [18, 19, 21, 22].flatMap((day) => Array.from({ length: 15 }, (_, index) => ({
    ts: Date.parse(`2026-11-${day}T12:00:00Z`) + index * 60_000,
    outcome: day >= 21 && index < 5 ? 'failed' : 'completed',
  })));
  const dimension = stability({ ok: true, records });
  assert.equal(dimension.series.find(({ day }) => day === '2026-11-20').score, null);
  assert.equal(dimension.comparison.earlier.days, 2);
  assert.equal(dimension.comparison.recent.days, 2);
  assert.ok(dimension.delta < -5);
  assert.match(dimensionGuide({ ...dimension, delta: 2 }, 'zh').trendStatus, /不到 5 分/);
  assert.match(dimensionGuide({ ...dimension, delta: null }, 'zh').trendStatus, /比较样本不足/);
});

test('Stricter scale, score ceilings and brief report keep missing data distinguishable', () => {
  assert.ok(calibrate(80) > 84 && calibrate(80) < 85);
  const ideal = [{ id: 'stability', score: 100, weight: .22 }, ...Array.from({ length: 5 }, (_, i) => ({
    id: `item${i}`, score: 100, weight: .156,
  }))];
  assert.equal(summarize(ideal).overall, 99);
  assert.equal(summarize([{ ...ideal[0], score: 76 }, ...ideal.slice(1)]).overall, 84);
  assert.equal(summarize([{ ...ideal[0], score: null }, ...ideal.slice(1)]).overall, 84);
  const report = buildReport({ memory: { base: { state: 'ready', readable: 2, sampled: 2, constitution: true } } }, { language: 'zh' });
  const brief = reportToText(report, { mode: 'brief' });
  assert.match(brief, /这次还缺记录/);
  assert.doesNotMatch(brief, /都在正常|100 分/);
  assert.equal(report.hardware.dimensions.find(({ id }) => id === 'memory').checkLabel, '2/2 可读');
  assert.ok(report.hardware.scoring.some((line) => line.includes('99')));
});

test('Quiz receipts wait for the other batch and score each batch with its own option order', () => {
  let date = new Date('2026-11-24T12:00:00Z');
  let state = {};
  const tools = makeToolHandlers({ snapshot: {}, quizState: () => state, saveQuizState: (next) => { state = next; }, now: () => date });
  const quiz = loadQuiz();
  const getAnswers = (batch) => tools[QUIZ_TOOL]({ batch }).items.map(({ id, options }) => {
    const item = quiz.items.find((item) => item.id === id);
    const preferred = item.options.find((option) => option.side === 'hi' || option.v === 100);
    return { id, option: options.find(({ text }) => text === preferred.t).key };
  });
  const first = getAnswers(1);
  const receipt = tools[SUBMIT_TOOL]({ batch: 1, answers: [...first, first[0]] });
  assert.equal(receipt.accepted, 14);
  assert.equal(receipt.rejected.length, 1);
  assert.match(receipt.message, /已收 14 条有效答案.*等第二批收齐/);
  assert.deepEqual(receipt.thisBatch, { axes: {}, letters: '', anchors: { pairs: 0, agreeRate: null } });
  assert.equal(state.result, null);
  assert.equal(state.takenAt, undefined);
  for (const mode of ['brief', 'detail']) {
    const { text } = tools[REPORT_TOOL]({ area: 'personality', mode });
    assert.match(text, /等第二批收齐/);
    assert.doesNotMatch(text, /依据 · 自述|还没做过题|\?{4}/);
  }
  assert.equal(tools[SUBMIT_TOOL]({ batch: 2, answers: first }).ok, false);
  assert.equal(state.batch2, undefined);
  date = new Date('2026-11-25T12:00:00Z');
  const second = tools[SUBMIT_TOOL]({ batch: 2, answers: getAnswers(2) });
  assert.match(second.message, /两批答案已收到/);
  assert.deepEqual(state.result.anchors, { pairs: 2, agreeRate: 1 });
  assert.equal(state.result.answered, 28);
  assert.match(tools[REPORT_TOOL]({ mode: 'detail' }).text, /锚点一致率: 100%/);
});

test('Absent or duplicate anchor observations do not form a pair, including legacy reports', () => {
  const one = { item: { id: 'an1', pair: 'direct' }, picked: { side: 'hi' } };
  const other = { item: { id: 'an1b', pair: 'direct' }, picked: { side: 'lo' } };
  assert.deepEqual(scoreAnchors([]), { pairs: 0, agreeRate: null });
  assert.deepEqual(scoreAnchors([one, one, { ...other, picked: { side: 'unknown' } }]), { pairs: 0, agreeRate: null });
  assert.deepEqual(scoreAnchors([one, other]), { pairs: 1, agreeRate: 0 });
  const report = buildReport({}, { quizResult: { anchors: { pairs: 0, agreeRate: 1 } } });
  assert.deepEqual(report.personality.anchors, { pairs: 0, agreeRate: null });
  const text = reportToText(report);
  assert.match(text, /暂未形成锚点对照/);
  assert.doesNotMatch(text, /锚点一致率.*%/);
});

test('Overall consistency requires four comparable axes and preserves supported per-axis evidence', () => {
  const axes = { EI: 75, SN: 75, TF: 49, JP: 70 };
  const memory = { entries: { total: 60, tagDiversity: 0.235 }, emotions: { count: 25, arousalSd: 0.1015 } };
  const report = buildReport({ memory }, { quizResult: { axes } });
  const { comparison, consistency } = report.personality;
  assert.equal(comparison.meanDelta, null);
  assert.equal(comparison.verdict, null);
  assert.deepEqual(comparison.perAxis.map(({ delta }) => delta), [null, 22, 22, null]);
  assert.equal(consistency.total, 2);
  assert.match(reportToText(report), /依据 · 行为 E\? S53 T71 J\?[\s\S]*暂无法比较（行为维度样本不足）/);
  assert.doesNotMatch(reportToText(report), /有点出入|平均偏差/);
  assert.equal(compareAxes(axes, { ...axes, JP: null }).meanDelta, null);
  assert.equal(compareAxes(axes, { ...axes, JP: 0 }).meanDelta, 18);
});

test('Brief and detail share the personality conclusion from four axes, valid quiz results or supported tags', () => {
  const cases = [
    [buildReport({ memory: {
      decisions: { total: 60, speakRate: 1, medianLen: 32, hourEntropy: 0.6 },
      entries: { total: 60, tagDiversity: 0.235 }, emotions: { count: 25, arousalSd: 0.1015 },
    } }), /来自近期行为记录/],
    [buildReport({}, { quizResult: { axes: { EI: 53, SN: 53, TF: 52, JP: 51 } } }), /来自她的情境小测自述/],
    [buildReport({ memory: { decisions: { total: 2, speakRate: 1, medianLen: 13 } } }), /来自体检标签的记录依据/],
  ];
  for (const [report, basis] of cases) {
    assert.match(report.personality.profile.character.basis, basis);
    const brief = reportToText(report, { mode: 'brief' });
    const detail = reportToText(report);
    assert.match(brief, basis);
    assert.match(detail, basis);
    assert.doesNotMatch(brief, /还需要多一点日常记录/);
    assert.doesNotMatch(detail, /这条鱼|这只小鱼/);
  }
  assert.match(reportToText(buildReport({}), { mode: 'brief' }), /还需要多一点日常记录/);
});

test('Detail puts plain language next to operational terms and scopes both length medians', () => {
  const records = Array.from({ length: 60 }, () => ({ outcome: 'completed', elapsedMs: 1500, ts: Date.parse('2026-11-24T12:00:00Z') }));
  const report = buildReport({ usage: { ok: true, records }, activity: { messages: 10, medianLength: 20 }, memory: {
    decisions: { total: 60, speakRate: 1, medianLen: 12 },
  } });
  const text = reportToText(report);
  assert.match(text, /体感达成度（调用体验有多顺）/);
  assert.match(text, /缺口曲线映射（按离满分的差距换算）/);
  assert.match(text, /Apdex（响应满意度指标）/);
  assert.match(text, /长度中位数（窗口内有效判断）只有 12 字/);
  assert.match(text, /长度中位数（近期已发送对话）20 字/);
});
