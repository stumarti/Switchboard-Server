'use strict';

/**
 * Calendar links: an iCalendar (.ics) address that a calendar app publishes —
 * Google Calendar's "secret address in iCal format", Outlook / Microsoft
 * 365's published calendar, an iCloud public calendar (webcal://), Fastmail,
 * Proton, Zoho, Nextcloud — read on the server, so a meeting-room sign or a
 * calendar section needs no Home Assistant calendar in between.
 *
 * Events come out in Home Assistant's own shape ({summary, description,
 * start: {dateTime} | {date}, end}), so everything downstream treats both
 * sources alike.
 *
 * No library: VEVENTs are read with a small parser, and recurring meetings
 * expanded here — RRULE (DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL,
 * COUNT, UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, BYSETPOS), RDATE,
 * EXDATE, and occurrences moved or cancelled (RECURRENCE-ID). Times are in
 * the event's TZID: an IANA zone, or one of Windows' names as Outlook and
 * Exchange write them ("GMT Standard Time"); anything else falls back to the
 * calendar's X-WR-TIMEZONE, then the house's.
 *
 * Each address is cached for CACHE_MS and read at most once at a time; a
 * failure keeps the last good copy and isn't retried for RETRY_MS.
 */

const CACHE_MS = 2 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 10000;
const MAX_BYTES = 10 * 1024 * 1024;
// Occurrences of one recurring event looked at, at most (a daily meeting
// for 15 years); and how many periods to step through to find them.
const MAX_OCCURRENCES = 5000;
const MAX_PERIODS = 20000;

const cache = new Map(); // url -> { at, cal, failedAt, error, pending }

// --- Addresses ---------------------------------------------------------------------

// A calendar link rather than a Home Assistant entity id.
function isCalendarUrl(v) {
  return /^(webcal|webcals|https?):\/\//i.test(String(v || '').trim());
}

// webcal:// is https:// to fetch (http:// stays as it is).
function fetchableUrl(v) {
  return String(v || '')
    .trim()
    .replace(/^webcals?:\/\//i, 'https://');
}

// What to show for a link with no name: its host, never the secret path.
function linkLabel(v) {
  try {
    return new URL(fetchableUrl(v)).host;
  } catch {
    return 'Calendar link';
  }
}

// --- Parsing -----------------------------------------------------------------------

function unescapeText(v) {
  return String(v).replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// "DTSTART;TZID="W. Europe Standard Time":20261005T090000" ->
// {name: 'DTSTART', params: {TZID: 'W. Europe Standard Time'}, value: '20261005T090000'}
function parseLine(line) {
  let i = 0;
  let inQuote = false;
  let colon = -1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [];
  const name = (parts.shift() || '').toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// A DATE or DATE-TIME value: {y, mo, d, h, mi, s, utc, isDate, tzid}.
function parseWhen(prop) {
  if (!prop) return null;
  const v = String(prop.value).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!m) return null;
  const isDate = !m[4] || prop.params.VALUE === 'DATE';
  return {
    y: +m[1],
    mo: +m[2],
    d: +m[3],
    h: isDate ? 0 : +m[4],
    mi: isDate ? 0 : +m[5],
    s: isDate ? 0 : +(m[6] || 0),
    utc: Boolean(m[7]),
    isDate,
    tzid: prop.params.TZID || ''
  };
}

// A comma-separated EXDATE / RDATE value, one parseWhen each.
function parseWhenList(prop) {
  return String(prop.value)
    .split(',')
    .map((value) => parseWhen({ params: prop.params, value }))
    .filter(Boolean);
}

// "PT1H30M", "P1D", "-PT15M" -> milliseconds.
function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRrule(v) {
  const r = {};
  for (const part of String(v || '').split(';')) {
    const [k, val] = part.split('=');
    if (k && val != null) r[k.toUpperCase()] = val;
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.FREQ)) return null;
  const nums = (s) => (s ? s.split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0) : []);
  return {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: r.COUNT ? Math.max(0, parseInt(r.COUNT, 10) || 0) : null,
    until: r.UNTIL ? parseWhen({ params: {}, value: r.UNTIL }) : null,
    byDay: (r.BYDAY ? r.BYDAY.split(',') : [])
      .map((x) => x.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i))
      .filter(Boolean)
      .map((x) => ({ n: x[1] ? parseInt(x[1], 10) : 0, wd: WEEKDAYS.indexOf(x[2].toUpperCase()) })),
    byMonthDay: nums(r.BYMONTHDAY),
    byMonth: nums(r.BYMONTH).filter((n) => n >= 1 && n <= 12),
    bySetPos: nums(r.BYSETPOS),
    wkst: Math.max(0, WEEKDAYS.indexOf(String(r.WKST || 'MO').toUpperCase()))
  };
}

