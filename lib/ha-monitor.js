'use strict';

/**
 * How talking to Home Assistant is going, for the admin Home page: every HA
 * request the server makes (lib/ha-state.js's haRequest) is recorded here,
 * in memory. A restart starts it afresh, which is fine: it answers "is it
 * working now, and what went wrong lately", not history.
 *
 *   record(path, ms, error)       one request's outcome
 *   noteEntities(scope, errors)   a room's / layout's entities HA couldn't
 *                                 give (a typo, a renamed entity), kept per
 *                                 scope until a later fetch succeeds
 *   snapshot(now)                 what the Home page shows
 */

const RECENT_ERRORS = 20;
const WINDOW_MS = 60 * 60 * 1000; // the "last hour" counts
const BUCKET_MS = 5 * 60 * 1000;

let lastOkAt = null;
let lastErrorAt = null;
let lastError = '';
let recent = []; // newest first: {at, path, error}
let buckets = []; // {start, ok, errors, ms}
const entityIssues = new Map(); // scope key -> {scope, at, entities: {id: message}}

// Paths carry entity ids; the HA token never appears in them.
function shortPath(path) {
  return String(path || '').split('?')[0].slice(0, 120);
}

function bucketFor(t) {
  const start = Math.floor(t / BUCKET_MS) * BUCKET_MS;
  let b = buckets[buckets.length - 1];
  if (!b || b.start !== start) {
    b = { start, ok: 0, errors: 0, ms: 0 };
    buckets.push(b);
    buckets = buckets.filter((x) => x.start > t - WINDOW_MS);
  }
  return b;
}

function record(path, ms, error, now = Date.now()) {
  const b = bucketFor(now);
  if (error) {
    b.errors += 1;
    lastErrorAt = now;
    lastError = String(error.message || error);
    recent = [{ at: now, path: shortPath(path), error: lastError }, ...recent].slice(0, RECENT_ERRORS);
  } else {
    b.ok += 1;
    b.ms += ms;
    lastOkAt = now;
  }
}

// `scope` = {kind: 'room'|'layout', slug, name}; `errors` = {entityId: msg}
// from a fetch. An empty `errors` clears the scope.
function noteEntities(scope, errors, now = Date.now()) {
  const key = `${scope.kind}:${scope.slug}`;
  // Only HA's "no such entity" (404): a timeout or HA being down is a
  // connection problem, reported as such, not a problem with the layout.
  const ids = Object.keys(errors || {}).filter((k) => k.includes('.') && /404/.test(errors[k]));
  if (!ids.length) {
    entityIssues.delete(key);
    return;
  }
  const entities = {};
  for (const id of ids) entities[id] = 'not found in Home Assistant';
  entityIssues.set(key, { scope, at: now, entities });
}

function snapshot(now = Date.now()) {
  const live = buckets.filter((x) => x.start > now - WINDOW_MS);
  const ok = live.reduce((n, x) => n + x.ok, 0);
  const errors = live.reduce((n, x) => n + x.errors, 0);
  const ms = live.reduce((n, x) => n + x.ms, 0);
  return {
    lastOkAt: lastOkAt && new Date(lastOkAt).toISOString(),
    lastErrorAt: lastErrorAt && new Date(lastErrorAt).toISOString(),
    lastError,
    // Reachable unless the latest outcome was a failure.
    reachable: lastOkAt == null && lastErrorAt == null ? null : (lastOkAt || 0) >= (lastErrorAt || 0),
    lastHour: { ok, errors, avgMs: ok ? Math.round(ms / ok) : null },
    recent: recent.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
    entityIssues: [...entityIssues.values()].map((x) => ({ ...x, at: new Date(x.at).toISOString() }))
  };
}

function reset() {
  lastOkAt = null;
  lastErrorAt = null;
  lastError = '';
  recent = [];
  buckets = [];
  entityIssues.clear();
}

module.exports = { record, noteEntities, snapshot, reset };
