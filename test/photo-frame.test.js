'use strict';

// node --test: a photo frame screen — an Immich photo with a few lines over
// it — and the layout's size on a 13.3" board.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { buildScreens } = require('../lib/dashboard-state');

const TZ = 'Europe/Dublin';
const st = (state, attributes = {}) => ({ state: String(state), attributes });

function frame(f, inputs = {}) {
  const layout = dashboard.normalizeLayout({ screens: [{ id: 'pf', kind: 'photoFrame', frame: f }] });
  return buildScreens(layout, { states: {}, timeZone: TZ, now: new Date('2026-10-07T08:30:00Z'), ...inputs }).pf;
}

test('a photo frame: the photo, then the date, the weather, the next event and a message in white', () => {
  const states = { 'weather.home': st('partlycloudy', { temperature: 16.4 }), 'input_text.note': st('Bins out tonight') };
  const calendars = {
    'calendar.family': [
      { summary: 'School run', start: { dateTime: '2026-10-07T07:30:00Z' }, end: { dateTime: '2026-10-07T08:00:00Z' } },
      { summary: 'Football practice', start: { dateTime: '2026-10-07T13:00:00Z' }, end: { dateTime: '2026-10-07T14:00:00Z' } }
    ]
  };
  const s = frame(
    { source: { kind: 'favorites' }, caption: 'both', weather: 'weather.home', calendars: ['calendar.family'], message: '{input_text.note}', corner: 'bottomRight' },
    { states, calendars, photos: { 'frame:pf': { src: 'immich:abc', caption: 'Lahinch, Ireland – 7 October 2019' } } }
  );
  assert.equal(s.kind, 'photoFrame');
  const d = s.data;
  assert.equal(d.src, 'immich:abc');
  assert.equal(d.caption, 'Lahinch, Ireland – 7 October 2019');
  assert.equal(d.corner, 'bottomRight');
  assert.deepEqual(d.lines, [
    { icon: '', text: 'Wednesday 7 October', big: true },
    { icon: 'weather-partly-cloudy', text: '16°C  Partly cloudy', big: false },
    // The school run is over: the next one.
    { icon: 'calendar-blank-outline', text: '14:00 Football practice', big: false },
    { icon: '', text: 'Bins out tonight', big: false }
  ]);
});

test('a photo frame with everything off is just the photo; no photo says why', () => {
  const s = frame({ date: false }, {});
  assert.deepEqual(s.data.lines, []);
  assert.equal(s.data.src, '');
  assert.equal(s.data.empty, 'No photo');
});

test('a 13.3" board shows a layout large unless it says small', () => {
  assert.equal(dashboard.normalizeLayout({}).boardSize, 'large');
  assert.equal(dashboard.normalizeLayout({ boardSize: 'small' }).boardSize, 'small');
  assert.equal(dashboard.normalizeLayout({ boardSize: 'huge' }).boardSize, 'large');
});

test('a photo frame is outlined in black unless that is turned off', () => {
  assert.equal(dashboard.normalizeLayout({ screens: [{ kind: 'photoFrame', frame: {} }] }).screens[0].frame.outline, true);
  assert.equal(frame({ source: { kind: 'favorites' } }).data.outline, true);
  assert.equal(frame({ source: { kind: 'favorites' }, outline: false }).data.outline, false);
});

test('a photo frame in black, or contrasting with the photo under its lines', () => {
  const layout = (f) => dashboard.normalizeLayout({ screens: [{ kind: 'photoFrame', frame: f }] }).screens[0].frame;
  assert.equal(layout({}).ink, 'white');
  assert.equal(layout({ ink: 'auto' }).ink, 'auto');
  assert.equal(layout({ ink: 'pink' }).ink, 'white');
  // Black, with its (white) edge unless that's off.
  assert.deepEqual([frame({ ink: 'black' }).data.ink, frame({ ink: 'black' }).data.outline], ['black', true]);
  assert.equal(frame({ ink: 'black', outline: false }).data.outline, false);
  // Contrasting: black on a light photo, white on a dark one, no edge either way.
  const auto = (tone) => frame({ ink: 'auto', outline: true }, { photos: { 'frame:pf': { src: 'immich:abc', tone } } }).data;
  assert.deepEqual([auto('light').ink, auto('light').outline], ['black', false]);
  assert.deepEqual([auto('dark').ink, auto('dark').outline], ['white', false]);
  // Not known (Immich didn't answer in time): white with an edge, readable anywhere.
  assert.deepEqual([auto(undefined).ink, auto(undefined).outline], ['white', true]);
});

