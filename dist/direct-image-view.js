import { readAssistantMessages, watchChatRendering } from './chat-host.js';
import { DirectImageController } from './direct-image-runner.js';
import { createImageGallery } from './image-gallery.js';
import { deleteImageHistory } from './image-history.js';
import { loadImageSettings } from './image-settings.js';
import { bindPanelViewport } from './panel-viewport.js';
import { emitPetEvent } from './pet-events.js';
/** Independent, read-only chat preview. Only the explicit generate button may submit to ComfyUI. */
export function bindDirectImagePicker(root, signal, options = {}) {
    const panel = document.createElement('dialog');
    panel.className = 'panel illustration-picker direct-image-picker';
    panel.setAttribute('aria-labelledby', 'direct-image-picker-title');
    panel.innerHTML = `<style>
    .direct-image-picker .direct-body { display:grid; gap:14px; min-height:0; overflow:auto; padding:18px 22px; }
    .direct-image-picker .direct-body label { display:grid; gap:6px; }
    .direct-image-picker textarea, .direct-image-picker select { width:100%; min-width:0; font:inherit; }
    .direct-image-picker textarea { min-height:100px; resize:vertical; }
    .direct-image-picker [data-direct-prompt] { min-height:240px; white-space:pre-wrap; }
    .direct-image-picker .direct-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:10px; }
    .direct-image-picker p { margin:0; overflow-wrap:anywhere; }
    .direct-image-picker [data-error="true"] { color:#a3463e; }
    .direct-image-picker [hidden] { display:none; }
  </style><div class="shell">
    <header class="window-header">
      <div class="window-brand"><p class="eyebrow">魔女画匣 · 独立路径</p><h1 id="direct-image-picker-title">正文直出 / ComfyUI</h1></div>
      <button type="button" class="close-button" data-direct-close aria-label="关闭正文直出">×</button>
    </header>
    <div class="direct-body content">
      <p class="muted">只使用已保存的 ComfyUI 配置：不调用文本模型，不改聊天，不切换当前生图服务。打开、选源和查看历史不会自动提交生成。</p>
      <label>原生 AI 楼层<select data-direct-source aria-label="选择原生 AI 楼层"></select></label>
      <div class="direct-actions"><button type="button" class="secondary" data-direct-refresh>重新读取楼层</button></div>
      <label>完整提取正文 · 可手动编辑<textarea data-direct-prompt aria-describedby="direct-image-limit" spellcheck="false"></textarea></label>
      <p id="direct-image-limit" class="muted" data-direct-limit>0 / 6000 字符。超限请手动选择或编辑；不会自动截取末尾。</p>
      <label>本次负面提示词<textarea data-direct-negative spellcheck="false"></textarea></label>
      <p class="muted">负词初值来自 ComfyUI 设置；此处修改只用于本次生成，不自动保存配置。每次生成一张，结果仅存图片历史，可查看、下载、删除与重开。</p>
      <p class="status" data-direct-status role="status" aria-live="polite"></p>
      <div class="direct-actions">
        <button type="button" class="secondary" data-direct-history>查看 / 重开图片历史</button>
        <button type="button" class="secondary" data-direct-cancel hidden>取消本地等待</button>
        <button type="button" class="primary" data-direct-generate>生成一张 · ComfyUI</button>
      </div>
      <p class="muted">取消或关闭仅停止本地等待；已提交的服务端任务可能继续，不发送全局中断。</p>
    </div>
  </div>`;
    root.append(panel);
    const viewport = bindPanelViewport(panel, signal);
    const field = (name) => panel.querySelector(`[data-direct-${name}]`);
    const source = field('source');
    const prompt = field('prompt');
    const negative = field('negative');
    const status = field('status');
    const limit = field('limit');
    const generate = field('generate');
    const history = field('history');
    const cancel = field('cancel');
    let sources = [];
    let selected = false;
    let loading = false;
    let working = false;
    let version = 0;
    let opener;
    let controller;
    let ignoringStatus = false;
    let lastBusy = false;
    let images = [];
    let selectedImage = null;
    let galleryActive = false;
    const isBusy = () => !signal.aborted && (loading || working || !!controller?.busy);
    const allowed = () => !signal.aborted && (options.canStart?.() ?? true);
    const validPrompt = () => prompt.value.trim().length > 0 && prompt.value.length <= 6000;
    const current = (token) => token === version && !signal.aborted && panel.open;
    function message(text, error = false) {
        status.textContent = text;
        status.dataset.error = String(error);
        status.classList.toggle('is-error', error);
    }
    function sync() {
        const busy = isBusy();
        const canRun = allowed() && selected && validPrompt() && !busy;
        generate.disabled = !canRun;
        history.disabled = !canRun;
        field('refresh').disabled = busy;
        source.disabled = !sources.length;
        prompt.readOnly = busy;
        negative.readOnly = busy;
        cancel.hidden = !busy;
        panel.setAttribute('aria-busy', String(busy));
        limit.textContent = `${prompt.value.length} / 6000 字符。${prompt.value.length > 6000 ? '已超限，请手动选择或编辑正文；' : ''}不会自动截取末尾。`;
        limit.dataset.error = String(prompt.value.length > 6000);
        if (busy !== lastBusy) {
            lastBusy = busy;
            options.onBusyChange?.(busy);
        }
    }
    // Empty the gallery before revoking: its img/download nodes must not retain released URLs.
    function clearImages(closeGallery = true) {
        const previous = images;
        images = [];
        selectedImage = null;
        gallery.setImages([], null);
        for (const image of previous)
            URL.revokeObjectURL(image.url);
        if (closeGallery) {
            galleryActive = false;
            gallery.close();
        }
    }
    function stop() {
        version++;
        loading = false;
        working = false;
        ignoringStatus = true;
        try {
            controller?.cancel();
        }
        finally {
            ignoringStatus = false;
        }
    }
    function invalidate(text) {
        stop();
        selected = false;
        clearImages();
        // Keep the user's candidate/negative edits visible for copying, but require fresh source validation.
        message(text, true);
        sync();
    }
    const gallery = createImageGallery('正文直出 / ComfyUI', signal, {
        onSelect(id) { selectedImage = id; },
        async onDelete(id) {
            if (!images.some(image => image.entry.id === id))
                return;
            const token = version;
            await deleteImageHistory(id);
            if (!current(token))
                return;
            const removed = images.filter(image => image.entry.id === id);
            images = images.filter(image => image.entry.id !== id);
            if (!images.some(image => image.entry.id === selectedImage))
                selectedImage = images.at(-1)?.entry.id ?? null;
            gallery.setImages(images, selectedImage);
            for (const image of removed)
                URL.revokeObjectURL(image.url);
        },
    });
    root.append(gallery.element);
    controller = new DirectImageController({
        onStatus(text, _busy, error = false) {
            if (ignoringStatus || signal.aborted)
                return;
            // A cancelled IDB commit can finish after close/invalidation. Refresh busy without
            // letting that old operation replace the invalidation message or resurrect its result.
            if (!panel.open || (!selected && !loading && !working)) {
                sync();
                return;
            }
            if (error)
                invalidate(text);
            else {
                message(text);
                sync();
            }
        },
    });
    function showImages(entries, token) {
        if (!current(token))
            return;
        clearImages();
        try {
            // Record each URL immediately so partial allocation and showModal failures also release it.
            for (const entry of entries)
                images.push({ entry, url: URL.createObjectURL(entry.blob) });
            selectedImage = images.at(-1)?.entry.id ?? null;
            gallery.setImages(images, selectedImage);
            galleryActive = true;
            gallery.open();
            if (!gallery.element.open)
                throw new Error('图片查看器未能打开，请重试。');
        }
        catch (error) {
            clearImages();
            throw error;
        }
    }
    async function selectSource() {
        if (!allowed()) {
            message('请先完成或取消原有 AI 处理。', true);
            return;
        }
        stop();
        clearImages();
        selected = false;
        prompt.value = '';
        const value = sources[Number(source.value)];
        if (!value) {
            message('当前没有可用的原生 AI 正文，请切换聊天后重新读取。', true);
            sync();
            return;
        }
        const token = version;
        loading = true;
        message('正在只读提取完整正文…');
        sync();
        try {
            const full = await controller.select(value);
            if (!current(token))
                return;
            prompt.value = full; // Intentionally complete; no tail, maxlength or dynamic HTML.
            selected = true;
            message(full.length > 6000 ? '正文超过 6000 字符，请手动选择或编辑后再生成；不会自动截取。' : '请核对正文和负词，然后明确点击“生成一张”。');
        }
        catch (error) {
            if (current(token))
                message(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            if (current(token)) {
                loading = false;
                sync();
            }
        }
    }
    function readSources() {
        if (!allowed() || isBusy())
            return;
        stop();
        clearImages();
        selected = false;
        try {
            sources = readAssistantMessages();
            source.replaceChildren(...sources.map((value, index) => {
                const option = document.createElement('option');
                option.value = String(index);
                option.textContent = `AI 楼层 ${value.messageId + 1} · 回复版本 ${(value.swipeId ?? 0) + 1}${value.historyId ? '' : ' · 缺稳定身份（不可生成）'}`;
                return option;
            }));
            source.value = sources.length ? String(sources.length - 1) : '';
            void selectSource();
        }
        catch (error) {
            sources = [];
            source.replaceChildren();
            message(error instanceof Error ? error.message : String(error), true);
            sync();
        }
    }
    async function run(kind) {
        if (!allowed() || isBusy() || !selected || !validPrompt()) {
            sync();
            return;
        }
        const token = ++version;
        working = true;
        message(kind === 'generate' ? '正在提交一张 ComfyUI 图片…' : '正在只读查询同一来源的图片历史…');
        sync();
        try {
            if (kind === 'generate') {
                const entry = await controller.generate(prompt.value, negative.value);
                if (!current(token))
                    return;
                showImages([entry], token);
                message('图片已保存至历史；未改动聊天。可下载、删除，或关闭后重开历史。');
            }
            else {
                const entries = await controller.loadHistory(prompt.value);
                if (!current(token))
                    return;
                showImages(entries, token);
                message(entries.length ? `已读取 ${entries.length} 张历史图片；没有提交新任务。` : '此来源暂无图片历史；没有提交新任务。');
            }
        }
        catch (error) {
            if (current(token))
                message(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            if (current(token)) {
                working = false;
                sync();
            }
        }
    }
    function close() {
        stop();
        selected = false;
        clearImages();
        sync();
        if (panel.open)
            panel.close();
    }
    generate.addEventListener('click', () => { void run('generate'); }, { signal });
    history.addEventListener('click', () => { void run('history'); }, { signal });
    source.addEventListener('change', () => { void selectSource(); }, { signal });
    field('refresh').addEventListener('click', readSources, { signal });
    field('close').addEventListener('click', close, { signal });
    prompt.addEventListener('input', sync, { signal });
    cancel.addEventListener('click', () => {
        stop();
        clearImages();
        message('已取消本地等待；已提交的服务端任务可能继续。请核对后再操作。');
        sync();
    }, { signal });
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); }, { signal });
    panel.addEventListener('close', () => {
        if (panel.open)
            return;
        stop();
        selected = false;
        clearImages();
        sync();
        emitPetEvent({ type: 'ui', action: 'panel-close' });
        if (opener?.isConnected)
            opener.focus({ preventScroll: true });
    }, { signal });
    gallery.element.addEventListener('close', () => {
        if (!galleryActive || gallery.element.open)
            return;
        galleryActive = false;
        stop();
        clearImages(false);
        sync();
    }, { signal });
    let unwatch;
    try {
        unwatch = watchChatRendering(() => { if (panel.open)
            invalidate('聊天或来源已改变，请重新读取并选择 AI 正文；未提交的编辑仍保留。'); });
    }
    catch { /* The explicit read/select reports unavailable host details when opened. */ }
    signal.addEventListener('abort', () => {
        stop();
        unwatch?.();
        controller?.dispose();
        clearImages();
        panel.remove();
        gallery.element.remove();
        if (lastBusy) {
            lastBusy = false;
            options.onBusyChange?.(false);
        }
    }, { once: true });
    sync();
    return {
        get busy() { return isBusy(); }, close,
        open(from) {
            if (signal.aborted || panel.open || isBusy() || !allowed())
                return;
            opener = from;
            try {
                negative.value = loadImageSettings('comfyui').negative;
                panel.showModal();
                viewport.refresh();
                emitPetEvent({ type: 'ui', action: 'panel-open' });
                readSources();
            }
            catch (error) {
                close();
                const text = `无法打开正文直出：${error instanceof Error ? error.message : String(error)}`;
                message(text, true);
                // A closed dialog cannot expose its own status: use a native visible fallback, not console-only.
                window.alert(text);
            }
        },
    };
}
