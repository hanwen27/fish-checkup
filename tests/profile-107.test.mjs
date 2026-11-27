import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProfile } from '../src/profile.mjs';
import { collectProfileSignals, compareProfileSignals } from '../src/profile-updates.mjs';
import { CheckupWorld, CHECKUP_DEFAULTS } from '../src/world.ts';

const knownTopic = (id, zh, en, days = 3) => ({ id, zh, en, days, count: 5 });
const log = { info() {}, warn() {} };

test('Missing evidence yields five indicators and no inferred trait or artwork', () => {
  const profile = buildProfile({ base: { state: 'ready', readable: 1, sampled: 1 } }, 'zh');
  assert.equal(profile.evidence.length, 5);
  assert.ok(profile.evidence.every(({ value }) => value === null));
  assert.equal(profile.situations.length, 0);
  assert.equal(profile.scene, null);
  assert.equal(profile.recent.length, 3);
  assert.ok(profile.recent.every(({ empty }) => empty));
});

test('Sent messages and a quiz support different illustrations and evidence labels', () => {
  const activity = { messages: 12, medianLength: 30, voice: [{ id: 'direct', count: 7, days: 3 }] };
  const brief = buildProfile(null, 'zh', activity);
  assert.equal(brief.scene, 'direct-bell');
  assert.equal(brief.situations[0].source, '跨天发出消息');
  assert.match(brief.situations[0].lines[1], /7 条.*3 天/);

  const careful = buildProfile(null, 'zh', null, { flags: [], axes: { JP: 91 } });
  assert.equal(careful.scene, 'mianmian-notebook');
  assert.equal(careful.situations[0].source, '奇遇小测自述');
  assert.equal(buildProfile(null, 'zh', null, { flags: ['unstable'], axes: { JP: 91 } }).scene, null);
  assert.equal(buildProfile(null, 'en', activity).situations[0].source, 'Sent messages across multiple days');
  const mixed = buildProfile(null, 'zh', null, { flags: [], axes: { TF: 86, JP: 13 } });
  assert.equal(mixed.title, '心里有谱，做事留点余地。');
  assert.equal(mixed.situations.length, 2);
  assert.notEqual(mixed.legacyCopyKey, mixed.copyKey);
  assert.equal(JSON.parse(mixed.legacyCopyKey)[1], '给她一张空白日程，她更愿意边走边看。');
});

test('Updates require recurring evidence and ignore a mere change in counts', () => {
  const early = knownTopic('music', '音乐', 'music', 2);
  assert.deepEqual(collectProfileSignals({ topics: [early] }), []);
  const music = collectProfileSignals({ topics: [knownTopic('music', '音乐', 'music')] });
  const last = { observedAt: 1, signals: music };
  assert.equal(compareProfileSignals(last, collectProfileSignals({ topics: [{ ...early, days: 4, count: 10 }] }), 'zh'), null);
  const drawing = collectProfileSignals({ topics: [knownTopic('art', '画画', 'drawing')] });
  assert.deepEqual(compareProfileSignals(last, drawing, 'zh'),
    { title: '聊天里的关注点', before: '音乐', now: '画画', observedAt: 1 });
  const two = collectProfileSignals({ topics: [knownTopic('art', '画画', 'drawing')] }, {
    profileTopics: [knownTopic('rain', '天气', 'weather')],
  });
  assert.equal(compareProfileSignals(last, two, 'zh').others[0].now, '天气');
  assert.equal(compareProfileSignals(null, drawing, 'zh'), null);
});

test('World works on native memory, retains quiz state and tracks seen changes across restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checkup-107-'));
  try {
    const memoryDir = join(root, 'workspace');
    const stateDir = join(root, 'checkup-state');
    mkdirSync(memoryDir);
    mkdirSync(stateDir);
    writeFileSync(join(memoryDir, 'CONSTITUTION.md'), '# Companion');
    writeFileSync(join(memoryDir, 'notes.md'), 'Test workspace');
    writeFileSync(join(stateDir, 'results.json'), JSON.stringify({
      creativeRequestedAt: 42, takenAt: 42,
      batch1: { at: 42, answers: [{ id: 'ei1', option: 'a' }] },
      result: { letters: '????', anchors: { pairs: 0, agreeRate: 1 } },
    }));
    const options = { cfg: CHECKUP_DEFAULTS, botDir: root, dataDir: root, memoryDir, stateDirOverride: stateDir };
    const world = new CheckupWorld(options);
    await world.start({ log });
    const load = async (instance = world) => (await instance.invoke('persona', 'report', ['zh'])).report;
    const first = await load();
    assert.equal(first.hardware.dimensions.length, 6);
    assert.equal(first.personality.taken, false);
    assert.equal(first.personality.takenAt, null);
    assert.match(first.personality.quizProgress, /等第二批收齐/);
    assert.ok(first.personality.profile.evidence.find(({ id }) => id === 'memory').lines.some((line) => line.includes('Coo')));
    assert.equal(first.personality.profile.hasBaseline, false);
    assert.deepEqual(await world.invoke('persona', 'profileSeen', ['zh', first.personality.profile.seenKey]), { ok: true });

    const originalSnapshot = world.safeSnapshot();
    world.safeSnapshot = () => ({ ...originalSnapshot, activity: { topics: [knownTopic('art', '画画', 'drawing')] } });
    const changed = (await load()).personality.profile;
    assert.equal(changed.change.now, '画画');
    assert.equal(world.webUi().badges.at(-1).value, '有新发现');
    assert.equal((await world.invoke('persona', 'profileSeen', ['zh', '[]'])).error, 'stale');
    assert.equal((await world.invoke('persona', 'profileSeen', ['zh', changed.seenKey])).ok, true);
    assert.equal((await load()).personality.profile.change, null);
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'results.json'), 'utf8')).creativeRequestedAt, 42);

    const reopened = new CheckupWorld(options);
    await reopened.start({ log });
    reopened.safeSnapshot = world.safeSnapshot;
    const resumed = (await load(reopened)).personality;
    assert.equal(resumed.profile.change, null);
    assert.equal(resumed.profile.hasBaseline, true);
    assert.match(resumed.quizProgress, /等第二批收齐/);
    await reopened.stop();
    await world.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
