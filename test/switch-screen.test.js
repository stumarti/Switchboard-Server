'use strict';

// node --test: a screen the display switches to by itself (switchWhen), and
// the large Now playing.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { buildScreens, switchPlan } = require('../lib/dashboard-state');

const st = (state, attributes = {}) => ({ state: String(state), attributes });
const layout = dashboard.normalizeLayout({
  screens: [
    { id: 'home', kind: 'sections', template: 'single', columns: [[{ type: 'message', text: 'Hi' }]] },
    { id: 'alert', kind: 'sections', template: 'single', switchWhen: { mode: 'entity', entity: 'binary_sensor.weather_alert', cond: 'eq', value: 'on', checkMin: 10 }, columns: [[{ type: 'message', text: 'Storm' }]] },
    { id: 'music', kind: 'sections', template: 'sidebar', switchWhen: { mode: 'playing' }, columns: [[{ type: 'message', text: 'x' }], [{ type: 'media', style: 'large', players: [{ entity: 'media_player.kitchen' }] }]] }
  ]
});

test('switch: a screen takes over while its rule holds, the first one winning', () => {
  assert.deepEqual(layout.screens[0].switchWhen, { mode: 'never', entity: '', cond: 'eq', value: '', checkMin: 0 });
  assert.equal(layout.screens[2].switchWhen.checkMin, 5); // the default
  const plan = (states) => switchPlan(layout, { states });
  // Nothing on: no switch, but the display looks every 5 minutes (the most often of the rules).
  assert.deepEqual(plan({}), { switchTo: '', checkSec: 300 });
  // Playing on the screen's Now playing: there.
  assert.equal(plan({ 'media_player.kitchen': st('playing') }).switchTo, 'music');
  assert.equal(plan({ 'media_player.kitchen': st('paused') }).switchTo, '');
  // Both: the earlier screen wins.
  assert.equal(plan({ 'media_player.kitchen': st('playing'), 'binary_sensor.weather_alert': st('on') }).switchTo, 'alert');
  // A switched-off screen never takes over.
  const off = dashboard.normalizeLayout({ ...layout, screens: layout.screens.map((s) => (s.id === 'alert' ? { ...s, enabled: false } : s)) });
  assert.equal(switchPlan(off, { states: { 'binary_sensor.weather_alert': st('on') } }).switchTo, '');
});

test('media: large, the one playing, with how far into the track', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const states = {
    'media_player.kitchen': st('playing', {
      media_title: 'Song', media_artist: 'Band', media_album_name: 'Album', media_duration: 200, media_position: 30,
      media_position_updated_at: '2026-10-25T11:59:20Z', entity_picture: '/api/media_player_proxy/media_player.kitchen?token=abc&cache=1'
    })
  };
  const s = buildScreens(layout, { states, now, timeZone: 'Europe/Dublin' }).music;
  const d = s.columns[1][0].data;
  assert.equal(d.style, 'large');
  assert.equal(d.players.length, 1);
  const p = d.players[0];
  assert.deepEqual([p.title, p.artist, p.album, p.duration, p.position], ['Song', 'Band', 'Album', 200, 70]); // 30 s + the 40 since
  assert.ok(!p.art.includes('token='));
  // Cover: the same, as its own style.
  const c = dashboard.normalizeLayout({ screens: [{ id: 'a', kind: 'sections', template: 'sidebar', columns: [[{ type: 'media', style: 'cover', players: [{ entity: 'media_player.kitchen' }] }], []] }] });
  const cd = buildScreens(c, { states, now }).a.columns[0][0].data;
  assert.deepEqual([cd.style, cd.players[0].position, cd.players[0].album], ['cover', 70, 'Album']);
  // A list (the default) has none of that.
  const l = dashboard.normalizeLayout({ screens: [{ id: 'a', kind: 'sections', template: 'single', columns: [[{ type: 'media', players: [{ entity: 'media_player.kitchen' }] }]] }] });
  const ld = buildScreens(l, { states, now }).a.columns[0][0].data;
  assert.equal(ld.style, undefined);
  assert.equal(ld.players[0].position, undefined);
});
