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
const { haBase, haRequest, stablePicture } = require('./ha-state');
const { screenSections, GRAPH_SERIES, MEETING_ICONS } = require('./dashboard');
const feeds = require('./feeds');
const ical = require('./ical');
const immich = require('./immich');

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
    case 'startsWith':
      return s.startsWith(value);
    case 'in':
      return String(value)
        .split(',')
        .map((v) => v.trim())
        .includes(s);
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

// The value a condition reads: an entity's state, or one of its attributes.
function readValue(ha, eid, attribute) {
  if (!ha) return '';
  const v = attribute ? ha.attr(eid, attribute) : ha.raw(eid);
  return v == null ? '' : String(v);
}

// Whether a rule holds: on its own entity if it names one, else on any of
// the icon's entities; then its `also` condition, on the entity it names or
// the one that matched.
function ruleHolds(r, entities, attribute, ha, fallbackState) {
  const candidates = r.entity ? [r.entity] : entities;
  const attr = r.attribute || attribute;
  // No lookup (a bare state, as the tests and older callers pass): the rule
  // reads that state.
  if (!ha || !candidates.length) return evalCond(fallbackState, r.cond, r.value);
  return candidates.some((eid) => {
    if (!evalCond(readValue(ha, eid, attr), r.cond, r.value)) return false;
    if (!r.also) return true;
    const a = r.also;
    return evalCond(readValue(ha, a.entity || eid, a.attribute), a.cond, a.value);
  });
}

// A status icon's look: the first matching rule's colour/icon/visibility,
// else the icon's own defaults. `state` is the main entity's (for a caller
// without a lookup); `ha` lets rules read every entity the icon follows.
function statusIconLook(icon, state, ha) {
  const entities = [icon.entity, ...(icon.entities || [])].filter(Boolean);
  for (const r of icon.rules || []) {
    if (ruleHolds(r, entities, icon.attribute, ha, state)) {
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

// HA's own text for a reading — its state and unit as HA shows them
// ("12.34 kWh"), which is what the panel prints.
const ascii = (u) => String(u || '').replace(/[^\x20-\x7e]/g, '');
function stateText(ha, eid) {
  const v = ha.text(eid);
  if (!v) return '';
  const u = ascii(ha.unit(eid));
  return u ? `${v} ${u}` : v;
}

function measure(ha, eid) {
  if (!eid) return null;
  const v = ha.number(eid);
  if (v == null) return null;
  // To one decimal place, whatever the sensor carries ("11.834" -> "11.8").
  const u = ascii(ha.unit(eid));
  const t = round1(v).toFixed(1);
  return { value: round1(v), unit: ha.unit(eid), text: u ? `${t} ${u}` : t };
}


const fixed = (v, d) => (v == null || !Number.isFinite(Number(v)) ? '--' : arduinoFixed(Number(v), d));

// A number as the kitchen panel's firmware wrote it: String(float, d), that
// is Arduino-ESP32's dtostrf(v, d + 2, d) on a float. It rounds half away
// from zero and pads on the left to that width (5 -> " 5"), so the text,
// and where it lands, are the panel's.
function arduinoFixed(value, prec) {
  let n = Math.fround(value);
  let fill = prec + 2 - (prec > 0 ? prec + 1 : 0);
  let out = '';
  const negative = n < 0;
  if (negative) {
    fill--;
    n = -n;
  }
  n += 1 / (2 * 10 ** prec);
  let tenpow = 1;
  let digits = 1;
  while (n >= 10 * tenpow) {
    tenpow *= 10;
    digits++;
  }
  n /= tenpow;
  fill -= digits;
  while (fill-- > 0) out += ' ';
  if (negative) out += '-';
  digits += prec;
  while (digits-- > 0) {
    const digit = Math.min(9, Math.trunc(n));
    out += String(digit);
    if (digits === prec && prec > 0) out += '.';
    n = (n - digit) * 10;
  }
  return out;
}

// C's roundf on a float: halves away from zero (Math.round takes -2.5 to -2).
const roundf = (v) => {
  const f = Math.fround(v);
  return Math.sign(f) * Math.round(Math.abs(f)) || 0;
};

// The next change between dry and wet in the hourly forecast: raining now
// and when it stops, when it starts, or raining throughout.
function rainOutlook(hourly, s, clock) {
  const now = clock.now.getTime();
  let first = null;
  let change = null;
  let checked = 0;
  for (const f of hourly) {
    if (checked >= s.rainHours) break;
    const t = Date.parse(f.datetime);
    if (!Number.isFinite(t) || t < now - 3600000) continue;
    if (t > now + s.rainHours * 3600000) break;
    const wet = Number(f.precipitation) > s.rainThresholdMm;
    if (first == null) first = wet;
    else if (wet !== first && !change) change = new Date(t);
    checked += 1;
  }
  if (first == null) return { state: 'dry', time: '', text: '' };
  if (change) {
    const time = clock.time(change);
    return first ? { state: 'stops', time, text: `Rain stops ${time}` } : { state: 'starts', time, text: `Rain at ${time}` };
  }
  return first ? { state: 'continuing', time: '', text: 'Rain continuing' } : { state: 'dry', time: '', text: '' };
}

function weather(s, ctx) {
  const { ha, clock, inputs } = ctx;
  const w = s.entity;
  if (!w) return null;
  const a = (k) => ha.attr(w, k);
  const fc = [];
  const hourly = (inputs.forecasts.hourly || {})[s.hourlyEntity || w] || [];
  const daily = (inputs.forecasts.daily || {})[w] || [];
  if (s.later) {
    // About three hours out.
    const later = hourly.find((f) => Date.parse(f.datetime) >= clock.now.getTime() + 3 * 3600000) || hourly[hourly.length - 1];
    if (later) fc.push({ label: 'Later', condition: later.condition || '', high: round1(later.temperature), low: null });
  }
  const upcoming = daily.filter((f) => dayDiff(new Date(f.datetime), clock.now, clock.timeZone) >= 1);
  for (const f of upcoming.slice(0, s.days)) {
    // Unrounded: the display rounds them, once, as the panel did.
    fc.push({ label: clock.weekday(new Date(f.datetime)), condition: f.condition || '', high: num(f.temperature), low: num(f.templow) });
  }
  const condition = ha.text(w);
  const hour = clock.hour(clock.now);
  const solar = s.solarForecast ? ha.number(s.solarForecast) : null;
  return {
    condition,
    // The icon to draw: partly cloudy at night (20:00-06:00) has its own.
    icon: condition === 'partlycloudy' && (hour >= 20 || hour < 6) ? 'night-partlycloudy' : condition,
    temperatureText: num(a('temperature')) == null ? '--' : String(roundf(num(a('temperature')))),
    humidityText: fixed(a('humidity'), 0),
    windText: fixed(a('wind_speed'), 0),
    bearing: a('wind_bearing') == null || !Number.isFinite(Number(a('wind_bearing'))) ? null : Number(a('wind_bearing')),
    uv: round1(a('uv_index')),
    uvText: fixed(a('uv_index'), 1),
    rain: s.rain ? rainOutlook(hourly, s, clock) : null,
    solar: solar == null ? null : { value: round1(solar), text: `Expecting ${arduinoFixed(solar, 1)}kWh today` },
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
    style: s.style,
    solarToday: solar,
    solarExpected: expected,
    loadToday: measure(ha, s.loadToday),
    gridExport: measure(ha, s.gridExport),
    gridImport: measure(ha, s.gridImport),
    solarPct: solar && expected && expected.value > 0 ? Math.round((solar.value / expected.value) * 100) : null
  };
}

// A power sensor's reading in watts, whatever unit it reports in (a meter
// in kW reads -1.25, not -1250).
const TO_WATTS = { w: 1, kw: 1000, mw: 1e6 };
function powerWatts(ha, eid) {
  const n = ha.number(eid);
  if (n == null) return null;
  return n * (TO_WATTS[String(ha.unit(eid)).trim().toLowerCase()] || 1);
}

// A wall-clock time ("2026-10-03 17:17", no offset) where the house is.
function wallTime(fields, timeZone) {
  const want = Date.UTC(...fields);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, Number(x.value)])
    );
    t += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(t);
}

