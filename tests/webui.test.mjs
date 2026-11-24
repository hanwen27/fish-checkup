import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDocument, makeCtx } from './_fake-dom.mjs';

/**
 * 用假 DOM 把三个面板各 mount 一遍。
 * 抓的是「render 引用了不存在的字段 / 调了 ctx 没有的方法」这类一挂就白屏的错误，
 * 不验证排版——排版要人眼看。
 */

const doc = new FakeDocument();
globalThis.document = doc;
// Node 24 的 navigator 是只读 getter，得用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

const bundle = (await import('../dist/webui.js')).default;

/** 一份完整的硬件 + 人格报告，字段与 src/report.mjs 的 buildReport 输出一致。 */
function fullReport() {
  const dim = (id, title, score, state) => ({
    id, title, score, state,
    headline: `${title} 的结论`,
    evidence: [{ label: '样本', value: '1000', hint: '近 7 天' }],
    formula: `${title} 的公式`,
    meaning: `${title} 的意义`,
  });
  return {
    hardware: {
      overall: 49,
      level: '有明确问题',
      levelKey: 'poor',
      scoredCount: 6,
      unknownCount: 0,
      dimensions: [
        dim('stability', '稳定性', 0, 'bad'),
        dim('speed', '速度', 41, 'warn'),
        dim('cache', '缓存', 80, 'ok'),
        dim('context', '上下文', 80, 'ok'),
        dim('handoff', '交接', 50, 'warn'),
        dim('memory', '记忆', 60, 'warn'),
      ],
    },
    personality: {
      taken: true,
      letters: 'ISTJ',
      tags: {
        nickname: '省电 · 全天小鱼',
        verdict: '记得挺牢，不白花钱；不是没想法，是没让它出来。',
        pool: 44,
        hitCount: 2,
        rarity: { 1: 0, 2: 1, 3: 1, 4: 0 },
        tags: [
          {
            id: 'cache-ace', nick: '省电', label: '算过的不重算', group: 'craft', tier: 3,
            tierLabel: '稀有', tierShort: '稀', evidence: '缓存维度 89.6 分', roast: '记得挺牢，不白花钱',
          },
          {
            id: 'all-day', nick: '全天', label: '全天都在', group: 'rhythm', tier: 2,
            tierLabel: '少见', tierShort: '少', evidence: '作息均匀度 0.9', roast: '没有作息，只有随时',
          },
        ],
      },
      takenAt: Date.parse('2026-11-24T10:00:00+08:00'),
      selfAxes: { EI: 30, SN: 60, TF: 40, JP: 70 },
      behaviorAxes: { EI: 17, SN: 56, TF: 70, JP: 51 },
      comparison: {
        perAxis: [
          { axis: 'EI', self: 30, behavior: 17, delta: 13 },
          { axis: 'SN', self: 60, behavior: 56, delta: 4 },
          { axis: 'TF', self: 40, behavior: 70, delta: 30 },
          { axis: 'JP', self: 70, behavior: 51, delta: 19 },
        ],
        meanDelta: 16.5,
        verdict: { key: 'drifting', text: '大体一致，有个别轴对不上' },
      },
      anchors: { agreeRate: 0.75 },
      flags: ['flat:EI', 'partial', 'unstable'],
      behaviorNotes: [
        { axis: 'EI', note: '开口率很低', evidence: [{ label: '开口率', value: '8%', hint: '647 次判断里' }] },
      ],
    },
    problems: ['handoffs: 目录不存在'],
    collectedAt: Date.parse('2026-11-24T10:00:00+08:00'),
    sampleDays: 7,
    live: null,
  };
}

function ctxFor(panelId, { report = fullReport(), lang = 'zh' } = {}) {
  const ctx = makeCtx({ report, language: lang });
  ctx.panelId = panelId;
  // 真实契约：invoke('report') 回 {ok, report}
  ctx.invoke = async (method, args) => {
    ctx._calls.push({ method, args });
    if (method === 'report') return { ok: true, report };
    if (method === 'refresh') return { ok: true };
    if (method === 'text') return { ok: true, text: '纯文本报告' };
    if (method === 'startQuiz') return { ok: true, started: true };
    if (method === 'behavior') return { ok: true, behavior: report.personality };
    throw new Error(`unexpected invoke: ${method}`);
  };
  return ctx;
}

function textOf(node) {
  return node.textContent;
}

