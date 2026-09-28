'use strict';

/**
 * Live values for a viewport's dashboard (lib/dashboard.js): everything each
 * screen draws, already evaluated — colour indices, alert sentences, times,
 * which rooms are calling for heat — so the device only lays them out.
 *
 *   fetchInputs(layout, globals)   one GET /api/states (every entity, one
 *                                  request whatever the layout references),
 *                                  the weather forecasts and calendar events,
 *                                  all in parallel
 *   buildScreens(layout, inputs)   pure: inputs -> { main, climate, presence,
 *                                  security }
 *   screenEtag(screen)             a stable hash per screen, so a device
 *                                  whose screen hasn't changed gets a 304 and
 *                                  skips the (15-20 s) panel refresh
 *
 * Times are formatted in the server's time zone (TZ), as short, stable text
 * ("08:47", "yesterday", "Tue") rather than "3 min ago", so an unchanged
 * house doesn't produce a changed screen every minute. The exceptions are
 * departures, whose "min" countdown is the point.
 */

const crypto = require('crypto');
const { haBase, haRequest } = require('./ha-state');

const WHITE = 0; // eslint-disable-line no-unused-vars
const BLACK = 1;
const RED = 2;
const YELLOW = 3;
const GREEN = 4;
const BLUE = 5;

const NO_VALUE = new Set(['', 'unknown', 'unavailable', 'none']);

// --- Time formatting ------------------------------------------------------------

function fmtParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday, date: `${Number(p.day)} ${new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short' }).format(date)}` };
}

// Calendar-day difference between two instants, in `timeZone`.
function dayDiff(a, b, timeZone) {
  const d = (x) => Date.parse(`${fmtParts(x, timeZone).day}T00:00:00Z`);
  return Math.round((d(a) - d(b)) / 86400000);
}

function makeClock(now, timeZone) {
  return {
    now,
    time: (date) => fmtParts(date, timeZone).time,
    // "08:47" today, "yesterday", "Mon" this week, "12 Sep" before that.
    when(date) {
      if (!date) return '';
      const diff = dayDiff(date, now, timeZone);
      const p = fmtParts(date, timeZone);
      if (diff === 0) return p.time;
      if (diff === -1) return 'yesterday';
      if (diff > -7 && diff < 0) return p.weekday;
      if (diff === 1) return `tomorrow ${p.time}`;
      return p.date;
    },
    // "Today", "Tomorrow", "Tue", "12 Sep".
    dayLabel(date) {
      const diff = dayDiff(date, now, timeZone);
      const p = fmtParts(date, timeZone);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff > 1 && diff < 7) return p.weekday;
      return p.date;
    },
    weekday: (date) => fmtParts(date, timeZone).weekday
  };
}

// --- Entity access ------------------------------------------------------------------

