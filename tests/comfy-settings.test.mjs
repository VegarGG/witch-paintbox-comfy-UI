import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as settings from '../dist/image-settings.js';
import { defaultComfySettings } from '../dist/comfy-workflow.js';
import { defaultModelSettings, validateAllModelSettings } from '../dist/model-settings.js';
import * as history from '../dist/image-history.js';
import { parseArchive, summarizeArchive } from '../dist/config-archive.js';
import { mergeArchive } from '../dist/config-merge.js';
import { defaultSettings } from '../dist/settings.js';

function all() { return settings.defaultAllImageSettings(); }
function model() { return validateAllModelSettings(defaultModelSettings()); }
function data() { return { image: all(), model: model(), preferences: defaultSettings(), anchors: [], sharedOutfits: [], worldbooks: [] }; }
function archive(payload = data()) { return { format: 'witch-paintbox-config', version: 2, kind: 'all', includesKeys: false, exportedAt: '2026-11-17T00:00:00Z', data: payload }; }

test('Comfy gets a credential-free isolated profile without changing legacy provider defaults', () => {
  const value = all();
  assert.equal(value.activeProvider, 'novelai');
  assert.deepEqual(settings.IMAGE_PROVIDERS, ['novelai', 'openai', 'gemini', 'grok', 'comfyui']);
  assert.deepEqual(value.profiles.comfyui.comfy, defaultComfySettings());
  assert.equal(value.profiles.comfyui.connection.key, '');
  assert.notEqual(value.profiles.novelai.comfy.workflow, value.profiles.comfyui.comfy.workflow);
  assert.equal(settings.isNaturalLanguageProvider('openai'), true);
  assert.equal(settings.isNaturalLanguageProvider('comfyui'), false, 'this predicate means no independent negative field');
});

test('four-provider and older two-provider v2 settings gain Comfy without touching active choice or secrets', () => {
  for (const kept of [['novelai', 'openai'], ['novelai', 'openai', 'gemini', 'grok']]) {
    const old = all(); old.activeProvider = 'openai'; old.profiles.openai.connection.key = 'test-only-existing-key';
    for (const name of Object.keys(old.profiles)) {
      delete old.profiles[name].comfy;
      if (!kept.includes(name)) delete old.profiles[name];
    }
    const before = JSON.stringify(old), migrated = settings.validateAllImageSettings(old);
    assert.equal(migrated.activeProvider, 'openai');
    assert.equal(migrated.profiles.openai.connection.key, 'test-only-existing-key');
    assert.deepEqual(migrated.profiles.comfyui.comfy, defaultComfySettings());
    assert.equal(JSON.stringify(old), before);
  }
});

test('Comfy permits real negative prompts but refuses cloud credentials and malformed workflow bindings', () => {
  const value = settings.defaultImageSettings('comfyui'); value.positive = '中文正文'; value.negative = '文字, 水印';
  assert.equal(settings.validateImageSettings(value).negative, value.negative);
  value.connection.key = 'test-only-wrong-profile';
  assert.throws(() => settings.validateImageSettings(value)); value.connection.key = '';
  value.comfy.bindings.seed = { nodeId: '6', input: 'batch_size' };
  assert.throws(() => settings.validateImageSettings(value));
  const cloud = settings.defaultImageSettings('openai'); cloud.negative = 'no';
  assert.throws(() => settings.validateImageSettings(cloud));
});

test('legacy model presets gain an empty Comfy preset, not automatic inherited text-generation instructions', () => {
  const old = model(); delete old.presets.comfyui;
  old.presets.openai.presetName = 'existing text preset';
  const before = JSON.stringify(old), next = validateAllModelSettings(old);
  assert.equal(next.presets.openai.presetName, 'existing text preset');
  assert.equal(next.presets.comfyui.presetName, ''); assert.deepEqual(next.presets.comfyui.head, []);
  assert.equal(JSON.stringify(old), before);
});

