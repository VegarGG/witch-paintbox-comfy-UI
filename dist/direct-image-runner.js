import { captureDirectAssistant, watchChatRendering } from './chat-host.js';
import { assertDirectImageCurrent, directImageHistoryKey, directImageHistoryKeyForSource, extractDirectNarrative, prepareDirectImage, readDirectPresetPayload } from './direct-image.js';
import { loadImageSettings, validateImageSettings } from './image-settings.js';
import { applyComfyModelPreset } from './comfy-model-presets.js';
import { parseDirectKeyframeSuggestions, suggestDirectKeyframes } from './direct-keyframe-plan.js';
import { generatePreparedImage } from './image-provider.js';
import { loadImageHistory, saveImageHistory, validateImageHistoryEntry } from './image-history.js';
const defaults = {
    capture: captureDirectAssistant, settings: loadImageSettings, generate: generatePreparedImage, suggest: suggestDirectKeyframes,
    load: loadImageHistory, save: saveImageHistory, watch: callback => watchChatRendering(() => callback()), now: () => Date.now(),
};
/** Manual, local-Comfy-only path. This controller never acquires chat write authorization. */
export class DirectImageController {
    options;
    dependencies;
    selected = null;
    stopWatch = null;
    active = null;
    pendingSaves = 0;
    disposed = false;
    message = '';
    failed = false;
    get busy() { return this.active !== null || this.pendingSaves > 0; }
    constructor(options = {}, dependencies = {}) {
        this.options = options;
        this.dependencies = { ...defaults, ...dependencies };
    }
    emit() {
        try {
            this.options.onStatus?.(this.message, this.busy, this.failed);
        }
        catch { /* A rendering failure must not repeat a generation or undo committed history. */ }
    }
    report(message, failed = false) { this.message = message; this.failed = failed; this.emit(); }
    check(operation) {
        if (this.disposed || this.active !== operation || operation.abort.signal.aborted) {
            throw new DOMException('直出任务已取消或失效，请重新确认当前来源。', 'AbortError');
        }
    }
    releaseSelection(deferred = false) {
        const stop = this.stopWatch, capture = this.selected;
        this.stopWatch = null;
        this.selected = null;
        const release = () => {
            try {
                stop?.();
            }
            catch { /* Cleanup cannot revive an invalid operation. */ }
            try {
                capture?.dispose();
            }
            catch { /* Keep other native listeners and UI state intact. */ }
        };
        // Native emitters may iterate a live listener array. Removing during dispatch could skip the
        // next extension's handler, so invalidate synchronously but unsubscribe after this event.
        if (deferred)
            void Promise.resolve().then(release);
        else
            release();
    }
    stopActive() {
        const operation = this.active;
        this.active = null;
        operation?.abort.abort();
    }
    invalidate() {
        this.releaseSelection(true);
        this.stopActive();
        const message = '聊天或来源已改变，请重新选择当前 AI 正文；已提交的服务端任务可能继续。';
        this.report(message, true);
        try {
            this.options.onSourceInvalidated?.(message);
        }
        catch { /* Already invalidated. */ }
    }
    async run(message, work) {
        if (this.disposed)
            throw new Error('正文直出窗口已关闭，任务控制器已失效。');
        if (this.busy)
            throw new Error('正文直出任务或历史保存正在进行，请等待或停止本地等待。');
        const operation = { abort: new AbortController() };
        this.active = operation;
        this.report(message);
        try {
            const value = await work(operation);
            this.check(operation);
            return value;
        }
        catch (error) {
            if (this.active === operation)
                this.report(error instanceof Error ? error.message : '正文直出未完成。', true);
            throw error;
        }
        finally {
            // A cancelled, late operation must not clear the busy state or status of its replacement.
            if (this.active === operation) {
                this.active = null;
                this.emit();
            }
        }
    }
    capture() {
        if (!this.selected)
            throw new Error('请先选择并确认一个有效的 AI 正文来源。');
        return this.selected;
    }
    /** Recheck the pinned source for explicit, synchronous local reads or a card-profile save. */
    confirmSelectedSource() {
        const capture = this.capture();
        try {
            return capture.assertCurrentSync();
        }
        catch (error) {
            if (this.selected === capture)
                this.invalidate();
            throw error;
        }
    }
    verifySync(operation, capture) {
        this.check(operation);
        try {
            capture.assertCurrentSync();
        }
        catch (error) {
            if (this.selected === capture && this.active === operation)
                this.invalidate();
            throw error;
        }
        this.check(operation);
    }
    async verify(operation, capture, task) {
        this.check(operation);
        try {
            const current = await capture.assertCurrent();
            this.check(operation);
            if (task) {
                await assertDirectImageCurrent(task, current);
                this.check(operation);
            }
            // Hashing yields. Recheck the live host, not just the pre-hash snapshot and operation token.
            this.verifySync(operation, capture);
        }
        catch (error) {
            if (this.selected === capture && this.active === operation)
                this.invalidate();
            throw error;
        }
    }
    /** Capture one actual AI floor. No image request, setting change, or automatic truncation. */
    async select(source) {
        // Take primitives before the first await, not a mutable UI/source object.
        const input = { scope: source.scope, chatId: source.chatId, messageId: source.messageId,
            historyId: source.historyId, swipeId: source.swipeId, turnId: source.turnId, text: source.text };
        return this.run('正在核对 AI 楼层，只读取正文…', async (operation) => {
            this.releaseSelection();
            const capture = await this.dependencies.capture(input);
            try {
                this.check(operation);
                await this.verify(operation, capture);
                const preview = extractDirectNarrative(capture.source.text);
                if (!preview.trim())
                    throw new Error('来源没有可用于直出的可见正文，请重新选择有效 AI 楼层。');
                this.selected = capture;
                const stop = this.dependencies.watch(() => this.invalidate());
                if (this.selected !== capture || this.active !== operation || operation.abort.signal.aborted) {
                    stop();
                    this.check(operation);
                }
                this.stopWatch = stop;
                this.check(operation);
                this.report('正文已完整读取；没有调用文本模型。');
                return preview;
            }
            catch (error) {
                if (this.selected === capture)
                    this.releaseSelection();
                else
                    capture.dispose();
                throw error;
            }
        });
    }
    /** Optional metadata emitted by the main reply itself; read only from the pinned raw source. */
    readPresetKeyframe() {
        const source = this.confirmSelectedSource();
        const { narrative, payload, malformed } = readDirectPresetPayload(source.text);
        if (malformed)
            throw new Error('预设附段不在正文之外的最后一行、重复或不完整；请手选片段。');
        if (payload === null)
            return null;
        try {
            return parseDirectKeyframeSuggestions(payload, narrative, 1)[0] ?? null;
        }
        catch {
            throw new Error('预设关键帧格式或原文引文不符合约定；请手选片段。');
        }
    }
    /** Separate explicit text-only action. Never prepares an image task, loads other context or auto-submits a frame. */
    async suggestKeyframes(count) {
        return this.run('正在通过酒馆主 API 提炼关键帧草稿（未提交生图）…', async (operation) => {
            const capture = this.capture();
            await this.verify(operation, capture);
            const cleaned = extractDirectNarrative(capture.source.text);
            this.verifySync(operation, capture);
            const frames = await this.dependencies.suggest(cleaned, count, operation.abort.signal);
            await this.verify(operation, capture);
            return frames;
        });
    }
    /** The original complete source, not an edited candidate or the floor index, owns the history key. */
    async loadHistory() {
        return this.run('正在只读加载此来源的图片历史…', async (operation) => {
            const capture = this.capture();
            await this.verify(operation, capture);
            const key = await directImageHistoryKeyForSource(capture.source);
            this.verifySync(operation, capture);
            const entries = await this.dependencies.load(key);
            this.check(operation);
            await this.verify(operation, capture);
            const images = entries.filter(entry => entry.markerKey === key && entry.provider === 'comfyui').map(validateImageHistoryEntry);
            this.report(images.length ? `已读取此来源的 ${images.length} 张图片；没有重新生成。` : '此来源还没有已保存图片；读取历史不会生成。');
            return images;
        });
    }
    /** Exactly one explicit local image request; no text model, provider fallback or retry. */
    async generate(prompt, negative, preset = 'saved') {
        return this.run('正在核对来源与本次 ComfyUI 配置…', async (operation) => {
            const capture = this.capture();
            if (typeof negative !== 'string' || negative.length > 65_536)
                throw new Error('负面词无效或过长，请手动核对。');
            // Snapshot configuration at the click, before hashing, host checks, or local queue waiting.
            const loaded = this.dependencies.settings('comfyui');
            if (loaded.provider !== 'comfyui')
                throw new Error('正文直出仅使用 ComfyUI 配置，不能改用当前云端提供方。');
            const settings = validateImageSettings(structuredClone(loaded));
            if (preset !== 'saved')
                settings.comfy = applyComfyModelPreset(settings.comfy, preset);
            await this.verify(operation, capture);
            const task = await prepareDirectImage(capture.source, prompt);
            this.check(operation);
            await this.verify(operation, capture, task);
            this.verifySync(operation, capture);
            const result = await this.dependencies.generate(settings, { positive: task.preview, negative, characters: [] }, operation.abort.signal, progress => {
                if (this.active !== operation || operation.abort.signal.aborted)
                    return;
                this.report(progress.state === 'queued' ? `已加入 ComfyUI 本地队列（${progress.position}）；可停止本地等待。`
                    : '正在等待 ComfyUI 返回一张图片；停止等待不等于停止服务端。');
            });
            this.check(operation);
            await this.verify(operation, capture, task);
            if (result.provider !== 'comfyui' || result.positive !== task.preview || result.negative !== negative || result.characters.length) {
                throw new Error('ComfyUI 结果提供方或提示词身份不一致，本次结果没有保存。');
            }
            const entry = validateImageHistoryEntry({
                id: task.id, markerKey: directImageHistoryKey(task), createdAt: this.dependencies.now(), blob: result.blob,
                provider: 'comfyui', parameters: result.parameters, positive: task.preview, negative,
                title: `正文直出 · 第 ${task.source.messageId + 1} 楼`,
            });
            this.verifySync(operation, capture);
            this.pendingSaves++;
            try {
                // IDB and native chat do not share an atomic transaction. If source changes during this
                // await, a committed entry remains pinned to its immutable OLD key, never a new floor.
                await this.dependencies.save(entry);
            }
            finally {
                this.pendingSaves--;
                this.emit();
            }
            this.check(operation);
            await this.verify(operation, capture, task);
            this.report('一张原图已保存至此来源的图片历史；聊天正文未修改。');
            return entry;
        });
    }
    /** Local-only cancellation. A history transaction already committing is not claimed rolled back. */
    cancel() {
        this.stopActive();
        this.report(this.pendingSaves ? '已停止本地等待；已开始的历史保存可能完成，但只归属原来源。'
            : '已停止本地等待；ComfyUI 已提交的任务可能继续，请在服务端核对。');
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.releaseSelection();
        this.stopActive();
        this.emit();
    }
}
