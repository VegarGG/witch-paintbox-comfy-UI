import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultComfySettings, bindComfyWorkflow } from '../dist/comfy-workflow.js';
import { defaultImageSettings } from '../dist/image-settings.js';
import { imageSettingsView } from '../dist/image-view.js';
import { buildComfyConfigDraft, comfySettingsView, comfyTaskView, ComfyConfigPanel } from '../dist/comfy-config.js';
import { listComfyTasks, forgetComfyTask } from '../dist/comfyui.js';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../dist/image-bytes.js';

// Local fixtures and minimal fake nodes only; no browser/TT/Comfy server or real generation.
function fixture(poisonKey = false) {
  const settings = defaultImageSettings('comfyui');
  settings.comfy = defaultComfySettings();
  // Deliberately invalid credentials are injected only for non-disclosure/rejection tests.
  if (poisonKey) settings.connection.key = 'PRIVATE_API_KEY_MUST_NOT_RENDER';
  settings.positive = '窗边的猫说 "你好"。\nC:\\paint';
  settings.negative = '模糊，水印';
  return settings;
}
function draft(settings) {
  return { url: settings.comfy.url, parameters: structuredClone(settings.comfy.parameters),
    loaders: [], positive: settings.positive, negative: settings.negative,
    workflowJson: JSON.stringify(settings.comfy.workflow), bindingsJson: JSON.stringify(settings.comfy.bindings), approved: false };
}

test('Comfy tab is reachable and legacy views still render their original controls', () => {
  const state = { connectionName: '', artistName: '', connectionSaved: false, refreshing: false, moreOpen: false };
  const html = imageSettingsView(fixture(true), state);
  assert.match(html, /data-provider="comfyui"[^>]*aria-pressed="true"/);
  assert.match(html, /data-comfy-host/);
  assert.doesNotMatch(html, /PRIVATE_API_KEY|data-connection="key"|SMEA|cfgRescale/);
  const nai = imageSettingsView(defaultImageSettings(), state);
  assert.match(nai, /data-connection="key"/);
  assert.match(nai, /SMEA/);
});

test('Comfy fields contain exact supported parameters, both prompts, loaders and safety copy', () => {
  const html = comfySettingsView(fixture(true));
  for (const key of ['width', 'height', 'seed', 'steps', 'cfg', 'shift', 'sampler', 'scheduler']) assert.match(html, new RegExp(`data-comfy-parameter="${key}"`));
  for (const text of ['正面提示词', '负面提示词', '仅 GET', '不等于', 'API JSON', '绑定 JSON', '明确批准', '512×640', '0 是固定']) assert.ok(html.includes(text), text);
  for (const file of ['Dirty-MossV2-CONVROT8.safetensors', 'qwen3.5_9b_w4a8_gptq.safetensors', 'flux2-vae_small.safetensors']) assert.ok(html.includes(file));
  assert.doesNotMatch(html, /PRIVATE_API_KEY|data-connection="key"|SMEA|cfgRescale|AI 动态画幅|data-action="refresh-models"/);
  assert.match(html, /&quot;你好&quot;/);
});

test('draft values, seed zero and explicit loader filenames really reach bound workflow', () => {
  const base = fixture(), input = draft(base);
  Object.assign(input.parameters, { width: 640, height: 512, steps: 31, cfg: 3.5, shift: 6, sampler: 'euler', scheduler: 'normal', seed: 0 });
  input.loaders = [{ nodeId: '1', input: 'unet_name', value: 'hand-entered.safetensors' }];
  const saved = buildComfyConfigDraft(base, input);
  const graph = bindComfyWorkflow(saved.comfy, saved.positive, saved.negative);
  for (const [key, value] of Object.entries(input.parameters)) {
    const b = saved.comfy.bindings[key]; assert.equal(graph[b.nodeId].inputs[b.input], value, key);
  }
  assert.equal(graph['1'].inputs.unet_name, 'hand-entered.safetensors');
  assert.equal(graph['4'].inputs.text, base.positive);
  assert.equal(graph['5'].inputs.text, base.negative);
  assert.equal(base.comfy.workflow['1'].inputs.unet_name, 'Dirty-MossV2-CONVROT8.safetensors');
});

