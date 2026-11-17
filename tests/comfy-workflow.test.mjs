import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { defaultComfySettings, validateComfySettings, bindComfyWorkflow, validateComfyUrl } from '../dist/comfy-workflow.js';

// These are local fixture strings, never user chat or model-generated workflow data.
test('Comfy defaults use a loopback service and an explicit single-image MOSS graph', () => {
  const settings = defaultComfySettings();
  assert.equal(settings.url, 'http://127.0.0.1:8188');
  const graph = settings.workflow;
  const nodes = Object.values(graph);
  assert.ok(nodes.some(node => node.class_type === 'UNETLoader' && node.inputs.unet_name === 'Dirty-MossV2-CONVROT8.safetensors'));
  assert.equal(nodes.find(node => node.class_type === 'CLIPLoader').inputs.type, 'moss_image');
  assert.equal(nodes.find(node => node.class_type === 'EmptyFlux2LatentImage').inputs.batch_size, 1);
  assert.equal(settings.parameters.steps, 25);
  assert.equal(settings.parameters.cfg, 2.5);
  assert.equal(settings.parameters.shift, 5);
  assert.equal(settings.parameters.sampler, 'er_sde');
  assert.equal(settings.parameters.scheduler, 'simple');
});

test('binding preserves exact quoted, multiline, backslash and Chinese prompts without mutating the template', () => {
  const settings = defaultComfySettings();
  const original = JSON.stringify(settings.workflow);
  const positive = '窗边的猫说 "你好"。\n路径 C:\\paint\\猫\n${notCode}';
  const negative = '低清晰度，水印\\"\n多余人物';
  const graph = bindComfyWorkflow(settings, positive, negative);
  const { positive: p, negative: n, seed, width, height } = settings.bindings;
  assert.equal(graph[p.nodeId].inputs[p.input], positive);
  assert.equal(graph[n.nodeId].inputs[n.input], negative);
  for (const b of [seed, width, height]) assert.equal(typeof graph[b.nodeId].inputs[b.input], 'number');
  assert.equal(JSON.stringify(settings.workflow), original);
  assert.deepEqual(Object.keys(graph), Object.keys(settings.workflow));
});

test('Comfy URLs reject remote, credentialed, query, fragment and non-HTTP addresses', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1.evil.invalid', 'http://user:pass@localhost:8188',
    'file:///tmp/image', 'http://localhost:8188?token=x', 'http://localhost:8188/#fragment', 'http://0.0.0.0:8188']) {
    assert.throws(() => validateComfyUrl(url));
  }
  for (const url of ['http://127.0.0.1:8188', 'http://localhost:8188/', 'http://[::1]:8188']) assert.ok(validateComfyUrl(url));
});

test('workflow settings reject UI graphs, dangling links, prototype fields and unsafe bindings', () => {
  const settings = defaultComfySettings();
  assert.throws(() => validateComfySettings({ ...settings, workflow: { nodes: [], links: [], version: 0.4 } }));
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const broken = structuredClone(settings);
    broken.bindings.positive.input = key;
    assert.throws(() => validateComfySettings(broken));
  }
  const dangling = structuredClone(settings);
  Object.values(dangling.workflow).find(n => n.class_type === 'SaveImage').inputs.images = ['missing-node', 0];
  assert.throws(() => validateComfySettings(dangling));
  const bad = structuredClone(settings);
  bad.bindings.width = bad.bindings.positive;
  assert.throws(() => validateComfySettings(bad));
});

test('the small MOSS contract rejects text-generation/custom nodes and multiple output targets', () => {
  const settings = defaultComfySettings();
  const custom = structuredClone(settings);
  custom.workflow['11'] = { class_type: 'TextGenerate', inputs: { text: 'never invoke a helper model' } };
  assert.throws(() => validateComfySettings(custom));
  const multi = structuredClone(settings);
  multi.workflow['11'] = structuredClone(multi.workflow['10']);
  multi.bindings.outputNodeIds.push('11');
  assert.throws(() => validateComfySettings(multi));
});

