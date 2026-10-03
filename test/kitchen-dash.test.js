'use strict';

// node --test: the kitchen dashboard layout (lib/dashboard.js's
// kitchenDashLayout) evaluated against a house, checking each value against
// what the wall panel's own firmware worked out before it pulled from here.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { buildScreens, refreshPlan, iconsUsed } = require('../lib/dashboard-state');

const TZ = 'Europe/London';
const NOW = new Date('2026-09-28T12:30:00Z'); // 13:30 BST

const st = (state, attributes = {}, changed = '2026-09-28T11:45:00Z') => ({ state, attributes, last_changed: changed });

function house(over = {}) {
  return {
    'weather.home': st('partlycloudy', { temperature: 17.6, temperature_unit: '°C', humidity: 71.4, wind_speed: 12.6, wind_speed_unit: 'km/h', wind_bearing: 225, uv_index: 3 }),
    'sensor.solar_forecast_today': st('14.26', { unit_of_measurement: 'kWh' }),
    'sensor.solar_generation': st('6.42', { unit_of_measurement: 'kWh' }),
    'sensor.load_today': st('9.1', { unit_of_measurement: 'kWh' }),
    'sensor.grid_import': st('0.4', { unit_of_measurement: 'kWh' }),
    'sensor.grid_export': st('2.25', { unit_of_measurement: 'kWh' }),
    'sensor.battery_soc': st('83', { unit_of_measurement: '%' }),
    'sensor.battery_power': st('-1450', { unit_of_measurement: 'W' }),
    'sensor.battery_charge_eta': st('2026-09-28T14:10:00+00:00'),
    'sensor.battery_discharge_eta': st('unknown'),
    'sensor.home_alarm_state': st('disarmed'),
    'sensor.home_alarm_event': st('Disarmed by Stuart at the front door keypad this morning before school run'),
    'alarm_control_panel.home_alarm': st('disarmed', {}, '2026-09-28T07:05:00Z'),
    'climate.whole_house': st('heat', { current_temperature: 19.2, temperature: 20.5, active_member_count: 8 }),
    'water_heater.home_tank': st('eco', { operation_mode: 'heating', current_temperature: 48.4, temperature: 55 }),
    'binary_sensor.front_door': st('on', {}, '2026-09-28T12:25:00Z'),
    'binary_sensor.back_door': st('off'),
    'binary_sensor.window_side': st('off'),
    'binary_sensor.window_living_room': st('on'),
    'binary_sensor.window_kitchen': st('on'),
    'binary_sensor.window_office_left': st('off'),
    'binary_sensor.window_office_right': st('off'),
    'binary_sensor.window_bedroom_left': st('off'),
    'binary_sensor.window_bedroom_right': st('off'),
    'sensor.plant_soil_moisture': st('Almost Dry'),
    'vacuum.vacuum1': st('cleaning'),
    'sensor.vacuum1_battery': st('64', { unit_of_measurement: '%' }),
    'binary_sensor.vacuum1_charging': st('off'),
    'vacuum.vacuum2': st('docked'),
    'sensor.vacuum2_battery': st('80', { unit_of_measurement: '%' }),
    'lawn_mower.mower': st('docked'),
    'sensor.mower_battery': st('100', { unit_of_measurement: '%' }),
    'binary_sensor.mower_charging': st('on'),
    'climate.kitchen': st('heat', { current_temperature: 19.0, temperature: 21 }),
    'climate.living_room': st('heat', { current_temperature: 20.8, temperature: 21 }),
    'climate.hall': st('auto', { current_temperature: 17.0, temperature: 18 }),
    'climate.bathroom': st('off', { current_temperature: 18.0, temperature: 22 }),
    'climate.office': st('heat', { current_temperature: 22.4, temperature: 20 }),
    'binary_sensor.front_door_motion': st('on', {}, '2026-09-28T12:20:00Z'),
    'binary_sensor.hall_motion': st('off', {}, '2026-09-28T09:02:00Z'),
    'binary_sensor.camera_front_motion': st('off', {}, '2026-09-28T10:15:00Z'),
    ...over
  };
}

