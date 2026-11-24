import { closeSync, openSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_DIRS = 128;
const MAX_FILES = 64;
const TEXT_FILE = /\.(?:md|txt|json|yaml|yml|toml|csv)$/iu;

function canOpen(file) {
  try {
    closeSync(openSync(file, 'r'));
    return true;
  } catch {
    return false;
  }
}

// Read only workspace directory metadata and probe accessible files.
// Optional memories may coexist, but do not define this check's score.
export function readBaseMemory(workspace) {
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
        if (canOpen(file)) result.readable += 1;
      }
    }
  }
  result.limited ||= index < queue.length;
  return result;
}
