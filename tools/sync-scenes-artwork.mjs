import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCENES_DIR = join(ROOT, 'assets', 'personality', 'scenes');
const TARGET = join(ROOT, 'dist', 'webui.js');
const START = '/* EXTRA_SCENES_START */';
const END = '/* EXTRA_SCENES_END */';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const entries = [];
if (existsSync(SCENES_DIR)) {
  for (const name of readdirSync(SCENES_DIR).sort()) {
    const ext = extname(name).toLowerCase();
    const mime = MIME[ext];
    if (!mime) continue;
    const key = name.slice(0, -ext.length);
    const data = readFileSync(join(SCENES_DIR, name)).toString('base64');
    entries.push(`  ${JSON.stringify(key)}: "data:${mime};base64,${data}"`);
  }
}

const block = `${START}\nObject.assign(SCENE_ARTWORK, {\n${entries.join(',\n')}\n});\n${END}`;
let js = readFileSync(TARGET, 'utf8');
if (js.includes(START) && js.includes(END)) {
  js = js.replace(new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), block);
} else {
  const anchor = 'const SCENE_ARTWORK = {';
  const startIdx = js.indexOf(anchor);
  if (startIdx < 0) throw new Error('SCENE_ARTWORK not found in dist/webui.js');
  const endIdx = js.indexOf('};', startIdx);
  if (endIdx < 0) throw new Error('SCENE_ARTWORK closing brace not found');
  const lineEnd = js.indexOf('\n', endIdx);
  const insertAt = lineEnd >= 0 ? lineEnd + 1 : endIdx + 2;
  js = `${js.slice(0, insertAt)}${block}\n${js.slice(insertAt)}`;
}
writeFileSync(TARGET, js, 'utf8');
console.log(`Synchronized ${entries.length} expressive personality scene artworks.`);
