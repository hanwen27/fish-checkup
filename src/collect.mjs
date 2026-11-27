/**
 * 采集层：把磁盘上的真实文件读成「原始样本」，不做任何判断、不打分。
 * 原则：
 *   · 只读。除 dataDir/self-checkup/ 之外不写任何路径。
 *   · 大文件不整读：usage.jsonl 从尾部按块倒着读，凑够窗口或行数就停。
 *   · 单文件失败不抛错：记进 problems[]，该维度自己降级成 unknown。
 */

import { openSync, readSync, closeSync, statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

/** 读尾部用的块大小。 */
const TAIL_CHUNK = 1 << 20; // 1 MiB

import { finishDecisions, observeDecision, profileClock, profileDecisions } from './profile.mjs';
import { sampleRecentActivity } from './recent-fish.mjs';
import { finishFishTopics, observeFishTopics } from './fish-topics.mjs';
import { readJsonFile } from './deployment.mjs';
import { readBaseMemory } from './base-memory.mjs';

/** 一次采集最多看多少条用量记录（够算 7 天，避免整读 63MB）。 */

const USAGE_MAX_LINES = 20000;

/** 记忆文件里最多扫多少行（防某些文件特别大）。 */
const MEMORY_MAX_LINES = 200000;

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** 从文件尾往前逐块读，返回按时间正序的「最近 maxLines 行」。 */
function readTailLines(path, maxLines) {
  const st = safeStat(path);
  if (!st || !st.isFile() || st.size === 0) return { lines: [], bytes: 0, truncated: false };
  const fd = openSync(path, 'r');
  try {
    let pos = st.size;
    let lineCount = 0;
    while (pos > 0 && lineCount <= maxLines) {
      const size = Math.min(TAIL_CHUNK, pos);
      const start = pos - size;
      pos -= size;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, pos);
      let boundary = null;
      for (let i = buf.length - 1; i >= 0; i -= 1) {
        if (buf[i] === 0x0a) {
          lineCount += 1;
          if (lineCount > maxLines) {
            boundary = start + i + 1;
            break;
          }
        }
      }
      if (boundary !== null) { pos = boundary; break; }
    }
    const tail = Buffer.alloc(st.size - pos);
    readSync(fd, tail, 0, tail.length, pos);
    const lines = tail.toString('utf8').split('\n').filter((l) => l.trim());
    return { lines: lines.slice(-maxLines), bytes: st.size, truncated: pos > 0 };
  } finally {
    closeSync(fd);
  }
}

function parseJsonLines(lines, { onBad } = {}) {
  const out = [];
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      bad += 1;
    }
  }
  if (bad && onBad) onBad(bad);
  return { rows: out, bad };
}

/** usage.jsonl → 近 sampleDays 天的用量样本。 */
export function readUsage(dataDir, { sampleDays = 7, now = new Date() } = {}) {
  const path = join(dataDir, 'usage.jsonl');
  const since = now.getTime() - sampleDays * 86400000;
  if (!existsSync(path)) {
    return { ok: false, path, reason: 'missing', records: [], skippedLines: 0 };
  }
  let skipped = 0;
  const { lines } = readTailLines(path, USAGE_MAX_LINES);
  const { rows, bad } = parseJsonLines(lines, { onBad: (n) => { skipped += n; } });
  const records = [];
  for (const row of rows) {
    const attempt = row?.attempt ?? {};
    const tsRaw = row?.ts ?? attempt.startedAt;
    const ts = typeof tsRaw === 'string' ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(ts)) { skipped += 1; continue; }
    if (ts < since || ts > now.getTime()) continue;
    const meters = attempt.meters ?? {};
    records.push({
      ts,
      model: attempt.origin?.model ?? row?.model ?? '',
      sessionId: row?.sessionId ?? row?.run ?? '',
      role: row?.role ?? '',
      outcome: attempt.outcome ?? '',
      status: numbered(attempt.status),
      elapsedMs: numbered(attempt.elapsedMs),
      input: numbered(meters.input) ?? numbered(row?.promptTokens),
      output: numbered(meters.output) ?? numbered(row?.completionTokens),
      cachedInput: Object.hasOwn(meters, 'cachedInput') ? numbered(meters.cachedInput) : numbered(row?.cacheHitTokens),
      prefixHash: typeof row?.prefixHash === 'string' ? row.prefixHash : '',
      run: typeof row?.run === 'string' ? row.run : '',
      purpose: attempt.purpose ?? '',
    });
  }
  return { ok: true, path, reason: null, records, skippedLines: skipped };
}

