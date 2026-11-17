import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../dist/image-bytes.js';
import { defaultComfySettings } from '../dist/comfy-workflow.js';
import { checkComfyConnection, generateComfyImage, resumeComfyImage, listComfyTasks, forgetComfyTask } from '../dist/comfyui.js';

const runtime = { pollIntervalMs: 1, requestTimeoutMs: 500, waitTimeoutMs: 2000 };
const signal = () => new AbortController().signal;
const taskOptions = extra => ({ ...runtime, ...extra });
const nodes = {
  UNETLoader: { input: { required: { unet_name: [['Dirty-MossV2-CONVROT8.safetensors']], weight_dtype: [['default']] } }, output: ['MODEL'] },
  CLIPLoader: { input: { required: { clip_name: [['qwen3.5_9b_w4a8_gptq.safetensors']], type: [['moss_image']] }, optional: { device: [['default', 'cpu']] } }, output: ['CLIP'] },
  VAELoader: { input: { required: { vae_name: [['flux2-vae_small.safetensors']] } }, output: ['VAE'] },
  CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  EmptyFlux2LatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } }, output: ['LATENT'] },
  ModelSamplingAuraFlow: { input: { required: { model: ['MODEL'], shift: ['FLOAT'] } }, output: ['MODEL'] },
  KSampler: { input: { required: { model: ['MODEL'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['er_sde']], scheduler: [['simple']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT'] } }, output: ['LATENT'] },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: ['IMAGE'], output_node: true },
};
function png() {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const image = png();
const descriptor = { filename: 'result.png', subfolder: 'witch-paintbox/dirty-moss-v2', type: 'output' };
const history = (outputs = { '10': { images: [descriptor] } }) => ({ 'p-1': { status: { completed: true, status_str: 'success', messages: [] }, outputs } });
function fixture(t, override = () => undefined) {
  const calls = [], seen = [];
  t.mock.method(globalThis, 'fetch', async (raw, options = {}) => {
    const url = new URL(raw), call = { url, ...options, json: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const response = await override(call, calls);
    if (response !== undefined) return response;
    if (url.pathname === '/system_stats') return Response.json({ system: { comfyui_version: '0.45.5' }, devices: [] });
    if (url.pathname === '/object_info') return Response.json(nodes);
    if (url.pathname === '/prompt') return Response.json({ prompt_id: 'p-1', node_errors: {} });
    if (url.pathname === '/history/p-1') return Response.json(history());
    if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/view') return new Response(image, { headers: { 'content-type': 'image/png' } });
    throw Error(`Unexpected mock request ${url.pathname}`);
  });
  t.after(() => { for (const receipt of seen) forgetComfyTask(receipt.taskId); });
  return { calls, seen, options: taskOptions({ onTask: task => seen.push(task) }) };
}

test('connection check is GET-only and distinguishes connected, node readiness and model readiness', async t => {
  const { calls } = fixture(t);
  const result = await checkComfyConnection(defaultComfySettings(), signal(), runtime);
  assert.equal(result.connected, true); assert.equal(result.ready, true);
  assert.equal(result.nodesReady, true); assert.equal(result.modelsReady, true);
  assert.deepEqual(calls.map(c => c.url.pathname), ['/system_stats', '/object_info']);
  assert.ok(calls.every(c => !c.method || c.method === 'GET'));
});

test('missing model or node fails before any prompt submission without echoing prompt text', async t => {
  let mode = 'model';
  const { calls, options } = fixture(t, c => {
    if (c.url.pathname !== '/object_info') return;
    const schema = structuredClone(nodes);
    if (mode === 'model') schema.CLIPLoader.input.required.clip_name[0] = [];
    else delete schema.KSampler;
    return Response.json(schema);
  });
  const check = await checkComfyConnection(defaultComfySettings(), signal(), runtime);
  assert.equal(check.connected, true); assert.equal(check.ready, false); assert.equal(check.modelsReady, false);
  for (mode of ['model', 'node']) await assert.rejects(generateComfyImage(defaultComfySettings(), 'private-scene', '', signal(), undefined, options), e => {
    assert.equal(e.receipt.mayContinue, false); assert.doesNotMatch(e.message, /private-scene/); return true;
  });
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('one prompt POST preserves exact text and returns the validated original bytes from only the selected output', async t => {
  const { calls, options } = fixture(t, c => c.url.pathname === '/history/p-1'
    ? Response.json(history({ '99': { images: [{ filename: 'unselected.png', type: 'output' }] }, '10': { images: [{ ...descriptor, url: 'https://untrusted.invalid/image' }] } })) : undefined);
  const settings = defaultComfySettings(), before = JSON.stringify(settings), text = '猫说"你好"\nC:\\猫\\';
  const result = await generateComfyImage(settings, text, '水印', signal(), undefined, options);
  const post = calls.filter(c => c.url.pathname === '/prompt'); assert.equal(post.length, 1);
  assert.equal(post[0].json.prompt['4'].inputs.text, text); assert.equal(post[0].json.prompt['5'].inputs.text, '水印');
  assert.equal(typeof post[0].json.client_id, 'string'); assert.equal(JSON.stringify(settings), before);
  assert.equal(result.receipt.promptId, 'p-1'); assert.equal(result.receipt.state, 'completed');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), image);
  assert.equal(result.parameters.width, 1); assert.equal(result.parameters.height, 1);
  const view = calls.filter(c => c.url.pathname === '/view'); assert.equal(view.length, 1);
  assert.equal(view[0].url.searchParams.get('filename'), 'result.png');
  assert.ok(calls.every(c => c.url.origin === 'http://127.0.0.1:8188' && c.credentials === 'omit' && c.redirect === 'error'));
  assert.ok(calls.every(c => !new Headers(c.headers).has('authorization')));
});

test('server queue states are reported while bounded history polling never resubmits', async t => {
  let polls = 0;
  const { calls, options, seen } = fixture(t, c => {
    if (c.url.pathname === '/history/p-1' && ++polls < 3) return Response.json({});
    if (c.url.pathname === '/queue') return Response.json({ queue_running: polls === 2 ? [[0, 'p-1']] : [], queue_pending: polls === 1 ? [[0, 'p-1']] : [] });
  });
  await generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options);
  assert.ok(seen.some(task => task.remoteState === 'queued')); assert.ok(seen.some(task => task.remoteState === 'running'));
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
});

test('queued Comfy requests freeze their graph/parameters and local queued cancellation sends nothing', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let paused = false;
  const { calls, options } = fixture(t, async c => {
    if (c.url.pathname === '/history/p-1' && !paused) { paused = true; entered.resolve(); await gate.promise; }
  });
  const first = generateComfyImage(defaultComfySettings(), 'first', '', signal(), undefined, options);
  await entered.promise;
  const settings = defaultComfySettings(); settings.parameters.width = 896;
  const second = generateComfyImage(settings, 'second', '', signal(), undefined, options);
  settings.parameters.width = 1536; settings.workflow['1'].inputs.unet_name = 'changed-after-queue';
  const controller = new AbortController();
  const cancelled = generateComfyImage(defaultComfySettings(), 'cancelled', '', controller.signal, undefined, options);
  controller.abort();
  await assert.rejects(cancelled, e => e.name === 'AbortError' && !e.receipt.mayContinue && e.receipt.promptId === null);
  gate.resolve(); await Promise.all([first, second]);
  const posts = calls.filter(c => c.url.pathname === '/prompt'); assert.equal(posts.length, 2);
  assert.equal(posts[1].json.prompt['6'].inputs.width, 896);
  assert.equal(posts[1].json.prompt['1'].inputs.unet_name, 'Dirty-MossV2-CONVROT8.safetensors');
});

test('ambiguous POST failure retains an unknown receipt and cannot auto-retry or start another submission', async t => {
  const { calls, options, seen } = fixture(t, c => { if (c.url.pathname === '/prompt') throw new TypeError('private upstream text'); });
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'secret-scene', '', signal(), undefined, options), e => {
    assert.equal(e.receipt.state, 'unknown'); assert.equal(e.receipt.mayContinue, true);
    assert.equal(e.receipt.promptId, null); assert.doesNotMatch(e.message, /private upstream|secret-scene/); return true;
  });
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene2', '', signal(), undefined, options), /未知|确认|未确认/);
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
  assert.ok(seen.some(task => task.state === 'submitting'));
});

test('HTTP rejection and accepted node errors are distinct from success and never retried', async t => {
  let mode = 400;
  const { calls, options } = fixture(t, c => c.url.pathname === '/prompt' ? mode === 400
    ? Response.json({ error: 'secret error', node_errors: { x: {} } }, { status: 400 })
    : Response.json({ prompt_id: 'p-1', node_errors: { x: { details: 'secret' } } }) : undefined);
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options), e => e.receipt.state === 'failed' && !e.receipt.mayContinue);
  mode = 200;
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options), e => e.receipt.promptId === 'p-1' && e.receipt.mayContinue && !/secret/.test(e.message));
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 2);
});

