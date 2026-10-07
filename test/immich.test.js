'use strict';

// node --test: Immich photos (lib/immich.js) — the connection kept from the
// UI and the displays, the sources, which photo when, captions — and a
// photo section and a screen background in a viewport's state.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-immich-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const immich = require('../lib/immich');
const dashboard = require('../lib/dashboard');
const art = require('../lib/art');
const { buildScreens, fetchInputs, deviceLayout } = require('../lib/dashboard-state');

const conn = { url: 'http://photos.lan:2283', apiKey: 'k-secret' };
const asset = (id, taken, city, extra = {}) => ({ id, type: 'IMAGE', localDateTime: taken, exifInfo: { city, country: 'Ireland' }, ...extra });
const FAVS = [
  asset('11111111-1111-1111-1111-111111111111', '2019-10-07T14:30:00.000Z', 'Dublin'),
  asset('22222222-2222-2222-2222-222222222222', '2021-06-01T09:00:00.000Z', 'Galway'),
  asset('33333333-3333-3333-3333-333333333333', '2022-01-15T12:00:00.000Z', ''),
  { id: '44444444-4444-4444-4444-444444444444', type: 'VIDEO' }
];

// A pretend Immich: records each request.
function fakeImmich() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers['x-api-key'] !== 'k-secret') return json({}, 401);
    if (u.pathname === '/api/users/me') return json({ name: 'Stu' });
    if (u.pathname === '/api/albums') return json([{ id: 'a2', albumName: 'Zoo', assetCount: 3 }, { id: 'a1', albumName: 'Holidays', assetCount: 2 }]);
    if (u.pathname === '/api/albums/a1') return json({ assets: FAVS.slice(0, 2) });
    if (u.pathname === '/api/people') return json({ people: [{ id: 'p1', name: 'Sam' }, { id: 'p2', name: '' }] });
    if (u.pathname === '/api/search/metadata') {
      const body = JSON.parse(init.body);
      return json({ assets: { items: body.personIds ? FAVS.slice(1, 2) : FAVS, nextPage: null } });
    }
    if (u.pathname === '/api/memories') return json([{ type: 'on_this_day', assets: FAVS.slice(0, 1) }]);
    return json({}, 404);
  };
  return { calls, fetchImpl, opts: { conn, fetchImpl } };
}

