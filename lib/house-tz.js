'use strict';

/**
 * The house's time zone. Every time a device shows (a viewport's clock,
 * calendar, "since", quiet hours; a remote's clock) is formatted in this
 * process's zone. In a container that's UTC unless TZ is set, which puts
 * all of it an hour out in summer in the UK. So, unless TZ is set, the
 * server takes Home Assistant's own time zone (GET /api/config), at
 * startup and every hour after; Node picks up a new process.env.TZ at once.
 */
const haState = require('./ha-state');

const FROM_ENV = Boolean(process.env.TZ);

function valid(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function adoptHaTimeZone(globals) {
  if (FROM_ENV) return null;
  const base = haState.haBase(globals);
  if (!base) return null;
  try {
    const cfg = await haState.haRequest(base, '/api/config');
    const tz = cfg && cfg.time_zone;
    if (tz && valid(tz) && process.env.TZ !== tz) {
      process.env.TZ = tz;
      console.log(`[time] using Home Assistant's time zone, ${tz}`);
    }
    return tz || null;
  } catch (e) {
    return null;
  }
}

function start(getGlobals) {
  const run = () => adoptHaTimeZone(getGlobals()).catch(() => null);
  run();
  setInterval(run, 3600000).unref();
}

module.exports = { adoptHaTimeZone, start, valid };
