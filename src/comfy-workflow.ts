import type { ComfyBinding, ComfyBindings, ComfyInputName, ComfyParameters, ComfySettings, ComfyWorkflow } from './comfy-types.js';
import { ImageResponseError } from './image-bytes.js';
export type { ComfyBinding, ComfyBindings, ComfyParameters, ComfySettings, ComfyWorkflow } from './comfy-types.js';

const inputNames: readonly ComfyInputName[] = ['positive', 'negative', 'width', 'height', 'seed', 'steps', 'cfg', 'shift', 'sampler', 'scheduler'];
const stringInputs = new Set(['positive', 'negative', 'sampler', 'scheduler']);
// This is the finite contract of the supported MOSS/KSampler template, not a generic node editor.
const bindingTargets: Record<ComfyInputName, readonly [string, string]> = {
  positive: ['CLIPTextEncode', 'text'], negative: ['CLIPTextEncode', 'text'],
  width: ['EmptyFlux2LatentImage', 'width'], height: ['EmptyFlux2LatentImage', 'height'],
  seed: ['KSampler', 'seed'], steps: ['KSampler', 'steps'], cfg: ['KSampler', 'cfg'],
  sampler: ['KSampler', 'sampler_name'], scheduler: ['KSampler', 'scheduler'], shift: ['ModelSamplingAuraFlow', 'shift'],
};
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const supportedNodes = new Set(['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyFlux2LatentImage',
  'ModelSamplingAuraFlow', 'KSampler', 'VAEDecode', 'SaveImage', 'PreviewImage']);
function fail(message: string): never { throw new ImageResponseError(`ComfyUI：${message}`, 'setup'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('配置应为 JSON 对象。');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => unsafe.has(key))) fail('配置包含不安全的字段名。');
  return result;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) || unsafe.has(value)) fail('节点或输入字段名无效。');
  return value;
}
function finite(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) fail('数值参数无效。');
  return value;
}

/** Only loopback endpoints are part of this experiment; no credentials or proxy URLs. */
export function validateComfyUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) fail('请填写本机 HTTP / HTTPS 服务地址。');
  let url: URL;
  try { url = new URL(value.trim()); } catch { return fail('本机服务地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || /[\\\x00-\x20]/.test(value)) {
    fail('本实验只接受不含账号、查询参数或锚点的 localhost / 127.0.0.1 / [::1] 地址。');
  }
  return url.href.replace(/\/+$/, '');
}

/** The companion UI/API files are checked against this plain, non-subgraph template. */
export function defaultComfySettings(): ComfySettings {
  return {
    url: 'http://127.0.0.1:8188',
    parameters: { width: 512, height: 640, seed: 0, steps: 25, cfg: 2.5, shift: 5, sampler: 'er_sde', scheduler: 'simple' },
    bindings: {
      positive: { nodeId: '4', input: 'text' }, negative: { nodeId: '5', input: 'text' },
      width: { nodeId: '6', input: 'width' }, height: { nodeId: '6', input: 'height' },
      seed: { nodeId: '8', input: 'seed' }, steps: { nodeId: '8', input: 'steps' }, cfg: { nodeId: '8', input: 'cfg' },
      sampler: { nodeId: '8', input: 'sampler_name' }, scheduler: { nodeId: '8', input: 'scheduler' },
      shift: { nodeId: '7', input: 'shift' }, outputNodeIds: ['10'],
    },
    workflow: {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'Dirty-MossV2-CONVROT8.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3.5_9b_w4a8_gptq.safetensors', type: 'moss_image', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae_small.safetensors' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'A ceramic cup on a wooden table beside a window, soft daylight.', clip: ['2', 0] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
      '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width: 512, height: 640, batch_size: 1 } },
      '7': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 5 } },
      '8': { class_type: 'KSampler', inputs: { model: ['7', 0], seed: 0, steps: 25, cfg: 2.5, sampler_name: 'er_sde',
        scheduler: 'simple', positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], denoise: 1 } },
      '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
      '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'witch-paintbox/dirty-moss-v2' } },
    },
  };
}