test('advanced template replacement requires explicit approval after finite validation', () => {
  const base = fixture(), input = draft(base), workflow = JSON.parse(input.workflowJson);
  assert.doesNotThrow(() => buildComfyConfigDraft(base, input), 'unchanged defaults must not need template approval');
  workflow['10'].inputs.filename_prefix = 'approved/new-prefix'; input.workflowJson = JSON.stringify(workflow);
  assert.throws(() => buildComfyConfigDraft(base, input), /批准/);
  assert.equal(buildComfyConfigDraft(base, { ...input, approved: true }).comfy.workflow['10'].inputs.filename_prefix, 'approved/new-prefix');
  for (const bad of [{ nodes: [], links: [] }, { ...workflow, '11': { class_type: 'TextGenerate', inputs: { text: 'not allowed' } } }]) {
    assert.throws(() => buildComfyConfigDraft(base, { ...input, workflowJson: JSON.stringify(bad), approved: true }));
  }
  assert.throws(() => buildComfyConfigDraft(base, { ...draft(base), bindingsJson: '{}' , approved: true }));
  assert.throws(() => buildComfyConfigDraft(base, { ...draft(base), url: 'https://example.com' }));
  assert.throws(() => buildComfyConfigDraft(base, { ...draft(base), loaders: [{ nodeId: '6', input: 'batch_size', value: '2' }] }));
  assert.throws(() => buildComfyConfigDraft(base, { ...draft(base), parameters: { ...input.parameters, seed: -1 } }));
});

function receipt(overrides = {}) {
  return { taskId: 'local-task-1', promptId: 'server-task-1', url: 'http://127.0.0.1:8188', state: 'unknown', mayContinue: true, persisted: false, ...overrides };
}
test('uncertain task copy exposes ids, may-continue and page-only without inventing prompt/history', () => {
  const html = comfyTaskView([receipt(), receipt({ taskId: 'no-id', promptId: null, persisted: true })]);
  for (const text of ['local-task-1', 'server-task-1', '服务端可能继续', 'page-only', '仅恢复查询', '清除本地记录', '不写聊天历史']) assert.ok(html.includes(text), text);
  assert.match(html, /data-comfy-task="no-id"[^>]*disabled/);
  assert.doesNotMatch(html, /data-comfy-prompt|interrupt|重新提交/);
  assert.match(comfyTaskView([receipt({ taskId: '<script>' })]), /&lt;script&gt;/);
});

