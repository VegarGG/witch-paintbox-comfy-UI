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
      this.readOnly = false; this.checked = false; this.selectionStart = this.selectionEnd = 0;
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
      if (['hidden', 'disabled', 'checked'].includes(key)) this[key] = true;
      if (key === 'readonly') this.readOnly = true;
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
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    getBoundingClientRect() { return { left: 10, right: 50, top: 10, bottom: 50, width: 40, height: 40 }; }
  }
  const document = new Node('document'); document.connected = true; document.createElement = tag => new Node(tag); document.body = new Node('body'); document.append(document.body);
  const root = new Node('shadow'); document.body.append(root); const window = new Node('window');
  const alerts = [], confirmations = [], confirmResults = [], storage = new Map(), storageReads = [], storageWrites = [];
  Object.assign(window, {
    innerWidth: 1000, innerHeight: 800, setTimeout: () => 1, alert: message => alerts.push(message),
    confirm(message) { confirmations.push(message); return confirmResults.shift() ?? false; },
    localStorage: {
      getItem(key) { storageReads.push(key); return storage.get(key) ?? null; },
      setItem(key, value) { storageWrites.push([key, value]); storage.set(key, value); },
    },
  });
  return { Node, document, root, window, alerts, confirmations, confirmResults, storageReads, storageWrites };
}
const cardScope = id => JSON.stringify(['character', id]);
const source = (messageId = 2, overrides = {}) => ({ scope: cardScope('card-a.png'), chatId: 'chat', messageId, swipeId: 0, historyId: `history-${messageId}`, turnId: null, text: `<img onerror="evil()">source ${messageId}`, ...overrides });
const entry = id => ({ id, markerKey: 'direct-key', blob: new Blob(['image']), positive: '正文', negative: '', provider: 'comfyui', createdAt: 1, parameters: { width: 512, height: 640 } });
async function harness({ menu = false, constructorReport = false, narrative = value => `完整正文 ${value.messageId}` } = {}) {
  const d = dom(), calls = { select: [], generate: [], history: [], suggest: [], presetFrame: 0, confirmSource: 0, cancel: 0, dispose: 0, legacyProcess: 0, legacyOpen: 0, deleted: [] }, urls = [], revoked = [], galleries = [], busy = [];
  const state = { sources: [source(), source(4)], select: null, generate: null, history: null, suggest: null, presetFrame: null, anchors: [], runner: null, legacy: null, render: null };
  class DirectImageController {
    constructor(options = {}) { this.options = options; this.busy = false; state.runner = this; options.onStatus?.('runner ready', false); }
    async select(value) { calls.select.push(value); this.selected = value; return state.select ? await state.select.promise : narrative(value); }
    confirmSelectedSource() { calls.confirmSource++; return this.selected; }
    async run(work) {
      const operation = this.operation = Symbol(); this.busy = true; this.options.onStatus?.('等待模拟结果', true);
      try { return await work(); }
      finally {
        // Deliberately let stale promises resolve, but not overwrite the replacement operation's status.
        if (this.operation === operation) { this.operation = null; this.busy = false; this.options.onStatus?.('完成', false); }
      }
    }
    async generate(...args) { calls.generate.push(args); return this.run(() => state.generate?.promise ?? entry('new')); }
    async loadHistory(...args) { calls.history.push(args); return state.history ? await state.history.promise : [entry('old')]; }
    async suggestKeyframes(...args) { calls.suggest.push(args); return this.run(() => state.suggest.promise); }
    readPresetKeyframe() { calls.presetFrame++; return state.presetFrame; }
    cancel() { calls.cancel++; this.operation = null; if (!state.pendingSave) this.busy = false; }
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
    './anchor-store.js': { loadAnchorText: async () => state.anchors },
    // Import the real keyframe limit, profile and composition code, but never a live API transport.
    './model-api.js': { requestModel: () => assert.fail('UI tests must not invoke the real text API') },
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
async function change(f, name, value, event = 'change') {
  const node = f.field(name); node.value = value; await node.fire(event);
}
const switchToRaw = f => change(f, 'mode', 'raw');
async function openRaw(f) { f.picker.open(); await tick(); await switchToRaw(f); }

test('fake raw UI opens read-only and previews full inert text; only explicit generate submits one exact edited prompt', async () => {
  const f = await harness(); f.state.select = deferred();
  f.picker.open(); await tick();
  assert.equal(f.calls.generate.length, 0); assert.equal(f.calls.history.length, 0); assert.equal(f.calls.select.length, 1);
  const full = '<script>inert()</script>' + '长'.repeat(6100); f.state.select.resolve(full); await tick(); await switchToRaw(f);
  assert.equal(f.field('keyframes').hidden, true);
  assert.equal(f.field('prompt').value, full); assert.equal(f.field('negative').value, '默认负词');
  assert.equal(f.field('prompt').hasAttribute('maxlength'), false); assert.equal(f.field('generate').disabled, true);
  assert.match(f.field('limit').textContent, /6000.*不自动截取/);
  await change(f, 'prompt', '手改原文\n"你好" <img onerror=evil()> C:\\paint', 'input');
  await change(f, 'negative', '本次负词', 'input'); await f.field('generate').fire('click');
  assert.deepEqual(f.calls.generate, [[f.field('prompt').value, '本次负词', 'saved']]);
  assert.equal(f.galleries[0].items[0].entry.id, 'new'); assert.equal(f.galleries[0].element.open, true);
  f.abort.abort();
});

test('fake source switching cancels work and rejects stale select/generate completion', async () => {
  const f = await harness(); const first = deferred(); f.state.select = first; f.picker.open(); await tick();
  f.state.select = null; f.field('source').value = '0'; await f.field('source').fire('change');
  first.resolve('旧正文禁止显示'); await tick(); await switchToRaw(f); assert.equal(f.field('prompt').value, '完整正文 2');
  const pending = deferred(); f.state.generate = pending; void f.field('generate').fire('click'); await tick();
  f.field('source').value = '1'; await f.field('source').fire('change'); pending.resolve(entry('stale')); await tick();
  assert.equal(f.field('prompt').value, '完整正文 4'); assert.equal(f.urls.length, 0); assert.ok(f.calls.cancel >= 2);
  f.abort.abort();
});

test('fake gallery replacement/close and root abort revoke every URL; history reopens without generation', async () => {
  const f = await harness(); await openRaw(f);
  await change(f, 'prompt', '手工改过也不作为历史键', 'input'); await f.field('history').fire('click');
  assert.deepEqual(f.calls.history, [[]]);
  assert.equal(f.galleries[0].items.length, 1); assert.equal(f.urls.length, 1);
  await f.field('history').fire('click'); assert.deepEqual(f.revoked, [f.urls[0]]);
  f.galleries[0].close(); await tick(); assert.deepEqual(f.revoked, f.urls); assert.equal(f.galleries[0].items.length, 0);
  await f.field('history').fire('click'); assert.equal(f.galleries[0].element.open, true);
  f.abort.abort(); assert.deepEqual(f.revoked, f.urls); assert.equal(f.calls.dispose, 1); assert.equal(f.panel.isConnected, false);
  assert.equal(f.calls.generate.length, 0); assert.equal(f.state.render, null);
});

test('fake gallery close/host event abort stale history and generate results without allocating URLs', async () => {
  const f = await harness(); await openRaw(f); await f.field('history').fire('click');
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
  f.state.select = null; await openRaw(f); const pending = deferred(); f.state.generate = pending; void f.field('generate').fire('click'); await tick();
  f.abort.abort(); pending.resolve(entry('late')); await tick(); assert.equal(f.urls.length, 0);
});

test('fake showModal failures are visibly reported for both preview and gallery; gallery failure frees URLs', async () => {
  const f = await harness(); f.panel.failShow = true; f.picker.open(); await tick();
  assert.match(f.alerts.join(' '), /打开|showModal/); assert.equal(f.calls.select.length, 0);
  f.panel.failShow = false; await openRaw(f); f.galleries[0].element.failShow = true;
  await f.field('history').fire('click'); assert.match(f.field('status').textContent, /showModal|打开/); assert.deepEqual(f.revoked, f.urls);
  f.abort.abort();
});

test('fake gallery delete uses existing history API and source change releases old images', async () => {
  const f = await harness(); await openRaw(f); await f.field('history').fire('click');
  await f.galleries[0].handlers.onDelete('old'); assert.deepEqual(f.calls.deleted, ['old']); assert.equal(f.galleries[0].items.length, 0);
  assert.deepEqual(f.revoked, f.urls); await f.field('history').fire('click'); f.field('source').value = '1'; await f.field('source').fire('change');
  assert.deepEqual(f.revoked, f.urls); assert.equal(f.galleries[0].items.length, 0); f.abort.abort();
});

test('fake runner invalidation reports clear pending results and controls without TDZ constructor callbacks', async () => {
  const f = await harness(); await openRaw(f); await f.field('history').fire('click');
  f.state.runner.options.onSourceInvalidated('来源已失效，请重新选择'); await tick();
  assert.deepEqual(f.revoked, f.urls); assert.equal(f.field('generate').disabled, true); assert.match(f.field('status').textContent, /失效/); f.abort.abort();
});

test('fake pending history commit stays busy across close, then status-only completion releases the menu interlock', async () => {
  const f = await harness(); await openRaw(f);
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
  f.state.select.resolve('正文'); await tick(); await switchToRaw(f);
  assert.equal(process.disabled, false); assert.equal(select.disabled, false); f.abort.abort();
});

async function pickText(f, text) {
  const body = f.field('body'), start = body.value.indexOf(text);
  assert.notEqual(start, -1);
  body.setSelectionRange(start, start + text.length);
  await f.field('use-selection').fire('click');
}

async function startPlan(f) {
  const pending = f.state.suggest = deferred();
  f.confirmResults.push(true);
  await f.field('plan').fire('click');
  return pending;
}

test('default keyframe lets a user select and edit an excerpt, compose, then explicitly submit one image', async t => {
  const excerpt = '她举起纸灯说：“等我”', full = `🌙<img onerror="inert()">夜色里，${excerpt}。随后转身。`;
  const f = await harness({ narrative: () => full }); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  assert.equal(f.field('mode').value, 'keyframe'); assert.equal(f.field('count').value, '1');
  assert.equal(f.field('keyframes').hidden, false); assert.equal(f.field('slot-field').hidden, true);
  assert.equal(f.field('body').value, full); assert.equal(f.field('body').readOnly, true);
  assert.equal(f.field('body').hasAttribute('maxlength'), false); assert.equal(f.field('prompt').value, '');
  assert.equal(f.field('prompt').readOnly, true); assert.equal(f.field('generate').disabled, true);
  await f.field('use-selection').fire('click'); assert.match(f.field('status').textContent, /选中一个片段/);
  await pickText(f, excerpt);
  assert.equal(f.field('scene').value, excerpt); assert.equal(f.field('evidence').textContent, `原文依据：${excerpt}`);
  const editedScene = '她在暮色中举着纸灯，侧面近景';
  await change(f, 'scene', editedScene, 'input'); await change(f, 'preset', 'anime');
  await f.field('generate').fire('click'); // The fake fires even on disabled controls; the handler must guard.
  assert.equal(f.calls.generate.length, 0);
  await f.field('compose').fire('click');
  assert.equal(f.field('prompt').value, editedScene); assert.equal(f.field('negative').value, '默认负词');
  assert.equal(f.field('prompt').readOnly, false); assert.equal(f.field('generate').disabled, false);
  assert.equal(f.field('body').value, full); assert.equal(f.field('evidence').textContent, `原文依据：${excerpt}`);
  assert.equal(f.calls.generate.length, 0); assert.equal(f.calls.suggest.length, 0); assert.equal(f.confirmations.length, 0);
  const finalPrompt = `${editedScene} · 暖侧光`;
  await change(f, 'prompt', finalPrompt, 'input'); await change(f, 'negative', '不要重影', 'input');
  const pending = f.state.generate = deferred();
  await f.field('generate').fire('click'); await f.field('generate').fire('click');
  assert.deepEqual(f.calls.generate, [[finalPrompt, '不要重影', 'anime']]);
  pending.resolve(entry('manual-image')); await tick();
  assert.equal(f.galleries[0].items[0].entry.id, 'manual-image');
  assert.equal(f.field('generate').disabled, true); await f.field('generate').fire('click');
  assert.equal(f.calls.generate.length, 1); assert.equal(f.storageWrites.length, 0);
});

test('explicit preset read fills a draft without requesting text or images, and missing metadata preserves it', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.state.presetFrame = { evidence: '正文 4', scene: '原回复附段里的场景' };
  f.picker.open(); await tick();
  await change(f, 'scene', '已有的未生成草稿', 'input'); await f.field('compose').fire('click');
  assert.equal(f.calls.presetFrame, 0); assert.equal(f.field('generate').disabled, false);
  await f.field('preset-frame').fire('click');
  assert.equal(f.calls.presetFrame, 1); assert.equal(f.field('scene').value, '原回复附段里的场景');
  assert.equal(f.field('evidence').textContent, '原文依据：正文 4'); assert.equal(f.field('generate').disabled, true);
  assert.match(f.field('status').textContent, /没有额外调用文本 API.*没有提交生图/);
  f.state.presetFrame = null; await change(f, 'source', '0');
  await pickText(f, '正文 2'); await f.field('compose').fire('click');
  await change(f, 'prompt', '这帧手调正词', 'input');
  assert.equal(f.calls.presetFrame, 1);
  await f.field('preset-frame').fire('click');
  assert.equal(f.calls.presetFrame, 2); assert.match(f.field('status').textContent, /没有可用的预设附段/);
  assert.equal(f.field('scene').value, '正文 2'); assert.equal(f.field('evidence').textContent, '原文依据：正文 2');
  assert.equal(f.field('prompt').value, '这帧手调正词'); assert.equal(f.field('generate').disabled, false);
  assert.deepEqual(f.calls.generate, []); assert.deepEqual(f.calls.suggest, []); assert.deepEqual(f.confirmations, []);
});

test('declining main API confirmation or receiving a failed suggestion leaves the manually composed draft intact', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  await change(f, 'scene', '手选画面', 'input'); await f.field('compose').fire('click');
  await change(f, 'prompt', '已细调的手工草稿', 'input');
  f.confirmResults.push(false); await f.field('plan').fire('click');
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0], /完整提取正文.*酒馆主文本 API.*联网和计费.*不会提交生图/);
  assert.deepEqual(f.calls.suggest, []); assert.equal(f.field('prompt').value, '已细调的手工草稿');
  const pending = await startPlan(f);
  assert.deepEqual(f.calls.suggest, [[1]]); assert.equal(f.field('generate').disabled, true);
  pending.reject(new Error('模拟主 API 请求失败')); await tick();
  assert.match(f.field('status').textContent, /模拟主 API 请求失败.*原草稿保留/);
  assert.equal(f.field('scene').value, '手选画面'); assert.equal(f.field('prompt').value, '已细调的手工草稿');
  assert.equal(f.field('generate').disabled, false); assert.deepEqual(f.calls.generate, []);
});

