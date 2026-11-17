import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

// Explicitly lightweight fake DOM + VM synthetic runner, NOT a browser, TT or Comfy test.
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function dom() {
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {};
      this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.open = false; this.connected = false;
      const classes = new Set(); this.classList = { toggle: (s, on = !classes.has(s)) => on ? classes.add(s) : classes.delete(s),
        add: s => classes.add(s), remove: s => classes.delete(s), contains: s => classes.has(s) };
      this.style = { setProperty() {}, removeProperty() {} };
    }
    set className(value) { this.attributes.set('class', value); }
    get className() { return this.attributes.get('class') ?? ''; }
    set innerHTML(value) {
      this.html = value; this.children = [];
      for (const tag of value.matchAll(/<(?!\/)([a-z][\w-]*)([^>]*)>/gi)) {
        if (tag[1] === 'style') continue;
        const child = new Node(tag[1]);
        for (const attr of tag[2].matchAll(/([\w-]+)(?:="([^"]*)"|'([^']*)')?/g)) child.setAttribute(attr[1], attr[2] ?? attr[3] ?? '');
        this.append(child);
      }
    }
    get innerHTML() { return this.html ?? ''; }
    setAttribute(key, value) {
      this.attributes.set(key, String(value));
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (['hidden', 'disabled'].includes(key)) this[key] = true;
    }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    hasAttribute(key) { return this.attributes.has(key); }
    matches(selector) {
      if (selector === ':modal') return this.open;
      if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
      const match = /^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(selector);
      return !!match && (!match[1] || this.tagName === match[1]) && (!match[2] || this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3]));
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(n => { n.parent = null; }); this.children = []; this.append(...nodes); }
    get isConnected() { return this.connected || !!this.parent?.isConnected; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; this.connected = false; }
    addEventListener(name, callback, options = {}) {
      if (options.signal?.aborted) return;
      const callbacks = this.listeners.get(name) ?? new Set(); callbacks.add(callback); this.listeners.set(name, callbacks);
      options.signal?.addEventListener('abort', () => callbacks.delete(callback), { once: true });
    }
    async fire(name, detail = {}) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, composedPath: () => [this], ...detail };
      await Promise.all([...(this.listeners.get(name) ?? [])].map(callback => callback(event))); await tick();
    }
    showModal() { if (this.failShow) throw new Error('synthetic showModal failure'); this.open = true; }
    close() { if (!this.open) return; this.open = false; void this.fire('close'); }
    focus() { this.focused = true; }
    getBoundingClientRect() { return { left: 10, right: 50, top: 10, bottom: 50, width: 40, height: 40 }; }
  }
  const document = new Node('document'); document.connected = true; document.createElement = tag => new Node(tag); document.body = new Node('body'); document.append(document.body);
  const root = new Node('shadow'); document.body.append(root); const window = new Node('window'); Object.assign(window, { innerWidth: 1000, innerHeight: 800, setTimeout: () => 1, alert: message => alerts.push(message) });
  const alerts = [];
  return { Node, document, root, window, alerts };
}
const source = (messageId = 2) => ({ scope: 'character', chatId: 'chat', messageId, swipeId: 0, historyId: `history-${messageId}`, turnId: null, text: `<img onerror="evil()">source ${messageId}` });
const entry = id => ({ id, markerKey: 'direct-key', blob: new Blob(['image']), positive: '正文', negative: '', provider: 'comfyui', createdAt: 1, parameters: { width: 512, height: 640 } });
async function harness({ menu = false, constructorReport = false } = {}) {
  const d = dom(), calls = { select: [], generate: [], history: [], cancel: 0, dispose: 0, legacyProcess: 0, legacyOpen: 0, deleted: [] }, urls = [], revoked = [], galleries = [], busy = [];
  const state = { sources: [source(), source(4)], select: null, generate: null, history: null, runner: null, legacy: null, render: null };
  class DirectImageController {
    constructor(options = {}) { this.options = options; this.busy = false; state.runner = this; options.onStatus?.('runner ready', false); }
    async select(value) { calls.select.push(value); return state.select ? await state.select.promise : `完整正文 ${value.messageId}`; }
    async generate(prompt, negative) { calls.generate.push([prompt, negative]); this.busy = true; this.options.onStatus?.('正在直出', true); try { return state.generate ? await state.generate.promise : entry('new'); } finally { this.busy = false; this.options.onStatus?.('完成', false); } }
    async loadHistory(prompt) { calls.history.push(prompt); return state.history ? await state.history.promise : [entry('old')]; }
    cancel() { calls.cancel++; if (!state.pendingSave) this.busy = false; }
    dispose() { calls.dispose++; this.cancel(); }
  }
  class ChatProcessor {
    constructor(report) { this.report = report; this.busy = false; state.legacy = this; if (constructorReport) report('constructor legacy report', false); }
    async process() { calls.legacyProcess++; this.busy = true; this.report('legacy start', true); }
    cancel() { this.busy = false; this.report('legacy cancel', false); }
  }
  const dependencies = {
    './direct-image-runner.js': { DirectImageController },
    './chat-host.js': { readAssistantMessages: () => state.sources, watchChatRendering: callback => { state.render = callback; return () => { state.render = null; }; } },
    './image-settings.js': { loadImageSettings: provider => { assert.equal(provider, 'comfyui'); return { negative: '默认负词' }; } },
    './image-history.js': { deleteImageHistory: async id => { calls.deleted.push(id); } },
    './image-gallery.js': { createImageGallery: (summary, signal, handlers) => {
      const element = d.document.createElement('dialog');
      const gallery = { element, items: [], selectedId: null, summary, handlers, openCount: 0,
        setImages(items, selectedId) { this.items = [...items]; this.selectedId = selectedId; }, setSummary(value) { this.summary = value; },
        open() { this.openCount++; element.showModal(); }, close() { element.close(); } };
      galleries.push(gallery); return gallery;
    } },
    './panel-viewport.js': { bindPanelViewport: () => ({ refresh() {} }) },
    './pet-events.js': { emitPetEvent() {} },
    './auto-process.js': { autoProcessReplies: processor => { if (constructorReport) processor.report('start events legacy report', false); } },
    './chat-processor.js': { ChatProcessor },
    './illustration-picker.js': { bindIllustrationPicker: () => ({ report() {}, open() { calls.legacyOpen++; } }) },
  };
  const context = vm.createContext({ console, document: d.document, window: d.window, HTMLElement: d.Node, HTMLButtonElement: d.Node, AbortController, Error,
    URL: { createObjectURL: () => { const url = `blob:fake-${urls.length}`; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url) } });
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    if (dependencies[name]) {
      const values = dependencies[name], mod = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context }); modules.set(name, mod); return mod;
    }
    const path = new URL(`../src/${name.replace(/^\.\//, '').replace(/\.js$/, '.ts')}`, import.meta.url);
    const code = ts.transpileModule(await fs.readFile(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const mod = new vm.SourceTextModule(code, { context, identifier: name }); modules.set(name, mod); await mod.link(load); return mod;
  }
  const mod = await load(menu ? './launcher-menu.js' : './direct-image-view.js'); await mod.evaluate();
  const abort = new AbortController(); let picker, launcher, menuNode;
  if (menu) { launcher = d.document.createElement('button'); d.root.append(launcher); picker = mod.namespace.bindLauncherMenu(launcher, d.root, abort.signal, () => {}); menuNode = d.root.querySelector('.launcher-menu'); }
  else picker = mod.namespace.bindDirectImagePicker(d.root, abort.signal, { canStart: () => !state.legacy?.busy, onBusyChange: value => busy.push(value) });
  const panel = d.root.querySelector('.direct-image-picker');
  const field = name => panel.querySelector(`[data-direct-${name}]`);
  return { ...d, picker, abort, field, panel, calls, state, urls, revoked, galleries, busy, launcher, menuNode };
}