export function validateComfyParameters(value: unknown): ComfyParameters {
  const p = object(value);
  const width = finite(p.width, 256, 2048, true), height = finite(p.height, 256, 2048, true);
  if (width % 16 || height % 16 || width * height > 4_194_304) fail('画幅必须是 16 的倍数，且不超过 2048×2048。');
  for (const key of ['sampler', 'scheduler']) {
    if (typeof p[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p[key] as string)) fail('采样器或调度器名称无效。');
  }
  return { width, height, seed: finite(p.seed, 0, Number.MAX_SAFE_INTEGER, true), steps: finite(p.steps, 1, 100, true),
    cfg: finite(p.cfg, 0, 30), shift: finite(p.shift, 0.01, 100), sampler: p.sampler as string, scheduler: p.scheduler as string };
}

function validateWorkflow(value: unknown): ComfyWorkflow {
  const source = object(value), ids = Object.keys(source);
  if (!ids.length || ids.length > 128 || 'nodes' in source || 'links' in source) fail('请导入 API 格式工作流，不是带 nodes/links 的界面图。');
  let size: number;
  try { size = JSON.stringify(value).length; } catch { return fail('工作流不是有效的 JSON。'); }
  if (size > 2 * 1024 * 1024) fail('工作流超过 2 MiB。');
  const graph: ComfyWorkflow = {};
  for (const id of ids) {
    name(id);
    const n = object(source[id]);
    if (Object.keys(n).some(key => !['class_type', 'inputs', '_meta'].includes(key))
      || typeof n.class_type !== 'string' || !supportedNodes.has(n.class_type)) fail('本轮仅支持 MOSS 基础原生图，不允许扩写模型、自定义节点或额外处理链。');
    const inputs = object(n.inputs);
    const copied: ComfyWorkflow[string]['inputs'] = {};
    if (Object.keys(inputs).length > 100) fail('单个节点输入过多。');
    for (const [key, input] of Object.entries(inputs)) {
      name(key);
      if (Array.isArray(input)) {
        if (input.length !== 2 || typeof input[0] !== 'string' || !Object.hasOwn(source, input[0])
          || !Number.isSafeInteger(input[1]) || input[1] < 0 || input[1] > 100) fail('节点连线指向不存在的节点或输出。');
        copied[key] = [input[0], input[1]];
      } else if (typeof input === 'string' && input.length <= 65_536 || typeof input === 'boolean'
        || typeof input === 'number' && Number.isFinite(input)) copied[key] = input;
      else fail('节点输入仅支持有限基本类型或明确连线。');
      if (key === 'batch_size' && input !== 1) fail('首版工作流仅支持 batch_size=1。');
    }
    graph[id] = { class_type: n.class_type, inputs: copied };
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) fail('工作流包含循环连线。');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of Object.values(graph[id].inputs)) if (Array.isArray(input)) visit(input[0]);
    visiting.delete(id); visited.add(id);
  }
  ids.forEach(visit);
  return graph;
}

