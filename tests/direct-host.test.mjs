import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

// Run against root's dist by default, or an explicitly isolated build directory.
const buildRoot = process.env.DIRECT_HOST_DIST
  ? pathToFileURL(`${process.env.DIRECT_HOST_DIST.replace(/\/$/, '')}/`)
  : new URL('../dist/', import.meta.url);
const eventNames = ['CHAT_CHANGED', 'CHAT_LOADED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED',
  'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_EDITING_STARTED', 'MESSAGE_SWIPED',
  'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_SENT', 'GENERATION_STARTED', 'GENERATION_ENDED',
  'GENERATION_STOPPED', 'CHARACTER_EDITED', 'CHARACTER_SELECTED', 'GROUP_UPDATED'];
const deferred = () => Promise.withResolvers();

async function fixture(options = {}) {
  const subscriptions = new Map(), calls = { network: 0, headers: 0, embeddedWrite: 0, imports: [] };
  const state = { sifang: false, embedded: null, editing: false, generating: false, send: false, saving: false,
    groupGenerating: false, onIdle: null, onQuery: null, context: null, ...options };
  const eventSource = {
    on(event, handler) {
      if (!subscriptions.has(event)) subscriptions.set(event, options.liveEmitter ? [] : new Set());
      const list = subscriptions.get(event);
      if (options.liveEmitter) list.push(handler); else list.add(handler);
    },
    removeListener(event, handler) {
      const list = subscriptions.get(event);
      if (options.liveEmitter) { const index = list?.indexOf(handler) ?? -1; if (index >= 0) list.splice(index, 1); }
      else list?.delete(handler);
    },
  };
  const context = {
    chat: [
      { mes: '<StoryText>第一段。\r\n完整旧正文。</StoryText>', name: 'Witch', send_date: '2026-11-16T12:00:00.000Z',
        swipe_id: 0, swipes: ['<StoryText>第一段。\r\n完整旧正文。</StoryText>', '另一个版本'],
        swipe_info: [{ send_date: '2026-11-16T12:00:00.000Z' }, { send_date: '2026-11-16T12:01:00.000Z' }] },
      { mes: '用户正文', is_user: true },
      { mes: '最新 AI 回复', name: 'Witch', send_date: '2026-11-16T12:02:00.000Z' },
    ],
    chatId: 'chat-A', characterId: 0, groupId: undefined,
    chatMetadata: {}, characters: [{ name: 'Witch', avatar: 'witch.png', chat: 'chat-A' }], groups: [],
    getCurrentChatId() { return this.chatId; },
    getRequestHeaders() { calls.headers++; throw new Error('direct capture must not request headers'); },
    eventSource, eventTypes: Object.fromEntries(eventNames.map(name => [name, `native:${name}`])),
  };
  state.context = context;
  const sandbox = vm.createContext({ URL, location: { href: 'https://tavern.invalid/' },
    document: { querySelector() { state.onQuery?.(); return state.editing ? {} : null; } },
    SillyTavern: { getContext: () => state.context },
    fetch() { calls.network++; throw new Error('network forbidden in offline host test'); },
  });
  async function synthetic(exports) {
    const mod = new vm.SyntheticModule(Object.keys(exports), function() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context: sandbox });
    await mod.link(() => assert.fail('synthetic imports forbidden'));
    await mod.evaluate();
    return mod;
  }
  const main = await synthetic({
    isGenerating() { state.onIdle?.(); return state.generating; },
    is_send_press: false, isChatSaving: false,
  });
  const group = await synthetic({ is_group_generating: false });
  function nativeFlags(values) {
    Object.assign(state, values);
    if ('send' in values) main.setExport('is_send_press', values.send);
    if ('saving' in values) main.setExport('isChatSaving', values.saving);
    if ('groupGenerating' in values) group.setExport('is_group_generating', values.groupGenerating);
  }
  nativeFlags(state);
  const forbidden = () => assert.fail('direct capture must not call a write or Sifang adapter');
  const stubs = {
    './embedded-chat.js': {
      captureEmbeddedWrite() { calls.embeddedWrite++; return null; },
      readEmbeddedTurn() { return state.embedded; },
    },
    './sifang-host.js': { isSifangEnvironment: () => state.sifang },
    './sifang-chat.js': Object.fromEntries(['assertSifangSnapshot', 'captureSifangAssistant', 'isSifangChatReady',
      'readSifangAssistantMessages', 'readSifangFloors', 'replaceSifangAssistant', 'sifangImageChatContext',
      'watchSifangChat'].map(name => [name, forbidden])),
  };
  const mod = new vm.SourceTextModule(await readFile(new URL('chat-host.js', buildRoot), 'utf8'), {
    context: sandbox, identifier: 'chat-host.js',
    async importModuleDynamically(specifier) {
      calls.imports.push(specifier);
      if (options.importGate) await options.importGate.promise;
      if (options.importError) throw new Error('offline import failed');
      if (specifier === 'https://tavern.invalid/script.js') return main;
      if (specifier === 'https://tavern.invalid/scripts/group-chats.js') return group;
      assert.fail(`Unexpected native import: ${specifier}`);
    },
  });
  await mod.link(name => {
    assert.ok(name in stubs, `Only explicit offline stubs may be loaded: ${name}`);
    return synthetic(stubs[name]);
  });
  await mod.evaluate();
  const api = mod.namespace;
  return { api, context, state, calls, nativeFlags, main,
    source: (id = 0) => ({ ...api.readAssistantMessages().find(item => item.messageId === id) }),
    emit(name, ...args) {
      const event = context.eventTypes[name] ?? name;
      const list = subscriptions.get(event) ?? [];
      for (const handler of options.liveEmitter ? list : [...list]) handler(...args);
    },
    listeners: () => [...subscriptions.values()].reduce((sum, value) => sum + (value.size ?? value.length), 0),
  };
}

