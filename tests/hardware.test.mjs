import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stability, latency, cacheHealth, contextConfig, handoffHealth, memoryHealth,
  runHardware, summarize, levelOf, percentile, grade,
} from '../src/hardware.mjs';

/** 造一批用量记录。 */
function records(n, { outcome = 'completed', elapsedMs = 2000, input = 1000, cached = 900, hash = 'h', spreadMs = 0 } = {}) {
  const base = Date.parse('2026-11-20T10:00:00+08:00');
  return Array.from({ length: n }, (_, i) => ({
    ts: base + i * 60000,
    model: 'm',
    outcome: typeof outcome === 'function' ? outcome(i) : outcome,
    status: 200,
    elapsedMs: typeof elapsedMs === 'function' ? elapsedMs(i) : elapsedMs + (spreadMs ? (i % 7) * spreadMs : 0),
    input,
    output: 10,
    cachedInput: cached,
    prefixHash: typeof hash === 'function' ? hash(i) : hash,
    run: 'r',
    purpose: 'generation',
  }));
}

const okUsage = (recs) => ({ ok: true, path: 'usage.jsonl', reason: null, records: recs, skippedLines: 0 });

/* ------------------------------------------------------------ 稳定性 */

test('稳定性：全部成功得满分', () => {
  const d = stability(okUsage(records(200)));
  assert.equal(d.score, 100);
  assert.equal(d.state, 'ok');
});

test('稳定性：全部失败仍标严重，但不显示恐慌性的 0 分', () => {
  const d = stability(okUsage(records(200, { outcome: 'failed' })));
  // 原始分下限 30，经缺口曲线映射后约 37——是「确实不好」，不是「这页坏了」。
  assert.ok(d.score > 30 && d.score < 45, `got ${d.score}`);
  assert.equal(d.state, 'bad');
});

test('稳定性：9.7% 失败仍在良好档', () => {
  const recs = records(300, { outcome: (i) => (i < 29 ? 'failed' : 'completed') });
  const d = stability(okUsage(recs));
  assert.ok(d.score >= 86, `got ${d.score}`);
  assert.equal(d.state, 'ok');
});

test('稳定性：n<10 的每日样本不进入结论证据', () => {
  const recs = records(50);
  const base = recs.at(-1).ts;
  recs.push(...Array.from({ length: 3 }, (_, i) => ({ ...records(1)[0], ts: base + 86400000 + i * 60000, outcome: 'completed' })));
  const d = stability(okUsage(recs));
  assert.equal(d.state, 'ok');
  assert.equal(d.evidence.some((e) => e.label === '2026-11-21'), false);
});

test('响应速度：长尾很慢仍保留严重但可解释的分数', () => {
  const d = latency(okUsage(records(200, { elapsedMs: 120000 })));
  // p95 远超 60 秒 → 原始分压到 30 左右，映射后约 63：明显慢，但还能用。
  assert.ok(d.score > 55 && d.score < 70, `got ${d.score}`);
  assert.equal(d.state, 'warn');
});
test('稳定性：样本不足 50 条给 unknown，而不是 0 分', () => {
  const d = stability(okUsage(records(49)));
  assert.equal(d.state, 'unknown');
  assert.equal(d.score, null);
});


test('稳定性：文件缺失也给 unknown', () => {
  const d = stability({ ok: false, path: 'x', reason: 'missing', records: [], skippedLines: 0 });
  assert.equal(d.state, 'unknown');
  assert.equal(d.score, null);
});

test('稳定性：aborted 按半次失败计', () => {
  // 100 条里 20 条 aborted = 10 次失败当量 = 10%
  const recs = records(100, { outcome: (i) => (i < 20 ? 'aborted' : 'completed') });
  const d = stability(okUsage(recs));
  const ev = d.evidence.find((e) => e.label === '加权失败率');
  assert.equal(ev.value, '10%');
});

test('稳定性：逐日证据能分辨「某几天集中坏」', () => {
  const recs = records(200, { outcome: (i) => (i < 100 ? 'failed' : 'completed') });
  const d = stability(okUsage(recs));
  assert.ok(d.evidence.some((e) => e.label === '最差一天'));
});

/* ------------------------------------------------------------ 速度 */

test('速度：p95 2.1 秒得满分', () => {
  const d = latency(okUsage(records(200, { elapsedMs: 2100 })));
  assert.equal(d.score, 100);
  assert.equal(d.state, 'ok');
});

test('速度：p95 30 秒左右落在良好档', () => {
  const d = latency(okUsage(records(200, { elapsedMs: 30600 })));
  assert.ok(d.score > 78 && d.score < 92, `got ${d.score}`);
  assert.equal(d.state, 'ok');
});

