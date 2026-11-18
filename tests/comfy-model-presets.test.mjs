import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { bindComfyWorkflow, defaultComfySettings, validateComfySettings } from '../dist/comfy-workflow.js';
import { applyComfyModelPreset, COMFY_MODEL_PRESETS } from '../dist/comfy-model-presets.js';

const pairs = {
  anime: ['moss_image_sft_int8_convrot.safetensors', 'qwen3.5_9b_w4a8_gptq.safetensors'],
  realistic: ['Dirty-MossV2-CONVROT8.safetensors', 'qwen3.5_9b_uncensored_int8_convrot.safetensors'],
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function renumber(settings) {
  const id = oldId => `active_${oldId}`;
  settings.workflow = Object.fromEntries(Object.entries(settings.workflow).reverse().map(([key, node]) => [id(key), {
    ...node,
    inputs: Object.fromEntries(Object.entries(node.inputs).map(([input, value]) => [input,
      Array.isArray(value) ? [id(value[0]), value[1]] : value])),
  }]));
  for (const [key, value] of Object.entries(settings.bindings)) {
    settings.bindings[key] = key === 'outputNodeIds' ? value.map(id) : { ...value, nodeId: id(value.nodeId) };
  }
  return settings;
}

test('exact anime and realistic model pairs are exposed as 20-step presets', () => {
  assert.deepEqual(Object.keys(COMFY_MODEL_PRESETS).sort(), ['anime', 'realistic']);
  for (const [preset, pair] of Object.entries(pairs)) {
    const { label, unetName, clipName, steps } = COMFY_MODEL_PRESETS[preset];
    assert.ok(label.trim());
    assert.deepEqual([unetName, clipName, steps], [...pair, 20]);
  }
  assert.notEqual(COMFY_MODEL_PRESETS.anime.label, COMFY_MODEL_PRESETS.realistic.label);
});

test('explicit switching changes only the active model names and steps in a detached copy', () => {
  const original = defaultComfySettings();
  original.url = 'http://localhost:8688/custom/';
  Object.assign(original.parameters, { width: 768, height: 896, steps: 31, seed: 42, cfg: 4, shift: 6, sampler: 'euler', scheduler: 'normal' });
  original.workflow['1'].inputs.weight_dtype = 'fp8_e4m3fn';
  original.workflow['2'].inputs.device = 'cpu';
  original.workflow['3'].inputs.vae_name = 'local-custom-vae.safetensors';
  original.workflow['4'].inputs.text = 'authored template text';
  original.workflow['4']._meta = { title: 'authored label' };
  original.workflow['8'].inputs.steps = 41;
  original.workflow['10'].inputs.filename_prefix = 'user-custom';
  const before = structuredClone(original);
  let current = deepFreeze(original);
  for (const preset of ['realistic', 'anime', 'realistic']) {
    const applied = applyComfyModelPreset(current, preset);
    const expected = structuredClone(before);
    expected.parameters.steps = expected.workflow['8'].inputs.steps = 20;
    [expected.workflow['1'].inputs.unet_name, expected.workflow['2'].inputs.clip_name] = pairs[preset];
    assert.deepEqual(applied, expected);
    assert.notEqual(applied.workflow['3'], current.workflow['3']);
    assert.notEqual(applied.workflow['4'].inputs.clip, current.workflow['4'].inputs.clip);
    assert.notEqual(applied.bindings.outputNodeIds, current.bindings.outputNodeIds);
    const compiled = bindComfyWorkflow(applied, 'synthetic scene', 'synthetic negative');
    assert.deepEqual([compiled['1'].inputs.unet_name, compiled['2'].inputs.clip_name, compiled['8'].inputs.steps], [...pairs[preset], 20]);
    for (const [key, value] of Object.entries(expected.parameters)) {
      const binding = expected.bindings[key];
      assert.equal(compiled[binding.nodeId].inputs[binding.input], value);
    }
    current = deepFreeze(applied);
  }
  assert.deepEqual(original, before);
});

test('selection follows renamed PreviewImage output dependencies and leaves unused native nodes alone', () => {
  const settings = renumber(defaultComfySettings());
  settings.workflow.active_10 = { class_type: 'PreviewImage', inputs: { images: ['active_9', 0] } };
  settings.workflow['1'] = { class_type: 'UNETLoader', inputs: { unet_name: 'unused-unet.safetensors' } };
  settings.workflow['2'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'unused-clip.safetensors', type: 'moss_image' } };
  settings.workflow['8'] = { class_type: 'KSampler', inputs: { steps: 77 } };
  delete settings.bindings.negative;
  const applied = applyComfyModelPreset(settings, 'anime');
  for (const id of ['1', '2', '8']) assert.deepEqual(applied.workflow[id], settings.workflow[id]);
  assert.deepEqual(applied.bindings, settings.bindings);
  const graph = bindComfyWorkflow(applied, 'synthetic scene', '');
  assert.equal(graph.active_1.inputs.unet_name, pairs.anime[0]);
  assert.equal(graph.active_2.inputs.clip_name, pairs.anime[1]);
  assert.equal(graph.active_8.inputs.steps, 20);
  assert.deepEqual(Object.keys(graph).sort(), Object.keys(settings.workflow).filter(id => id.startsWith('active_')).sort());
});

