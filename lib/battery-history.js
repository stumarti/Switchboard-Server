'use strict';

/**
 * Battery life, learned: how many days each device has left.
 *
 * Every device reports its battery % on its requests (X-Battery). This keeps
 * a thinned history of those readings per device, and from it:
 *
 *   - charges: the level rising CHARGE_JUMP points or more above the last
 *     few readings starts a new discharge, once the next reading stays up
 *     too (or at once for a rise of BIG_JUMP): a device that works its level
 *     out from the battery's voltage reads a few percent high now and then,
 *     and that isn't a charge. The reading at the top of the rise is where
 *     the discharge starts
 *   - the drain rate since then (least-squares slope, % per day), once
 *     there's MIN_SPAN_MS of it, the level has fallen MIN_DROP points (a
 *     fuel gauge moves in whole percents, so less than that is noise), and
 *     the slope stands MIN_T standard errors clear of the readings' scatter
 *     (so noisy readings can't make "433 days" out of a flat line)
 *   - a learned rate, carried across charges: each completed discharge long
 *     enough to measure folds its rate into it (a moving average), and it
 *     answers until the current discharge has enough data of its own
 *   - days left = (level - EMPTY_PCT) / rate: EMPTY_PCT is about where a
 *     remote parks on its charge screen
 *
 * The history is thinned to one reading per SAMPLE_MS (or on a change of
 * level) and kept for KEEP_MS, in <DATA_DIR>/_battery-history.json, written
 * at most once per WRITE_MS.
 */

const path = require('path');
const store = require('./store');

const FILE = path.join(store.DATA_DIR, '_battery-history.json');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SAMPLE_MS = 30 * 60 * 1000;
const KEEP_MS = 45 * DAY;
const MAX_SAMPLES = 2500;
const WRITE_MS = 5 * 60 * 1000;
const CHARGE_JUMP = 3;
const BIG_JUMP = 10;
const CHARGE_REF = 6;
const MIN_SPAN_MS = 12 * HOUR;
const MIN_DROP = 2;
const MIN_T = 4;
const EMPTY_PCT = 5;
const LEARN_MIN_SPAN_MS = 2 * DAY;
const LEARN_MIN_DROP = 5;

let cache = null;
let dirty = false;
let lastWrite = 0;

function data() {
  if (!cache) cache = store.readJsonFile(FILE, () => ({ devices: {} }));
  if (!cache.devices) cache.devices = {};
  return cache;
}

function flush(force = false) {
  if (!dirty || (!force && Date.now() - lastWrite < WRITE_MS)) return;
  store.writeJsonAtomic(FILE, cache);
  dirty = false;
  lastWrite = Date.now();
}

// Where charges start: a reading CHARGE_JUMP or more above the highest of
// the CHARGE_REF before it, which the next reading confirms (or BIG_JUMP or
// more, which needs no confirming).
function chargeStarts(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].p - samples[i - 1].p < CHARGE_JUMP) continue;
    let ref = 0;
    for (let j = Math.max(0, i - CHARGE_REF); j < i; j++) ref = Math.max(ref, samples[j].p);
    const rise = samples[i].p - ref;
    if (rise < CHARGE_JUMP) continue;
    if (rise >= BIG_JUMP || (i + 1 < samples.length && samples[i + 1].p >= ref + CHARGE_JUMP)) {
      out.push(i);
      // The rest of the rise is the same charge.
      while (i + 1 < samples.length && samples[i + 1].p > samples[i].p) i++;
    }
  }
  return out;
}

// The discharge in progress: the readings since the top of the last charge.
function currentDischarge(samples) {
  const starts = chargeStarts(samples);
  const charge = starts.length ? starts[starts.length - 1] : -1;
  let start = Math.max(0, charge);
  // Still charging (rising after the jump): move to the top.
  if (charge >= 0) while (start + 1 < samples.length && samples[start + 1].p > samples[start].p) start++;
  return { start, charge, samples: samples.slice(start) };
}

// % per day it's falling (positive), by least squares; null without enough.
function drainRate(samples) {
  if (samples.length < 3) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.t - first.t < MIN_SPAN_MS || first.p - last.p < MIN_DROP) return null;
  const n = samples.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = (s.t - first.t) / DAY;
    sx += x;
    sy += s.p;
    sxx += x * x;
    sxy += x * s.p;
  }
  const den = n * sxx - sx * sx;
  if (den <= 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  if (slope >= 0) return null;
  // How far the readings scatter about the line, and so how sure the slope is.
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  for (const s of samples) {
    const r = s.p - (intercept + slope * ((s.t - first.t) / DAY));
    ss += r * r;
  }
  const se = Math.sqrt((ss / Math.max(1, n - 2)) * (n / den));
  if (se > 0 && -slope / se < MIN_T) return null;
  return -slope;
}