test('速度：单条超长记录不拖垮 p95', () => {
  const recs = records(200, { elapsedMs: (i) => (i === 5 ? 1_971_026 : 2200) });
  const d = latency(okUsage(recs));
  assert.equal(d.score, 100, '单点异常不该改变 p95');
  assert.ok(d.evidence.some((e) => e.label === '最慢一条'));
});

test('速度：超大样本的最慢值统计不依赖参数展开', () => {
  const d = latency(okUsage(records(150000, { elapsedMs: 2500 })));
  assert.equal(d.state, 'ok');
  assert.equal(d.evidence.find((e) => e.label === '最慢一条').value, '2.5 秒');
});

test('速度：样本不足给 unknown', () => {
  const d = latency(okUsage(records(10, { elapsedMs: 1000 })));
  assert.equal(d.state, 'unknown');
});

test('percentile：nearest-rank 边界正确', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.equal(percentile([5], 0.5), 5);
  assert.equal(percentile([], 0.5), null);
});

/* ------------------------------------------------------------ 缓存 */

test('缓存：99.7% 命中得高分', () => {
  const recs = records(200, { input: 187989, cached: 187392 });
  const d = cacheHealth(okUsage(recs));
  assert.ok(d.score >= 95, `got ${d.score}`);
});

test('缓存：前缀哈希变化 20 次扣满上限 18 分', () => {
  const recs = records(200, { hash: (i) => `h${Math.floor(i / 10)}` }); // 20 个不同值 → 19 次变化
  const d = cacheHealth(okUsage(recs));
  const pen = d.evidence.find((e) => e.label === '前缀哈希变化');
  assert.ok(Number(pen.value.split(' ')[0]) >= 19);
  // 19 次 / 200 条 = 95 次每千条 × 1.6 = 152 → 封顶 18；100-18=82 再映射 → 约 87
  assert.ok(d.score <= 90, `got ${d.score}`);
});

test('缓存：前缀变化惩罚按每千条归一化', () => {
  const short = records(200, { hash: (i) => `h${Math.floor(i / 100)}` }); // 1 次 / 200 条
  const long = records(2000, { hash: (i) => `h${Math.floor((i * 11) / 2000)}` }); // 10 次 / 2000 条
  const a = cacheHealth(okUsage(short));
  const b = cacheHealth(okUsage(long));
  assert.equal(a.score, b.score);
  const hintA = a.evidence.find((e) => e.label === '前缀哈希变化').hint;
  const hintB = b.evidence.find((e) => e.label === '前缀哈希变化').hint;
  assert.equal(hintA, hintB);
});

test('缓存：扣了前缀分时 headline 不再自称「前缀相当稳」', () => {
  const recs = records(200, { input: 10000, cached: 9900, hash: (i) => `h${i}` });
  const d = cacheHealth(okUsage(recs));
  assert.ok(d.score < 100);
  assert.equal(d.headline.includes('前缀相当稳'), false, `实得：${d.headline}`);
  assert.ok(d.headline.includes('前缀换得勤'));
});

test('缓存：命中率低会掉到 bad', () => {
  const recs = records(200, { input: 10000, cached: 1000 });
  const d = cacheHealth(okUsage(recs));
  assert.equal(d.state, 'bad');
});

/* ------------------------------------------------------------ 上下文配置 */

const okConfig = (context = {}, rounds = {}) => ({
  ok: true,
  path: 'config.json',
  reason: null,
  context: { maxTokens: 256000, keepRatio: 0.25, softRatio: 0.85, firstTurn: false, ...context },
  rounds: { soft: 20, hard: 40, ...rounds },
  activeProvider: 'qwen',
});

test('上下文：256000 对 128k 窗口 → 第①条判不行（真问题显形）', () => {
  const d = contextConfig(okConfig(), 128000);
  const first = d.evidence[0];
  assert.equal(first.value, '✗');
  assert.ok(d.score > 80 && d.score < 95, `got ${d.score}`);
});

test('上下文：soft20/hard40 第④条满分', () => {
  // 512k 窗口下 maxTokens 256000 也在九成以内 → 五项全过。
  const d = contextConfig(okConfig(), 512000);
  const fourth = d.evidence[3];
  assert.equal(fourth.value, '✓');
  assert.equal(d.score, 100);
});

test('上下文：256000 恰好等于 256k 窗口 → 判「勉强」而不是「不行」', () => {
  const d = contextConfig(okConfig(), 256000);
  assert.equal(d.evidence[0].value, '~');
  assert.ok(d.score > 90, `got ${d.score}`);
});