function numbered(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const section = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

function mergeSection(defaultValue, configuredValue) {
  const base = section(defaultValue);
  const override = section(configuredValue);
  if (configuredValue !== undefined && !override) return null;
  return base || override ? { ...base, ...override } : null;
}

/** 只返回报告所需的配置字段和记忆路径。 */
export function readRuntimeConfig(botDir, defaults) {
  const path = join(botDir, 'config.json');
  const exists = existsSync(path);
  if (!exists && !defaults) return { ok: false, path, reason: 'missing', context: null, rounds: null, activeProvider: '' };
  try {
    const raw = exists ? readJsonFile(path) : {};
    const paths = mergeSection(defaults?.paths, raw?.paths);
    const memoryPath = typeof paths?.memory === 'string' && paths.memory.trim() ? paths.memory : null;
    const dataPath = typeof paths?.data === 'string' && paths.data.trim() ? paths.data : null;
    const fishbrain = raw?.worlds?.fishbrain;
    const logs = fishbrain?.enabled === false ? null : fishbrain?.memory?.dir;
    return {
      ok: true,
      path,
      reason: null,
      context: mergeSection(defaults?.context, raw?.context),
      rounds: mergeSection(defaults?.rounds, raw?.rounds),
      activeProvider: typeof raw?.activeProvider === 'string' ? raw.activeProvider : '',
      memoryPath,
      memoryLogsPath: typeof logs === 'string' && logs.trim() ? logs : null,
      dataPath,
    };
  } catch (err) {
    return { ok: false, path, reason: `unreadable: ${err?.message ?? err}`, context: null, rounds: null, activeProvider: '' };
  }
}

/** handoffs/*.md → 最近 N 份的「时间 + 体量 + 内容指纹」。不保留正文。 */
export function readHandoffs(memoryDir, { limit = 30, sampleDays = 7, now = new Date() } = {}) {
  const dir = join(memoryDir, 'handoffs');
  if (!existsSync(dir)) return { ok: false, path: dir, reason: 'missing', files: [] };
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch (err) {
    return { ok: false, path: dir, reason: `unreadable: ${err?.message ?? err}`, files: [] };
  }
  const files = [];
  for (const name of names) {
    const abs = join(dir, name);
    const st = safeStat(abs);
    if (!st?.isFile()) continue;
    // 修改时间只用于安排未识别文件的浏览顺序，不能证明交接发生时间。
    const event = handoffTimestampFromName(name);
    files.push({
      name, abs, size: st.size, mtime: st.mtimeMs,
      ts: event?.ts ?? st.mtimeMs, timeSource: event?.source ?? 'mtime',
    });
  }
  files.sort((a, b) => a.ts - b.ts);
  const since = now.getTime() - sampleDays * 86400000;
  const recent = files.filter((f) => f.timeSource === 'mtime' || (f.ts >= since && f.ts <= now.getTime())).slice(-limit);
  for (const f of recent) {
    try {
      const body = readFileSync(f.abs, 'utf8');
      f.sha1 = createHash('sha1').update(body).digest('hex');
    } catch {
      f.sha1 = '';
    }
  }
  return { ok: true, path: dir, reason: null, files: recent, total: files.length };
}

function handoffTimestampFromName(name) {
  // Current Coo handoffNoteStamp writes UTC seconds with Windows-safe hyphens.
  const utc = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.md$/iu.exec(name);
  if (utc) {
    const [, day, hour, minute, second] = utc;
    const iso = `${day}T${hour}:${minute}:${second}.000Z`;
    const ts = Date.parse(iso);
    return Number.isFinite(ts) && new Date(ts).toISOString() === iso ? { ts, source: 'filename-utc' } : null;
  }
  const legacy = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:[-_][^\r\n]+)?\.md$/iu.exec(name);
  if (!legacy) return null;
  const [year, month, day, hour, minute] = legacy.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return { ts: date.getTime(), source: 'filename-local' };
}

