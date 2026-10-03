'use strict';

// node --test: the viewport dashboard's layout model and importer, and the
// rules that turn Home Assistant state into what each section draws.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { evalCond, splitConsumption, statusIconLook, alertLine, stepAverage, buildScreens, screenEtag, iconsUsed } = require('../lib/dashboard-state');

const TZ = 'Europe/London';
const NOW = new Date('2026-09-28T12:30:00Z'); // 13:30 in London (BST)
const at = (min) => new Date(NOW.getTime() + min * 60000).toISOString();
const ago = (min) => at(-min);
const st = (state, attributes = {}, changedMinAgo = 600) => ({ state, attributes, last_changed: ago(changedMinAgo) });

// --- Rules -------------------------------------------------------------------------

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

test('status icon rules pick colour, icon and visibility; first match wins', () => {
  const lock = { icon: 'lock', color: 1, showByDefault: true, rules: [
    { cond: 'eq', value: 'unlocked', color: 2, icon: 'lock-open-variant', hide: false },
    { cond: 'eq', value: 'locked', color: 4, icon: '', hide: false }
  ] };
  assert.deepEqual(statusIconLook(lock, 'unlocked'), { color: 2, icon: 'lock-open-variant', hidden: false });
  assert.deepEqual(statusIconLook(lock, 'locked'), { color: 4, icon: 'lock', hidden: false });
  assert.deepEqual(statusIconLook(lock, 'jammed'), { color: 1, icon: 'lock', hidden: false });
  const onlyWhenOn = { icon: 'trash-can', color: 1, showByDefault: false, rules: [{ cond: 'eq', value: 'on', color: 3, icon: '', hide: false }] };
  assert.equal(statusIconLook(onlyWhenOn, 'off').hidden, true);
  assert.equal(statusIconLook(onlyWhenOn, 'on').hidden, false);
  const hideRule = { icon: 'x', color: 1, showByDefault: true, rules: [{ cond: 'eq', value: 'off', color: 1, icon: '', hide: true }] };
  assert.equal(statusIconLook(hideRule, 'off').hidden, true);
});

test('alert sentences match the panel', () => {
  assert.equal(alertLine(['Front door'], 'open'), 'Front door open');
  assert.equal(alertLine(['Front door', 'Garage'], 'open'), 'Front door, Garage open');
  assert.equal(alertLine(['Kitchen', 'Living', 'Hall', 'Office'], 'open'), 'Kitchen, Living +2 open');
  const long = alertLine(['A very long window name here', 'Another long one'], 'open');
  assert.equal(long.length, 42);
  assert.ok(long.endsWith('...'));
});

test('stepAverage weighs each value by how long it held', () => {
  const pts = [{ t: 0, v: 1 }, { t: 30, v: 3 }];
  assert.equal(stepAverage(pts, 0, 60), 2);
  assert.equal(stepAverage(pts, 30, 60), 3);
  assert.equal(stepAverage(pts, 10, 40), (1 * 20 + 3 * 10) / 30);
  assert.equal(stepAverage([], 0, 60), null);
  assert.equal(stepAverage([{ t: 100, v: 5 }], 0, 60), null);
});

// --- Model --------------------------------------------------------------------------

test('normalizeLayout: carousel defaults to staying put, sections are validated, templates set the column count', () => {
  const l = dashboard.normalizeLayout({
    carousel: { mode: 'bogus', everyMin: 1 },
    screens: [
      { id: 's1', template: 'single', columns: [[{ type: 'weather', entity: 'weather.x' }, { type: 'nope' }], [{ type: 'people' }]] },
      { id: 's2', kind: 'meetingRoom', meeting: { calendar: 'calendar.room', soonMin: 500 } },
      { id: 's3', template: 'columns', columns: [[{ type: 'statusIcons', icons: new Array(20).fill({ entity: 'a.b', rules: [{ cond: 'x', color: 9 }] }) }]] }
    ]
  });
  assert.deepEqual(l.carousel, { mode: 'stay', everyMin: 5 });
  const [s1, s2, s3] = l.screens;
  assert.equal(s1.columns.length, 1);
  assert.deepEqual(s1.columns[0].map((s) => s.type), ['weather', 'people']); // the extra column folds in
  assert.equal(s2.kind, 'meetingRoom');
  assert.equal(s2.meeting.soonMin, 60);
  assert.equal(s3.columns.length, 2);
  const icons = s3.columns[0][0].icons;
  assert.equal(icons.length, 12);
  assert.deepEqual(icons[0].rules[0], { cond: 'eq', value: '', entity: '', attribute: '', also: null, color: 1, icon: '', hide: false });
});

