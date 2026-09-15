/**
 * domstub.mjs — un DOM de mentira, suficiente para montar las pantallas de
 * Ajedrez Maestro fuera del navegador. No dibuja nada: sirve para que el
 * modulo se ejecute de verdad y salten los errores reales (imports que faltan,
 * APIs mal usadas, propiedades inexistentes), y para poder recorrer el arbol
 * resultante y comprobar que las clases CSS existen.
 *
 * Instala los globales al importarlo.
 */

const listeners = new WeakMap();

/** `style` acepta tanto asignacion directa como setProperty/getPropertyValue. */
function makeStyle() {
  const props = new Map();
  return {
    setProperty(name, value) { props.set(String(name), String(value)); },
    getPropertyValue(name) { const v = props.get(String(name)); return v === undefined ? '' : v; },
    removeProperty(name) { props.delete(String(name)); },
    get cssText() { return [...props].map(([k, v]) => k + ':' + v).join(';'); },
    set cssText(_value) { /* no hace falta interpretarlo */ },
  };
}

class StubNode {
  constructor(tagName = '', ns = null) {
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.namespaceURI = ns;
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = makeStyle();
    this.dataset = {};
    this._class = '';
    this._text = '';
    /* Propiedades habituales, para que `key in node` funcione como en el DOM. */
    this.id = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.hidden = false;
    this.href = '';
    this.src = '';
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.tabIndex = 0;
    this.width = 0;
    this.height = 0;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientWidth = 640;
    this.clientHeight = 640;
    this.offsetWidth = 640;
    this.offsetHeight = 640;
  }

  get className() { return this._class; }
  set className(value) { this._class = String(value == null ? '' : value); }

  get classList() {
    const self = this;
    return {
      add(...names) {
        const set = new Set(self._class.split(/\s+/).filter(Boolean));
        for (const n of names) if (n) set.add(n);
        self._class = [...set].join(' ');
      },
      remove(...names) {
        const set = new Set(self._class.split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        self._class = [...set].join(' ');
      },
      toggle(name, force) {
        const has = self.classList.contains(name);
        const want = force === undefined ? !has : !!force;
        if (want) self.classList.add(name);
        else self.classList.remove(name);
        return want;
      },
      contains(name) { return self._class.split(/\s+/).includes(name); },
    };
  }

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get parentElement() { return this.parentNode; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    const text = value == null ? '' : String(value);
    if (text !== '') this.appendChild(new StubText(text));
  }

  /* No se interpreta el marcado de verdad, pero si viene un elemento (el codigo
     lo usa para inyectar SVG propio) se crea UN hijo con ese nombre de etiqueta,
     que es lo justo para que `firstElementChild` y `cloneNode` funcionen. */
  set innerHTML(value) {
    this.childNodes = [];
    this._html = String(value == null ? '' : value);
    const match = /^\s*<([a-zA-Z][\w:-]*)/.exec(this._html);
    if (match) {
      const child = new StubNode(match[1]);
      child._html = this._html;
      this.appendChild(child);
    }
  }

  get innerHTML() { return this._html || ''; }

  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }

  appendChild(child) {
    if (!child) return child;
    if (child instanceof StubFragment) {
      for (const sub of [...child.childNodes]) this.appendChild(sub);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? new StubText(n) : n);
    }
  }

  prepend(...nodes) {
    for (const n of nodes.reverse()) {
      const node = typeof n === 'string' ? new StubText(n) : n;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    const i = this.childNodes.indexOf(ref);
    if (i === -1) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(i, 0, child);
    return child;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i !== -1) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((c) => c.contains && c.contains(node));
  }

  cloneNode(deep = false) {
    const copy = new StubNode(this.localName, this.namespaceURI);
    copy._class = this._class;
    copy._html = this._html;
    copy.attributes = new Map(this.attributes);
    Object.assign(copy.style, this.style);
    Object.assign(copy.dataset, this.dataset);
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, fn) {
    if (!listeners.has(this)) listeners.set(this, new Map());
    const map = listeners.get(this);
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    listeners.get(this)?.get(type)?.delete(fn);
  }

  dispatchEvent(event) {
    const fns = listeners.get(this)?.get(event && event.type);
    if (fns) for (const fn of [...fns]) fn.call(this, event);
    return true;
  }

  /** Solo entiende selectores simples: 'tag', '.clase' y combinaciones sueltas. */
  matches(selector) {
    return String(selector).split(',').some((raw) => {
      const sel = raw.trim();
      if (!sel) return false;
      if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
      if (sel.startsWith('#')) return this.id === sel.slice(1);
      return this.localName === sel.toLowerCase();
    });
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.nodeType === 1 && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 640, width: 640, height: 640 };
  }

  focus() {}
  blur() {}
  click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  animate() { return { cancel() {}, finished: Promise.resolve() }; }
  getContext() { return null; }
}