async function expectInvalid(capture) {
  await assert.rejects(capture.assertCurrent(), /变化|改变|失效|重新|来源|切换|不支持|前端/);
}

test('read-only native capture API exists (red before implementation)', async () => {
  const f = await fixture();
  assert.equal(typeof f.api.captureDirectAssistant, 'function');
});

test('the final synchronous guard rechecks live identity and busy flags without yielding or new native imports', async () => {
  const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source());
  assert.equal(typeof capture.assertCurrentSync, 'function');
  const imports = f.calls.imports.length, checked = capture.assertCurrentSync();
  assert.equal(typeof checked?.then, 'undefined'); assert.equal(checked.text, f.source().text);
  assert.equal(f.calls.imports.length, imports);
  f.context.chat[0].mes = '无事件的静默改文';
  assert.throws(() => capture.assertCurrentSync(), /来源|变化|失效/); assert.equal(f.listeners(), 0);
  const g = await fixture(), busy = await g.api.captureDirectAssistant(g.source());
  g.nativeFlags({ saving: true }); assert.throws(() => busy.assertCurrentSync(), /保存|稍后/);
  g.nativeFlags({ saving: false }); assert.throws(() => busy.assertCurrentSync(), /来源|失效/);
});

test('any native old AI floor is captured without writes, headers, storage, or network', async () => {
  const f = await fixture(), source = f.source(), original = JSON.stringify(f.context);
  Object.freeze(f.context.chat[0].swipes); Object.freeze(f.context.chat[0]); Object.freeze(f.context.chat);
  const capture = await f.api.captureDirectAssistant(source);
  assert.deepEqual({ ...capture.source }, source);
  assert.equal(Object.isFrozen(capture.source), true);
  source.text = 'caller later mutates its input';
  assert.equal((await capture.assertCurrent()).text, f.context.chat[0].mes);
  assert.equal(JSON.stringify(f.context), original);
  assert.deepEqual(f.calls.imports.sort(), ['https://tavern.invalid/script.js', 'https://tavern.invalid/scripts/group-chats.js']);
  assert.equal(f.calls.network + f.calls.headers + f.calls.embeddedWrite, 0);
  assert.ok(f.listeners() > 0);
  capture.dispose(); capture.dispose();
  assert.equal(f.listeners(), 0);
  await expectInvalid(capture);
});