test('the default layout is stable (same ids every time) and is the kitchen dashboard', () => {
  const a = dashboard.defaultLayout();
  assert.equal(JSON.stringify(a), JSON.stringify(dashboard.defaultLayout()));
  assert.deepEqual(a.screens.map((s) => s.id), ['status', 'heating', 'security']);
  assert.equal(a.carousel.mode, 'returnFirst');
});

test('a layout saved as the old fixed four screens converts to sections', () => {
  const l = dashboard.normalizeLayout({
    screens: [{ screen: 'main', enabled: true }, { screen: 'security', enabled: false }],
    weather: { entity: 'weather.x' },
    statusIcons: [{ name: 'A', entity: 'a.b', defaultColor: 3, rules: [] }],
    rooms: [{ name: 'R', temperature: 'sensor.r' }]
  });
  const home = l.screens.find((s) => s.id === 'home');
  assert.equal(home.columns[0][0].entity, 'weather.x');
  assert.equal(home.columns[1][0].icons[0].color, 3);
  assert.equal(l.screens.find((s) => s.id === 'security').enabled, false);
  assert.equal(l.screens.find((s) => s.id === 'climate').columns[0][1].rooms[0].name, 'R');
});

test('importing the kitchen panel config carries entities, colours, icons, thresholds and alerts', () => {
  const l = dashboard.fromKitchenPanel({
    sensors: { door: 'binary_sensor.front_door', vacuum1: 'vacuum.roomba', heatpump: 'climate.daikin' },
    colors: { door_open: 3, vac1_running: 5 },
    icons: { vacuum1: 'robot' },
    thresholds: { battery_critical: 15, climate_tolerance: 2 },
    alerts: { slot2: { label: 'ajar', cond: 'eq', value: 'on', enabled: 1 }, slot7: { enabled: 0 } }
  });
  const home = l.screens[0];
  const icons = home.columns[1][0].icons;
  assert.equal(icons[1].entity, 'binary_sensor.front_door');
  assert.equal(icons[1].rules[0].color, 3);
  assert.equal(icons[6].icon, 'robot');
  assert.equal(icons[6].rules[0].color, 5);
  const slots = home.columns[1][1].slots;
  assert.equal(slots[1].suffix, 'ajar');
  assert.equal(slots[1].color, 3);
  assert.deepEqual(slots[1].entities, [{ entity: 'binary_sensor.front_door', name: 'Doors' }]);
  assert.equal(slots[6].enabled, false);
  assert.equal(slots[0].value, 'armed_'); // doesn't fire on "disarmed"
  assert.equal(l.screens.find((s) => s.id === 'climate').columns[0][0].entity, 'climate.daikin');
  assert.equal(l.thresholds.batteryCritical, 15);
  assert.equal(l.thresholds.climateTolerance, 2);
});

// --- Evaluation ---------------------------------------------------------------------------

