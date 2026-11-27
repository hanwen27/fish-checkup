import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const file = new URL('dist/webui.js', root);
let ui = readFileSync(file, 'utf8');
const start = '/* GROUPED_UI_START */', end = '/* GROUPED_UI_END */';
if (ui.includes(start)) ui = ui.slice(0, ui.indexOf(start)) + ui.slice(ui.indexOf(end) + end.length);
const marker = '\nexport default {';
const source = readFileSync(new URL('src/grouped-webui.mjs', root), 'utf8').replace('export function', 'function');
const definition = `
const groupedViews = {
  hardware: makePanel(renderHardware), persona: makePanel(renderPersona), method: makePanel(renderMethod),
  'deep-checkup': makeDeepCheckupPanel(), tokens: makePassivePanel('tokens'),
  'memory-coverage': makePassivePanel('memory'), 'context-fit': makePassivePanel('context')
};
`;
if (!ui.includes(marker)) throw Error('Missing panel export');
const exportStart = ui.indexOf(marker);
ui = ui.slice(0, exportStart).trimEnd() + `\n\n${start}\n${source.trim()}\n${definition}${end}\n` + `
export default {
  panels: {
    hardware: makeGroupedPanel('hardware', groupedViews),
    persona: makeGroupedPanel('persona', groupedViews),
    'deep-checkup': makeGroupedPanel('deep-checkup', groupedViews),
    tokens: groupedViews.tokens,
    'memory-coverage': groupedViews['memory-coverage'],
    'context-fit': groupedViews['context-fit'],
    method: groupedViews.method
  }
};
`;
ui = ui.replaceAll('硬件健康', '运行健康').replaceAll('记忆覆盖', '记忆状态');
writeFileSync(file, ui);
const cssFile = new URL('dist/webui.css', root);
let css = readFileSync(cssFile, 'utf8');
const cssStart = '/* GROUPED_STYLE_START */', cssEnd = '/* GROUPED_STYLE_END */';
if (css.includes(cssStart)) css = css.slice(0, css.indexOf(cssStart)) + css.slice(css.indexOf(cssEnd) + cssEnd.length);
css = css.trimEnd() + '\n\n' + readFileSync(new URL('src/grouped-webui.css', root), 'utf8').trim() + '\n';
writeFileSync(cssFile, css);
console.log('Synchronized three main categories, four operational subpages and method help.');
