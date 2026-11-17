import { saveImageSettings } from './image-settings.js';
import { validateComfySettings } from './comfy-workflow.js';
import { checkComfyConnection, listComfyTasks, resumeComfyImage, forgetComfyTask } from './comfyui.js';
const MAX_JSON = 2 * 1024 * 1024;
const loaderTypes = {
    UNETLoader: { input: 'unet_name', label: '扩散模型文件名', inventory: 'diffusionModels' },
    CLIPLoader: { input: 'clip_name', label: '文本编码器文件名', inventory: 'textEncoders' },
    VAELoader: { input: 'vae_name', label: 'VAE 文件名', inventory: 'vaes' },
};
const escape = (value) => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
function json(text) {
    if (text.length > MAX_JSON)
        throw new Error('API 或绑定 JSON 超过 2 MiB。');
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('请填写有效的 API / 绑定 JSON。');
    }
}
/** A finite settings editor, never a UI-graph converter or an executable template loader. */
export function buildComfyConfigDraft(base, draft) {
    const workflow = json(draft.workflowJson), bindings = json(draft.bindingsJson);
    // Validate *before* approval or loader assignment: approval cannot waive the finite contract.
    const comfy = validateComfySettings({ url: draft.url, workflow, bindings, parameters: draft.parameters });
    const previous = validateComfySettings(base.comfy);
    const templateChanged = JSON.stringify(comfy.workflow) !== JSON.stringify(previous.workflow)
        || JSON.stringify(comfy.bindings) !== JSON.stringify(previous.bindings);
    if (templateChanged && draft.approved !== true)
        throw new Error('修改可信 API 模板或绑定需要明确批准，请核对后勾选批准。');
    for (const field of draft.loaders) {
        const node = comfy.workflow[field.nodeId];
        const spec = node && loaderTypes[node.class_type];
        if (!spec || field.input !== spec.input || typeof field.value !== 'string' || !field.value.trim()
            || field.value.length > 512 || /[\x00-\x1f\x7f]/.test(field.value))
            throw new Error('模型加载器文件名或目标无效。');
        node.inputs[spec.input] = field.value.trim();
    }
    if (typeof draft.positive !== 'string' || typeof draft.negative !== 'string'
        || draft.positive.length > 65_536 || draft.negative.length > 65_536)
        throw new Error('正负提示词过长。');
    if (draft.negative.trim() && !comfy.bindings.negative)
        throw new Error('此 API 模板没有负面提示词绑定。');
    return { ...structuredClone(base), comfy: validateComfySettings(comfy), positive: draft.positive, negative: draft.negative };
}
function numberField(key, label, value, min, max, step = 1) {
    return `<label class="config-field"><span>${label}</span><input type="number" data-comfy-parameter="${key}" value="${escape(value)}" min="${min}" max="${max}" step="${step}" required></label>`;
}
export function comfyTaskView(tasks) {
    if (!tasks.length)
        return '<p class="config-status">暂无本页会话的 ComfyUI 任务记录。</p>';
    return tasks.map(task => `<div class="parameter-group">
    <p class="config-status">本地任务 ${escape(task.taskId)} · 服务端编号 ${task.promptId ? escape(task.promptId) : '未取得'} · ${escape(task.state)}<br>
      ${escape(task.url)}<br>${task.mayContinue ? '服务端可能继续；清除本地记录不代表取消服务端任务。' : '当前记录未标记服务端继续。'}
      ${task.persisted ? '最小编号保存在本浏览器页签会话。' : 'page-only：编号仅在当前页面内存，刷新或关闭后可能丢失。'}</p>
    <div class="artist-actions"><button type="button" class="text-button" data-comfy-action="resume" data-comfy-task="${escape(task.taskId)}"${task.promptId ? '' : ' disabled'}>仅恢复查询</button>
      <button type="button" class="text-button" data-comfy-action="forget" data-comfy-task="${escape(task.taskId)}">清除本地记录</button></div>
    ${task.promptId ? '' : '<p class="config-status">未取得服务端编号，不能恢复；请到 ComfyUI 核对，没有自动重提。</p>'}
  </div>`).join('') + '<p class="config-status">恢复只 GET 原任务，不发送新任务。编号日志没有原提示词；恢复图片仅显示和下载，不编造正文、不写聊天历史或回顾。</p>';
}
/** Shares existing CSS, saveImageSettings, output and generation selectors; no extra storage. */
export function comfySettingsView(settings) {
    const c = settings.comfy, p = c.parameters;
    const loaders = Object.entries(c.workflow).flatMap(([nodeId, node]) => {
        const spec = loaderTypes[node.class_type];
        if (!spec)
            return [];
        return [`<label class="config-field"><span>${spec.label} · 节点 ${escape(nodeId)}</span><input type="text" data-comfy-loader-node="${escape(nodeId)}" data-comfy-loader-input="${spec.input}" value="${escape(String(node.inputs[spec.input] ?? ''))}" list="comfy-${spec.inventory}" maxlength="512" autocomplete="off" spellcheck="false" required></label>`];
    }).join('');
    return `<section class="config-section" aria-labelledby="comfy-connection-heading">
    <header class="section-heading"><span class="section-index" aria-hidden="true">01</span><h2 class="section-title" id="comfy-connection-heading">ComfyUI 本机连接</h2><p class="section-description">基础原生 MOSS 单图模板；不使用云端密钥、NAI 参数或文本扩写模型。</p></header>
    <label class="config-field"><span>本机服务 URL</span><input type="url" data-comfy-url value="${escape(c.url)}" maxlength="2048" autocomplete="off" spellcheck="false" required></label>
    <p class="config-status">只允许 localhost / 127.0.0.1 / [::1]，不含账号、查询参数或锚点。不会自动启动服务。</p>
    <div class="parameter-grid">${loaders}</div>
    <datalist id="comfy-diffusionModels"></datalist><datalist id="comfy-textEncoders"></datalist><datalist id="comfy-vaes"></datalist>
    <button type="button" class="text-button" data-comfy-action="check">检查连接 / 更新模型枚举（仅 GET）</button>
    <p class="config-status" data-comfy-check-status role="status">可以手填已核对的模型文件名；枚举更新不自动改选。检查就绪不等于实际加载模型或成功出图。</p>
  </section>
  <section class="config-section" aria-labelledby="comfy-parameters-heading">
    <header class="section-heading"><span class="section-index" aria-hidden="true">02</span><h2 class="section-title" id="comfy-parameters-heading">ComfyUI 生图配置</h2><p class="section-description">默认 512×640；固定画幅、batch=1，所有参数均绑定至实际采样输出。</p></header>
    <div class="parameter-grid">
      ${numberField('width', '宽度', p.width, 256, 2048, 16)}${numberField('height', '高度', p.height, 256, 2048, 16)}
      ${numberField('seed', '种子（0 是固定值）', p.seed, 0, Number.MAX_SAFE_INTEGER)}${numberField('steps', '步数', p.steps, 1, 100)}
      ${numberField('cfg', 'CFG', p.cfg, 0, 30, 0.1)}${numberField('shift', 'Shift', p.shift, 0.01, 100, 0.01)}
      <label class="config-field"><span>采样器</span><input type="text" data-comfy-parameter="sampler" value="${escape(p.sampler)}" maxlength="100" pattern="[a-zA-Z0-9_-]+" required></label>
      <label class="config-field"><span>调度器</span><input type="text" data-comfy-parameter="scheduler" value="${escape(p.scheduler)}" maxlength="100" pattern="[a-zA-Z0-9_-]+" required></label>
    </div><p class="config-status">宽高为 16 的倍数，256–2048；种子必须非负整数，0 不随机。采样器与调度器须为本机支持值，检查会核对，不自动替换。</p>
    <div class="artist-fields"><label class="config-field"><span>正面提示词</span><textarea data-comfy-positive rows="4" maxlength="65536" spellcheck="false">${escape(settings.positive)}</textarea></label>
      <label class="config-field"><span>负面提示词</span><textarea data-comfy-negative rows="3" maxlength="65536" spellcheck="false">${escape(settings.negative)}</textarea></label></div>
    <p class="config-status">正负词按原文结构化发送，不经文本模型、角色 anchor 或 NAI 分栏扩展。</p>
    <details class="advanced-parameters"><summary>高级：可信 API JSON / 绑定 JSON</summary>
      <p class="config-status">仅支持有限 MOSS 原生节点合同；不接受带 nodes/links 的 UI 图，不执行脚本。修改模板或绑定需先核对并明确批准。文件导入只填编辑框，不自动应用。</p>
      <label class="config-field"><span>API JSON</span><textarea data-comfy-json="workflow" rows="8" spellcheck="false">${escape(JSON.stringify(c.workflow, null, 2))}</textarea></label>
      <label class="config-field"><span>导入 API JSON 文件</span><input type="file" data-comfy-file="workflow" accept="application/json,.json"></label>
      <label class="config-field"><span>绑定 JSON</span><textarea data-comfy-json="bindings" rows="6" spellcheck="false">${escape(JSON.stringify(c.bindings, null, 2))}</textarea></label>
      <label class="config-field"><span>导入绑定 JSON 文件</span><input type="file" data-comfy-file="bindings" accept="application/json,.json"></label>
      <div class="parameter-toggles"><label><input type="checkbox" data-comfy-approved>我已核对并明确批准替换可信 API 模板和绑定</label></div>
    </details>
    <button type="button" class="text-button" data-comfy-action="save">应用并保存 ComfyUI 配置</button>
    <p class="config-status" data-comfy-save-status role="status">沿用现有 TT 扩展 / 本机配置保存；修改后请先保存，再生成。基础模板已内置。</p>
  </section>
  <section class="config-section" aria-labelledby="comfy-tasks-heading"><header class="section-heading"><span class="section-index" aria-hidden="true">03</span><h2 class="section-title" id="comfy-tasks-heading">任务编号与恢复</h2></header>
    <div data-comfy-tasks>${comfyTaskView(listComfyTasks())}</div>
    <button type="button" class="text-button" data-comfy-action="cancel" hidden>停止本地查询等待</button>
    <p class="config-status" data-comfy-task-status role="status"></p>
  </section>
  <section class="generation-area" aria-label="生成图片"><button type="button" class="generation-trigger" data-action="generate"><strong>点击生成图片</strong><span>使用当前配置连接 ComfyUI</span></button>
    <div data-output></div><div class="generation-actions"><button type="button" class="text-button" data-action="cancel-generation" hidden>取消等待</button></div><p class="config-status" data-generation-status role="status"></p></section>`;
}
export class ComfyConfigPanel {
    settings;
    options;
    container = null;
    listeners = null;
    request = null;
    saving = false;
    dirty = false;
    importing = 0;
    generationBusy = false;
    revision = 0;
    disposed = false;
    get hasPendingWrites() { return this.saving || this.importing > 0; }
    get isBusy() { return this.saving || this.importing > 0 || this.request !== null; }
    constructor(settings, options) {
        this.settings = settings;
        this.options = options;
    }
    mount(container) {
        this.unmount();
        this.disposed = false;
        this.container = container;
        container.innerHTML = comfySettingsView(this.settings);
        this.listeners = new AbortController();
        const { signal } = this.listeners;
        container.addEventListener('input', event => this.edit(event), { signal });
        container.addEventListener('change', event => { void this.importFile(event); }, { signal });
        container.addEventListener('click', event => { void this.click(event); }, { signal });
    }
    unmount() { this.listeners?.abort(); this.request?.abort(); this.container = null; }
    destroy() { this.disposed = true; this.revision++; this.unmount(); }
    refreshTasks() {
        const host = this.container?.querySelector('[data-comfy-tasks]');
        if (host)
            host.innerHTML = comfyTaskView(listComfyTasks());
        this.syncBusy();
    }
    setGenerationBusy(busy) {
        if (this.generationBusy === busy)
            return;
        this.generationBusy = busy;
        this.syncBusy();
    }
    assertSaved() {
        if (this.isBusy)
            throw new Error('请先完成 ComfyUI 保存、检查或恢复查询。');
        if (this.dirty)
            throw new Error('ComfyUI 配置有未保存修改，请先应用并保存。');
        validateComfySettings(this.settings.comfy);
    }
    message(area, text, error = false) {
        const node = this.container?.querySelector(`[data-comfy-${area}-status]`);
        if (node) {
            node.textContent = text;
            node.classList.toggle('is-error', error);
        }
    }
    edit(event) {
        if (this.isBusy || this.generationBusy)
            return;
        const field = event.target;
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
            return;
        if (field.dataset.comfyFile)
            return;
        this.dirty = true;
        this.revision++;
        if (field.dataset.comfyJson) {
            const approved = this.container?.querySelector('[data-comfy-approved]');
            if (approved)
                approved.checked = false;
        }
        this.message('save', '当前修改尚未保存；检查枚举不代表已保存或实际出图。');
    }
    readDraft() {
        const host = this.container;
        if (!host)
            throw new Error('ComfyUI 设置面板已关闭。');
        const value = (selector) => {
            const field = host.querySelector(selector);
            if (!field)
                throw new Error('ComfyUI 配置字段缺失。');
            return field.value;
        };
        const parameters = { ...this.settings.comfy.parameters };
        for (const field of Array.from(host.querySelectorAll('[data-comfy-parameter]'))) {
            if (!field.checkValidity() || field.value === '') {
                field.reportValidity();
                throw new Error('请核对 ComfyUI 参数。');
            }
            const key = field.dataset.comfyParameter;
            if (key === 'sampler' || key === 'scheduler')
                parameters[key] = field.value;
            else if (Object.hasOwn(parameters, key))
                parameters[key] = Number(field.value);
        }
        const approved = host.querySelector('[data-comfy-approved]')?.checked === true;
        const loaders = Array.from(host.querySelectorAll('[data-comfy-loader-node]')).map(field => ({
            nodeId: field.dataset.comfyLoaderNode, input: field.dataset.comfyLoaderInput, value: field.value,
        }));
        // Do not silently override a newly approved graph with stale loader editor values, or silently
        // discard a simultaneous loader edit. Save template replacement separately in that case.
        const workflowJson = value('[data-comfy-json="workflow"]');
        const changedGraph = JSON.stringify(json(workflowJson)) !== JSON.stringify(this.settings.comfy.workflow);
        if (changedGraph && loaders.some(field => field.value !== this.settings.comfy.workflow[field.nodeId]?.inputs[field.input])) {
            throw new Error('请先单独保存并批准 API 模板修改，再修改模型文件名；不会静默丢弃其中任一修改。');
        }
        return buildComfyConfigDraft(this.settings, { url: value('[data-comfy-url]'), parameters,
            loaders: changedGraph ? [] : loaders, positive: value('[data-comfy-positive]'), negative: value('[data-comfy-negative]'),
            workflowJson, bindingsJson: value('[data-comfy-json="bindings"]'), approved });
    }
    syncBusy() {
        const disabled = this.isBusy || this.generationBusy;
        for (const control of Array.from(this.container?.querySelectorAll('input, textarea, button[data-comfy-action]') ?? [])) {
            if (control.dataset.comfyAction === 'cancel') {
                control.hidden = this.request === null;
                control.disabled = false;
            }
            else
                control.disabled = disabled || control.dataset.comfyAction === 'resume' && !listComfyTasks().find(t => t.taskId === control.dataset.comfyTask)?.promptId;
        }
        this.options.onBusyChange?.();
    }
    async importFile(event) {
        const field = event.target;
        if (!(field instanceof HTMLInputElement) || !field.dataset.comfyFile || this.isBusy || this.generationBusy)
            return;
        const kind = field.dataset.comfyFile, file = field.files?.[0];
        if (!file || !['workflow', 'bindings'].includes(kind))
            return;
        this.importing++;
        this.syncBusy();
        try {
            if (file.size > MAX_JSON)
                throw new Error('JSON 文件超过 2 MiB。');
            const text = await file.text(), parsed = json(text);
            const other = this.container?.querySelector(`[data-comfy-json="${kind === 'workflow' ? 'bindings' : 'workflow'}"]`);
            if (!other || this.disposed)
                return;
            // Pair is validated on save/check, allowing both files to be imported in either order.
            // Reject UI graphs immediately even before their matching bindings file is imported.
            if (kind === 'workflow' && parsed && typeof parsed === 'object' && ('nodes' in parsed || 'links' in parsed))
                throw new Error('请导入 API JSON，不接受 UI 图。');
            const input = this.container.querySelector(`[data-comfy-json="${kind}"]`);
            input.value = text;
            const approved = this.container.querySelector('[data-comfy-approved]');
            if (approved)
                approved.checked = false;
            this.dirty = true;
            this.revision++;
            this.message('save', '文件仅填入编辑框；请核对完整 API / 绑定，明确批准后应用并保存。');
        }
        catch (error) {
            this.message('save', error.message, true);
        }
        finally {
            field.value = '';
            this.importing--;
            this.syncBusy();
        }
    }
    async click(event) {
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const button = target.closest('button[data-comfy-action]');
        const action = button?.dataset.comfyAction;
        if (!action)
            return;
        if (action === 'cancel') {
            this.request?.abort();
            return;
        }
        if (this.isBusy || this.generationBusy)
            return;
        try {
            if (action === 'save')
                await this.save();
            if (action === 'check')
                await this.check();
            if (action === 'resume') {
                const receipt = listComfyTasks().find(task => task.taskId === button.dataset.comfyTask);
                if (!receipt)
                    throw new Error('任务记录已不存在。');
                await this.resume(receipt);
            }
            if (action === 'forget') {
                const receipt = listComfyTasks().find(task => task.taskId === button.dataset.comfyTask);
                if (!receipt)
                    return;
                if (!window.confirm(`确认只清除本地任务 ${receipt.taskId}（服务端编号 ${receipt.promptId ?? '未取得'}）？\n服务端可能继续。此操作不会取消、删除服务端任务，也不能撤回已提交的绘图。请先到 ComfyUI 核对。`))
                    return;
                forgetComfyTask(receipt.taskId);
                this.refreshTasks();
                this.message('task', '已按确认清除本地编号；没有向服务端发送取消或删除。');
            }
        }
        catch (error) {
            this.message(action === 'check' ? 'check' : action === 'save' ? 'save' : 'task', error.message, true);
        }
    }
    async save() {
        const next = this.readDraft();
        this.saving = true;
        this.syncBusy();
        try {
            await saveImageSettings(next);
            this.settings = next;
            this.dirty = false;
            this.options.onSaved(next);
            if (this.container && !this.disposed) {
                // Rebuild approved loader fields after a graph replacement; no old field can overwrite a new loader.
                this.container.innerHTML = comfySettingsView(next);
                this.message('save', 'ComfyUI 配置已通过有限合同校验并保存；没有加载模型或生成图片。');
            }
        }
        finally {
            this.saving = false;
            this.syncBusy();
        }
    }
    async check() {
        const next = this.readDraft(), request = new AbortController(), revision = this.revision;
        this.request = request;
        this.syncBusy();
        this.message('check', '正在仅 GET 检查服务、节点和模型枚举；不加载模型、不生成图片…');
        try {
            // Inspect the values that generation would actually bind, not stale numeric literals in JSON.
            const checking = structuredClone(next.comfy);
            for (const [key, value] of Object.entries(checking.parameters)) {
                const binding = checking.bindings[key];
                checking.workflow[binding.nodeId].inputs[binding.input] = value;
            }
            const status = await checkComfyConnection(checking, request.signal);
            if (this.disposed || request.signal.aborted || revision !== this.revision)
                return;
            this.updateInventory(status);
            this.message('check', `服务可达 · ${status.version} · ${status.ready ? '节点与模型枚举就绪' : '尚未准备'}。${status.issues.join('；')}${status.issues.length ? '。' : ''}当前模型文件名保持不变；这不等于实际加载或成功出图。`, !status.ready);
        }
        catch (error) {
            if (!this.disposed)
                this.message('check', request.signal.aborted ? '已停止本地检查。' : error.message, !request.signal.aborted);
        }
        finally {
            if (this.request === request)
                this.request = null;
            this.syncBusy();
        }
    }
    updateInventory(status) {
        for (const [name, models] of Object.entries(status.inventory)) {
            const list = this.container?.querySelector(`#comfy-${name}`);
            if (list)
                list.innerHTML = models.map(value => `<option value="${escape(value)}"></option>`).join('');
        }
    }
    async resume(receipt) {
        if (!receipt.promptId)
            throw new Error('没有服务端任务编号；请到 ComfyUI 核对。');
        const request = new AbortController();
        this.request = request;
        this.syncBusy();
        this.message('task', `仅查询服务端任务 ${receipt.promptId}；没有重新提交。服务端可能继续。`);
        try {
            const result = await resumeComfyImage(receipt, request.signal, { onTask: () => { if (!this.disposed)
                    this.refreshTasks(); } });
            if (this.disposed || request.signal.aborted)
                return;
            this.options.onRecovered(result);
            this.message('task', '已恢复图片，只显示和下载；日志没有原提示词，不编造正文，不写聊天历史或回顾。');
        }
        catch (error) {
            if (!this.disposed)
                this.message('task', error.message, !request.signal.aborted);
        }
        finally {
            if (this.request === request)
                this.request = null;
            if (!this.disposed)
                this.refreshTasks();
        }
    }
}