test('上下文：窗口未知按 128k 兜底并在证据里写明', () => {
  const d = contextConfig(okConfig(), null);
  assert.ok(d.evidence[0].hint.includes('窗口未知'));
});

test('上下文：缺 context → unknown，不猜默认值', () => {
  const d = contextConfig({ ok: true, path: 'c', context: null, rounds: { soft: 20, hard: 40 } }, 128000);
  assert.equal(d.state, 'unknown');
  assert.equal(d.score, null);
});

test('上下文：缺单项数值记 unknown，从分母剔除而不是判差', () => {
  const d = contextConfig(okConfig({ softRatio: null }), 512000);
  const row = d.evidence.find((e) => e.label.startsWith('softRatio'));
  assert.equal(row.value, '?');
  assert.ok(row.hint.includes('缺值'));
  assert.equal(d.score, 100, '其余四项全过 → 100，不被缺值拖低');
  assert.ok(d.headline.includes('1 项缺值'));
});

test('上下文：窗口未知时第①条记 unknown 而不是 ✗', () => {
  const d = contextConfig(okConfig(), null);
  assert.equal(d.evidence[0].value, '?');
  assert.equal(d.score, 100);
});

test('上下文：五项全缺值 → unknown，不给分数', () => {
  const d = contextConfig(okConfig({ maxTokens: null, keepRatio: null, softRatio: null }, { soft: null, hard: null }), 512000);
  assert.equal(d.state, 'unknown');
  assert.equal(d.score, null);
});

test('上下文：hard 略小于 soft×1.5 记「勉强」而不是「不行」', () => {
  const d = contextConfig(okConfig({}, { soft: 20, hard: 25 }), 256000);
  assert.equal(d.evidence[3].value, '~');
  assert.ok(d.score > 90, `got ${d.score}`);
});

/* ------------------------------------------------------------ 交接 */

function handoffs(gapsMin, { size = 400, sameHash = false } = {}) {
  const base = Date.parse('2026-11-20T00:00:00+08:00');
  const files = [];
  let t = base;
  for (let i = 0; i < gapsMin.length + 1; i += 1) {
    files.push({
      name: `f${i}.md`,
      ts: t,
      size,
      sha1: sameHash ? 'same' : `h${i}`,
    });
    if (gapsMin[i] !== undefined) t += gapsMin[i] * 60000;
  }
  return { ok: true, path: 'handoffs', reason: null, files, total: files.length };
}

test('交接：间隔整齐满分', () => {
  const d = handoffHealth(handoffs([30, 30, 30, 30, 30, 30]));
  assert.equal(d.score, 100);
  assert.equal(d.state, 'ok');
});

test('交接：两份哈希相同扣分', () => {
  const d = handoffHealth(handoffs([30, 30, 30, 30, 30], { sameHash: true }));
  const dup = d.evidence.find((e) => e.label === '相邻两份内容不重复');
  assert.equal(dup.value, '✗');
  assert.ok(d.score < 100);
});

test('交接：含 120B 薄文件记「勉强」', () => {
  const h = handoffs([30, 30, 30, 30]);
  h.files[1].size = 120;
  const d = handoffHealth(h);
  const thin = d.evidence.find((e) => e.label === '单份体量 ≥200 字节');
  assert.equal(thin.value, '~');
  assert.ok(d.score < 100);
});

test('交接：偶尔一次间隔过密记「勉强」', () => {
  const d = handoffHealth(handoffs([30, 3, 30, 30, 30]));
  const close = d.evidence.find((e) => e.label === '间隔不短于 10 分钟');
  assert.equal(close.value, '~');
  assert.ok(d.score < 100);
});

test('交接：文件太少给 unknown', () => {
  const d = handoffHealth(handoffs([30, 30]));
  assert.equal(d.state, 'unknown');
});

/* ------------------------------------------------------------ 记忆 */

function memory({ entries, retrieve, sizes } = {}) {
  return {
    ok: true,
    path: 'memory',
    reason: null,
    entries: {
      total: 1000, invalid: 10, stale: 100, recent: 200, tagCount: 100,
      tagDiversity: 0.1, valenceNonZeroRatio: 0.2, avgWeight: 0.2,
      ...entries,
    },
    retrieve: { total: 500, hitRate: 0.6, injectedRate: 0.5, avgMs: 120, avgQueryLen: 20, ...retrieve },
    sizes: { entries: 1_000_000, retrieve: 2_000_000, ...sizes },
    problems: [],
  };
}

