import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as core from '../dist/direct-image.js';
import * as settings from '../dist/image-settings.js';
import * as history from '../dist/image-history.js';

const source = (extra = {}) => ({ scope: '["character","test.png"]', chatId: 'chat-A', messageId: 6,
  historyId: 'stable-reply-A', swipeId: 0, turnId: null, text: '<StoryText>窗边的陶杯。\n灯光照在桌面。</StoryText><think>不发送隐藏推理</think>', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const forbidden = () => { throw new Error('forbidden real host/network/storage'); };
let Runner;
async function runnerClass() {
  if (Runner) return Runner;
  const code = await readFile(new URL('../dist/direct-image-runner.js', import.meta.url), 'utf8');
  const context = vm.createContext({ structuredClone, crypto: webcrypto, TextEncoder, Uint8Array, Blob, AbortController, DOMException, Error, Date });
  const exports = {
    './direct-image.js': core, './image-settings.js': settings, './image-history.js': history,
    './image-provider.js': { generatePreparedImage: forbidden },
    './chat-host.js': { captureDirectAssistant: forbidden, watchChatRendering: forbidden },
  };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(name => {
    const values = exports[name]; assert.ok(values, `declared offline module: ${name}`);
    return new vm.SyntheticModule(Object.keys(values), function() { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  });
  await mod.evaluate(); Runner = mod.namespace.DirectImageController; return Runner;
}
async function fixture(options = {}) {
  const Controller = await runnerClass();
  const calls = { capture: [], settings: [], generate: [], save: [], load: [], status: [], disposed: 0, checks: 0, unwatch: 0 };
  const config = settings.defaultImageSettings('comfyui'); config.positive = '不应自动添加的设置正词';
  let current = source(), watcher = null;
  const dependencies = {
    capture: async value => {
      const frozen = Object.freeze({ ...value }); calls.capture.push(frozen);
      let disposed = false;
      if (options.captureGate) await options.captureGate.promise;
      return { source: frozen, assertCurrentSync() {
        if (disposed || Object.keys(frozen).some(key => current[key] !== frozen[key])) throw new Error('来源已改变或失效');
        return { ...current };
      }, async assertCurrent() {
        calls.checks++; if (disposed) throw new Error('来源已失效');
        if (options.checkHook) await options.checkHook(calls.checks);
        return { ...current };
      }, dispose() { if (!disposed) calls.disposed++; disposed = true; } };
    },
    settings: provider => { calls.settings.push(provider); return config; },
    generate: async (value, prompt, signal, progress) => {
      calls.generate.push({ config: value, prompt, signal }); progress?.({ state: 'queued', position: 1 });
      if (options.generateGate) await options.generateGate.promise;
      if (options.generateError) throw options.generateError;
      return { provider: 'comfyui', blob: new Blob(['original-raster']), positive: prompt.positive, negative: prompt.negative, characters: [],
        parameters: { ...value.comfy.parameters, width: 1, height: 2, model: 'Dirty-MossV2-CONVROT8.safetensors' }, ...options.result };
    },
    save: async entry => { calls.save.push(entry); if (options.saveGate) await options.saveGate.promise; if (options.saveError) throw options.saveError; },
    load: async key => { calls.load.push(key); if (options.loadGate) await options.loadGate.promise; return options.entries ?? []; },
    watch: callback => { watcher = callback; options.watchHook?.(callback); return () => { watcher = null; calls.unwatch++; options.onUnwatch?.(); }; },
    now: () => 1000,
  };
  const controller = new Controller({ onStatus: (...args) => { calls.status.push(args); if (options.statusThrows) throw new Error('view failure'); } }, dependencies);
  return { controller, calls, config, get current() { return current; }, set current(value) { current = value; }, invalidate() { watcher?.(); } };
}
async function until(check) { for (let count = 0; count < 100; count++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('offline operation never reached expected stage'); }

test('selection is read-only, returns the entire visible prose and never starts an image or text model', async () => {
  const f = await fixture(); const original = JSON.stringify(f.current);
  assert.equal(await f.controller.select(f.current), '窗边的陶杯。\n灯光照在桌面。');
  assert.equal(JSON.stringify(f.current), original); assert.equal(f.calls.generate.length, 0); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.load.length, 0);
  assert.equal(f.controller.busy, false); f.controller.dispose(); assert.equal(f.calls.disposed, 1); assert.equal(f.calls.unwatch, 1);
});

test('explicit generation freezes Comfy-only settings and preserves exact edited positive/negative fields', async () => {
  const f = await fixture(); await f.controller.select(f.current);
  f.config.comfy.parameters.steps = 2;
  const positive = '她说："你好"\\窗边。\n第二行，原样。', negative = '水印\n模糊';
  const pending = f.controller.generate(positive, negative); f.config.comfy.parameters.steps = 88;
  const entry = await pending;
  assert.deepEqual(f.calls.settings, ['comfyui']); assert.equal(f.calls.generate.length, 1); assert.equal(f.calls.save.length, 1);
  const sent = f.calls.generate[0]; assert.equal(sent.config.provider, 'comfyui'); assert.equal(sent.config.comfy.parameters.steps, 2);
  assert.equal(sent.prompt.positive, positive); assert.equal(sent.prompt.negative, negative); assert.equal(sent.prompt.characters.length, 0);
  assert.equal(entry.positive, positive); assert.equal(entry.negative, negative); assert.equal(entry.parameters.width, 1); assert.equal(entry.parameters.height, 2);
  assert.equal(entry.blob, f.calls.save[0].blob); assert.equal(entry.createdAt, 1000); assert.equal(entry.provider, 'comfyui');
  assert.equal('connection' in entry, false); assert.equal('workflow' in entry, false); assert.match(entry.markerKey, /direct-v1/);
});

test('history reopens by full source identity rather than a mutable message floor and performs no generation', async () => {
  const first = await fixture(); await first.controller.select(first.current); await first.controller.loadHistory('候选');
  const second = await fixture(); second.current = source({ messageId: 2 }); await second.controller.select(second.current); await second.controller.loadHistory('不同候选不改变原文归属');
  assert.equal(first.calls.load[0], second.calls.load[0]); assert.equal(first.calls.generate.length, 0); assert.equal(second.calls.generate.length, 0);
  second.current = source({ messageId: 2, text: `${second.current.text} ` });
  await assert.rejects(second.controller.loadHistory('候选'), /来源|失效|改变/); assert.equal(second.calls.load.length, 1);
});

test('source changes before submission reject without calling any image backend or history write', async () => {
  const f = await fixture(); await f.controller.select(f.current); f.current = { ...f.current, text: '已编辑的新正文' };
  await assert.rejects(f.controller.generate('旧候选', ''), /来源|失效|改变/);
  assert.equal(f.calls.generate.length, 0); assert.equal(f.calls.save.length, 0);
});

test('double submit while a request is pending is rejected rather than paid or queued twice', async () => {
  const gate = deferred(), f = await fixture({ generateGate: gate }); await f.controller.select(f.current);
  const first = f.controller.generate('第一张', ''); await until(() => f.calls.generate.length === 1);
  await assert.rejects(f.controller.generate('重复点击', ''), /进行|等待|忙|任务/);
  gate.resolve(); await first; assert.equal(f.calls.generate.length, 1); assert.equal(f.calls.save.length, 1);
});

test('cancel rejects a late result even if the transport ignores abort and a newer selection is active', async () => {
  const gate = deferred(), f = await fixture({ generateGate: gate }); await f.controller.select(f.current);
  const old = f.controller.generate('旧图', ''); const rejected = assert.rejects(old, /取消|失效|改变/); await until(() => f.calls.generate.length === 1);
  f.controller.cancel(); assert.equal(f.calls.generate[0].signal.aborted, true);
  f.current = source({ chatId: 'chat-B', historyId: 'stable-B', text: '新聊天的正文' });
  assert.equal(await f.controller.select(f.current), '新聊天的正文');
  gate.resolve(); await rejected; assert.equal(f.calls.save.length, 0); assert.equal(f.controller.busy, false);
  const entry = await f.controller.generate('新图', ''); assert.match(entry.markerKey, /chat-B/); assert.equal(f.calls.save.length, 1);
});

test('host events invalidate a source and abort local waiting without any save or server cancellation', async () => {
  const gate = deferred(), f = await fixture({ generateGate: gate }); await f.controller.select(f.current);
  const pending = f.controller.generate('候选', ''); const rejected = assert.rejects(pending, /取消|失效|改变/); await until(() => f.calls.generate.length === 1);
  f.invalidate(); assert.equal(f.calls.generate[0].signal.aborted, true); await Promise.resolve(); assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.status.at(-1)[2], true); gate.resolve(); await rejected;
  assert.equal(f.calls.save.length, 0); await assert.rejects(f.controller.generate('不可复用旧选择', ''), /选择|来源/);
});

test('a changed source after generation but before persistence cannot save or display the returned image', async () => {
  const gate = deferred(), f = await fixture({ generateGate: gate }); await f.controller.select(f.current);
  const pending = f.controller.generate('旧候选', ''); const rejected = assert.rejects(pending, /来源|失效|改变/); await until(() => f.calls.generate.length === 1);
  f.current = { ...f.current, swipeId: 1 }; gate.resolve(); await rejected; assert.equal(f.calls.save.length, 0);
});

test('a silent source edit during the final SHA await is rejected before history persistence', async () => {
  const f = await fixture(); await f.controller.select(f.current);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let digests = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: { async digest(...args) {
      const value = await webcrypto.subtle.digest(...args);
      if (++digests === 3) f.current = source({ chatId: 'chat-B', text: '静默改变的来源' });
      return value;
    } },
  } });
  try { await assert.rejects(f.controller.generate('已确认候选', ''), /来源|失效|改变/); }
  finally { if (original) Object.defineProperty(globalThis, 'crypto', original); else delete globalThis.crypto; }
  assert.equal(f.calls.generate.length, 1); assert.equal(f.calls.save.length, 0, 'source changed while hashing must not be saved first');
});

