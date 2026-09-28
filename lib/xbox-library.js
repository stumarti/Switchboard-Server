'use strict';

/**
 * The Xbox page's "Browse" library: the console's installed games and apps,
 * read from Home Assistant's media browser for the Xbox media_player.
 *
 * browse_media is a WebSocket-only Home Assistant call, and a remote only
 * speaks plain REST, so the server asks instead and hands the result to the
 * remote as the room's `xbox.games` — the same list a "Configured" room
 * types in by hand, so the firmware needs nothing new.
 *
 * The bundle a remote fetches is built synchronously, so the library comes
 * from a cache: gamesFor() answers with what's cached (empty the first
 * time) and refreshes it in the background when it's missing or older than
 * CACHE_MS. The bundle's ETag changes once the list lands, so the remote
 * picks it up on its next refresh.
 */

const WebSocket = require('ws');

const CACHE_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 1000; // after a failure, don't ask again straight away
const TIMEOUT_MS = 10000;
const MAX_GAMES = 36; // the remote's library holds 36 (kMaxXboxGames)
const MAX_ART = 127; // the remote's art field; a cut-off URL would only fail
const MAX_FOLDERS = 8;

const cache = new Map(); // entity -> { at, games, failedAt, pending }

// One browse_media conversation: authenticate, then ask for the root and
// each folder under it, collecting the playable items.
function browse(base, entity, { WebSocketImpl = WebSocket, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${base.url.replace(/^http/, 'ws')}/api/websocket`;
    const ws = new WebSocketImpl(url);
    let nextId = 1;
    const waiting = new Map();
    const done = (err, value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('Home Assistant took too long to browse the Xbox')), timeoutMs);
    const ask = (msg) =>
      new Promise((res, rej) => {
        const id = nextId++;
        waiting.set(id, { res, rej });
        ws.send(JSON.stringify({ id, ...msg }));
      });
    const browseAt = (item) =>
      ask({
        type: 'media_player/browse_media',
        entity_id: entity,
        ...(item ? { media_content_type: item.media_content_type, media_content_id: item.media_content_id } : {})
      });

    ws.on('error', (err) => done(err));
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: base.token }));
      } else if (msg.type === 'auth_invalid') {
        done(new Error('Home Assistant refused the token'));
      } else if (msg.type === 'auth_ok') {
        try {
          const root = await browseAt(null);
          const games = [];
          const take = (node) => {
            for (const c of (node && node.children) || []) {
              if (games.length >= MAX_GAMES) return;
              if (c.can_play && c.media_content_id) {
                const art = typeof c.thumbnail === 'string' && c.thumbnail.length <= MAX_ART ? c.thumbnail : '';
                games.push({ name: String(c.title || '').trim(), productId: String(c.media_content_id), art });
              }
            }
          };
          take(root);
          const folders = ((root && root.children) || []).filter((c) => c.can_expand && !c.can_play).slice(0, MAX_FOLDERS);
          for (const f of folders) take(await browseAt(f));
          const seen = new Set();
          done(null, games.filter((g) => g.name && !seen.has(g.productId) && seen.add(g.productId)));
        } catch (err) {
          done(err);
        }
      } else if (msg.type === 'result' && waiting.has(msg.id)) {
        const w = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.success) w.res(msg.result);
        else w.rej(new Error((msg.error && msg.error.message) || 'browse_media failed'));
      }
    });
  });
}

// Refresh one entity's library in the background (at most one at a time).
function refresh(base, entity, opts) {
  const entry = cache.get(entity) || { at: 0, games: [], failedAt: 0, pending: null };
  cache.set(entity, entry);
  if (entry.pending) return entry.pending;
  entry.pending = browse(base, entity, opts)
    .then((games) => {
      entry.games = games;
      entry.at = Date.now();
      entry.error = '';
      return games;
    })
    .catch((err) => {
      entry.failedAt = Date.now();
      entry.error = err.message;
      return entry.games;
    })
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

/**
 * The cached library for `entity` (possibly empty), refreshing it in the
 * background when it's stale. Never waits on Home Assistant.
 */
function gamesFor(base, entity, opts) {
  if (!base || !entity) return [];
  const entry = cache.get(entity);
  const now = Date.now();
  const stale = !entry || now - entry.at > CACHE_MS;
  const backingOff = entry && entry.failedAt && now - entry.failedAt < RETRY_MS;
  if (stale && !backingOff) refresh(base, entity, opts);
  return entry ? entry.games : [];
}

// A room's config with a "Browse" Xbox library filled in from the cache.
function withLibrary(profile, base, opts) {
  const x = profile && profile.xbox;
  if (!x || x.listSource !== 'browse' || !x.mediaPlayerEntity) return profile;
  return { ...profile, xbox: { ...x, games: gamesFor(base, x.mediaPlayerEntity, opts) } };
}

function status(entity) {
  const e = cache.get(entity);
  return e ? { count: e.games.length, at: e.at || null, error: e.error || '' } : null;
}

function clearCache() {
  cache.clear();
}

module.exports = { browse, refresh, gamesFor, withLibrary, status, clearCache };
