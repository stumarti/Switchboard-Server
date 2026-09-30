'use strict';

// node --test: learned battery life (lib/battery-history.js) — readings in,
// "about N days left" out, learning across charges.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-batt-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const bh = require('../lib/battery-history');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-01T00:00:00Z');

// A remote reporting every 30 min, draining `perDay` % a day, in whole
// percents like a fuel gauge.
function drain(entry, fromPct, perDay, days, start = T0) {
  for (let t = 0; t <= days * DAY; t += HOUR / 2) bh.addSample(entry, Math.round(fromPct - (perDay * t) / DAY), start + t);
  return start + days * DAY;
}

test('battery: learning at first, then days left from the drain since the last charge', () => {
  const e = { samples: [] };
  bh.addSample(e, 90, T0);
  bh.addSample(e, 90, T0 + 10 * 60 * 1000); // same level, too soon: not kept
  assert.equal(e.samples.length, 1);
  assert.equal(bh.estimateFor(e, T0).daysLeft, null); // learning

  const end = drain(e, 90, 2, 7); // 2% a day for a week: 90 -> 76
  const est = bh.estimateFor(e, end);
  assert.equal(est.basis, 'measured');
  assert.ok(Math.abs(est.ratePerDay - 2) < 0.1, est.ratePerDay);
  assert.ok(Math.abs(est.daysLeft - (76 - bh.EMPTY_PCT) / 2) < 1, est.daysLeft); // ~35 days
  assert.ok(Math.abs(est.fullChargeDays - 48) <= 1, est.fullChargeDays); // 95 points at ~2%/day
  // A day later with no new reading, a day less.
  assert.ok(Math.abs(bh.estimateFor(e, end + DAY).daysLeft - (est.daysLeft - 1)) < 0.2);
});

test('battery: a charge starts over, and the rate learned before it answers until there is enough new data', () => {
  const e = { samples: [] };
  let t = drain(e, 95, 3, 6); // 95 -> 77 at 3%/day
  // Charging back up over an hour, then a fresh start.
  for (const p of [80, 86, 93, 100]) bh.addSample(e, p, (t += 15 * 60 * 1000));
  assert.equal(e.discharges, 1);
  assert.ok(Math.abs(e.learnedRate - 3) < 0.15, e.learnedRate);
  const soon = bh.estimateFor(e, t + HOUR);
  assert.equal(soon.basis, 'learned'); // too little since the charge to measure
  assert.ok(Math.abs(soon.daysLeft - (100 - bh.EMPTY_PCT) / 3) < 1.5, soon.daysLeft);
  assert.equal(soon.sinceChargeDays, 0);

  // A couple of days on, at a slower 1%/day: now measured from the new data.
  t = drain(e, 100, 1, 3, t + HOUR);
  const later = bh.estimateFor(e, t);
  assert.equal(later.basis, 'measured');
  assert.ok(Math.abs(later.ratePerDay - 1) < 0.15, later.ratePerDay);
});

test('battery: a device that barely drains, or odd readings, gives no false estimate', () => {
  const e = { samples: [] };
  drain(e, 80, 0, 3); // flat for 3 days
  assert.equal(bh.estimateFor(e, T0 + 3 * DAY).daysLeft, null);
  assert.equal(bh.addSample(e, 0, T0 + 4 * DAY), false); // 0 = "not read yet"
  assert.equal(bh.addSample(e, 'x', T0 + 4 * DAY), false);
  assert.equal(bh.estimateFor({ samples: [] }), null);
});

test('battery: note() keeps readings per device and forget() drops them', () => {
  bh.reset();
  const mac = 'AA:00:00:00:00:09';
  for (let i = 0; i < 60; i++) bh.note(mac, 90 - Math.floor(i / 12), T0 + i * HOUR);
  const est = bh.estimate(mac, T0 + 60 * HOUR);
  assert.equal(est.pct, 86);
  assert.equal(est.basis, 'measured');
  bh.flush(true);
  bh.reset();
  assert.equal(bh.estimate(mac, T0 + 60 * HOUR).pct, 86); // read back from disk
  bh.forget(mac);
  assert.equal(bh.estimate(mac), null);
});