function makeLookup(states) {
  const get = (id) => (id && states[id]) || null;
  const raw = (id) => {
    const s = get(id);
    return s && s.state != null ? String(s.state) : '';
  };
  const text = (id) => {
    const v = raw(id);
    return NO_VALUE.has(v.toLowerCase()) ? '' : v;
  };
  const number = (id) => {
    const v = text(id);
    const n = v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const attr = (id, key) => {
    const s = get(id);
    return s && s.attributes ? s.attributes[key] : undefined;
  };
  const changed = (id) => {
    const s = get(id);
    const t = s && Date.parse(s.last_changed || '');
    return Number.isFinite(t) ? new Date(t) : null;
  };
  // A timestamp the entity's state holds (a timestamp sensor), else when it
  // last changed.
  const moment = (id) => {
    const v = text(id);
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return new Date(t);
    }
    return changed(id);
  };
  const name = (id, fallback) => fallback || attr(id, 'friendly_name') || id || '';
  const unit = (id) => attr(id, 'unit_of_measurement') || '';
  return { get, raw, text, number, attr, changed, moment, name, unit };
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const titleCase = (s) =>
  String(s || '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

// --- Rules (the panel's own semantics) ------------------------------------------------

// Unknown/unavailable/empty never match; gt/lt compare numbers.
function evalCond(state, cond, value) {
  const s = state == null ? '' : String(state);
  if (NO_VALUE.has(s.toLowerCase())) return false;
  switch (cond) {
    case 'eq':
      return s === value;
    case 'ne':
      return s !== value;
    case 'contains':
      return s.includes(value);
    case 'gt':
    case 'lt': {
      const a = Number(s);
      const b = Number(value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return cond === 'gt' ? a > b : a < b;
    }
    default:
      return false;
  }
}

// First matching rule wins; else the default.
function ruleColor(rules, defaultColor, state) {
  for (const r of rules || []) if (evalCond(state, r.cond, r.value)) return r.color;
  return defaultColor;
}

// "Front door open" / "Front door, Garage open" / "Front door, Garage +2 open",
// cut to 42 characters — the panel's own sentence building.
const MAX_ALERT_CHARS = 42;
const MAX_ALERT_LINES = 6;
function alertLine(names, suffix) {
  let line;
  if (names.length === 1) line = names[0];
  else if (names.length === 2) line = `${names[0]}, ${names[1]}`;
  else line = `${names[0]}, ${names[1]} +${names.length - 2}`;
  if (suffix) line += ` ${suffix}`;
  return line.length > MAX_ALERT_CHARS ? `${line.slice(0, MAX_ALERT_CHARS - 3)}...` : line;
}

function buildAlerts(layout, ha) {
  const lines = [];
  let overflow = 0;
  for (const a of layout.alerts) {
    if (!a.enabled) continue;
    const names = a.entities
      .filter((e) => e.entity && evalCond(ha.raw(e.entity), a.cond, a.value))
      .map((e) => ha.name(e.entity, e.name) || ha.raw(e.entity));
    if (!names.length) continue;
    if (lines.length < MAX_ALERT_LINES) lines.push({ text: alertLine(names, a.suffix), color: a.color });
    else overflow += 1;
  }
  return { lines, overflow, allClear: lines.length === 0 };
}

// --- Screens --------------------------------------------------------------------------

function measure(ha, id) {
  if (!id) return null;
  const v = ha.number(id);
  return v == null ? null : { value: round1(v), unit: ha.unit(id) };
}

function buildWeather(layout, ha, inputs, clock) {
  const w = layout.weather.entity;
  if (!w) return null;
  const a = (k) => ha.attr(w, k);
  const fc = [];
  const hourly = (inputs.forecasts.hourly || {})[w] || [];
  const daily = (inputs.forecasts.daily || {})[w] || [];
  // "Later": about three hours out; then the next two days.
  const later = hourly.find((f) => Date.parse(f.datetime) >= clock.now.getTime() + 3 * 3600000) || hourly[hourly.length - 1];
  if (later) fc.push({ label: 'Later', condition: later.condition || '', high: round1(later.temperature), low: null });
  const upcoming = daily.filter((f) => dayDiff(new Date(f.datetime), clock.now, inputs.timeZone) >= 1);
  for (const f of upcoming.slice(0, 3 - fc.length)) {
    fc.push({ label: clock.weekday(new Date(f.datetime)), condition: f.condition || '', high: round1(f.temperature), low: round1(f.templow) });
  }
  return {
    condition: ha.text(w),
    temperature: round1(a('temperature')),
    feelsLike: round1(a('apparent_temperature')),
    humidity: round1(a('humidity')),
    windSpeed: round1(a('wind_speed')),
    windUnit: a('wind_speed_unit') || '',
    temperatureUnit: a('temperature_unit') || '°C',
    forecast: fc
  };
}

function buildBattery(layout, ha) {
  const b = layout.battery;
  if (!b.soc && !b.status) return null;
  const soc = ha.number(b.soc);
  const status = ha.text(b.status).toLowerCase();
  const t = layout.thresholds;
  const c = b.colors;
  let color = c.idle;
  if (soc != null && soc <= t.batteryCritical) color = c.critical;
  else if (status === 'charging') color = c.charging;
  else if (status === 'full') color = c.full;
  else if (status === 'discharging') color = c.discharging;
  return {
    soc: soc == null ? null : Math.round(soc),
    status,
    eta: ha.text(b.eta),
    color,
    low: soc != null && soc <= t.batteryLow,
    critical: soc != null && soc <= t.batteryCritical
  };
}

function buildCalendar(layout, inputs, clock) {
  const events = [];
  for (const [entity, list] of Object.entries(inputs.calendars || {})) {
    for (const e of list || []) {
      const allDay = Boolean(e.start && e.start.date && !e.start.dateTime);
      const start = allDay ? new Date(`${e.start.date}T00:00:00`) : new Date((e.start && e.start.dateTime) || e.start);
      if (!Number.isFinite(start.getTime())) continue;
      events.push({ entity, allDay, start, title: e.summary || '' });
    }
  }
  events.sort((x, y) => x.start - y.start || x.title.localeCompare(y.title));
  return events.slice(0, layout.calendar.lines).map((e) => {
    const day = clock.dayLabel(e.start);
    const time = e.allDay ? '' : clock.time(e.start);
    return { day, time, title: e.title, allDay: e.allDay, text: `${day}${time ? ` ${time}` : ''} · ${e.title}` };
  });
}

function buildMain(layout, ha, inputs, clock) {
  const en = layout.energy;
  const solar = measure(ha, en.solarToday);
  const expected = measure(ha, en.solarExpected);
  return {
    weather: buildWeather(layout, ha, inputs, clock),
    energy: {
      solarToday: solar,
      solarExpected: expected,
      loadToday: measure(ha, en.loadToday),
      gridExport: measure(ha, en.gridExport),
      gridImport: measure(ha, en.gridImport),
      solarPct: solar && expected && expected.value > 0 ? Math.round((solar.value / expected.value) * 100) : null
    },
    battery: buildBattery(layout, ha),
    statusIcons: layout.statusIcons.map((s) => ({
      name: s.name,
      icon: s.icon,
      state: ha.text(s.entity),
      color: ruleColor(s.rules, s.defaultColor, ha.raw(s.entity))
    })),
    alerts: buildAlerts(layout, ha),
    calendar: buildCalendar(layout, inputs, clock)
  };
}

// Each room against its target: calling for heat (red), at target (green),
// over target / cooling (blue), or no target to judge by (black).
function buildRoom(room, layout, ha) {
  const temperature = round1(room.temperature ? ha.number(room.temperature) : room.climate ? ha.attr(room.climate, 'current_temperature') : null);
  const humidity = round1(room.humidity ? ha.number(room.humidity) : room.climate ? ha.attr(room.climate, 'current_humidity') : null);
  const climateTarget = room.climate ? Number(ha.attr(room.climate, 'temperature')) : NaN;
  const target = Number.isFinite(climateTarget) ? climateTarget : room.target;
  const action = room.climate ? String(ha.attr(room.climate, 'hvac_action') || '') : '';
  const tol = layout.thresholds.climateTolerance;
  let state = 'idle';
  if (action === 'heating') state = 'heat';
  else if (action === 'cooling') state = 'cool';
  else if (temperature != null && target != null) {
    const d = temperature - target;
    state = d < -tol ? 'heat' : d > tol ? 'cool' : 'ok';
  }
  const color = { heat: RED, cool: BLUE, ok: GREEN, idle: BLACK }[state];
  return {
    name: room.name || ha.name(room.temperature || room.climate),
    icon: room.icon,
    floor: room.floor,
    temperature,
    humidity,
    target: target == null ? null : round1(target),
    delta: temperature != null && target != null ? round1(temperature - target) : null,
    state,
    color
  };
}

function buildClimate(layout, ha) {
  const hp = layout.heatPump;
  const rooms = layout.rooms.map((r) => buildRoom(r, layout, ha));
  const pump = hp.entity
    ? {
        name: ha.name(hp.entity),
        mode: titleCase(ha.text(hp.entity)),
        action: titleCase(String(ha.attr(hp.entity, 'hvac_action') || '')),
        current: round1(ha.attr(hp.entity, 'current_temperature')),
        setpoint: round1(ha.attr(hp.entity, 'temperature')),
        outside: hp.outsideTemperature ? round1(ha.number(hp.outsideTemperature)) : null,
        cop: hp.cop ? round1(ha.number(hp.cop)) : null
      }
    : null;
  return {
    heatPump: pump,
    rooms,
    calling: rooms.filter((r) => r.state === 'heat').length,
    total: rooms.length
  };
}

// A departure sensor's state: a timestamp, a number of minutes, or "HH:MM".
function departure(state, clock, urgentMin, rowColor) {
  if (!state) return null;
  let at = null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(state) && Number.isFinite(Date.parse(state))) at = new Date(Date.parse(state));
  else if (/^\d+(\.\d+)?$/.test(state)) at = new Date(clock.now.getTime() + Number(state) * 60000);
  else if (/^\d{1,2}:\d{2}$/.test(state)) {
    // Today's HH:MM in the clock's zone: step from now by the difference.
    const [h, m] = state.split(':').map(Number);
    const [nh, nm] = clock.time(clock.now).split(':').map(Number);
    let mins = h * 60 + m - (nh * 60 + nm);
    if (mins < -60) mins += 1440;
    at = new Date(clock.now.getTime() + mins * 60000);
  }
  if (!at) return { time: '', minutes: null, urgent: false, color: rowColor, text: state };
  const minutes = Math.max(0, Math.round((at - clock.now) / 60000));
  const urgent = minutes <= urgentMin;
  return { time: clock.time(at), minutes, urgent, color: urgent ? RED : rowColor, text: `${minutes} min` };
}

function buildPresence(layout, ha, clock) {
  const t = layout.thresholds;
  return {
    rooms: layout.rooms.map((r) => {
      const x = buildRoom(r, layout, ha);
      return { name: x.name, icon: x.icon, floor: x.floor, temperature: x.temperature, humidity: x.humidity };
    }),
    people: layout.people.map((p) => {
      const state = ha.text(p.entity);
      const home = state === 'home';
      return { name: ha.name(p.entity, p.name), home, state: home ? 'Home' : state === 'not_home' ? 'Away' : titleCase(state), color: home ? GREEN : BLACK };
    }),
    media: layout.media
      .map((m) => {
        const state = ha.text(m.entity);
        if (state !== 'playing' && state !== 'paused') return null;
        return {
          room: m.name || ha.name(m.entity),
          icon: m.icon,
          app: String(ha.attr(m.entity, 'app_name') || ha.attr(m.entity, 'source') || ''),
          title: String(ha.attr(m.entity, 'media_title') || ''),
          artist: String(ha.attr(m.entity, 'media_artist') || ha.attr(m.entity, 'media_series_title') || ''),
          playing: state === 'playing'
        };
      })
      .filter(Boolean),
    transport: layout.transport.map((r) => ({
      name: r.name,
      stop: r.stop,
      icon: r.icon,
      color: r.color,
      departures: [r.departure1, r.departure2]
        .map((e) => departure(ha.text(e), clock, t.transportUrgentMin, r.color))
        .filter(Boolean)
    }))
  };
}

const ALARM_COLORS = { triggered: RED, arming: YELLOW, pending: YELLOW, disarmed: GREEN };

function buildSecurity(layout, ha, clock) {
  const s = layout.security;
  const t = layout.thresholds;
  const openClose = (list) =>
    list.map((d) => {
      const open = ha.text(d.entity) === 'on' || ha.text(d.entity) === 'open';
      return { name: ha.name(d.entity, d.name), open, state: open ? 'Open' : 'Closed', when: clock.when(ha.changed(d.entity)), color: open ? RED : GREEN };
    });
  const alarmState = ha.text(s.alarm);
  const doors = openClose(s.doors);
  const windows = openClose(s.windows);
  const recentMs = t.motionRecentMin * 60000;
  const motion = s.motion.map((m) => {
    const at = ha.changed(m.entity);
    const recent = ha.text(m.entity) === 'on' || (at != null && clock.now - at <= recentMs);
    return { name: ha.name(m.entity, m.name), when: clock.when(at), recent, color: recent ? BLUE : BLACK };
  });
  const last = (id) => (id ? clock.when(ha.moment(id)) : '');
  return {
    alarm: s.alarm
      ? {
          state: alarmState,
          label: titleCase(alarmState) || 'Unknown',
          since: clock.when(ha.changed(s.alarm)),
          color: alarmState.startsWith('armed_') ? RED : ALARM_COLORS[alarmState] || BLACK
        }
      : null,
    last: { armed: last(s.lastArmed), disarmed: last(s.lastDisarmed), triggered: last(s.lastTriggered) },
    summary: {
      doors: doors.length,
      doorsOpen: doors.filter((d) => d.open).length,
      windows: windows.length,
      windowsOpen: windows.filter((w) => w.open).length,
      motion: motion.length,
      cameras: s.cameras.length
    },
    doors,
    windows,
    motion,
    cameras: s.cameras.map((c) => ({ name: ha.name(c.entity, c.name), when: clock.when(ha.moment(c.entity)) }))
  };
}

/**
 * inputs: { states: {entity_id: {state, attributes, last_changed}},
 *           forecasts: {daily: {weatherEntity: [..]}, hourly: {...}},
 *           calendars: {entity: [events]}, now: Date, timeZone }
 */
function buildScreens(layout, inputs) {
  const now = inputs.now || new Date();
  const timeZone = inputs.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const full = { forecasts: {}, calendars: {}, ...inputs, now, timeZone };
  const ha = makeLookup(inputs.states || {});
  const clock = makeClock(now, timeZone);
  return {
    main: buildMain(layout, ha, full, clock),
    climate: buildClimate(layout, ha),
    presence: buildPresence(layout, ha, clock),
    security: buildSecurity(layout, ha, clock)
  };
}

function screenEtag(screen) {
  return `"${crypto.createHash('sha1').update(JSON.stringify(screen)).digest('hex').slice(0, 20)}"`;
}

// --- Fetching from Home Assistant ------------------------------------------------------

async function fetchForecast(base, entity, type) {
  const r = await haRequest(base, '/api/services/weather/get_forecasts?return_response', {
    method: 'POST',
    body: JSON.stringify({ entity_id: entity, type })
  });
  const resp = r && r.service_response && r.service_response[entity];
  return (resp && resp.forecast) || [];
}

async function fetchCalendar(base, entity, now, days) {
  const end = new Date(now.getTime() + days * 86400000);
  const qs = `start=${encodeURIComponent(now.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  return haRequest(base, `/api/calendars/${encodeURIComponent(entity)}?${qs}`);
}

/**
 * Everything buildScreens() needs, from HA in parallel. Throws (code NO_HA)
 * if HA isn't configured, or if the state list itself can't be fetched;
 * a failed forecast or calendar only leaves that part empty (in `errors`).
 */
async function fetchInputs(layout, globals, now = new Date()) {
  const base = haBase(globals);
  if (!base) {
    const err = new Error('Home Assistant host/token not configured');
    err.code = 'NO_HA';
    throw err;
  }
  const errors = {};
  const forecasts = { daily: {}, hourly: {} };
  const calendars = {};
  const w = layout.weather.entity;
  const soft = (key, p, put) => p.then(put).catch((e) => {
    errors[key] = e.message;
  });
  const [all] = await Promise.all([
    haRequest(base, '/api/states'),
    w && soft(`forecast:daily:${w}`, fetchForecast(base, w, 'daily'), (f) => (forecasts.daily[w] = f)),
    w && soft(`forecast:hourly:${w}`, fetchForecast(base, w, 'hourly'), (f) => (forecasts.hourly[w] = f)),
    ...layout.calendar.entities.map((c) =>
      soft(`calendar:${c}`, fetchCalendar(base, c, now, layout.calendar.days), (ev) => (calendars[c] = Array.isArray(ev) ? ev : []))
    )
  ]);
  const states = {};
  for (const s of Array.isArray(all) ? all : []) states[s.entity_id] = s;
  return { states, forecasts, calendars, errors, now };
}

module.exports = {
  evalCond,
  ruleColor,
  alertLine,
  buildScreens,
  screenEtag,
  fetchInputs,
  makeClock
};
