import { currentPreferences } from './settings.js';

export type ImageGenerationProgress =
  | { state: 'queued'; position: number; columns?: number }
  | { state: 'generating'; columns?: number };

interface QueuedGeneration {
  position: number;
  group?: 'comfyui';
  onProgress?: (progress: ImageGenerationProgress) => void;
  start: () => Promise<void>;
}

const waiting: QueuedGeneration[] = [];
let running = 0;
const activeGroups = new Set<string>();
let concurrency = 1;
let draining = false;
export interface ImageQueueState { generating: boolean; active: number; queued: number; limit: number }
const listeners = new Set<(state: ImageQueueState) => void>();

function queueState(): ImageQueueState {
  return { generating: running > 0, active: running, queued: waiting.length, limit: concurrency };
}

/** Apply saved preferences once host storage is ready, then follow edits/imports/resets. */
export function bindImageQueuePreferences(signal: AbortSignal): void {
  if (signal.aborted) return;
  const update = () => { concurrency = currentPreferences().imageConcurrency; drain(); };
  window.addEventListener('witch-paintbox:preferences-changed', update, { signal });
  update();
}

export function onImageQueueChanged(listener: (state: ImageQueueState) => void): () => void {
  listener(queueState());
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyQueue(): void {
  for (const listener of listeners) {
    try { listener(queueState()); }
    catch { /* A launcher update must not interrupt the shared queue. */ }
  }
}

function cancelled(): DOMException {
  return new DOMException('本次生图已取消。', 'AbortError');
}

function report(task: QueuedGeneration, progress: ImageGenerationProgress): void {
  try {
    task.onProgress?.(progress);
  } catch {
    // A view update must not interrupt a generation or block the queue.
  }
}

function updatePositions(): void {
  for (const task of [...waiting]) {
    // Progress callbacks may cancel other waiting tasks.
    const position = waiting.indexOf(task) + 1;
    if (position && task.position !== position) {
      task.position = position;
      report(task, { state: 'queued', position });
    }
  }
  notifyQueue();
}

function drain(): void {
  if (draining) return;
  draining = true;
  try {
    while (waiting.length && running < concurrency) {
      // Preserve FIFO among runnable jobs. A busy local backend must not reserve cloud slots.
      const index = waiting.findIndex(task => !task.group || !activeGroups.has(task.group));
      if (index < 0) break;
      const [task] = waiting.splice(index, 1);
      ++running;
      if (task.group) activeGroups.add(task.group);
      void task.start().finally(() => {
        --running;
        if (task.group) activeGroups.delete(task.group);
        drain();
      });
    }
  } finally {
    draining = false;
    updatePositions();
  }
}

/** One shared FIFO for every image entry point; the operation includes response decoding. */
export function queueImageGeneration<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onProgress?: (progress: ImageGenerationProgress) => void,
  group?: 'comfyui',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const cancel = () => {
      const index = waiting.indexOf(task);
      if (index < 0) return;
      waiting.splice(index, 1);
      signal.removeEventListener('abort', cancel);
      reject(cancelled());
      updatePositions();
    };
    const task: QueuedGeneration = {
      position: 0,
      group,
      onProgress,
      async start() {
        signal.removeEventListener('abort', cancel);
        try {
          if (signal.aborted) throw cancelled();
          report(task, { state: 'generating' });
          updatePositions();
          if (signal.aborted) throw cancelled();
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      },
    };
    waiting.push(task);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    drain();
  });
}
