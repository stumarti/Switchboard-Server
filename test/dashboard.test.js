'use strict';

// node --test: the viewport dashboard's layout normalizer, importer and the
// rules that turn Home Assistant state into what each screen draws.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { evalCond, ruleColor, alertLine, buildScreens, screenEtag } = require('../lib/dashboard-state');

const TZ = 'Europe/London';
const NOW = new Date('2026-09-28T12:30:00Z'); // 13:30 in London (BST)
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const st = (state, attributes = {}, changedMinAgo = 600) => ({ state, attributes, last_changed: ago(changedMinAgo) });

test('conditions follow the panel: unknown/unavailable never match, gt/lt are numeric', () => {
  assert.equal(evalCond('on', 'eq', 'on'), true);
  assert.equal(evalCond('off', 'ne', 'on'), true);
  assert.equal(evalCond('unavailable', 'ne', 'on'), false);
  assert.equal(evalCond('', 'ne', 'on'), false);
  assert.equal(evalCond('armed_away', 'contains', 'armed_'), true);
  assert.equal(evalCond('disarmed', 'contains', 'armed_'), false);
  assert.equal(evalCond('12.5', 'gt', '10'), true);
  assert.equal(evalCond('abc', 'gt', '10'), false);
  assert.equal(evalCond('9', 'lt', '10'), true);
});

test('first matching colour rule wins, else the default', () => {
  const rules = [{ cond: 'eq', value: 'triggered', color: 2 }, { cond: 'contains', value: 'armed_', color: 2 }, { cond: 'eq', value: 'disarmed', color: 4 }];
  assert.equal(ruleColor(rules, 1, 'disarmed'), 4);
  assert.equal(ruleColor(rules, 1, 'armed_home'), 2);
  assert.equal(ruleColor(rules, 1, 'unknown'), 1);
});

test('alert sentences match the panel', () => {
  assert.equal(alertLine(['Front door'], 'open'), 'Front door open');
  assert.equal(alertLine(['Front door', 'Garage'], 'open'), 'Front door, Garage open');
  assert.equal(alertLine(['Kitchen', 'Living', 'Hall', 'Office'], 'open'), 'Kitchen, Living +2 open');
  const long = alertLine(['A very long window name here', 'Another long one'], 'open');
  assert.equal(long.length, 42);
  assert.ok(long.endsWith('...'));
});

test('normalizeLayout keeps every screen once, main always on, and clamps values', () => {
  const l = dashboard.normalizeLayout({
    screens: [{ screen: 'security', enabled: false }, { screen: 'main', enabled: false }, { screen: 'bogus' }, { screen: 'security' }],
    refreshIntervalMin: 7,
    statusIcons: new Array(12).fill({ entity: 'x.y', rules: [{ cond: 'nope', color: 9 }] }),
    alerts: [{ entities: new Array(10).fill({ entity: 'a.b' }) }]
  });
  assert.deepEqual(l.screens.map((s) => [s.screen, s.enabled]), [['security', false], ['main', true], ['climate', false], ['presence', false]]);
  assert.equal(l.refreshIntervalMin, 30);
  assert.equal(l.statusIcons.length, 9);
  assert.deepEqual(l.statusIcons[0].rules[0], { cond: 'eq', value: '', color: 1 });
  assert.equal(l.alerts[0].entities.length, 8);
  assert.ok(l.alerts[0].id);
});

test('a partial update keeps the other sections', () => {
  const base = dashboard.defaultLayout();
  const next = dashboard.normalizeLayout({ weather: { entity: 'weather.other' } }, base);
  assert.equal(next.weather.entity, 'weather.other');
  assert.equal(next.rooms.length, base.rooms.length);
  assert.equal(next.statusIcons[0].id, base.statusIcons[0].id);
});