test('fake UI opens read-only and previews full inert text; only explicit generate submits one exact edited prompt', async () => {
  const f = await harness(); f.state.select = deferred();
  f.picker.open(); await tick();
  assert.equal(f.calls.generate.length, 0); assert.equal(f.calls.history.length, 0); assert.equal(f.calls.select.length, 1);
  const full = '<script>inert()</script>' + '长'.repeat(6100); f.state.select.resolve(full); await tick();
  assert.equal(f.field('prompt').value, full); assert.equal(f.field('negative').value, '默认负词');
  assert.equal(f.field('prompt').hasAttribute('maxlength'), false); assert.equal(f.field('generate').disabled, true);
  assert.match(f.field('limit').textContent, /6000/); assert.match(f.panel.innerHTML, /不会自动截取|不自动截取/);
  f.field('prompt').value = '手改原文\n"你好" <img onerror=evil()> C:\\paint'; await f.field('prompt').fire('input');
  f.field('negative').value = '本次负词'; await f.field('generate').fire('click');
  assert.deepEqual(f.calls.generate, [[f.field('prompt').value, '本次负词']]);
  assert.equal(f.galleries[0].items[0].entry.id, 'new'); assert.equal(f.galleries[0].element.open, true);
  f.abort.abort();
});

test('fake source switching cancels work and rejects stale select/generate completion', async () => {
  const f = await harness(); const first = deferred(); f.state.select = first; f.picker.open(); await tick();
  f.state.select = null; f.field('source').value = '0'; await f.field('source').fire('change');
  first.resolve('旧正文禁止显示'); await tick(); assert.equal(f.field('prompt').value, '完整正文 2');
  const pending = deferred(); f.state.generate = pending; void f.field('generate').fire('click'); await tick();
  f.field('source').value = '1'; await f.field('source').fire('change'); pending.resolve(entry('stale')); await tick();
  assert.equal(f.field('prompt').value, '完整正文 4'); assert.equal(f.urls.length, 0); assert.ok(f.calls.cancel >= 2);
  f.abort.abort();
});

