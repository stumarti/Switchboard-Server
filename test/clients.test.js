'use strict';

// node --test: how a device's layout is chosen — a remote from its room
// (unless customised), a viewport from its assigned dashboard.

const test = require('node:test');
const assert = require('node:assert/strict');
const clients = require('../lib/clients');
const dashboard = require('../lib/dashboard');
const { normalizeProfile } = require('../lib/validate');

const room = normalizeProfile({
  name: 'Kitchen',
  standby: { refreshIntervalMin: 15 },
  screens: { lighting: true, blinds: false, music: true, tv: false, xbox: false, climate: true, wifi: false, order: ['climate', 'status', 'lighting', 'bogus', 'climate'] },
  hub: { items: [{ id: 'h1', name: 'Lights', target: 'lighting', action: { type: 'none' } }] }
});

test("a room's carousel order is validated and kept", () => {
  assert.deepEqual(room.screens.order, ['climate', 'status', 'lighting']);
  assert.equal(room.screens.wifi, false);
  // A room saved before rooms had an order keeps the default.
  assert.deepEqual(normalizeProfile({ name: 'X' }).screens.order, []);
});

test("a remote without its own layout uses its room's order, pages, hub and refresh", () => {
  const layout = clients.layoutFor({ type: 'remote' }, room);
  assert.deepEqual(layout.carousel.map((c) => `${c.page}${c.enabled ? '' : '-'}`), [
    'climate', 'status', 'lighting', 'blinds-', 'music', 'tv-', 'xbox-', 'wifi-', 'receiver-' // the receiver starts off
  ]);
  assert.equal(layout.refreshIntervalMin, 15);
  assert.equal(layout.hub.items[0].name, 'Lights');
  const config = clients.composeDeviceConfig(room, { type: 'remote' });
  assert.deepEqual(config.screens.order, ['climate', 'status', 'lighting', 'music']);
  assert.equal(config.screens.wifi, false);
});

test("a customised remote keeps its own layout", () => {
  const own = { carousel: [{ page: 'status', enabled: true }, { page: 'music', enabled: true }], refreshIntervalMin: 60 };
  const layout = clients.layoutFor({ type: 'remote', layout: own }, room);
  assert.deepEqual(layout.carousel.filter((c) => c.enabled).map((c) => c.page), ['status', 'music']);
  assert.equal(layout.refreshIntervalMin, 60);
});

test('a viewport shows its dashboard, else a layout it still carries, else "not set up"', () => {
  const dash = dashboard.meetingRoomLayout();
  assert.equal(clients.layoutFor({ type: 'viewport' }, null, dash).screens[0].kind, 'meetingRoom');
  const carried = dashboard.blankLayout();
  assert.equal(clients.layoutFor({ type: 'viewport', layout: carried }, null, null).screens[0].id, 'home');
  const none = clients.layoutFor({ type: 'viewport' }, null, null);
  assert.equal(none.screens.length, 1);
  assert.match(none.screens[0].title, /Not set up/);
});

test('TV apps: a list of up to four with icons, still sent as the old name -> launch map', () => {
  // A room saved before the list: its fixed trio becomes the list.
  const legacy = normalizeProfile({ tv: { apps: { youtube: 'com.google.android.youtube.tv', netflix: '', tvMate: 'de.cyberdream.tvmate' } } }, null);
  assert.deepEqual(legacy.tv.appList.map((a) => [a.name, a.icon]), [['YouTube', 'youtube'], ['TV Mate', 'television-guide']]);
  assert.deepEqual(legacy.tv.apps, { YouTube: 'com.google.android.youtube.tv', 'TV Mate': 'de.cyberdream.tvmate' });
  // The new list: any names, optional icons, at most four.
  const list = [1, 2, 3, 4, 5].map((n) => ({ name: `App ${n}`, launch: `pkg.${n}`, icon: n === 1 ? 'plex' : '' }));
  const saved = normalizeProfile({ tv: { appList: list } }, legacy);
  assert.equal(saved.tv.appList.length, 4);
  assert.equal(saved.tv.appList[0].icon, 'plex');
  assert.deepEqual(Object.keys(saved.tv.apps), ['App 1', 'App 2', 'App 3', 'App 4']);
  // Saving other fields keeps the list.
  assert.equal(normalizeProfile({ tv: { mediaPlayerEntity: 'media_player.tv' } }, saved).tv.appList.length, 4);
});

test('receiver: an Enigma2 box with favourite channels; its page starts off', () => {
  const p = normalizeProfile({
    receiver: {
      mediaPlayerEntity: 'media_player.vu_uno',
      channels: [{ name: 'BBC One HD', source: 'BBC One HD', icon: 'alpha-b-box' }, ...Array.from({ length: 8 }, (_, i) => ({ name: `Ch ${i}`, source: `Ch ${i}` }))]
    }
  }, null);
  assert.equal(p.receiver.name, 'Receiver');
  assert.equal(p.receiver.channels.length, 6);
  assert.equal(p.receiver.channels[0].icon, 'alpha-b-box');
  assert.equal(p.screens.receiver, false);
  assert.equal(normalizeProfile({ screens: { receiver: true } }, p).screens.receiver, true);
  const layout = clients.layoutFor({ type: 'remote' }, normalizeProfile({ screens: { receiver: true } }, p));
  assert.equal(layout.carousel.find((c) => c.page === 'receiver').enabled, true);
});

test('refresh on the clock: the room and a customised remote carry it, with a stagger per remote', () => {
  const { normalizeProfile } = require('../lib/validate');
  const room = normalizeProfile({ name: 'Den', standby: { refreshIntervalMin: 30, refreshAligned: true } }, null);
  assert.equal(room.standby.refreshAligned, true);
  assert.equal(normalizeProfile({ name: 'Old' }, null).standby.refreshAligned, false);

  const devices = {
    'aa:00:00:00:00:03': { type: 'remote', status: 'approved' },
    'aa:00:00:00:00:01': { type: 'remote', status: 'approved' },
    'aa:00:00:00:00:02': { type: 'remote', status: 'pending' },
    'aa:00:00:00:00:04': { type: 'viewport', status: 'approved' }
  };
  // Approved remotes in MAC order, 7 s apart; anything else gets none.
  assert.equal(clients.staggerFor('aa:00:00:00:00:01', devices), 0);
  assert.equal(clients.staggerFor('aa:00:00:00:00:03', devices), 7);
  assert.equal(clients.staggerFor('aa:00:00:00:00:02', devices), 0);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`bb:${String(i).padStart(2, '0')}`, { type: 'remote', status: 'approved' }]));
  assert.ok(Object.keys(many).every((m) => clients.staggerFor(m, many) < 180)); // wraps at 3 minutes

  const cfg = clients.composeDeviceConfig({ ...room, slug: 'den' }, { type: 'remote' }, { staggerSec: 14, utcOffsetMin: 60 });
  assert.deepEqual(
    [cfg.standby.refreshIntervalMin, cfg.standby.refreshAligned, cfg.standby.refreshStaggerSec, cfg.standby.utcOffsetMin],
    [30, true, 14, 60]
  );
  // A remote customised on its own page keeps its own choice.
  const own = clients.composeDeviceConfig({ ...room, slug: 'den' }, { type: 'remote', layoutCustomized: true, layout: { refreshIntervalMin: 15, refreshAligned: false } });
  assert.equal(own.standby.refreshIntervalMin, 15);
  assert.equal(own.standby.refreshAligned, false);
  assert.equal(clients.utcOffsetMin(new Date('2026-01-15T12:00:00Z')), -new Date('2026-01-15T12:00:00Z').getTimezoneOffset());
});
