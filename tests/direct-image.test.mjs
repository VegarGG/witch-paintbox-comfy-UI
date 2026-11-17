import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertDirectImageCurrent, directImageHistoryKey, extractDirectNarrative,
  prepareDirectImage } from '../dist/direct-image.js';

const source = (overrides = {}) => ({
  scope: 'character:witch', chatId: 'chat-A', messageId: 8, swipeId: 0,
  historyId: 'stable-history-A', turnId: 'turn-A', text: '<StoryText>第一段。\n第二段。</StoryText>',
  ...overrides,
});
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

test('StoryText contains the full visible Chinese narrative, with exact line endings and characters', () => {
  const body = '\r\n第一段，月光洒落。\r\n\r\n第二段：她说“你好”。\n甲 &amp; 乙，emoji 🌙，e\u0301。\r';
  const original = `前言，不应出图。<StOrYtExT\n title="a > b">${body}</sToRyTeXt>\n附录，也不应出图。`;
  assert.equal(extractDirectNarrative(original), body);
  assert.equal(original, `前言，不应出图。<StOrYtExT\n title="a > b">${body}</sToRyTeXt>\n附录，也不应出图。`);
});

test('visible HTML text and all StoryText bodies survive, not their attributes or appendices', () => {
  assert.equal(extractDirectNarrative('前言<StoryText><p title=">">甲</p>\n乙</StoryText>附录<StoryText>丙</StoryText>尾注'), '甲\n乙丙');
  assert.equal(extractDirectNarrative('<StoryText>甲<StoryText>乙</StoryText>丙</StoryText>尾注'), '甲乙丙');
  assert.equal(extractDirectNarrative('外部正文<StoryText />附录'), '');
  assert.equal(extractDirectNarrative('普通正文。\n第二行。'), '普通正文。\n第二行。');
});

test('all protected blocks are case insensitive, multiline, nested and fail closed', () => {
  for (const tag of ['think', 'thinking', 'ChoiceList', 'options', 'summary', 'comment', 'UpdateVariable',
    'script', 'style', 'pre', 'code', 'textarea', 'option', 'select']) {
    const upper = tag.toUpperCase();
    assert.equal(extractDirectNarrative(`<StoryText>甲<${upper}\n data-label="a > b">秘密\n<${tag}>嵌套秘密</${tag}>仍是秘密</${upper}>乙</StoryText>`), '甲乙', tag);
    assert.equal(extractDirectNarrative(`甲<${tag}>秘密\n永不泄漏`), '甲', `${tag}: unclosed`);
    assert.equal(extractDirectNarrative(`<${tag}>全部隐藏</${tag}>`), '', tag);
  }
});

test('quoted pseudo-closes and fake closes in comments or code cannot end a protected block', () => {
  for (const hidden of [
    '<think data-x="</think> >">秘密</think>',
    '<think><div title="</think>">秘密</div></think>',
    '<think><!-- </think> -->仍是秘密</think>',
    '<think>\n```html\n</think>\n```\n仍是秘密</think>',
    '<think>`</think>`仍是秘密</think>',
    '<think>秘密</think bogus>仍是秘密</think>',
    '<think><summary>嵌套</think>仍是秘密</summary>',
    '<think data-x="未闭合 > 秘密',
  ]) {
    const text = `甲${hidden}`;
    assert.equal(extractDirectNarrative(text), '甲', hidden);
  }
  assert.equal(extractDirectNarrative('甲<think><!-- </think> -->隐藏</think>乙'), '甲乙');
});

test('comments, declarations and hidden StoryText never create visible narrative candidates', () => {
  for (const hidden of ['<!-- <StoryText>秘密</StoryText> -->', '<think><StoryText>秘密</StoryText></think>',
    '```html\n<StoryText>秘密</StoryText>\n```', '<![CDATA[<StoryText>秘密</StoryText>]]>']) {
    assert.equal(extractDirectNarrative(`正文。\n${hidden}\n尾部正文。`), '正文。\n\n尾部正文。');
  }
  assert.equal(extractDirectNarrative('甲<!-- 外层 <!-- 内层 --> 仍隐藏 -->乙'), '甲乙');
  assert.equal(extractDirectNarrative('甲<!-- 未闭合\n秘密'), '甲');
  assert.equal(extractDirectNarrative('<StoryText>甲<!-- </StoryText> -->乙</StoryText>附录'), '甲乙');
});

