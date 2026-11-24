import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readJsonFile(file) {
  const bytes = readFileSync(file);
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/u, '');
  return JSON.parse(text);
}

function exportEntry(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return exportEntry(value['.'] ?? value.import ?? value.default);
  }
  return undefined;
}

// Follow the same entry precedence as Core for installed bot packages.
export async function loadBotDefaults(packageDir, botDir) {
  if (!packageDir) return undefined;
  const manifestPath = join(packageDir, 'package.json');
  const manifest = existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
  let rel = 'index.ts';
  if (manifest?.cortico?.kind === 'bot') {
    rel = exportEntry(manifest.exports) ?? manifest.module ?? manifest.main ?? 'index.js';
  } else if (resolve(packageDir) === resolve(botDir) || manifest?.cortico?.kind) {
    return undefined;
  }
  if (typeof rel !== 'string' || isAbsolute(rel)) return undefined;
  const entry = resolve(packageDir, rel);
  const inside = relative(resolve(packageDir), entry);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || !existsSync(entry)) return undefined;
  const bot = (await import(pathToFileURL(entry).href)).default;
  const defaults = bot?.defaults?.();
  return defaults ? { context: defaults.context, rounds: defaults.rounds, paths: defaults.paths } : undefined;
}