test('complete legacy archives migrate and new archives round trip Comfy graph, bindings and negative text', () => {
  const old = data(); delete old.image.profiles.comfyui; delete old.model.presets.comfyui;
  assert.deepEqual(parseArchive(JSON.stringify(archive(old))).data.image.profiles.comfyui.comfy, defaultComfySettings());
  const value = data(); value.image.activeProvider = 'comfyui'; value.image.profiles.comfyui.negative = '水印';
  value.image.profiles.comfyui.comfy.parameters.width = 896;
  const parsed = parseArchive(JSON.stringify(archive(value)));
  assert.deepEqual(parsed.data.image, value.image);
  assert.ok(summarizeArchive(parsed).some(row => /Comfy/.test(row.title) && /896/.test(row.detail)));
});

test('archive API and workflow/parameter imports keep the Comfy endpoint in the correct section', () => {
  const local = data(); local.image.profiles.comfyui.comfy.url = 'http://127.0.0.1:8999';
  local.image.profiles.comfyui.comfy.parameters.width = 768; // Existing skip mode preserves non-default local values, but fills blanks.
  const incoming = data(); incoming.image.profiles.comfyui.comfy.url = 'http://127.0.0.1:8888';
  incoming.image.profiles.comfyui.comfy.parameters.width = 896;
  const parameters = mergeArchive(archive(incoming), local, { parameters: 'overwrite' }).config;
  assert.equal(parameters.image.profiles.comfyui.comfy.url, 'http://127.0.0.1:8999');
  assert.equal(parameters.image.profiles.comfyui.comfy.parameters.width, 896);
  const api = mergeArchive(archive(incoming), local, { api: 'overwrite' }).config;
  assert.equal(api.image.profiles.comfyui.comfy.url, 'http://127.0.0.1:8888');
  assert.equal(api.image.profiles.comfyui.comfy.parameters.width, 768);
  assert.equal(local.image.profiles.comfyui.comfy.parameters.width, 768);
});

test('legacy partial worldbook archives with two or four providers remain importable', () => {
  for (const names of [['novelai', 'openai'], ['novelai', 'openai', 'gemini', 'grok']]) {
    const value = { ...archive(), kind: 'worldbooks', data: { worldbooks: [], attachments: Object.fromEntries(names.map(name => [name, []])) } };
    const parsed = parseArchive(JSON.stringify(value));
    assert.deepEqual(parsed.data.attachments.comfyui, []);
    assert.equal(Object.keys(parsed.data.attachments).length, 5);
  }
});

test('legacy archive overwrite does not reset an absent Comfy endpoint but an explicit new default does', () => {
  const local = data(); local.image.profiles.comfyui.comfy.url = 'http://127.0.0.1:8999';
  const old = data(); delete old.image.profiles.comfyui; delete old.model.presets.comfyui;
  const before = JSON.stringify(local.image.profiles.comfyui);
  const parsed = parseArchive(JSON.stringify(archive(old)));
  const merged = mergeArchive(parsed, local, { api: 'overwrite', parameters: 'overwrite', artists: 'overwrite' });
  assert.equal(JSON.stringify(merged.config.image.profiles.comfyui), before);
  assert.equal(summarizeArchive(parsed).some(row => /Comfy/.test(row.title)), false);
  const explicit = parseArchive(JSON.stringify(archive(data())));
  assert.equal(mergeArchive(explicit, local, { api: 'overwrite' }).config.image.profiles.comfyui.comfy.url, 'http://127.0.0.1:8188');
});