test('a missing steps binding is repaired only in the explicit preset result, and actual sampler uses 20', () => {
  const settings = renumber(defaultComfySettings());
  settings.parameters.steps = 25;
  settings.workflow.active_8.inputs.steps = 51;
  delete settings.bindings.steps;
  assert.throws(() => validateComfySettings(settings), /steps/);
  for (const preset of Object.keys(pairs)) {
    const applied = applyComfyModelPreset(deepFreeze(settings), preset);
    assert.deepEqual(applied.bindings, { ...settings.bindings, steps: { nodeId: 'active_8', input: 'steps' } });
    assert.equal(applied.parameters.steps, 20);
    assert.equal(applied.workflow.active_8.inputs.steps, 20);
    assert.equal(bindComfyWorkflow(applied, 'synthetic scene', '').active_8.inputs.steps, 20);
    assert.equal(settings.bindings.steps, undefined);
    assert.equal(settings.workflow.active_8.inputs.steps, 51);
  }
});

test('unknown presets, malformed bindings and unsupported dataflow fail instead of rewriting another graph', () => {
  const settings = defaultComfySettings();
  for (const preset of ['saved', 'nvfp4', '__proto__', 'constructor']) {
    assert.throws(() => applyComfyModelPreset(settings, preset), { fault: 'setup' });
  }
  const breakGraph = [
    s => { s.bindings.steps.input = 'cfg'; },
    s => { s.workflow['11'] = { class_type: 'TextGenerate', inputs: {} }; },
    s => { s.workflow['7'].inputs.model = ['1', 1]; },
    s => { s.workflow['9'].inputs.samples = ['8', 1]; },
    s => { s.workflow['9'].inputs.vae = ['3', 1]; },
    s => { s.workflow['5'].inputs.clip = ['2', 1]; },
    s => { s.workflow['2'].inputs.type = 'qwen_image'; },
    s => { delete s.workflow['1'].inputs.unet_name; },
    s => { delete s.bindings.steps; delete s.workflow['8'].inputs.steps; },
    s => {
      s.workflow['11'] = structuredClone(s.workflow['8']);
      s.workflow['11'].inputs.latent_image = ['8', 0];
      s.workflow['9'].inputs.samples = ['11', 0];
    },
  ];
  for (const mutate of breakGraph) {
    const broken = structuredClone(settings);
    mutate(broken);
    assert.throws(() => applyComfyModelPreset(deepFreeze(broken), 'realistic'), { fault: 'setup' });
  }
});

test('no preset selected keeps the saved model pair and non-default steps', () => {
  const saved = defaultComfySettings();
  saved.workflow['1'].inputs.unet_name = 'my-saved-unet.safetensors';
  saved.workflow['2'].inputs.clip_name = 'my-saved-clip.safetensors';
  saved.parameters.steps = saved.workflow['8'].inputs.steps = 25;
  assert.deepEqual(validateComfySettings(saved), saved);
  const graph = bindComfyWorkflow(saved, 'synthetic scene', '');
  assert.equal(graph['1'].inputs.unet_name, 'my-saved-unet.safetensors');
  assert.equal(graph['2'].inputs.clip_name, 'my-saved-clip.safetensors');
  assert.equal(graph['8'].inputs.steps, 25);
});

test('factory and companion graphs keep the original model pair and agree on 20 steps', async () => {
  const read = async file => JSON.parse(await readFile(new URL(`../workflows/dirty-moss-v2.${file}.json`, import.meta.url), 'utf8'));
  const settings = defaultComfySettings();
  const [api, bindings, ui] = await Promise.all(['api', 'bindings', 'ui'].map(read));
  assert.deepEqual(settings.workflow, api);
  assert.deepEqual(settings.bindings, bindings);
  assert.equal(api['1'].inputs.unet_name, 'Dirty-MossV2-CONVROT8.safetensors');
  assert.equal(api['2'].inputs.clip_name, 'qwen3.5_9b_w4a8_gptq.safetensors');
  assert.equal(api['3'].inputs.vae_name, 'flux2-vae_small.safetensors');
  const node = ui.nodes.find(node => node.type === 'KSampler');
  assert.deepEqual(node.widgets_values, [0, 'fixed', 20, 2.5, 'er_sde', 'simple', 1]);
  assert.equal(node.widgets_values_named.steps, 20);
  assert.equal(settings.parameters.steps, 20);
  assert.equal(api['8'].inputs.steps, 20);
  assert.equal(bindComfyWorkflow(settings, 'synthetic scene', '')['8'].inputs.steps, 20);
});
