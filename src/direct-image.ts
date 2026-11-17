/** Pure direct-image preparation. The caller must first verify that this is an AI message. */
export interface DirectImageSource {
  scope: string;
  chatId: string;
  messageId: number;
  swipeId: number | null;
  historyId: string | null;
  turnId: string | null;
  text: string;
}

export interface DirectImageTask {
  readonly id: string;
  /** Exact candidate shown before submission; never an automatically selected tail. */
  readonly preview: string;
  readonly source: Readonly<DirectImageSource>;
  /** Lower-case SHA-256 of every UTF-8 encoded character of source.text, including hidden text. */
  readonly fingerprint: string;
  readonly historyKey: string;
}

const MAX_PROMPT_LENGTH = 6000;
const protectedTags = new Set([
  'think', 'thinking', 'choicelist', 'options', 'option', 'summary', 'comment', 'updatevariable',
  'script', 'style', 'pre', 'code', 'textarea', 'title', 'select', 'button',
]);

interface Tag {
  name: string;
  end: number;
  attributesStart: number;
  closing: boolean;
  validClose: boolean;
  selfClosing: boolean;
  complete: boolean;
}

/** A quote-aware token, not a regex searching for a closing tag inside attribute values. */
function readTag(text: string, at: number): Tag | null {
  const prefix = /<\s*(\/?)\s*([a-z][a-z\d:_-]*)(?=[\s/>]|$)/iy;
  prefix.lastIndex = at;
  const match = prefix.exec(text);
  if (!match) return null;
  const attributesStart = prefix.lastIndex;
  let quote = '';
  let end = text.length;
  let complete = false;
  for (let index = attributesStart; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '<') break; // Malformed/unclosed tag: fail closed through EOF.
    else if (character === '>') { end = index + 1; complete = true; break; }
  }
  const tail = complete ? text.slice(attributesStart, end - 1) : '';
  return {
    name: match[2].toLowerCase(), end, attributesStart, closing: !!match[1], complete,
    validClose: complete && !!match[1] && !tail.trim(),
    selfClosing: complete && !match[1] && /\/\s*$/.test(tail),
  };
}

/** Only a real src attribute makes an ordinary HTML img void; quoted fake attributes do not. */
function hasImageSource(text: string, tag: Tag): boolean {
  let at = tag.attributesStart;
  while (at < tag.end - 1) {
    while (/\s/.test(text[at] ?? '')) at++;
    const name = /^[^\s"'<>/=]+/.exec(text.slice(at, tag.end - 1));
    if (!name) return false;
    at += name[0].length;
    while (/\s/.test(text[at] ?? '')) at++;
    if (text[at] !== '=') continue;
    at++;
    while (/\s/.test(text[at] ?? '')) at++;
    const quote = text[at];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, at + 1);
      if (close < 0 || close >= tag.end) return false;
      at = close + 1;
    } else {
      while (at < tag.end - 1 && !/\s/.test(text[at])) at++;
    }
    if (name[0].toLowerCase() === 'src') return true;
  }
  return false;
}

function commentEnd(text: string, start: number): number {
  let at = start + 4;
  let depth = 1;
  while (at < text.length) {
    const closing = text.indexOf('-->', at);
    if (closing < 0) return text.length;
    const nested = text.indexOf('<!--', at);
    if (nested >= 0 && nested < closing) { depth++; at = nested + 4; }
    else { if (--depth === 0) return closing + 3; at = closing + 3; }
  }
  return text.length;
}

function lineEnd(text: string, at: number): number {
  while (at < text.length && text[at] !== '\r' && text[at] !== '\n') at++;
  return at;
}

function nextLine(text: string, end: number): number {
  return end + (text[end] === '\r' && text[end + 1] === '\n' ? 2 : end < text.length ? 1 : 0);
}