/**
 * memory/*.jsonl 的聚合统计。只累计计数，不驻留原文。
 * entries    → 条目数、invalid 数、stale 数、tag 多样性
 * retrieve   → 检索次数、命中次数、耗时、query 长度
 * emotions   → valence/arousal 序列
 * decisions  → 回应率、长度中位数、置信度、kind 集中度、活跃小时分布
 * experience → 事件数（用来确认数据源活着）
 */
export function readMemory(memoryDir, { sampleDays = 7, now = new Date(), timezone, logDir } = {}) {
  const nested = join(memoryDir, 'memory');
  const ownsLogs = (path) => ['entries.jsonl', 'retrieve.jsonl', 'decisions.jsonl', 'emotions.jsonl']
    .some((name) => safeStat(join(path, name))?.isFile());
  const dir = logDir ?? (ownsLogs(nested) || !ownsLogs(memoryDir) ? nested : memoryDir);
  const workspaceExists = safeStat(memoryDir)?.isDirectory() ?? false;
  const profileDays = Math.max(sampleDays, 14);
  const since = now.getTime() - profileDays * 86400000;
  const clock = profileClock(timezone);
  const out = {
    ok: true,
    path: dir,
    workspacePath: memoryDir,
    workspaceExists,
    reason: null,
    entries: null,
    retrieve: null,
    emotions: null,
    decisions: null,
    experience: null,
    profileDays,
    profileDecisions: null,
    sizes: {},
    problems: [],
  };
  if (!existsSync(dir)) {
    return { ...out, ok: false, reason: 'missing' };
  }

  const stat = (name) => safeStat(join(dir, name));

  // ---- entries ----
  const entriesStat = stat('entries.jsonl');
  if (entriesStat) {
    out.sizes.entries = entriesStat.size;
    const newTopics = new Map();
    const recalledTopics = new Map();
    const acc = {
      total: 0, invalid: 0, stale: 0, recent: 0,
      tags: new Map(), valenceNonZero: 0, valenceCount: 0,
      weightSum: 0, weightCount: 0, profileCount: 0, profileRecalled: 0, days: new Set(),
    };
    try {
      const { rows } = parseJsonLines(readTailLines(join(dir, 'entries.jsonl'), MEMORY_MAX_LINES).lines);
      for (const e of rows) {
        acc.total += 1;
        if (e?.invalid === true) acc.invalid += 1;
        const at = Date.parse(e?.t ?? e?.at ?? '');
        if (Number.isFinite(at) && at >= since) {
          acc.recent += 1;
          if (at <= now.getTime() && e?.invalid !== true) {
            acc.profileCount += 1;
            const { day } = clock(new Date(at));
            acc.days.add(day);
            if (!e?.hidden && !e?.dupOf) observeFishTopics(newTopics, e.text, day);
          }
        }
        const lastHit = Date.parse(e?.lastHitAt ?? '');
        if (Number.isFinite(lastHit) && now.getTime() - lastHit > 30 * 86400000) acc.stale += 1;
        if (at < since && lastHit >= since && lastHit <= now.getTime()
          && e?.hits > 0 && !e?.invalid && !e?.hidden) {
          acc.profileRecalled += 1;
          if (!e?.dupOf) observeFishTopics(recalledTopics, e.text, clock(new Date(lastHit)).day);
        }
        for (const tag of Array.isArray(e?.tags) ? e.tags : []) {
          const k = String(tag);
          acc.tags.set(k, (acc.tags.get(k) ?? 0) + 1);
        }
        const valence = entryValence(e);
        if (valence !== null) {
          acc.valenceCount += 1;
          if (valence !== 0) acc.valenceNonZero += 1;
        }
        if (typeof e?.weight === 'number') {
          acc.weightCount += 1;
          acc.weightSum += e.weight;
        }
      }
    } catch (err) {
      out.problems.push(`entries: ${err?.message ?? err}`);
    }
    out.entries = {
      total: acc.total,
      invalid: acc.invalid,
      stale: acc.stale,
      recent: acc.recent,
      profileCount: acc.profileCount,
      profileRecalled: acc.profileRecalled,
      profileTopics: finishFishTopics(newTopics),
      recalledTopics: finishFishTopics(recalledTopics),
      profileDays: acc.days.size,
      tagCount: acc.tags.size,
      // 多样性 = 不同 tag 数 / 出现总次数（0..1）
      tagDiversity: [...acc.tags.values()].reduce((a, b) => a + b, 0) > 0
        ? acc.tags.size / [...acc.tags.values()].reduce((a, b) => a + b, 0)
        : null,
      valenceCount: acc.valenceCount,
      valenceNonZeroRatio: acc.valenceCount > 0 ? acc.valenceNonZero / acc.valenceCount : null,
      avgWeight: acc.weightCount > 0 ? acc.weightSum / acc.weightCount : 0,
    };
  }

  // ---- retrieve ----
  const retrStat = stat('retrieve.jsonl');
  if (retrStat) {
    out.sizes.retrieve = retrStat.size;
    const acc = { total: 0, hit: 0, injected: 0, msSum: 0, msCount: 0, queryLenSum: 0, pushes: 0 };
    try {
      const { rows } = parseJsonLines(readTailLines(join(dir, 'retrieve.jsonl'), MEMORY_MAX_LINES).lines);
      for (const r of rows) {
        const at = Date.parse(r?.at ?? '');
        if (!Number.isFinite(at) || at < since || at > now.getTime()) continue;
        acc.total += 1;
        if (Array.isArray(r?.hits) && r.hits.length > 0) acc.hit += 1;
        if (r?.injected === true) acc.injected += 1;
        if (r?.pushed === true) acc.pushes += 1;
        if (typeof r?.ms === 'number') { acc.msSum += r.ms; acc.msCount += 1; }
        if (typeof r?.query === 'string') acc.queryLenSum += r.query.length;
      }
    } catch (err) {
      out.problems.push(`retrieve: ${err?.message ?? err}`);
    }
    out.retrieve = {
      total: acc.total,
      hitRate: acc.total > 0 ? acc.hit / acc.total : null,
      injectedRate: acc.total > 0 ? acc.injected / acc.total : null,
      avgMs: acc.msCount > 0 ? acc.msSum / acc.msCount : null,
      avgQueryLen: acc.total > 0 ? acc.queryLenSum / acc.total : null,
    };
  }

  // ---- emotions ----
  const emoStat = stat('emotions.jsonl');
  if (emoStat) {
    out.sizes.emotions = emoStat.size;
    const series = [];
    try {
      const { rows } = parseJsonLines(readTailLines(join(dir, 'emotions.jsonl'), MEMORY_MAX_LINES).lines);
      for (const e of rows) {
        const at = Date.parse(e?.at ?? '');
        if (!Number.isFinite(at) || at < since || at > now.getTime()) continue;
        if (!Number.isFinite(e?.valence) || !Number.isFinite(e?.arousal)) continue;
        series.push({ at, valence: e.valence, arousal: e.arousal });
      }
    } catch (err) {
      out.problems.push(`emotions: ${err?.message ?? err}`);
    }
    series.sort((a, b) => a.at - b.at);
    out.emotions = {
      ...summarizeSeries(series),
      profileDays: new Set(series.map(({ at }) => clock(new Date(at)).day)).size,
    };
  }

  // ---- decisions ----
  const decStat = stat('decisions.jsonl');
  if (decStat) {
    out.sizes.decisions = decStat.size;
    const profile = profileDecisions();
    const acc = {
      total: 0, judged: 0, spoke: 0, lens: [], confSum: 0, confCount: 0,
      kinds: new Map(), hours: new Array(24).fill(0), addressed: 0, groupDecisions: 0, blocks: 0,
    };
    try {
      const { rows } = parseJsonLines(readTailLines(join(dir, 'decisions.jsonl'), MEMORY_MAX_LINES).lines);
      for (const d of rows) {
        const at = Date.parse(d?.at ?? '');
        if (!Number.isFinite(at) || at < since || at > now.getTime()) continue;
        if (!['answer', 'ask', 'act', 'hold', 'silent'].includes(d?.act)) continue;
        acc.judged += 1;
        const systemBlocked = Array.isArray(d?.blocks) && d.blocks.length > 0;
        observeDecision(profile, d, at, clock);
        if (systemBlocked) { acc.blocks += 1; continue; }
        acc.total += 1;
        if (d?.act && d.act !== 'silent') acc.spoke += 1;
        if (typeof d?.len === 'number') acc.lens.push(d.len);
        if (typeof d?.conf === 'number') { acc.confSum += d.conf; acc.confCount += 1; }
        if (typeof d?.addressed === 'boolean' && typeof d?.chat === 'string' && d.chat.startsWith('group:')) {
          acc.groupDecisions += 1;
          if (d.addressed) acc.addressed += 1;
        }
        const k = String(d?.kind ?? '');
        if (k) acc.kinds.set(k, (acc.kinds.get(k) ?? 0) + 1);
        acc.hours[new Date(at).getHours()] += 1;
      }
    } catch (err) {
      out.problems.push(`decisions: ${err?.message ?? err}`);
    }
    out.profileDecisions = finishDecisions(profile);
    out.decisions = {
      total: acc.total,
      judgedTotal: acc.judged,
      blockedCount: acc.blocks,
      groupDecisionCount: acc.groupDecisions,
      speakRate: acc.total > 0 ? acc.spoke / acc.total : null,
      medianLen: median(acc.lens),
      avgConf: acc.confCount > 0 ? acc.confSum / acc.confCount : null,
      addressedRate: acc.groupDecisions > 0 ? acc.addressed / acc.groupDecisions : null,
      blockedRate: acc.judged > 0 ? acc.blocks / acc.judged : null,
      kindConcentration: concentration([...acc.kinds.values()]),
      hourEntropy: normalizedEntropy(acc.hours),
      hourHistogram: acc.hours.slice(),
    };
  }

  // ---- experience（只数条数，确认数据源活着） ----
  const expStat = stat('experience.jsonl');
  if (expStat) {
    out.sizes.experience = expStat.size;
    try {
      const { rows } = parseJsonLines(readTailLines(join(dir, 'experience.jsonl'), 5000).lines);
      let n = 0;
      for (const e of rows) {
        const at = Date.parse(e?.ts ?? '');
        if (Number.isFinite(at) && at >= since) n += 1;
      }
      out.experience = { recent: n };
    } catch (err) {
      out.problems.push(`experience: ${err?.message ?? err}`);
    }
  }

  if (!out.entries && !out.retrieve && !out.decisions) {
    out.ok = false;
    out.reason = 'no-recognised-files';
  }
  return out;
}