/**
 * The calendar in an .ics document: {name, timeZone, events}. Each event
 * keeps its raw parts for expand().
 */
function parseCalendar(text) {
  const lines = String(text || '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  const cal = { name: '', timeZone: '', events: [] };
  let ev = null;
  const depth = [];
  for (const raw of lines) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      depth.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === 'VEVENT') ev = { exdates: [], rdates: [] };
      continue;
    }
    if (p.name === 'END') {
      const what = depth.pop();
      if (what === 'VEVENT' && ev) {
        if (ev.dtstart) cal.events.push(ev);
        ev = null;
      }
      continue;
    }
    const inside = depth[depth.length - 1];
    if (inside === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') cal.name = unescapeText(p.value).trim();
      if (p.name === 'X-WR-TIMEZONE') cal.timeZone = p.value.trim();
      continue;
    }
    // Only the event's own properties, not those of an alarm inside it.
    if (inside !== 'VEVENT' || !ev) continue;
    switch (p.name) {
      case 'UID':
        ev.uid = p.value.trim();
        break;
      case 'SUMMARY':
        ev.summary = unescapeText(p.value).trim();
        break;
      case 'DESCRIPTION':
        ev.description = unescapeText(p.value).trim();
        break;
      case 'LOCATION':
        ev.location = unescapeText(p.value).trim();
        break;
      case 'STATUS':
        ev.status = p.value.trim().toUpperCase();
        break;
      case 'DTSTART':
        ev.dtstart = parseWhen(p);
        break;
      case 'DTEND':
        ev.dtend = parseWhen(p);
        break;
      case 'DURATION':
        ev.duration = parseDuration(p.value);
        break;
      case 'RRULE':
        ev.rrule = parseRrule(p.value);
        break;
      case 'EXDATE':
        ev.exdates.push(...parseWhenList(p));
        break;
      case 'RDATE':
        if (p.params.VALUE !== 'PERIOD') ev.rdates.push(...parseWhenList(p));
        break;
      case 'RECURRENCE-ID':
        ev.recurrenceId = parseWhen(p);
        break;
      default:
    }
  }
  return cal;
}

// --- Time zones --------------------------------------------------------------------

// Windows' zone names (Outlook, Exchange, Microsoft 365) as IANA zones.
const WINDOWS_ZONES = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'SA Pacific Standard Time': 'America/Bogota',
  'SA Eastern Standard Time': 'America/Cayenne',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Pacific SA Standard Time': 'America/Santiago',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Tasmania Standard Time': 'Australia/Hobart',
  'New Zealand Standard Time': 'Pacific/Auckland'
};

function validZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The IANA zone for an event's TZID, else the calendar's, else the house's.
function zoneFor(tzid, cal, houseZone) {
  const id = String(tzid || '').replace(/^\/+/, '');
  if (validZone(id)) return id;
  if (WINDOWS_ZONES[id]) return WINDOWS_ZONES[id];
  // "(UTC+01:00) Amsterdam, Berlin, ..." style names: the city after the offset.
  const city = id.match(/\)\s*([A-Za-z ]+)/);
  if (city) {
    const guess = Object.values(WINDOWS_ZONES).find((z) => z.endsWith(`/${city[1].trim().replace(/ /g, '_')}`));
    if (guess) return guess;
  }
  if (validZone(cal && cal.timeZone)) return cal.timeZone;
  return houseZone;
}

// The instant a wall-clock time in `timeZone` names.
function wallInstant(f, timeZone) {
  const want = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, Number(x.value)])
    );
    const diff = want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