test('记忆：正常数据满分', () => {
  const d = memoryHealth(memory());
  assert.equal(d.score, 100);
  assert.equal(d.state, 'ok');
});

test('记忆：retrieve 是 entries 的 5.4 倍记「勉强」而不是不行', () => {
  const d = memoryHealth(memory({ sizes: { entries: 1_060_000, retrieve: 5_780_000 } }));
  const ratio = d.evidence.find((e) => e.label === '检索日志不超过条目库 3 倍');
  assert.equal(ratio.value, '~');
  assert.ok(d.score < 100);
});

test('记忆：命中率太低扣分', () => {
  const d = memoryHealth(memory({ retrieve: { hitRate: 0.065 } }));
  const hit = d.evidence.find((e) => e.label === '检索命中率 ≥40%');
  assert.equal(hit.value, '✗');
});

test('记忆：目录不存在给 unknown', () => {
  const d = memoryHealth({ ok: false, path: 'm', reason: 'missing' });
  assert.equal(d.state, 'unknown');
});

/* ------------------------------------------------------------ 汇总 */

test('汇总：全 unknown 不给总分', () => {
  const s = summarize([
    { weight: 0.5, score: null },
    { weight: 0.5, score: null },
  ]);
  assert.equal(s.overall, null);
  assert.equal(s.levelKey, 'insufficient');
});

test('汇总：unknown ≥2 维不给总分', () => {
  const s = summarize([
    { weight: 0.25, score: 90 },
    { weight: 0.25, score: null },
    { weight: 0.25, score: null },
    { weight: 0.25, score: 80 },
  ]);
  assert.equal(s.overall, null);
  assert.equal(s.unknownCount, 2);
});

test('汇总：unknown 1 维权重重归一化', () => {
  const s = summarize([
    { weight: 0.5, score: 100 },
    { weight: 0.25, score: 50 },
    { weight: 0.25, score: null },
  ]);
  // (100*0.5 + 50*0.25) / 0.75 = (50+12.5)/0.75 = 83.33
  assert.equal(s.overall, 83);
  assert.equal(s.scoredCount, 2);
});

test('汇总：等级阈值', () => {
  assert.equal(levelOf(85).levelKey, 'solid');
  assert.equal(levelOf(84).levelKey, 'good');
  assert.equal(levelOf(76).levelKey, 'good');
  assert.equal(levelOf(75).levelKey, 'fair');
  assert.equal(levelOf(58).levelKey, 'fair');
  assert.equal(levelOf(57).levelKey, 'poor');
});

test('grade：分数到状态的映射（阈值随量纲放宽）', () => {
  assert.equal(grade(78), 'ok');
  assert.equal(grade(77), 'warn');
  assert.equal(grade(60), 'warn');
  assert.equal(grade(59), 'bad');
  assert.equal(grade(null), 'unknown');
});

test('汇总：带量纲版本号，便于旧报告对账', () => {
  const s = summarize([{ weight: 1, score: 90 }]);
  assert.ok(typeof s.calibration === 'string' && s.calibration.length > 0);
});

test('runHardware：空快照六个维度全 unknown', () => {
  const hw = runHardware({ usage: { ok: false }, config: { ok: false }, handoffs: { ok: false, files: [] }, memory: { ok: false } });
  assert.equal(hw.unknownCount, 6);
  assert.equal(hw.overall, null);
});

/* ------------------------------------------------------------ 逐日序列 */

/** 造一批跨 N 天的记录，每天 perDay 条；failedOn 指定哪些天全失败。 */
function multiDay(days, perDay, { failDays = [], elapsedMs = 2000 } = {}) {
  const base = Date.parse('2026-11-10T09:00:00+08:00');
  const out = [];
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay; i += 1) {
      out.push({
        ts: base + d * 86400000 + i * 60000,
        model: 'm',
        outcome: failDays.includes(d) ? 'failed' : 'completed',
        status: 200,
        elapsedMs,
        input: 1000,
        output: 10,
        cachedInput: 900,
        prefixHash: 'h',
        run: 'r',
        purpose: 'generation',
      });
    }
  }
  return out;
}

