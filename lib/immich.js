'use strict';

/**
 * Immich (immich.app): photos for viewports, from your own library.
 *
 * The connection — the server's address and an API key — is kept here, in
 * <DATA_DIR>/immich.json, apart from the globals (which devices can read).
 * Displays never see it: a photo reaches them as `immich:<asset id>`, which
 * /api/art fetches from Immich with the key and turns into the panel's six
 * inks (lib/art.js), like album art.
 *
 * Sources (a photo section's, or a screen background's):
 *   album      the photos in one album
 *   favorites  your favourites
 *   person     the photos of one recognised person
 *   memories   "on this day": photos taken on today's date in earlier years
 *              (falls back to favourites on a day with none)
 *   random     any photo in the library
 *
 * Which photo: each source changes every `every` minutes, in random order
 * (a hash of the section's id and the period picks from the source's list)
 * or in sequence (the next one each period, oldest first, from the start
 * again after the last). Within one period the choice is fixed, so a screen's state, and its ETag, stay the same until
 * the photo is due to change; a display wakes, sees nothing new, and sleeps.
 * Lists are cached for LIST_MS; a failure keeps the last good list.
 *
 * Immich's API (v1.118 and later): `x-api-key` on every request;
 * GET /api/users/me, /api/albums, /api/albums/:id, /api/people,
 * /api/memories; POST /api/search/metadata, /api/search/random;
 * GET /api/assets/:id/thumbnail?size=preview (a JPEG about 1440 px), or
 * ?size=fullsize (a JPEG at the photo's own size, Immich 1.126 and later)
 * for a picture bigger than that: a whole E1004 panel is 1600 px across.
 */

const path = require('path');
const store = require('./store');

const FILE = path.join(store.DATA_DIR, 'immich.json');
const KINDS = ['album', 'favorites', 'person', 'memories', 'random'];
const TIMEOUT_MS = 10000;
const LIST_MS = 10 * 60 * 1000;
const MAX_ASSETS = 2000;

// --- The connection ------------------------------------------------------------

function defaults() {
  return { url: '', apiKey: '' };
}

function get() {
  const c = store.readJsonFile(FILE, defaults);
  return { url: String(c.url || ''), apiKey: String(c.apiKey || '') };
}

// "photos.example.com" -> "https://photos.example.com"; no trailing slash,
// and no "/api" (added per request).
function cleanUrl(v) {
  let u = String(v || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!u) return '';
  const bad = () => Object.assign(new Error(`${v} isn't a web address`), { status: 400 });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !/^https?:\/\//i.test(u)) throw bad();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    return u;
  } catch {
    throw bad();
  }
}

// What the admin UI sees: the address, and whether a key is set — never the key.
function publicView(c = get()) {
  return { url: c.url, hasKey: Boolean(c.apiKey), configured: Boolean(c.url && c.apiKey) };
}

// `apiKey` left out (or empty) keeps the one saved; `clearKey` removes it.
function save(body) {
  const b = body || {};
  const old = get();
  const next = {
    url: b.url === undefined ? old.url : cleanUrl(b.url),
    apiKey: b.clearKey ? '' : String(b.apiKey || '').trim() || old.apiKey
  };
  store.writeJsonAtomic(FILE, next);
  lists.clear();
  return publicView(next);
}

function configured(c = get()) {
  return Boolean(c.url && c.apiKey);
}

// --- Requests ---------------------------------------------------------------------