function layout() {
  return dashboard.normalizeLayout({
    screens: [
      {
        id: 'home',
        template: 'sidebar',
        columns: [
          [
            { id: 'w', type: 'weather', entity: 'weather.home', later: true, days: 2 },
            { id: 'e', type: 'energy', solarToday: 'sensor.solar_today', solarExpected: 'sensor.solar_expected' },
            { id: 'b', type: 'battery', soc: 'sensor.battery_soc', status: 'sensor.battery_status' }
          ],
          [
            { id: 'i', type: 'statusIcons', icons: [
              { name: 'Alarm', entity: 'alarm_control_panel.home', icon: 'shield-home', rules: [{ cond: 'contains', value: 'armed_', color: 2 }] },
              { name: 'Bins', entity: 'sensor.bins', attribute: 'days', icon: 'trash-can', showByDefault: false, rules: [{ cond: 'lt', value: '2', color: 3 }] },
              { name: 'Back door', entity: 'lock.back', icon: 'lock', rules: [{ cond: 'eq', value: 'unlocked', color: 2, icon: 'lock-open-variant' }] }
            ] },
            { id: 'a', type: 'alerts', slots: [
              { suffix: 'open', cond: 'eq', value: 'on', color: 2, entities: [{ entity: 'binary_sensor.front', name: 'Front door' }, { entity: 'binary_sensor.back' }] },
              { suffix: 'running', cond: 'eq', value: 'cleaning', color: 4, entities: [{ entity: 'vacuum.downstairs' }] }
            ] },
            { id: 'c', type: 'calendar', entities: ['calendar.home'], lines: 3 }
          ]
        ]
      },
      {
        id: 'climate',
        template: 'single',
        columns: [[
          { id: 'hp', type: 'heatPump', entity: 'climate.heat_pump', outsideTemperature: 'sensor.outside', cop: 'sensor.cop' },
          { id: 'rc', type: 'roomClimate', rooms: [
            { name: 'Living', temperature: 'sensor.living_t', humidity: 'sensor.living_h', target: 21 },
            { name: 'Kitchen', climate: 'climate.kitchen' },
            { name: 'Office', floor: 'upstairs', temperature: 'sensor.office_t', target: 20 },
            { name: 'Guest', floor: 'upstairs', temperature: 'sensor.guest_t' }
          ] }
        ]]
      },
      {
        id: 'presence',
        template: 'columns',
        columns: [
          [{ id: 'p', type: 'people', people: [{ entity: 'person.alex' }, { name: 'Sam', entity: 'person.sam' }] }],
          [
            { id: 'm', type: 'media', players: [{ name: 'Bedroom', entity: 'media_player.bedroom' }, { name: 'Living', entity: 'media_player.tv' }] },
            { id: 't', type: 'transport', routes: [{ name: '42 · City', color: 4, departure1: 'sensor.bus1', departure2: 'sensor.bus2' }] }
          ]
        ]
      },
      {
        id: 'security',
        template: 'columns',
        columns: [
          [
            { id: 'al', type: 'alarm', entity: 'alarm_control_panel.home', lastTriggered: 'sensor.alarm_last_triggered' },
            { id: 'd', type: 'openings', title: 'Doors', items: [{ name: 'Front door', entity: 'binary_sensor.front' }, { entity: 'binary_sensor.back' }] }
          ],
          [
            { id: 'mo', type: 'motion', sensors: [{ name: 'Hall', entity: 'binary_sensor.hall_motion' }, { name: 'Garden', entity: 'binary_sensor.garden_motion' }] },
            { id: 'ca', type: 'cameras', cameras: [{ name: 'Front', entity: 'binary_sensor.cam_front_motion' }] }
          ]
        ]
      },
      {
        id: 'energy',
        template: 'single',
        columns: [[{ id: 'g', type: 'energyGraph', range: 'today', bucketMin: 60,
          solar: { entity: 'sensor.solar_power', kind: 'power' },
          load: { entity: 'sensor.load_energy', kind: 'energy' },
          forecast: { entity: 'sensor.solar_expected', attribute: 'detailedForecast', unit: 'auto' } }]]
      },
      { id: 'room', kind: 'meetingRoom', meeting: { calendar: 'calendar.boardroom', name: 'Boardroom', occupancy: 'binary_sensor.boardroom_occupied', soonMin: 10, emptyMin: 10 } }
    ]
  });
}