test('minimal fake mount owns lifecycle without network, model loading or implicit actions', () => {
  let html = '', listeners = [], aborted = false;
  const host = { set innerHTML(value) { html = value; }, get innerHTML() { return html; },
    addEventListener(name, callback, { signal }) { listeners.push([name, callback]); signal.addEventListener('abort', () => { aborted = true; }); },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  const panel = new ComfyConfigPanel(fixture(), { onSaved() {}, onRecovered() {} });
  panel.mount(host);
  assert.match(html, /data-comfy-action="check"/);
  assert.ok(listeners.some(([name]) => name === 'click'));
  assert.equal(panel.hasPendingWrites, false);
  panel.destroy();
  assert.equal(aborted, true);
});

function fakeDom(t, settings = fixture(), initialTasks = []) {
  class FakeElement {
    constructor(value = '', dataset = {}) { this.value = value; this.dataset = dataset; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.innerHTML = ''; this.classList = { toggle() {} }; }
    closest() { return this; }
    checkValidity() { return true; }
    reportValidity() { return true; }
  }
  class FakeInput extends FakeElement {}
  class FakeTextarea extends FakeElement {}
  const local = new Map(), session = new Map([['witch-paintbox:comfy-tasks:v1', JSON.stringify(initialTasks)]]);
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  let confirmed = false, confirmations = [];
  const replacements = { Element: FakeElement, HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextarea,
    sessionStorage: storage(session), window: { localStorage: storage(local), dispatchEvent() {}, confirm(message) { confirmations.push(message); return confirmed; } } };
  for (const [key, value] of Object.entries(replacements)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const fields = new Map(), parameters = Object.entries(settings.comfy.parameters).map(([key, value]) => new FakeInput(String(value), { comfyParameter: key }));
  const loaders = Object.entries(settings.comfy.workflow).flatMap(([nodeId, node]) => {
    const key = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name' }[node.class_type];
    return key ? [new FakeInput(node.inputs[key], { comfyLoaderNode: nodeId, comfyLoaderInput: key })] : [];
  });
  fields.set('[data-comfy-url]', new FakeInput(settings.comfy.url));
  fields.set('[data-comfy-positive]', new FakeTextarea(settings.positive));
  fields.set('[data-comfy-negative]', new FakeTextarea(settings.negative));
  fields.set('[data-comfy-json="workflow"]', new FakeTextarea(JSON.stringify(settings.comfy.workflow), { comfyJson: 'workflow' }));
  fields.set('[data-comfy-json="bindings"]', new FakeTextarea(JSON.stringify(settings.comfy.bindings), { comfyJson: 'bindings' }));
  fields.set('[data-comfy-approved]', new FakeInput());
  for (const area of ['save', 'check', 'task']) fields.set(`[data-comfy-${area}-status]`, new FakeElement());
  for (const name of ['diffusionModels', 'textEncoders', 'vaes']) fields.set(`#comfy-${name}`, new FakeElement());
  fields.set('[data-comfy-tasks]', new FakeElement());
  const buttons = ['save', 'check', 'cancel'].map(comfyAction => new FakeInput('', { comfyAction }));
  const host = { innerHTML: '', addEventListener() {},
    querySelector: selector => fields.get(selector) ?? null,
    querySelectorAll: selector => selector === '[data-comfy-parameter]' ? parameters : selector === '[data-comfy-loader-node]' ? loaders : [...fields.values(), ...parameters, ...loaders, ...buttons] };
  const recovered = [], saved = [], panel = new ComfyConfigPanel(settings, { onSaved: value => saved.push(value), onRecovered: result => recovered.push(result) });
  panel.mount(host);
  t.after(() => { panel.destroy(); for (const task of listComfyTasks()) forgetComfyTask(task.taskId); });
  return { panel, fields, parameters, loaders, local, recovered, saved, host, confirmations, FakeInput,
    confirm(value) { confirmed = value; },
    click(action, id) { return panel.click({ target: new FakeInput('', { comfyAction: action, comfyTask: id }) }); } };
}
function nodeSchema(settings) {
  const outputs = { UNETLoader: 'MODEL', CLIPLoader: 'CLIP', VAELoader: 'VAE', CLIPTextEncode: 'CONDITIONING', EmptyFlux2LatentImage: 'LATENT', ModelSamplingAuraFlow: 'MODEL', KSampler: 'LATENT', VAEDecode: 'IMAGE', SaveImage: 'IMAGE' };
  const nodes = {};
  for (const node of Object.values(settings.comfy.workflow)) {
    const required = {};
    for (const [key, value] of Object.entries(node.inputs)) {
      required[key] = Array.isArray(value) ? [outputs[settings.comfy.workflow[value[0]].class_type]]
        : typeof value === 'number' ? [Number.isInteger(value) ? 'INT' : 'FLOAT']
        : key === 'text' || key === 'filename_prefix' ? ['STRING'] : [[value, 'discovered-file.safetensors']];
    }
    nodes[node.class_type] = { input: { required }, output: [outputs[node.class_type]] };
  }
  return nodes;
}

test('fake form saves via existing settings storage, blocks dirty generation and resets template approval', async t => {
  const f = fakeDom(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('save must not fetch'); });
  f.fields.get('[data-comfy-positive]').value = 'saved exact prompt';
  f.panel.edit({ target: f.fields.get('[data-comfy-positive]') });
  assert.throws(() => f.panel.assertSaved(), /未保存/);
  await f.click('save');
  assert.equal(f.saved.length, 1, f.fields.get('[data-comfy-save-status]').textContent);
  assert.equal(f.saved[0].positive, 'saved exact prompt');
  const all = JSON.parse(f.local.get('witch-paintbox:image-settings:v1'));
  assert.equal(all.profiles.comfyui.positive, 'saved exact prompt');
  assert.equal(all.profiles.comfyui.comfy.parameters.seed, 0);
  assert.doesNotThrow(() => f.panel.assertSaved());
  f.fields.get('[data-comfy-approved]').checked = true;
  f.panel.edit({ target: f.fields.get('[data-comfy-json="workflow"]') });
  assert.equal(f.fields.get('[data-comfy-approved]').checked, false);
});

test('fake form refuses poisoned cloud credentials without saving or hiding the rejection', async t => {
  const f = fakeDom(t, fixture(true));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('rejected save must not fetch'); });
  f.panel.edit({ target: f.fields.get('[data-comfy-positive]') });
  await f.click('save');
  assert.equal(f.saved.length, 0);
  assert.equal(f.local.size, 0);
  assert.match(f.fields.get('[data-comfy-save-status]').textContent, /生图配置格式无效/);
  assert.throws(() => f.panel.assertSaved(), /未保存/);
});

