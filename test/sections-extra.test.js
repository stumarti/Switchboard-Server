'use strict';

// The guest Wi-Fi, message, bins and air quality sections.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { buildScreens, fetchInputs, deviceLayout, iconsUsed } = require('../lib/dashboard-state');
const ical = require('../lib/ical');

const TZ = 'Europe/London';
const st = (state, attributes = {}) => ({ state: String(state), attributes });

function screenOf(sections, inputs) {
  const l = dashboard.normalizeLayout({ screens: [{ id: 's', kind: 'sections', template: 'single', columns: [sections] }] });
  return { layout: l, data: buildScreens(l, { states: {}, timeZone: TZ, ...inputs }).s.columns[0].map((x) => x.data) };
}

test('guest Wi-Fi: a join QR code for the named network, the password shown or not', () => {
  const nets = [{ name: 'Home', password: 'secret' }, { name: 'Guest; 2.4', password: 'welcome:1' }];
  const { data } = screenOf([{ type: 'guestWifi', network: 'Guest; 2.4' }, { type: 'guestWifi', showPassword: false }, { type: 'guestWifi' }], { wifiNetworks: nets });
  const [guest, hidden] = data;
  assert.equal(guest.ssid, 'Guest; 2.4');
  assert.equal(guest.password, 'welcome:1');
  assert.ok(guest.qr.length >= 21 && guest.qr.every((r) => r.length === guest.qr.length && /^[01]+$/.test(r)));
  // No network named: the first. The password left off the screen, but still in the code.
  assert.equal(hidden.ssid, 'Home');
  assert.equal(hidden.password, '');
  assert.ok(hidden.qr.length > 0);
  const none = screenOf([{ type: 'guestWifi' }], { wifiNetworks: [] }).data[0];
  assert.deepEqual(none.qr, []);
  assert.match(none.empty, /No networks/);
});

test('a message fills in entity states and keeps its lines; blank when they are', () => {
  const states = { 'sensor.outside': st(12.5, { unit_of_measurement: '°C' }), 'input_text.visitor': st('Alex'), 'input_text.note': st('') };
  const { data, layout } = screenOf(
    [
      { type: 'message', text: 'Welcome, {input_text.visitor}\nIt is {sensor.outside} outside', size: 'large', align: 'center', icon: 'hand-wave' },
      { type: 'message', text: '{input_text.note}' }
    ],
    { states }
  );
  assert.deepEqual(data[0].lines, ['Welcome, Alex', 'It is 12.5°C outside']);
  assert.equal(data[0].size, 'large');
  assert.equal(data[0].align, 'center');
  assert.deepEqual(data[1].lines, []);
  assert.ok(iconsUsed(layout).includes('hand-wave'));
});

test('bins: the next collections from a calendar and a sensor, soonest first, out tonight', async () => {
  ical.clearCache();
  const LINK = 'https://example.com/bins/secret/basic.ics';
  const ICS = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:1', 'DTSTART;VALUE=DATE:20261006', 'DTEND;VALUE=DATE:20261007', 'SUMMARY:Recycling collection', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:2', 'DTSTART;VALUE=DATE:20261009', 'DTEND;VALUE=DATE:20261010', 'SUMMARY:General waste', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:3', 'DTSTART;VALUE=DATE:20261013', 'DTEND;VALUE=DATE:20261014', 'SUMMARY:Recycling collection', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => ICS });
  const l = dashboard.normalizeLayout({
    screens: [{
      id: 's', kind: 'sections', template: 'single',
      columns: [[{
        type: 'bins', calendar: LINK, count: 3,
        bins: [
          { name: 'Recycling', match: 'recycl', color: 5, icon: 'recycle' },
          { name: 'Rubbish', match: 'general, black bin' },
          { name: 'Garden', entity: 'sensor.garden_bin' },
          { name: 'Glass', match: 'glass' }
        ]
      }]]
    }]
  });
  // Monday 5 October, 18:00 BST: recycling tomorrow (out tonight), garden in 2 days.
  const now = new Date('2026-10-05T17:00:00Z');
  // (Fetched for the calendar alone: the sensor would need Home Assistant.)
  const calOnly = { ...l, screens: l.screens.map((sc) => ({ ...sc, columns: [[{ ...sc.columns[0][0], bins: sc.columns[0][0].bins.filter((b) => !b.entity) }]] })) };
  const inputs = await fetchInputs(calOnly, {}, now, { icalOpts: { fetchImpl } });
  const states = { 'sensor.garden_bin': st(2, { unit_of_measurement: 'days' }) };
  const d = buildScreens(l, { ...inputs, states, timeZone: TZ }).s.columns[0][0].data;
  assert.deepEqual(d.lines.map((x) => [x.name, x.when, x.soon]), [['Recycling', 'Tomorrow', true], ['Garden', 'Wed', false], ['Rubbish', 'Fri', false]]);
  assert.equal(d.lines[0].icon, 'recycle');
  assert.equal(d.lines[2].icon, 'trash-can-outline');
  assert.equal(d.note, 'Put out tonight: Recycling');
  // In the morning, no note yet.
  const am = buildScreens(l, { ...inputs, states, now: new Date('2026-10-05T07:00:00Z'), timeZone: TZ }).s.columns[0][0].data;
  assert.equal(am.note, '');
  // The calendar link never reaches the display.
  assert.ok(!JSON.stringify(deviceLayout(l)).includes('secret'));
});

test('air quality: readings coloured by their kind, pollen by its words, your own limits', () => {
  const states = {
    'sensor.office_co2': st(1240, { device_class: 'carbon_dioxide', unit_of_measurement: 'ppm', friendly_name: 'Office CO2' }),
    'sensor.pm25': st(8, { device_class: 'pm25', unit_of_measurement: 'µg/m³' }),
    'sensor.grass_pollen': st('very high'),
    'sensor.humidity': st(45, { device_class: 'humidity', unit_of_measurement: '%' }),
    'sensor.radon': st(150, { unit_of_measurement: 'Bq/m³' })
  };
  const d = screenOf(
    [{
      type: 'airQuality',
      items: [
        { entity: 'sensor.office_co2' },
        { entity: 'sensor.pm25', name: 'PM2.5' },
        { entity: 'sensor.grass_pollen', name: 'Grass pollen' },
        { entity: 'sensor.humidity', name: 'Humidity' },
        { entity: 'sensor.radon', name: 'Radon', fair: 100, poor: 200 }
      ]
    }],
    { states }
  ).data[0];
  assert.deepEqual(d.items.map((x) => [x.name, x.value, x.level, x.color]), [
    ['Office CO2', '1240 ppm', 'Fair', 3],
    ['PM2.5', '8 µg/m³', 'Good', 4],
    ['Grass pollen', 'Very high', '', 2],
    ['Humidity', '45%', 'Good', 4],
    ['Radon', '150 Bq/m³', 'Fair', 3]
  ]);
  assert.equal(d.worst, 'Poor');
});