test('a save failure is surfaced and never retries generation, storage or another provider', async () => {
  const f = await fixture({ saveError: new Error('图片历史保存失败') }); await f.controller.select(f.current);
  await assert.rejects(f.controller.generate('候选', ''), /保存失败/);
  assert.equal(f.calls.generate.length, 1); assert.equal(f.calls.save.length, 1); assert.equal(f.controller.busy, false);
});

test('cancel during a history commit pins only the original key and never presents it to another source', async () => {
  const gate = deferred(), f = await fixture({ saveGate: gate }); await f.controller.select(f.current);
  const pending = f.controller.generate('原来源图片', ''); const rejected = assert.rejects(pending, /取消|失效|改变/); await until(() => f.calls.save.length === 1);
  const key = f.calls.save[0].markerKey; f.controller.cancel(); assert.equal(f.controller.busy, true, 'in-flight storage is not claimed cancelled');
  f.current = source({ chatId: 'chat-B' }); await assert.rejects(f.controller.select(f.current), /进行|等待|忙|任务/);
  gate.resolve(); await rejected; assert.match(key, /chat-A/); assert.equal(f.calls.save.length, 1); assert.equal(f.controller.busy, false);
});

test('history load returning after cancellation is discarded without invoking the backend', async () => {
  const gate = deferred(), f = await fixture({ loadGate: gate }); await f.controller.select(f.current);
  const pending = f.controller.loadHistory('候选'); const rejected = assert.rejects(pending, /取消|失效|改变/); await until(() => f.calls.load.length === 1);
  f.controller.cancel(); gate.resolve(); await rejected; assert.equal(f.calls.generate.length, 0);
});