/** Keep the closing line ending outside the opaque fence, preserving prose line breaks. */
function fenceEnd(text: string, at: number): number | null {
  if (at && text[at - 1] !== '\n' && text[at - 1] !== '\r') return null;
  const pattern = / {0,3}(?:> ?)*(`{3,}|~{3,})([^\r\n]*)/y;
  pattern.lastIndex = at;
  const open = pattern.exec(text);
  if (!open) return null;
  let line = nextLine(text, lineEnd(text, at));
  while (line < text.length) {
    pattern.lastIndex = line;
    const close = pattern.exec(text);
    if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length && !close[2].trim()) {
      return lineEnd(text, line);
    }
    line = nextLine(text, lineEnd(text, line));
  }
  return text.length;
}

function inlineCodeEnd(text: string, at: number): number {
  let end = at;
  while (text[end] === '`') end++;
  const width = end - at;
  const runs = /`+/g;
  runs.lastIndex = end;
  for (let close = runs.exec(text); close; close = runs.exec(text)) {
    if (close[0].length === width) return close.index + width;
  }
  return text.length;
}

function balancedEnd(text: string, at: number, open: string, close: string): number {
  let depth = 0;
  let quote = '';
  for (let index = at; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    // Quotes are only delimiters in an image destination, not in visible alt text.
    if (open === '(' && (character === '"' || character === "'")) { quote = character; continue; }
    if (character === open) depth++;
    else if (character === close && --depth === 0) return index + 1;
  }
  return text.length;
}

function markdownImageEnd(text: string, at: number): number {
  const labelEnd = balancedEnd(text, at + 1, '[', ']');
  if (labelEnd >= text.length) return text.length;
  let destination = labelEnd;
  while (text[destination] === ' ' || text[destination] === '\t') destination++;
  if (text[destination] === '(') return balancedEnd(text, destination, '(', ')');
  if (text[destination] === '[') return balancedEnd(text, destination, '[', ']');
  return labelEnd;
}

/** Remove unmistakable option menus without normalizing or rewriting any surviving characters. */
function withoutOptionPanels(text: string): string {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  const content = (index: number) => lines[index].replace(/[\r\n]+$/, '');
  const heading = (line: string) => /^(?:#{1,6}\s*)?(?:[【\[]\s*)?(?:选项|选择|可选行动|行动选项|下一步选项|choices?|options?)(?:\s*[】\]])?(?:\s*[:：].*|\s*)$/i
    .test(line.replace(/[*_]/g, '').trim());
  const option = (line: string) => /^\s*(?:[A-Ha-h][.)、：:]|\d{1,2}[.)、]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*+]\s+(?:\[[ xX]\]\s*)?|【\s*选项[^】]*】)\s*\S/.test(line);
  const output: string[] = [];
  let at = 0;
  while (at < lines.length) {
    if (heading(content(at))) {
      at++;
      // An unterminated menu remains excluded, not guessed to be a new scene.
      while (at < lines.length && content(at).trim() && !/^\s*(?:---+|\*\*\*+)\s*$/.test(content(at))) at++;
      if (at < lines.length && content(at).trim()) at++;
      continue;
    }
    if (option(content(at))) {
      let end = at + 1;
      let lastOptionEnd = end;
      let count = 1;
      let blank = false;
      while (end < lines.length) {
        const line = content(end);
        if (option(line)) { count++; lastOptionEnd = end + 1; blank = false; }
        else if (!line.trim()) blank = true;
        else if (!blank && /^(?: {2,}|\t)\S/.test(line)) lastOptionEnd = end + 1;
        else break;
        end++;
      }
      if (count >= 2 || /^\s*【\s*选项/.test(content(at))) { at = lastOptionEnd; continue; }
    }
    output.push(lines[at++]);
  }
  return output.join('');
}

/**
 * Conservative source-text extraction, not HTML rendering. Opaque constructs are tokenized before
 * wrapper tags, so fake closes in attributes, comments, images or code cannot expose hidden text.
 * Unclosed/mismatched protected blocks stay excluded through EOF. No DOM or host state is consulted.
 */
export function extractDirectNarrative(text: string): string {
  if (typeof text !== 'string') throw new Error('直出来源正文必须是字符串。');
  const outside: string[] = [];
  const story: string[] = [];
  const hidden: string[] = [];
  let storyDepth = 0;
  let hasStory = false;
  let at = 0;
  let plainStart = 0;
  const append = (end: number) => {
    if (end > plainStart && !hidden.length) {
      const value = text.slice(plainStart, end);
      outside.push(value);
      if (storyDepth) story.push(value);
    }
  };
  const skip = (end: number) => { append(at); at = end; plainStart = at; };
  while (at < text.length) {
    const fence = fenceEnd(text, at);
    if (fence !== null) { skip(fence); continue; }
    if (text[at] === '`') { skip(inlineCodeEnd(text, at)); continue; }
    if (text.startsWith('![', at)) { skip(markdownImageEnd(text, at)); continue; }
    if (text[at] !== '<') { at++; continue; }
    if (text.startsWith('<!--', at)) { skip(commentEnd(text, at)); continue; }
    const declarationEnd = text.startsWith('<![CDATA[', at) ? ']]>' : text.startsWith('<?', at) ? '?>' : '';
    if (declarationEnd) {
      const end = text.indexOf(declarationEnd, at + 2);
      skip(end < 0 ? text.length : end + declarationEnd.length);
      continue;
    }
    const tag = readTag(text, at);
    if (!tag) {
      if (text.startsWith('<!', at)) {
        const end = text.indexOf('>', at + 2);
        skip(end < 0 ? text.length : end + 1);
      } else at++;
      continue;
    }
    append(at);
    if (protectedTags.has(tag.name) || tag.name === 'img') {
      if (tag.closing) {
        if (tag.validClose && hidden.at(-1) === tag.name) hidden.pop();
      } else if (!tag.selfClosing && !(tag.name === 'img' && hasImageSource(text, tag))) {
        hidden.push(tag.name);
      }
    } else if (tag.name === 'storytext' && !hidden.length) {
      if (!tag.closing) { hasStory = true; if (tag.complete && !tag.selfClosing) storyDepth++; }
      else if (tag.validClose && storyDepth) storyDepth--;
    }
    at = tag.end;
    plainStart = at;
  }
  append(text.length);
  return withoutOptionPanels((hasStory ? story : outside).join(''));
}