test('history network failure retains prompt_id and explicit recovery only queries the existing task', async t => {
  let broken = true, receipt;
  const { calls, options } = fixture(t, c => { if (c.url.pathname === '/history/p-1' && broken) throw new Error('disconnect'); });
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options), e => { receipt = e.receipt; return receipt.promptId === 'p-1' && receipt.state === 'unknown'; });
  broken = false;
  const result = await resumeComfyImage(receipt, signal(), options);
  assert.equal(result.receipt.taskId, receipt.taskId); assert.equal(result.receipt.state, 'completed');
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
});

test('execution failure including OOM is terminal and does not expose backend text or fetch an image', async t => {
  const { calls, options } = fixture(t, c => c.url.pathname === '/history/p-1' ? Response.json({ 'p-1': {
    outputs: {}, status: { completed: false, status_str: 'error', messages: [['execution_error', { exception_type: 'OutOfMemoryError', exception_message: 'secret prompt' }]] },
  } }) : undefined);
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options), e => {
    assert.equal(e.receipt.state, 'failed'); assert.equal(e.receipt.mayContinue, false);
    assert.match(e.message, /内存/); assert.doesNotMatch(e.message, /secret/); return true;
  });
  assert.equal(calls.filter(c => c.url.pathname === '/view').length, 0);
});

