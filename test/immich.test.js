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
      if (body.albumIds) return json({ assets: { items: body.albumIds.includes('a1') ? FAVS.slice(0, 2) : [], nextPage: null } });
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
  assert.deepEqual(s.background, { src: `immich:${FAVS[0].id}`, caption: '7 October 2019', empty: '', cards: 'white' });
  // No Immich: the screen still builds, saying why there's no photo.
  const none = buildScreens(layout, { states: {}, photos: {} }).pics;
  assert.deepEqual(none.background, { src: '', caption: '', empty: 'No photo', cards: 'white' });
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

test('a picture past 1440 px asks Immich for the full size, and falls back to the preview', async () => {
  assert.equal(immich.resolveSrc('immich:11111111-1111-1111-1111-111111111111', conn, 1440).url.endsWith('size=preview'), true);
  const big = immich.resolveSrc('immich:11111111-1111-1111-1111-111111111111', conn, 1600);
  assert.ok(big.url.endsWith('size=fullsize'));
  assert.ok(big.fallback.endsWith('size=preview'));

  // An Immich without full-size images: the preview, scaled up.
  const jpeg = await sharp({ create: { width: 1440, height: 1080, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
  const realFetch = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    asked.push(url);
    if (url.endsWith('fullsize')) return { ok: false, status: 404, headers: new Map() };
    return { ok: true, status: 200, headers: new Map([['content-length', String(jpeg.length)]]), arrayBuffer: async () => jpeg };
  };
  try {
    const img = await art.prepare('immich:22222222-2222-2222-2222-222222222222', { width: 1600, height: 1200, format: 'spectra', position: 'attention' }, {}, (s, side) => immich.resolveSrc(s, conn, side));
    assert.equal(img.width, 1600);
    assert.equal(img.height, 1200);
    assert.equal(img.body.length, 800 * 1200);
    assert.deepEqual(asked.map((u) => u.split('size=')[1]), ['fullsize', 'preview']);
  } finally {
    global.fetch = realFetch;
  }
});

test('an album in order: one photo after another, oldest first, then round again', async () => {
  immich._lists.clear();
  const f = fakeImmich();
  // The album lists them newest first; in order means by when they were taken.
  const t0 = new Date('2026-10-07T10:05:00Z');
  const ids = [];
  for (let h = 0; h < 6; h++) {
    const r = await immich.pick({ source: { kind: 'favorites' }, every: 60, order: 'sequential', seed: 'photo:s1' }, new Date(t0.getTime() + h * 3600000), 'UTC', f.opts);
    ids.push(r.id);
  }
  const order = FAVS.slice(0, 3).map((x) => x.id); // 2019, 2021, 2022
  const start = order.indexOf(ids[0]);
  assert.notEqual(start, -1);
  assert.deepEqual(ids, [0, 1, 2, 3, 4, 5].map((i) => order[(start + i) % 3]));
  // The same in every section and on every display: it's the period's turn.
  const other = await immich.pick({ source: { kind: 'favorites' }, every: 60, order: 'sequential', seed: 'bg:other' }, t0, 'UTC', f.opts);
  assert.equal(other.id, ids[0]);
  // Kept by the layout; random unless asked.
  const s = dashboard.normalizeLayout({ screens: [{ id: 'pf', kind: 'photoFrame', frame: { order: 'sequential' } }] }).screens[0].frame;
  assert.equal(s.order, 'sequential');
  assert.equal(dashboard.normalizeLayout({ screens: [{ id: 'pf', kind: 'photoFrame', frame: {} }] }).screens[0].frame.order, 'random');
});

test('a list due a refresh is answered at once; the refresh happens behind it', async () => {
  immich._lists.clear();
  let slow = false;
  let calls = 0;
  const f = fakeImmich();
  const fetchImpl = async (url, init) => {
    if (url.includes('/search/metadata')) {
      calls += 1;
      if (slow) await new Promise((r) => setTimeout(r, 200));
    }
    return f.fetchImpl(url, init);
  };
  const opts = { conn, fetchImpl };
  const t0 = new Date('2026-10-07T10:05:00Z');
  const first = await immich.list({ kind: 'favorites', album: '', person: '' }, t0, opts);
  assert.equal(first.length, 3);
  // Older than the cache allows: the old list now, a fresh one fetched behind it.
  for (const v of immich._lists.values()) v.at -= 11 * 60 * 1000;
  slow = true;
  const started = Date.now();
  const again = await immich.list({ kind: 'favorites', album: '', person: '' }, t0, opts);
  assert.ok(Date.now() - started < 150, 'answered without waiting for Immich');
  assert.deepEqual(again, first);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, 2);
});

test('a photo background: white cards unless the layout asks for none', () => {
  const screen = (bg) => dashboard.normalizeLayout({ screens: [{ id: 's', kind: 'sections', template: 'single', columns: [[]], background: bg }] }).screens[0].background;
  assert.equal(screen({ enabled: true }).cards, 'white');
  assert.equal(screen({ enabled: true, cards: 'none' }).cards, 'none');
  assert.equal(screen({ enabled: true, cards: 'glass' }).cards, 'white');
});

test('a photo the shape of where it goes: portrait for a portrait screen, landscape for a landscape one', async () => {
  immich._lists.clear();
  const sideways = { exifImageWidth: 4032, exifImageHeight: 3024, orientation: '6' };
  const wide = { exifImageWidth: 4032, exifImageHeight: 3024, orientation: '1' };
  const ALBUM = [
    asset('aaaaaaaa-0000-4000-8000-000000000001', '2020-01-01T10:00:00.000Z', 'Cork', { exifInfo: { city: 'Cork', ...wide } }),
    asset('aaaaaaaa-0000-4000-8000-000000000002', '2020-02-01T10:00:00.000Z', 'Cork', { exifInfo: { city: 'Cork', ...sideways } }),
    asset('aaaaaaaa-0000-4000-8000-000000000003', '2020-03-01T10:00:00.000Z', 'Cork', { exifInfo: { city: 'Cork', exifImageWidth: 3000, exifImageHeight: 4000 } })
  ];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/api/albums/mixed') return { ok: true, status: 200, json: async () => ({ assets: ALBUM }) };
    return fakeImmich().fetchImpl(url, init);
  };
  const opts = { conn, fetchImpl };
  const t0 = new Date('2026-10-07T10:05:00Z');
  const seen = { landscape: new Set(), portrait: new Set() };
  for (const shape of ['landscape', 'portrait'])
    for (let h = 0; h < 24; h++) {
      const r = await immich.pick({ source: { kind: 'album', album: 'mixed' }, every: 60, seed: 'bg:s', shape }, new Date(t0.getTime() + h * 3600000), 'UTC', opts);
      seen[shape].add(r.id);
    }
  assert.deepEqual([...seen.landscape], [ALBUM[0].id]);
  assert.deepEqual([...seen.portrait].sort(), [ALBUM[1].id, ALBUM[2].id].sort());
  // None that shape: any of them rather than nothing.
  immich._lists.clear();
  const onlyWide = async (url, init) => (new URL(url).pathname === '/api/albums/mixed' ? { ok: true, status: 200, json: async () => ({ assets: [ALBUM[0]] }) } : fetchImpl(url, init));
  assert.equal((await immich.pick({ source: { kind: 'album', album: 'mixed' }, seed: 'x', shape: 'portrait' }, t0, 'UTC', { conn, fetchImpl: onlyWide })).id, ALBUM[0].id);
});