function snapshotSource(value: DirectImageSource): Readonly<DirectImageSource> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('直出来源无效。');
  // Capture every primitive before the first await. No reference to the caller's mutable object survives.
  const source: DirectImageSource = {
    scope: value.scope, chatId: value.chatId, messageId: value.messageId, swipeId: value.swipeId,
    historyId: value.historyId, turnId: value.turnId, text: value.text,
  };
  if (typeof source.scope !== 'string' || !source.scope.trim() || typeof source.chatId !== 'string' || !source.chatId.trim()
    || !Number.isSafeInteger(source.messageId) || source.messageId < 0
    || !(source.swipeId === null || (Number.isSafeInteger(source.swipeId) && source.swipeId >= 0))
    || !(source.turnId === null || typeof source.turnId === 'string') || typeof source.text !== 'string') {
    throw new Error('直出来源字段不可用，无法确认有效 AI 来源。');
  }
  if (typeof source.historyId !== 'string' || !source.historyId.trim()) {
    throw new Error('直出来源缺少稳定 historyId，不能用消息楼层下标猜测持久身份。');
  }
  return Object.freeze(source);
}

async function sourceFingerprint(text: string): Promise<string> {
  // TextEncoder replaces lone UTF-16 surrogates with the same U+FFFD bytes. Reject such sources
  // before hashing so two different originals cannot share a persisted history key after reopening.
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (next >= 0xdc00 && next <= 0xdfff) continue;
    } else if (unit < 0xdc00 || unit > 0xdfff) continue;
    throw new Error('直出来源含无效 Unicode 字符，无法建立唯一的原文指纹；请核对来源。');
  }
  try {
    const subtle = globalThis.crypto?.subtle;
    if (typeof subtle?.digest !== 'function') throw new Error();
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    if (digest.byteLength !== 32) throw new Error();
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new Error('当前环境不支持 crypto.subtle SHA-256，无法安全验证直出来源；请使用支持 Web Crypto 的环境。');
  }
}

let taskSequence = 0n;
function uniqueTaskId(): string {
  const bytes = new Uint8Array(16);
  try { globalThis.crypto.getRandomValues(bytes); }
  catch { throw new Error('当前环境缺少安全随机数，无法创建唯一直出任务身份。'); }
  return `direct-v1-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}-${++taskSequence}`;
}

function historyKey(source: Readonly<DirectImageSource>, fingerprint: string): string {
  return JSON.stringify([source.scope, source.chatId, 'direct-v1', source.historyId,
    source.swipeId ?? 0, source.turnId ?? '', fingerprint]);
}

export async function prepareDirectImage(source: DirectImageSource, editedPrompt?: string): Promise<DirectImageTask> {
  const frozen = snapshotSource(source);
  const narrative = extractDirectNarrative(frozen.text);
  if (!narrative.trim()) throw new Error('来源没有可用于直出的可见正文，请手动选择有效 AI 正文。');
  const preview = editedPrompt === undefined ? narrative : editedPrompt;
  if (typeof preview !== 'string' || !preview.trim()) throw new Error('直出提示词候选不能为空。');
  if (preview.length > MAX_PROMPT_LENGTH) {
    throw new Error('直出提示词超过 6000 字符，请手动选择或编辑正文；不会自动截取末尾。');
  }
  const fingerprint = await sourceFingerprint(frozen.text);
  return Object.freeze({
    id: uniqueTaskId(), preview, source: frozen, fingerprint, historyKey: historyKey(frozen, fingerprint),
  });
}

/** Additional host-object identity and active-operation token checks remain the caller's responsibility. */
export async function assertDirectImageCurrent(task: DirectImageTask, current: DirectImageSource): Promise<void> {
  const snapshot = snapshotSource(current);
  const previous = task.source;
  if (snapshot.scope !== previous.scope || snapshot.chatId !== previous.chatId || snapshot.historyId !== previous.historyId
    || snapshot.turnId !== previous.turnId || snapshot.swipeId !== previous.swipeId || snapshot.messageId !== previous.messageId
    // Exact comparison also rejects distinct ill-formed UTF-16 strings that UTF-8 would replace identically.
    || snapshot.text !== previous.text || await sourceFingerprint(snapshot.text) !== task.fingerprint) {
    throw new Error('直出来源已改变或任务已失效，请重新选择当前 AI 正文。');
  }
}

export function directImageHistoryKey(task: DirectImageTask): string {
  return historyKey(task.source, task.fingerprint);
}