test('importing the kitchen panel config carries entities, colours, icons, thresholds and alerts', () => {
  const l = dashboard.fromKitchenPanel({
    sensors: { door: 'binary_sensor.front_door', vacuum1: 'vacuum.roomba', heatpump: 'climate.daikin' },
    colors: { door_open: 3, vac1_running: 5 },
    icons: { vacuum1: 'robot' },
    thresholds: { battery_critical: 15, climate_tolerance: 2 },
    alerts: { slot2: { label: 'ajar', cond: 'eq', value: 'on', enabled: 1 }, slot7: { enabled: 0 } }
  });
  const door = l.statusIcons[1];
  assert.equal(door.entity, 'binary_sensor.front_door');
  assert.deepEqual(door.rules, [{ cond: 'eq', value: 'on', color: 3 }]);
  assert.equal(l.statusIcons[6].icon, 'robot');
  assert.equal(l.statusIcons[6].rules[0].color, 5);
  assert.equal(l.heatPump.entity, 'climate.daikin');
  assert.equal(l.thresholds.batteryCritical, 15);
  assert.equal(l.thresholds.climateTolerance, 2);
  assert.equal(l.alerts[1].suffix, 'ajar');
  assert.equal(l.alerts[1].color, 3);
  assert.deepEqual(l.alerts[1].entities, [{ entity: 'binary_sensor.front_door', name: 'Doors' }]);
  assert.equal(l.alerts[6].enabled, false);
  // The alarm's alert takes the "armed" colour, and doesn't fire on disarmed.
  assert.equal(l.alerts[0].value, 'armed_');
});

function sampleLayout() {
  return dashboard.normalizeLayout({
    ...dashboard.defaultLayout(),
    alerts: [
      { suffix: 'open', cond: 'eq', value: 'on', color: 2, entities: [{ entity: 'binary_sensor.front', name: 'Front door' }, { entity: 'binary_sensor.back' }] },
      { suffix: 'running', cond: 'eq', value: 'cleaning', color: 4, entities: [{ entity: 'vacuum.downstairs' }] }
    ],
    calendar: { entities: ['calendar.home'], lines: 3, days: 7 },
    heatPump: { entity: 'climate.heat_pump', outsideTemperature: 'sensor.outside', cop: 'sensor.cop' },
    rooms: [
      { name: 'Living', floor: 'downstairs', temperature: 'sensor.living_t', humidity: 'sensor.living_h', target: 21 },
      { name: 'Kitchen', floor: 'downstairs', climate: 'climate.kitchen' },
      { name: 'Office', floor: 'upstairs', temperature: 'sensor.office_t', target: 20 },
      { name: 'Guest', floor: 'upstairs', temperature: 'sensor.guest_t' }
    ],
    people: [{ entity: 'person.alex' }, { name: 'Sam', entity: 'person.sam' }],
    media: [{ name: 'Bedroom', entity: 'media_player.bedroom' }, { name: 'Living', entity: 'media_player.tv' }],
    transport: [{ name: '42 · City', color: 4, departure1: 'sensor.bus1', departure2: 'sensor.bus2' }],
    security: {
      alarm: 'alarm_control_panel.home',
      lastTriggered: 'sensor.alarm_last_triggered',
      doors: [{ name: 'Front door', entity: 'binary_sensor.front' }, { entity: 'binary_sensor.back' }],
      windows: [{ name: 'Kitchen', entity: 'binary_sensor.kitchen_window' }],
      motion: [{ name: 'Hall', entity: 'binary_sensor.hall_motion' }, { name: 'Garden', entity: 'binary_sensor.garden_motion' }],
      cameras: [{ name: 'Front', entity: 'binary_sensor.cam_front_motion' }]
    }
  });
}