test('one confirmed main API draft request allows at most two frames, each requiring its own preview and submit', async t => {
  const evidenceOne = '她举起纸灯', evidenceTwo = '他打开木门';
  const f = await harness({ narrative: () => `黄昏，${evidenceOne}。隔天清早，${evidenceTwo}。` }); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  await change(f, 'count', '2'); await change(f, 'preset', 'realistic');
  assert.equal(f.field('slot-field').hidden, false);
  const pending = await startPlan(f);
  await f.field('plan').fire('click'); assert.equal(f.confirmations.length, 1); assert.deepEqual(f.calls.suggest, [[2]]);
  assert.equal(f.field('generate').disabled, true); assert.ok(f.picker.busy); assert.deepEqual(f.calls.generate, []);
  pending.resolve([{ evidence: evidenceOne, scene: '暮色纸灯，侧面近景' }, { evidence: evidenceTwo, scene: '晨光木门，低机位' }]); await tick();
  assert.equal(f.field('slot').value, '0'); assert.equal(f.field('evidence').textContent, `原文依据：${evidenceOne}`);
  assert.equal(f.field('scene').value, '暮色纸灯，侧面近景'); assert.equal(f.field('prompt').value, '');
  assert.equal(f.field('generate').disabled, true); assert.match(f.field('status').textContent, /尚未提交生图/);
  await f.field('compose').fire('click'); await change(f, 'prompt', '暮色纸灯，侧面近景，暖光', 'input');
  assert.equal(f.field('generate').disabled, false); assert.deepEqual(f.calls.generate, []);
  await f.field('generate').fire('click');
  assert.deepEqual(f.calls.generate, [['暮色纸灯，侧面近景，暖光', '默认负词', 'realistic']]);
  assert.equal(f.field('generate').disabled, true); assert.equal(f.field('plan').disabled, true);
  f.galleries[0].close(); await tick();
  await change(f, 'slot', '1');
  assert.equal(f.field('evidence').textContent, `原文依据：${evidenceTwo}`); assert.equal(f.field('scene').value, '晨光木门，低机位');
  assert.equal(f.field('prompt').value, ''); assert.equal(f.field('generate').disabled, true);
  await f.field('generate').fire('click'); assert.equal(f.calls.generate.length, 1);
  await f.field('compose').fire('click'); await change(f, 'scene', '晨光木门，低机位，推门动作', 'input');
  assert.equal(f.field('generate').disabled, true); // A scene edit requires a fresh compose/preview.
  await f.field('compose').fire('click'); await change(f, 'negative', '本帧负词', 'input');
  await f.field('generate').fire('click');
  assert.deepEqual(f.calls.generate, [['暮色纸灯，侧面近景，暖光', '默认负词', 'realistic'], ['晨光木门，低机位，推门动作', '本帧负词', 'realistic']]);
  assert.equal(f.field('generate').disabled, true); await f.field('generate').fire('click');
  assert.equal(f.calls.generate.length, 2); assert.equal(f.confirmations.length, 1);
});

