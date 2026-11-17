import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

test('Comfy group is serial without lowering the shared limit or blocking other providers behind it', async () => {
  const context = vm.createContext({ window: new EventTarget(), AbortController, DOMException });
  const settings = new vm.SyntheticModule(['currentPreferences'], function () { this.setExport('currentPreferences', () => ({ imageConcurrency: 4 })); }, { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../dist/image-queue.js', import.meta.url), 'utf8'), { context });
  await module.link(() => settings); await module.evaluate();
  const queue = module.namespace, lifecycle = new AbortController();
  queue.bindImageQueuePreferences(lifecycle.signal);
  const gates = new Map(), started = [], progress = [], states = [];
  const stop = queue.onImageQueueChanged(s => states.push({ ...s }));
  function add(id, group) {
    const gate = Promise.withResolvers(), controller = new AbortController(); gates.set(id, gate);
    const result = queue.queueImageGeneration(async () => { started.push(id); await gate.promise; return id; }, controller.signal,
      event => { progress.push([id, event.state]); }, group).then(value => ({ value }), error => ({ error }));
    return { result, controller };
  }
  const c1 = add('c1', 'comfyui'), c2 = add('c2', 'comfyui'), c3 = add('c3', 'comfyui');
  const other1 = add('old-1'), other2 = add('old-2');
  await flush();
  assert.deepEqual(started, ['c1', 'old-1', 'old-2']);
  assert.equal(states.at(-1).limit, 4); assert.equal(states.at(-1).active, 3);
  c2.controller.abort(); assert.equal((await c2.result).error.name, 'AbortError');
  gates.get('c1').resolve(); await c1.result; await flush();
  assert.deepEqual(started, ['c1', 'old-1', 'old-2', 'c3']);
  gates.get('c3').resolve(); gates.get('old-1').resolve(); gates.get('old-2').resolve();
  await Promise.all([c3.result, other1.result, other2.result]); await flush();
  assert.equal(states.at(-1).active, 0); assert.equal(states.at(-1).queued, 0);
  assert.ok(progress.some(([id, state]) => id === 'c3' && state === 'queued'));
  stop(); lifecycle.abort();
});