test('fake form checks GET-only, updates enums without replacing filenames, and checks actual sampler value', async t => {
  const settings = fixture(), f = fakeDom(t, settings), calls = [], schema = nodeSchema(settings);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ path: new URL(url).pathname, ...options });
    if (new URL(url).pathname === '/system_stats') return Response.json({ system: { comfyui_version: '0.45.5' }, devices: [] });
    if (new URL(url).pathname === '/object_info') return Response.json(schema);
    throw new Error('unexpected request');
  });
  await f.click('check');
  assert.deepEqual(calls.map(call => call.path), ['/system_stats', '/object_info']);
  assert.ok(calls.every(call => call.method === 'GET' && call.body === undefined));
  assert.match(f.fields.get('#comfy-diffusionModels').innerHTML, /discovered-file/);
  assert.equal(f.loaders[0].value, settings.comfy.workflow['1'].inputs.unet_name);
  assert.match(f.fields.get('[data-comfy-check-status]').textContent, /枚举就绪.*不等于/);
  f.parameters.find(field => field.dataset.comfyParameter === 'sampler').value = 'unsupported_sampler';
  await f.click('check');
  assert.match(f.fields.get('[data-comfy-check-status]').textContent, /尚未准备/);
  assert.equal(f.saved.length, 0);
});

test('fake file import rejects UI graphs, resets approval and does not save or execute imported JSON', async t => {
  const f = fakeDom(t), input = new f.FakeInput('', { comfyFile: 'workflow' });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('file import must not fetch'); });
  input.files = [{ size: 20, text: async () => '{"nodes":[],"links":[]}' }];
  const before = f.fields.get('[data-comfy-json="workflow"]').value;
  await f.panel.importFile({ target: input });
  assert.match(f.fields.get('[data-comfy-save-status]').textContent, /不接受 UI 图/);
  assert.equal(f.fields.get('[data-comfy-json="workflow"]').value, before);
  f.fields.get('[data-comfy-approved]').checked = true;
  input.files = [{ size: before.length, text: async () => before }];
  await f.panel.importFile({ target: input });
  assert.equal(f.fields.get('[data-comfy-approved]').checked, false);
  assert.equal(f.saved.length, 0);
});

function fullReceipt(overrides = {}) {
  return { ...receipt(), clientId: 'client-1', outputNodeIds: ['10'], parameters: { ...defaultComfySettings().parameters, model: 'Dirty-MossV2-CONVROT8.safetensors' }, submittedAt: 1, ...overrides };
}
function png() {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('fake recovery explicitly queries receipt only, returns display-only result and never posts', async t => {
  const task = fullReceipt(), f = fakeDom(t, fixture(), [task]), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = new URL(url).pathname; calls.push({ path, ...options });
    if (path === `/history/${task.promptId}`) return Response.json({ [task.promptId]: { status: { completed: true, status_str: 'success' }, outputs: { '10': { images: [{ filename: 'recovered.png', subfolder: '', type: 'output' }] } } } });
    if (path === '/view') return new Response(png(), { headers: { 'content-type': 'image/png' } });
    throw new Error('unexpected request');
  });
  await f.click('resume', task.taskId);
  assert.deepEqual(calls.map(call => call.path), [`/history/${task.promptId}`, '/view']);
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
  assert.equal(f.recovered.length, 1);
  assert.equal(f.saved.length, 0);
  assert.equal(f.recovered[0].positive, undefined);
  assert.match(f.fields.get('[data-comfy-task-status]').textContent, /不写聊天历史/);
});

test('fake task forget is gated by explicit confirmation and makes no server request', async t => {
  const task = fullReceipt({ taskId: 'forget-me', promptId: null }), f = fakeDom(t, fixture(), [task]);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('forget must not fetch'); });
  await f.click('forget', task.taskId);
  assert.ok(listComfyTasks().some(row => row.taskId === task.taskId));
  assert.match(f.confirmations[0], /服务端可能继续/);
  f.confirm(true);
  await f.click('forget', task.taskId);
  assert.ok(!listComfyTasks().some(row => row.taskId === task.taskId));
  assert.match(f.fields.get('[data-comfy-task-status]').textContent, /没有向服务端发送/);
});