test('Comfy history retains finite rendering metadata and original blob, never connection or workflow', () => {
  assert.equal(typeof history.validateImageHistoryEntry, 'function');
  const blob = new Blob(['mock-image-bytes']), p = defaultComfySettings().parameters;
  const input = { id: 'test-history', markerKey: JSON.stringify(['card', 'chat', 'direct-v1', 'stable-id', 0, '', 'fingerprint']),
    blob, createdAt: 1, positive: '正文', negative: '水印', provider: 'comfyui',
    parameters: { ...p, model: 'Dirty-MossV2-CONVROT8.safetensors', url: 'http://bad.invalid', key: 'test-only-not-a-key', workflow: {} },
    connection: { key: 'test-only-not-a-key' }, receipt: { private: 'not kept' } };
  const next = history.validateImageHistoryEntry(input);
  assert.equal(next.blob, blob); assert.equal(next.scope, 'card'); assert.equal(next.negative, '水印');
  assert.deepEqual(next.parameters, { ...p, model: 'Dirty-MossV2-CONVROT8.safetensors' });
  assert.equal('connection' in next, false); assert.equal('receipt' in next, false);
  const raster = history.validateImageHistoryEntry({ ...input, parameters: { ...input.parameters, width: 1, height: 2 } });
  assert.equal(raster.parameters.width, 1); assert.equal(raster.parameters.height, 2);
  assert.throws(() => history.validateImageHistoryEntry({ ...input, parameters: { ...input.parameters, width: 0 } }));
  assert.throws(() => history.validateImageHistoryEntry({ ...input, characters: [{ positive: 'x', negative: '' }] }));
  assert.throws(() => history.validateImageHistoryEntry({ ...input, seed: 4 }));
});