const forecasts = {
  daily: {
    'weather.home': [
      { datetime: '2026-09-28T00:00:00Z', condition: 'rainy', temperature: 15, templow: 9 },
      { datetime: '2026-09-29T00:00:00Z', condition: 'cloudy', temperature: 16.4, templow: 8 },
      { datetime: '2026-09-30T00:00:00Z', condition: 'sunny', temperature: 18, templow: 10 },
      { datetime: '2026-10-01T00:00:00Z', condition: 'pouring', temperature: 12.5, templow: 7 }
    ]
  },
  hourly: {
    'weather.home': [
      { datetime: '2026-09-28T12:00:00Z', precipitation: 0 },
      { datetime: '2026-09-28T13:00:00Z', precipitation: 0.05 },
      { datetime: '2026-09-28T14:00:00Z', precipitation: 0 },
      { datetime: '2026-09-28T15:00:00Z', precipitation: 0.6 },
      { datetime: '2026-09-28T16:00:00Z', precipitation: 1.2 }
    ]
  }
};

const calendars = {
  'calendar.home_schedule': [
    { start: { dateTime: '2026-09-28T08:15:00+01:00' }, end: { dateTime: '2026-09-28T08:45:00+01:00' }, summary: 'School run' },
    { start: { dateTime: '2026-09-28T18:30:00+01:00' }, end: { dateTime: '2026-09-28T20:00:00+01:00' }, summary: 'Football', description: 'Bring boots and the orange bibs for the\nwhole team please' }
  ],
  'calendar.work': [{ start: { dateTime: '2026-09-28T10:00:00+01:00' }, end: { dateTime: '2026-09-28T11:00:00+01:00' }, summary: 'Standup' }],
  'calendar.birthdays': [{ start: { date: '2026-09-28' }, end: { date: '2026-09-29' }, summary: "Gran's birthday" }]
};

function screens(states = house()) {
  return buildScreens(dashboard.defaultLayout(), { states, forecasts, calendars, now: NOW, timeZone: TZ });
}
const data = (screen, id) => screen.columns.flat().find((s) => s.id === id).data;

test('the kitchen dashboard: Status, Heating and Security, returning to Status, quieter overnight', () => {
  const l = dashboard.defaultLayout();
  assert.deepEqual(l.screens.map((s) => s.id), ['status', 'heating', 'security']);
  assert.deepEqual(l.carousel, { mode: 'returnFirst', everyMin: 30, buttons: 'direct' });
  assert.equal(l.refreshIntervalMin, 30);
  assert.deepEqual(l.quietHours, { enabled: true, start: 23, end: 6, intervalMin: 60 });
  assert.equal(l.screens[2].template, 'triple');
  assert.equal(l.screens[2].columns.length, 3);
  // 23:30 BST is quiet: an hour; 05:30 BST wakes at 06:00, when it ends.
  assert.deepEqual(refreshPlan(l, new Date('2026-09-28T22:30:00Z'), TZ), { quiet: true, interval: 3600 });
  assert.deepEqual(refreshPlan(l, new Date('2026-09-28T04:30:00Z'), TZ), { quiet: true, interval: 1800 });
  assert.deepEqual(refreshPlan(l, NOW, TZ), { quiet: false, interval: 1800 });
});

test('weather: whole-number temperature, detail row, rain outlook and the 3 days after today', () => {
  const w = data(screens().status, 'status-weather');
  assert.equal(w.temperatureText, '18');
  assert.equal(w.humidityText, '71');
  assert.equal(w.windText, '13');
  assert.equal(w.bearing, 225);
  assert.equal(w.uvText, '3.0');
  assert.equal(w.icon, 'partlycloudy');
  // 13:00 BST (12:00Z) dry, 0.05 mm under the threshold, wet from 16:00 BST.
  assert.deepEqual(w.rain, { state: 'starts', time: '16:00', text: 'Rain at 16:00' });
  assert.deepEqual(w.solar, { value: 14.3, text: 'Expecting 14.3kWh today' });
  assert.deepEqual(w.forecast.map((f) => [f.label, f.condition, f.high]), [['Tue', 'cloudy', 16.4], ['Wed', 'sunny', 18], ['Thu', 'pouring', 12.5]]);
  // At night partly cloudy has its own icon.
  const night = buildScreens(dashboard.defaultLayout(), { states: house(), forecasts, calendars, now: new Date('2026-09-28T21:00:00Z'), timeZone: TZ });
  assert.equal(data(night.status, 'status-weather').icon, 'night-partlycloudy');
});