test('missing or multiple selected images and unsafe paths fail without returning arbitrary URLs', async t => {
  let outputs = { '99': { images: [descriptor] } };
  const { calls, options } = fixture(t, c => c.url.pathname === '/history/p-1' ? Response.json(history(outputs)) : undefined);
  for (const value of [{ '99': { images: [descriptor] } }, { '10': { images: [descriptor, descriptor] } },
    { '10': { images: [{ ...descriptor, filename: '../escape.png' }] } },
    { '10': { images: [{ ...descriptor, subfolder: '../secret' }] } },
    { '10': { images: [{ ...descriptor, type: 'input' }] } }]) {
    outputs = value;
    await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options));
  }
  assert.equal(calls.filter(c => c.url.pathname === '/view').length, 0);
});

test('image response uses the existing size and byte validators rather than trusting MIME', async t => {
  const { options } = fixture(t, c => c.url.pathname === '/view' ? new Response('<html>not an image</html>', { headers: { 'content-type': 'image/png' } }) : undefined);
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options), /HTML|图片/);
});

test('bounded overall waiting expires with its task id and never interrupts other Comfy jobs', async t => {
  const { calls, options } = fixture(t, c => c.url.pathname === '/history/p-1' ? Response.json({}) : undefined);
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, { ...options, waitTimeoutMs: 30 }), e => e.receipt.promptId === 'p-1' && e.receipt.state === 'unknown' && e.fault === 'timeout');
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
  assert.equal(calls.filter(c => /interrupt|cancel/.test(c.url.pathname)).length, 0);
});

test('request timeout also covers a stalled response stream', async t => {
  const { options } = fixture(t, c => c.url.pathname === '/system_stats' ? new Response(new ReadableStream({ start() {} })) : undefined);
  await assert.rejects(checkComfyConnection(defaultComfySettings(), signal(), { ...options, requestTimeoutMs: 20 }), e => e.fault === 'timeout');
});