// When charging or discharging will finish, from the sensor that says so,
// as "17:17" (or '' if it doesn't say). It can hold:
//   a timestamp (a timestamp sensor: "2026-10-03T16:17:58+00:00"), its
//     offset honoured; one with none ("2026-10-03 17:17:00", an
//     input_datetime) is the house's local time;
//   the time left (a number in s, min, h or d, or "1:45:00"): from now.
const DURATION_UNITS = { s: 1, sec: 1, min: 60, m: 60, h: 3600, hr: 3600, d: 86400 };
function etaTime(ha, eid, clock) {
  if (!eid) return '';
  const v = ha.text(eid).trim();
  const ts = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (ts) {
    const [, y, mo, d, h, mi, sec = '0', zone] = ts;
    const at = zone ? new Date(Date.parse(v.replace(' ', 'T'))) : wallTime([+y, +mo - 1, +d, +h, +mi, +sec], clock.timeZone);
    return Number.isFinite(at.getTime()) ? clock.time(at) : '';
  }
  let secs = null;
  const hms = v.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) secs = +hms[1] * 3600 + +hms[2] * 60 + +(hms[3] || 0);
  else {
    const n = ha.number(eid);
    const k = DURATION_UNITS[String(ha.unit(eid)).trim().toLowerCase()];
    if (n != null && k) secs = n * k;
  }
  return secs != null && secs >= 0 ? clock.time(new Date(clock.now.getTime() + secs * 1000)) : '';
}

// From a power sensor: which way the battery's going (beyond ± idleWatts;
// negative is charging unless the layout says it's positive, as some
// inverters report), and when it'll be full or empty.
function powerStatus(s, ha, clock) {
  const w = powerWatts(ha, s.power);
  if (w == null) return { status: '', eta: '' };
  const p = s.chargingWhen === 'positive' ? -w : w;
  if (p < -s.idleWatts) {
    const t = etaTime(ha, s.chargeEta, clock);
    return { status: 'charging', eta: t ? `full at ${t}` : '' };
  }
  if (p > s.idleWatts) {
    const t = etaTime(ha, s.dischargeEta, clock);
    return { status: 'discharging', eta: t ? `empty at ${t}` : '' };
  }
  return { status: 'idle', eta: '' };
}

function battery(s, { ha, layout, clock }) {
  if (!s.soc && !s.status && !s.power) return null;
  const soc = ha.number(s.soc);
  const fromPower = s.power ? powerStatus(s, ha, clock) : null;
  const status = fromPower ? fromPower.status : ha.text(s.status).toLowerCase();
  const t = layout.thresholds;
  const c = s.colors;
  let col = c.idle;
  // From a power sensor the colour is the direction only, as the kitchen
  // panel drew it; from a status sensor, critical charge wins.
  if (!fromPower && soc != null && soc <= t.batteryCritical) col = c.critical;
  else if (status === 'charging') col = c.charging;
  else if (status === 'full') col = c.full;
  else if (status === 'discharging') col = c.discharging;
  return {
    // Unrounded: the bar fills to it, as the panel's did.
    soc: soc == null ? null : soc,
    // "n/a" when it can't be read, as the panel showed a sensor it couldn't fetch.
    socText: soc == null ? 'n/a' : stateText(ha, s.soc),
    status,
    // Nothing when the power sensor can't be read (the panel left it blank).
    statusText: fromPower && !status ? '' : titleCase(status) || 'Idle',
    eta: fromPower ? fromPower.eta : ha.text(s.eta),
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
        const look = statusIconLook(ic, state == null ? '' : String(state), ha);
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
function eventsOf(inputs, entities, clock) {
  // An all-day date's midnight where the house is (not where the server is).
  const midnight = (date) => (clock ? clock.startOfDay(new Date(`${date}T12:00:00Z`)) : new Date(`${date}T00:00:00`));
  const out = [];
  for (const entity of entities) {
    ((inputs.calendars || {})[entity] || []).forEach((e, index) => {
      const allDay = Boolean(e.start && e.start.date && !e.start.dateTime);
      const start = allDay ? midnight(e.start.date) : new Date((e.start && e.start.dateTime) || e.start);
      const endRaw = e.end && (e.end.dateTime || e.end.date);
      const end = endRaw ? (e.end.date && !e.end.dateTime ? midnight(e.end.date) : new Date(endRaw)) : null;
      if (!Number.isFinite(start.getTime())) return;
      out.push({ entity, index, allDay, start, end: end && Number.isFinite(end.getTime()) ? end : null, title: e.summary || '', description: e.description || '' });
    });
  }
  return out.sort((x, y) => x.start - y.start || x.title.localeCompare(y.title));
}

// The kitchen panel's order: at most 20 events, taken calendar by calendar
// in the order they're listed (each calendar's in Home Assistant's order),
// then timed ones first by their "HH:MM" (so an event that began last night
// at 20:00 sorts as 20:00), all-day ones after; ties keep that order.
function panelOrder(events, entities, clock) {
  const rank = (e) => entities.indexOf(e.entity) * 10000 + e.index;
  const taken = [...events].sort((a, b) => rank(a) - rank(b)).slice(0, 20);
  const timed = taken.filter((e) => !e.allDay).map((e, i) => ({ e, i, hhmm: clock.time(e.start) }));
  timed.sort((a, b) => (a.hhmm < b.hhmm ? -1 : a.hhmm > b.hhmm ? 1 : a.i - b.i));
  return [...timed.map((t) => t.e), ...taken.filter((e) => e.allDay)];
}

// The first six words of a description, on one line, at most 32 characters.
function shortDescription(text) {
  // Each line break a space, as the panel did ("\r\n" is two, an empty word).
  const d = String(text || '').replace(/[\r\n]/g, ' ').trim();
  if (!d) return '';
  const words = d.split(' ');
  let out = words.slice(0, 6).join(' ');
  if (words.length > 6) out += '...';
  return out.length > 32 ? `${out.slice(0, 32)}...` : out;
}

function calendar(s, { inputs, clock }) {
  let events = eventsOf(inputs, s.entities, clock);
  if (s.today) {
    const sod = clock.startOfDay(clock.now);
    const eod = clock.startOfDay(new Date(sod.getTime() + 36 * 3600000));
    events = events.filter((e) => e.start < eod && (!e.end || e.end > sod));
  }
  else events = events.filter((e) => !e.end || e.end > clock.now);
  if (s.timedFirst) events = panelOrder(events, s.entities, clock);
  return {
    lines: events.slice(0, s.lines).map((e) => {
      const day = clock.dayLabel(e.start < clock.now ? clock.now : e.start);
      const time = e.allDay ? '' : clock.time(e.start);
      return {
        day,
        time,
        title: e.title,
        allDay: e.allDay,
        color: (s.colors || {})[e.entity] || BLACK,
        description: s.descriptions ? shortDescription(e.description) : '',
        text: `${day}${time ? ` ${time}` : ''} · ${e.title}`
      };
    })
  };
}

// Company announcements (lib/feeds.js): the newest `count` items, each a
// title, a short summary and when it was posted. `error` when the feed can't
// be read (the last good copy still shows).
const SUMMARY_MAX = 220;
function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}
function announcements(s, { inputs, clock }) {
  const feed = (inputs.feeds || {})[s.url] || { items: [], error: '' };
  const oldest = s.maxAgeDays > 0 ? clock.now.getTime() - s.maxAgeDays * 86400000 : null;
  const items = (feed.items || [])
    .filter((it) => !oldest || !it.date || new Date(it.date).getTime() >= oldest)
    .slice(0, s.count)
    .map((it) => {
      const date = it.date ? new Date(it.date) : null;
      const summary = s.summary && it.summary && it.summary !== it.title ? shorten(it.summary, SUMMARY_MAX) : '';
      return { title: it.title || shorten(it.summary, 80), summary, when: s.showDate && date ? clock.when(date) : '' };
    });
  return {
    items,
    color: s.color,
    empty: !s.url ? 'No feed set' : feed.error && !items.length ? "Couldn't read the feed" : items.length ? '' : 'No announcements',
    error: feed.error || ''
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
          // The cover, for /api/art (?fmt=spectra on the device, png in the
          // admin preview); it changes with the track — and only then: HA's
          // rotating access token is dropped, or the screen would change
          // (and cost a panel refresh) every few minutes mid-track.
          art: stablePicture(String(ha.attr(m.entity, 'entity_picture') || '')),
          playing: state === 'playing'
        };
      })
      .filter(Boolean)
  };
}

// A departure sensor's state: a timestamp, a number of minutes, or "HH:MM".
// When a departure is, from however a stop's sensor gives it:
//   "Due", "Now", "Arriving"               leaving now
//   12, "12", "12 min", "12 mins", "12m"   minutes from now (a bare number in
//                                          s or h, by the entity's unit)
//   "17:05" or "17:05:30"                  a time today (or just past midnight)
//   "2026-10-03T16:05:00+00:00"            a timestamp, its offset honoured;
//   "2026-10-03 17:05:00"                  without one, the house's local time
// Anything else is shown as it is, without a countdown.
const MINUTE_UNITS = { s: 1 / 60, sec: 1 / 60, min: 1, m: 1, h: 60, hr: 60 };
function departureAt(raw, unit, clock) {
  const v = String(raw).trim();
  const now = clock.now.getTime();
  if (/^(due|now|arriving|departing)$/i.test(v)) return new Date(now);
  let m = v.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)?$/i);
  if (m) {
    const k = m[2] ? 1 : MINUTE_UNITS[String(unit || '').trim().toLowerCase()] ?? 1;
    return new Date(now + Number(m[1]) * k * 60000);
  }
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h, mi, sec = '0', zone] = m;
    const at = zone ? new Date(Date.parse(v.replace(' ', 'T'))) : wallTime([+y, +mo - 1, +d, +h, +mi, +sec], clock.timeZone);
    return Number.isFinite(at.getTime()) ? at : null;
  }
  m = v.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) {
    const [nh, nm] = clock.time(clock.now).split(':').map(Number);
    let mins = +m[1] * 60 + +m[2] - (nh * 60 + nm);
    if (mins < -60) mins += 1440;
    return new Date(now + mins * 60000);
  }
  return null;
}