test('an album’s photos: found by search (Immich 2 and 3), or in the album itself (older)', async () => {
  immich._lists.clear();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    // Current Immich: the album without its photos; search finds them.
    if (u.pathname === '/api/albums/new') return json({ id: 'new', albumName: 'New', assetCount: 2 });
    // An older Immich: no album search, the photos in the album.
    if (u.pathname === '/api/albums/old') return json({ id: 'old', assets: FAVS.slice(1, 3) });
    if (u.pathname === '/api/search/metadata') {
      const body = JSON.parse(init.body);
      if (body.albumIds && body.albumIds[0] === 'new') return json({ assets: { items: FAVS.slice(0, 2), nextPage: null } });
      if (body.albumIds) return { ok: false, status: 400, json: async () => ({ message: 'property albumIds should not exist' }) };
    }
    return json({});
  };
  const opts = { conn, fetchImpl };
  const at = new Date('2026-10-07T10:05:00Z');
  const ids = async (album) => {
    const seen = new Set();
    for (let h = 0; h < 24; h++) seen.add((await immich.pick({ source: { kind: 'album', album }, seed: 'x' }, new Date(at.getTime() + h * 3600000), 'UTC', opts)).id);
    return [...seen].sort();
  };
  assert.deepEqual(await ids('new'), FAVS.slice(0, 2).map((x) => x.id).sort());
  assert.ok(!calls.includes('/api/albums/new'), 'found by search, the album never asked');
  assert.deepEqual(await ids('old'), FAVS.slice(1, 3).map((x) => x.id).sort());
});

