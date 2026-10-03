'use strict';

// node --test: battery sensors published to Home Assistant (lib/ha-publish.js)
// — which sensors, named how, and keeping Home Assistant in line with them.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hapub-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');
const publish = require('../lib/ha-publish');

const device = (mac, name, battery, extra = {}) => ({
  mac, name, type: 'remote', status: 'approved', assignedSlug: 'kitchen', health: { battery, firmware: 'v1.4.0', at: '2026-09-30T10:00:00Z' }, ...extra
});
const life = { a: { daysLeft: 12.5, ratePerDay: 2.1, basis: 'measured', sinceChargeDays: 6, fullChargeDays: 45 } };
const estimate = (mac) => life[mac] || null;

test('ha-publish: two sensors a device, named after it', () => {
  const want = publish.desiredStates(
    {
      a: device('a', 'Kitchen remote', 72),
      b: device('b', 'Café panel', 40, { type: 'viewport', dashboard: 'cafe' }),
      c: device('c', 'Spare', 90, { status: 'pending' }), // not paired: nothing
      d: device('d', 'No reading', undefined)
    },
    { estimate, dashboards: { cafe: { name: 'Café' } } }
  );
  assert.deepEqual(Object.keys(want).sort(), [
    'sensor.switchboard_cafe_panel_battery',
    'sensor.switchboard_cafe_panel_battery_days_left',
    'sensor.switchboard_kitchen_remote_battery',
    'sensor.switchboard_kitchen_remote_battery_days_left'
  ]);
  const bat = want['sensor.switchboard_kitchen_remote_battery'];
  assert.equal(bat.state, '72');
  assert.equal(bat.attributes.device_class, 'battery');
  assert.equal(bat.attributes.unit_of_measurement, '%');
  assert.equal(bat.attributes.room, 'kitchen');
  assert.equal(bat.attributes.days_left, 12.5);
  assert.equal(want['sensor.switchboard_kitchen_remote_battery_days_left'].state, '12.5');
  // Still learning: "unknown", as Home Assistant expects.
  assert.equal(want['sensor.switchboard_cafe_panel_battery_days_left'].state, 'unknown');
  assert.equal(want['sensor.switchboard_cafe_panel_battery'].attributes.layout, 'Café');
});

test("ha-publish: a viewport's temperature, humidity and battery voltage too, as the kitchen panel sent them", () => {
  const v = device('aa:00:00:00:00:09', 'Kitchen panel', 76);
  v.type = 'viewport';
  v.health = { ...v.health, temperature: 21.46, humidity: 48.6, voltage: 3.9 };
  const want = publish.desiredStates({ [v.mac]: v }, { estimate });
  assert.equal(want['sensor.switchboard_kitchen_panel_temperature'].state, '21.5');
  assert.equal(want['sensor.switchboard_kitchen_panel_temperature'].attributes.unit_of_measurement, '°C');
  assert.equal(want['sensor.switchboard_kitchen_panel_humidity'].state, '49');
  assert.equal(want['sensor.switchboard_kitchen_panel_voltage'].state, '3.90');
  assert.equal(want['sensor.switchboard_kitchen_panel_voltage'].attributes.device_class, 'voltage');
  // A remote measures none of them.
  const r = publish.desiredStates({ 'aa:00:00:00:00:01': device('aa:00:00:00:00:01', 'Sofa', 50) }, { estimate });
  assert.deepEqual(Object.keys(r).sort(), ['sensor.switchboard_sofa_battery', 'sensor.switchboard_sofa_battery_days_left']);
});

test('ha-publish: devices with the same name are told apart', () => {
  const want = publish.desiredStates({
    'aa:00:00:00:12:34': device('aa:00:00:00:12:34', 'Remote', 50),
    'aa:00:00:00:56:78': device('aa:00:00:00:56:78', 'Remote', 60)
  }, { estimate });
  assert.ok(want['sensor.switchboard_remote_1234_battery']);
  assert.ok(want['sensor.switchboard_remote_5678_battery']);
});

test('ha-publish: sync sends what changed, re-sends when due, removes what went, and all of it when switched off', async () => {
  const calls = [];
  const request = async (base, p, init) => {
    calls.push(`${init.method} ${p}`);
    return {};
  };
  store.saveGlobals({ ...store.getGlobals(), homeAssistant: { host: 'ha', port: 8123, token: 't', publishBattery: true } });
  store.saveDevices({ 'aa:00:00:00:00:01': device('aa:00:00:00:00:01', 'Kitchen remote', 72) });
  const t0 = Date.parse('2026-09-30T12:00:00Z');

  let st = await publish.sync({ now: t0, request });
  assert.equal(st.error, null);
  assert.deepEqual(calls.sort(), ['POST /api/states/sensor.switchboard_kitchen_remote_battery', 'POST /api/states/sensor.switchboard_kitchen_remote_battery_days_left']);

  calls.length = 0;
  await publish.sync({ now: t0 + 60000, request });
  assert.deepEqual(calls, []); // nothing changed

  await publish.sync({ now: t0 + publish.REFRESH_MS + 1, request });
  assert.equal(calls.length, 2); // due again (Home Assistant may have restarted)

  // Renamed: the new sensors in, the old ones out.
  calls.length = 0;
  store.saveDevices({ 'aa:00:00:00:00:01': device('aa:00:00:00:00:01', 'Hall remote', 70) });
  await publish.sync({ now: t0 + publish.REFRESH_MS + 2, request });
  assert.ok(calls.includes('POST /api/states/sensor.switchboard_hall_remote_battery'));
  assert.ok(calls.includes('DELETE /api/states/sensor.switchboard_kitchen_remote_battery'));
  assert.ok(calls.includes('DELETE /api/states/sensor.switchboard_kitchen_remote_battery_days_left'));

  // Switched off: everything published goes.
  calls.length = 0;
  store.saveGlobals({ ...store.getGlobals(), homeAssistant: { host: 'ha', port: 8123, token: 't', publishBattery: false } });
  st = await publish.sync({ now: t0 + publish.REFRESH_MS + 3, request });
  assert.deepEqual(calls.sort(), ['DELETE /api/states/sensor.switchboard_hall_remote_battery', 'DELETE /api/states/sensor.switchboard_hall_remote_battery_days_left']);
  assert.equal(st.published, 0);
});

test('ha-publish: an error is reported, and what failed is tried again', async () => {
  store.saveGlobals({ ...store.getGlobals(), homeAssistant: { host: 'ha', port: 8123, token: 't', publishBattery: true } });
  store.saveDevices({ 'aa:00:00:00:00:02': device('aa:00:00:00:00:02', 'Sofa remote', 64) });
  const t0 = Date.parse('2026-10-01T12:00:00Z');
  const st = await publish.sync({ now: t0, request: async () => { throw new Error('HTTP 401 (token rejected)'); } });
  assert.match(st.error, /401/);
  const calls = [];
  await publish.sync({ now: t0 + 1000, request: async (b, p, init) => calls.push(`${init.method} ${p}`) });
  assert.equal(calls.filter((c) => c.startsWith('POST')).length, 2);
});
