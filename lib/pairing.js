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
function register(mac, ip) {
  const normalized = store.normalizeMac(mac);
  if (!store.isValidMac(normalized)) return { error: 'invalid mac' };

  const devices = store.getDevices();
  const existing = devices[normalized];
  const ts = now();

  if (!existing) {
    devices[normalized] = {
      mac: normalized,
      name: normalized,
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

module.exports = { register, list, approve, assign, rename, revoke, remove };
