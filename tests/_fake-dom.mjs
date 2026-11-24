/**
 * 用一个最小假 DOM 把 dist/webui.js 的三个面板各 mount 一遍。
 *
 * 目的不是验证长相，是抓「render 里引用了不存在的字段 / 调了 ctx 没有的方法」
 * 这类一挂就白屏的错误。真 DOM 里的排版仍要人眼看。
 */

class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this._text = '';
    this._html = '';
    this.className = '';
    this.classList = {
      add: (...n) => { this.className = [this.className, ...n].filter(Boolean).join(' '); },
      remove: (...n) => {
        const drop = new Set(n);
        this.className = this.className.split(' ').filter((c) => c && !drop.has(c)).join(' ');
      },
      toggle: () => {},
      contains: () => false,
    };
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    this._text = String(v ?? '');
    this.children.length = 0;
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ''); this.children.length = 0; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children.at(-1) ?? null; }

  appendChild(node) {
    const n = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
    n.parentNode = this;
    this.children.push(n);
    return n;
  }

  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  prepend(node) { this.children.unshift(node); node.parentNode = this; }
  insertBefore(node, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes) { this.children.length = 0; this.append(...nodes); }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (list) this.listeners[type] = list.filter((f) => f !== fn);
  }

  /** 测试里直接触发，绕开真实事件系统。 */
  fire(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this, ...event });
  }

  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400 }; }
}

class FakeDocument {
  constructor() { this.body = new FakeNode('body', this); }
  createElement(tag) { return new FakeNode(tag, this); }
  createElementNS(_ns, tag) { return new FakeNode(tag, this); }
  createTextNode(text) {
    const n = new FakeNode('#text', this);
    n._text = String(text ?? '');
    return n;
  }
  createDocumentFragment() { return new FakeNode('#fragment', this); }
  querySelector() { return null; }
}

/** 把她会调到的 ctx 方法都做成可记录的桩。 */
function makeCtx({ report = null, language = 'zh' } = {}) {
  const doc = new FakeDocument();
  const root = new FakeNode('div', doc);
  const calls = [];
  const controller = new AbortController();

  const invoke = async (method, args) => {
    calls.push({ method, args });
    if (method === 'report') return report ?? { hardware: { overall: null, levelKey: 'insufficient' }, personality: { taken: false } };
    if (method === 'refresh') return report;
    if (method === 'behavior') return { axes: {}, letters: '????', notes: [] };
    if (method === 'text') return { text: '' };
    if (method === 'startQuiz') return { ok: true, batch: 1 };
    throw new Error(`unexpected invoke: ${method}`);
  };

  const ctx = {
    pageId: 'p', panelId: 'hardware', language,
    root, signal: controller.signal,
    invoke,
    invokeBinary: async () => new Uint8Array(),
    notifyOnUnmount: () => {},
    pickPath: async () => null,
    setConfig: async () => {},
    stream: () => ({ close() {} }),
    interval: (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
    timeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    frame: (fn) => { fn(); return 0; },
    own: (d) => d,
    memo: (fn) => fn(),
    ui: {},

    // 内部测试用
    _doc: doc,
    _calls: calls,
    _abort: () => controller.abort(),
  };
  return ctx;
}

export { FakeNode, FakeDocument, makeCtx };