test('native group scope and a floor without swipes are supported', async () => {
  const f = await fixture();
  f.context.groupId = 'group-A'; f.context.groups = [{ id: 'group-A', chat_id: 'chat-A' }];
  const source = f.source(2), capture = await f.api.captureDirectAssistant(source);
  assert.equal(capture.source.scope, JSON.stringify(['group', 'group-A']));
  assert.equal(capture.source.swipeId, null);
  await capture.assertCurrent(); capture.dispose();
});

test('source is bound before native import await; switching away and back never revives it', async () => {
  const gate = deferred(), f = await fixture({ importGate: gate });
  const result = f.api.captureDirectAssistant(f.source());
  assert.ok(f.listeners() > 0, 'subscribe before the first await');
  f.context.chatId = 'chat-B'; f.emit('CHAT_CHANGED');
  f.context.chatId = 'chat-A'; f.emit('CHAT_CHANGED');
  gate.resolve();
  await assert.rejects(result, /变化|改变|失效|重新/);
  assert.equal(f.listeners(), 0);
});

test('capture copies caller fields before its first await', async () => {
  const gate = deferred(), f = await fixture({ importGate: gate }), source = f.source();
  const result = f.api.captureDirectAssistant(source);
  source.text = 'tampered caller'; source.chatId = 'tampered caller';
  gate.resolve();
  const capture = await result;
  assert.equal(capture.source.text, f.context.chat[0].mes);
  assert.equal(capture.source.chatId, 'chat-A'); capture.dispose();
});

test('text edited during the initial import await is rejected with listener cleanup', async () => {
  const gate = deferred(), f = await fixture({ importGate: gate });
  const result = f.api.captureDirectAssistant(f.source());
  f.context.chat[0].mes = 'changed silently'; gate.resolve();
  await assert.rejects(result, /变化|改变|失效|重新/);
  assert.equal(f.listeners(), 0);
});

test('all source primitive mismatches, user/system floors, missing and duplicate history IDs reject', async () => {
  for (const change of [{ scope: 'other' }, { chatId: 'other' }, { messageId: 1 }, { messageId: 2 },
    { swipeId: 1 }, { text: 'other' }, { historyId: null }, { historyId: '' }, { historyId: 'other' },
    { turnId: 'embedded-turn' }, { messageId: -1 }, { swipeId: NaN }]) {
    const f = await fixture();
    await assert.rejects(f.api.captureDirectAssistant({ ...f.source(), ...change }), undefined, JSON.stringify(change));
    assert.equal(f.listeners(), 0);
  }
  for (const mutate of [
    f => { delete f.context.chat[0].send_date; f.context.chat[0].swipe_info = []; },
    f => { f.context.chat[2].send_date = f.context.chat[0].send_date; },
    f => { f.context.chat[0].swipe_info[1].send_date = f.context.chat[0].send_date; },
    f => { f.context.chat[0].is_system = true; },
    f => { f.context.chat[0].is_user = true; },
  ]) {
    const f = await fixture(), source = f.source(); mutate(f);
    await assert.rejects(f.api.captureDirectAssistant(source));
    assert.equal(f.listeners(), 0);
  }
});

test('unverified embedded and Sifang sources explicitly reject without native imports or adapter writes', async () => {
  for (const kind of ['embedded', 'sifang']) {
    const f = await fixture(), source = f.source();
    if (kind === 'embedded') f.state.embedded = { turnId: 'frontend', historyId: 'frontend', text: source.text };
    else f.state.sifang = true;
    await assert.rejects(f.api.captureDirectAssistant(source), /原生|内嵌|前端|Sifang|支持/);
    assert.equal(f.calls.network + f.calls.headers + f.calls.embeddedWrite, 0);
    assert.equal(f.calls.imports.length, 0); assert.equal(f.listeners(), 0);
  }
});

