'use strict';

// Viewports in an office: meeting rooms on calendar links (no Home
// Assistant needed), quiet weekends, and links kept off the displays.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { buildScreens, refreshPlan, fetchInputs, deviceLayout, usesHomeAssistant } = require('../lib/dashboard-state');
const ical = require('../lib/ical');

const TZ = 'Europe/London';
const LINK = 'https://outlook.office365.com/owa/calendar/abc/secret-token/calendar.ics';
const ICS = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Boardroom',
  'BEGIN:VEVENT',
  'UID:1',
  'DTSTART;TZID=GMT Standard Time:20261005T100000',
  'DTEND;TZID=GMT Standard Time:20261005T110000',
  'SUMMARY:Quarterly review',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');
const fetchImpl = async () => ({ ok: true, status: 200, text: async () => ICS });

test('quiet weekends: Saturday and Sunday quiet all day, waking on Monday morning', () => {
  const l = dashboard.normalizeLayout({ refreshIntervalMin: 15, quietHours: { enabled: true, start: 19, end: 7, intervalMin: 240, weekends: true } });
  // Friday 18:30 BST: normal, until quiet hours start at 19:00.
  assert.deepEqual(refreshPlan(l, new Date('2026-10-02T17:30:00Z'), TZ), { quiet: false, interval: 15 * 60 });
  assert.deepEqual(refreshPlan(l, new Date('2026-10-02T17:50:00Z'), TZ), { quiet: false, interval: 10 * 60 });
  // Saturday noon: quiet, every four hours.
  assert.deepEqual(refreshPlan(l, new Date('2026-10-03T11:00:00Z'), TZ), { quiet: true, interval: 4 * 3600 });
  // Sunday 23:00: quiet straight through the night until 07:00 Monday.
  assert.deepEqual(refreshPlan(l, new Date('2026-10-04T22:00:00Z'), TZ), { quiet: true, interval: 4 * 3600 });
  assert.deepEqual(refreshPlan(l, new Date('2026-10-05T04:00:00Z'), TZ), { quiet: true, interval: 2 * 3600 }); // 05:00, to 07:00
  // Off: Saturday noon is an ordinary day.
  l.quietHours.weekends = false;
  assert.deepEqual(refreshPlan(l, new Date('2026-10-03T11:00:00Z'), TZ), { quiet: false, interval: 15 * 60 });
});

test('a meeting room on a calendar link: no Home Assistant needed, named from the calendar', async () => {
  ical.clearCache();
  const l = dashboard.normalizeLayout({ screens: [{ id: 'room', kind: 'meetingRoom', meeting: { calendar: LINK, aheadMin: 0 } }] });
  assert.equal(usesHomeAssistant(l), false);
  const now = new Date('2026-10-05T09:30:00Z'); // 10:30 BST
  const inputs = await fetchInputs(l, {}, now, { icalOpts: { fetchImpl } });
  const room = buildScreens(l, { ...inputs, timeZone: TZ }).room.data;
  assert.equal(room.name, 'Boardroom');
  assert.equal(room.status, 'busy');
  assert.deepEqual(room.current, { title: 'Quarterly review', time: '10:00–11:00', endsInMin: 30 });
  // A layout with Home Assistant entities still needs it.
  const kitchen = dashboard.defaultLayout();
  assert.equal(usesHomeAssistant(kitchen), true);
  await assert.rejects(fetchInputs(kitchen, {}, now), (e) => e.code === 'NO_HA');
});

test('a display never gets a calendar link: the server reads the calendars', () => {
  const l = dashboard.normalizeLayout({
    screens: [
      { id: 'room', kind: 'meetingRoom', meeting: { calendar: LINK, name: 'Boardroom' } },
      { id: 'rooms', kind: 'roomFinder', finder: { rooms: [{ name: 'Focus', calendar: `webcal://p01-caldav.icloud.com/published/2/xyz` }] } },
      { id: 'home', template: 'single', columns: [[{ type: 'calendar', entities: [LINK, 'calendar.team'], colors: { [LINK]: 2, 'calendar.team': 5 } }]] }
    ]
  });
  const out = JSON.stringify(deviceLayout(l));
  assert.ok(!out.includes('secret-token') && !out.includes('xyz'));
  assert.ok(out.includes('calendar.team'));
});