test('overlong sources remain fully visible for manual editing, never silently tail-selected', async () => {
  const f = await fixture(); f.current = source({ text: `开头${'完整正文'.repeat(1800)}结尾` });
  assert.equal(await f.controller.select(f.current), f.current.text);
  await assert.rejects(f.controller.generate(f.current.text, ''), /6000|超过/); assert.equal(f.calls.generate.length, 0);
  const entry = await f.controller.generate('手动确认的短候选', ''); assert.equal(entry.positive, '手动确认的短候选');
  const expected = await core.prepareDirectImage(f.current, '其他短候选'); assert.equal(entry.markerKey, expected.historyKey);
});

test('empty visible sources release their capture rather than accepting an invented replacement scene', async () => {
  const f = await fixture(); f.current = source({ text: '<think>全部隐藏</think>' });
  await assert.rejects(f.controller.select(f.current), /正文|来源/); assert.equal(f.calls.disposed, 1);
  await assert.rejects(f.controller.generate('不能凭空替换', ''), /选择|来源/); assert.equal(f.calls.generate.length, 0);
});

test('wrong saved provider and unexpected response providers fail closed without cross-provider history', async () => {
  const f = await fixture(); await f.controller.select(f.current); f.config.provider = 'grok';
  await assert.rejects(f.controller.generate('候选', ''), /Comfy|配置/); assert.equal(f.calls.generate.length, 0);
  const g = await fixture({ result: { provider: 'openai' } }); await g.controller.select(g.current);
  await assert.rejects(g.controller.generate('候选', ''), /Comfy|结果|提供/); assert.equal(g.calls.save.length, 0);
});

test('negative text is bounded before dispatch without silently dropping an unsupported value', async () => {
  const f = await fixture(); await f.controller.select(f.current);
  for (const negative of [null, '坏'.repeat(65537)]) await assert.rejects(f.controller.generate('候选', negative), /负面|负词|过长/);
  assert.equal(f.calls.generate.length, 0);
});

test('view callback failures cannot undo a successful history commit or cause duplicate execution', async () => {
  const f = await fixture({ statusThrows: true }); await f.controller.select(f.current);
  await f.controller.generate('候选', ''); assert.equal(f.calls.save.length, 1); assert.equal(f.calls.generate.length, 1);
});

test('an event during watcher installation releases both the late unsubscribe and the source capture', async () => {
  const f = await fixture({ watchHook: callback => callback() });
  await assert.rejects(f.controller.select(f.current), /取消|失效|改变/);
  assert.equal(f.calls.unwatch, 1); assert.equal(f.calls.disposed, 1); assert.equal(f.controller.busy, false);
});

test('invalidating inside a live-array host emitter must not swallow later rendering listeners', async () => {
  const listeners = []; let later = 0;
  const f = await fixture({ watchHook: callback => listeners.push(callback), onUnwatch: () => listeners.splice(0, 1) });
  await f.controller.select(f.current); listeners.push(() => { later++; });
  for (let index = 0; index < listeners.length; index++) listeners[index]();
  assert.equal(later, 1); await Promise.resolve(); assert.equal(f.calls.unwatch, 1);
});

test('disposing during source capture releases the late capture and cannot reopen a dead controller', async () => {
  const gate = deferred(), f = await fixture({ captureGate: gate });
  const pending = f.controller.select(f.current); const rejected = assert.rejects(pending, /取消|失效|改变/);
  f.controller.dispose(); gate.resolve(); await rejected; assert.equal(f.calls.disposed, 1);
  await assert.rejects(f.controller.select(source()), /关闭|失效|结束/); assert.equal(f.calls.capture.length, 1);
});
