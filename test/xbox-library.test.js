'use strict';

// node --test: the Xbox page's "Browse" library, read from Home Assistant's
// media browser over a (faked) WebSocket.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const xboxLibrary = require('../lib/xbox-library');

const LONG_ART = `https://store-images.s-microsoft.com/image/${'x'.repeat(120)}`;

// HA's WebSocket API, just enough of it: auth, then browse_media answers.
function fakeHa({ token = 'tok', calls = [] } = {}) {
  const tree = {
    root: {
      title: 'Xbox',
      children: [
        { title: 'Games', media_content_type: 'game', media_content_id: 'game', can_expand: true, can_play: false },
        { title: 'Apps', media_content_type: 'app', media_content_id: 'app', can_expand: true, can_play: false }
      ]
    },
    game: {
      children: [
        { title: 'Forza Horizon 5', media_content_id: '9NKX70BBCDRN', can_play: true, thumbnail: 'https://img/fh5.png' },
        { title: 'Halo Infinite', media_content_id: '9PP5G1F0C2B6', can_play: true, thumbnail: LONG_ART }
      ]
    },
    app: {
      children: [
        { title: 'YouTube', media_content_id: '9MT5JTV6JH8S', can_play: true },
        { title: 'Forza Horizon 5', media_content_id: '9NKX70BBCDRN', can_play: true } // listed twice: kept once
      ]
    }
  };
  return class FakeWs extends EventEmitter {
    constructor(url) {
      super();
      calls.push({ url });
      setImmediate(() => this.reply({ type: 'auth_required' }));
    }
    reply(msg) {
      this.emit('message', Buffer.from(JSON.stringify(msg)));
    }
    send(raw) {
      const msg = JSON.parse(raw);
      calls.push(msg);
      if (msg.type === 'auth') return this.reply({ type: msg.access_token === token ? 'auth_ok' : 'auth_invalid' });
      const node = tree[msg.media_content_id || 'root'];
      this.reply({ id: msg.id, type: 'result', success: Boolean(node), result: node, error: node ? null : { message: 'Not found' } });
    }
    close() {}
  };
}

const base = { url: 'http://ha.local:8123', token: 'tok' };

test('xbox library: installed games and apps from HA, over the WebSocket API', async () => {
  const calls = [];
  const games = await xboxLibrary.browse(base, 'media_player.xbox', { WebSocketImpl: fakeHa({ calls }) });
  assert.equal(calls[0].url, 'ws://ha.local:8123/api/websocket');
  assert.deepEqual(games, [
    { name: 'Forza Horizon 5', productId: '9NKX70BBCDRN', art: 'https://img/fh5.png' },
    { name: 'Halo Infinite', productId: '9PP5G1F0C2B6', art: '' }, // art too long for the remote: left out
    { name: 'YouTube', productId: '9MT5JTV6JH8S', art: '' }
  ]);
  assert.ok(calls.filter((c) => c.type === 'media_player/browse_media').every((c) => c.entity_id === 'media_player.xbox'));
});

test('xbox library: a refused token is an error, not an empty library', async () => {
  await assert.rejects(
    xboxLibrary.browse({ ...base, token: 'wrong' }, 'media_player.xbox', { WebSocketImpl: fakeHa() }),
    /refused the token/
  );
});

test('xbox library: a "Browse" room is filled from the cache, which refreshes in the background', async () => {
  xboxLibrary.clearCache();
  const profile = { xbox: { listSource: 'browse', mediaPlayerEntity: 'media_player.xbox', games: [{ name: 'Typed in' }] } };
  const opts = { WebSocketImpl: fakeHa() };
  // First look: nothing cached yet, so an empty list (and a browse starts).
  assert.deepEqual(xboxLibrary.withLibrary(profile, base, opts).xbox.games, []);
  await xboxLibrary.refresh(base, 'media_player.xbox', opts); // joins the one already running
  const filled = xboxLibrary.withLibrary(profile, base, opts);
  assert.equal(filled.xbox.games.length, 3);
  assert.equal(profile.xbox.games[0].name, 'Typed in'); // the stored room is untouched
  // A "Configured" room keeps its own list, and HA isn't asked.
  const configured = { xbox: { listSource: 'configured', mediaPlayerEntity: 'media_player.xbox', games: [{ name: 'Typed in' }] } };
  assert.equal(xboxLibrary.withLibrary(configured, base, opts), configured);
  assert.equal(xboxLibrary.withLibrary(profile, null, opts).xbox.games.length, 0); // HA not set up
});
