const prefix = 'witch-paintbox:direct-card:v1:';
export const DIRECT_CARD_STYLE_LIMIT = 1200;
export function defaultDirectCardProfile() { return { preset: 'saved', anchorId: '', style: '', negative: '' }; }
/** Native avatar/file key, not display name, numeric character index or chat file. No implicit group binding. */
export function directCardId(source) {
    if (source.turnId !== null)
        return null;
    try {
        const key = JSON.parse(source.scope);
        return Array.isArray(key) && key.length === 2 && key[0] === 'character' && typeof key[1] === 'string'
            && key[1].trim() && key[1].length <= 1024 ? key[1] : null;
    }
    catch {
        return null;
    }
}
function storageKey(card) {
    if (typeof card !== 'string' || !card.trim() || card.length > 1024)
        throw new Error('无法确认原生角色卡身份。');
    return prefix + JSON.stringify(card);
}
function check(value) {
    const profile = value;
    if (!profile || !['saved', 'anime', 'realistic'].includes(profile.preset)
        || typeof profile.anchorId !== 'string' || profile.anchorId.length > 128
        || typeof profile.style !== 'string' || profile.style.length > DIRECT_CARD_STYLE_LIMIT
        || typeof profile.negative !== 'string' || profile.negative.length > DIRECT_CARD_STYLE_LIMIT) {
        throw new Error('角色卡绘图配方格式无效或过长，原记录未覆盖。');
    }
    const { preset, anchorId, style, negative } = profile;
    return { preset, anchorId, style: style.trim(), negative: negative.trim() };
}
export function loadDirectCardProfile(card, storage = window.localStorage) {
    const raw = storage.getItem(storageKey(card));
    return raw === null ? defaultDirectCardProfile() : check(JSON.parse(raw));
}
/** Explicit local preference only. Never saves the body, scene, image, API key or a card edit. */
export function saveDirectCardProfile(card, profile, storage = window.localStorage) {
    const key = storageKey(card);
    // Do not silently overwrite a record written by a newer or broken version.
    loadDirectCardProfile(card, storage);
    storage.setItem(key, JSON.stringify(check(profile)));
}
export function composeDirectKeyframe(scene, profile, anchors, useDefaultOutfit, baseNegative) {
    if (!scene.trim())
        throw new Error('请先选一个可见动作或填写关键帧画面。');
    const { anchorId, style, negative } = check(profile);
    const anchor = anchorId ? anchors.find(item => item.id === anchorId) : undefined;
    if (anchorId && !anchor)
        throw new Error('已绑定的角色锚定不存在，请重新选择或取消绑定。');
    const outfit = useDefaultOutfit && anchor?.selectedOutfitId ? anchor.outfits.find(item => item.id === anchor.selectedOutfitId) : undefined;
    const positive = [scene.trim(), anchor && `画面中${anchor.name}的固定外貌：${anchor.appearance}`,
        outfit && `${anchor.name}的服装：${outfit.tags}`, style && `画风：${style}`].filter(Boolean).join('\n');
    const negatives = [baseNegative.trim(), anchor?.negative.trim(), negative].filter(Boolean);
    return { positive, negative: [...new Set(negatives)].join('\n') };
}
