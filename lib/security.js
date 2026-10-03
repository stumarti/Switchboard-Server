'use strict';

/**
 * Settings → Security, besides the allowed networks (lib/netguard.js):
 *
 *   sessionHours      how long a browser stays signed in without being used
 *                     (sliding; lib/auth.js)
 *   loginLockout      after MAX_FAILS wrong passwords from one address within
 *                     WINDOW_MS, that address can't try again for LOCK_MS
 *   acceptNewDevices  whether a device the server has never seen may ask to
 *                     pair; a known one can always get a fresh token
 *
 * Saved in <DATA_DIR>/_settings.json as `security`.
 */

const store = require('./store');

const SESSION_CHOICES = [1, 8, 24, 24 * 7, 24 * 30];
const DEFAULTS = { sessionHours: 24 * 30, loginLockout: true, acceptNewDevices: true };
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function get() {
  return { ...DEFAULTS, ...((store.getSettings() || {}).security || {}) };
}

function save(body) {
  const b = body || {};
  const cur = get();
  const next = { ...cur };
  if (b.sessionHours !== undefined) {
    const h = Number(b.sessionHours);
    if (!SESSION_CHOICES.includes(h)) throw Object.assign(new Error('Pick one of the sign-in lengths offered.'), { status: 400 });
    next.sessionHours = h;
  }
  if (b.loginLockout !== undefined) next.loginLockout = Boolean(b.loginLockout);
  if (b.acceptNewDevices !== undefined) next.acceptNewDevices = Boolean(b.acceptNewDevices);
  const s = store.getSettings();
  store.saveSettings({ ...s, security: next });
  return next;
}

function sessionTtlMs() {
  return get().sessionHours * 60 * 60 * 1000;
}

// Failed sign-ins per address: {fails: [t...], lockedUntil}.
const attempts = new Map();

/** Ms until `address` may try again (0 = now). */
function lockedFor(address, now = Date.now()) {
  if (!get().loginLockout) return 0;
  const a = attempts.get(address);
  return a && a.lockedUntil > now ? a.lockedUntil - now : 0;
}

/** A wrong password from `address`; returns ms locked out (0 = not yet). */
function noteFailure(address, now = Date.now()) {
  const a = attempts.get(address) || { fails: [], lockedUntil: 0 };
  a.fails = a.fails.filter((t) => now - t < WINDOW_MS);
  a.fails.push(now);
  if (a.fails.length >= MAX_FAILS) {
    a.lockedUntil = now + LOCK_MS;
    a.fails = [];
  }
  attempts.set(address, a);
  // Forget addresses that went quiet, so the map can't grow without end.
  if (attempts.size > 1000) for (const [k, v] of attempts) if (v.lockedUntil < now && !v.fails.some((t) => now - t < WINDOW_MS)) attempts.delete(k);
  return lockedFor(address, now);
}

function noteSuccess(address) {
  attempts.delete(address);
}

// Tests only.
function resetAttempts() {
  attempts.clear();
}

module.exports = { SESSION_CHOICES, MAX_FAILS, LOCK_MS, get, save, sessionTtlMs, lockedFor, noteFailure, noteSuccess, resetAttempts };