test('rain: raining now shows when it stops, or that it carries on', () => {
  const wet = { ...forecasts, hourly: { 'weather.home': [{ datetime: '2026-09-28T12:00:00Z', precipitation: 2 }, { datetime: '2026-09-28T13:00:00Z', precipitation: 1 }, { datetime: '2026-09-28T14:00:00Z', precipitation: 0 }] } };
  let w = data(buildScreens(dashboard.defaultLayout(), { states: house(), forecasts: wet, calendars, now: NOW, timeZone: TZ }).status, 'status-weather');
  assert.deepEqual(w.rain, { state: 'stops', time: '15:00', text: 'Rain stops 15:00' });
  const allDay = { ...forecasts, hourly: { 'weather.home': [{ datetime: '2026-09-28T12:00:00Z', precipitation: 2 }, { datetime: '2026-09-28T13:00:00Z', precipitation: 1 }] } };
  w = data(buildScreens(dashboard.defaultLayout(), { states: house(), forecasts: allDay, calendars, now: NOW, timeZone: TZ }).status, 'status-weather');
  assert.equal(w.rain.text, 'Rain continuing');
});

test('energy and home battery: HA text, charging with the time it will be full', () => {
  const s = screens().status;
  const e = data(s, 'status-energy');
  assert.equal(e.solarToday.text, '6.42 kWh');
  assert.equal(e.gridExport.text, '2.25 kWh');
  const b = data(s, 'status-battery');
  assert.equal(b.socText, '83 %');
  assert.equal(b.status, 'charging');
  assert.equal(b.statusText, 'Charging');
  assert.equal(b.eta, 'full at 15:10');
  assert.equal(b.color, 4);
  const idle = data(screens(house({ 'sensor.battery_power': st('40') })).status, 'status-battery');
  assert.deepEqual([idle.statusText, idle.eta, idle.color], ['Idle', '', 1]);
  const out = data(screens(house({ 'sensor.battery_power': st('900'), 'sensor.battery_discharge_eta': st('2026-09-28T21:00:00Z') })).status, 'status-battery');
  assert.deepEqual([out.statusText, out.eta, out.color], ['Discharging', 'empty at 22:00', 2]);
  // Low, idle: black, as the panel drew it (no "critical" red from a power sensor).
  const low = data(screens(house({ 'sensor.battery_soc': st('6', { unit_of_measurement: '%' }), 'sensor.battery_power': st('0') })).status, 'status-battery');
  assert.deepEqual([low.statusText, low.color], ['Idle', 1]);
  // The power sensor unreadable: no word at all.
  const gone = data(screens(house({ 'sensor.battery_power': st('unavailable') })).status, 'status-battery');
  assert.deepEqual([gone.statusText, gone.eta, gone.color], ['', '', 1]);
});

