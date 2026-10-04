'use strict';

/**
 * The house's (or office's) time zone. Every time a device shows (a
 * viewport's clock, calendar, "since", quiet hours, a meeting room's
 * bookings; a remote's clock) is formatted in this process's zone. In a
 * container that's UTC unless something sets it, which puts all of it an
 * hour out in summer in the UK. So the zone comes from, in order:
 *
 *   env      TZ in the environment (docker-compose), which wins outright
 *   setting  Settings -> Clock -> Time zone (globals.timeZone)
 *   homeAssistant  Home Assistant's own (GET /api/config), re-read hourly
 *   default  none of those: the process's own, UTC in a container
 *
 * Node picks up a new process.env.TZ at once.
 */
const haState = require('./ha-state');

const ENV_TZ = process.env.TZ || '';
let source = ENV_TZ ? 'env' : 'default';

function valid(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function use(tz, from) {
  if (process.env.TZ !== tz) {
    process.env.TZ = tz;
    console.log(`[time] using ${from === 'setting' ? 'the time zone set in Settings' : "Home Assistant's time zone"}, ${tz}`);
  }
  source = from;
}

async function adoptHaTimeZone(globals) {
  if (ENV_TZ) return null;
  const base = haState.haBase(globals);
  if (!base) return null;
  try {
    const cfg = await haState.haRequest(base, '/api/config');
    const tz = cfg && cfg.time_zone;
    if (valid(tz)) use(tz, 'homeAssistant');
    return tz || null;
  } catch (e) {
    return null;
  }
}

/**
 * Apply the zone the settings call for: TZ from the environment, else the
 * one set in Settings, else Home Assistant's. Called at startup, hourly, and
 * whenever the settings are saved.
 */
async function apply(globals) {
  if (ENV_TZ) return current();
  const set = globals && globals.timeZone;
  if (valid(set)) {
    use(set, 'setting');
    return current();
  }
  // The setting was cleared: back to Home Assistant's, or the default.
  if (source === 'setting') {
    if (process.env.TZ !== undefined) delete process.env.TZ;
    source = 'default';
  }
  await adoptHaTimeZone(globals);
  return current();
}

// The zone in use and where it came from.
function current() {
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, source };
}

function start(getGlobals) {
  const run = () => apply(getGlobals()).catch(() => null);
  run();
  setInterval(run, 3600000).unref();
}

module.exports = { adoptHaTimeZone, apply, current, start, valid };
