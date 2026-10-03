'use strict';

// node --test: Settings → Security besides the allowed networks
// (lib/security.js) — sign-in length, the failed sign-in limit, and turning
// away devices the server has never seen.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sec-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../lib/security');
const auth = require('../lib/auth');
const pairing = require('../lib/pairing');

test('security: defaults as before (30 days signed in, limit on, new devices welcome); only the offered lengths', () => {
  assert.deepEqual(security.get(), { sessionHours: 720, loginLockout: true, acceptNewDevices: true });
  assert.equal(security.save({ sessionHours: 8 }).sessionHours, 8);
  assert.throws(() => security.save({ sessionHours: 5 }), /sign-in lengths/);
  assert.equal(security.get().sessionHours, 8);
});

test('security: 5 wrong passwords from one address lock it out for 15 minutes; others, and a right one, are fine', () => {
  security.resetAttempts();
  const t0 = Date.parse('2026-10-03T10:00:00Z');
  for (let i = 0; i < security.MAX_FAILS - 1; i++) assert.equal(security.noteFailure('10.0.0.9', t0 + i * 1000), 0);
  assert.ok(security.noteFailure('10.0.0.9', t0 + 5000) > 0);
  assert.ok(security.lockedFor('10.0.0.9', t0 + 6000) > 0);
  assert.equal(security.lockedFor('10.0.0.8', t0 + 6000), 0); // another address
  assert.equal(security.lockedFor('10.0.0.9', t0 + 5000 + security.LOCK_MS + 1), 0); // waited it out
  // Wrong guesses spread out over more than 15 minutes never add up.
  security.resetAttempts();
  for (let i = 0; i < 10; i++) assert.equal(security.noteFailure('10.0.0.7', t0 + i * 16 * 60 * 1000), 0);
  // Switched off: no limit.
  security.save({ loginLockout: false });
  for (let i = 0; i < 10; i++) security.noteFailure('10.0.0.6', t0);
  assert.equal(security.lockedFor('10.0.0.6', t0), 0);
  security.save({ loginLockout: true });
});

test('security: a sign-in lasts the chosen time unused, and a shorter choice applies to it too', () => {
  security.save({ sessionHours: 720 });
  const token = auth.createSession();
  const req = { headers: { cookie: `sb_session=${token}` } };
  assert.equal(auth.sessionFromRequest(req), token);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * 3600 * 1000; // two hours later
    assert.equal(auth.sessionFromRequest(req), token); // 30 days: still in
    security.save({ sessionHours: 1 });
    Date.now = () => realNow() + 4 * 3600 * 1000; // two more hours unused
    assert.equal(auth.sessionFromRequest(req), null);
  } finally {
    Date.now = realNow;
  }
  security.save({ sessionHours: 720 });
});

test('security: with new devices turned away, a stranger can\'t ask to pair; a known device still can', () => {
  assert.equal(pairing.register('aa:00:00:00:00:01', '10.0.0.2', 'remote').status, 'pending');
  security.save({ acceptNewDevices: false });
  const r = pairing.register('aa:00:00:00:00:02', '10.0.0.3', 'remote');
  assert.equal(r.error, 'not accepting new devices');
  assert.equal(r.status, 403);
  assert.equal(pairing.register('aa:00:00:00:00:01', '10.0.0.2', 'remote').status, 'pending'); // known
  security.save({ acceptNewDevices: true });
  assert.equal(pairing.register('aa:00:00:00:00:02', '10.0.0.3', 'remote').status, 'pending');
});
