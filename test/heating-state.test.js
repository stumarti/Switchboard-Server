'use strict';

// node --test: the heating state (calling / idle / off), as the Heating
// section works it out, for status icons and "now" items.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { buildScreens } = require('../lib/dashboard-state');

const TZ = 'Europe/Dublin';
const st = (state, attributes = {}) => ({ state: String(state), attributes });
function sectionsOf(sections, states) {
  const layout = dashboard.normalizeLayout({ screens: [{ id: 's', kind: 'sections', template: 'single', columns: [sections] }] });
  return buildScreens(layout, { states, timeZone: TZ }).s.columns[0].map((x) => x.data);
}

const STATES = {
  'climate.auto_at_target': st('auto', { current_temperature: 20.8, temperature: 21 }),
  'climate.auto_cold': st('auto', { current_temperature: 18, temperature: 21 }),
  // Says it's heating, but within half a degree: not calling (as the panel).
  'climate.heat_told': st('heat', { current_temperature: 20.9, temperature: 21, hvac_action: 'heating' }),
  'climate.heat_cold': st('heat', { current_temperature: 19, temperature: 21 }),
  'climate.off': st('off', { current_temperature: 15, temperature: 21 }),
  'water_heater.tank': st('eco', { current_temperature: 47, temperature: 55, operation_mode: 'eco' }),
  'switch.boiler': st('on')
};

test('status icons: the Heating preset is red only while calling, never just for being on auto', () => {
  const p = dashboard.ICON_PRESETS.heating;
  const icon = (entity) => ({ ...p, entity, showByDefault: true, color: 1 });
  const [d] = sectionsOf([{ type: 'statusIcons', icons: ['climate.auto_at_target', 'climate.auto_cold', 'climate.heat_cold', 'climate.off', 'switch.boiler'].map(icon) }], STATES);
  assert.deepEqual(d.icons.map((x) => [x.state, x.color]), [['idle', 1], ['calling', 2], ['calling', 2], ['off', 1], ['calling', 2]]);
  assert.equal(d.icons[3].icon, 'radiator-off');
});

test('now: a heating item with just its thermostat shows while it calls; hot water while below target', () => {
  const now = (items) => sectionsOf([{ type: 'now', items }], STATES)[0].items;
  assert.deepEqual(now([{ kind: 'heating', entity: 'climate.auto_at_target' }]), []);
  const [h] = now([{ kind: 'heating', entity: 'climate.auto_cold', name: 'House', detail: '{name}' }]);
  assert.equal(h.line1, 'Heating');
  assert.equal(h.line2, 'House');
  // Zones: only the calling ones counted.
  const [z] = now([{ kind: 'heating', items: [{ entity: 'climate.auto_at_target' }, { entity: 'climate.auto_cold' }, { entity: 'climate.heat_cold' }, { entity: 'climate.heat_told' }] }]);
  assert.equal(z.line2, '2 zones heating');
  // Hot water: eco, but 8 degrees below its target.
  assert.equal(now([{ kind: 'hotWater', entity: 'water_heater.tank' }]).length, 1);
  // Any item can ask for the heating state.
  assert.equal(now([{ kind: 'entity', entity: 'climate.auto_at_target', attribute: '@heating', value: 'calling' }]).length, 0);
  assert.equal(now([{ kind: 'entity', entity: 'climate.heat_cold', attribute: '@heating', value: 'calling', title: '{name} {state}' }])[0].line1, 'climate.heat_cold calling');
});

test('the heating state is the Heating section’s: half a degree below target, whatever the thermostat says', () => {
  const [d] = sectionsOf([{ type: 'heating', zones: [{ entity: 'climate.auto_at_target' }, { entity: 'climate.heat_told' }, { entity: 'climate.heat_cold' }] }], STATES);
  assert.deepEqual(d.zones.map((z) => z.active), [false, false, true]);
  assert.equal(d.calling, 1);
});