test('battery times: full at / empty at only while charging / discharging, only from a timestamp, in local time', () => {
  const bat = (over) => data(screens(house(over)).status, 'status-battery');
  // Charging: the charge ETA (UTC in HA) as local time; the discharge one ignored.
  let b = bat({ 'sensor.battery_power': st('-500'), 'sensor.battery_charge_eta': st('2026-09-28T16:45:00+00:00'), 'sensor.battery_discharge_eta': st('2026-09-28T23:00:00+00:00') });
  assert.deepEqual([b.statusText, b.eta, b.color], ['Charging', 'full at 17:45', 4]);
  // Exactly at the idle threshold is idle (the panel: below -100 / above +100).
  assert.deepEqual([bat({ 'sensor.battery_power': st('-100') }).statusText, bat({ 'sensor.battery_power': st('100') }).statusText], ['Idle', 'Idle']);
  // Discharging: the discharge ETA; a fractional-second timestamp too.
  b = bat({ 'sensor.battery_power': st('101'), 'sensor.battery_discharge_eta': st('2026-09-29T05:30:00.250+00:00') });
  assert.deepEqual([b.statusText, b.eta, b.color], ['Discharging', 'empty at 06:30', 2]);
  // No usable ETA (unknown, a duration, missing): the status alone.
  assert.equal(bat({ 'sensor.battery_power': st('-900'), 'sensor.battery_charge_eta': st('unknown') }).eta, '');
  assert.equal(bat({ 'sensor.battery_power': st('-900'), 'sensor.battery_charge_eta': st('1h 10m') }).eta, '');
  assert.equal(bat({ 'sensor.battery_power': st('900'), 'sensor.battery_discharge_eta': undefined }).eta, '');
  // Idle never shows a time, even with ETAs about.
  assert.equal(bat({ 'sensor.battery_power': st('20') }).eta, '');
});

test('battery inputs: a meter in kW, positive-while-charging inverters, and finish times however the sensor gives them', () => {
  const bat = (over, section = {}) => {
    const layout = dashboard.defaultLayout();
    Object.assign(layout.screens[0].columns[0].find((x) => x.id === 'status-battery'), section);
    return data(buildScreens(layout, { states: house(over), forecasts, calendars, now: NOW, timeZone: TZ }).status, 'status-battery');
  };
  // kW: -1.25 kW is 1250 W charging (read as W it would be "Idle").
  assert.equal(bat({ 'sensor.battery_power': st('-1.25', { unit_of_measurement: 'kW' }) }).statusText, 'Charging');
  assert.equal(bat({ 'sensor.battery_power': st('0.05', { unit_of_measurement: 'kW' }) }).statusText, 'Idle');
  // An inverter that reports charging as positive.
  let b = bat({ 'sensor.battery_power': st('900'), 'sensor.battery_charge_eta': st('2026-09-28T15:00:00Z') }, { chargingWhen: 'positive' });
  assert.deepEqual([b.statusText, b.eta, b.color], ['Charging', 'full at 16:00', 4]);
  assert.equal(bat({ 'sensor.battery_power': st('-900') }, { chargingWhen: 'positive' }).statusText, 'Discharging');
  // Finish times: a timestamp with no offset (an input_datetime) is local;
  // a space instead of the T; an offset honoured.
  const eta = (v, attrs) => bat({ 'sensor.battery_power': st('-900'), 'sensor.battery_charge_eta': st(v, attrs) }).eta;
  assert.equal(eta('2026-09-28 17:15:00'), 'full at 17:15');
  assert.equal(eta('2026-09-28 16:15:00+00:00'), 'full at 17:15');
  assert.equal(eta('2026-09-28T18:15:00+02:00'), 'full at 17:15');
  // Or the time left, from now (13:30): minutes, hours, seconds, h:mm:ss.
  assert.equal(eta('95', { unit_of_measurement: 'min' }), 'full at 15:05');
  assert.equal(eta('2.5', { unit_of_measurement: 'h' }), 'full at 16:00');
  assert.equal(eta('600', { unit_of_measurement: 's' }), 'full at 13:40');
  assert.equal(eta('1:45:00'), 'full at 15:15');
  // A bare number with no unit says nothing.
  assert.equal(eta('95'), '');
});

