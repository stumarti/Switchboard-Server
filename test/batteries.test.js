'use strict';

// The Batteries section: every battery HA has, the low ones lowest first,
// then the offline ones; hidden while none are.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLayout, normalizeSection } = require('../lib/dashboard');
const { buildScreens, iconsUsed } = require('../lib/dashboard-state');

const NOW = new Date('2026-11-08T12:00:00Z');
const bat = (state, name, extra = {}) => ({ state, attributes: { friendly_name: name, device_class: 'battery', unit_of_measurement: '%', ...extra } });
const STATES = {
  'sensor.pixel_7_battery_level': bat('12', 'Pixel 7 Battery level'),
  'sensor.hall_dimmer_battery': bat('5', 'Hall Dimmer Battery'),
  'sensor.living_room_remote_battery': bat('19', 'Living Room Remote battery'),
  'sensor.suzi_battery': bat('unavailable', 'Suzi Battery'),
  'sensor.ipad_battery_level': bat('35', 'iPad Battery Level'),
  'binary_sensor.smoke_battery': { state: 'on', attributes: { friendly_name: 'Smoke alarm battery', device_class: 'battery' } },
  // Not a battery sensor, but listed.
  'sensor.givenergy_soc': { state: '7', attributes: { friendly_name: 'GivEnergy Power SOC', unit_of_measurement: '%' } },
  'sensor.kitchen_temperature': { state: '21', attributes: { friendly_name: 'Kitchen', unit_of_measurement: '°C' } }
};

function screen(section, states = STATES) {
  const layout = normalizeLayout({ screens: [{ id: 's', columns: [[{ id: 'b', type: 'batteries', ...section }]] }] });
  return buildScreens(layout, { states, forecasts: {}, now: NOW, timeZone: 'Europe/Dublin' }).s;
}
const data = (section, states) => {
  const s = screen(section, states).columns.flat().find((x) => x.id === 'b');
  return s ? s.data : null;
};

test('batteries: defaults', () => {
  const s = normalizeSection({ type: 'batteries' });
  assert.deepEqual(
    { auto: s.auto, entities: s.entities, exclude: s.exclude, below: s.below, offline: s.offline, count: s.count, hideWhenFine: s.hideWhenFine },
    { auto: true, entities: [], exclude: [], below: 20, offline: true, count: 6, hideWhenFine: true }
  );
  assert.deepEqual(normalizeSection({ type: 'batteries', exclude: ['sensor.a', '', 'sensor.a', { entity: 'sensor.b' }] }).exclude, ['sensor.a', 'sensor.b']);
});

test('batteries: every battery HA has, lowest first, red when critical, then offline', () => {
  const d = data({});
  assert.deepEqual(
    d.items.map((it) => [it.name, it.value, it.color]),
    [
      ['Smoke alarm', 'Low', 2],
      ['Hall Dimmer', '5%', 2],
      ['Pixel 7', '12%', 1],
      ['Living Room Remote', '19%', 1],
      ['Suzi', 'Offline', 1]
    ]
  );
  assert.equal(d.more, 0);
  assert.equal(d.empty, '');
});

test('batteries: listed extras, labels, exclusions, threshold and count', () => {
  const d = data({
    entities: [{ name: 'Home battery', entity: 'sensor.givenergy_soc' }],
    exclude: ['binary_sensor.smoke_battery', 'sensor.pixel_7_battery_level'],
    below: 40,
    offline: false,
    count: 3
  });
  assert.deepEqual(d.items.map((it) => `${it.name} ${it.value}`), ['Hall Dimmer 5%', 'Home battery 7%', 'Living Room Remote 19%']);
  // The iPad at 35% is the one left over.
  assert.equal(d.more, 1);
});

test('batteries: only the listed ones when not automatic', () => {
  const d = data({ auto: false, entities: [{ name: '', entity: 'sensor.ipad_battery_level' }], below: 50 });
  assert.deepEqual(d.items.map((it) => `${it.name} ${it.value}`), ['iPad 35%']);
});

test('batteries: hidden while none are low, unless asked to stay', () => {
  const fine = { 'sensor.ipad_battery_level': STATES['sensor.ipad_battery_level'] };
  assert.equal(data({}, fine), null);
  const d = data({ hideWhenFine: false }, fine);
  assert.deepEqual(d.items, []);
  assert.equal(d.empty, 'All batteries above 20%');
});

test('batteries: its icons are sent to the display', () => {
  const layout = normalizeLayout({ screens: [{ id: 's', columns: [[{ id: 'b', type: 'batteries' }]] }] });
  const icons = iconsUsed(layout);
  for (const n of ['battery-low', 'battery-alert-variant-outline', 'battery-unknown']) assert.ok(icons.includes(n), n);
});
