'use strict';

/**
 * Setting up many meeting-room signs at once: a list of rooms (pasted from a
 * spreadsheet, one per line) becomes a viewport layout per room, each sign's
 * "Other rooms" screen listing the rest, and — where a line gives the
 * display's MAC address — the display named, given its layout and, if asked,
 * approved, whether it has connected yet or not.
 *
 * A line is a room's name, then (in any order) its calendar (a calendar link
 * or a Home Assistant calendar), an occupancy sensor, and the display's MAC:
 *
 *   Boardroom, https://outlook.office365.com/owa/calendar/…/calendar.ics, AA:BB:CC:00:01:01
 *   Focus	calendar.focus	binary_sensor.focus_occupied
 *
 * Commas, semicolons or tabs between them; a header row is skipped.
 */

const dashboard = require('./dashboard');
const ical = require('./ical');
const store = require('./store');

const MAX_ROOMS = 100;
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i;

// One line's cells: tab-separated (a spreadsheet paste), else comma or
// semicolon, with "quoted" cells as CSV has them.
function cells(line) {
  const sep = line.includes('\t') ? '\t' : /;/.test(line) && !/,/.test(line) ? ';' : ',';
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === sep && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function macOf(v) {
  const hex = String(v).replace(/[^0-9a-f]/gi, '');
  return hex.length === 12 ? hex.match(/../g).join(':').toLowerCase() : '';
}

/** The rooms in a pasted list: [{line, name, calendar, occupancy, mac, problems}]. */
function parseRoomList(text) {
  const rooms = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [name, ...rest] = cells(line);
    // A header row ("Room, Calendar, ...").
    if (!rooms.length && /^(room|name|room name)$/i.test(name) && rest.some((c) => /calendar|mac|display|occupancy/i.test(c))) return;
    const room = { line: i + 1, name: name.replace(/^"|"$/g, '').trim(), calendar: '', occupancy: '', mac: '', problems: [] };
    for (const c of rest) {
      if (!c) continue;
      if (ical.isCalendarUrl(c) || /^calendar\.[a-z0-9_]+$/.test(c)) room.calendar ||= c;
      else if (MAC.test(c)) room.mac ||= macOf(c);
      else if (/^[a-z_]+\.[a-z0-9_]+$/.test(c)) room.occupancy ||= c;
      else room.problems.push(`“${c.length > 40 ? `${c.slice(0, 40)}…` : c}” isn't a calendar, a sensor or a MAC address`);
    }
    if (!room.name) room.problems.push('no room name');
    if (!room.calendar) room.problems.push('no calendar');
    rooms.push(room);
  });
  // The same name or MAC twice.
  const seen = { name: new Map(), mac: new Map() };
  for (const r of rooms) {
    for (const k of ['name', 'mac']) {
      const v = k === 'name' ? r.name.toLowerCase() : r.mac;
      if (!v) continue;
      if (seen[k].has(v)) r.problems.push(`same ${k === 'name' ? 'name' : 'MAC'} as line ${seen[k].get(v)}`);
      else seen[k].set(v, r.line);
    }
  }
  return rooms.slice(0, MAX_ROOMS);
}

// What an office sign starts with: wakes on the half hour (each a few
// seconds apart), quiet from 7 pm to 7 am and all weekend, every 4 hours.
function officeSettings(s = {}) {
  return {
    refreshIntervalMin: s.refreshIntervalMin ?? 30,
    refreshAligned: s.refreshAligned ?? true,
    quietHours: { enabled: true, start: 19, end: 7, intervalMin: 240, weekends: true, ...(s.quietHours || {}) },
    aheadMin: s.aheadMin ?? 2
  };
}

/**
 * Each room's sign as a layout: the room, then the other rooms (up to the
 * finder's limit, the nearest in the list first).
 */
function roomLayout(room, all, settings, withFinder) {
  const base = dashboard.meetingRoomLayout();
  const others = all.filter((r) => r !== room);
  // The rooms either side of it in the list first (usually its neighbours).
  const i = all.indexOf(room);
  others.sort((a, b) => Math.abs(all.indexOf(a) - i) - Math.abs(all.indexOf(b) - i));
  const screens = base.screens
    .map((sc) => {
      if (sc.kind === 'meetingRoom') return { ...sc, title: room.name, meeting: { ...sc.meeting, name: room.name, calendar: room.calendar, occupancy: room.occupancy, aheadMin: settings.aheadMin } };
      if (sc.kind === 'roomFinder') {
        if (!withFinder || !others.length) return null;
        return { ...sc, finder: { ...sc.finder, aheadMin: settings.aheadMin, rooms: others.slice(0, 12).map((r) => ({ name: r.name, calendar: r.calendar, occupancy: r.occupancy })) } };
      }
      return sc;
    })
    .filter(Boolean);
  return dashboard.normalizeLayout({ ...base, refreshIntervalMin: settings.refreshIntervalMin, refreshAligned: settings.refreshAligned, quietHours: settings.quietHours, screens });
}

/**
 * Create (or update, by name) a sign per room, and set up the displays the
 * list names. `approve`: approve those displays now, even before they first
 * connect (they then start at once). Returns a line per room.
 */
function apply(rooms, { finder = true, approve = false, settings } = {}, pairing) {
  const ok = rooms.filter((r) => !r.problems || !r.problems.length);
  const conf = officeSettings(settings);
  const existing = new Map(store.listDashboards().map((d) => [d.name.trim().toLowerCase(), d]));
  const now = new Date().toISOString();
  return ok.map((room) => {
    const layout = roomLayout(room, ok, conf, finder);
    const had = existing.get(room.name.toLowerCase());
    let slug;
    if (had) {
      slug = had.slug;
      // Keep any other screens the layout has; replace the room's own.
      const prev = dashboard.normalizeLayout(had.layout);
      const keep = prev.screens.filter((sc) => sc.kind === 'sections');
      store.saveDashboard(slug, { ...had, layout: { ...layout, screens: [...layout.screens, ...keep] }, updatedAt: now });
    } else {
      slug = store.newDashboardSlug(room.name);
      store.saveDashboard(slug, { name: room.name, createdAt: now, updatedAt: now, layout });
    }
    let display = '';
    if (room.mac) display = pairing.expect(room.mac, { name: `${room.name} sign`, dashboard: slug, approve });
    return { name: room.name, slug, layout: had ? 'updated' : 'created', display };
  });
}

module.exports = { parseRoomList, apply, roomLayout, officeSettings, cells };
