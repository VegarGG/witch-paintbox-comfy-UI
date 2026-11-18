import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDirectImageInline } from '../dist/direct-image-inline.js';
import { directImageHistoryKey, directImageHistoryKeyForSource, prepareDirectImage } from '../dist/direct-image.js';

const source = (overrides = {}) => ({ scope: '["character","neutral.png"]', chatId: 'chat-a', messageId: 0,
  swipeId: 0, historyId: 'stable-a', turnId: null, text: 'A ceramic cup rests on a table.', ...overrides });
const keyOf = directImageHistoryKeyForSource;
const entry = (markerKey, id, provider = 'comfyui', mime = 'image/png') => ({ markerKey, id, provider, blob: new Blob(['fixture'], { type: mime }) });

function floor(id = 0, swipe = 0, { editing = false, embedded = false, user = false, nested = false } = {}) {
  const block = {
    parentElement: { closest: () => nested ? {} : null },
    getAttribute: name => ({ mesid: String(id), swipeid: swipe === null ? null : String(swipe), is_user: String(user) })[name] ?? null,
    querySelector: selector => selector === '.mes_text' ? text : editing ? {} : null,
  };
  const text = { closest: () => block, querySelector: name => name === 'iframe' && embedded ? {} : null, original: 'untouched DOM' };
  return { block, text };
}

function harness(t, initial = source()) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const state = { chat: [], message: {}, source: initial, floors: [floor(initial.messageId, initial.swipeId)], stored: new Map() };
  state.root = { isConnected: true, querySelectorAll: () => state.floors.map(item => item.block) };
  const visible = new Map(), calls = [], unmounted = [], unwatch = [];
  const listeners = {};
  let scheduled;
  const watch = name => callback => {
    listeners[name] = callback;
    return () => { unwatch.push(name); delete listeners[name]; };
  };
  const deps = {
    root: () => state.root,
    read: ids => ({ chat: state.chat, sources: new Map(ids.includes(state.source.messageId)
      ? [[state.source.messageId, { message: state.message, source: { ...state.source } }]] : []) }),
    load: key => { calls.push(key); return state.stored.get(key) ?? []; },
    mount: (item, image) => {
      assert.equal(item.text.original, 'untouched DOM');
      assert.ok(!visible.has(item.block), 'no duplicate image on a floor');
      visible.set(item.block, image.id);
      return () => { visible.delete(item.block); unmounted.push(image.id); };
    },
    watch: watch('chat'), watchHistory: watch('history'), watchDom: watch('dom'),
    schedule: callback => { scheduled = callback; return () => { scheduled = undefined; }; },
  };
  function run() { const next = scheduled; scheduled = undefined; assert.ok(next, 'expected a refresh'); next(); }
  const start = () => bindDirectImageInline(controller.signal, deps);
  return { state, visible, calls, unmounted, unwatch, deps, listeners, run, start, controller };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('timed out waiting for the inline render');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('display derives the original persisted key without a prompt or a task', async () => {
  const origin = source();
  assert.equal(await keyOf(origin), directImageHistoryKey(await prepareDirectImage(origin, 'Edited local prompt')));
  assert.equal(await keyOf(source({ messageId: 9 })), await keyOf(origin), 'renumbering alone does not change persisted identity');
  for (const changed of [{ chatId: 'chat-b' }, { scope: 'group' }, { swipeId: 1 }, { historyId: 'other' }, { text: `${origin.text} ` }]) {
    assert.notEqual(await keyOf(source(changed)), await keyOf(origin));
  }
  await assert.rejects(keyOf(source({ historyId: null })), /historyId/);
});

test('initial mount restores only the newest matching raster; history deletion and save refresh without duplicates', async t => {
  const h = harness(t), key = await keyOf(h.state.source);
  const first = entry(key, 'first'), latest = entry(key, 'latest');
  h.state.stored.set(key, [first, latest, entry(key, 'other provider', 'openai'), entry(key, 'wrong MIME', 'comfyui', 'image/svg+xml'), entry('other-key', 'wrong key')]);
  h.start(); h.run();
  await until(() => h.visible.size === 1);
  assert.deepEqual([...h.visible.values()], ['latest']);
  h.state.stored.set(key, [first]); h.listeners.history({ deletedIds: ['latest'] });
  assert.equal(h.visible.size, 0, 'deleted pixels removed before the read finishes');
  h.run(); await until(() => h.visible.size === 1);
  assert.deepEqual([...h.visible.values()], ['first']);
  h.state.stored.set(key, []); h.listeners.history({ before: 100 }); h.run(); await settle();
  assert.equal(h.visible.size, 0);
  h.state.stored.set(key, [latest]); h.listeners.history({ savedId: 'latest' }); h.run();
  await until(() => h.visible.size === 1);
  h.controller.abort();
  assert.equal(h.visible.size, 0);
  assert.deepEqual(h.unwatch, ['chat', 'history', 'dom']);
});