test('fake gallery replacement/close and root abort revoke every URL; history reopens without generation', async () => {
  const f = await harness(); f.picker.open(); await tick(); await f.field('history').fire('click');
  assert.equal(f.galleries[0].items.length, 1); assert.equal(f.urls.length, 1);
  await f.field('history').fire('click'); assert.deepEqual(f.revoked, [f.urls[0]]);
  f.galleries[0].close(); await tick(); assert.deepEqual(f.revoked, f.urls); assert.equal(f.galleries[0].items.length, 0);
  await f.field('history').fire('click'); assert.equal(f.galleries[0].element.open, true);
  f.abort.abort(); assert.deepEqual(f.revoked, f.urls); assert.equal(f.calls.dispose, 1); assert.equal(f.panel.isConnected, false);
  assert.equal(f.calls.generate.length, 0); assert.equal(f.state.render, null);
});

test('fake gallery close/host event abort stale history and generate results without allocating URLs', async () => {
  const f = await harness(); f.picker.open(); await tick(); await f.field('history').fire('click');
  const history = deferred(); f.state.history = history; void f.field('history').fire('click'); await tick();
  f.galleries[0].close(); await tick(); history.resolve([entry('late-history')]); await tick();
  assert.equal(f.urls.length, 1); assert.equal(f.galleries[0].items.length, 0);
  f.state.history = null; const pending = deferred(); f.state.generate = pending; void f.field('generate').fire('click'); await tick();
  f.state.render(undefined, undefined, 'CHAT_CHANGED'); pending.resolve(entry('late-generation')); await tick();
  assert.equal(f.urls.length, 1); assert.equal(f.field('generate').disabled, true); assert.match(f.field('status').textContent, /改变|重新/);
  f.abort.abort();
});