class StubText extends StubNode {
  constructor(text) {
    super('#text');
    this.nodeType = 3;
    this._text = String(text);
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); }
  cloneNode() { return new StubText(this._text); }
}

class StubFragment extends StubNode {
  constructor() {
    super('#fragment');
    this.nodeType = 11;
  }
}

const documentStub = {
  createElement: (tag) => new StubNode(tag),
  createElementNS: (ns, tag) => new StubNode(tag, ns),
  createTextNode: (text) => new StubText(text),
  createDocumentFragment: () => new StubFragment(),
  getElementById(id) { return this.body.querySelectorAll('*').find((n) => n.id === id) || null; },
  querySelector(sel) { return this.body.querySelector(sel); },
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); },
  addEventListener() {},
  removeEventListener() {},
  body: new StubNode('body'),
  documentElement: new StubNode('html'),
  activeElement: null,
  hidden: false,
};

const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
  key: (i) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};

class StubAudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
  createOscillator() {
    return {
      frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
      type: 'sine', connect() {}, start() {}, stop() {}, disconnect() {},
    };
  }
  createGain() {
    return {
      gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
      connect() {}, disconnect() {},
    };
  }
  createBiquadFilter() {
    return { type: 'lowpass', frequency: { value: 0, setValueAtTime() {} }, Q: { value: 1 }, connect() {}, disconnect() {} };
  }
  createBuffer() { return { getChannelData: () => new Float32Array(1024) }; }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  AudioContext: StubAudioContext,
  webkitAudioContext: StubAudioContext,
  localStorage: localStorageStub,
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 900,
  location: { hash: '#/', href: 'http://localhost:8080/' },
  navigator: { hardwareConcurrency: 4, clipboard: { writeText: () => Promise.resolve() }, language: 'es' },
};

export function installDom() {
  globalThis.Node = StubNode;
  globalThis.Element = StubNode;
  globalThis.HTMLElement = StubNode;
  globalThis.SVGElement = StubNode;
  globalThis.Text = StubText;
  globalThis.DocumentFragment = StubFragment;
  globalThis.document = documentStub;
  globalThis.window = windowStub;
  globalThis.localStorage = localStorageStub;
  /* Node ya trae `navigator` como getter de solo lectura: se completa lo que
     falte en vez de reemplazarlo, y si no existe se define. */
  if (globalThis.navigator) {
    windowStub.navigator = globalThis.navigator;
    if (!globalThis.navigator.clipboard) {
      try {
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          value: { writeText: () => Promise.resolve() }, configurable: true,
        });
      } catch { /* da igual: la UI debe tolerar que no haya portapapeles */ }
    }
  } else {
    Object.defineProperty(globalThis, 'navigator', { value: windowStub.navigator, configurable: true });
  }
  globalThis.AudioContext = StubAudioContext;
  globalThis.getComputedStyle = windowStub.getComputedStyle;
  globalThis.matchMedia = windowStub.matchMedia;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.Worker = undefined;
  /* Node ya trae Event y CustomEvent de verdad, y undici los comprueba con
     instanceof: pisarlos rompia cualquier WebSocket abierto despues en el
     mismo proceso, y tumbaba la suite entera cuando otra corria detras. Se
     rellenan solo si faltan. */
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
      preventDefault() {}
      stopPropagation() {}
    };
  }
  if (typeof globalThis.Event !== 'function') globalThis.Event = globalThis.CustomEvent;
  return { document: documentStub, window: windowStub };
}

export { StubNode, StubText, documentStub };

installDom();
