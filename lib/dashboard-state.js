'use strict';

/**
 * Live values for a viewport's dashboard (lib/dashboard.js): everything each
 * screen draws, already evaluated — colour indices, which icon to show,
 * alert sentences, times, rooms calling for heat, a meeting room's status,
 * the energy graph's buckets — so the device only lays them out.
 *
 *   fetchInputs(layout, globals)   one GET /api/states (every entity in one
 *                                  request), plus only what the layout needs
 *                                  of: weather forecasts, calendar events,
 *                                  and history for energy graphs — in parallel
 *   buildScreens(layout, inputs)   pure: inputs -> { [screenId]: screen }
 *   screenEtag(screen)             a stable hash per screen, so a device
 *                                  whose screen hasn't changed gets a 304 and
 *                                  skips the (15-20 s) panel refresh
 *
 * Times are formatted in the server's time zone (TZ) as short, stable text
 * ("08:47", "yesterday", "Tue") rather than "3 min ago", so an unchanged
 * house doesn't make a changed screen every minute. Countdowns (departures,
 * "ends in 25 min") are the exception: they're the point.
 */

const crypto = require('crypto');
const { haBase, haRequest } = require('./ha-state');
const { screenSections } = require('./dashboard');

const BLACK = 1;
const RED = 2;
const YELLOW = 3;
const GREEN = 4;
const BLUE = 5;

const NO_VALUE = new Set(['', 'unknown', 'unavailable', 'none']);

// --- Time -------------------------------------------------------------------------

function fmtParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday,
    date: `${Number(p.day)} ${new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short' }).format(date)}`
  };
}

// Calendar-day difference between two instants, in `timeZone`.
function dayDiff(a, b, timeZone) {
  const d = (x) => Date.parse(`${fmtParts(x, timeZone).day}T00:00:00Z`);
  return Math.round((d(a) - d(b)) / 86400000);
}

// Midnight (local to `timeZone`) at the start of `date`'s day.
function startOfDay(date, timeZone) {
  const p = fmtParts(date, timeZone);
  const guess = new Date(date.getTime() - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - date.getMilliseconds());
  // A DST change during the day moves midnight by an hour: correct once.
  const q = fmtParts(guess, timeZone);
  return q.hour === 0 ? guess : new Date(guess.getTime() - (q.hour > 12 ? q.hour - 24 : q.hour) * 3600000);
}

function makeClock(now, timeZone) {
  return {
    now,
    timeZone,
    time: (date) => fmtParts(date, timeZone).time,
    hour: (date) => fmtParts(date, timeZone).hour,
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
    sameDay: (a, b) => dayDiff(a, b, timeZone) === 0,
    weekday: (date) => fmtParts(date, timeZone).weekday,
    startOfDay: (date) => startOfDay(date, timeZone)
  };
}

// --- Entity access ------------------------------------------------------------------

function makeLookup(states) {
  const get = (eid) => (eid && states[eid]) || null;
  const raw = (eid) => {
    const s = get(eid);
    return s && s.state != null ? String(s.state) : '';
  };
  const text = (eid) => {
    const v = raw(eid);
    return NO_VALUE.has(v.toLowerCase()) ? '' : v;
  };
  const number = (eid) => {
    const v = text(eid);
    const n = v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const attr = (eid, key) => {
    const s = get(eid);
    return s && s.attributes ? s.attributes[key] : undefined;
  };
  const changed = (eid) => {
    const s = get(eid);
    const t = s && Date.parse(s.last_changed || '');
    return Number.isFinite(t) ? new Date(t) : null;
  };
  // A timestamp the entity's state holds (a timestamp sensor), else when it
  // last changed.
  const moment = (eid) => {
    const v = text(eid);
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return new Date(t);
    }
    return changed(eid);
  };
  const name = (eid, fallback) => fallback || attr(eid, 'friendly_name') || eid || '';
  const unit = (eid) => attr(eid, 'unit_of_measurement') || '';
  return { get, raw, text, number, attr, changed, moment, name, unit };
}