async function request(p, { method = 'GET', body, conn = get(), fetchImpl = fetch, raw = false } = {}) {
  if (!configured(conn)) throw Object.assign(new Error('Immich isn’t set up: add its address and an API key in Settings → Immich.'), { status: 409 });
  let res;
  try {
    res = await fetchImpl(`${conn.url}/api${p}`, {
      method,
      headers: { 'x-api-key': conn.apiKey, accept: raw ? 'image/*' : 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    throw Object.assign(new Error(`Can't reach Immich at ${new URL(conn.url).host}: ${e.message}`), { status: 502 });
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Immich refused the API key.'), { status: 502 });
  if (!res.ok) throw Object.assign(new Error(`Immich answered HTTP ${res.status} for ${p.split('?')[0]}`), { status: 502 });
  return raw ? res : res.json();
}

// Settings → Immich → Test: who the key belongs to, and the albums count.
async function test(opts = {}) {
  const me = await request('/users/me', opts);
  const albums = await request('/albums', opts);
  return { user: me.name || me.email || '', albums: Array.isArray(albums) ? albums.length : 0 };
}

async function albums(opts = {}) {
  const list = await request('/albums', opts);
  return (Array.isArray(list) ? list : [])
    .map((a) => ({ id: String(a.id), name: String(a.albumName || ''), count: Number(a.assetCount) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function people(opts = {}) {
  const r = await request('/people?withHidden=false', opts);
  return ((r && r.people) || [])
    .filter((p) => p.name)
    .map((p) => ({ id: String(p.id), name: String(p.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Sources ------------------------------------------------------------------------

function normalizeSource(v) {
  const x = v && typeof v === 'object' ? v : {};
  const kind = KINDS.includes(x.kind) ? x.kind : 'favorites';
  return { kind, album: String(x.album || '').slice(0, 64), person: String(x.person || '').slice(0, 64) };
}

// An asset as the rest of the server needs it.
function slim(a) {
  const exif = a.exifInfo || {};
  return {
    id: String(a.id),
    taken: String(a.localDateTime || a.fileCreatedAt || ''),
    place: [exif.city, exif.country].filter(Boolean).join(', ')
  };
}
const isImage = (a) => a && a.id && (a.type === undefined || a.type === 'IMAGE') && !a.isTrashed && !a.isArchived;

async function search(filter, opts) {
  const out = [];
  for (let page = 1; out.length < MAX_ASSETS && page <= 10; page++) {
    const r = await request('/search/metadata', { ...opts, method: 'POST', body: { ...filter, type: 'IMAGE', withExif: true, size: 250, page } });
    const items = (r && r.assets && r.assets.items) || [];
    out.push(...items);
    if (!r || !r.assets || !r.assets.nextPage) break;
  }
  return out;
}

// "On this day": Immich's memories for `now`'s date.
async function memories(now, opts) {
  const r = await request(`/memories?for=${encodeURIComponent(now.toISOString())}`, opts).catch(() => null);
  const assets = [];
  for (const m of Array.isArray(r) ? r : []) if (!m.type || m.type === 'on_this_day') assets.push(...(m.assets || []));
  return assets;
}

async function fetchList(source, now, opts) {
  switch (source.kind) {
    case 'album': {
      if (!source.album) return [];
      const r = await request(`/albums/${encodeURIComponent(source.album)}?withoutAssets=false`, opts);
      return (r && r.assets) || [];
    }
    case 'person':
      return source.person ? search({ personIds: [source.person] }, opts) : [];
    case 'memories': {
      const m = await memories(now, opts);
      return m.length ? m : search({ isFavorite: true }, opts);
    }
    case 'random': {
      const r = await request('/search/random', { ...opts, method: 'POST', body: { size: 100, type: 'IMAGE', withExif: true } });
      return Array.isArray(r) ? r : [];
    }
    default:
      return search({ isFavorite: true }, opts);
  }
}

const lists = new Map(); // key -> {at, assets, pending}

function listKey(source, now) {
  // Memories change with the date; random with the hour (a fresh sample).
  const extra = source.kind === 'memories' ? now.toISOString().slice(0, 10) : source.kind === 'random' ? Math.floor(now / 3600000) : '';
  return `${source.kind}|${source.album}|${source.person}|${extra}`;
}

// The source's photos, cached; the last good list if Immich fails.
async function list(source, now = new Date(), opts = {}) {
  const key = listKey(source, now);
  const hit = lists.get(key);
  if (hit && hit.assets && Date.now() - hit.at < LIST_MS) return hit.assets;
  if (hit && hit.pending) return hit.pending;
  const pending = fetchList(source, now, opts)
    .then((raw) => {
      const assets = raw.filter(isImage).slice(0, MAX_ASSETS).map(slim);
      lists.set(key, { at: Date.now(), assets });
      return assets;
    })
    .catch((e) => {
      const prev = lists.get(key);
      if (prev && prev.assets) {
        lists.set(key, { at: Date.now(), assets: prev.assets });
        return prev.assets;
      }
      lists.delete(key);
      throw e;
    });
  lists.set(key, { ...(hit || {}), pending });
  return pending;
}

function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

// Oldest first (then by id, so the order never wobbles).
function byTaken(assets) {
  return [...assets].sort((a, b) => (a.taken < b.taken ? -1 : a.taken > b.taken ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The photo for `seed` (a section's or screen's id) in the period `now` is
// in: any of them (random), or the period's turn in date order (sequential).
function choose(assets, seed, everyMin, now = new Date(), order = 'random') {
  if (!assets.length) return null;
  const period = Math.floor(now.getTime() / (Math.max(1, everyMin) * 60000));
  if (order === 'sequential') return byTaken(assets)[period % assets.length];
  return assets[fnv(`${seed}|${period}`) % assets.length];
}

// When the photo next changes.
function nextChange(everyMin, now = new Date()) {
  const ms = Math.max(1, everyMin) * 60000;
  return new Date((Math.floor(now.getTime() / ms) + 1) * ms);
}

/**
 * The photo for a section or background: {id, src, caption} or {error}.
 * `caption`: none | date | place | both.
 */
async function pick({ source, every = 60, order = 'random', caption = 'none', seed = '' }, now = new Date(), timeZone, opts = {}) {
  if (!configured(opts.conn || get())) return { error: 'Set up Immich in Settings' };
  try {
    const src = normalizeSource(source);
    const assets = await list(src, now, opts);
    const a = choose(assets, seed, every, now, order);
    if (!a) return { error: src.kind === 'album' && !src.album ? 'Pick an album' : src.kind === 'person' && !src.person ? 'Pick a person' : 'No photos' };
    return { id: a.id, src: `immich:${a.id}`, caption: captionFor(a, caption, timeZone) };
  } catch (e) {
    return { error: e.message };
  }
}

function captionFor(a, mode, timeZone) {
  if (!mode || mode === 'none') return '';
  let date = '';
  if (a.taken) {
    // localDateTime is the camera's wall time, written as if UTC.
    const d = new Date(a.taken);
    if (Number.isFinite(d.getTime())) date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  if (mode === 'date') return date;
  if (mode === 'place') return a.place;
  // An en dash: the panel's fonts draw it (as "-"), not a middle dot.
  return [a.place, date].filter(Boolean).join(' – ');
}

// For /api/art: an `immich:<asset id>` source as the URL and header to fetch
// it with (lib/art.js's resolve hook). Anything else: null.
const ASSET_RE = /^immich:([0-9a-f-]{8,64})$/i;
// `side`: the picture's longest side. Past the preview's 1440 px, the full
// size, with the preview to fall back on (an older Immich has no fullsize).
const PREVIEW_SIDE = 1440;
function resolveSrc(src, conn = get(), side = 0) {
  const m = ASSET_RE.exec(String(src || ''));
  if (!m) return null;
  if (!configured(conn)) throw Object.assign(new Error('Immich isn’t set up'), { status: 409 });
  const base = `${conn.url}/api/assets/${m[1]}/thumbnail`;
  const headers = { 'x-api-key': conn.apiKey };
  if (side > PREVIEW_SIDE) return { url: `${base}?size=fullsize`, headers, fallback: `${base}?size=preview` };
  return { url: `${base}?size=preview`, headers };
}

module.exports = {
  KINDS,
  get,
  save,
  publicView,
  configured,
  cleanUrl,
  test,
  albums,
  people,
  normalizeSource,
  list,
  choose,
  nextChange,
  pick,
  captionFor,
  resolveSrc,
  _lists: lists
};
