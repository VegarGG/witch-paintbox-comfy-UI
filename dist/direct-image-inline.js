import { readNativeDirectDisplaySources, watchChatRendering } from './chat-host.js';
import { directImageHistoryKeyForSource } from './direct-image.js';
import { loadImageHistory, onImageHistoryChanged } from './image-history.js';
const floorSelector = '.mes[mesid]';
const editSelector = '.edit_textarea, .reasoning_edit_textarea, [contenteditable="true"]';
const structure = `${floorSelector}, .mes_text, iframe, ${editSelector}`;
function floors(root) {
    const unique = new Map();
    const seen = new Set();
    for (const block of Array.from(root.querySelectorAll(floorSelector))) {
        if (block.parentElement?.closest('.mes'))
            continue;
        const raw = block.getAttribute('mesid');
        if (!raw || !/^(0|[1-9]\d*)$/.test(raw))
            continue;
        const id = Number(raw);
        if (!Number.isSafeInteger(id))
            continue;
        if (seen.has(id)) {
            unique.delete(id);
            continue;
        }
        seen.add(id);
        const text = block.querySelector('.mes_text');
        if (!text || text.closest('.mes') !== block || block.querySelector(editSelector) || text.querySelector('iframe'))
            continue;
        if (block.getAttribute('is_user') === 'true' || block.getAttribute('is_system') === 'true')
            continue;
        unique.set(id, { id, block, text });
    }
    return unique;
}
function sameSource(a, b) {
    return a.scope === b.scope && a.chatId === b.chatId && a.messageId === b.messageId && a.swipeId === b.swipeId
        && a.historyId === b.historyId && a.turnId === b.turnId && a.text === b.text;
}
function nativeSwipeMatches(block, source) {
    const swipe = block.getAttribute('swipeid');
    return swipe === null || swipe === String(source.swipeId ?? 0);
}
function latestDirectImage(records, key) {
    // loadImageHistory returns oldest first. Non-direct, invalid MIME, or mismatched entries never mount.
    for (let index = records.length - 1; index >= 0; index--) {
        const entry = records[index];
        if (entry.markerKey === key && entry.provider === 'comfyui'
            && ['image/png', 'image/jpeg', 'image/webp'].includes(entry.blob.type))
            return entry;
    }
    return undefined;
}
const defaults = {
    root: () => document.getElementById('chat'),
    read: readNativeDirectDisplaySources, load: loadImageHistory,
    watch: watchChatRendering, watchHistory: onImageHistoryChanged,
    watchDom(invalidate, owned) {
        let root = defaults.root();
        const observer = new MutationObserver(records => {
            const current = defaults.root();
            if (current !== root) {
                root = current;
                invalidate();
                return;
            }
            if (!root)
                return;
            for (const record of records) {
                if (!root.contains(record.target))
                    continue;
                if (record.type === 'attributes') {
                    invalidate();
                    return;
                }
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                if (target?.closest('.mes_text')) {
                    invalidate();
                    return;
                }
                const changed = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
                if (changed.some(node => !owned.has(node) && node instanceof Element
                    && (node.matches(structure) || node.querySelector(structure)))) {
                    invalidate();
                    return;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['mesid', 'swipeid', 'is_user', 'is_system', 'contenteditable'] });
        return () => observer.disconnect();
    },
    mount(floor, entry, owned) {
        const figure = document.createElement('figure');
        figure.className = 'witch-paintbox-direct-image';
        figure.style.margin = '0.75em 0 0';
        const caption = document.createElement('figcaption');
        caption.textContent = '正文直出 · 本地历史';
        const image = document.createElement('img');
        image.alt = '此回复版本的正文直出配图';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.style.cssText = 'display:block;max-width:100%;max-height:70vh;width:auto;height:auto;object-fit:contain';
        owned.add(figure);
        // Native extensions may clone message DOM; a clone must not carry old pixels or blob URLs.
        figure.attachShadow({ mode: 'closed' }).append(caption, image);
        const url = URL.createObjectURL(entry.blob);
        let disposed = false;
        const dispose = () => {
            if (disposed)
                return;
            disposed = true;
            figure.remove();
            image.removeAttribute('src');
            URL.revokeObjectURL(url);
        };
        image.addEventListener('error', dispose, { once: true });
        try {
            image.src = url;
            floor.text.after(figure);
        }
        catch (error) {
            dispose();
            throw error;
        }
        return dispose;
    },
    schedule(callback) {
        const timer = setTimeout(callback, 40);
        return () => clearTimeout(timer);
    },
};
/** Presentation only: original DOM body, chat storage, prompt and generation paths stay untouched. */
export function bindDirectImageInline(signal, overrides = {}) {
    if (signal.aborted)
        return () => { };
    const deps = { ...defaults, ...overrides };
    const owned = new WeakSet();
    // A recycled floor from a different chat must receive a fresh text container
    // before it can show another chat's image, even when both use the same mesid.
    const textOwners = new WeakMap();
    const mounts = [];
    const off = [];
    let epoch = 0, stopped = false, running = false;
    let cancelSchedule;
    const active = (ticket) => !stopped && ticket === epoch;
    const clear = () => { for (const dispose of mounts.splice(0))
        dispose(); };
    async function render(ticket) {
        const root = deps.root();
        if (!root?.isConnected)
            return;
        const candidates = floors(root);
        const snapshot = deps.read([...candidates.keys()]);
        if (!snapshot || !active(ticket))
            return;
        const all = [...snapshot.sources].filter(([id, pin]) => {
            const floor = candidates.get(id);
            if (!floor || !nativeSwipeMatches(floor.block, pin.source))
                return false;
            const { scope, chatId } = pin.source;
            const owner = textOwners.get(floor.text);
            if (owner)
                return owner.scope === scope && owner.chatId === chatId;
            textOwners.set(floor.text, { scope, chatId });
            return true;
        });
        // Bound concurrent IndexedDB reads, and never persist a cache of image blobs in the view.
        for (let start = 0; start < all.length && active(ticket); start += 4) {
            const results = await Promise.all(all.slice(start, start + 4).map(async ([id, pin]) => {
                try {
                    const key = await directImageHistoryKeyForSource(pin.source);
                    if (!active(ticket))
                        return null;
                    const entry = latestDirectImage(await deps.load(key), key);
                    return entry ? { id, pin, entry } : null;
                }
                catch {
                    return null;
                }
            }));
            if (!active(ticket) || deps.root() !== root || !root.isConnected)
                return;
            const ready = results.filter(item => item !== null);
            if (!ready.length)
                continue;
            const currentFloors = floors(root);
            const current = deps.read(ready.map(item => item.id));
            if (!active(ticket) || current?.chat !== snapshot.chat)
                return;
            for (const { id, pin, entry } of ready) {
                if (!active(ticket))
                    return;
                const floor = currentFloors.get(id), was = candidates.get(id), now = current.sources.get(id);
                if (!floor || floor.block !== was?.block || floor.text !== was.text || now?.message !== pin.message
                    || !sameSource(pin.source, now.source) || !nativeSwipeMatches(floor.block, now.source))
                    continue;
                try {
                    mounts.push(deps.mount(floor, entry, owned));
                }
                catch { /* No side effect on history or host text. */ }
            }
        }
    }
    function schedule() {
        if (stopped || cancelSchedule || running)
            return;
        cancelSchedule = deps.schedule(() => {
            cancelSchedule = undefined;
            if (stopped)
                return;
            const ticket = epoch;
            running = true;
            void render(ticket).catch(() => { if (active(ticket))
                clear(); }).finally(() => {
                running = false;
                if (!active(ticket))
                    schedule();
            });
        });
    }
    function invalidate() {
        if (stopped)
            return;
        epoch++;
        clear(); // Synchronously remove old pixels before any repaint or new history lookup.
        schedule();
    }
    function stop() {
        if (stopped)
            return;
        stopped = true;
        epoch++;
        cancelSchedule?.();
        clear();
        for (const dispose of off) {
            try {
                dispose();
            }
            catch { /* Do not interrupt other teardown. */ }
        }
        signal.removeEventListener('abort', stop);
    }
    try {
        off.push(deps.watch(invalidate));
        off.push(deps.watchHistory(invalidate));
        off.push(deps.watchDom(invalidate, owned));
        signal.addEventListener('abort', stop, { once: true });
        schedule();
    }
    catch {
        stop();
    }
    return stop;
}