test('fenced code, inline code and existing image syntax are never narrative', () => {
  for (const hidden of ['```js\nsecret();\n```', '~~~html\n<StoryText>秘密</StoryText>\n~~~',
    '`secret()`', '``a ` b``', '<img>\n[旧图片]\nold prompt\n</img>', '<img><img>nested</img>old prompt</img>',
    '<img src="data:image/png;base64,secret" alt="秘密 >" />', '![秘密](https://example.invalid/image_(1).png "title")',
    '![秘密][image-reference]']) {
    assert.equal(extractDirectNarrative(`正文。\n${hidden}\n后文。`), '正文。\n\n后文。', hidden);
  }
  for (const hidden of ['```js\nsecret', '`secret', '<img>\nold prompt']) {
    assert.equal(extractDirectNarrative(`甲\n${hidden}`), '甲\n', hidden);
  }
});

test('obvious plain-text option panels and menu rows are excluded, not Chinese prose', () => {
  for (const options of ['选项：\nA. 向左\nB. 向右', '**Options:**\n1. left\n2. right',
    '### 可选行动\n- 推门\n- 离开', '【选项】\nA. 向左\nB. 向右',
    'A. 向左\n  选项的说明，不能当场景。\nB. 向右',
    'A. 向左\n\nB. 向右', 'A. 向左\nB. 向右', '1. 推门\n2. 离开', '① 前进\n② 后退']) {
    const value = extractDirectNarrative(`<StoryText>第一段。\n${options}\n\n第二段。</StoryText>`);
    assert.equal(value, '第一段。\n\n第二段。', options);
  }
  assert.equal(extractDirectNarrative('<StoryText>她选择了向左。\nA 是她的名字。</StoryText>'), '她选择了向左。\nA 是她的名字。');
});

test('default preview is the entire extracted body, never a tail or an automatic shortening', async () => {
  const body = `开头哨兵。${'正文甲乙。'.repeat(900)}结束哨兵。`;
  const task = await prepareDirectImage(source({ text: `<StoryText>${body}</StoryText>` }));
  assert.equal(task.preview, body);
  assert.ok(task.preview.startsWith('开头哨兵。'));
  assert.ok(task.preview.endsWith('结束哨兵。'));
  assert.equal((await prepareDirectImage(source({ text: '甲'.repeat(6000) }))).preview.length, 6000);
  await assert.rejects(prepareDirectImage(source({ text: '甲'.repeat(6001) })), /6000.*(?:手动|选择|编辑)|(?:手动|选择|编辑).*6000/);
});

test('valid edited prompt is exact and bounded but fingerprints the full unmodified source', async () => {
  const original = '<think>秘密</think><StoryText>原文\r\n正文 &amp; 🌙。</StoryText>尾注';
  const input = source({ text: original });
  const task = await prepareDirectImage(input, '  用户候选，保留空格。\n第二行。  ');
  assert.equal(task.preview, '  用户候选，保留空格。\n第二行。  ');
  assert.equal(task.fingerprint, sha256(original));
  assert.equal(task.source.text, original);
  assert.equal(input.text, original);
  assert.equal((await prepareDirectImage(source({ text: '甲'.repeat(6001) }), '用户手动选择的一段')).preview, '用户手动选择的一段');
  for (const edited of ['', ' \r\n\t ', '甲'.repeat(6001), null, 3]) {
    await assert.rejects(prepareDirectImage(input, edited), /提示词|候选|6000/);
  }
  assert.equal((await prepareDirectImage(input, '甲'.repeat(6000))).preview.length, 6000);
});

test('empty extraction is rejected even when user supplies a usable edited prompt', async () => {
  for (const text of ['', '\n \t', '<think>秘密</think>', '<StoryText><ChoiceList>秘密</ChoiceList></StoryText>',
    '前言<StoryText></StoryText>尾注', '```\ncode\n```', '<StoryText>选项：\nA. 左\nB. 右</StoryText>']) {
    await assert.rejects(prepareDirectImage(source({ text }), '不能仅对隐藏区块出图'), /正文|来源/);
  }
});

test('task and copied source are frozen, including mutations while hashing is pending', async () => {
  const input = source();
  const original = { ...input };
  const pending = prepareDirectImage(input);
  Object.assign(input, { scope: 'other', chatId: 'elsewhere', messageId: 999, swipeId: 7,
    historyId: 'mutated', turnId: 'mutated-turn', text: '后改的正文' });
  const task = await pending;
  assert.deepEqual(task.source, original);
  assert.notEqual(task.source, input);
  assert.equal(task.fingerprint, sha256(original.text));
  assert.ok(Object.isFrozen(task));
  assert.ok(Object.isFrozen(task.source));
  assert.throws(() => { task.preview = '覆盖'; }, TypeError);
  assert.throws(() => { task.source.text = '覆盖'; }, TypeError);
});