function states() {
  return {
    'weather.home': st('rainy', { temperature: 14.26, apparent_temperature: 12, humidity: 80, wind_speed: 20, wind_speed_unit: 'km/h' }),
    'sensor.solar_today': st('12.34', { unit_of_measurement: 'kWh' }),
    'sensor.solar_expected': st('20', { unit_of_measurement: 'kWh', detailedForecast: [
      { period_start: '2026-09-28T09:00:00+01:00', pv_estimate: 1.0 },
      { period_start: '2026-09-28T09:30:00+01:00', pv_estimate: 2.0 },
      { period_start: '2026-09-28T10:00:00+01:00', pv_estimate: 3.0 }
    ] }),
    'sensor.battery_soc': st('8'),
    'sensor.battery_status': st('Discharging'),
    'alarm_control_panel.home': st('armed_away', {}, 45),
    'sensor.bins': st('ok', { days: 1 }),
    'lock.back': st('unlocked'),
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
    'sensor.bus1': st(at(3)),
    'sensor.bus2': st('20'),
    'binary_sensor.hall_motion': st('off', {}, 10),
    'binary_sensor.garden_motion': st('off', {}, 60 * 30),
    'sensor.alarm_last_triggered': st('2026-09-25T09:00:00Z'),
    'binary_sensor.cam_front_motion': st('off', {}, 90),
    'sensor.solar_power': st('2500', { unit_of_measurement: 'W' }),
    'sensor.load_energy': st('5.5', { unit_of_measurement: 'kWh' }),
    'calendar.boardroom': st('on', { friendly_name: 'Boardroom calendar' }),
    'binary_sensor.boardroom_occupied': st('on', {}, 30)
  };
}

function build(extra = {}) {
  return buildScreens(layout(), {
    states: states(),
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
    calendars: {
      'calendar.home': [
        { start: { dateTime: '2026-09-29T09:00:00+01:00' }, end: { dateTime: '2026-09-29T10:00:00+01:00' }, summary: 'Dentist' },
        { start: { date: '2026-09-28' }, end: { date: '2026-09-29' }, summary: 'Bin day' },
        { start: { dateTime: '2026-09-28T18:30:00+01:00' }, end: { dateTime: '2026-09-28T20:00:00+01:00' }, summary: 'Football' }
      ],
      'calendar.boardroom': [
        { start: { dateTime: '2026-09-28T13:00:00+01:00' }, end: { dateTime: '2026-09-28T14:00:00+01:00' }, summary: 'Quarterly review' },
        { start: { dateTime: '2026-09-28T14:00:00+01:00' }, end: { dateTime: '2026-09-28T14:30:00+01:00' }, summary: 'Design sync' },
        { start: { dateTime: '2026-09-28T16:00:00+01:00' }, end: { dateTime: '2026-09-28T17:00:00+01:00' }, summary: 'Hiring panel' }
      ]
    },
    history: {
      // 2.5 kW from 12:00 local (11:00Z) onwards, 1 kW before.
      'sensor.solar_power': [
        { entity_id: 'sensor.solar_power', state: '1000', last_changed: '2026-09-27T23:00:00Z' },
        { state: '2500', last_changed: '2026-09-28T11:00:00Z' }
      ],
      // A cumulative meter: 5.5 kWh now, 4.0 at 12:00 local, 3.0 at 11:00.
      'sensor.load_energy': [
        { entity_id: 'sensor.load_energy', state: '3.0', last_changed: '2026-09-28T10:00:00Z' },
        { state: '4.0', last_changed: '2026-09-28T11:00:00Z' },
        { state: '5.5', last_changed: '2026-09-28T12:15:00Z' }
      ]
    },
    now: NOW,
    timeZone: TZ,
    ...extra
  });
}

const sectionData = (screen, id) => screen.columns.flat().find((s) => s.id === id).data;

test('main sections: weather, energy, battery, rule-driven icons, alerts, calendar', () => {
  const home = build().home;
  assert.equal(home.template, 'sidebar');
  const w = sectionData(home, 'w');
  assert.equal(w.temperature, 14.3);
  assert.deepEqual(w.forecast.map((f) => f.label), ['Later', 'Tue', 'Wed']);
  assert.equal(w.forecast[0].condition, 'pouring');
  assert.equal(sectionData(home, 'e').solarPct, 62);
  const b = sectionData(home, 'b');
  assert.equal(b.critical, true);
  assert.equal(b.color, 2);
  assert.deepEqual(sectionData(home, 'i').icons, [
    { name: 'Alarm', icon: 'shield-home', color: 2, state: 'armed_away' },
    { name: 'Bins', icon: 'trash-can', color: 3, state: '1' }, // from its `days` attribute
    { name: 'Back door', icon: 'lock-open-variant', color: 2, state: 'unlocked' }
  ]);
  assert.deepEqual(sectionData(home, 'a').lines, [
    { text: 'Front door open', color: 2 },
    { text: 'vacuum.downstairs running', color: 4 }
  ]);
  assert.deepEqual(sectionData(home, 'c').lines.map((c) => c.text), ['Today · Bin day', 'Today 18:30 · Football', 'Tomorrow 09:00 · Dentist']);
});

