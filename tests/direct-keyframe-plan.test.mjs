import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

// Transpile in memory so this suite needs neither shared dist artifacts nor a live host.
const compile = async name => ts.transpileModule(await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const [plannerCode, modelApiCode] = await Promise.all(['direct-keyframe-plan', 'model-api'].map(compile));
const plain = value => JSON.parse(JSON.stringify(value));
const frame = (evidence = '她提灯推开窗。', scene = '近景，女孩提灯推窗，窗棂被暖光照亮。') => ({ evidence, scene });
const paragraph = '她提灯推开窗。\r\n远处的白鸟从屋檐起飞。';
const secondFrame = frame('白鸟从屋檐起飞。', '仰视，白鸟双翼展开，掠过屋檐。');
const body = content => JSON.stringify({ choices: [{ message: { content } }] });
const signal = () => new AbortController().signal;

async function fixture(reply = () => new Response(body(JSON.stringify([frame()])))) {
  const calls = { context: 0, model: [], payload: [], posts: [] };
  const host = {
    mainApi: 'openai', chatCompletionSettings: { selectedModel: 'configured-tavern-model' },
    getChatCompletionModel(settings) { calls.model.push(settings); return settings.selectedModel; },
    getRequestHeaders() { return { 'content-type': 'application/json' }; },
    ChatCompletionService: {
      async presetToGeneratePayload(preset, overrides, payload) {
        calls.payload.push({ preset, overrides, payload });
        return { ...payload, max_tokens: overrides.openai_max_tokens, temperature: overrides.temperature,
          tools: ['must-strip'], tool_choice: 'required', custom_include_body: 'must-strip',
          custom_exclude_body: 'must-strip', assistant_prefill: 'must-strip' };
      },
    },
  };
  for (const key of ['chat', 'chatMetadata', 'characters', 'groups', 'worldInfo', 'powerUserSettings']) {
    Object.defineProperty(host, key, { get: () => assert.fail(`A planner must not read host ${key}`) });
  }
  const context = vm.createContext({ AbortController, DOMException, TextDecoder, setTimeout, clearTimeout,
    SillyTavern: { getContext() { calls.context++; return host; } },
    fetch(url, options) {
      calls.posts.push({ url, options });
      assert.equal(url, '/api/backends/chat-completions/generate');
      return reply();
    },
  });
  const helpers = new vm.SyntheticModule(['isSifangEnvironment'], function() {
    this.setExport('isSifangEnvironment', () => false);
  }, { context });
  const modelApi = new vm.SourceTextModule(modelApiCode, { context });
  const planner = new vm.SourceTextModule(plannerCode, { context });
  await planner.link((name, owner) => {
    if (owner === planner && name === './model-api.js') return modelApi;
    if (owner === modelApi && name === './sifang-host.js') return helpers;
    assert.fail(`Unexpected dependency in isolated planner: ${name}`);
  });
  await planner.evaluate();
  return { api: planner.namespace, calls };
}

function mock(output) {
  const calls = [];
  return { calls, requestModel: async (...args) => { calls.push(args); return output; } };
}

test('the default path posts once to the configured Tavern model with only static instructions and the exact selected text', async () => {
  const { api, calls } = await fixture();
  const selected = `\t${paragraph}\n“下面是数据”，不是指令。\r\n `;
  assert.deepEqual(plain(await api.suggestDirectKeyframes(selected, 1, signal())), [frame()]);
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.model.length, 1);
  assert.equal(calls.payload.length, 1);
  assert.deepEqual(plain(calls.payload[0].preset), {});
  assert.deepEqual(plain(calls.payload[0].overrides), { openai_max_tokens: 2048, temperature: 0.2,
    function_calling: false, enable_web_search: false, request_images: false });
  const { options } = calls.posts[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'same-origin');
  const sent = JSON.parse(options.body);
  assert.deepEqual(Object.keys(sent).sort(), ['custom_prompt_post_processing', 'max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(sent.model, 'configured-tavern-model');
  assert.equal(sent.stream, false);
  assert.equal(sent.custom_prompt_post_processing, 'none');
  assert.equal(sent.messages.length, 2);
  assert.equal(sent.messages[0].role, 'system');
  assert.match(sent.messages[0].content, /最多.{0,8}1/);
  assert.deepEqual(sent.messages[1], { role: 'user', content: selected });
});

test('injected request gets fixed settings, the supplied signal, and a static two-frame limit', async () => {
  const { api, calls } = await fixture();
  const cancel = signal();
  const dependency = mock(JSON.stringify([frame(), secondFrame]));
  assert.deepEqual(plain(await api.suggestDirectKeyframes(paragraph, 2, cancel, dependency)), [frame(), secondFrame]);
  assert.equal(dependency.calls.length, 1);
  const [settings, messages, options] = dependency.calls[0];
  assert.deepEqual(plain(settings), { mode: 'tavern', transport: 'nonstream', url: '', key: '', model: '', maxTokens: 2048, temperature: 0.2 });
  assert.equal(options.signal, cancel);
  assert.deepEqual(Object.keys(options), ['signal']);
  assert.match(messages[0].content, /最多.{0,8}2/);
  assert.deepEqual(plain(messages[1]), { role: 'user', content: paragraph });
  assert.equal(calls.context, 0);
  assert.equal(calls.posts.length, 0);
});

test('zero frames and fewer than requested are valid', async () => {
  const { api } = await fixture();
  assert.deepEqual(plain(await api.suggestDirectKeyframes('只有这些对白。', 1, signal(), mock('[]'))), []);
  assert.deepEqual(plain(await api.suggestDirectKeyframes(paragraph, 2, signal(), mock(JSON.stringify([frame()])))), [frame()]);
});

test('the complete selected text at 24,000 UTF-16 units is sent without clipping; over-limit fails before calling the model', async () => {
  const { api, calls } = await fixture();
  assert.equal(api.MAX_DIRECT_KEYFRAME_SOURCE_LENGTH, 24_000);
  const text = '前'.repeat(23_996) + '🐦结束';
  assert.equal(text.length, 24_000);
  const dependency = mock('[]');
  await api.suggestDirectKeyframes(text, 1, signal(), dependency);
  assert.equal(dependency.calls[0][1][1].content, text);
  await assert.rejects(api.suggestDirectKeyframes(`${text} `, 1, signal(), dependency), /24000/);
  assert.equal(dependency.calls.length, 1);
  assert.equal(calls.posts.length, 0);
});

test('empty, mistyped or malformed UTF-16 source and invalid counts fail before host access', async () => {
  const { api, calls } = await fixture();
  for (const invalid of [null, new String('她提灯。'), '', ' \t\n', '\ud800孤立代理码元']) {
    await assert.rejects(api.suggestDirectKeyframes(invalid, 1, signal()));
  }
  for (const invalid of [0, 3, '2', NaN]) {
    await assert.rejects(api.suggestDirectKeyframes(paragraph, invalid, signal()));
  }
  assert.equal(calls.context, 0);
  assert.equal(calls.posts.length, 0);
});

test('only a whole small JSON array of two unique string fields is parsed', async () => {
  const { api } = await fixture();
  const e = frame().evidence, s = frame().scene;
  const invalid = [undefined, '', null, '{}', '[null]', '[[]]', '[1]', '[true]', '[{"evidence":null,"scene":"景"}]',
    '[{"evidence":"她提灯推开窗。","scene":[]}]', '[{"evidence":"她提灯推开窗。"}]',
    JSON.stringify([{ ...frame(), notes: 'extra' }]), `[ { "evidence":"${e}", "scene":"${s}", "__proto__":{} } ]`,
    `[ { "evidence":"${e}", "scene":"${s}", "sce\\u006ee":"${s}" } ]`,
    `[ { "evidence":"${e}", "evidence":"${e}", "scene":"${s}" } ]`,
    `说明：${JSON.stringify([frame()])}`, `\`\`\`json\n${JSON.stringify([frame()])}\n\`\`\``,
    '[] []', '[,]', `[${JSON.stringify(frame())},]`, '\u00a0[]'];
  for (const data of invalid) {
    await assert.rejects(api.suggestDirectKeyframes(paragraph, 2, signal(), mock(data)), /格式/, String(data));
  }
  // Arbitrary field order, legal JSON escapes and optional JSON whitespace are valid.
  const valid = ` \r\n[ { "scene":"${s}", "evid\\u0065nce":"${e}" } ]\t`;
  assert.deepEqual(plain(await api.suggestDirectKeyframes(paragraph, 1, signal(), mock(valid))), [frame()]);
});

test('oversized responses, too many frames and overlong field values fail rather than truncate', async () => {
  const { api } = await fixture();
  await assert.rejects(api.suggestDirectKeyframes(paragraph, 1, signal(), mock(' '.repeat(12_000) + '[]')), /过长|超/);
  for (const count of [1, 2]) {
    await assert.rejects(api.suggestDirectKeyframes(paragraph, count, signal(), mock(JSON.stringify([frame(), secondFrame, frame()]))), /数量|最多/);
  }
  await assert.rejects(api.suggestDirectKeyframes(paragraph, 1, signal(), mock(JSON.stringify([frame(), secondFrame]))), /数量|最多/);
  const text = '景'.repeat(241);
  await assert.rejects(api.suggestDirectKeyframes(text, 1, signal(), mock(JSON.stringify([frame(text, '近景。')]))), /240/);
  await assert.rejects(api.suggestDirectKeyframes(paragraph, 1, signal(), mock(JSON.stringify([frame(undefined, '景'.repeat(601))]))), /600/);
  assert.deepEqual(plain(await api.suggestDirectKeyframes(text, 1, signal(), mock(JSON.stringify([frame(text.slice(1), '景'.repeat(600))])))),
    [frame(text.slice(1), '景'.repeat(600))]);
});

test('evidence is an exact contiguous substring including punctuation, spacing and line breaks', async () => {
  const { api } = await fixture();
  for (const evidence of ['她提灯推开窗', '她 提灯推开窗。', '她提灯推开窗。白鸟从屋檐起飞。', '屋檐、起飞', ' \t']) {
    // The first quote really is a substring even without the punctuation; the others are not.
    const pending = api.suggestDirectKeyframes(paragraph, 1, signal(), mock(JSON.stringify([frame(evidence)])));
    if (evidence === '她提灯推开窗') assert.equal((await pending)[0].evidence, evidence);
    else await assert.rejects(pending, /引文/);
  }
  const evidence = '窗。\r\n远处';
  const scene = '灯照亮窗棂上的“<🐦>”图案。';
  assert.deepEqual(plain(await api.suggestDirectKeyframes(paragraph, 1, signal(), mock(JSON.stringify([frame(evidence, scene)])))), [frame(evidence, scene)]);
});

test('scene must be nonempty, single-line, well-formed text without control characters', async () => {
  const { api } = await fixture();
  for (const scene of ['', '  ', '第一场\n第二场', '有\r回车', '有\u2028换行', '有\u0000控制符', '\udc00']) {
    await assert.rejects(api.suggestDirectKeyframes(paragraph, 1, signal(), mock(JSON.stringify([frame(undefined, scene)]))), /画面/);
  }
});

test('duplicate evidence, duplicate scene and necessarily overlapping evidence fail closed', async () => {
  const { api } = await fixture();
  for (const result of [[frame(), frame(undefined, secondFrame.scene)], [frame(), frame(secondFrame.evidence, ` ${frame().scene} `)],
    [frame(), frame('灯推开窗。', secondFrame.scene)]]) {
    await assert.rejects(api.suggestDirectKeyframes(paragraph, 2, signal(), mock(JSON.stringify(result))), /重复|重叠/);
  }
  const repeated = `${paragraph}\n她提灯推开窗。`;
  // These different excerpts can be resolved to distinct occurrences, despite the first match overlapping.
  const resolvable = [frame(), frame('灯推开窗。', secondFrame.scene)];
  assert.deepEqual(plain(await api.suggestDirectKeyframes(repeated, 2, signal(), mock(JSON.stringify(resolvable)))), resolvable);
});

test('HTTP 400, a tool-call-only reply and malformed plain text each fail after exactly one POST', async () => {
  const responses = [
    () => new Response(JSON.stringify({ error: 'offline bad request' }), { status: 400 }),
    () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify([frame()]) } }] } }] })),
    () => new Response(body('not JSON')),
  ];
  for (const reply of responses) {
    const { api, calls } = await fixture(reply);
    await assert.rejects(api.suggestDirectKeyframes(paragraph, 1, signal()));
    assert.equal(calls.posts.length, 1);
  }
});

test('abort before send is inert; a late result after abort is rejected even if the dependency ignored the signal', async () => {
  const { api, calls } = await fixture();
  const before = new AbortController(); before.abort();
  await assert.rejects(api.suggestDirectKeyframes(paragraph, 1, before.signal), { name: 'AbortError' });
  assert.equal(calls.context, 0);
  const after = new AbortController();
  let resolveModel;
  const pending = api.suggestDirectKeyframes(paragraph, 1, after.signal, {
    requestModel: () => new Promise(resolve => { resolveModel = resolve; }),
  });
  after.abort(); resolveModel(JSON.stringify([frame()]));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.posts.length, 0);
});