function departure(raw, unit, clock, urgentMin, rowColor) {
  if (raw == null || raw === '' || NO_VALUE.has(String(raw).toLowerCase())) return null;
  const at = departureAt(raw, unit, clock);
  if (!at) return { time: '', minutes: null, urgent: false, color: rowColor, text: String(raw) };
  const minutes = Math.max(0, Math.round((at - clock.now) / 60000));
  const urgent = minutes <= urgentMin;
  // "Due" rather than "0 min", as stop displays say.
  return { time: clock.time(at), minutes, urgent, color: urgent ? RED : rowColor, text: minutes === 0 ? 'Due' : `${minutes} min` };
}

// A stop's arrivals list (an attribute of its sensor): each entry's live
// time if it has one, else its timetabled one; only the routes asked for;
// gone ones dropped; soonest first.
const LIVE_KEYS = ['real_time_arrival', 'realtime_arrival', 'expected_arrival', 'real_time_departure', 'expected_departure', 'expected', 'realtime'];
const PLANNED_KEYS = ['scheduled_arrival', 'scheduled_departure', 'scheduled', 'arrival', 'departure', 'time', 'due'];
const ROUTE_ONLY = /^[A-Za-z]{0,2}\d{1,3}[A-Za-z]{0,2}$/;
function stopArrivals(r, ha, clock) {
  const list = ha.attr(r.stopEntity, r.listAttribute);
  if (!Array.isArray(list)) return [];
  let only = r.routes.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  // A stop serves many routes: a line named for one ("C3", "C3 Maynooth")
  // shows only that route's buses, unless its routes are set.
  if (!only.length && r.name) {
    const route = ROUTE_ONLY.test(r.name.trim()) ? r.name.trim() : splitRoute(r.name).route;
    if (route) only = [route.toLowerCase()];
  }
  const pick = (a, keys) => keys.map((k) => a[k]).find((v) => v != null && v !== '');
  return list
    .filter((a) => a && typeof a === 'object' && (!only.length || only.includes(String(a.route ?? '').toLowerCase())))
    .map((a) => {
      const live = pick(a, LIVE_KEYS);
      const raw = live ?? pick(a, PLANNED_KEYS);
      const at = raw == null ? null : departureAt(raw, '', clock);
      return at && { a, raw, live: live != null, at };
    })
    .filter((x) => x && x.at.getTime() >= clock.now.getTime() - 60000)
    .sort((x, y) => x.at - y.at);
}

// A route's name as a stop board shows it: the route number for a badge
// ("C3", "39A", "N4") and where it's going ("Maynooth"). "42 · City Centre",
// "39A - Ongar" and "C3 Maynooth" split, as does a short line name before a
// separator ("DART · Howth", "Luas - Green Line"); anything else is all
// destination.
function splitRoute(name) {
  const v = String(name || '').trim();
  const m = v.match(/^([A-Za-z]{0,2}\d{1,3}[A-Za-z]{0,2})(?:\s*[·\-–—:|]\s*|\s+)(.+)$/) || v.match(/^(\S{1,6})\s+[·\-–—:|]\s+(.+)$/);
  return m ? { route: m[1], destination: m[2].trim() } : { route: '', destination: v };
}

function transport(s, { ha, clock, layout }) {
  const read = (eid, attr) => (attr ? ha.attr(eid, attr) : ha.text(eid));
  const urgentMin = layout.thresholds.transportUrgentMin;
  // A live time in the route's colour; one only from the timetable in black
  // (red either way when it's due).
  const times = (r, list) => list.slice(0, 2).map((x) => ({ ...departure(x.raw, '', clock, urgentMin, x.live ? r.color : BLACK), live: x.live }));
  return {
    routes: s.routes.flatMap((r) => {
      if (r.stopEntity) {
        const arrivals = stopArrivals(r, ha, clock);
        const row = (parts, list) => ({ name: [parts.route, parts.destination].filter(Boolean).join(' '), ...parts, stop: r.stop, icon: r.icon, color: r.color, departures: times(r, list) });
        // Named: one line, every arrival (of its routes) on it. Named just
        // for its route ("C3"), it's headed where its next bus is going.
        if (r.name) {
          const n = r.name.trim();
          const parts = ROUTE_ONLY.test(n) ? { route: n, destination: String(arrivals[0]?.a.headsign ?? '') } : splitRoute(n);
          return [{ ...row(parts, arrivals), name: r.name }];
        }
        // Else as a stop board: a line per route and headsign, the soonest first.
        const lines = new Map();
        for (const x of arrivals) {
          const key = `${x.a.route ?? ''}\u0000${x.a.headsign ?? ''}`;
          if (!lines.has(key)) lines.set(key, { parts: { route: String(x.a.route ?? ''), destination: String(x.a.headsign ?? '') }, list: [] });
          lines.get(key).list.push(x);
        }
        const out = [...lines.values()].slice(0, r.lines).map((l) => row(l.parts, l.list));
        return out.length ? out : [row({ route: '', destination: r.stop || 'No departures' }, [])];
      }
      return [
        {
          name: r.name,
          ...splitRoute(r.name),
          stop: r.stop,
          icon: r.icon,
          color: r.color,
          departures: [
            [r.departure1, r.departure1Attribute],
            [r.departure2, r.departure2Attribute]
          ]
            .filter(([eid]) => eid)
            .map(([eid, attr]) => departure(read(eid, attr), attr ? '' : ha.unit(eid), clock, urgentMin, r.color))
            .filter(Boolean)
        }
      ];
    })
  };
}

const ALARM_COLORS = { triggered: RED, arming: YELLOW, pending: YELLOW, disarmed: GREEN };

function alarm(s, { ha, clock }) {
  if (!s.entity) return null;
  const state = ha.text(s.entity);
  const last = (eid) => (eid ? clock.when(ha.moment(eid)) : '');
  const changed = ha.changed(s.entity);
  return {
    state,
    label: titleCase(state) || 'Unknown',
    since: clock.when(changed),
    sinceTime: changed ? clock.time(changed) : '',
    summary: s.summary,
    color: state.startsWith('armed_') ? RED : ALARM_COLORS[state] || BLACK,
    last: { armed: last(s.lastArmed), disarmed: last(s.lastDisarmed), triggered: last(s.lastTriggered) }
  };
}

function openings(s, { ha, clock }) {
  const items = s.items.map((d) => {
    const st = ha.text(d.entity);
    const open = ['on', 'open', 'opening', 'unlocked'].includes(st);
    const at = ha.changed(d.entity);
    return { name: ha.name(d.entity, d.name), open, state: open ? 'Open' : st ? 'Closed' : '—', when: clock.when(at), time: at ? clock.time(at) : '', color: open ? s.openColor : s.closedColor };
  });
  return { items, open: items.filter((i) => i.open).length, total: items.length };
}

function motion(s, { ha, clock, layout }) {
  const recentMs = layout.thresholds.motionRecentMin * 60000;
  return {
    sensors: s.sensors.map((m) => {
      const at = ha.changed(m.entity);
      const recent = ha.text(m.entity) === 'on' || (at != null && clock.now - at <= recentMs);
      return { name: ha.name(m.entity, m.name), when: clock.when(at), time: at ? clock.time(at) : '', on: ha.text(m.entity) === 'on', recent, color: recent ? BLUE : BLACK };
    })
  };
}