test('an icon hidden by default appears only when its rule matches', () => {
  const s = states();
  s['sensor.bins'] = st('ok', { days: 4 });
  const icons = sectionData(build({ states: s }).home, 'i').icons;
  assert.deepEqual(icons.map((i) => i.name), ['Alarm', 'Back door']);
});

test('climate sections: heat pump and each room against its target', () => {
  const c = build().climate;
  assert.deepEqual(sectionData(c, 'hp'), { name: 'climate.heat_pump', mode: 'Heat', action: 'Heating', current: 19.5, setpoint: 21, outside: 8.4, cop: 3.2 });
  const rc = sectionData(c, 'rc');
  const byName = Object.fromEntries(rc.rooms.map((r) => [r.name, r]));
  assert.equal(byName.Living.state, 'heat');
  assert.equal(byName.Living.delta, -1.8);
  assert.equal(byName.Kitchen.state, 'ok');
  assert.equal(byName.Office.state, 'cool');
  assert.equal(byName.Guest.state, 'idle');
  assert.equal(rc.calling, 1);
});

test('presence sections: people, now playing, departures', () => {
  const p = build().presence;
  assert.deepEqual(sectionData(p, 'p').people, [
    { name: 'Alex', home: true, state: 'Home', color: 4 },
    { name: 'Sam', home: false, state: 'Away', color: 1 }
  ]);
  assert.equal(sectionData(p, 'm').players.length, 1);
  const [d1, d2] = sectionData(p, 't').routes[0].departures;
  assert.deepEqual(d1, { time: '13:33', minutes: 3, urgent: true, color: 2, text: '3 min' });
  assert.deepEqual(d2, { time: '13:50', minutes: 20, urgent: false, color: 4, text: '20 min' });
});

test('security sections: alarm, openings, motion, cameras', () => {
  const s = build().security;
  const al = sectionData(s, 'al');
  assert.equal(al.label, 'Armed away');
  assert.equal(al.since, '12:45');
  assert.equal(al.last.triggered, 'Fri');
  const d = sectionData(s, 'd');
  assert.equal(d.open, 1);
  assert.deepEqual(d.items[0], { name: 'Front door', open: true, state: 'Open', when: '13:25', time: '13:25', color: 2 });
  assert.equal(d.items[1].when, 'yesterday');
  const mo = sectionData(s, 'mo').sensors;
  assert.equal(mo[0].recent, true);
  assert.equal(mo[1].recent, false);
  assert.equal(sectionData(s, 'ca').cameras[0].when, '12:00');
});

test('energy graph: solar vs forecast on top; power averaged and meters differenced per hour', () => {
  const g = sectionData(build().energy, 'g');
  assert.equal(g.labels.length, 24);
  assert.equal(g.labels[0], '00');
  assert.equal(g.nowIndex, 13);
  // Solar: 1 kW until 12:00 local, 2.5 kW after; 13:00-13:30 so far is 2.5.
  assert.equal(g.solar.actual[11], 1);
  assert.equal(g.solar.actual[12], 2.5);
  assert.equal(g.solar.actual[13], 2.5);
  assert.equal(g.solar.actual[14], null); // the future
  // Forecast: 09:00 local averages its two half-hours; 10:00 holds 3 kW.
  assert.equal(g.solar.forecast[9], 1.5);
  assert.equal(g.solar.forecast[10], 3);
  assert.equal(g.solar.forecast[8], null);
  assert.equal(g.solar.max, 3);
  assert.equal(g.totals.forecast, 4.5);
  // Load meter: 3.0 -> 4.0 over 11:00-12:00 local is 1 kW; 13:00-13:30 adds 1.5 kWh in half an hour.
  // No grid or battery sensors here, so it's all from solar while solar covers it.
  assert.equal(g.usage.fromSolar[11], 1);
  assert.equal(g.usage.fromSolar[13], 2.5);
  assert.equal(g.usage.fromBattery[13], 0.5); // 3 kW used, 2.5 kW of solar
  assert.equal(g.usage.fromGrid[13], 0);
  assert.equal(g.totals.gridImport, null); // not configured
});

