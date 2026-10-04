'use strict';

// Many meeting-room signs at once: a pasted room list -> a layout per room,
// each listing the others, and the displays named, assigned and (if asked)
// approved before they first connect.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rooms-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const pairing = require('../lib/pairing');
const meetingRooms = require('../lib/meeting-rooms');
const { deviceLayout } = require('../lib/dashboard-state');

const LIST = `Room, Calendar, Occupancy, Display
Boardroom, https://outlook.office365.com/owa/calendar/abc/s1/calendar.ics, binary_sensor.boardroom_occupied, aa:bb:cc:00:01:01
"Focus, 2nd floor",webcal://p01-caldav.icloud.com/published/2/xyz,AABBCC000102
Huddle\tcalendar.huddle
Kitchen table, nothing here
`;

test('a pasted list: commas, quotes, tabs, any order, and what is wrong with a line', () => {
  const rooms = meetingRooms.parseRoomList(LIST);
  assert.deepEqual(
    rooms.map((r) => [r.name, r.calendar.slice(0, 20), r.occupancy, r.mac, r.problems.length]),
    [
      ['Boardroom', 'https://outlook.offi', 'binary_sensor.boardroom_occupied', 'aa:bb:cc:00:01:01', 0],
      ['Focus, 2nd floor', 'webcal://p01-caldav.', '', 'aa:bb:cc:00:01:02', 0],
      ['Huddle', 'calendar.huddle', '', '', 0],
      ['Kitchen table', '', '', '', 2]
    ]
  );
  assert.match(rooms[3].problems.join(' '), /isn't a calendar.*no calendar/);
  assert.match(meetingRooms.parseRoomList('A, calendar.a\na, calendar.b')[1].problems[0], /same name as line 1/);
});

test('a sign per room, each listing the others, office hours, and the displays set up', () => {
  const rooms = meetingRooms.parseRoomList(LIST);
  // One display has already asked to pair; the other hasn't been seen yet.
  pairing.register('aa:bb:cc:00:01:01', '10.0.0.5', 'viewport');
  const results = meetingRooms.apply(rooms, { approve: true }, pairing);
  assert.deepEqual(
    results.map((r) => [r.name, r.layout, r.display]),
    [
      ['Boardroom', 'created', 'approved'],
      ['Focus, 2nd floor', 'created', 'approved, not connected yet'],
      ['Huddle', 'created', '']
    ]
  );
  const board = store.getDashboard(results[0].slug);
  const [room, others] = board.layout.screens;
  assert.deepEqual([room.meeting.name, room.meeting.occupancy, room.meeting.aheadMin], ['Boardroom', 'binary_sensor.boardroom_occupied', 2]);
  assert.deepEqual(others.finder.rooms.map((r) => r.name), ['Focus, 2nd floor', 'Huddle']);
  assert.deepEqual(board.layout.quietHours, { enabled: true, start: 19, end: 7, intervalMin: 240, weekends: true });
  assert.equal(board.layout.refreshAligned, true);
  // The displays: named, assigned, approved.
  const devices = store.getDevices();
  assert.deepEqual(['status', 'type', 'name', 'dashboard'].map((k) => devices['aa:bb:cc:00:01:01'][k]), ['approved', 'viewport', 'Boardroom sign', results[0].slug]);
  const ahead = devices['aa:bb:cc:00:01:02'];
  assert.deepEqual([ahead.status, ahead.expected, ahead.lastSeenAt], ['approved', true, '']);
  // ...and the one not seen yet gets its token the moment it first asks.
  const first = pairing.register('aa:bb:cc:00:01:02', '10.0.0.6', 'viewport');
  assert.equal(first.status, 'approved');
  assert.ok(first.token);
  assert.ok(store.getDevices()['aa:bb:cc:00:01:02'].firstSeenAt);
  // Its layout never carries the calendar links.
  assert.ok(!JSON.stringify(deviceLayout(board.layout)).includes('/s1/'));
});

test('run again with a changed list: updated by name, not duplicated', () => {
  const before = store.listDashboards().length;
  const results = meetingRooms.apply(meetingRooms.parseRoomList('Huddle, calendar.huddle_new'), {}, pairing);
  assert.deepEqual(results.map((r) => r.layout), ['updated']);
  assert.equal(store.listDashboards().length, before);
  const huddle = store.listDashboards().find((d) => d.name === 'Huddle');
  assert.equal(store.getDashboard(huddle.slug).layout.screens[0].meeting.calendar, 'calendar.huddle_new');
});
