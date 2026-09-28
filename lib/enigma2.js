'use strict';

/**
 * An Enigma2 box's own web interface (OpenWebif), for what Home Assistant's
 * enigma2 integration doesn't give: the programme on next, and each
 * channel's picon. Optional — a room sets `receiver.boxUrl` (e.g.
 * "http://192.168.1.50", credentials allowed: "http://root:pw@vu.local");
 * without it the receiver page uses Home Assistant alone.
 *
 *   current(box)           GET /api/getcurrent -> the channel on now, its now
 *                          and next programmes
 *   channels(box)          every channel in the box's TV bouquets, with its
 *                          picon path (/api/getservices ... &picon=1), cached
 *   receiverInfo(receiver, {ha, timeZone, piconSrc})
 *                          what the remote's Receiver page draws, from the box
 *                          when it answers, else from Home Assistant's state
 *
 * Picons are served to devices through /api/art like album art, with a
 * `rx:<room slug>:<path on the box>` src the art route resolves to the box
 * (so the box's address and password never reach a device).
 */

const { URL } = require('url');

const BOX_TIMEOUT_MS = 5000;
const CHANNELS_TTL_MS = 10 * 60 * 1000;
const MAX_BOUQUETS = 20;

// "http://user:pw@host" -> {url: "http://host", headers: {Authorization}}.
function boxBase(boxUrl) {
  const raw = String(boxUrl || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const headers = {};
  if (u.username || u.password) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`;
  }
  u.username = '';
  u.password = '';
  return { url: u.toString().replace(/\/+$/, ''), headers };
}

// A box that didn't answer isn't asked again for a minute: every remote
// refresh would otherwise wait out the timeout while it's in standby.
const BOX_BACKOFF_MS = 60 * 1000;
const downUntil = new Map(); // box url -> ms

async function boxJson(box, path, fetchImpl = fetch) {
  if ((downUntil.get(box.url) || 0) > Date.now()) throw new Error('receiver not answering');
  try {
    const res = await fetchImpl(box.url + path, { headers: box.headers, signal: AbortSignal.timeout(BOX_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`receiver answered HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    downUntil.set(box.url, Date.now() + BOX_BACKOFF_MS);
    throw e;
  }
}

function event(e) {
  if (!e || !e.title || e.title === 'N/A' || !e.begin_timestamp) return null;
  return {
    title: String(e.title),
    begin: Number(e.begin_timestamp) * 1000,
    end: (Number(e.begin_timestamp) + Number(e.duration_sec || 0)) * 1000,
    desc: String(e.shortdesc || '').trim()
  };
}

async function current(box, fetchImpl) {
  const r = await boxJson(box, '/api/getcurrent', fetchImpl);
  const info = (r && r.info) || {};
  return { ref: String(info.ref || ''), name: String(info.name || ''), now: event(r && r.now), next: event(r && r.next) };
}

// Channel name -> {ref, picon}, from every TV bouquet. Cached per box.
const channelCache = new Map(); // box url -> {at, byName, byRef}
async function channels(box, fetchImpl, now = Date.now()) {
  const hit = channelCache.get(box.url);
  if (hit && now - hit.at < CHANNELS_TTL_MS) return hit;
  const bouquets = ((await boxJson(box, '/api/getservices', fetchImpl)).services || []).slice(0, MAX_BOUQUETS);
  const byName = new Map();
  const byRef = new Map();
  for (const b of bouquets) {
    const ref = b && b.servicereference;
    if (!ref) continue;
    const list = (await boxJson(box, `/api/getservices?sRef=${encodeURIComponent(ref)}&picon=1`, fetchImpl)).services || [];
    for (const s of list) {
      const name = String(s.servicename || '').trim();
      const sref = String(s.servicereference || '');
      // Markers and separators have no picon of their own.
      if (!name || !sref || s.picon === '/images/default_picon.png') continue;
      const entry = { ref: sref, picon: typeof s.picon === 'string' ? s.picon : '' };
      if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), entry);
      byRef.set(sref, entry);
    }
  }
  const out = { at: now, byName, byRef };
  channelCache.set(box.url, out);
  return out;
}

