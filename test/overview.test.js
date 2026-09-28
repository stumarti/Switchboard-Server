'use strict';

// node --test: the admin Home page — what needs attention, and the Home
// Assistant request monitor behind it.

const test = require('node:test');
const assert = require('node:assert/strict');
const overview = require('../lib/overview');
const haMonitor = require('../lib/ha-monitor');

const NOW = Date.parse('2026-09-28T12:00:00Z');
const minAgo = (m) => new Date(NOW - m * 60000).toISOString();
const dev = (x) => ({ status: 'approved', type: 'remote', assignedSlug: 'kitchen', lastSeenAt: minAgo(5), health: {}, ...x });

test('overview: pending, batteries, offline, weak Wi-Fi and unassigned devices, worst first', () => {
  const o = overview.build({
    now: NOW,
    rooms: { kitchen: 'Kitchen' },
    layouts: { door: 'Boardroom door' },
    ha: { reachable: true, lastHour: { ok: 40, errors: 0, avgMs: 30 }, entityIssues: [] },
    devices: [
      dev({ mac: 'a', name: 'Kitchen remote', health: { battery: 8, rssi: -62, firmware: '1.4.0', at: minAgo(5) } }),
      dev({ mac: 'b', name: 'Lounge remote', health: { battery: 18, rssi: -84, firmware: '1.3.2', at: minAgo(5) } }),
      dev({ mac: 'c', name: 'Old remote', lastSeenAt: minAgo(60 * 30), health: { battery: 50, at: minAgo(60 * 30) } }),
      dev({ mac: 'd', name: 'Door sign', type: 'viewport', dashboard: 'door', refreshMin: 15, lastSeenAt: minAgo(70) }),
      dev({ mac: 'e', name: 'e', status: 'pending', assignedSlug: '' }),
      dev({ mac: 'f', name: 'Spare', assignedSlug: '' })
    ]
  });
  const titles = o.attention.map((a) => `${a.level}:${a.kind}:${a.title}`);
  assert.deepEqual(titles, [
    'critical:battery:Kitchen remote: battery 8%',
    'warn:battery:Lounge remote: battery 18%',
    'warn:offline:Old remote hasn’t been heard from',
    'warn:offline:Door sign hasn’t been heard from', // 70 min > max(3 x 15, 60)
    'warn:pending:e is waiting for approval',
    'info:wifi:Lounge remote: weak Wi-Fi (-84 dBm)',
    'info:unassigned:Spare has no room',
    'info:firmware:Remotes run 2 firmware versions'
  ]);
  // A day-old battery reading isn't shown as now.
  assert.equal(o.devices.find((d) => d.mac === 'c').battery, null);
  assert.equal(o.devices.find((d) => d.mac === 'd').assignedTo, 'Boardroom door');
  assert.deepEqual(
    { remotes: o.counts.remotes, remotesOnline: o.counts.remotesOnline, viewports: o.counts.viewports, pending: o.counts.pending, lowBattery: o.counts.lowBattery, critical: o.counts.critical },
    { remotes: 4, remotesOnline: 3, viewports: 1, pending: 1, lowBattery: 2, critical: 1 }
  );
});

test('overview: Home Assistant not set up, down, flaky, and entities it doesn’t have', () => {
  const kinds = (o) => o.attention.map((a) => `${a.level}:${a.title}`);
  assert.deepEqual(kinds(overview.build({ now: NOW, haConfigured: false })), ['critical:Home Assistant isn’t set up']);
  assert.deepEqual(kinds(overview.build({ now: NOW, ha: { reachable: false, lastError: 'fetch failed (ECONNREFUSED)', lastOkAt: minAgo(90) } })), [
    'critical:Can’t reach Home Assistant'
  ]);
  const flaky = overview.build({
    now: NOW,
    rooms: { kitchen: 'Kitchen' },
    ha: {
      reachable: true,
      lastError: 'no answer in 6 s',
      lastHour: { ok: 97, errors: 3 },
      entityIssues: [{ scope: { kind: 'room', slug: 'kitchen' }, entities: { 'light.kitchn': 'not found in Home Assistant' } }]
    }
  });
  assert.deepEqual(kinds(flaky), [
    'warn:3 Home Assistant requests failed in the last hour',
    'warn:Kitchen: 1 entity Home Assistant couldn’t give'
  ]);
  assert.equal(flaky.attention[1].link, '#/remote-layouts/kitchen');
});

test('ha-monitor: counts the last hour, keeps recent errors, and a 404 entity by scope', () => {
  haMonitor.reset();
  const t = NOW;
  haMonitor.record('/api/states/light.a', 40, null, t - 70 * 60000); // outside the hour
  haMonitor.record('/api/states/light.a', 20, null, t - 10 * 60000);
  haMonitor.record('/api/states/light.b', 40, null, t - 9 * 60000);
  haMonitor.record('/api/states/light.c?x=1', 6000, new Error('no answer in 6 s'), t - 5 * 60000);
  let s = haMonitor.snapshot(t);
  assert.deepEqual(s.lastHour, { ok: 2, errors: 1, avgMs: 30 });
  assert.equal(s.reachable, false); // the latest outcome failed
  assert.deepEqual(s.recent.map((r) => r.path), ['/api/states/light.c']);
  haMonitor.record('/api/states/light.a', 25, null, t - 60000);
  assert.equal(haMonitor.snapshot(t).reachable, true);

  haMonitor.noteEntities({ kind: 'room', slug: 'kitchen' }, { 'light.kitchn': 'HTTP 404', 'light.slow': 'no answer in 6 s' }, t);
  s = haMonitor.snapshot(t);
  assert.deepEqual(s.entityIssues.map((x) => Object.keys(x.entities)), [['light.kitchn']]); // timeouts aren't the layout's fault
  haMonitor.noteEntities({ kind: 'room', slug: 'kitchen' }, {}, t); // fixed
  assert.equal(haMonitor.snapshot(t).entityIssues.length, 0);
  haMonitor.reset();
});

test('missing entities: any entity id a layout names that HA doesn’t have', () => {
  const { missingEntities } = require('../lib/dashboard-state');
  const layout = {
    screens: [
      { kind: 'meetingRoom', title: 'St. James room', meeting: { calendar: 'calendar.boardroom', occupancy: 'binary_sensor.gone', freeIcon: 'door-open' } },
      { kind: 'sections', columns: [[{ type: 'weather', entity: 'weather.home', title: 'Weather' }]] }
    ]
  };
  assert.deepEqual(missingEntities(layout, { 'calendar.boardroom': {}, 'weather.home': {} }), ['binary_sensor.gone']);
});
