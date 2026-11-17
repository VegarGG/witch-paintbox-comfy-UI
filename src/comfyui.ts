import { ImageResponseError, MAX_IMAGE_BYTES } from './image-bytes.js';
import { object, readBytes, withRequest } from './openai-image.js';
import { readRasterImage } from './raster-image.js';
import { queueImageGeneration, type ImageGenerationProgress } from './image-queue.js';
import { bindComfyWorkflow, validateComfyParameters, validateComfySettings, validateComfyUrl } from './comfy-workflow.js';
import type { ComfyParameters, ComfySettings } from './comfy-types.js';
import type { PetFault } from './pet-events.js';

export type ComfyTaskState = 'queued' | 'checking' | 'submitting' | 'waiting' | 'fetching' | 'completed' | 'failed' | 'unknown' | 'cancelled-local';
export interface ComfyReceipt {
  taskId: string;
  clientId: string;
  promptId: string | null;
  url: string;
  outputNodeIds: string[];
  parameters: ComfyParameters & { model: string };
  submittedAt: number | null;
  state: ComfyTaskState;
  remoteState?: 'queued' | 'running' | 'not-seen';
  mayContinue: boolean;
  persisted: boolean;
}
export interface ComfyRuntimeOptions {
  requestTimeoutMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  onTask?: (receipt: ComfyReceipt) => void;
}
export interface ComfyConnectionStatus {
  connected: true;
  ready: boolean;
  nodesReady: boolean;
  modelsReady: boolean;
  version: string;
  issues: string[];
  inventory: { diffusionModels: string[]; textEncoders: string[]; vaes: string[] };
}
export interface ComfyImageResult { blob: Blob; parameters: ComfyParameters & { model: string }; receipt: ComfyReceipt }
export class ComfyTaskError extends ImageResponseError {
  constructor(message: string, readonly receipt: ComfyReceipt, fault: PetFault = 'unknown', cancelled = false) {
    super(message, fault);
    if (cancelled) this.name = 'AbortError';
  }
}
class HttpError extends ImageResponseError {
  constructor(readonly status: number) { super(`ComfyUI 接口拒绝或未完成请求（HTTP ${status}），没有自动重试。`, status === 429 ? 'busy' : 'setup'); }
}
const JOURNAL_KEY = 'witch-paintbox:comfy-tasks:v1';
const tasks = new Map<string, ComfyReceipt>();
const states: ComfyTaskState[] = ['queued', 'checking', 'submitting', 'waiting', 'fetching', 'completed', 'failed', 'unknown', 'cancelled-local'];
const MAX_JSON = 16 * 1024 * 1024;
function fail(message: string, fault: PetFault = 'format'): never { throw new ImageResponseError(`ComfyUI：${message}`, fault); }
function token(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function copy(receipt: ComfyReceipt): ComfyReceipt { return structuredClone(receipt); }
function runtime(options: ComfyRuntimeOptions) {
  const result = { requestTimeoutMs: options.requestTimeoutMs ?? 30_000, waitTimeoutMs: options.waitTimeoutMs ?? 1_800_000, pollIntervalMs: options.pollIntervalMs ?? 1500 };
  if (Object.values(result).some(v => !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 3_600_000)) fail('等待参数无效。', 'setup');
  return result;
}
async function overall<T>(signal: AbortSignal, timeout: number, operation: (signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
  const controller = new AbortController(), deadline = Date.now() + timeout;
  let expired = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => { expired = true; controller.abort(); }, timeout);
  try { return await operation(controller.signal, deadline); }
  catch (error) {
    if (expired && !signal.aborted) fail('整体等待超时（包含本地排队）；没有自动重提。', 'timeout');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort(); }
}
function parseReceipt(value: unknown): ComfyReceipt {
  const r = object(value), parameters = object(r.parameters);
  if (!token(r.taskId) || !token(r.clientId) || r.promptId !== null && !token(r.promptId)
    || !Array.isArray(r.outputNodeIds) || !r.outputNodeIds.length || r.outputNodeIds.length > 8 || !r.outputNodeIds.every(token)
    || !states.includes(r.state as ComfyTaskState) || typeof r.mayContinue !== 'boolean'
    || r.submittedAt !== null && (typeof r.submittedAt !== 'number' || !Number.isFinite(r.submittedAt) || r.submittedAt < 0)
    || typeof parameters.model !== 'string' || parameters.model.length > 512) fail('任务记录无效，不能恢复查询。', 'setup');
  return { taskId: r.taskId, clientId: r.clientId, promptId: r.promptId as string | null, url: validateComfyUrl(r.url),
    outputNodeIds: [...r.outputNodeIds] as string[], parameters: { ...validateComfyParameters(parameters), model: parameters.model },
    submittedAt: r.submittedAt as number | null, state: r.state as ComfyTaskState, mayContinue: r.mayContinue, persisted: r.persisted === true,
    ...(['queued', 'running', 'not-seen'].includes(r.remoteState as string) ? { remoteState: r.remoteState as ComfyReceipt['remoteState'] } : {}) };
}
function restore(): void {
  try {
    const raw = globalThis.sessionStorage?.getItem(JOURNAL_KEY);
    if (!raw || raw.length > 100_000) return;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 20) return;
    for (const value of rows) {
      try { const receipt = parseReceipt(value); if (!tasks.has(receipt.taskId)) tasks.set(receipt.taskId, receipt); } catch { /* Ignore invalid foreign data. */ }
    }
  } catch { /* Storage may be unavailable; in-memory receipts and errors still expose the task id. */ }
}
function persist(): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return false;
    const rows = [...tasks.values()].filter(r => r.submittedAt !== null);
    const uncertain = rows.filter(r => r.mayContinue);
    if (uncertain.length > 20) return false; // Never tail-drop an unresolved server task.
    const terminal = rows.filter(r => !r.mayContinue).slice(-(20 - uncertain.length));
    storage.setItem(JOURNAL_KEY, JSON.stringify([...uncertain, ...(uncertain.length === 20 ? [] : terminal)]));
    return true;
  } catch { return false; }
}
/** Minimal page-session journal only: never prompts, workflow JSON, images, cookies or cloud credentials. */
export function listComfyTasks(): ComfyReceipt[] { restore(); return [...tasks.values()].map(copy); }
/** Explicit acknowledgement only; this does not cancel, delete or resubmit anything on the server. */
export function forgetComfyTask(taskId: string): void { restore(); tasks.delete(taskId); persist(); }
function publish(receipt: ComfyReceipt, options: ComfyRuntimeOptions): void {
  tasks.set(receipt.taskId, copy(receipt));
  // Keep uncertain receipts; do not evict one merely to retain older terminal metadata.
  if (tasks.size > 20) for (const [id, row] of tasks) {
    if (tasks.size <= 20) break;
    if (!row.mayContinue && id !== receipt.taskId) tasks.delete(id);
  }
  const saved = persist();
  receipt.persisted = receipt.submittedAt !== null && saved; tasks.set(receipt.taskId, copy(receipt));
  try { options.onTask?.(copy(receipt)); } catch { /* An observer must not cause a second submission. */ }
}
function remaining(deadline: number, timeout: number): number {
  const left = deadline - Date.now();
  if (left <= 0) fail('整体等待超时；请按原任务编号查询，没有自动重提。', 'timeout');
  return Math.min(left, timeout);
}
async function jsonRequest(base: string, path: string, signal: AbortSignal, timeout: number, body?: unknown): Promise<Record<string, unknown>> {
  return withRequest(signal, timeout, async requestSignal => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal,
      mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new HttpError(response.status); }
    const bytes = await readBytes(response, MAX_JSON, requestSignal);
    let result: unknown;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return fail('接口没有返回有效 JSON；请确认地址不是界面页面。'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('接口 JSON 结构无效。');
    return object(result);
  });
}
function inputDefinitions(schema: Record<string, unknown>): Record<string, unknown> {
  const input = object(schema.input);
  return { ...object(input.required), ...object(input.optional) };
}
function inventoryList(info: Record<string, unknown>, node: string, field: string): string[] {
  const def = inputDefinitions(object(info[node]))[field];
  return Array.isArray(def) && Array.isArray(def[0]) ? def[0].filter((v): v is string => typeof v === 'string' && v.length <= 512).slice(0, 10_000) : [];
}
async function inspect(settings: ComfySettings, signal: AbortSignal, options: ComfyRuntimeOptions, deadline: number): Promise<ComfyConnectionStatus> {
  const timing = runtime(options), budget = () => remaining(deadline, timing.requestTimeoutMs);
  const stats = await jsonRequest(settings.url, '/system_stats', signal, budget());
  if (!stats.system || !Array.isArray(stats.devices)) fail('服务可达，但响应不是可识别的 ComfyUI 状态。', 'setup');
  const info = await jsonRequest(settings.url, '/object_info', signal, budget());
  const nodeIssues: string[] = [], modelIssues: string[] = [];
  for (const node of Object.values(settings.workflow)) {
    if (!Object.hasOwn(info, node.class_type)) { nodeIssues.push(`缺少节点 ${node.class_type}`); continue; }
    const schema = object(info[node.class_type]), input = object(schema.input), defs = inputDefinitions(schema);
    for (const key of Object.keys(object(input.required))) if (!Object.hasOwn(node.inputs, key)) nodeIssues.push(`节点 ${node.class_type} 缺少必需输入 ${key}`);
    for (const [key, value] of Object.entries(node.inputs)) {
      const def = defs[key];
      if (!Array.isArray(def) || !def.length) { nodeIssues.push(`节点 ${node.class_type} 的输入 ${key} 不受支持`); continue; }
      const type = def[0], config = object(def[1]);
      let valid = true;
      if (Array.isArray(value)) {
        const source = settings.workflow[value[0]], output = object(info[source.class_type]).output;
        const sourceType = Array.isArray(output) ? output[value[1]] : undefined;
        valid = typeof sourceType === 'string' && typeof type === 'string' && (sourceType === type || sourceType === '*' || type === '*');
      } else if (Array.isArray(type)) valid = type.includes(value);
      else if (type === 'INT' || type === 'FLOAT') {
        valid = typeof value === 'number' && (type !== 'INT' || Number.isInteger(value))
          && (typeof config.min !== 'number' || value >= config.min) && (typeof config.max !== 'number' || value <= config.max);
      } else if (type === 'STRING') valid = typeof value === 'string';
      else if (type === 'BOOLEAN') valid = typeof value === 'boolean';
      else valid = false;
      if (!valid) {
        const list = ['unet_name', 'clip_name', 'vae_name', 'ckpt_name'].includes(key) ? modelIssues : nodeIssues;
        // Identify the configuration field, never include its value (which might be narrative text).
        list.push(`节点 ${node.class_type} 的 ${key} 未准备或类型/取值不受支持`);
      }
    }
  }
  const issues = [...new Set([...nodeIssues, ...modelIssues])].slice(0, 30);
  const version = object(stats.system).comfyui_version;
  return { connected: true, ready: !issues.length, nodesReady: !nodeIssues.length, modelsReady: !modelIssues.length,
    version: typeof version === 'string' && /^[a-zA-Z0-9.+_-]{1,80}$/.test(version) ? version : 'unknown', issues,
    inventory: { diffusionModels: inventoryList(info, 'UNETLoader', 'unet_name'), textEncoders: inventoryList(info, 'CLIPLoader', 'clip_name'), vaes: inventoryList(info, 'VAELoader', 'vae_name') } };
}
/** GET-only; readiness is not evidence that a model has loaded or a picture has been generated. */
export async function checkComfyConnection(value: ComfySettings, signal: AbortSignal, options: ComfyRuntimeOptions = {}): Promise<ComfyConnectionStatus> {
  const settings = validateComfySettings(value), timing = runtime(options);
  return inspect(settings, signal, options, Date.now() + Math.min(timing.waitTimeoutMs, timing.requestTimeoutMs * 2));
}
function taskError(error: unknown, receipt: ComfyReceipt, signal: AbortSignal, options: ComfyRuntimeOptions): ComfyTaskError {
  if (error instanceof ComfyTaskError) return error;
  const aborted = signal.aborted;
  receipt.state = aborted ? 'cancelled-local' : receipt.mayContinue ? 'unknown' : 'failed';
  publish(receipt, options);
  const detail = error instanceof ImageResponseError ? error.message : 'ComfyUI 请求未完成。';
  const tail = receipt.mayContinue ? `服务端可能仍在执行；${receipt.promptId ? `任务编号 ${receipt.promptId}，可仅恢复查询` : '未取得任务编号，请到 Comfy 界面核对'}。没有自动重提。` : '没有自动重提。';
  return new ComfyTaskError(`${aborted ? '已停止本地等待，未声称 GPU 已停止。' : detail} ${tail}`, copy(receipt), error instanceof ImageResponseError ? error.fault : 'unknown', aborted);
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('已停止本地等待。', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
function outputDescriptor(row: Record<string, unknown>, selected: string[]): { filename: string; subfolder: string; type: string } {
  const outputs = object(row.outputs), images: unknown[] = [];
  for (const id of selected) {
    const found = object(outputs[id]).images;
    if (Array.isArray(found)) images.push(...found);
  }
  if (images.length !== 1) fail('指定输出节点应返回且仅返回一张图片。');
  const image = object(images[0]), subfolder = image.subfolder ?? '';
  if (typeof image.filename !== 'string' || !image.filename || image.filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(image.filename)
    || image.filename === '.' || image.filename === '..' || typeof subfolder !== 'string' || subfolder.length > 512
    || /[\\:\x00-\x1f\x7f]/.test(subfolder) || subfolder.startsWith('/') || subfolder.split('/').some(part => part === '.' || part === '..')
    || !['output', 'temp'].includes(image.type as string)) fail('图片输出描述无效；不会访问任意 URL 或越界路径。');
  return { filename: image.filename, subfolder, type: image.type as string };
}
async function poll(receipt: ComfyReceipt, signal: AbortSignal, options: ComfyRuntimeOptions, deadline: number): Promise<ComfyImageResult> {
  const timing = runtime(options), budget = () => remaining(deadline, timing.requestTimeoutMs);
  if (!receipt.promptId) fail('没有任务编号，不能恢复查询；请在 Comfy 界面确认，未自动重提。', 'setup');
  receipt.state = 'waiting'; publish(receipt, options);
  while (true) {
    signal.throwIfAborted();
    const history = await jsonRequest(receipt.url, `/history/${encodeURIComponent(receipt.promptId)}`, signal, budget());
    const row = object(history[receipt.promptId]), status = object(row.status);
    const messages = Array.isArray(status.messages) ? status.messages : [];
    const errorEvents = messages.filter((m): m is unknown[] => Array.isArray(m) && ['execution_error', 'execution_interrupted'].includes(m[0]));
    if (status.status_str === 'error' || errorEvents.length) {
      receipt.mayContinue = false;
      const oom = errorEvents.some(m => /out.of.memory|outofmemory|mps.*memory/i.test(String(object(m[1]).exception_type) + ' ' + String(object(m[1]).exception_message)));
      fail(oom ? '执行因内存不足失败；请降低画幅或调整已核对的运行设备，不自动重试。' : '服务端执行失败或被中断；未自动重试。', oom ? 'quota' : 'unknown');
    }
    if (status.completed === true && status.status_str === 'success') {
      receipt.mayContinue = false;
      const descriptor = outputDescriptor(row, receipt.outputNodeIds);
      receipt.state = 'fetching'; publish(receipt, options);
      const url = new URL(`${receipt.url}/view`);
      for (const [key, value] of Object.entries(descriptor)) url.searchParams.set(key, value);
      const result = await withRequest(signal, budget(), async requestSignal => {
        const response = await fetch(url.href, { signal: requestSignal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
        const bytes = await readBytes(response, MAX_IMAGE_BYTES, requestSignal);
        return readRasterImage(bytes, requestSignal);
      });
      signal.throwIfAborted(); receipt.state = 'completed'; publish(receipt, options);
      return { blob: result.blob, parameters: { ...receipt.parameters, width: result.width, height: result.height }, receipt: copy(receipt) };
    }
    const queue = await jsonRequest(receipt.url, '/queue', signal, budget());
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) fail('队列响应无效，保留原任务编号。');
    const has = (rows: unknown[]) => rows.some(item => Array.isArray(item) && item[1] === receipt.promptId);
    receipt.remoteState = has(queue.queue_running) ? 'running' : has(queue.queue_pending) ? 'queued' : 'not-seen';
    publish(receipt, options);
    await delay(Math.min(timing.pollIntervalMs, remaining(deadline, timing.pollIntervalMs)), signal);
  }
}
function ensureNoUncertain(url: string): void {
  const pending = listComfyTasks().filter(task => task.mayContinue);
  if (pending.length >= 20) throw new ComfyTaskError('未确认任务日志已满，请先核对并处理旧任务；没有发送新任务。', pending[0], 'busy');
  const uncertain = pending.find(task => task.url === url);
  if (uncertain) throw new ComfyTaskError('已有提交结果未确认的 ComfyUI 任务，请先恢复查询或在服务端核对后明确清除本地记录。未发送新任务。', uncertain, 'busy');
}
/** One POST, no implicit retry, no paid fallback, no global interrupt. */
export async function generateComfyImage(
  value: ComfySettings, positive: string, negative: string, signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void, options: ComfyRuntimeOptions = {},
): Promise<ComfyImageResult> {
  const settings = validateComfySettings(value), workflow = bindComfyWorkflow(settings, positive, negative), timing = runtime(options);
  const taskId = crypto.randomUUID();
  const modelNode = Object.values(workflow).find(node => node.class_type === 'UNETLoader');
  const model = typeof modelNode?.inputs.unet_name === 'string' ? modelNode.inputs.unet_name.slice(0, 512) : 'ComfyUI workflow';
  const receipt: ComfyReceipt = { taskId, clientId: taskId, promptId: null, url: settings.url, outputNodeIds: [...settings.bindings.outputNodeIds],
    parameters: { ...settings.parameters, model }, submittedAt: null, state: 'queued', mayContinue: false, persisted: false };
  try {
    return await overall(signal, timing.waitTimeoutMs, (signal, deadline) => queueImageGeneration(async () => {
      ensureNoUncertain(settings.url);
      receipt.state = 'checking'; publish(receipt, options);
      const status = await inspect({ ...settings, workflow }, signal, options, deadline);
      if (!status.ready) fail(`工作流尚未准备：${status.issues.join('；')}。没有提交绘图。`, 'setup');
      signal.throwIfAborted();
      receipt.state = 'submitting'; receipt.submittedAt = Date.now(); receipt.mayContinue = true; publish(receipt, options);
      let response: Record<string, unknown>;
      try { response = await jsonRequest(settings.url, '/prompt', signal, remaining(deadline, timing.requestTimeoutMs), { prompt: workflow, client_id: receipt.clientId }); }
      catch (error) {
        if (error instanceof HttpError && [400, 401, 403, 404, 413, 422, 429].includes(error.status)) receipt.mayContinue = false;
        throw error;
      }
      if (token(response.prompt_id)) receipt.promptId = response.prompt_id;
      publish(receipt, options);
      if (Object.keys(object(response.node_errors)).length) fail('提交响应含节点错误；可能已部分入队，请按原任务核对，不自动重提。', 'setup');
      if (response.error || !receipt.promptId) fail('提交结果不明确，未获得有效任务编号。');
      return poll(receipt, signal, options, deadline);
    }, signal, onProgress, 'comfyui'));
  } catch (error) { throw taskError(error, receipt, signal, options); }
}
/** Explicit recovery of this receipt only; never reconstruct or POST a workflow after a failure/reload. */
export async function resumeComfyImage(value: ComfyReceipt, signal: AbortSignal, options: ComfyRuntimeOptions = {}): Promise<ComfyImageResult> {
  const receipt = parseReceipt(value), timing = runtime(options);
  try {
    if (!receipt.promptId) fail('没有任务编号，不能恢复查询；请在 Comfy 界面确认，未自动重提。', 'setup');
    return await overall(signal, timing.waitTimeoutMs, (signal, deadline) =>
      queueImageGeneration(() => poll(receipt, signal, options, deadline), signal, undefined, 'comfyui'));
  } catch (error) { throw taskError(error, receipt, signal, options); }
}