function entryValence(entry) {
  const emotion = entry?.emotion;
  if (Number.isFinite(emotion)) return emotion;
  if (Number.isFinite(emotion?.valence)) return emotion.valence;
  if (typeof emotion === 'string') {
    const label = emotion.trim().toLowerCase();
    if (['calm', 'neutral', '平静', '中性'].includes(label)) return 0;
    if (label && !['unknown', 'none', 'n/a', '未知', '未标注'].includes(label)) return 1;
  }
  return Number.isFinite(entry?.valence) ? entry.valence : null;
}

function summarizeSeries(series) {
  if (series.length === 0) return { count: 0, meanValence: null, meanArousal: null, valenceSd: null, arousalSd: null, trend: null };
  const vals = series.map((s) => s.valence);
  const aros = series.map((s) => s.arousal);
  const meanV = mean(vals);
  const meanA = mean(aros);
  const half = Math.floor(series.length / 2);
  const early = series.slice(0, half).map((s) => s.valence);
  const late = series.slice(series.length - half).map((s) => s.valence);
  return {
    count: series.length,
    meanValence: meanV,
    meanArousal: meanA,
    valenceSd: sd(vals, meanV),
    arousalSd: sd(aros, meanA),
    trend: half > 0 ? mean(late) - mean(early) : null,
  };
}