test('the connection: saved on the server, the key never sent back, kept when left blank', () => {
  assert.deepEqual(immich.publicView(), { url: '', hasKey: false, configured: false });
  assert.deepEqual(immich.save({ url: 'photos.lan:2283/', apiKey: 'abc' }), { url: 'http://photos.lan:2283', hasKey: true, configured: true });
  // A save without a key (the form shows none) keeps the saved one.
  immich.save({ url: 'https://photos.example.com/api' });
  assert.deepEqual(immich.get(), { url: 'https://photos.example.com', apiKey: 'abc' });
  assert.equal(JSON.stringify(immich.publicView()).includes('abc'), false);
  immich.save({ clearKey: true });
  assert.equal(immich.get().apiKey, '');
  assert.throws(() => immich.save({ url: 'ftp://x' }), /isn't a web address/);
});

test('test, albums and people, as the pickers list them', async () => {
  const f = fakeImmich();
  assert.deepEqual(await immich.test(f.opts), { user: 'Stu', albums: 2 });
  assert.deepEqual((await immich.albums(f.opts)).map((a) => a.name), ['Holidays', 'Zoo']);
  assert.deepEqual(await immich.people(f.opts), [{ id: 'p1', name: 'Sam' }]);
  await assert.rejects(immich.test({ ...f.opts, conn: { ...conn, apiKey: 'wrong' } }), /refused the API key/);
});

test('a photo: fixed within its period, from the source asked for, with its caption', async () => {
  immich._lists.clear();
  const f = fakeImmich();
  const at = new Date('2026-10-07T10:05:00Z');
  const a = await immich.pick({ source: { kind: 'favorites' }, every: 60, caption: 'both', seed: 'photo:s1' }, at, 'Europe/Dublin', f.opts);
  assert.match(a.src, /^immich:[1-3]{8}-/);
  // The same hour: the same photo (so the screen's ETag holds).
  const b = await immich.pick({ source: { kind: 'favorites' }, every: 60, caption: 'both', seed: 'photo:s1' }, new Date('2026-10-07T10:55:00Z'), 'Europe/Dublin', f.opts);
  assert.equal(b.src, a.src);
  // Videos are left out; over many periods every photo comes up.
  const seen = new Set();
  for (let h = 0; h < 48; h++) seen.add((await immich.pick({ source: { kind: 'favorites' }, every: 60, seed: 'photo:s1' }, new Date(at.getTime() + h * 3600000), 'UTC', f.opts)).id);
  assert.deepEqual([...seen].sort(), FAVS.slice(0, 3).map((x) => x.id).sort());
  // One list request for all of that (cached).
  assert.equal(f.calls.filter((c) => c.url.includes('/search/metadata')).length, 1);

  assert.equal(immich.captionFor({ taken: '2019-10-07T14:30:00.000Z', place: 'Dublin, Ireland' }, 'both'), 'Dublin, Ireland – 7 October 2019');
  assert.equal(immich.captionFor({ taken: '2019-10-07T14:30:00.000Z', place: '' }, 'place'), '');
  assert.equal(immich.captionFor({ taken: '2019-10-07T14:30:00.000Z', place: 'X' }, 'date'), '7 October 2019');

  const album = await immich.pick({ source: { kind: 'album', album: 'a1' }, seed: 'x' }, at, 'UTC', f.opts);
  assert.ok(FAVS.slice(0, 2).some((x) => `immich:${x.id}` === album.src));
  const person = await immich.pick({ source: { kind: 'person', person: 'p1' }, seed: 'x' }, at, 'UTC', f.opts);
  assert.equal(person.id, FAVS[1].id);
  assert.equal((await immich.pick({ source: { kind: 'memories' }, seed: 'x' }, at, 'UTC', f.opts)).id, FAVS[0].id);
  assert.deepEqual(await immich.pick({ source: { kind: 'album' }, seed: 'x' }, at, 'UTC', f.opts), { error: 'Pick an album' });
  assert.deepEqual(await immich.pick({ source: { kind: 'favorites' } }, at, 'UTC', { conn: { url: '', apiKey: '' } }), { error: 'Set up Immich in Settings' });
});

test('/api/art fetches an immich: source with the key; nothing else is resolved', () => {
  const r = immich.resolveSrc('immich:11111111-1111-1111-1111-111111111111', conn);
  assert.deepEqual(r, { url: 'http://photos.lan:2283/api/assets/11111111-1111-1111-1111-111111111111/thumbnail?size=preview', headers: { 'x-api-key': 'k-secret' } });
  assert.equal(immich.resolveSrc('/api/media_player_proxy/x', conn), null);
  assert.equal(immich.resolveSrc('immich:../../users', conn), null);
});

test('a photo section and a screen background in the state; the key never in it', async () => {
  immich._lists.clear();
  const f = fakeImmich();
  const layout = dashboard.normalizeLayout({
    screens: [{
      id: 'pics', kind: 'sections', template: 'columns',
      background: { enabled: true, source: { kind: 'memories' }, caption: 'date' },
      columns: [[{ id: 'p', type: 'photo', source: { kind: 'album', album: 'a1' }, every: 30, caption: 'place', height: 300 }], [{ id: 'm', type: 'message', text: 'Hello' }]]
    }]
  });
  const inputs = await fetchInputs(layout, {}, new Date('2026-10-07T10:00:00Z'), { immichOpts: f.opts });
  const s = buildScreens(layout, inputs).pics;
  const photo = s.columns[0][0].data;
  assert.match(photo.src, /^immich:/);
  assert.equal(photo.height, 300);
  assert.equal(photo.empty, '');
  assert.ok(['Dublin, Ireland', 'Galway, Ireland'].includes(photo.caption));
  assert.deepEqual(s.background, { src: `immich:${FAVS[0].id}`, caption: '7 October 2019', empty: '' });
  // No Immich: the screen still builds, saying why there's no photo.
  const none = buildScreens(layout, { states: {}, photos: {} }).pics;
  assert.deepEqual(none.background, { src: '', caption: '', empty: 'No photo' });
  // The layout a display gets has the sources, never the connection.
  assert.ok(!JSON.stringify(deviceLayout(layout)).includes('k-secret'));
  assert.ok(!JSON.stringify(s).includes('k-secret'));
});

test('a whole-panel picture: 800x480 in the six inks, cropped round what matters', async () => {
  const jpeg = await sharp({ create: { width: 1440, height: 1080, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
  const realFetch = global.fetch;
  let asked;
  global.fetch = async (url, init) => {
    asked = { url, headers: init.headers };
    return { ok: true, status: 200, headers: new Map([['content-length', String(jpeg.length)]]), arrayBuffer: async () => jpeg };
  };
  try {
    const img = await art.prepare('immich:11111111-1111-1111-1111-111111111111', { width: 800, height: 480, format: 'spectra', position: 'attention' }, {}, (s) => immich.resolveSrc(s, conn));
    assert.equal(img.width, 800);
    assert.equal(img.height, 480);
    assert.equal(img.body.length, 400 * 480);
    assert.equal(asked.headers['x-api-key'], 'k-secret');
  } finally {
    global.fetch = realFetch;
  }
});