function sampleStates() {
  return {
    'weather.home': st('rainy', { temperature: 14.26, apparent_temperature: 12, humidity: 80, wind_speed: 20, wind_speed_unit: 'km/h', temperature_unit: '°C' }),
    'sensor.solar_energy_today': st('12.34', { unit_of_measurement: 'kWh' }),
    'sensor.solar_forecast_today': st('20', { unit_of_measurement: 'kWh' }),
    'sensor.battery_soc': st('8'),
    'sensor.battery_status': st('Discharging'),
    'alarm_control_panel.home': st('armed_away', {}, 45),
    'binary_sensor.any_door_open': st('on'),
    'vacuum.downstairs': st('cleaning'),
    'binary_sensor.front': st('on', {}, 5),
    'binary_sensor.back': st('off', { friendly_name: 'Back door' }, 60 * 30),
    'climate.heat_pump': st('heat', { hvac_action: 'heating', temperature: 21, current_temperature: 19.5 }),
    'sensor.outside': st('8.4'),
    'sensor.cop': st('3.21'),
    'sensor.living_t': st('19.2'),
    'sensor.living_h': st('55'),
    'climate.kitchen': st('heat', { current_temperature: 20.1, temperature: 21, hvac_action: 'idle' }),
    'sensor.office_t': st('21.6'),
    'sensor.guest_t': st('18'),
    'person.alex': st('home', { friendly_name: 'Alex' }),
    'person.sam': st('not_home'),
    'media_player.bedroom': st('playing', { media_title: 'Comptine', media_artist: 'Yann Tiersen', app_name: 'Spotify' }),
    'media_player.tv': st('off'),
    'sensor.bus1': st(new Date(NOW.getTime() + 3 * 60000).toISOString()),
    'sensor.bus2': st('20'),
    'binary_sensor.kitchen_window': st('off'),
    'binary_sensor.hall_motion': st('off', {}, 10),
    'binary_sensor.garden_motion': st('off', {}, 60 * 30),
    'sensor.alarm_last_triggered': st('2026-09-25T09:00:00Z'),
    'binary_sensor.cam_front_motion': st('off', {}, 90)
  };
}

function build(extra = {}) {
  return buildScreens(sampleLayout(), {
    states: sampleStates(),
    forecasts: {
      daily: { 'weather.home': [
        { datetime: '2026-09-28T00:00:00Z', condition: 'rainy', temperature: 15, templow: 9 },
        { datetime: '2026-09-29T00:00:00Z', condition: 'cloudy', temperature: 16, templow: 8 },
        { datetime: '2026-09-30T00:00:00Z', condition: 'sunny', temperature: 18, templow: 10 }
      ] },
      hourly: { 'weather.home': [
        { datetime: '2026-09-28T13:00:00Z', condition: 'rainy', temperature: 14 },
        { datetime: '2026-09-28T16:00:00Z', condition: 'pouring', temperature: 13 }
      ] }
    },
    calendars: { 'calendar.home': [
      { start: { dateTime: '2026-09-29T09:00:00+01:00' }, summary: 'Dentist' },
      { start: { date: '2026-09-28' }, summary: 'Bin day' },
      { start: { dateTime: '2026-09-28T18:30:00+01:00' }, summary: 'Football' }
    ] },
    now: NOW,
    timeZone: TZ,
    ...extra
  });
}

test('main screen: weather, forecast, energy, battery, icons, alerts, calendar', () => {
  const { main } = build();
  assert.equal(main.weather.temperature, 14.3);
  assert.equal(main.weather.condition, 'rainy');
  assert.deepEqual(main.weather.forecast.map((f) => f.label), ['Later', 'Tue', 'Wed']);
  assert.equal(main.weather.forecast[0].condition, 'pouring');
  assert.deepEqual(main.energy.solarToday, { value: 12.3, unit: 'kWh' });
  assert.equal(main.energy.solarPct, 62);
  assert.equal(main.energy.loadToday, null);
  assert.equal(main.battery.soc, 8);
  assert.equal(main.battery.critical, true);
  assert.equal(main.battery.color, 2);
  assert.equal(main.statusIcons[0].color, 2); // armed_away
  assert.equal(main.statusIcons[1].color, 2); // a door open
  assert.equal(main.statusIcons[2].color, 1); // windows: unknown -> default
  assert.equal(main.statusIcons[6].color, 4); // vacuum cleaning
  // A named entity uses its name; an unnamed one its HA friendly name, else its id.
  assert.deepEqual(main.alerts.lines, [
    { text: 'Front door open', color: 2 },
    { text: 'vacuum.downstairs running', color: 4 }
  ]);
  assert.equal(main.alerts.allClear, false);
  assert.deepEqual(main.calendar.map((c) => c.text), ['Today · Bin day', 'Today 18:30 · Football', 'Tomorrow 09:00 · Dentist']);
});