test('photos in the Locked Folder, hidden or archived are never picked', async () => {
  immich._lists.clear();
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/api/search/metadata')
      return { ok: true, status: 200, json: async () => ({ assets: { items: [
        { ...FAVS[0], visibility: 'locked' }, { ...FAVS[1], visibility: 'hidden' }, { ...FAVS[2], visibility: 'archive' },
        { ...asset('dddddddd-0000-4000-8000-000000000001', '2020-01-01T00:00:00.000Z', 'Cork'), visibility: 'timeline' }
      ], nextPage: null } }) };
    return fakeImmich().fetchImpl(url, init);
  };
  const list = await immich.list({ kind: 'favorites', album: '', person: '' }, new Date(), { conn, fetchImpl });
  assert.deepEqual(list.map((x) => x.id), ['dddddddd-0000-4000-8000-000000000001']);
});

test('colour strength: chosen per photo, carried in its src, used by /api/art', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  // The layout keeps a known strength, and makes anything else standard.
  const layout = dashboard.normalizeLayout({
    screens: [{
      id: 'pics', kind: 'sections', template: 'single',
      background: { enabled: true, source: { kind: 'favorites' }, strength: 'vivid' },
      columns: [[{ id: 'p', type: 'photo', source: { kind: 'favorites' }, strength: 'loud' }]]
    }]
  });
  assert.equal(layout.screens[0].background.strength, 'vivid');
  assert.equal(layout.screens[0].columns[0][0].strength, 'standard');
  // Standard leaves the src as it was (and so the display's cached picture).
  assert.equal(immich.srcFor(id), `immich:${id}`);
  assert.equal(immich.srcFor(id, 'extra'), `immich:${id}?strength=extra`);
  assert.equal(immich.strengthOf(`immich:${id}?strength=natural`), 'natural');
  assert.equal(immich.strengthOf(`immich:${id}`), 'standard');
  assert.equal(immich.strengthOf('/api/media_player_proxy/x?strength=vivid'), 'standard');
  // The asset is fetched the same whatever the strength.
  assert.deepEqual(immich.resolveSrc(`immich:${id}?strength=vivid`, conn), immich.resolveSrc(`immich:${id}`, conn));
  // The background's photo comes with its strength.
  immich._lists.clear();
  const f = fakeImmich();
  const inputs = await fetchInputs(layout, {}, new Date('2026-10-07T10:00:00Z'), { immichOpts: f.opts });
  assert.match(buildScreens(layout, inputs).pics.background.src, /\?strength=vivid$/);
  // Stronger means more colour ink in the same muted photo.
  const muted = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 150, g: 110, b: 100 } } }).jpeg().toBuffer();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => muted });
  try {
    const coloured = async (strength) => {
      const img = await art.prepare(`immich:${id}?strength=${strength}`, { width: 64, height: 64, format: 'spectra', strength }, {}, (s) => immich.resolveSrc(s, conn));
      let n = 0;
      for (const b of img.body) n += ((b >> 4) > 1 ? 1 : 0) + ((b & 15) > 1 ? 1 : 0);
      return n;
    };
    const [natural, standard, extra] = [await coloured('natural'), await coloured('standard'), await coloured('extra')];
    assert.ok(natural < standard && standard < extra, `${natural} < ${standard} < ${extra}`);
  } finally {
    global.fetch = realFetch;
  }
});

test('a frame whose lines contrast with the photo: its tone found from Immich, with the key', async () => {
  immich._lists.clear();
  const f = fakeImmich();
  const white = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 250, g: 250, b: 245 } } }).jpeg().toBuffer();
  const realFetch = global.fetch;
  let asked;
  global.fetch = async (url, init) => {
    asked = { url, headers: init.headers };
    return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => white };
  };
  try {
    const layout = dashboard.normalizeLayout({ screens: [{ id: 'pf', kind: 'photoFrame', frame: { source: { kind: 'favorites' }, ink: 'auto', corner: 'topRight', footer: true } }] });
    const inputs = await fetchInputs(layout, {}, new Date('2026-10-07T10:00:00Z'), { immichOpts: f.opts });
    assert.equal(inputs.photos['frame:pf'].tone, 'light');
    assert.equal(inputs.photos['frame:pf'].footerTone, 'light');
    assert.match(asked.url, /^http:\/\/photos\.lan:2283\/api\/assets\/.+\/thumbnail\?size=preview$/);
    assert.equal(asked.headers['x-api-key'], 'k-secret');
    const d = buildScreens(layout, inputs).pf.data;
    assert.deepEqual([d.ink, d.outline], ['black', false]);
  } finally {
    global.fetch = realFetch;
  }
});