function instantOf(w, zone) {
  if (w.utc) return new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s));
  return wallInstant(w, zone);
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (w) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;

// --- Recurrence --------------------------------------------------------------------

// Calendar arithmetic on whole days (no time zone involved).
const dayNum = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
function fromDayNum(n) {
  const dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const weekdayOf = (n) => new Date(n * 86400000).getUTCDay();
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// The days of one month a MONTHLY (or YEARLY-by-month) rule picks.
function monthDays(y, mo, r, startDay) {
  const dim = daysInMonth(y, mo);
  const first = dayNum(y, mo, 1);
  let days;
  if (r.byMonthDay.length) {
    days = r.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim).map((d) => first + d - 1);
  } else if (r.byDay.length) {
    days = [];
    for (const { n, wd } of r.byDay) {
      const all = [];
      for (let d = 0; d < dim; d++) if (weekdayOf(first + d) === wd) all.push(first + d);
      if (!n) days.push(...all);
      else if (n > 0 && all[n - 1] != null) days.push(all[n - 1]);
      else if (n < 0 && all[all.length + n] != null) days.push(all[all.length + n]);
    }
  } else {
    days = startDay <= dim ? [first + startDay - 1] : [];
  }
  // BYMONTHDAY and BYDAY together: days that are both.
  if (r.byMonthDay.length && r.byDay.length) days = days.filter((n) => r.byDay.some((b) => !b.n && b.wd === weekdayOf(n)));
  return [...new Set(days)].sort((a, b) => a - b);
}

