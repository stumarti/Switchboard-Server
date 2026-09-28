'use strict';

// node --test: the receiver page's now / next and picons, from an Enigma2
// box's OpenWebif (faked here) or, without one, from Home Assistant.

const test = require('node:test');
const assert = require('node:assert/strict');
const enigma2 = require('../lib/enigma2');
const clients = require('../lib/clients');
const { normalizeProfile } = require('../lib/validate');

const TZ = 'Europe/London';
const T = (hhmm) => Math.floor(Date.parse(`2026-09-28T${hhmm}:00+01:00`) / 1000);
const BBC1 = '1:0:19:1B1F:802:2:11A0000:0:0:0:';
const SKY = '1:0:1:1B2A:7E3:2:11A0000:0:0:0:';

// A fake OpenWebif: /api/getcurrent, the bouquet list and one bouquet.
function fakeBox({ calls = [], down = false } = {}) {
  return async (url, init) => {
    calls.push({ url, auth: init && init.headers && init.headers.Authorization });
    if (down) throw new Error('fetch failed');
    const u = new URL(url);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.pathname === '/api/getcurrent') {
      return json({
        info: { ref: BBC1, name: 'BBC One HD' },
        now: { title: 'Six O’Clock News', begin_timestamp: T('18:00'), duration_sec: 1800, shortdesc: 'The latest national news.' },
        next: { title: 'Regional News', begin_timestamp: T('18:30'), duration_sec: 1800, shortdesc: '' }
      });
    }
    if (u.pathname === '/api/getservices' && !u.searchParams.get('sRef')) {
      return json({ services: [{ servicereference: '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.favourites.tv" ORDER BY bouquet', servicename: 'Favourites' }] });
    }
    if (u.pathname === '/api/getservices') {
      assert.equal(u.searchParams.get('picon'), '1');
      return json({
        services: [
          { servicename: 'BBC One HD', servicereference: BBC1, picon: '/picon/1_0_19_1B1F_802_2_11A0000_0_0_0.png' },
          { servicename: 'Sky News', servicereference: SKY, picon: '/picon/skynews.png' },
          { servicename: '--- Sport ---', servicereference: '1:64:1:0:0:0:0:0:0:0::--- Sport ---', picon: '/images/default_picon.png' }
        ]
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const receiver = {
  mediaPlayerEntity: 'media_player.vu',
  boxUrl: 'http://root:secret@192.168.1.50',
  channels: [
    { name: 'BBC One', source: 'BBC One HD', usePicon: true },
    { name: 'Sky News', source: 'sky news', usePicon: true },
    { name: 'No picon', source: 'Sky News', usePicon: false },
    { name: 'Not on the box', source: 'Nowhere TV', usePicon: true }
  ]
};

test('receiver: now and next from the box, with picons for the channel and favourites', async () => {
  enigma2.clearCache();
  const calls = [];
  const info = await enigma2.receiverInfo(receiver, { timeZone: TZ, piconSrc: enigma2.piconSrcFor('den'), fetchImpl: fakeBox({ calls }) });
  assert.equal(info.source, 'box');
  assert.deepEqual(info.now, { time: '18:00–18:30', title: 'Six O’Clock News', desc: 'The latest national news.' });
  assert.deepEqual(info.next, { time: '18:30', title: 'Regional News', desc: '' });
  assert.equal(info.picon, 'rx:den:/picon/1_0_19_1B1F_802_2_11A0000_0_0_0.png');
  // By channel name, any case; off where not wanted; blank where the box has no such channel.
  assert.deepEqual(info.favourites, ['rx:den:/picon/1_0_19_1B1F_802_2_11A0000_0_0_0.png', 'rx:den:/picon/skynews.png', '', '']);
  // Credentials go in a header, never in the URL.
  assert.ok(calls.every((c) => c.url.startsWith('http://192.168.1.50/') && c.auth === `Basic ${Buffer.from('root:secret').toString('base64')}`));
  // The channel list is cached: a second look asks only for what's on.
  calls.length = 0;
  await enigma2.receiverInfo(receiver, { timeZone: TZ, piconSrc: enigma2.piconSrcFor('den'), fetchImpl: fakeBox({ calls }) });
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/api/getcurrent']);
});

test('receiver: without a box (or with one not answering) it falls back to Home Assistant', async () => {
  enigma2.clearCache();
  const haState = {
    state: 'on',
    attributes: { media_series_title: 'Six O’Clock News', media_start_time: T('18:00'), media_end_time: T('18:30'), entity_picture: '/api/media_player_proxy/media_player.vu?cache=abc' }
  };
  const noBox = { ...receiver, boxUrl: '' };
  const info = await enigma2.receiverInfo(noBox, { haState, timeZone: TZ, piconSrc: enigma2.piconSrcFor('den') });
  assert.equal(info.source, 'ha');
  assert.deepEqual(info.now, { time: '18:00–18:30', title: 'Six O’Clock News', desc: '' });
  assert.equal(info.next, null);
  assert.equal(info.picon, '/api/media_player_proxy/media_player.vu?cache=abc');
  assert.deepEqual(info.favourites, ['', '', '', '']);

  const calls = [];
  const down = await enigma2.receiverInfo(receiver, { haState, timeZone: TZ, piconSrc: enigma2.piconSrcFor('den'), fetchImpl: fakeBox({ calls, down: true }) });
  assert.equal(down.source, 'ha');
  // ...and isn't asked again straight away.
  calls.length = 0;
  await enigma2.receiverInfo(receiver, { haState, timeZone: TZ, piconSrc: enigma2.piconSrcFor('den'), fetchImpl: fakeBox({ calls }) });
  assert.equal(calls.length, 0);
  assert.equal(await enigma2.receiverInfo({ channels: [] }, {}), null);
});

test('receiver: picon srcs resolve to the room’s box only, and only to picons', () => {
  const profiles = { den: { receiver: { boxUrl: 'http://root:secret@vu.local' } } };
  const get = (slug) => profiles[slug];
  const ok = enigma2.resolvePiconSrc('rx:den:/picon/skynews.png', get);
  assert.equal(ok.url, 'http://vu.local/picon/skynews.png');
  assert.ok(ok.headers.Authorization.startsWith('Basic '));
  assert.equal(enigma2.resolvePiconSrc('rx:den:/api/powerstate?newstate=1', get), null);
  assert.equal(enigma2.resolvePiconSrc('rx:den:/picon/../api/x', get), null);
  assert.equal(enigma2.resolvePiconSrc('rx:nowhere:/picon/a.png', get), null);
  assert.equal(enigma2.resolvePiconSrc('/api/media_player_proxy/x', get), null);
  assert.equal(enigma2.defaultPicon(BBC1), '/picon/1_0_19_1B1F_802_2_11A0000_0_0_0.png');
});

test('receiver: the box address stays on the server', () => {
  const p = normalizeProfile({ receiver: { ...receiver } }, null);
  assert.equal(p.receiver.boxUrl, 'http://root:secret@192.168.1.50');
  assert.equal(p.receiver.channels[0].usePicon, true);
  const cfg = clients.composeDeviceConfig({ ...p, slug: 'den' }, { type: 'remote' });
  assert.equal(cfg.receiver.boxUrl, undefined);
  assert.equal(cfg.receiver.channels.length, 4);
});