/**
 * Records a reading; returns true if it was kept. Pure on `entry`
 * (exported for the tests); note() is the stored version.
 */
function addSample(entry, pct, t) {
  const p = Math.round(Number(pct));
  if (!Number.isFinite(p) || p < 1 || p > 100) return false;
  const samples = entry.samples || (entry.samples = []);
  const prev = samples[samples.length - 1];
  if (prev && prev.p === p && t - prev.t < SAMPLE_MS) return false;
  if (prev && t <= prev.t) return false;
  samples.push({ t, p });
  // A charge (confirmed by this reading, or a big one) ends the discharge
  // before it: learn from that if it was long enough.
  const starts = chargeStarts(samples);
  const c = starts.length ? starts[starts.length - 1] : -1;
  if (c > 0 && samples[c].t > (entry.lastChargedAt || 0)) {
    const { samples: seg } = currentDischarge(samples.slice(0, c));
    const rate = drainRate(seg);
    const span = seg.length ? seg[seg.length - 1].t - seg[0].t : 0;
    const drop = seg.length ? seg[0].p - seg[seg.length - 1].p : 0;
    if (rate && span >= LEARN_MIN_SPAN_MS && drop >= LEARN_MIN_DROP) {
      entry.learnedRate = entry.learnedRate ? entry.learnedRate * 0.5 + rate * 0.5 : rate;
      entry.discharges = (entry.discharges || 0) + 1;
    }
    entry.lastChargedAt = samples[c].t;
  }
  const cutoff = t - KEEP_MS;
  while (samples.length && (samples[0].t < cutoff || samples.length > MAX_SAMPLES)) samples.shift();
  return true;
}

/**
 * The estimate for one device's history (pure):
 *   {pct, daysLeft, ratePerDay, basis: 'measured'|'learned'|null,
 *    sinceChargeDays, fullChargeDays, discharges}
 * daysLeft null while it's still learning.
 */
function estimateFor(entry, now = Date.now()) {
  const samples = (entry && entry.samples) || [];
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  const { samples: seg, charge } = currentDischarge(samples);
  const measured = drainRate(seg);
  const rate = measured || entry.learnedRate || null;
  const basis = measured ? 'measured' : entry.learnedRate ? 'learned' : null;
  // The reading is from the device's last check-in: count time since then.
  const elapsedDays = Math.max(0, (now - last.t) / DAY);
  const daysLeft = rate ? Math.max(0, (last.p - EMPTY_PCT) / rate - elapsedDays) : null;
  const since = charge >= 0 ? seg[0].t : entry.lastChargedAt || seg[0].t;
  return {
    pct: last.p,
    daysLeft: daysLeft == null ? null : Math.round(daysLeft * 10) / 10,
    ratePerDay: rate ? Math.round(rate * 100) / 100 : null,
    basis,
    sinceChargeDays: Math.round(((now - since) / DAY) * 10) / 10,
    // A whole charge (100% to empty) at this rate.
    fullChargeDays: rate ? Math.round((100 - EMPTY_PCT) / rate) : null,
    discharges: entry.discharges || 0
  };
}

/** A device reported `pct` just now. */
function note(mac, pct, t = Date.now()) {
  if (pct == null || pct === '') return;
  const d = data();
  const key = store.normalizeMac(mac);
  if (!key) return;
  const entry = d.devices[key] || (d.devices[key] = { samples: [] });
  if (addSample(entry, pct, t)) {
    dirty = true;
    flush();
  }
}

function estimate(mac, now = Date.now()) {
  return estimateFor(data().devices[store.normalizeMac(mac)], now);
}

function forget(mac) {
  const d = data();
  delete d.devices[store.normalizeMac(mac)];
  dirty = true;
  flush(true);
}

// Tests only: drop the in-memory copy.
function reset() {
  cache = null;
  dirty = false;
  lastWrite = 0;
}

module.exports = { note, estimate, forget, flush, addSample, estimateFor, drainRate, reset, EMPTY_PCT };