test('card profile is only written by explicit remember and reused for the same native card across chats', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.state.anchors = [{ id: 'lamp-keeper', name: '提灯人', appearance: '短发和琥珀色眼睛', negative: '变色瞳孔',
    selectedOutfitId: 'cloak', outfits: [{ id: 'cloak', tags: '灰色斗篷' }] }];
  f.picker.open(); await tick();
  await change(f, 'style', '未保存的试画风', 'input'); assert.equal(f.storageWrites.length, 0);
  f.state.sources = [source(1, { chatId: 'new-chat-same-card' })]; await f.field('refresh').fire('click');
  assert.equal(f.field('style').value, '');
  await change(f, 'preset', 'realistic'); await change(f, 'anchor', 'lamp-keeper');
  await change(f, 'style', ' 克制的青灰色调 ', 'input'); await change(f, 'style-negative', '锐化过强', 'input');
  await change(f, 'scene', '沿河提灯', 'input');
  f.field('outfit').checked = true; await f.field('outfit').fire('change');
  await f.field('compose').fire('click');
  assert.equal(f.field('prompt').value, '沿河提灯\n画面中提灯人的固定外貌：短发和琥珀色眼睛\n提灯人的服装：灰色斗篷\n画风：克制的青灰色调');
  assert.equal(f.field('negative').value, '默认负词\n变色瞳孔\n锐化过强');
  f.field('use-anchor').checked = false; await f.field('use-anchor').fire('change');
  assert.equal(f.field('outfit').disabled, true); assert.equal(f.field('generate').disabled, true);
  await f.field('compose').fire('click');
  assert.equal(f.field('prompt').value, '沿河提灯\n画风：克制的青灰色调');
  assert.equal(f.field('negative').value, '默认负词\n锐化过强');
  await change(f, 'prompt', '这条最终正词只给本轮', 'input');
  assert.equal(f.storageWrites.length, 0); assert.equal(f.field('save-card').disabled, false);
  await f.field('save-card').fire('click');
  assert.equal(f.calls.confirmSource, 1); assert.equal(f.storageWrites.length, 1);
  assert.deepEqual(JSON.parse(f.storageWrites[0][1]), { preset: 'realistic', anchorId: 'lamp-keeper', style: '克制的青灰色调', negative: '锐化过强' });
  f.state.sources = [source(7, { chatId: 'another-chat-same-card' })]; await f.field('refresh').fire('click');
  assert.equal(f.field('preset').value, 'realistic'); assert.equal(f.field('anchor').value, 'lamp-keeper');
  assert.equal(f.field('style').value, '克制的青灰色调'); assert.equal(f.field('style-negative').value, '锐化过强');
  assert.equal(f.field('outfit').checked, false); assert.equal(f.field('scene').value, ''); assert.equal(f.field('prompt').value, '');
  f.state.sources = [source(7, { scope: cardScope('card-b.png'), chatId: 'another-chat-same-card' })]; await f.field('refresh').fire('click');
  assert.equal(f.field('preset').value, 'saved'); assert.equal(f.field('anchor').value, ''); assert.equal(f.field('style').value, '');
  assert.equal(f.storageWrites.length, 1); assert.deepEqual(f.calls.generate, []);
});