function findByTag(node, tagName) {
  const matches = [];
  const visit = (current) => {
    if (current.tagName === tagName.toUpperCase()) matches.push(current);
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return matches;
}

for (const id of ['hardware', 'persona', 'method']) {
  test(`面板 ${id} 能 mount 且画出内容`, async () => {
    const ctx = ctxFor(id);
    await bundle.panels[id].mount(ctx);
    const text = textOf(ctx.root);
    assert.ok(text.length > 0, '面板不能是空的');
    assert.equal(text.includes('undefined'), false, `面板 ${id} 出现了 undefined`);
    assert.equal(text.includes('NaN'), false, `面板 ${id} 出现了 NaN`);
  });
}

test('硬件面板：总分、六维标题、依据、公式都在', async () => {
  const ctx = ctxFor('hardware');
  await bundle.panels.hardware.mount(ctx);
  const text = textOf(ctx.root);
  assert.ok(text.includes('49'));
  for (const title of ['稳定性', '速度', '缓存', '上下文', '交接', '记忆']) {
    assert.ok(text.includes(title), `缺维度 ${title}`);
  }
  assert.ok(text.includes('怎么算的'));
  assert.ok(text.includes('只读取，不修改'));
  assert.ok(text.includes('handoffs: 目录不存在'), 'problems 要列出来');
});

test('硬件面板：刷新按钮走 refresh（清缓存后再读），不是只 load', async () => {
  const ctx = ctxFor('hardware');
  await bundle.panels.hardware.mount(ctx);
  const buttons = [];
  const walk = (n) => { if (n.tagName === 'BUTTON') buttons.push(n); for (const c of n.children) walk(c); };
  walk(ctx.root);
  const btn = buttons.find((b) => b.textContent.includes('刷新'));
  assert.ok(btn, '应该有刷新按钮');
  ctx._calls.length = 0;
  btn.fire('click');
  await new Promise((r) => setTimeout(r, 30));
  const methods = ctx._calls.map((c) => c.method);
  assert.ok(methods.includes('refresh'), `应该先调 refresh，实际: ${methods.join(',')}`);
  assert.ok(methods.includes('report'), 'refresh 之后要重读报告');
});

test('硬件面板：unknown 维度显示破折号，不出 NaN', async () => {
  const report = fullReport();
  report.hardware.overall = null;
  report.hardware.level = '样本不足';
  report.hardware.levelKey = 'insufficient';
  report.hardware.scoredCount = 3;
  report.hardware.unknownCount = 3;
  report.hardware.dimensions[0].score = null;
  report.hardware.dimensions[0].state = 'unknown';
  const ctx = ctxFor('hardware', { report });
  await bundle.panels.hardware.mount(ctx);
  const text = textOf(ctx.root);
  assert.ok(text.includes('样本不足，暂不给总分'));
  assert.ok(text.includes('3 项数据不足'));
  assert.equal(text.includes('NaN'), false);
});

test('人格面板：小名切换到四种对应的小鱼角色', async () => {
  const cases = [
    ['省电 · 全天小鱼', 'sleepy'],
    ['开心回应', 'happy'],
    ['好奇探头', 'curious'],
    ['害羞躲躲', 'shy'],
  ];
  const seenSources = new Set();
  for (const [nickname, state] of cases) {
    const report = fullReport();
    report.personality.tags.nickname = nickname;
    const ctx = ctxFor('persona', { report });
    await bundle.panels.persona.mount(ctx);
    const portraits = findByTag(ctx.root, 'img');
    assert.equal(portraits.length, 1, '只在小名卡里显示一个角色');
    assert.equal(portraits[0].getAttribute('data-personality-state'), state);
    const src = portraits[0].getAttribute('src');
    assert.ok(src.startsWith('data:image/png;base64,'));
    seenSources.add(src);
    assert.ok(portraits[0].getAttribute('alt'));
  }
  assert.equal(seenSources.size, 4, '四种状态使用四张独立图片');
});

test('人格面板：标签卡与外号是首屏，四字母收进依据折叠', async () => {
  const ctx = ctxFor('persona');
  await bundle.panels.persona.mount(ctx);
  const text = textOf(ctx.root);
  // 首屏：外号 + 稀有度 + 逐条标签卡
  assert.ok(text.includes('省电 · 全天小鱼'));
  assert.ok(text.includes('算过的不重算'));
  assert.ok(text.includes('缓存维度 89.6 分'), '标签要挂可核对的依据');
  assert.ok(text.includes('池子里共 44 条标签，它命中 2 条'));
  // 四字母仍在，但退到「依据与四轴」里
  assert.ok(text.includes('依据与四轴'));
  assert.ok(text.includes('ISTJ'));
  assert.ok(text.includes('不是临床量表'));
});

test('人格面板：未测时给按钮 + 行为侧写仍可见', async () => {
  const report = fullReport();
  report.personality = {
    taken: false,
    selfAxes: null,
    behaviorAxes: { EI: 17, SN: 56, TF: 70, JP: 51 },
    comparison: { perAxis: [], meanDelta: null, verdict: null },
    behaviorNotes: [{ axis: 'EI', note: '开口率很低', evidence: [] }],
    flags: [],
  };
  const ctx = ctxFor('persona', { report });
  await bundle.panels.persona.mount(ctx);
  const text = textOf(ctx.root);
  assert.ok(text.includes('还没做过测验'));
  assert.ok(text.includes('让她做一次人格测验'));
  assert.ok(text.includes('开口率很低'), '没测也要能看行为侧写');
});

test('人格面板：创作入口只发创作邀请，查看结果重新读取报告', async () => {
  const report = fullReport();
  const ctx = ctxFor('persona', { report });
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => {
    if (method !== 'startCreative') return invoke(method, args);
    ctx._calls.push({ method, args });
    return { ok: true, started: true };
  };
  await bundle.panels.persona.mount(ctx);
  const find = (node, text) => node.tagName === 'BUTTON' && node.textContent === text
    ? node : node.children.map((child) => find(child, text)).find(Boolean);
  const start = find(ctx.root, '来做几道创作题');
  assert.ok(start);
  assert.deepEqual(ctx._calls.map((c) => c.method), ['report']);
  start.fire('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(textOf(ctx.root).includes('已邀请她做创作题'));
  report.personality.creative = { taken: true, blurb: '小鱼留下了一幅画', tags: ['脑海里有画面'] };
  find(ctx.root, '查看结果').fire('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx._calls.map((c) => c.method), ['report', 'startCreative', 'report']);
  assert.ok(textOf(ctx.root).includes('小鱼留下了一幅画'));
  assert.ok(textOf(ctx.root).includes('ISTJ'));
  assert.equal(find(ctx.root, '来做几道创作题'), undefined);
});

test('人格面板：点按钮会走 startQuiz', async () => {
  const report = fullReport();
  report.personality = {
    taken: false, selfAxes: null, behaviorAxes: null,
    comparison: { perAxis: [], meanDelta: null, verdict: null }, behaviorNotes: [], flags: [],
  };
  const ctx = ctxFor('persona', { report });
  await bundle.panels.persona.mount(ctx);

  const buttons = [];
  const walk = (n) => {
    if (n.tagName === 'BUTTON') buttons.push(n);
    for (const c of n.children) walk(c);
  };
  walk(ctx.root);
  const start = buttons.find((b) => b.textContent.includes('让她做') || b.textContent.includes('Ask her'));
  assert.ok(start, '应该有开始按钮');
  start.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ctx._calls.some((c) => c.method === 'startQuiz'), '点了要调 startQuiz');
});

test('人格面板：startQuiz 回 taken-recently 时给对应文案', async () => {
  const report = fullReport();
  report.personality = {
    taken: false, selfAxes: null, behaviorAxes: null,
    comparison: { perAxis: [], meanDelta: null, verdict: null }, behaviorNotes: [], flags: [],
    tags: {
      nickname: '没上秤小鱼', verdict: '说自己不用测。', pool: 44, hitCount: 1,
      rarity: { 1: 1, 2: 0, 3: 0, 4: 0 },
      tags: [{ id: 'untested', nick: '没上秤', label: '还没做过题', group: 'temper', tier: 1, tierLabel: '常见', tierShort: '常', evidence: '人格题还没做', roast: '测了也是这个样' }],
    },
  };
  const ctx = ctxFor('persona', { report });
  ctx.invoke = async (m) => (m === 'report' ? { ok: true, report } : { ok: false, error: 'taken-recently' });
  await bundle.panels.persona.mount(ctx);
  const buttons = [];
  const walk = (n) => { if (n.tagName === 'BUTTON') buttons.push(n); for (const c of n.children) walk(c); };
  walk(ctx.root);
  // 首屏现在有标签块和复制按钮，不能再按下标猜——按文案找那个真的开始按钮。
  const start = buttons.find((b) => b.textContent.includes('让她做'));
  assert.ok(start, '应该有开始按钮');
  start.fire('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(textOf(ctx.root).includes('24 小时'), '冷却要说明白');
});

test('人格面板：组合彩蛋单独成块，写明由哪两条构成', async () => {
  const report = fullReport();
  report.personality.tags.comboPool = 14;
  report.personality.tags.combos = [
    { id: 'crafty-calm', title: '省着说，也算得清', blurb: '算过的绝不重算，想好的也不全说。', tier: 3, tierLabel: '稀有', need: ['算过的不重算', '话到嘴边又咽回去'] },
  ];
  const ctx = ctxFor('persona', { report });
  await bundle.panels.persona.mount(ctx);
  const text = textOf(ctx.root);
  assert.ok(text.includes('组合彩蛋'));
  assert.ok(text.includes('省着说，也算得清'));
  assert.ok(text.includes('共 14 种组合，凑出 1 个'));
  // 必须说清是哪两条凑出来的，否则彩蛋变成没根据的称号
  assert.ok(text.includes('算过的不重算 + 话到嘴边又咽回去'));
});

test('人格面板：没有组合时不渲染组合块', async () => {
  const report = fullReport();
  delete report.personality.tags.combos;
  const ctx = ctxFor('persona', { report });
  await bundle.panels.persona.mount(ctx);
  assert.equal(textOf(ctx.root).includes('组合彩蛋'), false);
});

test('口径面板：公式、来源、不做什么', async () => {
  const ctx = ctxFor('method');
  await bundle.panels.method.mount(ctx);
  const text = textOf(ctx.root);
  assert.ok(text.includes('两份报告分开算'));
  assert.ok(text.includes('data/usage.jsonl'));
  assert.ok(text.includes('不改任何文件'));
  for (const t of ['稳定性', '记忆']) assert.ok(text.includes(t), `口径里缺 ${t} 的公式`);
});

test('英文环境三个面板都不崩', async () => {
  for (const id of ['hardware', 'persona', 'method']) {
    const ctx = ctxFor(id, { lang: 'en' });
    await bundle.panels[id].mount(ctx);
    const text = textOf(ctx.root);
    assert.ok(text.length > 0);
    assert.equal(text.includes('undefined'), false);
  }
});

test('report 失败时给出错提示，不白屏', async () => {
  for (const id of ['hardware', 'persona', 'method']) {
    const ctx = makeCtx({ language: 'zh' });
    ctx.invoke = async (m) => (m === 'report' ? { ok: false, error: 'boom' } : { ok: true });
    await bundle.panels[id].mount(ctx);
    assert.ok(textOf(ctx.root).includes('boom'), `${id} 应显示错误原因`);
  }
});

test('invoke 抛异常也不崩', async () => {
  for (const id of ['hardware', 'persona', 'method']) {
    const ctx = makeCtx({ language: 'zh' });
    ctx.invoke = async () => { throw new Error('network down'); };
    await bundle.panels[id].mount(ctx);
    assert.ok(textOf(ctx.root).includes('network down'));
  }
});

test('新版人格面板展示画像与近期图标，奇遇小测独立折叠', async () => {
  const report = fullReport();
  const speech = {
    id: 'speech', title: '开口习惯', value: '50.5 字', lines: ['50 条判断里，有 20 次倾向接话。'],
    summary: '在群里被叫到时，更常选择回应。',
  };
  report.personality.profile = {
    name: '憨着', days: 14, title: speech.summary, description: '',
    evidence: [speech], recent: [speech],
  };
  const ctx = ctxFor('persona', { report });
  const container = { scrollTop: 420, parentElement: null };
  ctx.root.parentElement = container;
  ctx.root.ownerDocument.scrollingElement = { scrollTop: 120 };
  await bundle.panels.persona.mount(ctx);
  assert.equal(container.scrollTop, 0);
  assert.equal(ctx.root.ownerDocument.scrollingElement.scrollTop, 0);
  const text = textOf(ctx.root);
  for (const phrase of ['憨着', '性格分析', '近 14 天', '最近的她', '20 次倾向接话', '奇遇小测']) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.ok(!text.includes('算过的不重算'), '新版不再展示标签墙');
  const details = findByTag(ctx.root, 'details');
  const analysis = details.find((node) => textOf(node).includes('20 次倾向接话'));
  const quiz = details.find((node) => textOf(node).includes('奇遇小测'));
  assert.ok(!analysis.open, '分析进入时折叠');
  const evidence = findByTag(analysis, 'ul').find((node) => node.className.includes('sc-profile-evidence-list'));
  assert.ok(evidence, '心理健康的长句单栏展示');
  assert.deepEqual(findByTag(evidence, 'li').map(textOf), ['50 条判断里，有 20 次倾向接话。']);
  assert.match(textOf(findByTag(analysis, 'summary')[0]), /50\.5 字/);
  assert.ok(!quiz.open);
  const pics = findByTag(ctx.root, 'img');
  assert.ok(pics.some((image) => image.getAttribute('src').startsWith('data:image/png;base64,')));
  assert.ok(pics.some((image) => image.getAttribute('src').startsWith('data:image/svg+xml,')));
  const invite = findByTag(quiz, 'button').find((node) => textOf(node) === '邀请她答题');
  assert.ok(invite);
  invite.fire('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(ctx._calls.some(({ method }) => method === 'startQuiz'));
});