export function validateComfySettings(value: unknown): ComfySettings {
  const settings = object(value), url = validateComfyUrl(settings.url), parameters = validateComfyParameters(settings.parameters);
  const workflow = validateWorkflow(settings.workflow), raw = object(settings.bindings);
  if (!Object.hasOwn(raw, 'positive') || Object.keys(raw).some(key => key !== 'outputNodeIds' && !inputNames.includes(key as ComfyInputName))) fail('输入绑定缺失或包含未支持的参数。');
  const bindings = {} as ComfyBindings;
  const targets = new Set<string>();
  for (const key of inputNames) {
    if (raw[key] === undefined) {
      if (key !== 'negative') fail(`本轮模板必须绑定参数 ${key}，不能静默使用旧值。`);
      continue;
    }
    const b = object(raw[key]);
    if (Object.keys(b).length !== 2) fail('绑定仅接受 nodeId 和 input。');
    const nodeId = name(b.nodeId), input = name(b.input), node = workflow[nodeId];
    if (!node || !Object.hasOwn(node.inputs, input)) fail('绑定的节点或输入不存在。');
    const [expectedClass, expectedInput] = bindingTargets[key];
    if (node.class_type !== expectedClass || input !== expectedInput) fail('绑定超出本轮 MOSS 模板允许的语义输入。');
    const expected = stringInputs.has(key) ? 'string' : 'number';
    if (typeof node.inputs[input] !== expected) fail('绑定目标的原始类型与参数类型不同。');
    const target = `${nodeId}:${input}`;
    if (targets.has(target)) fail('多个参数不能绑定同一输入。');
    targets.add(target); bindings[key] = { nodeId, input };
  }
  if (!Array.isArray(raw.outputNodeIds) || raw.outputNodeIds.length !== 1
    || new Set(raw.outputNodeIds).size !== raw.outputNodeIds.length) fail('请选择明确的图片输出节点。');
  bindings.outputNodeIds = raw.outputNodeIds.map(id => {
    const selected = name(id);
    if (!workflow[selected] || !['SaveImage', 'PreviewImage'].includes(workflow[selected].class_type)) fail('输出节点必须是 SaveImage 或 PreviewImage。');
    return selected;
  });
  // Every advertised binding must affect every selected output, not an unused side branch.
  for (const output of bindings.outputNodeIds) {
    const ancestors = new Set<string>();
    const visit = (id: string): void => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      for (const value of Object.values(workflow[id].inputs)) if (Array.isArray(value)) visit(value[0]);
    };
    visit(output);
    // This experiment approves one base denoising stage, not arbitrary chains of allowed classes.
    const expected: Record<string, number> = { UNETLoader: 1, CLIPLoader: 1, VAELoader: 1, CLIPTextEncode: 2,
      EmptyFlux2LatentImage: 1, ModelSamplingAuraFlow: 1, KSampler: 1, VAEDecode: 1, [workflow[output].class_type]: 1 };
    const counts = new Map<string, number>();
    for (const id of ancestors) counts.set(workflow[id].class_type, (counts.get(workflow[id].class_type) ?? 0) + 1);
    if (counts.size !== Object.keys(expected).length || Object.entries(expected).some(([type, count]) => counts.get(type) !== count)) {
      fail('本轮仅接受基础单阶段 MOSS：一个采样器、两路文本编码及各一个加载/潜图/Shift/解码/输出节点，不允许额外处理链。');
    }
    for (const key of inputNames) if (bindings[key] && !ancestors.has(bindings[key]!.nodeId)) fail('绑定节点不在指定输出的依赖链上。');
  }
  const sampler = bindings.seed!.nodeId;
  for (const key of ['steps', 'cfg', 'sampler', 'scheduler'] as const) if (bindings[key]!.nodeId !== sampler) fail('采样参数必须控制同一个 KSampler。');
  const linked = (input: string, binding: ComfyBinding): boolean => {
    const value = workflow[sampler].inputs[input];
    return Array.isArray(value) && value[0] === binding.nodeId && value[1] === 0;
  };
  if (!linked('positive', bindings.positive) || bindings.negative && !linked('negative', bindings.negative)
    || !linked('latent_image', bindings.width!) || bindings.width!.nodeId !== bindings.height!.nodeId
    || !linked('model', bindings.shift!)) fail('正文、负面词、画幅或 Shift 绑定未控制本轮采样器的对应输入。');
  return { url, parameters, workflow, bindings };
}

/** Never interpolate prompt strings into JSON; only approved, typed input fields can change. */
export function bindComfyWorkflow(value: ComfySettings, positive: string, negative: string): ComfyWorkflow {
  const settings = validateComfySettings(value);
  if (typeof positive !== 'string' || !positive.trim() || positive.length > 65_536
    || typeof negative !== 'string' || negative.length > 65_536) fail('提示词为空或过长。');
  if (negative.trim() && !settings.bindings.negative) fail('此模板没有负面提示词绑定。');
  const values = { ...settings.parameters, positive, negative };
  for (const key of inputNames) {
    const b: ComfyBinding | undefined = settings.bindings[key];
    if (b) settings.workflow[b.nodeId].inputs[b.input] = values[key];
  }
  // Check after assignment, then send only the selected output's dependency graph. Extra SaveImage
  // nodes must not execute just because their results would later be ignored by the collector.
  const graph = validateWorkflow(settings.workflow), selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const value of Object.values(graph[id].inputs)) if (Array.isArray(value)) visit(value[0]);
  };
  settings.bindings.outputNodeIds.forEach(visit);
  return Object.fromEntries(Object.entries(graph).filter(([id]) => selected.has(id)));
}