function cameras(s, { ha, clock }) {
  return {
    cameras: s.cameras.map((c) => {
      const at = ha.changed(c.entity);
      return { name: ha.name(c.entity, c.name), when: clock.when(ha.moment(c.entity)), time: at ? clock.time(at) : '', on: ha.text(c.entity) === 'on' };
    })
  };
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

// Where each bar of consumption came from. Grid first (it's metered); then
// the battery's metered discharge; then solar, up to what it produced; any
// remainder is put down to the battery (a house with a battery but no
// sensor for it, or sensors that don't quite agree).
function splitConsumption(load, solar, gridImport, batteryDischarge) {
  if (load == null) return { fromSolar: null, fromBattery: null, fromGrid: null };
  const fromGrid = Math.min(Math.max(0, gridImport || 0), load);
  const rest = load - fromGrid;
  let fromBattery;
  let fromSolar;
  const metered = batteryDischarge != null ? Math.min(Math.max(0, batteryDischarge), rest) : 0;
  // Solar covers what's left, up to what it actually produced; anything
  // still unaccounted for came from the battery (unmetered, or its sensor
  // lagging the others).
  fromSolar = solar == null ? rest - metered : Math.min(Math.max(0, solar), rest - metered);
  fromBattery = rest - fromSolar;
  return { fromSolar: round2(fromSolar), fromBattery: round2(fromBattery), fromGrid: round2(fromGrid) };
}

/**
 * Two panels over the same time axis:
 *   top      actual solar (bars) against the forecast (line)
 *   bottom   consumption stacked by source — from solar, from the battery,
 *            from the grid — above the line; export to the grid below it
 * Everything is average kW per bar; totals are kWh.
 */
function energyGraph(s, ctx) {
  const { clock, ha } = ctx;
  const win = graphWindow(s, clock);
  const series = {};
  for (const k of GRAPH_SERIES) series[k] = seriesBuckets(s[k], win, ctx);
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
  // One signed battery sensor stands in for whichever of charge and
  // discharge isn't metered on its own: its average over each bar, the
  // charging side one way and the discharging side the other.
  if (series.batteryPower) {
    const signed = series.batteryPower.map((v) => (v == null ? null : s.batteryChargingWhen === 'positive' ? -v : v));
    if (!series.batteryCharge) series.batteryCharge = signed.map((v) => (v == null ? null : round2(Math.max(0, -v))));
    if (!series.batteryDischarge) series.batteryDischarge = signed.map((v) => (v == null ? null : round2(Math.max(0, v))));
  }
  const at = (k, i) => (series[k] ? series[k][i] : null);
  // Below the line, where the energy went other than the house: into the
  // battery (next to the line) and out to the grid.
  const stack = { fromSolar: [], fromBattery: [], fromGrid: [], export: [], toBattery: [] };
  for (let i = 0; i < win.count; i++) {
    const part = splitConsumption(at('load', i), at('solar', i), at('gridImport', i), at('batteryDischarge', i));
    stack.fromSolar.push(part.fromSolar);
    stack.fromBattery.push(part.fromBattery);
    stack.fromGrid.push(part.fromGrid);
    stack.export.push(at('gridExport', i));
    const ch = at('batteryCharge', i);
    stack.toBattery.push(ch == null ? null : Math.max(0, ch));
  }

  const hours = win.bucketMs / 3600000;
  const now = clock.now.getTime();
  const kwh = (vals, future) => {
    if (!vals) return null;
    let sum = 0;
    vals.forEach((v, i) => {
      if (v == null) return;
      const a = win.start.getTime() + i * win.bucketMs;
      sum += v * (future ? hours : Math.min(win.bucketMs, now - a) / 3600000);
    });
    return round1(sum);
  };
  const max = (lists) => round2(Math.max(0, ...lists.flat().filter((v) => v != null)));
  const labels = Array.from({ length: win.count }, (_, i) => String(clock.hour(new Date(win.start.getTime() + i * win.bucketMs))).padStart(2, '0'));
  const nowIndex = Math.floor((now - win.start.getTime()) / win.bucketMs);
  return {
    range: s.range,
    bucketMin: s.bucketMin,
    start: win.start.toISOString(),
    labels,
    nowIndex: nowIndex >= 0 && nowIndex < win.count ? nowIndex : null,
    solar: { actual: series.solar, forecast: series.forecast, max: max([series.solar || [], series.forecast || []]) },
    usage: {
      ...stack,
      max: max([stack.fromSolar.map((v, i) => (v == null ? null : v + (stack.fromBattery[i] || 0) + (stack.fromGrid[i] || 0)))]),
      // How far below the line goes: export and charging together.
      exportMax: max([stack.export.map((v, i) => (v == null && stack.toBattery[i] == null ? null : (v || 0) + (stack.toBattery[i] || 0)))])
    },
    totals: {
      solar: kwh(series.solar),
      forecast: kwh(series.forecast, true),
      load: kwh(series.load),
      fromSolar: kwh(series.load && stack.fromSolar),
      fromBattery: kwh(series.load && stack.fromBattery),
      fromGrid: kwh(series.load && stack.fromGrid),
      gridImport: kwh(series.gridImport),
      gridExport: kwh(series.gridExport),
      toBattery: kwh(series.batteryCharge)
    },
    colors: s.colors
  };
}

// --- Heating and "now" ----------------------------------------------------------------------

const OPEN_STATES = ['on', 'open', 'opening', 'unlocked'];
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// A zone against its setpoint: calling when it's in heat or auto and more
// than `delta` below it (about where a radiator valve opens).
function zoneValues(z, ha, delta) {
  const mode = ha.text(z.entity);
  const current = num(ha.attr(z.entity, 'current_temperature'));
  const target = num(ha.attr(z.entity, 'temperature'));
  const active = (mode === 'heat' || mode === 'auto') && current != null && target != null && target - current > delta;
  // Unrounded: the scale and the bars are worked out from them, as the
  // panel's were, and the display writes them as it did.
  return { name: z.name || ha.name(z.entity), icon: z.icon || '', current, target, mode, active };
}

function callingZones(zones, ha, delta) {
  return zones.filter((z) => z.entity && ha.get(z.entity)).map((z) => zoneValues(z, ha, delta));
}

function waterHeater(ha, eid) {
  if (!eid || !ha.get(eid)) return null;
  const cur = num(ha.attr(eid, 'current_temperature'));
  const tgt = num(ha.attr(eid, 'temperature'));
  return {
    on: String(ha.attr(eid, 'operation_mode') || '') === 'heating',
    mode: String(ha.attr(eid, 'operation_mode') || ''),
    current: cur == null ? null : Math.round(cur),
    target: tgt == null ? null : Math.round(tgt)
  };
}

function heating(s, { ha }) {
  const zones = callingZones(s.zones, ha, s.callingDelta);
  const temps = zones.flatMap((z) => [z.current, z.target]).filter((v) => v != null);
  const lo = temps.length ? Math.min(...temps) : 5;
  const hi = temps.length ? Math.max(...temps) : 25;
  const calling = zones.filter((z) => z.active).length;
  return {
    on: calling > 0,
    mode: ha.text(s.entity),
    // The whole house's "now" and "set" lines (the kitchen panel never
    // showed them: its Heating page didn't read the whole-house thermostat).
    current: s.houseTemps ? num(ha.attr(s.entity, 'current_temperature')) : null,
    target: s.houseTemps ? num(ha.attr(s.entity, 'temperature')) : null,
    calling,
    total: zones.length,
    scaleMin: Math.floor(lo / 5) * 5,
    scaleMax: Math.ceil(hi / 5) * 5,
    zones,
    water: waterHeater(ha, s.hotWater)
  };
}

const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k])));
const lowerFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);
const cut = (t, max) => (t.length > max ? `${t.slice(0, max - 3)}...` : t);

// "Front & back" (and) or "Kitchen, Side" (list).
function joinNames(names, join) {
  if (join === 'and' && names.length > 1) return `${names.slice(0, -1).join(', ')} & ${lowerFirst(names[names.length - 1])}`;
  return names.join(', ');
}

// The alarm's own words: armed, part set, disarmed.
function alarmItem(it, ha) {
  const st = ha.text(it.entity);
  let look = { icon: it.icon, color: it.color, line1: it.title || 'Alarm' };
  if (st === 'disarmed') look = { icon: 'shield-check', color: GREEN, line1: 'Alarm disarmed' };
  // (Home Assistant's armed_home and armed_night are "armed", as the panel said.)
  else if (st.includes('partly') || st.startsWith('partset')) look = { icon: 'shield-alert', color: RED, line1: 'Alarm part set' };
  else if (st.startsWith('armed') || st === 'triggered') look = { icon: 'shield-alert', color: RED, line1: st === 'triggered' ? 'Alarm triggered' : 'Alarm armed' };
  const ev = it.eventEntity ? ha.text(it.eventEntity) : '';
  return { ...look, line2: ev.length > it.maxChars ? `${ev.slice(0, it.maxChars - 1)}...` : ev };
}

