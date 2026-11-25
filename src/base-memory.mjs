import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { finishFishTopics, observeFishTopics } from './fish-topics.mjs';

const MAX_DIRS = 128;
const MAX_FILES = 64;
const TEXT_FILE = /\.(?:md|txt|json|yaml|yml|toml|csv)$/iu;
const DATED_NOTE = /^(\d{4}-\d{2}-\d{2})\.(?:md|txt)$/iu;
const NOTE_FOLDERS = new Set(['memory', 'memories', 'daily', 'diary']);
const NOTE_BYTES = 16 * 1024;

function canOpen(file) {
  try {
    closeSync(openSync(file, 'r'));
    return true;
  } catch {
    return false;
  }
}

function collectDatedNote(tally, file, name, since, until) {
  const day = DATED_NOTE.exec(name)?.[1];
  if (!day || day < since || day > until) return;
  const date = new Date(day);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return;
  try {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(NOTE_BYTES);
      const count = readSync(fd, buffer, 0, NOTE_BYTES, 0);
      observeFishTopics(tally, buffer.toString('utf8', 0, count), day);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The file-access check above still determines the health result.
  }
}

// Keep only aggregate topic counts from dated notes in recognizable journal folders.
// Optional memories may coexist, but do not define this check's score.
export function readBaseMemory(workspace, { now = new Date(), profileDays = 14 } = {}) {
  const result = { path: workspace, state: 'missing', constitution: null, readable: 0, sampled: 0, limited: false, blockedDirs: 0 };
  if (!workspace) return result;
  try {
    if (!statSync(workspace).isDirectory()) return { ...result, state: 'not-directory' };
  } catch (err) {
    return err?.code === 'ENOENT' ? result : { ...result, state: 'unreadable' };
  }

  let rootEntries;
  try {
    rootEntries = readdirSync(workspace, { withFileTypes: true });
  } catch {
    return { ...result, state: 'unreadable' };
  }
  result.state = 'ready';
  const constitution = rootEntries.find(({ name }) => name === 'CONSTITUTION.md');
  if (constitution?.isFile()) result.constitution = canOpen(join(workspace, constitution.name));

  const queue = [{ dir: workspace, entries: rootEntries }];
  const topics = new Map();
  const since = new Date(now.getTime() - profileDays * 86400000).toISOString().slice(0, 10);
  const until = now.toISOString().slice(0, 10);
  let index = 0;
  while (index < queue.length && index < MAX_DIRS && result.sampled < MAX_FILES) {
    const { dir, entries } = queue[index++];
    let files;
    try {
      files = (entries ?? readdirSync(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      result.blockedDirs += 1;
      continue;
    }
    for (const entry of files) {
      if (entry.name.startsWith('.') || entry.name === 'CONSTITUTION.md') continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (queue.length < MAX_DIRS) queue.push({ dir: file });
        else result.limited = true;
      } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
        if (result.sampled === MAX_FILES) {
          result.limited = true;
          break;
        }
        result.sampled += 1;
        if (canOpen(file)) {
          result.readable += 1;
          if (NOTE_FOLDERS.has(relative(workspace, dir).split(sep, 1)[0].toLowerCase())) {
            collectDatedNote(topics, file, entry.name, since, until);
          }
        }
      }
    }
  }
  result.limited ||= index < queue.length;
  result.profileTopics = finishFishTopics(topics);
  return result;
}