test('swipe, edit, switch and return never borrow a different source image', async t => {
  const h = harness(t), original = h.state.source, key = await keyOf(original);
  const other = source({ chatId: 'chat-b' });
  const otherKey = await keyOf(other);
  h.state.stored.set(key, [entry(key, 'original')]);
  h.state.stored.set(otherKey, [entry(otherKey, 'other chat')]);
  h.start(); h.run(); await until(() => h.visible.size === 1);
  h.state.source = source({ swipeId: 1 }); h.state.floors = [floor(0, 1)];
  h.listeners.chat(0, undefined, 'MESSAGE_SWIPED'); h.run(); await until(() => h.calls.length === 2);
  assert.equal(h.visible.size, 0);
  h.state.source = source({ text: 'Revised cup.' }); h.state.floors = [floor()];
  h.listeners.chat(0, undefined, 'MESSAGE_EDITED'); await settle(); h.run(); await until(() => h.calls.length === 3);
  assert.equal(h.visible.size, 0);
  h.state.source = other; h.state.chat = []; h.state.message = {};
  h.listeners.chat(); await settle(); h.run(); await settle();
  assert.equal(h.calls.length, 3, 'old text node must not be reused for another chat');
  h.state.floors = [floor()]; h.listeners.dom(); h.run(); await until(() => h.visible.size === 1);
  assert.deepEqual([...h.visible.values()], ['other chat']);
  h.state.source = original; h.state.chat = []; h.state.message = {}; h.state.floors = [floor()];
  h.listeners.chat(); await settle(); h.run(); await until(() => h.visible.size === 1);
  assert.deepEqual([...h.visible.values()], ['original']);
});

test('an in-flight read is discarded on invalidation and a late completion cannot resurrect a deleted image', async t => {
  const h = harness(t), key = await keyOf(h.state.source);
  let finish;
  h.state.stored.set(key, new Promise(resolve => { finish = resolve; }));
  h.start(); h.run(); await until(() => h.calls.length === 1);
  h.state.stored.delete(key); h.listeners.history({ deletedIds: ['stale'] });
  finish([entry(key, 'stale')]);
  await settle(); assert.equal(h.visible.size, 0);
  h.run(); await until(() => h.calls.length === 2); assert.equal(h.visible.size, 0);
});

for (const [caption, change] of [
  ['native message object', h => { h.state.message = {}; }],
  ['original text', h => { h.state.source = source({ text: 'Changed while awaiting' }); }],
  ['floor text node', h => { h.state.floors = [floor()]; }],
  ['chat root', h => { h.state.root = { ...h.state.root }; }],
  ['editing state', h => { h.state.floors = [floor(0, 0, { editing: true })]; }],
]) {
  test(`lookup rechecks ${caption} even without an intervening event`, async t => {
    const h = harness(t), key = await keyOf(h.state.source);
    let finish;
    h.state.stored.set(key, new Promise(resolve => { finish = resolve; }));
    h.start(); h.run(); await until(() => h.calls.length === 1);
    change(h); finish([entry(key, 'stale')]);
    await settle(); assert.equal(h.visible.size, 0);
  });
}

test('default renderer appends a sibling with protected blob pixels and revokes the URL on teardown', async t => {
  const h = harness(t), key = await keyOf(h.state.source), [sourceFloor] = h.state.floors;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  const children = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: tag => ({ tag, style: {}, attachShadow: ({ mode }) => {
      assert.equal(mode, 'closed'); return { append: (...nodes) => children.push(...nodes) };
    }, addEventListener() {}, removeAttribute(name) { delete this[name]; }, remove() { this.removed = true; } }),
  } });
  let sibling;
  sourceFloor.text.after = node => { sibling = node; };
  const create = t.mock.method(URL, 'createObjectURL', () => 'blob:neutral-fixture');
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  h.state.stored.set(key, [entry(key, 'latest')]);
  const { mount: _fake, ...deps } = h.deps;
  const stop = bindDirectImageInline(h.controller.signal, deps);
  h.run(); await until(() => sibling);
  assert.equal(sibling.tag, 'figure');
  assert.equal(sourceFloor.text.original, 'untouched DOM');
  assert.deepEqual(children.map(node => node.tag), ['figcaption', 'img']);
  assert.equal(children[1].src, 'blob:neutral-fixture');
  assert.equal(create.mock.callCount(), 1);
  stop(); stop();
  assert.ok(sibling.removed);
  assert.equal(children[1].src, undefined);
  assert.deepEqual(revoke.mock.calls.map(call => call.arguments), [['blob:neutral-fixture']]);
});

test('duplicate floors, native editing, embedded frames, user DOM and mismatched swipe do not query history', async t => {
  const h = harness(t);
  h.state.floors = [floor(), floor()];
  h.start(); h.run(); await settle();
  for (const item of [floor(0, 0, { editing: true }), floor(0, 0, { embedded: true }),
    floor(0, 0, { user: true }), floor(0, 1), floor(0, 0, { nested: true })]) {
    h.state.floors = [item]; h.listeners.dom(); h.run(); await settle();
  }
  assert.deepEqual(h.calls, []);
});