test('group chat permits temporary draft style but neither loads a card profile nor remembers one', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  await change(f, 'style', '单聊保存的画风', 'input'); await f.field('save-card').fire('click');
  assert.equal(f.storageWrites.length, 1);
  const reads = f.storageReads.length;
  f.state.sources = [source(2, { scope: JSON.stringify(['group', 'card-a.png']) })];
  await f.field('refresh').fire('click');
  assert.equal(f.field('style').value, ''); assert.equal(f.storageReads.length, reads);
  assert.equal(f.field('save-card').disabled, true); assert.match(f.field('card-note').textContent, /群聊.*只用于本轮/);
  await change(f, 'style', '群聊的临时画风', 'input'); await change(f, 'scene', '众人在灯下交谈', 'input');
  await f.field('compose').fire('click'); assert.equal(f.field('prompt').value, '众人在灯下交谈\n画风：群聊的临时画风');
  await f.field('save-card').fire('click'); assert.equal(f.storageWrites.length, 1); assert.equal(f.calls.confirmSource, 1);
  await f.field('refresh').fire('click');
  assert.equal(f.field('style').value, ''); assert.equal(f.storageReads.length, reads); assert.deepEqual(f.calls.generate, []);
});

test('host source invalidation during confirmed planning keeps old edits visible and discards the late draft', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  await change(f, 'scene', '失效前手工草稿', 'input'); await f.field('compose').fire('click');
  const pending = await startPlan(f); assert.deepEqual(f.calls.suggest, [[1]]);
  f.state.render(undefined, undefined, 'CHAT_CHANGED');
  const invalidated = f.field('status').textContent;
  assert.match(invalidated, /来源已改变.*重新/); assert.equal(f.field('generate').disabled, true);
  pending.resolve([{ evidence: '完整正文 4', scene: '不应展示的主 API 草稿' }]); await tick();
  assert.equal(f.field('status').textContent, invalidated);
  assert.equal(f.field('scene').value, '失效前手工草稿'); assert.equal(f.field('prompt').value, '失效前手工草稿');
  assert.equal(f.field('evidence').hidden, true); assert.equal(f.field('plan').disabled, true); assert.deepEqual(f.calls.generate, []);
});

