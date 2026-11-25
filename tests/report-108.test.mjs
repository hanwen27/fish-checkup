import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBaseMemory } from '../src/base-memory.mjs';
import { dimensionGuide } from '../src/hardware-guide.mjs';
import { stability, summarize } from '../src/hardware.mjs';
import { buildProfile } from '../src/profile.mjs';
import { sampleRecentActivity } from '../src/recent-fish.mjs';
import { buildReport, reportToText } from '../src/report.mjs';
import { calibrate } from '../src/scale.mjs';

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
