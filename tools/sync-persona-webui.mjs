import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_JS = join(ROOT, 'src', 'persona-showcase.mjs');
const SRC_CSS = join(ROOT, 'src', 'persona-showcase.css');
const DIST_JS = join(ROOT, 'dist', 'webui.js');
const DIST_CSS = join(ROOT, 'dist', 'webui.css');

const JS_START = '/* PERSONA_SHOWCASE_START */';
const JS_END = '/* PERSONA_SHOWCASE_END */';
const CSS_START = '/* PERSONA_SHOWCASE_STYLE_START */';
const CSS_END = '/* PERSONA_SHOWCASE_STYLE_END */';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 1. Inject showcase helper + call into dist/webui.js
const helper = `${JS_START}\n${readFileSync(SRC_JS, 'utf8').trim()}\n${JS_END}`;
let js = readFileSync(DIST_JS, 'utf8');
if (js.includes(JS_START) && js.includes(JS_END)) {
  js = js.replace(new RegExp(`${escRe(JS_START)}[\\s\\S]*?${escRe(JS_END)}`), helper);
} else {
  const anchor = 'function renderLegacyPersona(ctx, report, panelActions)';
  const idx = js.indexOf(anchor);
  if (idx < 0) throw new Error('renderLegacyPersona anchor not found in dist/webui.js');
  js = `${js.slice(0, idx)}${helper}\n\n${js.slice(idx)}`;
}
const callMarker = 'if (typeof enhancePersonaShowcase === \'function\') enhancePersonaShowcase(root, report, ctx);';
if (!js.includes(callMarker)) {
  const target = '  if (profile.candidates && (profile.cues?.length || profile.recent.some((item) => !item.empty))) root.append(cardEditor(ctx, panelActions, zh));\n  return root;';
  const targetCrlf = target.replace(/\n/g, '\r\n');
  if (js.includes(target)) {
    js = js.replace(target, `${target.replace('  return root;', `  ${callMarker}\n  return root;`)}`);
  } else if (js.includes(targetCrlf)) {
    js = js.replace(targetCrlf, `${targetCrlf.replace('  return root;', `  ${callMarker}\r\n  return root;`)}`);
  } else {
    throw new Error('persona return root anchor not found');
  }
}
writeFileSync(DIST_JS, js, 'utf8');

// 2. Inject showcase CSS into dist/webui.css
const cssBlock = readFileSync(SRC_CSS, 'utf8').trim();
let css = readFileSync(DIST_CSS, 'utf8');
if (css.includes(CSS_START) && css.includes(CSS_END)) {
  css = css.replace(new RegExp(`${escRe(CSS_START)}[\\s\\S]*?${escRe(CSS_END)}`), cssBlock);
} else {
  css = `${css.trimEnd()}\n\n${cssBlock}\n`;
}
writeFileSync(DIST_CSS, css, 'utf8');
console.log('Synchronized Shareable Persona Showcase UI.');