test('abort after submission cancels local waiting only, preserves receipt, and never sends global interrupt', async t => {
  const controller = new AbortController();
  const { calls, options } = fixture(t);
  await assert.rejects(generateComfyImage(defaultComfySettings(), 'scene', '', controller.signal, undefined, {
    ...options, onTask: task => { options.onTask(task); if (task.state === 'waiting') controller.abort(); },
  }), e => e.name === 'AbortError' && e.receipt.promptId === 'p-1' && e.receipt.state === 'cancelled-local' && e.receipt.mayContinue);
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
  assert.equal(calls.filter(c => /interrupt|cancel/.test(c.url.pathname)).length, 0);
});

test('overall timeout includes local queue waiting and sends no queued prompt', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let paused = false;
  const { calls, options } = fixture(t, async c => {
    if (c.url.pathname === '/history/p-1' && !paused) { paused = true; entered.resolve(); await gate.promise; }
  });
  const first = generateComfyImage(defaultComfySettings(), 'first', '', signal(), undefined, options);
  await entered.promise;
  const queued = generateComfyImage(defaultComfySettings(), 'queued', '', signal(), undefined, { ...options, waitTimeoutMs: 5 })
    .then(() => ({ resolved: true }), error => ({ error }));
  try {
    const result = await Promise.race([queued, new Promise(resolve => setTimeout(() => resolve({ pending: true }), 30))]);
    assert.equal(result.pending, undefined, 'must expire while still waiting for the local group');
    assert.equal(result.error.fault, 'timeout'); assert.equal(result.error.receipt.promptId, null);
    assert.equal(result.error.receipt.mayContinue, false);
    assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
  } finally { gate.resolve(); await first; await queued; }
});

test('a full uncertain journal blocks a 21st submission without losing old recovery guards', async t => {
  const data = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : Reflect.deleteProperty(globalThis, 'sessionStorage'));
  const { calls, options } = fixture(t, c => { if (c.url.pathname === '/prompt') throw new Error('ambiguous'); });
  for (let i = 0; i < 20; i++) {
    const settings = defaultComfySettings(); settings.url = `http://127.0.0.1:${9000 + i}`;
    await assert.rejects(generateComfyImage(settings, 'scene', '', signal(), undefined, options));
  }
  const extra = defaultComfySettings(); extra.url = 'http://127.0.0.1:9099';
  await assert.rejects(generateComfyImage(extra, 'scene', '', signal(), undefined, options), e => e.fault === 'busy');
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 20);
  const saved = JSON.parse(data.get('witch-paintbox:comfy-tasks:v1'));
  assert.equal(saved.filter(r => r.mayContinue).length, 20);
  assert.ok(saved.some(r => r.url === 'http://127.0.0.1:9000'));
});

test('a restored waiting receipt blocks a fresh submission after a page reload', async t => {
  const data = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : Reflect.deleteProperty(globalThis, 'sessionStorage'));
  const { calls, options } = fixture(t);
  const first = await generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, options);
  const interrupted = { ...first.receipt, state: 'waiting', mayContinue: true };
  data.set('witch-paintbox:comfy-tasks:v1', JSON.stringify([interrupted]));
  const fresh = await import(`../dist/comfyui.js?journal-reload=${crypto.randomUUID()}`);
  await assert.rejects(fresh.generateComfyImage(defaultComfySettings(), 'scene', '', signal(), undefined, runtime), e => e.receipt.taskId === first.receipt.taskId && e.fault === 'busy');
  assert.equal(calls.filter(c => c.url.pathname === '/prompt').length, 1);
  fresh.forgetComfyTask(first.receipt.taskId);
});

test('minimal task journal contains no prompt or graph and remains available for explicit recovery', async t => {
  const data = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : Reflect.deleteProperty(globalThis, 'sessionStorage'));
  const { options } = fixture(t);
  const result = await generateComfyImage(defaultComfySettings(), 'private prompt', 'private negative', signal(), undefined, options);
  const json = [...data.values()].join('');
  assert.doesNotMatch(json, /private prompt|private negative|class_type|unet_name|Authorization/);
  assert.match(json, /p-1/); assert.ok(listComfyTasks().some(task => task.taskId === result.receipt.taskId));
});
