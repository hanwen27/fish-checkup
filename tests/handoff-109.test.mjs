import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readHandoffs } from '../src/collect.mjs';
import { handoffHealth } from '../src/hardware.mjs';
import { buildReport } from '../src/report.mjs';

const start = Date.parse('2026-11-20T00:00:00Z');
const stamp = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-') + '.md';

function withNotes(names, check) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-109-'));
  try {
    const dir = join(root, 'handoffs');
    mkdirSync(dir);
    for (const [i, name] of names.entries()) {
      const path = join(dir, name);
      writeFileSync(path, `真实交接记录 ${i}\n`.repeat(40), 'utf8');
      const batchCopy = start / 1000 + 86400 + i * .8;
      utimesSync(path, batchCopy, batchCopy);
    }
    check(readHandoffs(root, { now: new Date(start + 2 * 86400_000) }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const evidence = (dimension, label) => dimension.evidence.find((row) => row.label === label);

test('Native Coo UTC filenames keep 30-minute gaps after a batch copy', () => {
  withNotes(Array.from({ length: 10 }, (_, i) => stamp(start + i * 30 * 60_000)), (handoffs) => {
    assert.ok(handoffs.files.every(({ timeSource }) => timeSource === 'filename-utc'));
    assert.equal(handoffs.files[0].ts, start);
    const result = handoffHealth(handoffs);
    assert.equal(evidence(result, '平均间隔').value, '30 分钟');
    assert.equal(evidence(result, '间隔不短于 10 分钟').value, '✓');
    assert.equal(result.timing.verifiedGaps, 9);
  });
});

test('Real second-scale gaps show seconds and still count as short', () => {
  withNotes(Array.from({ length: 10 }, (_, i) => stamp(start + i * 2000)), (handoffs) => {
    const result = handoffHealth(handoffs);
    assert.equal(evidence(result, '平均间隔').value, '2 秒');
    assert.match(evidence(result, '间隔不短于 10 分钟').hint, /9\/9 段短于 10 分钟/);
  });
});

test('Unknown dates and modification-only files yield missing timing rather than nine short gaps', () => {
  withNotes(['2026-02-30T12-00-00Z.md', ...Array.from({ length: 9 }, (_, i) => `import-${i}.md`)], (handoffs) => {
    assert.ok(handoffs.files.every(({ timeSource }) => timeSource === 'mtime'));
    const result = handoffHealth(handoffs);
    assert.equal(result.score, null);
    assert.equal(result.state, 'unknown');
    assert.equal(evidence(result, '平均间隔').value, '—');
    assert.match(evidence(result, '平均间隔').hint, /可核验 0\/9 段/);
    assert.match(evidence(result, '间隔不短于 10 分钟').hint, /暂不判断频率/);
    const report = buildReport({ handoffs }, { language: 'zh' });
    assert.equal(report.summary.unknown.find(({ id }) => id === 'handoff').trendStatus, '间隔样本不足');
  });
});

test('Legacy minute timestamps still work and same-minute duplicates are skipped', () => {
  withNotes(['20261120-0900-auto.md', '20261120-0900-backup.md', '20261120-0930-auto.md', '20261120-1000-auto.md'], (handoffs) => {
    assert.ok(handoffs.files.every(({ timeSource }) => timeSource === 'filename-local'));
    const result = handoffHealth(handoffs);
    assert.equal(evidence(result, '平均间隔').value, '30 分钟');
    assert.deepEqual(result.timing, { verifiedGaps: 2, unavailable: 1 });
    assert.equal(evidence(result, '间隔不短于 10 分钟').value, '✓');
  });
});
