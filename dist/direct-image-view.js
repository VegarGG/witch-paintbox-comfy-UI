import { readAssistantMessages, watchChatRendering } from './chat-host.js';
import { DirectImageController } from './direct-image-runner.js';
import { createImageGallery } from './image-gallery.js';
import { deleteImageHistory } from './image-history.js';
import { loadImageSettings } from './image-settings.js';
import { bindPanelViewport } from './panel-viewport.js';
import { emitPetEvent } from './pet-events.js';
import { loadAnchorText } from './anchor-store.js';
import { COMFY_MODEL_PRESETS } from './comfy-model-presets.js';
import { composeDirectKeyframe, defaultDirectCardProfile, directCardId, loadDirectCardProfile, saveDirectCardProfile, DIRECT_CARD_STYLE_LIMIT } from './direct-card-profile.js';
import { MAX_DIRECT_KEYFRAME_SOURCE_LENGTH } from './direct-keyframe-plan.js';
function emptyFrame() {
    return { scene: '', evidence: '', useAnchor: true, outfit: false, positive: '', negative: '', previewed: false, generated: false };
}
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
    .direct-image-picker [data-direct-prompt] { min-height:160px; white-space:pre-wrap; }
    .direct-image-picker .direct-group { display:grid; gap:10px; min-width:0; }
    .direct-image-picker .direct-group summary { cursor:pointer; margin-bottom:8px; }
    .direct-image-picker .direct-check { display:flex; align-items:center; gap:8px; }
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
      <p class="muted">只向本机 ComfyUI 生图，不修改聊天或切换当前生图服务。手选片段不调用文本 API。</p>
      <label>原生 AI 楼层<select data-direct-source aria-label="选择原生 AI 楼层"></select></label>
      <div class="direct-actions"><button type="button" class="secondary" data-direct-refresh>重新读取楼层</button></div>
      <label>本次模型配方<select data-direct-preset></select></label>
      <p class="muted" data-direct-model></p>
      <label>生图方式<select data-direct-mode><option value="keyframe">剧情关键帧</option><option value="raw">整段原样直出</option></select></label>
      <div class="direct-group" data-direct-keyframes>
        <label>本轮张数<select data-direct-count><option value="1">1 张（人物和关键动作优先在同一张）</option><option value="2">最多 2 张（两次分别确认）</option></select></label>
        <label data-direct-slot-field hidden>正在编辑<select data-direct-slot><option value="0">关键帧 1</option><option value="1">关键帧 2</option></select></label>
        <label>完整提取正文 · 可选中文字<textarea data-direct-body readonly spellcheck="false"></textarea></label>
        <div class="direct-actions">
          <button type="button" class="secondary" data-direct-use-selection>使用选中片段</button>
          <button type="button" class="secondary" data-direct-preset-frame>读取本轮预设附段</button>
          <button type="button" class="secondary" data-direct-plan>用酒馆主 API 建议关键帧…</button>
        </div>
        <p class="muted">仅确认主 API 选帧时，把当前楼层的完整提取正文发给酒馆主文本 API（最多 ${MAX_DIRECT_KEYFRAME_SOURCE_LENGTH.toLocaleString('en-US')} 字符，按 UTF-16 计）。可能联网或计费；不会发送其他楼层、角色资料或画风配方，不会生成图片。</p>
        <p class="muted" data-direct-evidence hidden></p>
        <label>本帧画面 · 可编辑<textarea data-direct-scene placeholder="写清一个瞬间：谁在做什么，神情怎样，在哪里，从哪个角度看。" spellcheck="false"></textarea></label>
        <details class="direct-group" data-direct-card>
          <summary>角色外貌与画风配方（可选）</summary>
          <label>选择已有角色锚定<select data-direct-anchor></select></label>
          <label class="direct-check"><input type="checkbox" data-direct-use-anchor>此角色在本帧出现，加入固定外貌</label>
          <label class="direct-check"><input type="checkbox" data-direct-outfit>本帧沿用该锚定的默认服装</label>
          <label>固定画风提示词<textarea data-direct-style maxlength="${DIRECT_CARD_STYLE_LIMIT}" placeholder="例如：柔和赛璐璐上色、克制的青灰色调、参考插画式取景"></textarea></label>
          <label>固定画风负词<textarea data-direct-style-negative maxlength="${DIRECT_CARD_STYLE_LIMIT}"></textarea></label>
          <p class="muted" data-direct-card-note></p>
          <div class="direct-actions"><button type="button" class="secondary" data-direct-save-card>记住此角色卡配方</button></div>
        </details>
        <div class="direct-actions"><button type="button" class="secondary" data-direct-compose>预览本帧正负词</button></div>
      </div>
      <label>最终正面提示词 · 可编辑<textarea data-direct-prompt aria-describedby="direct-image-limit" spellcheck="false"></textarea></label>
      <p id="direct-image-limit" class="muted" data-direct-limit></p>
      <label>最终负面提示词 · 可编辑<textarea data-direct-negative spellcheck="false"></textarea></label>
      <p class="muted">提交只使用这里显示的正负词；每次点击只提交一张，结果存入来源楼层的图片历史。</p>
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
    const preset = field('preset');
    const mode = field('mode');
    const count = field('count');
    const slot = field('slot');
    const body = field('body');
    const scene = field('scene');
    const anchor = field('anchor');
    const useAnchor = field('use-anchor');
    const outfit = field('outfit');
    const style = field('style');
    const styleNegative = field('style-negative');
    const plan = field('plan');
    const pick = field('use-selection');
    const readPresetFrame = field('preset-frame');
    const compose = field('compose');
    const saveCard = field('save-card');
    let sources = [];
    let frames = [emptyFrame(), emptyFrame()];
    let frameIndex = 0;
    let frameCount = 1;
    let keyframes = true;
    let fullText = '';
    let defaultNegative = '';
    let raw = { positive: '', negative: '' };
    let card = null;
    let anchors = [];
    let cardError = '';
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
    const validPrompt = () => prompt.value.trim().length > 0 && prompt.value.length <= 6000 && negative.value.length <= 65_536;
    const current = (token) => token === version && !signal.aborted && panel.open;
    const frame = () => frames[frameIndex];
    const canEdit = () => allowed() && selected && !isBusy();
    const canGenerate = () => canEdit() && validPrompt() && (!keyframes || frame().previewed && !frame().generated);
    const canPlan = () => canEdit() && keyframes && !frames.some(draft => draft.generated)
        && fullText.length > 0 && fullText.length <= MAX_DIRECT_KEYFRAME_SOURCE_LENGTH;
    const errorText = (error) => error instanceof Error ? error.message : String(error);
    const choice = (key, text) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = text;
        return option;
    };
    preset.replaceChildren(choice('saved', '沿用已保存的 ComfyUI 配置'), ...Object.entries(COMFY_MODEL_PRESETS).map(([id, recipe]) => choice(id, `${recipe.label} · ${recipe.steps} 步`)));
    preset.value = 'saved';
    mode.value = 'keyframe';
    count.value = '1';
    slot.value = '0';
    function profile() {
        const value = preset.value === 'anime' || preset.value === 'realistic' ? preset.value : 'saved';
        return { preset: value, anchorId: anchor.value, style: style.value, negative: styleNegative.value };
    }
    function applyProfile(value) {
        preset.value = value.preset;
        const missing = value.anchorId && !anchors.some(item => item.id === value.anchorId);
        anchor.replaceChildren(choice('', '不加角色锚定'), ...anchors.map(item => choice(item.id, item.name)), ...(missing ? [choice(value.anchorId, '此卡原绑定的锚定未找到')] : []));
        anchor.value = value.anchorId;
        style.value = value.style;
        styleNegative.value = value.negative;
    }
    function rememberEdits() {
        const draft = keyframes ? frame() : raw;
        draft.positive = prompt.value;
        draft.negative = negative.value;
    }
    function paintDraft() {
        const draft = frame();
        scene.value = draft.scene;
        useAnchor.checked = draft.useAnchor;
        outfit.checked = draft.outfit;
        prompt.value = keyframes ? draft.positive : raw.positive;
        negative.value = keyframes ? draft.negative : raw.negative;
        const evidence = field('evidence');
        evidence.hidden = !draft.evidence;
        evidence.textContent = draft.evidence ? `原文依据：${draft.evidence}` : '';
    }
    function changeScene(text, evidence) {
        frame().scene = text;
        frame().evidence = evidence;
        frame().previewed = false;
        paintDraft();
        sync();
    }
    function message(text, error = false) {
        status.textContent = text;
        status.dataset.error = String(error);
        status.classList.toggle('is-error', error);
    }
    function sync() {
        const busy = isBusy();
        const editable = canEdit(), draft = frame();
        generate.disabled = !canGenerate();
        generate.textContent = keyframes && draft.generated ? `关键帧 ${frameIndex + 1} 已保存`
            : keyframes ? `仅生成关键帧 ${frameIndex + 1} · ComfyUI` : '生成一张 · ComfyUI';
        history.disabled = !editable;
        field('refresh').disabled = busy;
        source.disabled = !sources.length;
        field('keyframes').hidden = !keyframes;
        field('slot-field').hidden = frameCount !== 2;
        [mode, preset, count, slot].forEach(input => { input.disabled = !editable; });
        anchor.disabled = !editable || !keyframes;
        useAnchor.disabled = !editable || !keyframes || !anchor.value || draft.generated;
        outfit.disabled = useAnchor.disabled || !draft.useAnchor;
        style.readOnly = styleNegative.readOnly = !editable;
        plan.disabled = !canPlan();
        pick.disabled = !editable || !keyframes || draft.generated;
        readPresetFrame.disabled = pick.disabled;
        scene.readOnly = pick.disabled;
        compose.disabled = pick.disabled || !draft.scene.trim();
        saveCard.disabled = !editable || !card || !!cardError;
        const recipe = profile().preset;
        field('model').textContent = recipe === 'saved' ? '保留已保存的模型、编码器及步数，不改旧配置。'
            : `${COMFY_MODEL_PRESETS[recipe].unetName} + ${COMFY_MODEL_PRESETS[recipe].clipName} · ${COMFY_MODEL_PRESETS[recipe].steps} 步`;
        field('card-note').textContent = cardError || (card ? '只有点击记住才会在本机按原生卡文件身份保存；同卡换聊天仍复用。不会修改角色卡。'
            : '群聊不自动匹配到某张角色卡；选择只用于本轮。');
        prompt.readOnly = negative.readOnly = !editable || keyframes && (!draft.previewed || draft.generated);
        cancel.hidden = !busy;
        panel.setAttribute('aria-busy', String(busy));
        limit.textContent = `${prompt.value.length} / 6000 字符。${prompt.value.length > 6000 ? '已超限，请手动缩短；' : ''}不自动截取。${keyframes && !draft.previewed ? '请先预览本帧正负词。' : ''}`;
        limit.dataset.error = String(prompt.value.length > 6000 || negative.value.length > 65_536);
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
            message(text, error);
            sync();
        },
        onSourceInvalidated(text) {
            if (!ignoringStatus && !signal.aborted && panel.open)
                invalidate(text);
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
        frames = [emptyFrame(), emptyFrame()];
        frameIndex = 0;
        frameCount = 1;
        count.value = '1';
        slot.value = '0';
        fullText = body.value = '';
        raw = { positive: '', negative: defaultNegative };
        card = null;
        cardError = '';
        anchors = [];
        applyProfile(defaultDirectCardProfile());
        paintDraft();
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
            fullText = body.value = full; // Intentionally complete; no tail, maxlength or dynamic HTML.
            raw.positive = full;
            card = directCardId(value);
            let saved = defaultDirectCardProfile();
            try {
                if (card)
                    saved = loadDirectCardProfile(card);
            }
            catch (error) {
                cardError = `角色卡配方无法读取，原记录未覆盖。${errorText(error)}`;
            }
            try {
                const loaded = await loadAnchorText();
                if (!current(token))
                    return;
                anchors = loaded;
            }
            catch {
                if (current(token) && !cardError)
                    cardError = '角色锚定库暂不可读；不绑定锚定也可生成。重新读取楼层可重试。';
            }
            if (!current(token))
                return;
            applyProfile(saved);
            paintDraft();
            selected = true;
            message(keyframes ? '请从原文选一个可见瞬间，或手动填写；也可以单独确认调用主 API 提炼。'
                : '请核对整段正文与负词，再明确生成一张。');
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
        if (kind === 'generate' ? !canGenerate() : !canEdit()) {
            sync();
            return;
        }
        const token = ++version;
        const draft = keyframes ? frame() : null;
        working = true;
        message(kind === 'generate' ? '正在提交一张 ComfyUI 图片…' : '正在只读查询同一来源的图片历史…');
        sync();
        try {
            if (kind === 'generate') {
                const entry = await controller.generate(prompt.value, negative.value, profile().preset);
                if (!current(token))
                    return;
                if (draft)
                    draft.generated = true;
                showImages([entry], token);
                message('图片已保存至历史；未改动聊天。可以关闭图库继续核对其他帧。');
            }
            else {
                const entries = await controller.loadHistory();
                if (!current(token))
                    return;
                showImages(entries, token);
                message(entries.length ? `已读取 ${entries.length} 张历史图片；没有提交新任务。` : '此来源暂无图片历史；没有提交新任务。');
            }
        }
        catch (error) {
            if (current(token))
                message(errorText(error), true);
        }
        finally {
            if (current(token)) {
                working = false;
                sync();
            }
        }
    }
    async function runPlan() {
        if (!canPlan())
            return;
        const selection = version;
        if (!window.confirm('把当前楼层的完整提取正文发送给酒馆主文本 API，最多请求一次。该 API 可能联网和计费。若返回候选，将覆盖本轮已有的未生成草稿；不会提交生图。继续吗？')
            || !current(selection) || !canPlan())
            return;
        const token = ++version;
        working = true;
        sync();
        try {
            const proposals = await controller.suggestKeyframes(frameCount);
            if (!current(token))
                return;
            if (!proposals.length) {
                message('主 API 没有返回可用关键帧；原草稿保留，可手选片段。');
                return;
            }
            frames = [emptyFrame(), emptyFrame()];
            proposals.forEach((proposal, index) => {
                if (index < frameCount) {
                    frames[index].scene = proposal.scene;
                    frames[index].evidence = proposal.evidence;
                }
            });
            frameIndex = 0;
            slot.value = '0';
            paintDraft();
            message(`建议了 ${proposals.length} 帧。请逐帧核对原文依据、编辑画面并预览正负词；尚未提交生图。`);
        }
        catch (error) {
            if (current(token))
                message(`${errorText(error)} 原草稿保留；可改用手选片段。`, true);
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
    for (const input of [prompt, negative])
        input.addEventListener('input', () => { rememberEdits(); sync(); }, { signal });
    mode.addEventListener('change', () => {
        if (!canEdit())
            return;
        rememberEdits();
        keyframes = mode.value !== 'raw';
        paintDraft();
        sync();
    }, { signal });
    count.addEventListener('change', () => {
        if (!canEdit() || !keyframes)
            return;
        rememberEdits();
        frameCount = count.value === '2' ? 2 : 1;
        if (frameCount === 1) {
            frameIndex = 0;
            slot.value = '0';
        }
        paintDraft();
        sync();
    }, { signal });
    slot.addEventListener('change', () => {
        if (!canEdit() || !keyframes)
            return;
        rememberEdits();
        frameIndex = frameCount === 2 && slot.value === '1' ? 1 : 0;
        paintDraft();
        sync();
    }, { signal });
    preset.addEventListener('change', sync, { signal });
    for (const input of [anchor, style, styleNegative])
        input.addEventListener(input === anchor ? 'change' : 'input', () => {
            for (const draft of frames)
                if (!draft.generated)
                    draft.previewed = false;
            sync();
        }, { signal });
    useAnchor.addEventListener('change', () => { frame().useAnchor = useAnchor.checked; frame().previewed = false; sync(); }, { signal });
    outfit.addEventListener('change', () => { frame().outfit = outfit.checked; frame().previewed = false; sync(); }, { signal });
    scene.addEventListener('input', () => { frame().scene = scene.value; frame().previewed = false; sync(); }, { signal });
    pick.addEventListener('click', () => {
        if (!canEdit() || !keyframes || frame().generated)
            return;
        const text = body.value.slice(body.selectionStart, body.selectionEnd).trim();
        if (!text) {
            message('请先在完整正文中选中一个片段。', true);
            return;
        }
        if (text.length > 6000) {
            message('选中的范围太长，请缩小到一个关键瞬间（不超过 6000 字符）。', true);
            return;
        }
        changeScene(text, text);
        message('已复制选中片段。可以去掉对白、前后事件和不可见的内心描写，再预览本帧正负词。');
    }, { signal });
    readPresetFrame.addEventListener('click', () => {
        if (!canEdit() || !keyframes || frame().generated)
            return;
        try {
            const proposal = controller.readPresetKeyframe();
            if (!proposal) {
                message('此楼层没有可用的预设附段。可以手选片段，或另行确认调用酒馆主 API。');
                return;
            }
            changeScene(proposal.scene, proposal.evidence);
            message('已读取原回复中的一个关键帧草稿；没有额外调用文本 API，也没有提交生图。');
        }
        catch (error) {
            message(errorText(error), true);
        }
    }, { signal });
    plan.addEventListener('click', () => { void runPlan(); }, { signal });
    compose.addEventListener('click', () => {
        if (!canEdit() || !keyframes || frame().generated)
            return;
        try {
            const draft = frame(), other = frames[1 - frameIndex];
            if (frameCount === 2 && (draft.scene.trim() && draft.scene.trim() === other.scene.trim()
                || draft.evidence && draft.evidence === other.evidence))
                throw new Error('两帧选中了相同画面或片段；请给第二张选择不同的剧情瞬间。');
            const recipe = profile();
            if (!draft.useAnchor)
                recipe.anchorId = '';
            const { positive, negative } = composeDirectKeyframe(draft.scene, recipe, anchors, draft.outfit, defaultNegative);
            draft.positive = positive;
            draft.negative = negative;
            draft.previewed = true;
            paintDraft();
            message('正负词已组装，可以直接编辑；核对后只提交当前这一帧。');
        }
        catch (error) {
            message(errorText(error), true);
        }
        sync();
    }, { signal });
    saveCard.addEventListener('click', () => {
        if (!canEdit() || !card || cardError)
            return;
        try {
            const live = directCardId(controller.confirmSelectedSource()), value = profile();
            if (live !== card)
                throw new Error('当前角色卡已切换，请重新选择来源。');
            if (value.anchorId && !anchors.some(item => item.id === value.anchorId))
                throw new Error('角色锚定已不存在，请重新选择或清空。');
            saveDirectCardProfile(live, value);
            message('已记住当前卡的模型配方、锚定与画风；不会保存选段、服装选择或最终提示词。');
        }
        catch (error) {
            message(errorText(error), true);
        }
    }, { signal });
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
                defaultNegative = loadImageSettings('comfyui').negative;
                keyframes = true;
                mode.value = 'keyframe';
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
