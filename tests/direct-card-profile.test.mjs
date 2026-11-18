import assert from 'node:assert/strict';
import test from 'node:test';
import { composeDirectKeyframe, defaultDirectCardProfile, directCardId, loadDirectCardProfile, saveDirectCardProfile } from '../dist/direct-card-profile.js';

const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const card = (avatar, chatId) => ({ scope: JSON.stringify(['character', avatar]), chatId, turnId: null });
const anchor = { id: 'anchor-1', name: '角色甲', appearance: '黑色短发，深棕眼睛', negative: '重复人物',
  outfits: [{ id: 'outfit-1', name: '外套', tags: '蓝色外套' }], selectedOutfitId: 'outfit-1', portrait: new Blob(['not an input']) };

test('a profile is reused across chats only by the exact native avatar key, never by group or embedded identity', () => {
  const disk = storage(), one = directCardId(card('avatar.png', 'chat A')), two = directCardId(card('avatar.png', 'chat B'));
  assert.equal(one, two);
  const recipe = { preset: 'anime', anchorId: 'anchor-1', style: '磨砂质感', negative: '水印' };
  saveDirectCardProfile(one, { ...recipe, scene: 'do not store', text: 'do not store' }, disk);
  assert.deepEqual(loadDirectCardProfile(two, disk), recipe);
  assert.deepEqual(loadDirectCardProfile(directCardId(card('Avatar.png', 'chat A')), disk), defaultDirectCardProfile());
  assert.deepEqual(JSON.parse([...disk.data.values()][0]), recipe);
  assert.equal(directCardId({ scope: JSON.stringify(['group', 'avatar.png']), turnId: null }), null);
  assert.equal(directCardId({ ...card('avatar.png', 'chat A'), turnId: 'embedded' }), null);
});

test('broken profile storage is not overwritten and positive/negative style is bounded', () => {
  const disk = storage(); saveDirectCardProfile('1.png', defaultDirectCardProfile(), disk);
  assert.throws(() => saveDirectCardProfile('1.png', { ...defaultDirectCardProfile(), style: '画'.repeat(1201) }, disk), /过长/);
  const [key] = disk.data.keys(); disk.setItem(key, '{broken');
  assert.throws(() => saveDirectCardProfile('1.png', defaultDirectCardProfile(), disk));
  assert.equal(disk.getItem(key), '{broken');
});

test('composition uses the explicitly chosen character once; pose and default outfit are per frame, portrait never sent', () => {
  const profile = { preset: 'realistic', anchorId: anchor.id, style: '冷色调', negative: '重复人物' };
  const another = { ...anchor, id: 'anchor-2', appearance: '不应拼入的特征' };
  const body = '她跃过积水，侧脸带着笑意。';
  const preview = composeDirectKeyframe(body, profile, [another, anchor], false, '模糊');
  assert.equal(preview.positive, `${body}\n画面中角色甲的固定外貌：黑色短发，深棕眼睛\n画风：冷色调`);
  assert.equal(preview.negative, '模糊\n重复人物');
  assert.deepEqual(Object.keys(preview).sort(), ['negative', 'positive']);
  assert.match(composeDirectKeyframe(body, profile, [anchor], true, '').positive, /蓝色外套/);
  assert.throws(() => composeDirectKeyframe(body, profile, [another], false, ''), /锚定不存在/);
});
