import { validateComfySettings } from './comfy-workflow.js';
import { ImageResponseError } from './image-bytes.js';
export const COMFY_MODEL_PRESETS = Object.freeze({
    anime: Object.freeze({
        label: '二次元（MOSS Image）',
        unetName: 'moss_image_sft_int8_convrot.safetensors',
        clipName: 'qwen3.5_9b_w4a8_gptq.safetensors',
        steps: 20,
    }),
    realistic: Object.freeze({
        label: '写实（Dirty-Moss V2）',
        unetName: 'Dirty-MossV2-CONVROT8.safetensors',
        clipName: 'qwen3.5_9b_uncensored_int8_convrot.safetensors',
        steps: 20,
    }),
});
function unsupportedGraph() {
    throw new ImageResponseError('ComfyUI：模型预设只适用于支持的原生单阶段 MOSS 图。', 'setup');
}
function linkedNode(graph, id, input, expectedClass) {
    const value = graph[id].inputs[input];
    if (!Array.isArray(value) || value[1] !== 0 || graph[value[0]]?.class_type !== expectedClass)
        return unsupportedGraph();
    return value[0];
}
/** Pure preview of an explicit selection: does not store settings or contact ComfyUI. */
export function applyComfyModelPreset(settings, preset) {
    if (!Object.hasOwn(COMFY_MODEL_PRESETS, preset))
        throw new ImageResponseError('ComfyUI：不支持此模型预设。', 'setup');
    const selected = COMFY_MODEL_PRESETS[preset];
    const next = structuredClone(settings);
    // Seed already has a mandatory KSampler binding. Validate the inferred steps binding with
    // all existing constraints, rather than making steps optional on the general request path.
    const seedNode = next.bindings?.seed?.nodeId;
    if (next.bindings?.steps === undefined && typeof seedNode === 'string') {
        next.bindings.steps = { nodeId: seedNode, input: 'steps' };
    }
    const { workflow, bindings } = validateComfySettings(next);
    const decode = linkedNode(workflow, bindings.outputNodeIds[0], 'images', 'VAEDecode');
    const sampler = linkedNode(workflow, decode, 'samples', 'KSampler');
    linkedNode(workflow, decode, 'vae', 'VAELoader');
    const shift = linkedNode(workflow, sampler, 'model', 'ModelSamplingAuraFlow');
    const unet = linkedNode(workflow, shift, 'model', 'UNETLoader');
    const positive = linkedNode(workflow, sampler, 'positive', 'CLIPTextEncode');
    const negative = linkedNode(workflow, sampler, 'negative', 'CLIPTextEncode');
    const clip = linkedNode(workflow, positive, 'clip', 'CLIPLoader');
    if (sampler !== bindings.steps?.nodeId || positive === negative
        || clip !== linkedNode(workflow, negative, 'clip', 'CLIPLoader') || workflow[clip].inputs.type !== 'moss_image'
        || typeof workflow[unet].inputs.unet_name !== 'string' || typeof workflow[clip].inputs.clip_name !== 'string') {
        return unsupportedGraph();
    }
    // Keep both the visible parameter and on-graph value aligned; preserve URL, other inputs,
    // wire IDs and metadata from the original draft instead of returning a normalized copy.
    next.parameters.steps = selected.steps;
    next.workflow[sampler].inputs.steps = selected.steps;
    next.workflow[unet].inputs.unet_name = selected.unetName;
    next.workflow[clip].inputs.clip_name = selected.clipName;
    return next;
}
