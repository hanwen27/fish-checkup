/** Navigation within one COO panel; all transport stays on the parent panel. */
let groupedPanelSerial = 0;
export function makeGroupedPanel(baseId, panels) {
  let remembered = baseId;
  return { async mount(ctx) {
    if (ctx.signal?.aborted) return;
    const zh = String(ctx.language ?? 'zh').toLowerCase().startsWith('zh');
    const el = (tag, className, text) => {
      const node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const id = `sc-group-${++groupedPanelSerial}`;
    const shell = el('section', 'sc-panel sc-group-shell');
    const toolbar = el('div', 'sc-group-toolbar');
    const tabs = el('nav', 'sc-group-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', zh ? '运行健康检查项' : 'Operational health views');
    const content = el('div', 'sc-group-content'); content.id = `${id}-content`;
    const help = el('button', 'sc-deep-button sc-group-help', zh ? '方法说明' : 'Method');
    help.type = 'button'; help.id = `${id}-help`; help.setAttribute('aria-controls', content.id);
    const buttons = new Map();
    if (baseId === 'hardware') {
      for (const [key, label] of [
        ['hardware', zh ? '总览' : 'Overview'], ['tokens', zh ? 'Token 消耗' : 'Token usage'],
        ['memory-coverage', zh ? '记忆状态' : 'Memory status']
      ]) {
        const button = el('button', 'sc-group-tab', label); button.type = 'button';
        button.id = `${id}-${key}`; button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', content.id); button.dataset.view = key;
        button.addEventListener('click', () => select(key), { signal: ctx.signal });
        buttons.set(key, button); tabs.append(button);
      }
      toolbar.append(tabs);
    }
    toolbar.append(help); shell.append(toolbar, content); ctx.root.append(shell);
    let current = remembered, child;
    ctx.signal?.addEventListener('abort', () => child?.abort(), { once: true });
    help.addEventListener('click', () => select(current === 'method' ? remembered : 'method'), { signal: ctx.signal });
    async function select(key) {
      if (ctx.signal?.aborted || !panels[key]) return;
      child?.abort(); child = new AbortController();
      const signal = child.signal; current = key;
      if (key !== 'method') remembered = key;
      const isHelp = key === 'method'; tabs.hidden = isHelp;
      help.textContent = isHelp ? (zh ? '返回体检' : 'Back to checkup') : (zh ? '方法说明' : 'Method');
      help.setAttribute('aria-pressed', String(isHelp));
      for (const [view, button] of buttons) button.setAttribute('aria-selected', String(view === key));
      const mountRoot = el('div', 'sc-group-body');
      if (baseId === 'hardware' || isHelp) {
        mountRoot.setAttribute('role', 'tabpanel');
        mountRoot.setAttribute('aria-labelledby', isHelp ? help.id : buttons.get(key).id);
      }
      content.replaceChildren(mountRoot);
      const childCtx = {
        ...ctx, root: mountRoot, signal,
        async invoke(method, args = []) {
          if (isHelp) method = ({ report: 'methodReport', text: 'methodText', refresh: 'methodRefresh' })[method] ?? method;
          return ctx.invoke(method, args);
        },
        interval(fn, ms) {
          const timer = setInterval(() => { if (!signal.aborted) fn(); }, ms);
          signal.addEventListener('abort', () => clearInterval(timer), { once: true }); return timer;
        },
        timeout(fn, ms) {
          const timer = setTimeout(() => { if (!signal.aborted) fn(); }, ms);
          signal.addEventListener('abort', () => clearTimeout(timer), { once: true }); return timer;
        }
      };
      try { await panels[key].mount(childCtx); }
      catch { if (!signal.aborted) mountRoot.replaceChildren(el('p', 'sc-prose', zh ? '页面暂时无法加载，请刷新后重试。' : 'Unable to load this view. Please refresh.')); }
    }
    await select(current);
  } };
}
