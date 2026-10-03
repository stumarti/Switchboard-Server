'use strict';

/**
 * Device pairing lifecycle: register -> pending -> admin approves (assigning
 * a room in the same action, see server.js's /api/pairing/:mac/approve) ->
 * approved, with a bearer token the device stores and sends on every request
 * from then on (see lib/auth.js's requireAdminOrDevice). This is also the
 * MAC -> default room mapping and "every remote that has contacted the
 * server" list in one place - see lib/store.js's _devices.json doc comment.
 *
 * Tokens: only a sha256 hash is ever persisted (store.js's tokenHash field).
 * The plaintext token is returned to the caller exactly once, at
 * issuance/rotation time, and never again retrievable.
 */

const crypto = require('crypto');
const store = require('./store');
const clients = require('./clients');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueToken() {
  return crypto.randomBytes(32).toString('hex');
}

function now() {
  return new Date().toISOString();
}

// Device's first-ever contact, and each later unauthenticated check-in while
// still pending/revoked (current firmware registers once, then checks again
// only when the user presses a button after approving it) - no auth on this
// endpoint by design, since a never-paired device has no token yet. Also how
// an approved device that lost (or had rejected) its token gets a fresh one.
// `type` is what the device says it is ('remote' | 'viewport'); older
// firmware sends none and is a remote.
function register(mac, ip, type) {
  const normalized = store.normalizeMac(mac);
  if (!store.isValidMac(normalized)) return { error: 'invalid mac' };

  const devices = store.getDevices();
  const existing = devices[normalized];
  const ts = now();

  if (!existing) {
    devices[normalized] = {
      mac: normalized,
      name: normalized,
      type: clients.normalizeType(type),
      status: 'pending',
      assignedSlug: '',
      tokenHash: '',
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastIp: ip || '',
      createdAt: ts,
      updatedAt: ts
    };
    store.saveDevices(devices);
    return { status: 'pending' };
  }

  const seenChanged = store.touchLastSeen(existing, ip);

  if (existing.status === 'approved') {
    // Self-heal: a previously-approved device that lost its NVS token (e.g.
    // a factory reset) re-registers with the same MAC and gets a fresh
    // token without needing the admin to re-approve it. The LAN trust model
    // already accepted MAC-based trust the first time this device was
    // approved; this just re-establishes the token efficiently.
    const token = issueToken();
    existing.tokenHash = hashToken(token);
    existing.updatedAt = ts;
    store.saveDevices(devices);
    return { status: 'approved', token, slug: existing.assignedSlug || '' };
  }

  // Still pending/revoked: nothing about the record changed except (maybe)
  // when it was last seen, so only write that back, and only when due.
  if (seenChanged) store.saveDevices(devices);
  return { status: existing.status };
}

function list() {
  const devices = store.getDevices();
  // Never leak tokenHash to the admin UI.
  return Object.keys(devices)
    .map((mac) => {
      const { tokenHash, ...rest } = devices[mac];
      return rest;
    })
    .sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
}

function approve(mac, slug) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  const d = devices[normalized];
  if (!d) return { error: 'no such device' };

  const token = issueToken();
  d.status = 'approved';
  d.tokenHash = hashToken(token);
  if (typeof slug === 'string') d.assignedSlug = slug;
  d.updatedAt = now();
  store.saveDevices(devices);
  return { ok: true, token, device: { ...d, tokenHash: undefined } };
}

function assign(mac, slug) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  const d = devices[normalized];
  if (!d) return { error: 'no such device' };

  d.assignedSlug = String(slug || '');
  d.updatedAt = now();
  store.saveDevices(devices);
  return { ok: true };
}

function rename(mac, name) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  const d = devices[normalized];
  if (!d) return { error: 'no such device' };

  d.name = String(name || normalized).trim() || normalized;
  d.updatedAt = now();
  store.saveDevices(devices);
  return { ok: true };
}

function revoke(mac) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  const d = devices[normalized];
  if (!d) return { error: 'no such device' };

  d.status = 'revoked';
  d.tokenHash = ''; // any request bearing the old token 401s from now on
  d.updatedAt = now();
  store.saveDevices(devices);
  return { ok: true };
}

function remove(mac) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  if (!devices[normalized]) return { error: 'no such device' };

  delete devices[normalized];
  store.saveDevices(devices);
  return { ok: true };
}

// Admin edits from the Remotes / Viewports pages: any of name, type, room
// and layout (normalized for the device's type). Returns the updated record.
function update(mac, body) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  const d = devices[normalized];
  if (!d) return { error: 'no such device' };
  const b = body || {};
  if (typeof b.name === 'string') d.name = b.name.trim() || normalized;
  if (b.type !== undefined) {
    const type = clients.normalizeType(b.type, d.type || 'remote');
    // A layout only means something for the type it was built for.
    if (type !== clients.normalizeType(d.type)) delete d.layout;
    d.type = type;
  }
  if (typeof b.room === 'string') d.assignedSlug = b.room;
  // A viewport's UI: the slug of a dashboard (lib/store.js), '' for none.
  if (typeof b.dashboard === 'string') {
    d.dashboard = b.dashboard;
    if (b.dashboard) delete d.layout; // the dashboard replaces any layout it carried
  }
  if (b.layout === null) {
    delete d.layout; // back to the default (a remote: its room's screens + hub)
  } else if (b.layout !== undefined) {
    const type = clients.normalizeType(d.type);
    d.layout = type === 'viewport'
      ? clients.normalizeViewportLayout(b.layout, d.layout)
      : clients.normalizeRemoteLayout(b.layout, d.layout);
  }
  d.updatedAt = now();
  store.saveDevices(devices);
  const { tokenHash, ...rest } = d;
  return { ok: true, device: rest };
}

// What a viewport reports about itself on each request (headers, see
// server.js's viewport routes): battery %, panel temperature and humidity,
// Wi-Fi signal, firmware. Written back only when something moved noticeably
// or the last write is 10+ minutes old, so a device polling on a timer
// doesn't rewrite _devices.json every time.
const HEALTH_WRITE_MS = 10 * 60 * 1000;
function recordHealth(mac, reported) {
  const normalized = store.normalizeMac(mac);
  const devices = store.getDevices();
  const d = devices[normalized];
  if (!d) return;
  const prev = d.health || {};
  const next = { ...prev };
  const numOr = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const fields = { battery: 1, temperature: 0.5, humidity: 2, rssi: 5 };
  let moved = false;
  for (const [k, step] of Object.entries(fields)) {
    const v = numOr(reported[k]);
    if (v === undefined) continue;
    if (prev[k] === undefined || Math.abs(v - prev[k]) >= step) moved = true;
    next[k] = v;
  }
  if (typeof reported.firmware === 'string' && reported.firmware && reported.firmware !== prev.firmware) {
    next.firmware = reported.firmware.slice(0, 64);
    moved = true;
  }
  // The kind of device (its firmware's board, for updates: lib/firmware.js).
  if (typeof reported.board === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(reported.board) && reported.board !== prev.board) {
    next.board = reported.board;
    moved = true;
  }
  const last = Date.parse(prev.at || '');
  const stale = !Number.isFinite(last) || Date.now() - last >= HEALTH_WRITE_MS;
  if (!moved && !stale) return;
  next.at = new Date().toISOString();
  d.health = next;
  store.saveDevices(devices);
}

module.exports = { register, list, approve, assign, rename, revoke, remove, update, recordHealth };