test('chat/message/swipes identity, roles, scope and stable history are revalidated without events', async () => {
  for (const [label, mutate] of [
    ['chat array', f => { f.context.chat = [...f.context.chat]; }],
    ['message object', f => { f.context.chat[0] = { ...f.context.chat[0] }; }],
    ['swipes object', f => { f.context.chat[0].swipes = [...f.context.chat[0].swipes]; }],
    ['swipes count', f => { f.context.chat[0].swipes.push('new swipe'); }],
    ['swipe text', f => { f.context.chat[0].swipes[0] = 'different'; }],
    ['swipe selection', f => { f.context.chat[0].swipe_id = 1; }],
    ['body', f => { f.context.chat[0].mes += 'different'; }],
    ['user role', f => { f.context.chat[0].is_user = true; }],
    ['system role', f => { f.context.chat[0].is_system = true; }],
    ['chat id', f => { f.context.chatId = 'chat-B'; }],
    ['character', f => { f.context.characterId = 1; }],
    ['avatar scope', f => { f.context.characters[0].avatar = 'other.png'; }],
    ['character object', f => { f.context.characters[0] = { ...f.context.characters[0] }; }],
    ['group', f => { f.context.groupId = 'group-A'; }],
    ['floor index', f => { f.context.chat.unshift({ mes: 'new user', is_user: true }); }],
    ['history date', f => { f.context.chat[0].send_date = '2026-11-16T12:03:00.000Z'; }],
    ['history collision', f => { f.context.chat[2].send_date = f.context.chat[0].send_date; }],
    ['turn becomes embedded', f => { f.state.embedded = { turnId: 'embedded' }; }],
  ]) {
    const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source()); mutate(f);
    await assert.rejects(capture.assertCurrent(), undefined, label);
    assert.equal(f.listeners(), 0, label);
  }
});

test('every relevant native activity event permanently invalidates even after state is restored', async () => {
  for (const event of [...eventNames, 'js_generation_requested', 'js_generation_started']) {
    const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source());
    f.emit(event, 0);
    await expectInvalid(capture);
    assert.equal(f.listeners(), 0, event);
  }
});

test('one disposed capture cannot detach another active capture listener', async () => {
  const f = await fixture(), first = await f.api.captureDirectAssistant(f.source()),
    second = await f.api.captureDirectAssistant(f.source());
  const count = f.listeners(); first.dispose();
  assert.ok(f.listeners() > 0 && f.listeners() < count);
  await second.assertCurrent(); f.emit('CHAT_CHANGED'); await expectInvalid(second);
  assert.equal(f.listeners(), 0);
});

test('assertCurrent checks both before and after its await, including switch-away-and-back epoch', async () => {
  const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source());
  const result = capture.assertCurrent();
  f.emit('CHAT_CHANGED'); f.emit('CHAT_CHANGED');
  await assert.rejects(result, /变化|改变|失效|重新/);
  assert.equal(f.listeners(), 0);
});

test('assertCurrent rejects changes made during idle checks and never revives afterward', async () => {
  for (const hook of ['onIdle', 'onQuery']) {
    const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source());
    f.state[hook] = () => { f.context.chat[0].mes = 'changed while checking idle'; };
    await expectInvalid(capture);
    f.state[hook] = null; f.context.chat[0].mes = capture.source.text;
    await expectInvalid(capture);
    assert.equal(f.listeners(), 0);
  }
});

test('initial capture also rejects a switch-away-and-back triggered by an idle check', async () => {
  const f = await fixture();
  f.state.onIdle = () => { f.emit('CHAT_CHANGED'); f.emit('CHAT_CHANGED'); };
  await assert.rejects(f.api.captureDirectAssistant(f.source()), /变化|改变|失效|重新/);
  assert.equal(f.listeners(), 0);
});