test('consumption splits into grid first, then battery, then solar', () => {
  // Metered grid import and battery discharge.
  assert.deepEqual(splitConsumption(3, 1, 0.5, 1.5), { fromSolar: 1, fromBattery: 1.5, fromGrid: 0.5 });
  // Grid import can't exceed what the house used.
  assert.deepEqual(splitConsumption(1, 0, 4, 0), { fromSolar: 0, fromBattery: 0, fromGrid: 1 });
  // No battery sensor: what solar didn't cover came from the battery.
  assert.deepEqual(splitConsumption(3, 2, 0, null), { fromSolar: 2, fromBattery: 1, fromGrid: 0 });
  // Solar beyond consumption (exported or charging) isn't counted as used.
  assert.deepEqual(splitConsumption(1, 4, 0, null), { fromSolar: 1, fromBattery: 0, fromGrid: 0 });
  // Metered battery says 0, but solar can't have covered it all: the gap is battery.
  assert.deepEqual(splitConsumption(2.2, 1.6, 0, 0), { fromSolar: 1.6, fromBattery: 0.6, fromGrid: 0 });
  assert.deepEqual(splitConsumption(null, 4, 0, null), { fromSolar: null, fromBattery: null, fromGrid: null });
});

test('meeting room: in use, back-to-back blocks, and when to wake next', () => {
  const r = build().room;
  assert.equal(r.kind, 'meetingRoom');
  assert.equal(r.data.status, 'busy');
  assert.equal(r.data.color, 2);
  assert.deepEqual(r.data.current, { title: 'Quarterly review', time: '13:00–14:00', endsInMin: 30 });
  assert.equal(r.data.until, 'Busy until 14:30');
  assert.deepEqual(r.data.upcoming.map((u) => u.time), ['14:00–14:30', '16:00–17:00']);
  assert.equal(r.nextChangeInSec, 30 * 60);
});

test('meeting room: free, starting soon, booked-but-empty, and hidden titles', () => {
  const lay = layout();
  const room = lay.screens.find((s) => s.id === 'room');
  const run = (now, stateOverrides = {}) => buildScreens(lay, {
    states: { ...states(), ...stateOverrides },
    calendars: { 'calendar.boardroom': [
      { start: { dateTime: '2026-09-28T14:00:00+01:00' }, end: { dateTime: '2026-09-28T15:00:00+01:00' }, summary: 'Design sync' }
    ] },
    now: new Date(now),
    timeZone: TZ
  }).room;
  const free = run('2026-09-28T12:30:00Z', { 'binary_sensor.boardroom_occupied': st('off', {}, 30) });
  assert.equal(free.data.status, 'free');
  assert.equal(free.data.until, 'Free until 14:00');
  assert.equal(free.nextChangeInSec, 20 * 60); // entering "starting soon" at 13:50
  assert.equal(run('2026-09-28T12:55:00Z').data.status, 'soon');
  const empty = run('2026-09-28T13:20:00Z', { 'binary_sensor.boardroom_occupied': st('off', {}, 60) });
  assert.equal(empty.data.status, 'bookedEmpty');
  assert.equal(run('2026-09-28T12:30:00Z').data.status, 'occupied'); // someone's in, nothing booked
  room.meeting.hideTitles = true;
  assert.equal(run('2026-09-28T13:20:00Z').data.current.title, 'Booked');
});

const BOARDROOM = {
  'calendar.boardroom': [
    { start: { dateTime: '2026-09-28T13:00:00+01:00' }, end: { dateTime: '2026-09-28T14:00:00+01:00' }, summary: 'Quarterly review' },
    { start: { dateTime: '2026-09-28T14:00:00+01:00' }, end: { dateTime: '2026-09-28T14:30:00+01:00' }, summary: 'Design sync' },
    { start: { dateTime: '2026-09-28T16:00:00+01:00' }, end: { dateTime: '2026-09-28T17:00:00+01:00' }, summary: 'Hiring panel' }
  ]
};

