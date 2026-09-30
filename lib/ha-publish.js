'use strict';

/**
 * Battery status, published back to Home Assistant (optional; Settings →
 * Home Assistant → "Publish battery to Home Assistant", off by default).
 *
 * Each paired device with a battery reading gets two sensors, set through
 * Home Assistant's REST API (POST /api/states/<entity_id>):
 *
 *   sensor.switchboard_<name>_battery            82 (%), device_class battery
 *   sensor.switchboard_<name>_battery_days_left  33.5 (d), or "unknown" while
 *                                                 it's still learning
 *
 * with the device's room or layout, firmware, last check-in and the learned
 * drain rate as attributes (lib/battery-history.js). Nothing is needed in
 * Home Assistant: no MQTT, no integration.
 *
 * States set this way live until Home Assistant restarts, and aren't
 * editable in its UI (they have no unique id), so they're re-sent every
 * REFRESH_MS as well as whenever a value changes. A renamed or removed
 * device's old sensors are deleted, and switching publishing off deletes
 * them all. What was published is kept in <DATA_DIR>/_ha-published.json so
 * that survives a restart of this server too.
 */

const path = require('path');
const store = require('./store');
const batteryHistory = require('./battery-history');
const ha = require('./ha-state');

const FILE = path.join(store.DATA_DIR, '_ha-published.json');
const REFRESH_MS = 10 * 60 * 1000; // re-send even when unchanged (HA restarts)
const KICK_DELAY_MS = 5 * 1000; // a check-in's reading, batched with others
const TICK_MS = 60 * 1000;

let timer = null;
let kickTimer = null;
let running = null;
let status = { lastSyncAt: null, published: 0, error: null };

function enabled(globals = store.getGlobals()) {
  return Boolean(globals && globals.homeAssistant && globals.homeAssistant.publishBattery);
}

// "Kitchen remote" -> "kitchen_remote": Home Assistant's object-id rules.
function objectId(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The sensors every device should have now (pure: exported for the tests):
 * {entity_id: {state, attributes}}. Two devices with the same name are told
 * apart by the end of their MAC address.
 */
function desiredStates(devices, { estimate = batteryHistory.estimate, dashboards = {} } = {}) {
  const list = Object.values(devices || {}).filter((d) => d && d.status === 'approved' && d.health && Number.isFinite(Number(d.health.battery)));
  const counts = {};
  for (const d of list) {
    const id = objectId(d.name && d.name !== d.mac ? d.name : `device ${d.mac}`);
    counts[id] = (counts[id] || 0) + 1;
  }
  const out = {};
  for (const d of list) {
    const name = d.name && d.name !== d.mac ? d.name : d.mac;
    let id = objectId(d.name && d.name !== d.mac ? d.name : `device ${d.mac}`);
    if (counts[id] > 1) id += `_${d.mac.replace(/:/g, '').slice(-4)}`;
    const base = `sensor.switchboard_${id}`;
    const life = estimate(d.mac) || {};
    const type = d.type || 'remote';
    const common = {
      switchboard_mac: d.mac,
      switchboard_type: type,
      ...(type === 'viewport' ? { layout: (dashboards[d.dashboard] && dashboards[d.dashboard].name) || d.dashboard || '' } : { room: d.assignedSlug || '' }),
      firmware: d.health.firmware || '',
      last_seen: d.lastSeenAt || d.health.at || ''
    };
    out[`${base}_battery`] = {
      state: String(Math.round(Number(d.health.battery))),
      attributes: {
        friendly_name: `${name} battery`,
        unit_of_measurement: '%',
        device_class: 'battery',
        state_class: 'measurement',
        icon: type === 'viewport' ? 'mdi:tablet' : 'mdi:remote',
        ...common,
        days_left: life.daysLeft ?? null,
        drain_per_day: life.ratePerDay ?? null,
        estimate_from: life.basis || null,
        days_since_charge: life.sinceChargeDays ?? null
      }
    };
    out[`${base}_battery_days_left`] = {
      state: life.daysLeft == null ? 'unknown' : String(life.daysLeft),
      attributes: {
        friendly_name: `${name} battery days left`,
        unit_of_measurement: 'd',
        device_class: 'duration',
        state_class: 'measurement',
        icon: 'mdi:battery-clock-outline',
        ...common,
        full_charge_days: life.fullChargeDays ?? null
      }
    };
  }
  return out;
}

function loadPublished() {
  const d = store.readJsonFile(FILE, () => ({ entities: {} }));
  return d && d.entities ? d : { entities: {} };
}

/**
 * Bring Home Assistant in line: send what's new, changed or due a refresh,
 * delete what's gone. Returns the status. Never throws.
 */
async function sync({ now = Date.now(), request = ha.haRequest } = {}) {
  if (running) return running;
  running = (async () => {
    const globals = store.getGlobals();
    const base = ha.haBase(globals);
    const published = loadPublished();
    const on = enabled(globals);
    const want = on ? desiredStates(store.getDevices(), { dashboards: Object.fromEntries(store.listDashboards().map((x) => [x.slug, x])) }) : {};
    let error = null;
    let changed = false;
    if (!base) {
      status = { ...status, error: on ? 'Home Assistant isn’t set up.' : null, published: 0 };
      return status;
    }
    for (const [id, st] of Object.entries(want)) {
      const prev = published.entities[id];
      const body = JSON.stringify(st);
      if (prev && prev.body === body && now - prev.at < REFRESH_MS) continue;
      try {
        await request(base, `/api/states/${id}`, { method: 'POST', body });
        published.entities[id] = { body, at: now };
        changed = true;
      } catch (e) {
        error = `Couldn't set ${id}: ${e.message}`;
        break;
      }
    }
    if (!error) {
      for (const id of Object.keys(published.entities)) {
        if (want[id]) continue;
        try {
          await request(base, `/api/states/${id}`, { method: 'DELETE' });
        } catch (e) {
          // Already gone (HA restarted, or deleted there): nothing to do.
          if (!e.answered) {
            error = `Couldn't remove ${id}: ${e.message}`;
            break;
          }
        }
        delete published.entities[id];
        changed = true;
      }
    }
    if (changed) store.writeJsonAtomic(FILE, published);
    status = { lastSyncAt: new Date(now).toISOString(), published: Object.keys(want).length, entities: Object.keys(want), error };
    return status;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Something changed (a reading, a rename, the setting): sync shortly. */
function kick() {
  if (!timer) return; // not started (tests, or publishing never wanted)
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => sync().catch(() => {}), KICK_DELAY_MS);
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    const idle = !enabled() && !Object.keys(loadPublished().entities).length;
    if (!idle) sync().catch(() => {});
  }, TICK_MS);
  timer.unref();
  kick();
}

function stop() {
  clearInterval(timer);
  clearTimeout(kickTimer);
  timer = null;
}

function getStatus() {
  return { enabled: enabled(), ...status };
}

module.exports = { start, stop, kick, sync, getStatus, desiredStates, objectId, REFRESH_MS };