function nowItem(it, ha) {
  const item = (vars, line1, line2) => ({ icon: it.icon, color: it.color, line1: fill(line1, vars), line2: fill(line2, vars) });
  const many = (n) => (n > 1 && it.titleMany ? it.titleMany : it.title);
  switch (it.kind) {
    case 'alarm':
      return it.entity ? alarmItem(it, ha) : null;
    case 'heating': {
      const n = callingZones(it.items, ha, it.callingDelta).filter((z) => z.active).length;
      return n > 0 ? item({ n, name: it.name }, it.title, it.detail) : null;
    }
    case 'hotWater': {
      const w = waterHeater(ha, it.entity);
      return w && w.on ? item({ current: w.current == null ? '--' : w.current, target: w.target == null ? '--' : w.target, name: it.name }, it.title, it.detail || '{current}C / {target}C target') : null;
    }
    case 'openings': {
      const open = it.items.filter((x) => OPEN_STATES.includes(ha.text(x.entity))).map((x) => ha.name(x.entity, x.name));
      if (!open.length) return null;
      const names = cut(joinNames(open, it.join), 72);
      return item({ n: open.length, names, name: it.name }, many(open.length), it.detail || '{names}');
    }
    case 'plants': {
      const dry = it.items.filter((x) => evalCond(ha.raw(x.entity), it.cond, it.value)).map((x) => ha.name(x.entity, x.name));
      if (!dry.length) return null;
      return item({ n: dry.length, names: dry.join(', '), name: it.name }, many(dry.length), it.detail || '{names}');
    }
    case 'robot': {
      if (ha.text(it.entity) !== it.value) return null;
      const b = ha.number(it.battery);
      return item({ name: it.name || ha.name(it.entity), battery: b == null ? '--' : Math.round(b), state: ha.text(it.entity) }, it.title, it.detail);
    }
    default: {
      const v = readValue(ha, it.entity, it.attribute);
      if (!it.entity || !evalCond(v, it.cond, it.value)) return null;
      return item({ name: it.name || ha.name(it.entity), state: v }, it.title, it.detail);
    }
  }
}

function now(s, { ha }) {
  return { items: s.items.map((it) => nowItem(it, ha)).filter(Boolean) };
}

// --- Guest Wi-Fi, a message, bins, air quality -----------------------------------------------