// OpenWebif's own fallback name for a service's picon: its reference with
// ":" as "_" and the trailing separators dropped.
function defaultPicon(ref) {
  const r = String(ref || '').replace(/:+$/, '');
  return r ? `/picon/${r.replace(/:/g, '_')}.png` : '';
}

function fmtTime(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(ms));
}

// Home Assistant's enigma2 attributes: timestamps may be epoch seconds or ISO.
function haTime(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * The Receiver page's extra lines and pictures.
 *   receiver   the room's receiver config
 *   haState    the receiver entity's (untrimmed or trimmed) HA state, or null
 *   piconSrc   (path) -> the /api/art src for a picon path on the box
 * Returns {now, next, picon, favourites: [picon src | ''], source: 'box'|'ha'}
 * or null with no receiver configured. Never throws: a box that doesn't
 * answer falls back to Home Assistant.
 */
async function receiverInfo(receiver, { haState, timeZone, piconSrc, fetchImpl } = {}) {
  const r = receiver || {};
  if (!r.mediaPlayerEntity) return null;
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const line = (e, withEnd) =>
    e ? { time: withEnd && e.end > e.begin ? `${fmtTime(e.begin, tz)}–${fmtTime(e.end, tz)}` : fmtTime(e.begin, tz), title: e.title, desc: e.desc || '' } : null;
  const favourites = (r.channels || []).map(() => '');
  const box = boxBase(r.boxUrl);
  if (box) {
    try {
      const cur = await current(box, fetchImpl);
      let list = null;
      try {
        list = await channels(box, fetchImpl);
      } catch {
        list = null; // no bouquet list: the picon by the reference's own name still works
      }
      const pic = (ref) => (list && list.byRef.get(ref) && list.byRef.get(ref).picon) || defaultPicon(ref);
      (r.channels || []).forEach((ch, i) => {
        if (!ch.usePicon || !list) return;
        const hit = list.byName.get(String(ch.source || '').toLowerCase());
        if (hit && hit.picon) favourites[i] = piconSrc(hit.picon);
      });
      return {
        source: 'box',
        now: line(cur.now, true),
        next: line(cur.next, false),
        picon: cur.ref ? piconSrc(pic(cur.ref)) : '',
        favourites
      };
    } catch {
      // fall through to Home Assistant
    }
  }
  const a = (haState && haState.attributes) || {};
  const begin = haTime(a.media_start_time);
  const end = haTime(a.media_end_time);
  const title = a.media_series_title || '';
  return {
    source: 'ha',
    now: title ? { time: begin ? (end && end > begin ? `${fmtTime(begin, tz)}–${fmtTime(end, tz)}` : fmtTime(begin, tz)) : '', title, desc: String(a.media_description || '').trim() } : null,
    next: null,
    // HA's enigma2 "use channel icon" option makes the picon the entity picture.
    picon: a.entity_picture ? String(a.entity_picture) : '',
    favourites
  };
}

// The src the art route resolves: rx:<slug>:<path on the box>.
function piconSrcFor(slug) {
  return (path) => (path ? `rx:${slug}:${path}` : '');
}

// rx:<slug>:<path> -> {url, headers} on that room's box, or null.
function resolvePiconSrc(src, getProfile) {
  // Only picons: a device can't use this to reach anything else on the box.
  const m = /^rx:([a-z0-9-]+):(\/picon\/[^?#]+)$/i.exec(String(src || ''));
  if (m && m[2].includes('..')) return null;
  if (!m) return null;
  const profile = getProfile(m[1]);
  const box = boxBase(profile && profile.receiver && profile.receiver.boxUrl);
  if (!box) return null;
  return { url: box.url + m[2], headers: box.headers };
}

function clearCache() {
  channelCache.clear();
  downUntil.clear();
}

module.exports = { boxBase, current, channels, defaultPicon, receiverInfo, piconSrcFor, resolvePiconSrc, haTime, clearCache };