export function mean(xs) {
  if (!xs || xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sd(xs, m = mean(xs)) {
  if (!xs || xs.length < 2) return null;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function median(xs) {
  if (!xs || xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 归一化香农熵：0 = 全挤在一处，1 = 完全均匀。 */
export function normalizedEntropy(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const n = counts.filter((c) => c > 0).length;
  if (n <= 1) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(counts.length);
}

/** 集中度 = 前两类占比；越高越「就那几件事」。 */
export function concentration(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const top = [...counts].sort((a, b) => b - a).slice(0, 2);
  return top.reduce((a, b) => a + b, 0) / total;
}

// 从近期运行文件尾部采样。只输出汇总，不把聊天正文或接收者带进报告。
function readRecentActivity(dataDir, since, now) {
  const dir = join(dataDir, 'runs');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^r-\d{8}-\d{6}-[a-z0-9]+$/i.test(entry.name))
    .map(({ name }) => join(dir, name, 'toolcalls.jsonl'))
    .map((file) => ({ file, last: safeStat(file)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 32);
  const rows = [];
  for (const { file } of runs) {
    const { rows: tail } = parseJsonLines(readTailLines(file, 300).lines);
    for (const row of tail) {
      const at = Date.parse(row?.ts);
      if (at >= since && at <= now && row.role === 'main') rows.push(row);
    }
  }
  return sampleRecentActivity(rows);
}

/** 一次拿齐所有原始样本。 */
export function collectAll({ botDir, dataDir, memoryDir, sampleDays = 7, now = new Date(), timezone, botDefaults, memoryDirOverride }) {
  const problems = [];
  let usage;
  try {
    usage = readUsage(dataDir, { sampleDays, now });
  } catch (err) {
    usage = { ok: false, path: join(dataDir, 'usage.jsonl'), reason: `unreadable: ${err?.message ?? err}`, records: [], skippedLines: 0 };
  }
  if (!usage.ok) problems.push(`usage.jsonl: ${usage.reason}`);

  let config;
  try {
    config = readRuntimeConfig(botDir, botDefaults);
  } catch (err) {
    config = { ok: false, path: join(botDir, 'config.json'), reason: `unreadable: ${err?.message ?? err}`, context: null, rounds: null, activeProvider: '' };
  }
  if (!config.ok) problems.push(`config.json: ${config.reason}`);

  const workspace = memoryDirOverride ?? (config.memoryPath ? resolve(botDir, config.memoryPath) : memoryDir);
  const logDir = !memoryDirOverride && config.memoryLogsPath ? resolve(botDir, config.memoryLogsPath) : undefined;
  let handoffs;
  try {
    handoffs = readHandoffs(workspace, { sampleDays, now });
  } catch (err) {
    handoffs = { ok: false, path: join(workspace, 'handoffs'), reason: `unreadable: ${err?.message ?? err}`, files: [] };
  }
  if (!handoffs.ok) problems.push(`handoffs: ${handoffs.reason}`);

  let memory;
  try {
    memory = readMemory(workspace, { sampleDays, now, timezone, logDir });
  } catch (err) {
    memory = { ok: false, path: logDir ?? join(workspace, 'memory'), reason: `unreadable: ${err?.message ?? err}`, problems: [] };
  }
  memory.base = readBaseMemory(workspace, { now, profileDays: Math.max(sampleDays, 14) });
  if (memory.base.state !== 'ready') problems.push(`workspace: ${memory.base.state}`);
  // 没有独立统计日志是正常部署，只有实际读取错误才计入采集问题。
  if (!memory.ok && memory.reason !== 'missing') problems.push(`memory statistics: ${memory.reason}`);
  problems.push(...(memory.problems ?? []));

  let activity = null;
  try {
    activity = readRecentActivity(dataDir, now.getTime() - Math.max(sampleDays, 14) * 86400000, now.getTime());
  } catch (err) {
    problems.push(`toolcalls.jsonl: ${err?.message ?? err}`);
  }
  return { usage, config, handoffs, memory, activity, problems, collectedAt: now.getTime(), sampleDays };
}