test('active generation, saving, edits, unreadable flags and failed imports fail closed and release listeners', async () => {
  for (const values of [{ generating: true }, { send: true }, { saving: true }, { groupGenerating: true }, { editing: true }]) {
    const f = await fixture(); f.nativeFlags(values);
    await assert.rejects(f.api.captureDirectAssistant(f.source()), /回复|保存|编辑/);
    assert.equal(f.listeners(), 0);
  }
  const missing = await fixture();
  missing.main.setExport('isGenerating', undefined); missing.main.setExport('is_send_press', undefined);
  await assert.rejects(missing.api.captureDirectAssistant(missing.source()), /生成状态/);
  assert.equal(missing.listeners(), 0);
  const broken = await fixture({ importError: true });
  await assert.rejects(broken.api.captureDirectAssistant(broken.source()), /生成状态/);
  assert.equal(broken.listeners(), 0);
});

test('assertCurrent rejects newly busy idle state and permanently invalidates the capture', async () => {
  const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source());
  f.nativeFlags({ generating: true }); await assert.rejects(capture.assertCurrent(), /回复/);
  f.nativeFlags({ generating: false }); await expectInvalid(capture);
  assert.equal(f.listeners(), 0);
});

test('missing core event APIs fail closed rather than permitting an unobservable switch', async () => {
  for (const mutate of [f => { delete f.context.eventTypes.CHAT_CHANGED; },
    f => { delete f.context.eventTypes.GENERATION_STARTED; },
    f => { f.context.eventSource = null; }]) {
    const f = await fixture(), source = f.source(); mutate(f);
    await assert.rejects(f.api.captureDirectAssistant(source), /事件|宿主|支持/);
    assert.equal(f.listeners(), 0);
  }
});

test('watchChatRendering forwards generation start, edits, sends and character changes for prompt UI cancellation', async () => {
  const f = await fixture(), received = [];
  const stop = f.api.watchChatRendering((id, _change, event) => received.push([id, event]));
  for (const event of ['GENERATION_STARTED', 'MESSAGE_EDITED', 'MESSAGE_SENT', 'CHARACTER_EDITED', 'CHARACTER_SELECTED']) {
    f.emit(event, 0); assert.deepEqual(received.at(-1), [0, event]);
  }
  stop(); assert.equal(f.listeners(), 0);
});

test('an event queued by the final idle check invalidates capture before it is returned', async () => {
  const f = await fixture();
  f.state.onQuery = () => { queueMicrotask(() => f.emit('CHAT_CHANGED')); };
  await assert.rejects(f.api.captureDirectAssistant(f.source()), /变化|改变|失效|重新/);
  assert.equal(f.listeners(), 0);
});

test('invalidation does not swallow later host listeners on an emitter with live array iteration', async () => {
  const f = await fixture({ liveEmitter: true }), capture = await f.api.captureDirectAssistant(f.source()), seen = [];
  const stop = f.api.watchChatRendering((_id, _change, event) => seen.push(event));
  f.emit('CHAT_CHANGED');
  assert.deepEqual(seen, ['CHAT_CHANGED']);
  await expectInvalid(capture); stop(); assert.equal(f.listeners(), 0);
});

test('a malformed native swipes field is rejected instead of treated as a normal no-swipe floor', async () => {
  const f = await fixture(); f.context.chat[0].swipes = 'not a native swipe array';
  await assert.rejects(f.api.captureDirectAssistant(f.source()), /swipe|楼层|来源/);
  assert.equal(f.listeners(), 0);
});

test('legacy latest-assistant write snapshot still rejects old floors and does not share direct authorization', async () => {
  const f = await fixture(), capture = await f.api.captureDirectAssistant(f.source());
  await assert.rejects(f.api.assertChatSnapshot(capture.source), /变化|改变|写回/);
  const latest = await f.api.captureLatestAssistant();
  assert.equal(latest.messageId, 2);
  await f.api.assertChatSnapshot(latest);
  f.context.chat.push({ mes: 'newer AI', send_date: '2026-11-16T12:03:00.000Z' });
  await assert.rejects(f.api.assertChatSnapshot(latest), /变化|改变|写回/);
  capture.dispose();
});