test('meeting room: status icon, a timeline snapped to the quarter hour, and the room climate', () => {
  const lay = dashboard.normalizeLayout({
    screens: [{ id: 'room', kind: 'meetingRoom', meeting: {
      calendar: 'calendar.boardroom', timelineHours: 2, occupiedIcon: 'account-tie',
      climate: { show: true, temperature: 'climate.kitchen', co2: 'sensor.boardroom_co2' }
    } }]
  });
  const run = (now) => buildScreens(lay, {
    states: { ...states(), 'sensor.boardroom_co2': st('1200') },
    calendars: BOARDROOM,
    now: new Date(now),
    timeZone: TZ
  }).room.data;
  const d = run('2026-09-28T12:30:00Z'); // 13:30 local, in the Quarterly review
  assert.equal(d.icon, 'account-tie');
  assert.deepEqual(d.timeline.blocks.map((b) => [b.from, b.to, b.title]), [[0, 0.25, 'Quarterly review'], [0.25, 0.5, 'Design sync']]);
  assert.deepEqual(d.timeline.ticks.map((t) => t.label), ['13:30', '14:00', '14:30', '15:00', '15:30']);
  assert.deepEqual([d.timeline.start, d.timeline.end], ['13:30', '15:30']);
  assert.deepEqual(d.climate, { temperature: 20.1, unit: '°', humidity: null, co2: 1200, co2Color: 3 });
  // Seven minutes on, the timeline hasn't moved: same screen, no panel refresh.
  assert.deepEqual(run('2026-09-28T12:37:00Z').timeline, d.timeline);
  assert.equal(run('2026-09-28T11:00:00Z').icon, 'door-open'); // free before the meeting
  assert.equal(d.label, 'In use');
  lay.screens[0].meeting.labels = { ...lay.screens[0].meeting.labels, busy: 'Busy', free: '' };
  assert.equal(run('2026-09-28T12:30:00Z').label, 'Busy');
  assert.equal(dashboard.normalizeLayout(lay).screens[0].meeting.labels.free, 'Available'); // blank -> default
  // Off: no timeline, no climate.
  lay.screens[0].meeting.timelineHours = 0;
  lay.screens[0].meeting.climate.show = false;
  const off = run('2026-09-28T12:30:00Z');
  assert.equal(off.timeline, null);
  assert.equal(off.climate, null);
});

test('room finder: free rooms first, longest free first, and when to wake', () => {
  const lay = dashboard.normalizeLayout({
    screens: [{ id: 'rooms', kind: 'roomFinder', finder: { rooms: [
      { name: 'Boardroom', calendar: 'calendar.boardroom' },
      { name: 'Focus', calendar: 'calendar.focus' },
      { name: 'Quiet', calendar: 'calendar.quiet' },
      { name: 'Huddle', calendar: 'calendar.huddle', occupancy: 'binary_sensor.huddle' }
    ] } }]
  });
  const run = () => buildScreens(lay, {
    states: { ...states(), 'binary_sensor.huddle': st('on') },
    calendars: {
      ...BOARDROOM,
      'calendar.focus': [{ start: { dateTime: '2026-09-28T14:00:00+01:00' }, end: { dateTime: '2026-09-28T15:00:00+01:00' }, summary: 'Secret' }]
    },
    now: NOW,
    timeZone: TZ
  }).rooms;
  const r = run();
  assert.equal(r.kind, 'roomFinder');
  assert.deepEqual(r.data.rooms.map((x) => [x.name, x.status, x.until]), [
    ['Quiet', 'free', 'Free for the rest of the day'],
    ['Focus', 'free', 'Free until 14:00'],
    ['Huddle', 'occupied', 'Not booked today'],
    ['Boardroom', 'busy', 'Busy until 14:30']
  ]);
  assert.equal(r.data.summary, '2 of 4 rooms free');
  assert.deepEqual(r.data.rooms.map((x) => x.label), ['Free', 'Free', 'In use — not booked', 'In use']);
  assert.equal(r.nextChangeInSec, 20 * 60); // Focus turns "starting soon" at 13:50
  lay.screens[0].finder.showBusy = false;
  assert.deepEqual(run().data.rooms.map((x) => x.name), ['Quiet', 'Focus']);
  // The meeting-room template comes with it, as the screen to toggle to.
  assert.deepEqual(dashboard.meetingRoomLayout().screens.map((s) => s.kind), ['meetingRoom', 'roomFinder']);
});