test('稳定性：多天数据出逐日序列，且断点留 null', () => {
  // 6 天 × 12 条 = 72 条（过 50 条总门槛），其中一天被削到 4 条（低于单日 5 条门槛）
  const recs = multiDay(6, 12, { failDays: [5] });
  const base = Date.parse('2026-11-10T09:00:00+08:00');
  const day3 = recs.filter((r) => Math.floor((r.ts - base) / 86400000) === 3);
  const keep = new Set(day3.slice(0, 4));
  for (const r of day3) if (!keep.has(r)) recs.splice(recs.indexOf(r), 1);

  const d = stability(okUsage(recs));
  assert.ok(Array.isArray(d.series));
  assert.equal(d.series.length, 6);
  const thin = d.series.find((p) => p.n < 5);
  assert.ok(thin, '应有一天样本不足');
  assert.equal(thin.score, null, '样本不足那天留 null，不假装有分');
  assert.ok(d.series.filter((p) => Number.isFinite(p.score)).length >= 4);
});

test('稳定性：前面好后面坏 → delta 为负', () => {
  // 6 天 × 12 条，后 3 天全失败
  const recs = multiDay(6, 12, { failDays: [3, 4, 5] });
  const d = stability(okUsage(recs));
  assert.ok(Number.isFinite(d.delta), 'delta 应可算');
  assert.ok(d.delta < -20, `delta 应为明显负值，实得 ${d.delta}`);
});

test('稳定性：一直好 → delta 接近 0', () => {
  const recs = multiDay(6, 12);
  const d = stability(okUsage(recs));
  assert.ok(Number.isFinite(d.delta));
  assert.equal(Math.round(d.delta), 0);
});

test('稳定性：只有一天 → delta 为 null（没得比就明说）', () => {
  const recs = multiDay(1, 60);
  const d = stability(okUsage(recs));
  assert.equal(d.delta, null);
  assert.equal(d.series.length, 1);
  assert.equal(d.series.filter((p) => Number.isFinite(p.score)).length, 1);
});

test('速度：多天出序列，变慢则 delta 为负', () => {
  const base = Date.parse('2026-11-10T09:00:00+08:00');
  const recs = multiDay(6, 12, { elapsedMs: 3000 });
  for (const r of recs) {
    const day = Math.floor((r.ts - base) / 86400000);
    if (day >= 3) r.elapsedMs = 45000;   // 后三天明显变慢
  }
  const d = latency(okUsage(recs));
  assert.equal(d.series.length, 6);
  assert.ok(Number.isFinite(d.delta));
  assert.ok(d.delta < 0, `变慢应 delta 为负，实得 ${d.delta}`);
  assert.ok(d.series.at(-1).score < d.series[0].score, '最后一天应比第一天低');
});

test('缓存：多天出序列', () => {
  const recs = multiDay(5, 12);
  const d = cacheHealth(okUsage(recs));
  assert.equal(d.series.length, 5);
  assert.ok(d.series.every((p) => p.score === 100 || p.score === null));
  assert.equal(d.delta, 0);
});

test('缓存：逐日序列包含前缀变化惩罚，而不只看命中率', () => {
  const recs = multiDay(3, 20).map((r, i) => {
    const day = Math.floor(i / 20);
    return { ...r, prefixHash: day === 1 ? `h${i}` : 'stable' };
  });
  const d = cacheHealth(okUsage(recs));
  assert.equal(d.series.length, 3);
  assert.equal(d.series[0].score, 100, '第一天前缀没变，满分');
  // 第二天前缀每条都变：19 次 / 20 条 → 惩罚封顶 18，原始 82 → 映射约 87
  assert.ok(d.series[1].score < 95 && d.series[1].score > 80, `got ${d.series[1].score}`);
  assert.equal(d.series[2].score, 100, '第三天恢复稳定');
});

test('结构性维度（上下文/交接/记忆）series 为空、delta 为 null', () => {
  const hw = runHardware({
    usage: okUsage(multiDay(3, 20)),
    config: {
      ok: true,
      context: { maxTokens: 100000, keepRatio: 0.25, softRatio: 0.85, firstTurn: false },
      rounds: { soft: 20, hard: 40 },
    },
    handoffs: { ok: true, files: [], total: 0 },
    memory: { ok: false },
  });
  const byId = Object.fromEntries(hw.dimensions.map((d) => [d.id, d]));
  for (const id of ['context', 'handoff', 'memory']) {
    assert.deepEqual(byId[id].series, [], `${id} 不该有序列`);
    assert.equal(byId[id].delta, null);
  }
  // 而用量派生的三个维度应该有
  assert.ok(byId.stability.series.length > 0);
});

test('所有维度都带 series / delta 字段（UI 不用判 undefined）', () => {
  const hw = runHardware({
    usage: { ok: false }, config: { ok: false }, handoffs: { ok: false, files: [] }, memory: { ok: false },
  });
  for (const d of hw.dimensions) {
    assert.ok('series' in d, `${d.id} 缺 series`);
    assert.ok('delta' in d, `${d.id} 缺 delta`);
  }
});