function setPos(days, positions) {
  if (!positions.length) return days;
  const out = positions.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((n) => n != null);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The day numbers a rule produces from `start` (a day number) onwards, in
 * order, through `lastDay` — at most MAX_OCCURRENCES of them, honouring
 * COUNT and UNTIL (`untilDay`, inclusive).
 */
function ruleDays(r, start, firstDay, lastDay, untilDay) {
  const s = fromDayNum(start);
  const out = [];
  let produced = 0;
  const take = (n) => {
    if (n < start) return true;
    if (untilDay != null && n > untilDay) return false;
    if (r.count != null && produced >= r.count) return false;
    produced++;
    if (n >= firstDay && n <= lastDay) out.push(n);
    return n <= lastDay && out.length < MAX_OCCURRENCES;
  };
  const inMonths = (n) => !r.byMonth.length || r.byMonth.includes(fromDayNum(n).mo);
  // Without a COUNT nothing before the window matters: start a period or so
  // before it (a daily meeting since 2010 needn't be walked from 2010).
  let p0 = 0;
  if (r.count == null && firstDay > start) {
    const f = fromDayNum(firstDay);
    const span = { DAILY: firstDay - start, WEEKLY: Math.floor((firstDay - start) / 7), MONTHLY: (f.y - s.y) * 12 + (f.mo - s.mo), YEARLY: f.y - s.y }[r.freq];
    p0 = Math.max(0, Math.floor(span / r.interval) - 1);
  }
  for (let p = p0; p < p0 + MAX_PERIODS; p++) {
    let days;
    let anchor; // the period's first day
    if (r.freq === 'DAILY') {
      const n = start + p * r.interval;
      anchor = n;
      const okDay = !r.byDay.length || r.byDay.some((b) => b.wd === weekdayOf(n));
      const okMonthDay = !r.byMonthDay.length || monthDays(fromDayNum(n).y, fromDayNum(n).mo, { ...r, byDay: [] }, 0).includes(n);
      days = okDay && okMonthDay && inMonths(n) ? [n] : [];
    } else if (r.freq === 'WEEKLY') {
      const weekStart = start - ((weekdayOf(start) - r.wkst + 7) % 7) + p * 7 * r.interval;
      anchor = weekStart;
      const wds = r.byDay.length ? r.byDay.map((b) => b.wd) : [weekdayOf(start)];
      days = [];
      for (let i = 0; i < 7; i++) if (wds.includes(weekdayOf(weekStart + i))) days.push(weekStart + i);
      days = setPos(days.filter(inMonths), r.bySetPos);
    } else if (r.freq === 'MONTHLY') {
      const mIndex = s.y * 12 + (s.mo - 1) + p * r.interval;
      const y = Math.floor(mIndex / 12);
      const mo = (mIndex % 12) + 1;
      anchor = dayNum(y, mo, 1);
      days = r.byMonth.length && !r.byMonth.includes(mo) ? [] : setPos(monthDays(y, mo, r, s.d), r.bySetPos);
    } else {
      const y = s.y + p * r.interval;
      anchor = dayNum(y, 1, 1);
      const months = r.byMonth.length ? r.byMonth : [s.mo];
      days = [];
      for (const mo of months) {
        const rr = !r.byMonthDay.length && !r.byDay.length ? { ...r, byMonthDay: [s.d] } : r;
        days.push(...monthDays(y, mo, rr, s.d));
      }
      days = setPos([...new Set(days)].sort((a, b) => a - b), r.bySetPos);
    }
    // Past the window (or the rule's end): nothing more to find.
    if (anchor > lastDay || (untilDay != null && anchor > untilDay)) break;
    for (const n of days) if (!take(n)) return out;
  }
  return out;
}

/**
 * Every occurrence of the calendar's events that overlaps [from, to), in
 * Home Assistant's event shape, soonest first.
 */
function expand(cal, from, to, houseZone) {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out = [];
  // Moved or cancelled occurrences of a recurring event, by UID and the
  // occurrence's original start.
  const overrides = new Map();
  for (const ev of cal.events) {
    if (!ev.recurrenceId || !ev.uid) continue;
    const zone = zoneFor(ev.recurrenceId.tzid || ev.dtstart.tzid, cal, houseZone);
    const key = ev.recurrenceId.isDate ? dateKey(ev.recurrenceId) : instantOf(ev.recurrenceId, zone).getTime();
    overrides.set(`${ev.uid}\u0000${key}`, ev);
  }

  const emit = (ev, start, end, isDate) => {
    if (ev.status === 'CANCELLED') return;
    if (end.getTime() <= fromMs || start.getTime() >= toMs) {
      // An all-day event still counts on its day.
      if (!(isDate && end.getTime() === start.getTime() && start.getTime() >= fromMs && start.getTime() < toMs)) return;
    }
    const fmt = (d) => (isDate ? { date: d.toISOString().slice(0, 10) } : { dateTime: d.toISOString() });
    out.push({ summary: ev.summary || '', description: ev.description || '', location: ev.location || '', start: fmt(start), end: fmt(end) });
  };

  for (const ev of cal.events) {
    const zone = zoneFor(ev.dtstart.tzid, cal, houseZone);
    const isDate = ev.dtstart.isDate;
    // All-day dates stay dates: their own midnights, as UTC (the house's
    // midnight is applied downstream, as for Home Assistant's).
    const startOf = (w) => (isDate ? new Date(Date.UTC(w.y, w.mo - 1, w.d)) : instantOf(w, zone));
    const start0 = startOf(ev.dtstart);
    let durMs;
    if (ev.dtend) durMs = (ev.dtend.isDate ? new Date(Date.UTC(ev.dtend.y, ev.dtend.mo - 1, ev.dtend.d)) : instantOf(ev.dtend, zoneFor(ev.dtend.tzid || ev.dtstart.tzid, cal, houseZone))).getTime() - start0.getTime();
    else if (ev.duration != null) durMs = ev.duration;
    else durMs = isDate ? 86400000 : 0;
    durMs = Math.max(0, durMs);

    // An override is emitted as itself (below), not as a rule's occurrence.
    if (ev.recurrenceId) {
      emit(ev, start0, new Date(start0.getTime() + durMs), isDate);
      continue;
    }
    if (!ev.rrule && !ev.rdates.length) {
      emit(ev, start0, new Date(start0.getTime() + durMs), isDate);
      continue;
    }

    // Occurrence starts as wall-clock fields (the event's time of day on
    // each day the rule picks), each turned into an instant in its zone.
    const t = ev.dtstart;
    const occurrences = [];
    if (ev.rrule) {
      const r = ev.rrule;
      let untilDay = null;
      if (r.until) {
        const u = r.until;
        // UNTIL in UTC (or a date): the last day whose occurrence starts by then.
        if (u.isDate) untilDay = dayNum(u.y, u.mo, u.d);
        else {
          const uMs = instantOf(u, zone).getTime();
          const local = new Date(uMs);
          untilDay = dayNum(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate()) + 1;
          r.untilMs = uMs;
        }
      }
      // Far enough past the window for any occurrence that could overlap it.
      const lastDay = Math.floor((toMs + 86400000) / 86400000) + 1;
      // From a day before the window (an occurrence that began the evening
      // before still overlaps it).
      const firstDay = Math.floor(fromMs / 86400000) - 1 - Math.ceil(durMs / 86400000);
      for (const n of ruleDays(r, dayNum(t.y, t.mo, t.d), firstDay, lastDay, untilDay)) {
        const d = fromDayNum(n);
        const w = { ...t, y: d.y, mo: d.mo, d: d.d };
        const at = startOf(w);
        if (r.untilMs != null && at.getTime() > r.untilMs) continue;
        occurrences.push({ w, at });
      }
    } else {
      occurrences.push({ w: t, at: start0 });
    }
    for (const rd of ev.rdates) occurrences.push({ w: rd, at: rd.isDate ? new Date(Date.UTC(rd.y, rd.mo - 1, rd.d)) : instantOf(rd, zoneFor(rd.tzid || t.tzid, cal, houseZone)) });

    const excluded = new Set(
      ev.exdates.map((x) => (isDate || x.isDate ? dateKey(x) : instantOf(x, zoneFor(x.tzid || t.tzid, cal, houseZone)).getTime()))
    );
    const seen = new Set();
    for (const { w, at } of occurrences) {
      const key = isDate ? dateKey(w) : at.getTime();
      if (seen.has(key)) continue;
      seen.add(key);
      // EXDATE by date matches any occurrence on that day.
      if (excluded.has(key) || excluded.has(dateKey(w))) continue;
      if (ev.uid && overrides.has(`${ev.uid}\u0000${key}`)) continue;
      if (at.getTime() >= toMs) continue;
      emit(ev, at, new Date(at.getTime() + durMs), isDate);
    }
  }
  const startMs = (e) => Date.parse(e.start.dateTime || `${e.start.date}T00:00:00Z`);
  return out.sort((a, b) => startMs(a) - startMs(b) || a.summary.localeCompare(b.summary));
}

// --- Fetching ----------------------------------------------------------------------

async function download(url, fetchImpl = fetch) {
  const u = new URL(fetchableUrl(url));
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('a calendar link must start with https://, http:// or webcal://');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(u.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'Switchboard' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('the calendar is too large');
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error("that link isn't an iCal (.ics) calendar");
    return body;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'the calendar took too long to answer' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function refresh(url, { fetchImpl } = {}) {
  const entry = cache.get(url) || { at: 0, cal: null, failedAt: 0, error: '', pending: null };
  cache.set(url, entry);
  if (entry.pending) return entry.pending;
  entry.pending = download(url, fetchImpl)
    .then((text) => {
      entry.cal = parseCalendar(text);
      entry.at = Date.now();
      entry.error = '';
      return entry;
    })
    .catch((e) => {
      entry.failedAt = Date.now();
      entry.error = e.message;
      return entry;
    })
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

/**
 * A calendar link's events in [start, end): {events, name, error}. Read
 * from the cache while it's fresh; a failed read keeps the last good copy.
 */
async function eventsFor(url, { start, end }, houseZone, opts = {}) {
  const now = Date.now();
  const entry = cache.get(url);
  const stale = !entry || now - entry.at > CACHE_MS;
  const backingOff = entry && entry.failedAt && now - entry.failedAt < RETRY_MS && entry.failedAt > entry.at;
  const e = stale && !backingOff ? await refresh(url, opts) : entry;
  if (!e.cal) return { events: [], name: '', error: e.error || 'not read yet' };
  return { events: expand(e.cal, start, end, houseZone), name: e.cal.name, error: e.error };
}

function clearCache() {
  cache.clear();
}

module.exports = { isCalendarUrl, fetchableUrl, linkLabel, parseCalendar, expand, eventsFor, refresh, clearCache, WINDOWS_ZONES };
