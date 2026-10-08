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