test('request dimensions, batch and numeric parameters fail validation rather than being coerced', () => {
  const settings = defaultComfySettings();
  for (const [key, value] of [['width', 0], ['width', '512'], ['width', 513], ['height', Infinity],
    ['steps', 0], ['cfg', NaN], ['seed', -1], ['seed', Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => validateComfySettings({ ...settings, parameters: { ...settings.parameters, [key]: value } }));
  }
  const multi = structuredClone(settings);
  Object.values(multi.workflow).find(n => n.class_type === 'EmptyFlux2LatentImage').inputs.batch_size = 2;
  assert.throws(() => validateComfySettings(multi));
});

test('delivered API workflow and bindings exactly match the built-in approved template', async () => {
  const read = async name => JSON.parse(await readFile(new URL(`../workflows/${name}`, import.meta.url), 'utf8'));
  const settings = defaultComfySettings();
  assert.deepEqual(await read('dirty-moss-v2.api.json'), settings.workflow);
  assert.deepEqual(await read('dirty-moss-v2.bindings.json'), settings.bindings);
});

test('editable UI graph has the same real nodes, typed connections and widget values as the API graph', async () => {
  const ui = JSON.parse(await readFile(new URL('../workflows/dirty-moss-v2.ui.json', import.meta.url), 'utf8'));
  const api = defaultComfySettings().workflow;
  assert.equal(ui.version, 0.4);
  assert.equal(ui.definitions, undefined, 'no subgraph export dependency');
  assert.equal(ui.nodes.length, Object.keys(api).length);
  // Real LiteGraph widget order and socket types, independently specified rather than mirrored metadata.
  const widgets = { UNETLoader: ['unet_name', 'weight_dtype'], CLIPLoader: ['clip_name', 'type', 'device'],
    VAELoader: ['vae_name'], CLIPTextEncode: ['text'], EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
    ModelSamplingAuraFlow: ['shift'], KSampler: ['seed', '$fixed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
    VAEDecode: [], SaveImage: ['filename_prefix'] };
  const ports = { UNETLoader: [], CLIPLoader: [], VAELoader: [], CLIPTextEncode: ['clip'], EmptyFlux2LatentImage: [],
    ModelSamplingAuraFlow: ['model'], KSampler: ['model', 'positive', 'negative', 'latent_image'], VAEDecode: ['samples', 'vae'], SaveImage: ['images'] };
  const outputs = { UNETLoader: ['MODEL'], CLIPLoader: ['CLIP'], VAELoader: ['VAE'], CLIPTextEncode: ['CONDITIONING'],
    EmptyFlux2LatentImage: ['LATENT'], ModelSamplingAuraFlow: ['MODEL'], KSampler: ['LATENT'], VAEDecode: ['IMAGE'], SaveImage: ['IMAGE'] };
  function verify(graph) {
    assert.equal(graph.links.length, Object.values(api).flatMap(n => Object.values(n.inputs)).filter(Array.isArray).length);
    for (const [id, node] of Object.entries(api)) {
      const view = graph.nodes.find(item => String(item.id) === id);
      assert.equal(view.type, node.class_type);
      assert.deepEqual(view.widgets_values, widgets[node.class_type].map(key => key === '$fixed' ? 'fixed' : node.inputs[key]));
      assert.deepEqual(view.inputs.map(item => item.name), ports[node.class_type]);
      assert.deepEqual(view.outputs.map(item => item.type), outputs[node.class_type]);
      for (const [input, value] of Object.entries(node.inputs)) {
        if (!Array.isArray(value)) continue;
        const index = view.inputs.findIndex(item => item.name === input), slot = view.inputs[index];
        const link = graph.links.find(item => item[0] === slot.link);
        const type = outputs[api[value[0]].class_type][value[1]];
        assert.deepEqual(link, [slot.link, Number(value[0]), value[1], Number(id), index, type]);
        assert.equal(slot.type, type);
      }
      view.outputs.forEach((output, index) => assert.deepEqual(output.links, graph.links.filter(link => String(link[1]) === id && link[2] === index).map(link => link[0])));
    }
  }
  verify(ui);
  for (const mutate of [
    graph => { const n = graph.nodes.find(n => n.id === 6); [n.widgets_values[0], n.widgets_values[1]] = [n.widgets_values[1], n.widgets_values[0]]; },
    graph => { graph.nodes.find(n => n.id === 8).widgets_values.splice(1, 1); },
    graph => { const n = graph.nodes.find(n => n.id === 8); [n.widgets_values[5], n.widgets_values[6]] = [n.widgets_values[6], n.widgets_values[5]]; },
    graph => { graph.links.forEach(link => { link[5] = 'INVALID'; }); },
  ]) { const broken = structuredClone(ui); mutate(broken); assert.throws(() => verify(broken)); }
});

test('semantic bindings cannot overwrite loaders, batch size, or disconnected prompt nodes', () => {
  const settings = defaultComfySettings();
  for (const [key, binding] of [['seed', { nodeId: '6', input: 'batch_size' }], ['positive', { nodeId: '1', input: 'unet_name' }]]) {
    const broken = structuredClone(settings); broken.parameters.seed = 2; broken.bindings[key] = binding;
    assert.throws(() => bindComfyWorkflow(broken, 'do not overwrite loaders', ''));
  }
  const offline = structuredClone(settings);
  offline.workflow['11'] = { class_type: 'CLIPTextEncode', inputs: { text: 'offline', clip: ['2', 0] } };
  offline.bindings.positive = { nodeId: '11', input: 'text' };
  assert.throws(() => validateComfySettings(offline));
  const swapped = structuredClone(settings);
  [swapped.bindings.positive, swapped.bindings.negative] = [swapped.bindings.negative, swapped.bindings.positive];
  assert.throws(() => validateComfySettings(swapped));
});

test('unselected output branches are pruned before submission, not merely ignored after execution', () => {
  const settings = defaultComfySettings();
  settings.workflow['11'] = structuredClone(settings.workflow['10']);
  settings.workflow['11'].inputs.filename_prefix = 'must-not-run';
  const graph = bindComfyWorkflow(settings, 'scene', '');
  assert.equal(Object.hasOwn(graph, '11'), false);
  assert.equal(Object.hasOwn(settings.workflow, '11'), true);
});

test('all advertised render parameters have a real binding and non-default values reach the output chain', () => {
  const settings = defaultComfySettings();
  Object.assign(settings.parameters, { width: 896, height: 1152, seed: 1234, steps: 29, cfg: 3, shift: 6 });
  const graph = bindComfyWorkflow(settings, 'new positive', 'new negative');
  for (const [key, value] of Object.entries(settings.parameters)) {
    const binding = settings.bindings[key];
    assert.equal(graph[binding.nodeId].inputs[binding.input], value);
    const incomplete = structuredClone(settings); delete incomplete.bindings[key];
    assert.throws(() => validateComfySettings(incomplete), `missing ${key} must not silently use an old value`);
  }
});

test('the approved single-stage graph rejects a second sampler hidden downstream of the bound controls', () => {
  const settings = defaultComfySettings(); settings.parameters.steps = 2;
  settings.workflow['11'] = structuredClone(settings.workflow['8']);
  settings.workflow['11'].inputs.latent_image = ['8', 0]; settings.workflow['11'].inputs.steps = 100;
  settings.workflow['9'].inputs.samples = ['11', 0];
  assert.throws(() => validateComfySettings(settings));
  assert.throws(() => bindComfyWorkflow(settings, 'scene', ''));
});

test('unknown workflow inputs cannot be supplied through the finite parameter binding API', () => {
  const settings = defaultComfySettings();
  settings.bindings.hiddenExecutableInput = { nodeId: '1', input: 'anything' };
  assert.throws(() => validateComfySettings(settings));
});