test('screen etags change only when that screen changes; icons used are listed', () => {
  const a = build();
  const s = states();
  s['person.sam'] = st('home');
  const b = build({ states: s });
  assert.equal(screenEtag(a.home), screenEtag(b.home));
  assert.notEqual(screenEtag(a.presence), screenEtag(b.presence));
  // The meeting room's four status icons are listed too.
  assert.deepEqual(iconsUsed(layout()), [
    'account-group', 'account-off-outline', 'bus', 'clock-alert-outline', 'door-open', 'lock', 'lock-open-variant', 'shield-home', 'trash-can'
  ]);
});

test('a screen with departures wakes when the next one turns imminent', () => {
  const { presence, home } = build();
  // 3 min is already imminent (threshold 5); 20 min turns imminent in 15.
  assert.equal(presence.nextChangeInSec, 15 * 60);
  assert.equal(home.nextChangeInSec, null);
});

test('conditional section: Now playing shows only while music plays, the calendar shrinks, and the display wakes every 3 min meanwhile', () => {
  const lay = dashboard.normalizeLayout({
    screens: [{
      id: 'home', template: 'sidebar',
      columns: [
        [{ id: 'w', type: 'weather', entity: 'weather.home' }],
        [
          { id: 'cal', type: 'calendar', entities: ['calendar.home'], lines: 5 },
          { id: 'np', type: 'media', players: [{ entity: 'media_player.bedroom' }], showWhen: { mode: 'playing' } }
        ]
      ]
    }]
  });
  assert.deepEqual(lay.screens[0].columns[1][1].showWhen, { mode: 'playing', entity: '', cond: 'eq', value: '', liveMin: 3 });
  assert.equal(lay.screens[0].columns[1][0].shrinkTo, 2);
  const cal = { 'calendar.home': [1, 2, 3, 4, 5, 6].map((d) => ({ start: { dateTime: `2026-10-0${d}T09:00:00+01:00` }, end: { dateTime: `2026-10-0${d}T10:00:00+01:00` }, summary: `Event ${d}` })) };
  const run = (player) => buildScreens(lay, { states: { ...states(), 'media_player.bedroom': player }, calendars: cal, now: NOW, timeZone: TZ }).home;

  const playing = run(st('playing', { media_title: 'Comptine', media_artist: 'Yann Tiersen', entity_picture: '/api/media_player_proxy/media_player.bedroom?token=abc&cache=1' }));
  const right = playing.columns[1];
  assert.deepEqual(right.map((s) => s.id), ['cal', 'np']);
  assert.equal(right[1].conditional, true);
  assert.equal(right[1].data.players[0].title, 'Comptine');
  assert.equal(right[1].data.players[0].art, '/api/media_player_proxy/media_player.bedroom?cache=1'); // no rotating token
  assert.equal(right[0].data.lines.length, 2); // shrunk to make room
  assert.equal(playing.nextChangeInSec, 180);

  const paused = run(st('paused', { media_title: 'Comptine' }));
  assert.deepEqual(paused.columns[1].map((s) => s.id), ['cal']);
  assert.equal(paused.columns[1][0].data.lines.length, 5); // full height again
  assert.equal(paused.nextChangeInSec, null); // back to the normal refresh
});

test('conditional section: on an entity state, and "playing" only means something for Now playing', () => {
  const lay = dashboard.normalizeLayout({
    screens: [{ id: 's', template: 'single', columns: [[
      { id: 'a', type: 'alarm', entity: 'alarm_control_panel.home', showWhen: { mode: 'entity', entity: 'alarm_control_panel.home', cond: 'ne', value: 'disarmed', liveMin: 0 } },
      { id: 'b', type: 'people', people: [], showWhen: { mode: 'playing' } }
    ]] }]
  });
  assert.equal(lay.screens[0].columns[0][1].showWhen.mode, 'always');
  const run = (alarm) => buildScreens(lay, { states: { ...states(), 'alarm_control_panel.home': st(alarm) }, now: NOW, timeZone: TZ }).s;
  assert.deepEqual(run('armed_away').columns[0].map((s) => s.id), ['a', 'b']);
  assert.deepEqual(run('disarmed').columns[0].map((s) => s.id), ['b']);
  assert.equal(run('armed_away').nextChangeInSec, null); // liveMin 0: no extra wakes
});