test('all clear when nothing matches', () => {
  const states = sampleStates();
  states['binary_sensor.front'] = st('off');
  states['vacuum.downstairs'] = st('docked');
  const { main } = build({ states });
  assert.deepEqual(main.alerts, { lines: [], overflow: 0, allClear: true });
});

test('climate screen: heat pump and each room against its target', () => {
  const { climate } = build();
  assert.deepEqual(climate.heatPump, { name: 'climate.heat_pump', mode: 'Heat', action: 'Heating', current: 19.5, setpoint: 21, outside: 8.4, cop: 3.2 });
  const byName = Object.fromEntries(climate.rooms.map((r) => [r.name, r]));
  assert.equal(byName.Living.state, 'heat'); // 19.2 vs 21, tolerance 1
  assert.equal(byName.Living.color, 2);
  assert.equal(byName.Living.delta, -1.8);
  assert.equal(byName.Kitchen.state, 'ok'); // 20.1 vs 21 from its thermostat, idle
  assert.equal(byName.Kitchen.temperature, 20.1);
  assert.equal(byName.Office.state, 'cool'); // 21.6 vs 20
  assert.equal(byName.Guest.state, 'idle'); // no target
  assert.equal(climate.calling, 1);
  assert.equal(climate.total, 4);
});

test('presence screen: people, now playing, departures', () => {
  const { presence } = build();
  assert.deepEqual(presence.people, [
    { name: 'Alex', home: true, state: 'Home', color: 4 },
    { name: 'Sam', home: false, state: 'Away', color: 1 }
  ]);
  assert.equal(presence.media.length, 1);
  assert.deepEqual(presence.media[0], { room: 'Bedroom', icon: '', app: 'Spotify', title: 'Comptine', artist: 'Yann Tiersen', playing: true });
  const [d1, d2] = presence.transport[0].departures;
  assert.deepEqual(d1, { time: '13:33', minutes: 3, urgent: true, color: 2, text: '3 min' });
  assert.deepEqual(d2, { time: '13:50', minutes: 20, urgent: false, color: 4, text: '20 min' });
  assert.deepEqual(presence.rooms.map((r) => r.floor), ['downstairs', 'downstairs', 'upstairs', 'upstairs']);
});

test('security screen: alarm, summary, doors, windows, motion, cameras', () => {
  const { security } = build();
  assert.deepEqual(security.alarm, { state: 'armed_away', label: 'Armed away', since: '12:45', color: 2 });
  assert.equal(security.last.triggered, 'Fri');
  assert.deepEqual(security.summary, { doors: 2, doorsOpen: 1, windows: 1, windowsOpen: 0, motion: 2, cameras: 1 });
  assert.deepEqual(security.doors[0], { name: 'Front door', open: true, state: 'Open', when: '13:25', color: 2 });
  assert.equal(security.doors[1].name, 'Back door');
  assert.equal(security.doors[1].when, 'yesterday');
  assert.equal(security.motion[0].recent, true);
  assert.equal(security.motion[0].color, 5);
  assert.equal(security.motion[1].recent, false);
  assert.equal(security.cameras[0].when, '12:00');
});

test('screen etags change only when that screen changes', () => {
  const a = build();
  const states = sampleStates();
  states['person.sam'] = st('home');
  const b = build({ states });
  assert.equal(screenEtag(a.main), screenEtag(b.main));
  assert.notEqual(screenEtag(a.presence), screenEtag(b.presence));
});
