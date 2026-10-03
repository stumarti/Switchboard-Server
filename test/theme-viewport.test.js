'use strict';

// node --test: the viewport's theme packs — its own icon slots and font
// faces, in the same SBI1/SBF1 formats the remote's packs use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-theme-'));

const viewportSlots = require('../lib/assets/viewport-slots');
const { compileIconsPack } = require('../lib/assets/icons');
const { compileFontsPack } = require('../lib/assets/fonts');
const store = require('../lib/store');

// A TTF that's always to hand: the firmware repo's isn't, so build one from
// whatever opentype.js can parse in node_modules, else skip the font test.
function anyTtf() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'opentype.js', 'test', 'fonts', 'Roboto-Black.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  ];
  return candidates.find((p) => fs.existsSync(p));
}

test('the viewport icon pack has every slot, each at the size the panel draws it', async () => {
  const slots = viewportSlots.listSlots();
  const keys = slots.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'slot keys are unique');
  for (const k of keys) assert.ok(k.length <= 24, `${k} fits the pack's 24-byte name`);
  const buf = await compileIconsPack({ vf_refresh: 'autorenew' }, slots);
  assert.equal(buf.toString('ascii', 0, 4), 'SBI1');
  assert.equal(buf.readUInt16LE(4), slots.length);
  const entry = (i) => {
    const o = 8 + i * 38;
    return { name: buf.toString('ascii', o, o + 24).replace(/\0+$/, ''), w: buf.readUInt16LE(o + 24), h: buf.readUInt16LE(o + 26) };
  };
  const hero = entry(keys.indexOf('vwx_sunny'));
  assert.deepEqual(hero, { name: 'vwx_sunny', w: 88, h: 88 });
  assert.deepEqual(entry(keys.indexOf('vf_refresh')), { name: 'vf_refresh', w: 16, h: 16 });
});

test('the viewport font pack has its four faces, regular and bold', async (t) => {
  const ttf = anyTtf();
  if (!ttf) return t.skip('no TTF available to compile');
  const font = fs.readFileSync(ttf);
  const faces = viewportSlots.listFaces();
  const buf = await compileFontsPack(font, faces, font);
  assert.equal(buf.toString('ascii', 0, 4), 'SBF1');
  assert.equal(buf.readUInt8(4), faces.length);
  const slots = faces.map((_, i) => buf.toString('ascii', 8 + i * 39, 8 + i * 39 + 16).replace(/\0+$/, ''));
  assert.deepEqual(slots, ['regular18', 'bold18', 'bold24', 'bold82']);
  // 1bpp, the full printable range: what Adafruit GFX draws.
  for (let i = 0; i < faces.length; i++) {
    const o = 8 + i * 39 + 16;
    assert.equal(buf.readUInt16LE(o), 0x20);
    assert.equal(buf.readUInt16LE(o + 2), 0x7e);
    assert.equal(buf.readUInt8(o + 8), 1);
  }
});

test('each kind of device has its own packs and versions', () => {
  store.saveIconsPack(Buffer.from('remote'), 'remote');
  store.saveIconsPack(Buffer.from('viewport'), 'viewport');
  assert.equal(store.getIconsPack('remote').toString(), 'remote');
  assert.equal(store.getIconsPack('viewport').toString(), 'viewport');
  assert.equal(store.getIconsPack().toString(), 'remote'); // no kind: the remote's, as before
  const theme = { iconsVersion: 'r1', fontsVersion: 'r2', iconOverrides: { a: 'b' }, viewport: { iconsVersion: 'v1', fontsVersion: '', iconOverrides: {} } };
  assert.deepEqual(store.themeFor(theme, 'viewport'), { iconsVersion: 'v1', fontsVersion: '', iconOverrides: {} });
  assert.deepEqual(store.themeFor(theme, 'remote'), { iconsVersion: 'r1', fontsVersion: 'r2', iconOverrides: { a: 'b' } });
  // A theme saved before viewports had packs.
  assert.deepEqual(store.themeFor({ iconsVersion: 'x', fontsVersion: 'y' }, 'viewport'), { iconsVersion: '', fontsVersion: '', iconOverrides: {} });
});