test('history uses stable source identity and full SHA256, never the mutable floor index', async () => {
  const input = source({ scope: 'scope|["', chatId: 'chat,]"', historyId: 'stable,]"', swipeId: null, turnId: null });
  const first = await prepareDirectImage(input);
  const again = await prepareDirectImage(input, 'edited');
  const reordered = await prepareDirectImage({ ...input, messageId: 42 });
  const expected = JSON.stringify([input.scope, input.chatId, 'direct-v1', input.historyId, 0, '', sha256(input.text)]);
  assert.equal(first.historyKey, expected);
  assert.equal(directImageHistoryKey(first), expected);
  assert.equal(again.historyKey, expected);
  assert.equal(reordered.historyKey, expected);
  assert.notEqual(first.id, again.id);
  assert.notEqual(first.id, reordered.id);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(assertDirectImageCurrent(first, { ...input, messageId: 42 }), /来源|失效|改变/);
  assert.equal(new Set((await Promise.all(Array.from({ length: 32 }, () => prepareDirectImage(input)))).map(task => task.id)).size, 32);
});

test('each stable identity or original-text change produces a separately traceable history key', async () => {
  const input = source();
  const first = await prepareDirectImage(input);
  for (const changed of [{ scope: 'other' }, { chatId: 'other' }, { historyId: 'other' }, { swipeId: 1 },
    { turnId: 'other' }, { text: `${input.text}\n附录变更` }]) {
    assert.notEqual((await prepareDirectImage({ ...input, ...changed })).historyKey, first.historyKey);
  }
});

test('current assertion rejects chat/swipe/turn/history/floor movement and every original-character edit', async () => {
  const input = source({ text: '<think>隐藏甲</think><StoryText>甲\r\n乙 🌙 e\u0301。</StoryText>' });
  const task = await prepareDirectImage(input, '不同编辑词不影响来源校验');
  await assert.doesNotReject(assertDirectImageCurrent(task, { ...input }));
  for (const changed of [{ scope: 'other' }, { chatId: 'other' }, { historyId: 'other' }, { turnId: null },
    { swipeId: 1 }, { swipeId: null }, { messageId: input.messageId + 1 },
    { text: input.text.replace('隐藏甲', '隐藏乙') }, { text: input.text.replace('\r\n', '\n') },
    { text: input.text.replace('e\u0301', 'é') }, { text: `${input.text} ` }]) {
    await assert.rejects(assertDirectImageCurrent(task, { ...input, ...changed }), /来源|失效|改变/);
  }
});

test('ill-formed Unicode cannot create colliding persisted source identities through UTF-8 replacement', async () => {
  for (const text of ['正文\ud800。', '正文\ud801。', '正文\udc00。']) {
    await assert.rejects(prepareDirectImage(source({ text })), /来源|Unicode/);
  }
  const input = source({ text: '正文🌿。' }), task = await prepareDirectImage(input);
  assert.equal(task.source.text, input.text);
  await assert.rejects(assertDirectImageCurrent(task, { ...input, text: '正文\ud801。' }), /来源|失效|改变/);
});

test('unusable source fields are rejected without inventing an identity from the message index', async () => {
  const input = source();
  for (const changed of [{ historyId: null }, { historyId: '' }, { historyId: '  ' }, { historyId: undefined },
    { historyId: 8 }, { scope: '' }, { scope: null }, { chatId: ' ' }, { chatId: undefined },
    { messageId: -1 }, { messageId: 0.5 }, { messageId: NaN }, { messageId: Infinity }, { messageId: '8' },
    { swipeId: -1 }, { swipeId: 0.5 }, { swipeId: undefined }, { turnId: 4 }, { turnId: undefined },
    { text: null }, { text: undefined }]) {
    await assert.rejects(prepareDirectImage({ ...input, ...changed }), /来源|身份|正文|historyId/);
  }
  for (const invalid of [null, undefined, [], 8]) {
    await assert.rejects(prepareDirectImage(invalid), /来源/);
  }
  await assert.doesNotReject(prepareDirectImage(source({ messageId: 0, swipeId: null, turnId: null })));
});

test('SHA256 capability failure is explicit and never falls back to a weak hash', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const crypto of [undefined, {}, { subtle: {} }, { subtle: { digest: async () => { throw new Error('unavailable'); } } }]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto });
      await assert.rejects(prepareDirectImage(source()), /SHA-?256|crypto\.subtle/);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
  assert.equal((await prepareDirectImage(source())).fingerprint, sha256(source().text));
});
