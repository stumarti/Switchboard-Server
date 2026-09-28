'use strict';

// node --test: which remote pages are live, and the bitmaps /api/art sends.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pageEntities, livePages } = require('../lib/ha-state');
const art = require('../lib/art');

const room = {
  media: { enabled: true, entity: 'media_player.kitchen' },
  xbox: { mediaPlayerEntity: 'media_player.xbox' },
  blinds: { group: { enabled: true, entity: 'cover.all' }, items: [{ entity: 'cover.a' }, { entity: 'cover.b' }] }
};

test('each live-capable page has its entities', () => {
  assert.deepEqual(pageEntities(room), {
    music: ['media_player.kitchen'],
    xbox: ['media_player.xbox'],
    blinds: ['cover.all', 'cover.a', 'cover.b']
  });
  assert.deepEqual(pageEntities({ media: { enabled: false, entity: 'x.y' } }).music, []);
});

test('pages are live only while something changes on its own', () => {
  const s = (state) => ({ state, attributes: {} });
  assert.deepEqual(
    livePages(room, { 'media_player.kitchen': s('playing'), 'media_player.xbox': s('paused'), 'cover.all': s('open'), 'cover.a': s('closing') }),
    { music: 'live', xbox: 'passive', blinds: 'live' }
  );
  // Unknown pages (not fetched) are left out.
  assert.deepEqual(livePages(room, { 'media_player.kitchen': s('idle') }), { music: 'passive' });
});

test('mask1: 1 bpp, rows padded to bytes, MSB first, 0 = ink', () => {
  // A 10x1 row: dark, light alternating -> 0101010101 then padding 1s.
  const grey = Buffer.from([0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  assert.deepEqual([...art.toMask1(grey, 10, 1)], [0b01010101, 0b01111111]);
});

test('spectra: palette indices, two pixels a byte, high nibble first', () => {
  // Each colour lands on its own ink. Green is a real-world green: a pure
  // 0,255,0 is far brighter than the panel's dark green ink, so its nearest
  // is yellow (asserted below, so a palette change that alters it is seen).
  const inks = [[255, 255, 255], [0, 0, 0], [255, 0, 0], [255, 255, 0], [34, 139, 34], [0, 0, 255]];
  const idx = inks.map((c) => art.toSpectraIndices(Buffer.from(c), 1, 1)[0]);
  assert.deepEqual(idx, [0, 1, 2, 3, 4, 5]);
  assert.equal(art.toSpectraIndices(Buffer.from([0, 255, 0]), 1, 1)[0], 3);
  assert.deepEqual([...art.packNibbles(idx, 6, 1)], [0x01, 0x23, 0x45]);
  assert.deepEqual([...art.packNibbles(Uint8Array.from([5, 4, 3]), 3, 1)], [0x54, 0x30]);
});

test('spectra: the picture is fitted into the panel\'s measured range', () => {
  const fit = art.fitToPanel(Buffer.from([255, 255, 255, 0, 0, 0]));
  assert.deepEqual([...fit.slice(0, 3)], art.SPECTRA[0]); // white -> the white ink, no error
  assert.deepEqual([...fit.slice(3, 6)], art.SPECTRA[1]); // black -> the black ink
  // A mid grey dithers to a mix of white and black ink, nothing coloured.
  const grey = Buffer.alloc(16 * 16 * 3, 128);
  const idx = art.toSpectraIndices(grey, 16, 16);
  assert.ok([...idx].every((v) => v === 0 || v === 1));
  const whites = [...idx].filter((v) => v === 0).length;
  assert.ok(whites > 96 && whites < 160, `about half white, got ${whites}/256`);
  // Realistic greens (foliage, sleeve art) find the green ink.
  const leaf = Buffer.from(Array(16 * 16).fill([34, 139, 34]).flat());
  const greens = [...art.toSpectraIndices(leaf, 16, 16)].filter((v) => v === 4).length;
  assert.ok(greens > 200, `mostly green ink, got ${greens}/256`);
});

test('entity_picture drops the rotating HA access token', () => {
  const { stablePicture } = require('../lib/ha-state');
  assert.equal(
    stablePicture('/api/media_player_proxy/media_player.x?token=abc123&cache=9f8e'),
    '/api/media_player_proxy/media_player.x?cache=9f8e'
  );
  assert.equal(stablePicture('/api/media_player_proxy/media_player.x?token=abc'), '/api/media_player_proxy/media_player.x');
  assert.equal(stablePicture('https://store-images.example/box.jpg'), 'https://store-images.example/box.jpg');
  assert.equal(stablePicture(undefined), undefined);
});