async function providerHarness(legacy = false) {
  const calls = [], context = vm.createContext({ structuredClone, Blob, AbortSignal, Error });
  const stub = exports => new vm.SyntheticModule(Object.keys(exports), function() { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  const forbidden = () => { throw new Error('unexpected paid/text/library call'); };
  const oldBackend = provider => async (connection, parameters, positive, negative) => {
    if (!legacy) forbidden();
    calls.push({ provider, connection, parameters, positive, negative });
    return { blob: new Blob(['mock legacy image']), parameters, width: 17, height: 19, seed: 117 };
  };
  const modules = {
    './image-settings.js': { imageProviderName: settings.imageProviderName, isNaturalLanguageProvider: settings.isNaturalLanguageProvider },
    './image-prompt.js': { prepareImagePrompt: forbidden }, './anchor-resolver.js': { resolveStoredAnchorPromptFields: forbidden },
    './novelai.js': { generateImage: oldBackend('novelai') }, './openai-image.js': { generateOpenAIImage: oldBackend('openai') },
    './gemini-image.js': { generateGeminiImage: oldBackend('gemini') }, './grok-image.js': { generateGrokImage: oldBackend('grok') },
    './vibe-transfer.js': { prepareVibeReferences: legacy ? async () => [] : forbidden },
    './comfyui.js': { generateComfyImage: async (value, positive, negative) => { if (legacy) forbidden(); calls.push({ value, positive, negative }); return { blob: new Blob(['image']), parameters: { ...value.parameters, model: 'main' } }; } },
    './aspect-image.js': { geminiExpectedSize: forbidden, grokExpectedSize: forbidden, geminiRatioForSize: forbidden, grokRatioForSize: forbidden },
    './pet-events.js': { withFault: (error, fault) => Object.assign(error, { fault }) },
    './model-settings.js': { isImageSizeModeSaving: () => false, loadModelSettings: () => ({}) },
    './image-size-mode.js': { imageSizeMode: () => 'ai' }, './image-size.js': { imageSizeDimensions: () => ({ width: 896, height: 1152 }) },
  };
  const mod = new vm.SourceTextModule(await readFile(new URL('../dist/image-provider.js', import.meta.url), 'utf8'), { context });
  await mod.link(name => { if (!modules[name]) throw new Error(`unexpected import ${name}`); return stub(modules[name]); });
  await mod.evaluate(); return { api: mod.namespace, calls };
}

test('Comfy dispatch preserves natural language and negatives without anchors, NAI parsing, text-model or vibe calls', async () => {
  const { api, calls } = await providerHarness(), value = settings.defaultImageSettings('comfyui');
  value.negative = '真实负词'; value.connection.key = 'must-never-be-forwarded';
  const original = '中文 “引号”\n@not-an-anchor [NAI-looking:1.2]';
  const result = await api.generateConfiguredImage(value, original, new AbortController().signal);
  assert.equal(result.provider, 'comfyui'); assert.equal(result.positive, original); assert.equal(result.negative, '真实负词');
  assert.equal(calls.length, 1); assert.equal(calls[0].positive, original); assert.equal(calls[0].negative, '真实负词');
  assert.equal('connection' in calls[0].value, false);
  value.comfy.parameters.width = 1536; assert.equal(calls[0].value.parameters.width, 512);
});

for (const provider of ['novelai', 'openai', 'gemini', 'grok']) test(`legacy ${provider} prepared dispatch retains its own connection, prompt and response shape without a Comfy fallback`, async () => {
  const { api, calls } = await providerHarness(true), value = settings.defaultImageSettings(provider);
  value.connection.key = `synthetic-${provider}`; value.connection.url = `https://example.invalid/${provider}`;
  const positive = '旧后端正文 [不额外解析]，原样。', negative = provider === 'novelai' ? '原有负词' : '';
  const result = await api.generatePreparedImage(value, { positive, negative, characters: [] }, new AbortController().signal);
  assert.equal(calls.length, 1); assert.equal(calls[0].provider, provider);
  assert.equal(calls[0].connection.key, `synthetic-${provider}`); assert.equal(calls[0].connection.url, `https://example.invalid/${provider}`);
  assert.equal('comfy' in calls[0].connection, false); assert.equal('comfy' in calls[0].parameters, false);
  assert.equal(calls[0].positive, positive); assert.equal(result.provider, provider); assert.equal(result.positive, positive); assert.equal(result.negative, negative);
  if (provider === 'novelai') { assert.equal(calls[0].negative, negative); assert.equal(result.seed, 117); }
  if (provider === 'gemini' || provider === 'grok') { assert.equal(result.parameters.width, 17); assert.equal(result.parameters.height, 19); }
});

test('navigating away keeps an asynchronous Comfy save visible to the global import/export guard', async () => {
  const context = vm.createContext({ structuredClone, AbortController, URL, window: {} });
  const code = await readFile(new URL('../dist/image-config.js', import.meta.url), 'utf8');
  const pending = [];
  class FakePanel {
    hasPendingWrites = false; isBusy = false;
    constructor(value, options) { this.options = options; pending.push(this); }
    mount() {} destroy() {} setGenerationBusy() {}
    start() { this.hasPendingWrites = true; this.options.onBusyChange(); }
    finish() { this.hasPendingWrites = false; this.options.onBusyChange(); }
  }
  const imports = new Map([...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)].map(match => [match[2], match[1].split(',').map(name => name.trim().split(/\s+as\s+/)[0])]));
  const overrides = { loadImageSettings: () => settings.defaultImageSettings('comfyui'), onImageHistoryChanged: () => () => {},
    imageSettingsView: () => '', ComfyConfigPanel: FakePanel };
  const mod = new vm.SourceTextModule(code, { context });
  await mod.link(name => {
    const names = imports.get(name); assert.ok(names, `known static module ${name}`);
    return new vm.SyntheticModule(names, function() { for (const key of names) this.setExport(key, overrides[key] ?? (() => undefined)); }, { context });
  });
  await mod.evaluate();
  const config = new mod.namespace.ImageConfig();
  config.container = { innerHTML: '', querySelector: () => null };
  config.syncGeneration = () => {}; config.render();
  pending[0].start(); assert.equal(config.hasPendingWrites, true);
  config.unmount(); assert.equal(config.hasPendingWrites, true, 'unmount must not hide a still-running settings write');
  pending[0].finish(); assert.equal(config.hasPendingWrites, false);
});

test('existing AI marker framing and placeholder sizing target Comfy parameters, not hidden NAI controls', async () => {
  const { api } = await providerHarness(), value = settings.defaultImageSettings('comfyui');
  const framed = api.imageSettingsForMarker(value, { size: 'portrait' });
  assert.deepEqual(JSON.parse(JSON.stringify(api.expectedImageSize(framed))), { width: 896, height: 1152 });
  assert.equal(framed.parameters.width, value.parameters.width);
  assert.equal(value.comfy.parameters.width, 512);
});