const round1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const titleCase = (s) =>
  String(s || '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

// --- Rules (the panel's own semantics) --------------------------------------------

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

// A status icon's look for a state: the first matching rule's colour/icon/
// visibility, else the icon's own defaults.
function statusIconLook(icon, state) {
  for (const r of icon.rules || []) {
    if (evalCond(state, r.cond, r.value)) {
      return { color: r.color, icon: r.icon || icon.icon, hidden: Boolean(r.hide) };
    }
  }
  return { color: icon.color, icon: icon.icon, hidden: !icon.showByDefault };
}

// "Front door open" / "Front door, Garage open" / "Front door, Garage +2 open",
// cut to 42 characters — the panel's own sentence building.
const MAX_ALERT_CHARS = 42;
function alertLine(names, suffix) {
  let line;
  if (names.length === 1) line = names[0];
  else if (names.length === 2) line = `${names[0]}, ${names[1]}`;
  else line = `${names[0]}, ${names[1]} +${names.length - 2}`;
  if (suffix) line += ` ${suffix}`;
  return line.length > MAX_ALERT_CHARS ? `${line.slice(0, MAX_ALERT_CHARS - 3)}...` : line;
}

// --- Sections --------------------------------------------------------------------------

function measure(ha, eid) {
  if (!eid) return null;
  const v = ha.number(eid);
  return v == null ? null : { value: round1(v), unit: ha.unit(eid) };
}

function weather(s, ctx) {
  const { ha, clock, inputs } = ctx;
  const w = s.entity;
  if (!w) return null;
  const a = (k) => ha.attr(w, k);
  const fc = [];
  const hourly = (inputs.forecasts.hourly || {})[w] || [];
  const daily = (inputs.forecasts.daily || {})[w] || [];
  if (s.later) {
    // About three hours out.
    const later = hourly.find((f) => Date.parse(f.datetime) >= clock.now.getTime() + 3 * 3600000) || hourly[hourly.length - 1];
    if (later) fc.push({ label: 'Later', condition: later.condition || '', high: round1(later.temperature), low: null });
  }
  const upcoming = daily.filter((f) => dayDiff(new Date(f.datetime), clock.now, clock.timeZone) >= 1);
  for (const f of upcoming.slice(0, s.days)) {
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

function energy(s, { ha }) {
  const solar = measure(ha, s.solarToday);
  const expected = measure(ha, s.solarExpected);
  return {
    solarToday: solar,
    solarExpected: expected,
    loadToday: measure(ha, s.loadToday),
    gridExport: measure(ha, s.gridExport),
    gridImport: measure(ha, s.gridImport),
    solarPct: solar && expected && expected.value > 0 ? Math.round((solar.value / expected.value) * 100) : null
  };
}

function battery(s, { ha, layout }) {
  if (!s.soc && !s.status) return null;
  const soc = ha.number(s.soc);
  const status = ha.text(s.status).toLowerCase();
  const t = layout.thresholds;
  const c = s.colors;
  let col = c.idle;
  if (soc != null && soc <= t.batteryCritical) col = c.critical;
  else if (status === 'charging') col = c.charging;
  else if (status === 'full') col = c.full;
  else if (status === 'discharging') col = c.discharging;
  return {
    soc: soc == null ? null : Math.round(soc),
    status,
    eta: ha.text(s.eta),
    color: col,
    low: soc != null && soc <= t.batteryLow,
    critical: soc != null && soc <= t.batteryCritical
  };
}

function statusIcons(s, { ha }) {
  return {
    icons: s.icons
      .map((ic) => {
        const state = ic.attribute ? ha.attr(ic.entity, ic.attribute) : ha.raw(ic.entity);
        const look = statusIconLook(ic, state == null ? '' : String(state));
        return look.hidden ? null : { name: ic.name, icon: look.icon, color: look.color, state: state == null ? '' : String(state) };
      })
      .filter(Boolean)
  };
}

function alerts(s, { ha }) {
  const lines = [];
  let overflow = 0;
  for (const a of s.slots) {
    if (!a.enabled) continue;
    const names = a.entities
      .filter((e) => e.entity && evalCond(ha.raw(e.entity), a.cond, a.value))
      .map((e) => ha.name(e.entity, e.name) || ha.raw(e.entity));
    if (!names.length) continue;
    if (lines.length < s.maxLines) lines.push({ text: alertLine(names, a.suffix), color: a.color });
    else overflow += 1;
  }
  return { lines, overflow, allClear: lines.length === 0, allClearText: s.allClear };
}

// Calendar events as {start, end, allDay, title}, sorted.
function eventsOf(inputs, entities) {
  const out = [];
  for (const entity of entities) {
    for (const e of (inputs.calendars || {})[entity] || []) {
      const allDay = Boolean(e.start && e.start.date && !e.start.dateTime);
      const start = allDay ? new Date(`${e.start.date}T00:00:00`) : new Date((e.start && e.start.dateTime) || e.start);
      const endRaw = e.end && (e.end.dateTime || e.end.date);
      const end = endRaw ? new Date(e.end.date && !e.end.dateTime ? `${e.end.date}T00:00:00` : endRaw) : null;
      if (!Number.isFinite(start.getTime())) continue;
      out.push({ entity, allDay, start, end: end && Number.isFinite(end.getTime()) ? end : null, title: e.summary || '' });
    }
  }
  return out.sort((x, y) => x.start - y.start || x.title.localeCompare(y.title));
}

function calendar(s, { inputs, clock }) {
  return {
    lines: eventsOf(inputs, s.entities)
      .filter((e) => !e.end || e.end > clock.now)
      .slice(0, s.lines)
      .map((e) => {
        const day = clock.dayLabel(e.start < clock.now ? clock.now : e.start);
        const time = e.allDay ? '' : clock.time(e.start);
        return { day, time, title: e.title, allDay: e.allDay, text: `${day}${time ? ` ${time}` : ''} · ${e.title}` };
      })
  };
}

function heatPump(s, { ha }) {
  if (!s.entity) return null;
  return {
    name: ha.name(s.entity),
    mode: titleCase(ha.text(s.entity)),
    action: titleCase(String(ha.attr(s.entity, 'hvac_action') || '')),
    current: round1(ha.attr(s.entity, 'current_temperature')),
    setpoint: round1(ha.attr(s.entity, 'temperature')),
    outside: s.outsideTemperature ? round1(ha.number(s.outsideTemperature) ?? ha.attr(s.outsideTemperature, 'temperature')) : null,
    cop: s.cop ? round1(ha.number(s.cop)) : null
  };
}

// Each room against its target: calling for heat (red), at target (green),
// over target / cooling (blue), or no target to judge by (black).
function roomValues(room, { ha, layout }) {
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
  return {
    name: room.name || ha.name(room.temperature || room.climate),
    icon: room.icon,
    floor: room.floor,
    temperature,
    humidity,
    target: target == null ? null : round1(target),
    delta: temperature != null && target != null ? round1(temperature - target) : null,
    state,
    color: { heat: RED, cool: BLUE, ok: GREEN, idle: BLACK }[state]
  };
}

function roomClimate(s, ctx) {
  const rooms = s.rooms.map((r) => roomValues(r, ctx));
  return { rooms, calling: rooms.filter((r) => r.state === 'heat').length, total: rooms.length };
}

function roomList(s, ctx) {
  return {
    byFloor: s.byFloor,
    rooms: s.rooms.map((r) => {
      const x = roomValues(r, ctx);
      return { name: x.name, icon: x.icon, floor: x.floor, temperature: x.temperature, humidity: x.humidity };
    })
  };
}

function people(s, { ha }) {
  return {
    people: s.people.map((p) => {
      const state = ha.text(p.entity);
      const home = state === 'home';
      return { name: ha.name(p.entity, p.name), home, state: home ? 'Home' : state === 'not_home' ? 'Away' : titleCase(state), color: home ? GREEN : BLACK };
    })
  };
}

function media(s, { ha }) {
  return {
    players: s.players
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
      .filter(Boolean)
  };
}

// A departure sensor's state: a timestamp, a number of minutes, or "HH:MM".
function departure(state, clock, urgentMin, rowColor) {
  if (!state) return null;
  let at = null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(state) && Number.isFinite(Date.parse(state))) at = new Date(Date.parse(state));
  else if (/^\d+(\.\d+)?$/.test(state)) at = new Date(clock.now.getTime() + Number(state) * 60000);
  else if (/^\d{1,2}:\d{2}$/.test(state)) {
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

function transport(s, { ha, clock, layout }) {
  return {
    routes: s.routes.map((r) => ({
      name: r.name,
      stop: r.stop,
      icon: r.icon,
      color: r.color,
      departures: [r.departure1, r.departure2]
        .map((e) => departure(ha.text(e), clock, layout.thresholds.transportUrgentMin, r.color))
        .filter(Boolean)
    }))
  };
}

const ALARM_COLORS = { triggered: RED, arming: YELLOW, pending: YELLOW, disarmed: GREEN };

function alarm(s, { ha, clock }) {
  if (!s.entity) return null;
  const state = ha.text(s.entity);
  const last = (eid) => (eid ? clock.when(ha.moment(eid)) : '');
  return {
    state,
    label: titleCase(state) || 'Unknown',
    since: clock.when(ha.changed(s.entity)),
    color: state.startsWith('armed_') ? RED : ALARM_COLORS[state] || BLACK,
    last: { armed: last(s.lastArmed), disarmed: last(s.lastDisarmed), triggered: last(s.lastTriggered) }
  };
}

function openings(s, { ha, clock }) {
  const items = s.items.map((d) => {
    const st = ha.text(d.entity);
    const open = ['on', 'open', 'opening', 'unlocked'].includes(st);
    return { name: ha.name(d.entity, d.name), open, state: open ? 'Open' : st ? 'Closed' : '—', when: clock.when(ha.changed(d.entity)), color: open ? s.openColor : s.closedColor };
  });
  return { items, open: items.filter((i) => i.open).length, total: items.length };
}

function motion(s, { ha, clock, layout }) {
  const recentMs = layout.thresholds.motionRecentMin * 60000;
  return {
    sensors: s.sensors.map((m) => {
      const at = ha.changed(m.entity);
      const recent = ha.text(m.entity) === 'on' || (at != null && clock.now - at <= recentMs);
      return { name: ha.name(m.entity, m.name), when: clock.when(at), recent, color: recent ? BLUE : BLACK };
    })
  };
}

function cameras(s, { ha, clock }) {
  return { cameras: s.cameras.map((c) => ({ name: ha.name(c.entity, c.name), when: clock.when(ha.moment(c.entity)) })) };
}

// --- Energy graph ------------------------------------------------------------------------

const POWER_SCALE = { W: 0.001, kW: 1, MW: 1000 };
const ENERGY_SCALE = { Wh: 0.001, kWh: 1, MWh: 1000 };

function graphWindow(s, clock) {
  const bucketMs = s.bucketMin * 60000;
  let start;
  let end;
  if (s.range === '24h') {
    end = new Date(Math.ceil(clock.now.getTime() / bucketMs) * bucketMs);
    start = new Date(end.getTime() - 24 * 3600000);
  } else {
    start = clock.startOfDay(clock.now);
    end = clock.startOfDay(new Date(start.getTime() + 36 * 3600000));
  }
  return { start, end, bucketMs, count: Math.round((end - start) / bucketMs) };
}

// Time-weighted average of a step series (each point holds until the next)
// over [a, b). `points` sorted by t; null if nothing is known in the window.
function stepAverage(points, a, b) {
  if (b <= a) return null;
  let idx = -1;
  for (let i = 0; i < points.length && points[i].t < b; i++) idx = i;
  if (idx < 0) return null;
  let first = 0;
  while (first < points.length && points[first].t <= a) first++;
  let t = a;
  let v = first > 0 ? points[first - 1].v : null;
  let sum = 0;
  let covered = 0;
  for (let i = first; i <= idx; i++) {
    if (v != null) {
      sum += v * (points[i].t - t);
      covered += points[i].t - t;
    }
    t = points[i].t;
    v = points[i].v;
  }
  if (v != null) {
    sum += v * (b - t);
    covered += b - t;
  }
  return covered > 0 ? sum / covered : null;
}

// A meter's reading at `t` (the last point at or before it).
function readingAt(points, t) {
  let v = null;
  for (const p of points) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

function historyPoints(history, entity, scale) {
  return ((history || {})[entity] || [])
    .map((p) => ({ t: Date.parse(p.last_changed || p.last_updated), v: Number(p.state) * scale }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((x, y) => x.t - y.t);
}

// One series' bucket values, in kW (average power over the bucket's
// elapsed part). Future buckets are null.
function seriesBuckets(series, win, ctx) {
  const { ha, clock, inputs } = ctx;
  if (!series.entity) return null;
  const unit = ha.unit(series.entity);
  const now = clock.now.getTime();
  const out = [];
  if (series.kind === 'energy') {
    const pts = historyPoints(inputs.history, series.entity, ENERGY_SCALE[unit] ?? 1);
    for (let i = 0; i < win.count; i++) {
      const a = win.start.getTime() + i * win.bucketMs;
      const b = Math.min(a + win.bucketMs, now);
      if (a >= now) {
        out.push(null);
        continue;
      }
      const v0 = readingAt(pts, a);
      const v1 = readingAt(pts, b);
      if (v1 == null) {
        out.push(null);
        continue;
      }
      let kwh = v0 == null ? 0 : v1 - v0;
      if (kwh < 0) kwh = v1; // the meter reset (midnight) within this bucket
      out.push(round2(kwh / ((b - a) / 3600000)));
    }
  } else {
    const pts = historyPoints(inputs.history, series.entity, POWER_SCALE[unit] ?? 1);
    for (let i = 0; i < win.count; i++) {
      const a = win.start.getTime() + i * win.bucketMs;
      out.push(a >= now ? null : round2(stepAverage(pts, a, Math.min(a + win.bucketMs, now))));
    }
  }
  return out;
}

// A solar forecast held in an entity's attribute: a list of
// {period_start|datetime|time|start: ..., pv_estimate|value|watts|power: ...}
// or a map {time: value}. Returned as kW points.
const TIME_KEYS = ['period_start', 'datetime', 'time', 'start', 'period_end'];
const VALUE_KEYS = ['pv_estimate', 'value', 'watts', 'power', 'pv_power', 'estimate', 'energy'];
function forecastPoints(f, ha) {
  if (!f.entity) return [];
  const raw = f.attribute ? ha.attr(f.entity, f.attribute) : undefined;
  let pts = [];
  if (Array.isArray(raw)) {
    pts = raw.map((r) => {
      const tk = TIME_KEYS.find((k) => r && r[k] != null);
      const vk = VALUE_KEYS.find((k) => r && r[k] != null);
      return { t: tk ? Date.parse(r[tk]) : NaN, v: vk ? Number(r[vk]) : NaN };
    });
  } else if (raw && typeof raw === 'object') {
    pts = Object.entries(raw).map(([k, v]) => ({ t: Date.parse(k), v: Number(v) }));
  }
  pts = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  const inWatts = f.unit === 'W' || (f.unit === 'auto' && pts.some((p) => p.v > 100));
  return inWatts ? pts.map((p) => ({ t: p.t, v: p.v / 1000 })) : pts;
}

function energyGraph(s, ctx) {
  const { clock, ha } = ctx;
  const win = graphWindow(s, clock);
  const series = {};
  for (const k of ['solar', 'load', 'gridImport', 'gridExport']) series[k] = seriesBuckets(s[k], win, ctx);
  const fpts = forecastPoints(s.forecast, ha);
  if (fpts.length) {
    const last = fpts[fpts.length - 1].t + 3600000;
    series.forecast = Array.from({ length: win.count }, (_, i) => {
      const a = win.start.getTime() + i * win.bucketMs;
      return a >= last || a + win.bucketMs <= fpts[0].t ? null : round2(stepAverage(fpts, a, a + win.bucketMs));
    });
  } else {
    series.forecast = null;
  }
  const hours = win.bucketMs / 3600000;
  const now = clock.now.getTime();
  const totals = {};
  let max = 0;
  for (const [k, vals] of Object.entries(series)) {
    if (!vals) {
      totals[k] = null;
      continue;
    }
    let kwh = 0;
    vals.forEach((v, i) => {
      if (v == null) return;
      const a = win.start.getTime() + i * win.bucketMs;
      const len = k === 'forecast' ? hours : Math.min(win.bucketMs, now - a) / 3600000;
      kwh += v * len;
      max = Math.max(max, v);
    });
    totals[k] = round1(kwh);
  }
  const labels = Array.from({ length: win.count }, (_, i) => {
    const d = new Date(win.start.getTime() + i * win.bucketMs);
    return String(clock.hour(d)).padStart(2, '0');
  });
  const nowIndex = Math.floor((now - win.start.getTime()) / win.bucketMs);
  return {
    range: s.range,
    bucketMin: s.bucketMin,
    start: win.start.toISOString(),
    labels,
    nowIndex: nowIndex >= 0 && nowIndex < win.count ? nowIndex : null,
    series,
    totals,
    max: round2(max),
    colors: s.colors
  };
}

const BUILDERS = {
  weather,
  energy,
  energyGraph,
  battery,
  statusIcons,
  alerts,
  calendar,
  heatPump,
  roomClimate,
  roomList,
  people,
  media,
  transport,
  alarm,
  openings,
  motion,
  cameras
};

// --- Meeting room ----------------------------------------------------------------------------

const MEETING_LOOK = {
  free: { label: 'Available', color: GREEN },
  soon: { label: 'Starting soon', color: YELLOW },
  busy: { label: 'In use', color: RED },
  bookedEmpty: { label: 'Booked — no one here', color: YELLOW },
  occupied: { label: 'In use — not booked', color: YELLOW }
};

function meetingRoom(m, { ha, clock, inputs }) {
  const now = clock.now;
  const events = eventsOf(inputs, m.calendar ? [m.calendar] : []).filter((e) => !e.allDay && e.end && e.end > now);
  const title = (e) => (m.hideTitles ? 'Booked' : e.title || 'Booked');
  const range = (e) => `${clock.time(e.start)}–${clock.time(e.end)}`;
  const current = events.find((e) => e.start <= now);
  const next = events.find((e) => e.start > now);
  const occupied = m.occupancy ? ['on', 'home', 'detected', 'occupied'].includes(ha.text(m.occupancy)) : null;
  const quietFor = m.occupancy && occupied === false && ha.changed(m.occupancy) ? (now - ha.changed(m.occupancy)) / 60000 : 0;

  let status = 'free';
  if (current) {
    const runningFor = (now - current.start) / 60000;
    status = occupied === false && quietFor >= m.emptyMin && runningFor >= m.emptyMin ? 'bookedEmpty' : 'busy';
  } else if (next && (next.start - now) / 60000 <= m.soonMin) status = 'soon';
  else if (occupied) status = 'occupied';

  // Back-to-back meetings read as one busy block.
  let until = '';
  if (current) {
    let end = current.end;
    for (const e of events) if (e.start <= end && e.end > end) end = e.end;
    until = `Busy until ${clock.time(end)}`;
  } else if (next && clock.sameDay(next.start, now)) until = `Free until ${clock.time(next.start)}`;
  else until = 'Free for the rest of the day';

  // When this screen next changes on its own: a meeting starting/ending,
  // entering the "starting soon" window, or becoming "booked but empty".
  const edges = [];
  if (current) edges.push(current.end - now);
  if (next) edges.push(next.start - now);
  // "Starting soon" only shows between meetings; during one, "in use" wins.
  if (next && !current) edges.push(next.start - m.soonMin * 60000 - now);
  if (current && occupied === false && ha.changed(m.occupancy)) {
    const emptyAt = Math.max(current.start.getTime(), ha.changed(m.occupancy).getTime()) + m.emptyMin * 60000;
    edges.push(emptyAt - now);
  }
  const future = edges.filter((ms) => ms > 0);
  const look = MEETING_LOOK[status];
  return {
    data: {
      name: m.name || (m.calendar ? ha.name(m.calendar) : 'Meeting room'),
      status,
      label: look.label,
      color: look.color,
      until,
      current: current ? { title: title(current), time: range(current), endsInMin: Math.max(0, Math.round((current.end - now) / 60000)) } : null,
      next: next ? { title: title(next), time: range(next), day: clock.dayLabel(next.start) } : null,
      upcoming: events
        .filter((e) => e !== current && clock.sameDay(e.start, now))
        .slice(0, m.upcoming)
        .map((e) => ({ title: title(e), time: range(e) }))
    },
    nextChangeInSec: future.length ? Math.ceil(Math.min(...future) / 1000) : null
  };
}

// --- Screens -------------------------------------------------------------------------------------

/**
 * inputs: { states: {entity_id: {state, attributes, last_changed}},
 *           forecasts: {daily: {weatherEntity: [..]}, hourly: {...}},
 *           calendars: {entity: [events]}, history: {entity: [points]},
 *           now: Date, timeZone }
 * Returns {screenId: {kind, title, template, columns | data, nextChangeInSec}}.
 */
function buildScreens(layout, inputs) {
  const now = inputs.now || new Date();
  const timeZone = inputs.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const full = { forecasts: {}, calendars: {}, history: {}, ...inputs, now, timeZone };
  const ctx = { ha: makeLookup(inputs.states || {}), clock: makeClock(now, timeZone), inputs: full, layout };
  const out = {};
  for (const screen of layout.screens) {
    if (screen.kind === 'meetingRoom') {
      const { data, nextChangeInSec } = meetingRoom(screen.meeting, ctx);
      out[screen.id] = { kind: screen.kind, title: screen.title, data, nextChangeInSec };
    } else {
      out[screen.id] = {
        kind: screen.kind,
        title: screen.title,
        template: screen.template,
        columns: screen.columns.map((col) =>
          col.map((s) => ({ id: s.id, type: s.type, title: s.title, data: BUILDERS[s.type](s, ctx) }))
        ),
        nextChangeInSec: null
      };
    }
  }
  return out;
}

function screenEtag(screen) {
  return `"${crypto.createHash('sha1').update(JSON.stringify(screen)).digest('hex').slice(0, 20)}"`;
}

// Every icon name a layout can show (status icons and their rule icons), so
// a device can fetch them all ahead of time.
function iconsUsed(layout) {
  const names = new Set();
  for (const screen of layout.screens) {
    for (const s of screenSections(screen)) {
      if (s.type === 'statusIcons') {
        for (const ic of s.icons) {
          if (ic.icon) names.add(ic.icon);
          for (const r of ic.rules) if (r.icon) names.add(r.icon);
        }
      }
      for (const key of ['rooms', 'players', 'routes']) for (const x of s[key] || []) if (x.icon) names.add(x.icon);
    }
  }
  return [...names].sort();
}

// --- Fetching from Home Assistant ----------------------------------------------------------------

// What the layout needs beyond entity states.
function needs(layout, now, timeZone) {
  const weather = new Set();
  const calendars = new Map(); // entity -> days
  const history = new Map(); // entity -> earliest start
  const clock = makeClock(now, timeZone);
  const wantCal = (eid, days) => eid && calendars.set(eid, Math.max(calendars.get(eid) || 0, days));
  // Every screen, switched off or not: the admin UI previews them all.
  for (const screen of layout.screens) {
    if (screen.kind === 'meetingRoom') wantCal(screen.meeting.calendar, 2);
    for (const s of screenSections(screen)) {
      if (s.type === 'weather' && s.entity) weather.add(s.entity);
      if (s.type === 'calendar') s.entities.forEach((c) => wantCal(c, s.days));
      if (s.type === 'energyGraph') {
        const { start } = graphWindow(s, clock);
        for (const k of ['solar', 'load', 'gridImport', 'gridExport']) {
          const e = s[k].entity;
          // An energy meter needs the reading just before the window too.
          const from = new Date(start.getTime() - (s[k].kind === 'energy' ? 3600000 : 0));
          if (e && (!history.has(e) || history.get(e) > from)) history.set(e, from);
        }
      }
    }
  }
  return { weather, calendars, history };
}

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

// HA's history API, one request for every entity that starts at the same
// time: {entity: [{state, last_changed}]}.
async function fetchHistory(base, byStart, now) {
  const groups = new Map();
  for (const [e, start] of byStart) {
    const k = start.toISOString();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const out = {};
  await Promise.all(
    [...groups].map(async ([start, entities]) => {
      const qs = `filter_entity_id=${entities.map(encodeURIComponent).join(',')}&end_time=${encodeURIComponent(now.toISOString())}&minimal_response&no_attributes`;
      const res = await haRequest(base, `/api/history/period/${encodeURIComponent(start)}?${qs}`);
      for (const series of Array.isArray(res) ? res : []) {
        const first = series && series[0];
        if (first && first.entity_id) out[first.entity_id] = series;
      }
    })
  );
  return out;
}

/**
 * Everything buildScreens() needs, from HA in parallel. Throws (code NO_HA)
 * if HA isn't configured, or if the state list itself can't be fetched; a
 * failed forecast, calendar or history only leaves that part empty (listed
 * in `errors`).
 */
async function fetchInputs(layout, globals, now = new Date()) {
  const base = haBase(globals);
  if (!base) {
    const err = new Error('Home Assistant host/token not configured');
    err.code = 'NO_HA';
    throw err;
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const want = needs(layout, now, timeZone);
  const errors = {};
  const forecasts = { daily: {}, hourly: {} };
  const calendars = {};
  let history = {};
  const soft = (key, p, put) =>
    p.then(put).catch((e) => {
      errors[key] = e.message;
    });
  const jobs = [haRequest(base, '/api/states')];
  for (const w of want.weather) {
    jobs.push(soft(`forecast:daily:${w}`, fetchForecast(base, w, 'daily'), (f) => (forecasts.daily[w] = f)));
    jobs.push(soft(`forecast:hourly:${w}`, fetchForecast(base, w, 'hourly'), (f) => (forecasts.hourly[w] = f)));
  }
  for (const [c, days] of want.calendars) {
    jobs.push(soft(`calendar:${c}`, fetchCalendar(base, c, now, days), (ev) => (calendars[c] = Array.isArray(ev) ? ev : [])));
  }
  if (want.history.size) jobs.push(soft('history', fetchHistory(base, want.history, now), (h) => (history = h)));
  const [all] = await Promise.all(jobs);
  const states = {};
  for (const s of Array.isArray(all) ? all : []) states[s.entity_id] = s;
  return { states, forecasts, calendars, history, errors, now, timeZone };
}

module.exports = {
  evalCond,
  statusIconLook,
  alertLine,
  stepAverage,
  buildScreens,
  screenEtag,
  iconsUsed,
  fetchInputs,
  makeClock
};