test('status icons: any door or window, heating calling, robots working, charging or in error', () => {
  const icons = Object.fromEntries(data(screens().status, 'status-icons').icons.map((i) => [i.name, [i.icon, i.color]]));
  assert.deepEqual(icons, {
    Alarm: ['shield-check', 4],
    Doors: ['door-open', 2],
    Windows: ['window-open', 2],
    Heating: ['radiator', 2],
    'Hot water': ['water-boiler', 2],
    Plants: ['flower', 2],
    'Vacuum 1': ['robot-vacuum', 4],
    'Vacuum 2': ['robot-vacuum-variant', 5], // docked, 80%, no charging sensor
    Mower: ['robot-mower', 1] // charging, but already full
  });
  const quiet = house({
    'sensor.home_alarm_state': st('armed_away'),
    'binary_sensor.front_door': st('off'),
    'binary_sensor.window_living_room': st('off'),
    'binary_sensor.window_kitchen': st('off'),
    'climate.whole_house': st('heat', { active_member_count: 0 }),
    'water_heater.home_tank': st('eco', { operation_mode: 'off' }),
    'vacuum.vacuum1': st('error')
  });
  const q = Object.fromEntries(data(screens(quiet).status, 'status-icons').icons.map((i) => [i.name, [i.icon, i.color]]));
  assert.deepEqual(q.Alarm, ['shield-alert', 2]);
  assert.deepEqual(q.Doors, ['door-closed', 1]);
  assert.deepEqual(q.Windows, ['window-closed', 1]);
  assert.deepEqual(q.Heating, ['radiator-off', 1]);
  assert.deepEqual(q['Hot water'], ['water-boiler-off', 1]);
  assert.deepEqual(q['Vacuum 1'], ['robot-vacuum', 2]);
});

test('now: the alarm always, then only what is active, worded as the panel words it', () => {
  const items = data(screens().status, 'status-now').items;
  assert.deepEqual(
    items.map((i) => [i.line1, i.line2, i.color, i.icon]),
    [
      // Cut as the panel cut it: 49 characters and "...".
      ['Alarm disarmed', 'Disarmed by Stuart at the front door keypad this ...', 4, 'shield-check'],
      ['Heating', '2 zones heating', 2, 'radiator'], // kitchen 2.0 below, hall 1.0 below; living 0.2, bathroom off
      ['Hot water', '48C / 55C target', 2, 'water-boiler'],
      ['Door open', 'Front', 2, 'door-open'],
      ['2 windows open', 'Living room, Kitchen', 2, 'window-open'],
      ['Plant needs water', 'House plant', 5, 'watering-can'],
      ['Vacuum 1 cleaning', '64% battery', 4, 'robot-vacuum']
    ]
  );
  const both = data(screens(house({ 'binary_sensor.back_door': st('on'), 'sensor.home_alarm_state': st('partset_b') })).status, 'status-now').items;
  assert.deepEqual(both[0].line1, 'Alarm part set');
  assert.deepEqual(both.find((i) => i.line1 === 'Door open').line2, 'Front & back');
});

test("today's calendar: everything today, timed first, coloured per calendar, with a short description", () => {
  const lines = data(screens().status, 'status-today').lines;
  assert.deepEqual(
    lines.map((l) => [l.time, l.title, l.color, l.description]),
    [
      ['08:15', 'School run', 1, ''],
      ['10:00', 'Standup', 5, ''],
      // Six words and "...", then cut to 32 characters and "..." (the panel's own rule).
      ['18:30', 'Football', 1, 'Bring boots and the orange bibs....'],
      ['', "Gran's birthday", 2, '']
    ]
  );
});

test('heating: zones on a shared scale, calling when more than half a degree below in heat or auto', () => {
  const h = screens().heating.columns[0][0].data;
  assert.equal(h.on, true);
  assert.equal(h.calling, 2);
  assert.equal(h.total, 5); // zones HA has
  // The panel's Heating page never showed the whole house's now / set.
  assert.equal(h.current, null);
  assert.equal(h.target, null);
  assert.equal(h.scaleMin, 15);
  assert.equal(h.scaleMax, 25);
  assert.deepEqual(h.zones.map((z) => [z.name, z.active]), [['Kitchen', true], ['Living Room', false], ['Hall', true], ['Bathroom', false], ['Office', false]]);
  assert.deepEqual(h.water, { on: true, mode: 'heating', current: 48, target: 55 });
});