test('how light a photo is in the corner a frame writes in', async () => {
  const sharp = require('sharp');
  const art = require('../lib/art');
  // Top half white, bottom half black: light at the top, dark at the bottom.
  const W = 400, H = 240;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) raw.fill(y < H / 2 ? 255 : 0, y * W * 3, (y + 1) * W * 3);
  const jpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg().toBuffer();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => jpeg });
  try {
    const tone = (corner) => art.toneUnder(`http://photos.lan/half-${corner}.jpg`, { width: 800, height: 480, corner }, {});
    assert.equal(await tone('topLeft'), 'light');
    assert.equal(await tone('topRight'), 'light');
    assert.equal(await tone('bottomLeft'), 'dark');
    assert.equal(await tone('bottomRight'), 'dark');
  } finally {
    global.fetch = realFetch;
  }
});

test('a photo frame corner note: an icon and a line in a corner of its own', () => {
  const layout = (f) => dashboard.normalizeLayout({ screens: [{ kind: 'photoFrame', frame: f }] }).screens[0].frame;
  assert.deepEqual(layout({}).note, { text: '', icon: '', corner: 'topRight' });
  assert.equal(layout({ note: { corner: 'middle' } }).note.corner, 'topRight');
  // Nothing set: no note.
  assert.equal(frame({}).data.note, null);
  // Its own corner, its text's live values filled in (first line only).
  const states = { 'sensor.porch': st('12', { unit_of_measurement: '°C' }) };
  const d = frame({ note: { text: 'Porch {sensor.porch}\nsecond line', icon: 'home-heart', corner: 'topLeft' } }, { states }).data;
  assert.deepEqual(d.note, { icon: 'home-heart', text: 'Porch 12°C', corner: 'topLeft' });
  // An icon alone is a note too.
  assert.deepEqual(frame({ note: { icon: 'heart' } }).data.note, { icon: 'heart', text: '', corner: 'topRight' });
  // In the lines' own corner: their last line, no separate note.
  const same = frame({ corner: 'bottomLeft', date: false, note: { text: 'Welcome', icon: 'hand-wave', corner: 'bottomLeft' } }).data;
  assert.equal(same.note, null);
  assert.deepEqual(same.lines.at(-1), { icon: 'hand-wave', text: 'Welcome', big: false });
});

test('a photo frame with the footer: in the lines\' colour and edge, or contrasting with the photo under it', () => {
  const layout = (f) => dashboard.normalizeLayout({ screens: [{ kind: 'photoFrame', frame: f }] }).screens[0].frame;
  assert.equal(layout({}).footer, false);
  assert.equal(layout({ footer: true }).footer, true);
  // Off: none.
  assert.equal(frame({}).data.footer, null);
  // On: the lines' own colour and edge.
  assert.deepEqual(frame({ footer: true }).data.footer, { ink: 'white', outline: true });
  assert.deepEqual(frame({ footer: true, ink: 'black', outline: false }).data.footer, { ink: 'black', outline: false });
  // Contrasting: with the photo in the bottom right, whatever is under the lines.
  const auto = (tone, footerTone) => frame({ ink: 'auto', footer: true }, { photos: { 'frame:pf': { src: 'immich:abc', tone, footerTone } } }).data;
  assert.deepEqual(auto('light', 'dark').footer, { ink: 'white', outline: false });
  assert.equal(auto('light', 'dark').ink, 'black');
  assert.deepEqual(auto('dark', 'light').footer, { ink: 'black', outline: false });
  assert.deepEqual(auto('dark', undefined).footer, { ink: 'white', outline: true });
});