// A guest network (Settings -> Wi-Fi networks) as a join QR code: the
// modules worked out here (qrcode-generator), as rows of '0'/'1', so the
// display and the preview just draw squares.
const qrcode = require('qrcode-generator');
const wifiEscape = (v) => String(v).replace(/([\;,:"])/g, '\\$1');
function qrRows(text) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    let row = '';
    for (let c = 0; c < n; c++) row += q.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}
function guestWifi(s, { inputs }) {
  const nets = (inputs.wifiNetworks || []).filter((n) => n && n.name);
  const net = (s.network && nets.find((n) => n.name === s.network)) || nets[0];
  if (!net) return { ssid: '', password: '', caption: s.caption, qr: [], empty: 'No networks in Settings → Wi-Fi networks' };
  const pass = net.password || '';
  const join = `WIFI:T:${pass ? 'WPA' : 'nopass'};S:${wifiEscape(net.name)};${pass ? `P:${wifiEscape(pass)};` : ''};`;
  return { ssid: net.name, password: s.showPassword ? pass : '', caption: s.caption, qr: qrRows(join), empty: '' };
}

// Text with {entity_id} filled in: the entity's state and unit ("" when HA
// doesn't have it). Lines are kept; a message that comes out blank (an empty
// input_text) shows nothing.
function message(s, { ha }) {
  const text = s.text
    .replace(/\{\s*([a-z_]+\.[a-z0-9_]+)\s*\}/g, (_, eid) => {
      const v = ha.text(eid);
      const u = ha.unit(eid);
      return v ? `${v}${u ? (u === '%' || u === '°C' || u === '°F' ? u : ` ${u}`) : ''}` : '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { lines: text ? text.split('\n') : [], size: s.size, align: s.align, color: s.color, icon: s.icon };
}

// Each bin's next collection, soonest first: from its own sensor (a date, a
// timestamp, or a number of days) or the first calendar event whose title has
// one of its words. "Put out tonight" from `tonightFrom` the day before.
function binDate(ha, eid, clock) {
  const v = ha.text(eid);
  if (!v) return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return new Date(clock.startOfDay(clock.now).getTime() + Math.round(Number(v)) * 86400000 + 12 * 3600000);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? clock.startOfDay(new Date(`${v}T12:00:00Z`)) : new Date(Date.parse(v));
  return Number.isFinite(t.getTime()) ? t : null;
}
function bins(s, { ha, inputs, clock }) {
  const events = eventsOf(inputs, s.calendar ? [s.calendar] : [], clock).filter((e) => (e.end || e.start) > clock.startOfDay(clock.now));
  const words = (b) => (b.match || b.name).split(/[,;]/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  const next = s.bins
    .map((b) => {
      let at = b.entity ? binDate(ha, b.entity, clock) : null;
      if (!b.entity) {
        const w = words(b);
        const e = w.length ? events.find((x) => w.some((k) => x.title.toLowerCase().includes(k))) : null;
        at = e ? e.start : null;
      }
      if (!at) return null;
      const days = dayDiff(at, clock.now, clock.timeZone);
      if (days < 0 || days > s.days) return null;
      return { name: b.name || b.match, icon: b.icon || 'trash-can-outline', color: b.color, days, at };
    })
    .filter(Boolean)
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name))
    .slice(0, s.count);
  const hour = clock.hour(clock.now);
  const tonight = s.tonightFrom > 0 && hour >= s.tonightFrom ? next.filter((b) => b.days === 1).map((b) => b.name) : [];
  return {
    lines: next.map((b) => ({ name: b.name, icon: b.icon, color: b.color, when: clock.dayLabel(b.at), soon: b.days <= 1 })),
    note: tonight.length ? `Put out tonight: ${tonight.join(', ')}` : '',
    empty: !s.bins.length ? 'No bins set' : next.length ? '' : `No collections in the next ${s.days} days`
  };
}

// Air quality: each reading against its kind's usual limits (fair from the
// first, poor from the second); pollen and other words by their level.
const AIR_LIMITS = {
  co2: [1000, 1500],
  pm25: [15, 35],
  pm10: [45, 100],
  voc: [250, 400],
  aqi: [51, 101],
  pollen: [3, 5]
};
const AIR_DEVICE_CLASS = { carbon_dioxide: 'co2', pm25: 'pm25', pm10: 'pm10', volatile_organic_compounds: 'voc', volatile_organic_compounds_parts: 'voc', aqi: 'aqi', humidity: 'humidity' };
const LEVEL_WORDS = [
  [/^(none|very low|low|good|excellent|clean)$/i, 0],
  [/^(moderate|medium|fair|elevated)$/i, 1],
  [/^(high|very high|poor|bad|unhealthy|very unhealthy|hazardous|extreme)/i, 2]
];
const LEVEL_LOOK = [
  { label: 'Good', color: GREEN },
  { label: 'Fair', color: YELLOW },
  { label: 'Poor', color: RED }
];
// A photo from Immich, picked in fetchInputs (lib/immich.js): its source for
// /api/art (`immich:<asset>`, which only the server can fetch), a caption,
// and the height to fill (0 = the rest of its column). `empty` says why
// there's no photo (Immich not set up, an album with none...).
function photoData(p) {
  const x = p || {};
  return { src: x.src || '', caption: x.caption || '', empty: x.src ? '' : x.error || 'No photo' };
}
function photo(s, { inputs }) {
  return { ...photoData((inputs.photos || {})[`photo:${s.id}`]), height: s.height || 0 };
}

function airKind(it, ha) {
  if (it.kind !== 'auto') return it.kind;
  const dc = String(ha.attr(it.entity, 'device_class') || '');
  if (AIR_DEVICE_CLASS[dc]) return AIR_DEVICE_CLASS[dc];
  if (/pollen/.test(it.entity)) return 'pollen';
  if (/co2|carbon_dioxide/.test(it.entity)) return 'co2';
  if (/pm2_?5/.test(it.entity)) return 'pm25';
  if (/pm10/.test(it.entity)) return 'pm10';
  if (/voc/.test(it.entity)) return 'voc';
  if (/aqi|air_quality/.test(it.entity)) return 'aqi';
  if (/humidity/.test(it.entity)) return 'humidity';
  return 'other';
}
function airLevel(kind, n, word, it) {
  if (n == null) {
    const hit = LEVEL_WORDS.find(([re]) => re.test(word.trim()));
    return hit ? hit[1] : null;
  }
  if (kind === 'humidity' && it.fair == null && it.poor == null) return n < 20 || n > 70 ? 2 : n < 30 || n > 60 ? 1 : 0;
  const [fair, poor] = [it.fair ?? (AIR_LIMITS[kind] || [])[0], it.poor ?? (AIR_LIMITS[kind] || [])[1]];
  if (fair == null && poor == null) return null;
  return poor != null && n >= poor ? 2 : fair != null && n >= fair ? 1 : 0;
}
function airQuality(s, { ha }) {
  const items = s.items
    .filter((it) => it.entity)
    .map((it) => {
      const kind = airKind(it, ha);
      const n = ha.number(it.entity);
      const word = ha.text(it.entity);
      const level = airLevel(kind, n, word, it);
      const look = level == null ? null : LEVEL_LOOK[level];
      const unit = ha.unit(it.entity);
      const value = n != null ? `${Math.round(n * 10) / 10}${unit ? (unit === '%' ? '%' : ` ${unit}`) : ''}` : word ? titleCase(word) : '--';
      return {
        name: it.name || ha.name(it.entity),
        value,
        level: look && s.showLevel && n != null ? look.label : '',
        color: look ? look.color : BLACK
      };
    });
  const worst = items.reduce((w, x) => (x.color === RED ? 2 : x.color === YELLOW ? Math.max(w, 1) : w), 0);
  return { items, worst: items.length ? LEVEL_LOOK[worst].label : '', empty: items.length ? '' : 'No readings set' };
}

const BUILDERS = {
  spacer: (s) => ({ height: s.height }),
  weather,
  now,
  heating,
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
  cameras,
  announcements,
  guestWifi,
  message,
  bins,
  airQuality,
  photo
};

// --- Meeting room ----------------------------------------------------------------------------

const MEETING_LOOK = {
  free: { label: 'Available', color: GREEN },
  soon: { label: 'Starting soon', color: YELLOW },
  busy: { label: 'In use', color: RED },
  bookedEmpty: { label: 'Booked — no one here', color: YELLOW },
  occupied: { label: 'In use — not booked', color: YELLOW }
};

// A room's name when the layout doesn't give one: a Home Assistant
// calendar's friendly name, or a calendar link's own (X-WR-CALNAME).
function calendarName(calendar, { ha, inputs }) {
  if (!calendar) return '';
  if (ical.isCalendarUrl(calendar)) return ((inputs.calendarNames || {})[calendar] || ical.linkLabel(calendar));
  return ha.name(calendar);
}

function meetingIcon(status, m) {
  if (status === 'free') return m.freeIcon || MEETING_ICONS.free;
  if (status === 'soon') return MEETING_ICONS.soon;
  if (status === 'bookedEmpty') return MEETING_ICONS.bookedEmpty;
  return m.occupiedIcon || MEETING_ICONS.occupied; // busy, occupied
}

// One room's status from its calendar and occupancy sensor: shared by the
// meeting-room screen and each room on the room finder. `m` carries
// calendar, occupancy, soonMin, emptyMin (and the icons).
function roomStatus(m, { ha, clock, inputs }) {
  const now = clock.now;
  const events = eventsOf(inputs, m.calendar ? [m.calendar] : [], clock).filter((e) => !e.allDay && e.end && e.end > now);
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
  let busyUntil = null;
  if (current) {
    busyUntil = current.end;
    for (const e of events) if (e.start <= busyUntil && e.end > busyUntil) busyUntil = e.end;
  }
  const nextToday = next && clock.sameDay(next.start, now);
  let until;
  if (busyUntil) until = `Busy until ${clock.time(busyUntil)}`;
  // Someone's in without a booking: not "free", just not booked.
  else if (status === 'occupied') until = nextToday ? `Not booked until ${clock.time(next.start)}` : 'Not booked today';
  else if (nextToday) until = `Free until ${clock.time(next.start)}`;
  else until = 'Free for the rest of the day';

  // When this changes on its own: a meeting starting/ending, entering the
  // "starting soon" window, or becoming "booked but empty".
  const edges = [];
  if (current) edges.push(current.end - now);
  if (next) edges.push(next.start - now);
  // "Starting soon" only shows between meetings; during one, "in use" wins.
  if (next && !current) edges.push(next.start - m.soonMin * 60000 - now);
  if (current && occupied === false && ha.changed(m.occupancy)) {
    const emptyAt = Math.max(current.start.getTime(), ha.changed(m.occupancy).getTime()) + m.emptyMin * 60000;
    edges.push(emptyAt - now);
  }
  const look = MEETING_LOOK[status];
  return {
    status,
    label: (m.labels && m.labels[status]) || look.label,
    color: look.color,
    icon: meetingIcon(status, m),
    until,
    // Minutes free from now (null = the rest of the day), for sorting.
    freeForMin: current ? 0 : next && clock.sameDay(next.start, now) ? Math.round((next.start - now) / 60000) : null,
    events,
    current,
    next,
    edges: edges.filter((ms) => ms > 0)
  };
}

const QUARTER_MS = 15 * 60000;
const round3 = (n) => Math.round(n * 1000) / 1000;

// The next 1-3 hours as a bar under the status: booked blocks as fractions
// of the window. The window starts at the current quarter hour, not "now",
// so it stays the same (same ETag, no panel refresh) until the quarter
// turns or a booking changes.
function meetingTimeline(events, hours, title, clock) {
  if (!hours) return null;
  const start = Math.floor(clock.now.getTime() / QUARTER_MS) * QUARTER_MS;
  const span = hours * 3600000;
  const end = start + span;
  const blocks = events
    .filter((e) => e.start.getTime() < end && e.end.getTime() > start)
    .map((e) => ({
      from: round3(Math.max(0, (e.start.getTime() - start) / span)),
      to: round3(Math.min(1, (e.end.getTime() - start) / span)),
      title: title(e),
      time: `${clock.time(e.start)}–${clock.time(e.end)}`,
      color: RED
    }));
  // Both ends labelled, and a tick every 15 min for one hour, 30 for two,
  // 60 for three — minus any too close to an end to read.
  const step = { 1: 15, 2: 30, 3: 60 }[hours] * 60000;
  const tick = (t) => ({ at: round3((t - start) / span), label: clock.time(new Date(t)) });
  const ticks = [tick(start)];
  for (let t = Math.ceil(start / step) * step; t < end; t += step) {
    const at = (t - start) / span;
    if (at >= 0.1 && at <= 0.9) ticks.push(tick(t));
  }
  ticks.push(tick(end));
  return { hours, start: clock.time(new Date(start)), end: clock.time(new Date(end)), blocks, ticks };
}

// The room's climate for the bottom-right corner. CO2 is coloured: green
// fresh, yellow stuffy (1000+ ppm), red open a window (1500+).
function meetingClimate(c, ha) {
  if (!c.show || !(c.temperature || c.humidity || c.co2)) return null;
  const isClimate = c.temperature.startsWith('climate.');
  const temperature = round1(isClimate ? ha.attr(c.temperature, 'current_temperature') : c.temperature ? ha.number(c.temperature) : null);
  const humidity = round1(c.humidity ? ha.number(c.humidity) : isClimate ? ha.attr(c.temperature, 'current_humidity') : null);
  const co2 = c.co2 && ha.number(c.co2) != null ? Math.round(ha.number(c.co2)) : null;
  return {
    temperature,
    unit: isClimate ? '°' : (c.temperature && ha.unit(c.temperature)) || '°',
    humidity,
    co2,
    co2Color: co2 == null ? null : co2 >= 1500 ? RED : co2 >= 1000 ? YELLOW : GREEN
  };
}

function meetingRoom(m, ctx) {
  const { ha, clock } = ctx;
  // The minutes left count from the real time, not the look-ahead.
  const now = ctx.realNow || clock.now;
  const r = roomStatus(m, ctx);
  const title = (e) => (m.hideTitles ? 'Booked' : e.title || 'Booked');
  const range = (e) => `${clock.time(e.start)}–${clock.time(e.end)}`;
  const { current, next, events } = r;
  return {
    data: {
      name: m.name || calendarName(m.calendar, ctx) || 'Meeting room',
      status: r.status,
      label: r.label,
      color: r.color,
      icon: r.icon,
      until: r.until,
      current: current ? { title: title(current), time: range(current), endsInMin: Math.max(0, Math.round((current.end - now) / 60000)) } : null,
      next: next ? { title: title(next), time: range(next), day: clock.dayLabel(next.start) } : null,
      upcoming: events
        // Not the meeting on now, nor (between meetings) the one shown as next.
        .filter((e) => e !== current && (current || e !== next) && clock.sameDay(e.start, now))
        .slice(0, m.upcoming)
        .map((e) => ({ title: title(e), time: range(e) })),
      timeline: meetingTimeline(events, m.timelineHours, title, clock),
      climate: meetingClimate(m.climate, ha)
    },
    nextChangeInSec: r.edges.length ? Math.ceil(Math.min(...r.edges) / 1000) : null
  };
}

// Which of the other rooms are free: free ones first (longest free first),
// then starting soon, then the rest. Titles are never shown here.
const FINDER_ORDER = { free: 0, occupied: 2, soon: 1, bookedEmpty: 3, busy: 4 };

function roomFinder(f, ctx) {
  const { ha } = ctx;
  const all = f.rooms.map((room) => {
    const r = roomStatus({ ...room, soonMin: f.soonMin, emptyMin: f.emptyMin, freeIcon: f.freeIcon, occupiedIcon: f.occupiedIcon, labels: f.labels }, ctx);
    const available = r.status === 'free' || r.status === 'soon';
    return {
      name: room.name || calendarName(room.calendar, ctx) || 'Room',
      status: r.status,
      available,
      label: r.label,
      color: r.color,
      icon: r.icon,
      until: r.until,
      freeForMin: r.freeForMin,
      edges: r.edges
    };
  });
  const rank = (x) => FINDER_ORDER[x.status];
  const freeFor = (x) => (x.freeForMin == null ? Infinity : x.freeForMin);
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || freeFor(b) - freeFor(a) || a.name.localeCompare(b.name));
  const shown = f.showBusy ? sorted : sorted.filter((x) => x.available);
  const edges = all.flatMap((x) => x.edges);
  return {
    data: {
      rooms: shown.map(({ edges: _e, ...x }) => x),
      available: all.filter((x) => x.available).length,
      total: all.length,
      summary: all.length === 0 ? 'No rooms set up' : `${all.filter((x) => x.available).length} of ${all.length} rooms free`
    },
    nextChangeInSec: edges.length ? Math.ceil(Math.min(...edges) / 1000) : null
  };
}

// --- Screens -------------------------------------------------------------------------------------

/**
 * inputs: { states: {entity_id: {state, attributes, last_changed}},
 *           forecasts: {daily: {weatherEntity: [..]}, hourly: {...}},
 *           calendars: {entity: [events]}, history: {entity: [points]},
 *           feeds: {url: {items: [{title, summary, link, date}], error}},
 *           now: Date, timeZone }
 * Returns {screenId: {kind, title, template, columns | data, nextChangeInSec}}.
 */
function buildScreens(layout, inputs) {
  const now = inputs.now || new Date();
  const timeZone = inputs.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const full = { forecasts: {}, calendars: {}, history: {}, feeds: {}, ...inputs, now, timeZone };
  const ctx = { ha: makeLookup(inputs.states || {}), clock: makeClock(now, timeZone), inputs: full, layout };
  const out = {};
  for (const screen of layout.screens) {
    if (screen.kind === 'meetingRoom' || screen.kind === 'roomFinder') {
      // Ahead of time: the screen as it will be `aheadMin` from now, so a
      // display that wakes that much before a meeting starts or ends (and
      // takes ~30 s to wake and redraw) has the change on the panel when it
      // happens. Its next wake is the next change less the same.
      const cfg = screen.kind === 'meetingRoom' ? screen.meeting : screen.finder;
      const aheadMs = (cfg.aheadMin || 0) * 60000;
      const sctx = aheadMs ? { ...ctx, clock: makeClock(new Date(now.getTime() + aheadMs), timeZone), realNow: now } : ctx;
      const { data, nextChangeInSec } = screen.kind === 'meetingRoom' ? meetingRoom(cfg, sctx) : roomFinder(cfg, sctx);
      out[screen.id] = { kind: screen.kind, title: screen.title, data, nextChangeInSec };
    } else {
      let liveSec = null;
      const columns = screen.columns.map((col) => {
        // Conditional sections: only the ones showing now. A calendar in the
        // same column shrinks to make room for them.
        const shown = col.filter((s) => sectionShows(s, ctx));
        const conditionalShowing = shown.some((s) => s.showWhen && s.showWhen.mode !== 'always');
        return shown.map((s) => {
          const live = s.showWhen && s.showWhen.mode !== 'always' && s.showWhen.liveMin > 0 ? s.showWhen.liveMin * 60 : null;
          if (live && (liveSec == null || live < liveSec)) liveSec = live;
          const cfg = s.type === 'calendar' && conditionalShowing && s.shrinkTo > 0 ? { ...s, lines: Math.min(s.lines, s.shrinkTo) } : s;
          const out = { id: s.id, type: s.type, title: s.title, data: BUILDERS[s.type](cfg, ctx) };
          if (s.showWhen && s.showWhen.mode !== 'always') out.conditional = true;
          return out;
        });
      });
      const wakes = [departureWake(columns, layout.thresholds.transportUrgentMin), liveSec].filter((n) => n != null);
      out[screen.id] = {
        kind: screen.kind,
        title: screen.title,
        template: screen.template,
        columns,
        // A photo behind the sections, which sit on white cards over it.
        ...(screen.background && screen.background.enabled ? { background: photoData((full.photos || {})[`bg:${screen.id}`]) } : {}),
        // A conditional section that's showing keeps the display waking
        // every few minutes while it's there (music playing), and not after.
        nextChangeInSec: wakes.length ? Math.min(...wakes) : null
      };
    }
  }
  return out;
}

// Whether a section shows now (its showWhen, lib/dashboard.js).
function sectionShows(s, { ha }) {
  const w = s.showWhen;
  if (!w || w.mode === 'always') return true;
  if (w.mode === 'playing') return (s.players || []).some((p) => ha.text(p.entity) === 'playing');
  if (w.mode === 'entity') return Boolean(w.entity) && evalCond(ha.text(w.entity), w.cond, w.value);
  return true;
}

// When a departure on this screen turns imminent (red): a battery display
// wakes then, rather than a whole refresh interval later. Null if none.
function departureWake(columns, urgentMin) {
  let soonest = null;
  for (const s of columns.flat()) {
    if (s.type !== 'transport') continue;
    for (const r of s.data.routes) {
      for (const d of r.departures) {
        if (d.minutes == null || d.minutes <= urgentMin) continue;
        const sec = (d.minutes - urgentMin) * 60;
        if (soonest == null || sec < soonest) soonest = sec;
      }
    }
  }
  return soonest;
}

// How long a display sleeps between refreshes: the layout's interval, or the
// quiet-hours one overnight (and all weekend, if set) — and never past the
// moment quiet hours start or end, so the change takes effect on time.
// `staggerSec`: with the layout on the clock, how many seconds after each
// mark this display wakes (lib/clients.js viewportStaggerFor).
function refreshPlan(layout, now, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, { staggerSec = 0 } = {}) {
  const normal = layout.refreshIntervalMin * 60;
  const q = layout.quietHours;
  const p = fmtParts(now, timeZone);
  const nightly = Boolean(q && q.enabled && q.start !== q.end);
  const weekends = Boolean(q && q.enabled && q.weekends);
  const inQuiet = (h) => (q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end);
  const quietAt = (x) => (weekends && (x.weekday === 'Sat' || x.weekday === 'Sun')) || (nightly && inQuiet(x.hour));
  const quiet = quietAt(p);
  const every = quiet ? q.intervalMin * 60 : normal;
  // Quiet hours start and end on the hour: the next hour mark at which
  // being quiet changes (within a week).
  let secsToBoundary = 0;
  if (nightly || weekends) {
    const toHour = 3600 - p.minute * 60 - p.second;
    for (let k = 0; k < 8 * 24; k++) {
      const t = toHour + k * 3600;
      if (quietAt(fmtParts(new Date(now.getTime() + t * 1000), timeZone)) !== quiet) {
        secsToBoundary = t;
        break;
      }
    }
  }
  if (layout.refreshAligned) {
    // The next mark of the interval, counted from local midnight (so 30
    // minutes is :00 and :30, an hour on the hour). Under two minutes away
    // (a display that woke a little early) it's the one after: the display
    // takes its drawing time (~30 s) off this and never sleeps under a
    // minute, so a closer mark would be missed. Never past quiet hours
    // starting or ending, which are on the hour.
    const sod = p.hour * 3600 + p.minute * 60 + p.second;
    let toMark = Math.ceil((sod + 1) / every) * every - sod;
    if (toMark + staggerSec < 120) toMark += every;
    if (secsToBoundary > 0 && secsToBoundary < toMark) toMark = secsToBoundary;
    return { quiet, interval: toMark + staggerSec };
  }
  return { quiet, interval: secsToBoundary > 0 ? Math.min(every, secsToBoundary) : every };
}

function screenEtag(screen) {
  return `"${crypto.createHash('sha1').update(JSON.stringify(screen)).digest('hex').slice(0, 20)}"`;
}

// Every icon name a layout can show (status icons and their rule icons), so
// a device can fetch them all ahead of time.
function iconsUsed(layout) {
  const names = new Set();
  for (const screen of layout.screens) {
    if (screen.icon) names.add(screen.icon);
    const m = screen.meeting || screen.finder;
    if (m) [m.freeIcon, m.occupiedIcon, MEETING_ICONS.soon, MEETING_ICONS.bookedEmpty].forEach((n) => n && names.add(n));
    for (const s of screenSections(screen)) {
      if (s.type === 'statusIcons') {
        for (const ic of s.icons) {
          if (ic.icon) names.add(ic.icon);
          for (const r of ic.rules) if (r.icon) names.add(r.icon);
        }
      }
      if (s.type === 'now') {
        for (const it of s.items) {
          if (it.icon) names.add(it.icon);
          if (it.kind === 'alarm') ['shield-check', 'shield-alert'].forEach((n) => names.add(n));
        }
      }
      for (const key of ['rooms', 'players', 'routes', 'zones']) for (const x of s[key] || []) if (x.icon) names.add(x.icon);
      if (s.type === 'bins') s.bins.forEach((b) => names.add(b.icon || 'trash-can-outline'));
      if (s.type === 'message' && s.icon) names.add(s.icon);
    }
  }
  return [...names].sort();
}

// Every entity id a layout refers to that HA's state list doesn't have (a
// typo, or an entity renamed or removed in HA) — for the Home page. Walks the
// whole layout, so every section type is covered without a list per type.
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
// The layout as a display gets it: calendar links (secret addresses: anyone
// holding one can read the calendar) left out. The display never needs them;
// the server reads the calendars.
function deviceLayout(layout) {
  const strip = (v) => {
    if (typeof v === 'string') return ical.isCalendarUrl(v) ? 'link' : v;
    if (Array.isArray(v)) return v.map(strip);
    // (A calendar section's colours are keyed by calendar.)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x], i) => [ical.isCalendarUrl(k) ? `link${i}` : k, strip(x)]));
    return v;
  };
  return strip(layout);
}

// Whether a layout refers to any Home Assistant entity at all.
function usesHomeAssistant(layout) {
  let found = false;
  const walk = (v) => {
    if (found) return;
    if (typeof v === 'string') found = ENTITY_ID.test(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(layout.screens);
  return found;
}

function missingEntities(layout, states) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (ENTITY_ID.test(v)) found.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(layout.screens);
  return [...found].filter((id) => !states[id]).sort();
}

// --- Fetching from Home Assistant ----------------------------------------------------------------

// What the layout needs beyond entity states.
function needs(layout, now, timeZone) {
  const weather = new Set();
  const calendars = new Map(); // entity -> {start, end}
  const history = new Map(); // entity -> earliest start
  const feeds = new Set(); // RSS/Atom addresses
  const clock = makeClock(now, timeZone);
  // The widest window any section wants: from now (or from midnight, for a
  // calendar of today's events) for that many days.
  const wantCal = (eid, days, fromMidnight) => {
    if (!eid) return;
    const start = fromMidnight ? clock.startOfDay(now) : now;
    // From midnight: to a local midnight (a clock-change day is 23 or 25 hours).
    const end = fromMidnight ? clock.startOfDay(new Date(start.getTime() + days * 86400000 + 12 * 3600000)) : new Date(now.getTime() + days * 86400000);
    const had = calendars.get(eid);
    calendars.set(eid, had ? { start: had.start < start ? had.start : start, end: had.end > end ? had.end : end } : { start, end });
  };
  // Every screen, switched off or not: the admin UI previews them all.
  for (const screen of layout.screens) {
    if (screen.kind === 'meetingRoom') wantCal(screen.meeting.calendar, 2);
    if (screen.kind === 'roomFinder') screen.finder.rooms.forEach((r) => wantCal(r.calendar, 1));
    for (const s of screenSections(screen)) {
      if (s.type === 'weather' && s.entity) weather.add(s.entity);
      if (s.type === 'weather' && s.hourlyEntity) weather.add(s.hourlyEntity);
      if (s.type === 'calendar') s.entities.forEach((c) => wantCal(c, s.today ? 1 : s.days, s.today));
      if (s.type === 'announcements' && s.url) feeds.add(s.url);
      if (s.type === 'bins' && s.calendar && s.bins.some((b) => !b.entity)) wantCal(s.calendar, s.days + 1, true);
      if (s.type === 'energyGraph') {
        const { start } = graphWindow(s, clock);
        for (const k of GRAPH_SERIES) {
          const e = s[k].entity;
          // An energy meter needs the reading just before the window too.
          const from = new Date(start.getTime() - (s[k].kind === 'energy' ? 3600000 : 0));
          if (e && (!history.has(e) || history.get(e) > from)) history.set(e, from);
        }
      }
    }
  }
  return { weather, calendars, history, feeds };
}

async function fetchForecast(base, entity, type) {
  const r = await haRequest(base, '/api/services/weather/get_forecasts?return_response', {
    method: 'POST',
    body: JSON.stringify({ entity_id: entity, type })
  });
  const resp = r && r.service_response && r.service_response[entity];
  return (resp && resp.forecast) || [];
}

async function fetchCalendar(base, entity, { start, end }) {
  const qs = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
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
// Every photo a layout shows, keyed as buildScreens looks them up: a photo
// section by its id, a screen's background by the screen's.
function photoRequests(layout) {
  const out = [];
  for (const screen of layout.screens) {
    if (screen.kind !== 'sections') continue;
    if (screen.background && screen.background.enabled) out.push([`bg:${screen.id}`, screen.background]);
    for (const s of screen.columns.flat()) if (s.type === 'photo') out.push([`photo:${s.id}`, s]);
  }
  return out;
}

async function fetchInputs(layout, globals, now = new Date(), { icalOpts, immichOpts } = {}) {
  const base = haBase(globals);
  // Without Home Assistant, a layout that needs none (meeting rooms on
  // calendar links, say) still works; one that refers to entities can't.
  if (!base && usesHomeAssistant(layout)) {
    const err = new Error('Home Assistant host/token not configured');
    err.code = 'NO_HA';
    throw err;
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const want = needs(layout, now, timeZone);
  const errors = {};
  const forecasts = { daily: {}, hourly: {} };
  const calendars = {};
  const calendarNames = {};
  let history = {};
  const soft = (key, p, put) =>
    p.then(put).catch((e) => {
      errors[key] = e.message;
    });
  const jobs = [base ? haRequest(base, '/api/states') : Promise.resolve([])];
  if (base) {
    for (const w of want.weather) {
      jobs.push(soft(`forecast:daily:${w}`, fetchForecast(base, w, 'daily'), (f) => (forecasts.daily[w] = f)));
      jobs.push(soft(`forecast:hourly:${w}`, fetchForecast(base, w, 'hourly'), (f) => (forecasts.hourly[w] = f)));
    }
  }
  for (const [c, range] of want.calendars) {
    if (ical.isCalendarUrl(c)) {
      // A calendar link: read (and cached) by lib/ical.js. Its address is a
      // secret, so errors are keyed by its host.
      jobs.push(
        ical.eventsFor(c, range, timeZone, icalOpts).then((r) => {
          calendars[c] = r.events;
          calendarNames[c] = r.name;
          if (r.error) errors[`calendar:${ical.linkLabel(c)}`] = r.error;
        })
      );
    } else if (base) {
      jobs.push(soft(`calendar:${c}`, fetchCalendar(base, c, range), (ev) => (calendars[c] = Array.isArray(ev) ? ev : [])));
    }
  }
  if (base && want.history.size) jobs.push(soft('history', fetchHistory(base, want.history, now), (h) => (history = h)));
  // Feeds aren't Home Assistant's: read (and cached) by lib/feeds.js.
  const feedsOut = {};
  for (const url of want.feeds) {
    jobs.push(
      feeds.itemsFor(url).then((f) => {
        feedsOut[url] = f;
        if (f.error) errors[`feed:${url}`] = f.error;
      })
    );
  }
  // Photos from Immich: never a reason the rest fails.
  const photos = {};
  for (const [key, cfg] of photoRequests(layout)) {
    jobs.push(
      immich.pick({ source: cfg.source, every: cfg.every, caption: cfg.caption, seed: key }, now, timeZone, immichOpts).then((r) => {
        photos[key] = r;
        if (r.error) errors[key] = r.error;
      })
    );
  }
  const [all] = await Promise.all(jobs);
  const states = {};
  for (const s of Array.isArray(all) ? all : []) states[s.entity_id] = s;
  // Guest networks, for a guest Wi-Fi section's QR code.
  const wifiNetworks = ((globals && globals.wifiNetworks) || []).map((n) => ({ name: n.name, password: n.password }));
  return { states, forecasts, calendars, calendarNames, history, feeds: feedsOut, wifiNetworks, photos, errors, now, timeZone };
}

module.exports = {
  evalCond,
  splitConsumption,
  statusIconLook,
  alertLine,
  stepAverage,
  buildScreens,
  sectionShows,
  meetingTimeline,
  missingEntities,
  usesHomeAssistant,
  deviceLayout,
  screenEtag,
  refreshPlan,
  iconsUsed,
  fetchInputs,
  makeClock,
  arduinoFixed,
  roundf
};