test('fake panel close and root abort reject pending selects and pending generated images', async () => {
  const f = await harness(); const first = deferred(); f.state.select = first; f.picker.open(); await tick(); f.picker.close(); first.resolve('late'); await tick();
  assert.equal(f.field('prompt').value, ''); assert.equal(f.picker.busy, false);
  f.state.select = null; f.picker.open(); await tick(); const pending = deferred(); f.state.generate = pending; void f.field('generate').fire('click'); await tick();
  f.abort.abort(); pending.resolve(entry('late')); await tick(); assert.equal(f.urls.length, 0);
});

test('fake showModal failures are visibly reported for both preview and gallery; gallery failure frees URLs', async () => {
  const f = await harness(); f.panel.failShow = true; f.picker.open(); await tick();
  assert.match(f.alerts.join(' '), /打开|showModal/); assert.equal(f.calls.select.length, 0);
  f.panel.failShow = false; f.picker.open(); await tick(); f.galleries[0].element.failShow = true;
  await f.field('history').fire('click'); assert.match(f.field('status').textContent, /showModal|打开/); assert.deepEqual(f.revoked, f.urls);
  f.abort.abort();
});

test('fake gallery delete uses existing history API and source change releases old images', async () => {
  const f = await harness(); f.picker.open(); await tick(); await f.field('history').fire('click');
  await f.galleries[0].handlers.onDelete('old'); assert.deepEqual(f.calls.deleted, ['old']); assert.equal(f.galleries[0].items.length, 0);
  assert.deepEqual(f.revoked, f.urls); await f.field('history').fire('click'); f.field('source').value = '1'; await f.field('source').fire('change');
  assert.deepEqual(f.revoked, f.urls); assert.equal(f.galleries[0].items.length, 0); f.abort.abort();
});

test('fake runner invalidation reports clear pending results and controls without TDZ constructor callbacks', async () => {
  const f = await harness(); f.picker.open(); await tick(); await f.field('history').fire('click');
  f.state.runner.options.onStatus('来源已失效，请重新选择', false, true); await tick();
  assert.deepEqual(f.revoked, f.urls); assert.equal(f.field('generate').disabled, true); assert.match(f.field('status').textContent, /失效/); f.abort.abort();
});

test('fake pending history commit stays busy across close, then status-only completion releases the menu interlock', async () => {
  const f = await harness(); f.picker.open(); await tick();
  f.state.pendingSave = true; f.state.runner.busy = true; f.state.runner.options.onStatus('历史保存中', true);
  f.picker.close(); await tick(); assert.equal(f.picker.busy, true); assert.equal(f.busy.at(-1), true);
  f.state.pendingSave = false; f.state.runner.busy = false; f.state.runner.options.onStatus('旧任务已完成', false);
  assert.equal(f.picker.busy, false); assert.equal(f.busy.at(-1), false); f.abort.abort();
});

test('fake menu preserves legacy action semantics and blocks both directions of concurrent manual use; reports initialize safely', async () => {
  const f = await harness({ menu: true, constructorReport: true });
  const process = f.menuNode.querySelector('[data-process]'), select = f.menuNode.querySelector('[data-select]'), direct = f.menuNode.querySelector('[data-direct]');
  assert.ok(direct); assert.match(f.menuNode.innerHTML, /正文直出 \/ ComfyUI/);
  await select.fire('click'); assert.equal(f.calls.legacyOpen, 1); await process.fire('click'); assert.equal(f.calls.legacyProcess, 1);
  await direct.fire('click'); assert.equal(f.panel.open, false); f.state.legacy.cancel();
  f.state.select = deferred(); void direct.fire('click'); await tick(); assert.equal(f.panel.open, true); assert.equal(process.disabled, true); assert.equal(select.disabled, true);
  await process.fire('click'); await select.fire('click'); assert.equal(f.calls.legacyProcess, 1); assert.equal(f.calls.legacyOpen, 1);
  f.state.select.resolve('正文'); await tick(); assert.equal(process.disabled, false); assert.equal(select.disabled, false); f.abort.abort();
});