test('security: alarm since HH:MM, and every row with the time it last changed', () => {
  const sec = screens().security;
  const a = sec.columns[0][0].data;
  assert.equal(a.state, 'disarmed');
  assert.equal(a.sinceTime, '08:05');
  assert.equal(a.summary, true);
  const doors = sec.columns[1][0].data.items;
  assert.deepEqual(doors.map((d) => [d.name, d.open, d.time]), [['Front door', true, '13:25'], ['Back door', false, '12:45']]);
  const motion = sec.columns[2][0].data.sensors;
  assert.deepEqual(motion.slice(0, 2).map((m) => [m.name, m.on, m.time]), [['Front door', true, '13:20'], ['Hall', false, '10:02']]);
  assert.deepEqual(sec.columns[2][1].data.cameras[0], { name: 'Front camera', when: '11:15', time: '11:15', on: false });
});

test('the bundle lists every icon the kitchen dashboard can show', () => {
  const names = iconsUsed(dashboard.defaultLayout());
  for (const n of ['shield-check', 'shield-alert', 'door-open', 'door-closed', 'window-open', 'radiator-off', 'water-boiler', 'flower', 'watering-can', 'robot-mower']) {
    assert.ok(names.includes(n), n);
  }
});

test("numbers come out as the panel's firmware wrote them (String(float, n), roundf)", () => {
  const { arduinoFixed, roundf } = require('../lib/dashboard-state');
  // dtostrf(v, n + 2, n): half away from zero, padded on the left to n + 2.
  assert.equal(arduinoFixed(68, 0), '68');
  assert.equal(arduinoFixed(5, 0), ' 5');
  assert.equal(arduinoFixed(3.4, 0), ' 3');
  assert.equal(arduinoFixed(20.5, 0), '21');
  assert.equal(arduinoFixed(18.5, 0), '19');
  assert.equal(arduinoFixed(-3, 0), '-3');
  assert.equal(arduinoFixed(3, 1), '3.0');
  assert.equal(arduinoFixed(14.25, 1), '14.3');
  assert.equal(arduinoFixed(123.45, 1), '123.4'); // a float: 123.4499...
  assert.equal(roundf(-0.5), -1);
  assert.equal(roundf(-2.5), -3);
  assert.equal(roundf(2.5), 3);
  assert.equal(roundf(-0.4), 0);
});

test("today's calendar in the panel's order: timed by HH:MM (last night's 20:00 sorts as 20:00), ties and all-day by calendar", () => {
  const day = '2026-09-28';
  const cals = {
    'calendar.home_schedule': [
      { start: { date: day }, end: { date: '2026-09-29' }, summary: 'Zeta all day' },
      { start: { dateTime: '2026-09-27T20:00:00+01:00' }, end: { dateTime: '2026-09-28T18:00:00+01:00' }, summary: 'Overnight' },
      { start: { dateTime: `${day}T09:00:00+01:00` }, end: { dateTime: `${day}T10:00:00+01:00` }, summary: 'Same time B' }
    ],
    'calendar.work': [{ start: { dateTime: `${day}T09:00:00+01:00` }, end: { dateTime: `${day}T10:00:00+01:00` }, summary: 'Same time A' }],
    'calendar.birthdays': [{ start: { date: day }, end: { date: '2026-09-29' }, summary: 'Alpha all day' }]
  };
  const sc = buildScreens(dashboard.defaultLayout(), { states: house(), forecasts, calendars: cals, now: NOW, timeZone: TZ });
  const lines = data(sc.status, 'status-today').lines.map((l) => `${l.time}|${l.title}`);
  assert.deepEqual(lines, ['09:00|Same time B', '09:00|Same time A', '20:00|Overnight', '|Zeta all day', '|Alpha all day']);
});

test("the bundle stays within the viewport's JSON nesting limit (ARDUINOJSON_DEFAULT_NESTING_LIMIT=32)", () => {
  const depth = (v) => (v && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0);
  // The deepest layouts: the kitchen dashboard and a meeting-room sign, in a
  // bundle ({layout, ...}), with room to spare: the display refuses deeper
  // JSON outright and then says it isn't connected.
  for (const layout of [dashboard.defaultLayout(), dashboard.meetingRoomLayout()]) {
    assert.ok(depth({ layout }) <= 24, `bundle depth ${depth({ layout })}`);
  }
});