test('switching floors during a confirmed plan does not overwrite the new floor with a late reply', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  const pending = await startPlan(f); assert.deepEqual(f.calls.suggest, [[1]]);
  await change(f, 'source', '0'); assert.equal(f.field('body').value, '完整正文 2');
  await pickText(f, '正文 2'); await f.field('compose').fire('click');
  pending.resolve([{ evidence: '完整正文 4', scene: '上个楼层的关键帧' }]); await tick();
  assert.equal(f.field('scene').value, '正文 2'); assert.equal(f.field('evidence').textContent, '原文依据：正文 2');
  assert.equal(f.field('prompt').value, '正文 2'); assert.equal(f.field('generate').disabled, false);
  assert.deepEqual(f.calls.generate, []); assert.deepEqual(f.urls, []);
});

test('cancelling local planning wait unlocks the editor without accepting any late draft', async t => {
  const f = await harness(); t.after(() => f.abort.abort());
  f.picker.open(); await tick();
  await change(f, 'scene', '本帧保留的画面', 'input'); await f.field('compose').fire('click');
  const pending = await startPlan(f); assert.deepEqual(f.calls.suggest, [[1]]);
  assert.equal(f.field('cancel').hidden, false); const cancels = f.calls.cancel;
  await f.field('cancel').fire('click');
  assert.equal(f.calls.cancel, cancels + 1); assert.equal(f.picker.busy, false);
  assert.equal(f.field('generate').disabled, false); assert.equal(f.field('cancel').hidden, true);
  pending.resolve([{ evidence: '完整正文 4', scene: '已取消的建议' }]); await tick();
  assert.match(f.field('status').textContent, /已取消本地等待/); assert.equal(f.field('scene').value, '本帧保留的画面');
  assert.equal(f.field('prompt').value, '本帧保留的画面'); assert.deepEqual(f.calls.generate, []);
});
