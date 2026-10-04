'use strict';

/**
 * A pretend Home Assistant with a whole example house in it, for demos and
 * the manual's screenshots: lights, blinds, speakers, a TV, an Xbox, an
 * Enigma2 box, heating, solar and a home battery, calendars and departures.
 * It answers the REST calls Switchboard Server makes (states, forecasts,
 * history, calendars, album art, and setting states for published battery
 * sensors) and nothing else.
 *
 *   node tools/demo/fake-ha.js [port]      (default 48123, token "demo-token")
 */

const http = require('http');
const sharp = require('sharp');

const PORT = Number(process.argv[2] || process.env.FAKE_HA_PORT || 48123);
const TOKEN = process.env.FAKE_HA_TOKEN || 'demo-token';
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const S = (id, state, attributes = {}, minAgo = 120) => ({ entity_id: id, state, attributes, last_changed: iso(minAgo), last_updated: iso(minAgo) });
const temp = (id, name, v) => S(id, String(v), { friendly_name: name, device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' });
const hum = (id, name, v) => S(id, String(v), { friendly_name: name, device_class: 'humidity', unit_of_measurement: '%' });
const light = (id, name, on, extra = {}) =>
  S(id, on ? 'on' : 'off', { friendly_name: name, supported_color_modes: ['color_temp', 'hs'], color_mode: on ? 'color_temp' : null, brightness: on ? 170 : null, color_temp_kelvin: on ? 3000 : null, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, ...extra });
const art = (name) => `http://127.0.0.1:${PORT}/art/${name}.png`;

const states = [
  // Weather and the house
  S('weather.home', 'partlycloudy', { friendly_name: 'Home', temperature: 16.4, apparent_temperature: 15, humidity: 68, wind_speed: 14, wind_speed_unit: 'km/h', wind_bearing: 230, temperature_unit: '°C', uv_index: 3, pressure: 1016 }),
  S('sun.sun', 'above_horizon', { friendly_name: 'Sun', next_setting: new Date(now + 5 * 3600000).toISOString() }),
  S('person.alex', 'home', { friendly_name: 'Alex' }, 300),
  S('person.sam', 'not_home', { friendly_name: 'Sam' }, 90),
  S('person.jo', 'home', { friendly_name: 'Jo' }, 40),

  // Living room: lights and scenes
  light('light.living_room', 'Living room lights', true, { effect_list: ['None', 'Candle', 'Rainbow', 'Sunrise'], effect: 'None' }),
  light('light.ceiling', 'Ceiling', true),
  light('light.floor_lamp', 'Floor lamp', true),
  light('light.reading_lamp', 'Reading lamp', false),
  light('light.shelf', 'Shelf strip', true, { effect_list: ['None', 'Candle', 'Rainbow'], effect: 'Candle' }),
  light('light.tv_backlight', 'TV backlight', false),
  light('light.window', 'Window lamp', false),
  S('scene.movie_night', 'scening', { friendly_name: 'Movie night', icon: 'mdi:movie-open' }),
  S('scene.reading', 'scening', { friendly_name: 'Reading', icon: 'mdi:book-open-variant' }),
  S('scene.relax', 'scening', { friendly_name: 'Relax', icon: 'mdi:sofa' }),
  S('scene.bright', 'scening', { friendly_name: 'Bright', icon: 'mdi:white-balance-sunny' }),
  S('scene.goodnight', 'scening', { friendly_name: 'Goodnight', icon: 'mdi:weather-night' }),

  // Blinds
  S('cover.living_room_blinds', 'open', { friendly_name: 'Living room blinds', current_position: 100, supported_features: 15, device_class: 'blind' }),
  S('cover.bay_window', 'open', { friendly_name: 'Bay window', current_position: 100, supported_features: 15, device_class: 'blind' }),
  S('cover.side_window', 'closed', { friendly_name: 'Side window', current_position: 0, supported_features: 15, device_class: 'blind' }),

  // Climate
  S('climate.living_room', 'heat', { friendly_name: 'Living room', hvac_modes: ['off', 'heat', 'auto'], hvac_action: 'heating', current_temperature: 20.5, temperature: 21, min_temp: 7, max_temp: 30, target_temp_step: 0.5 }),
  temp('sensor.living_temperature', 'Living room temperature', 20.5),
  hum('sensor.living_humidity', 'Living room humidity', 54),
  temp('sensor.hall_temperature', 'Hall temperature', 18.9),
  temp('sensor.outside_temperature', 'Outside temperature', 15.8),

  // Music, TV, Xbox, receiver
  S('media_player.living_room_speaker', 'playing', {
    friendly_name: 'Living room speaker', media_title: 'Clair de Lune', media_artist: 'Claude Debussy', media_album_name: 'Suite bergamasque',
    app_name: 'Spotify', volume_level: 0.35, is_volume_muted: false, supported_features: 152461,
    entity_picture: '/api/media_player_proxy/media_player.living_room_speaker?token=demo&cache=moon'
  }, 3),
  S('media_player.living_room_tv', 'on', { friendly_name: 'Living room TV', app_name: 'YouTube', volume_level: 0.2, is_volume_muted: false, source: 'YouTube' }),
  S('remote.living_room_tv', 'on', { friendly_name: 'Living room TV remote' }),
  S('media_player.xbox', 'playing', {
    friendly_name: 'Xbox', media_title: 'Forza Horizon 5', media_content_type: 'game', app_name: 'Forza Horizon 5',
    entity_picture: art('forza')
  }, 25),
  S('remote.xbox', 'on', { friendly_name: 'Xbox remote' }),
  S('media_player.vu_uno', 'on', {
    friendly_name: 'Vu+ Uno 4K', media_channel: 'BBC One HD', media_title: 'BBC One HD', media_series_title: 'The One Show',
    media_start_time: new Date(now - 20 * 60000).toISOString(), media_end_time: new Date(now + 10 * 60000).toISOString(),
    source: 'BBC One HD', volume_level: 0.4, is_volume_muted: false,
    source_list: ['BBC One HD', 'BBC Two HD', 'ITV1 HD', 'Channel 4 HD', 'Sky News', 'Eurosport 1', 'RTÉ One', 'TG4']
  }),

  // Quick Access toggles
  S('switch.coffee_machine', 'off', { friendly_name: 'Coffee machine', icon: 'mdi:coffee-maker' }),
  S('lock.front_door', 'locked', { friendly_name: 'Front door' }),
  S('input_boolean.guest_mode', 'off', { friendly_name: 'Guest mode' }),
  S('fan.bedroom', 'off', { friendly_name: 'Bedroom fan' }),

  // Energy (the kitchen viewport)
  S('sensor.solar_energy_today', '11.8', { friendly_name: 'Solar today', unit_of_measurement: 'kWh' }),
  S('sensor.solar_forecast_today', '18.5', {
    friendly_name: 'Solar forecast today', unit_of_measurement: 'kWh',
    detailedForecast: Array.from({ length: 48 }, (_, i) => {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      const h = i / 2;
      return { period_start: new Date(d.getTime() + i * 1800000).toISOString(), pv_estimate: Math.max(0, Math.round(3.2 * Math.sin(((h - 6) / 13) * Math.PI) * 100) / 100) };
    })
  }),
  S('sensor.home_consumption_today', '9.1', { friendly_name: 'Home use today', unit_of_measurement: 'kWh' }),
  S('sensor.grid_export_today', '3.4', { friendly_name: 'Exported today', unit_of_measurement: 'kWh' }),
  S('sensor.grid_import_today', '0.6', { friendly_name: 'Imported today', unit_of_measurement: 'kWh' }),
  S('sensor.battery_soc', '87', { friendly_name: 'Home battery', unit_of_measurement: '%', device_class: 'battery' }),
  S('sensor.battery_status', 'charging', { friendly_name: 'Home battery status' }),
  S('sensor.battery_time_to_full', '1h 10m', { friendly_name: 'Home battery time to full' }),
  S('sensor.solar_power', '2400', { friendly_name: 'Solar power', unit_of_measurement: 'W' }),
  S('sensor.home_power', '900', { friendly_name: 'Home power', unit_of_measurement: 'W' }),
  S('sensor.grid_import_power', '0', { friendly_name: 'Grid import power', unit_of_measurement: 'W' }),
  S('sensor.grid_export_power', '1500', { friendly_name: 'Grid export power', unit_of_measurement: 'W' }),
  S('sensor.battery_charge_power', '700', { friendly_name: 'Battery charge power', unit_of_measurement: 'W' }),
  S('sensor.battery_discharge_power', '0', { friendly_name: 'Battery discharge power', unit_of_measurement: 'W' }),

  // Status icons and security
  S('alarm_control_panel.home', 'disarmed', { friendly_name: 'Home alarm' }, 45),
  S('binary_sensor.any_door_open', 'on', { friendly_name: 'Any door', device_class: 'door' }),
  S('binary_sensor.any_window_open', 'off', { friendly_name: 'Any window', device_class: 'window' }),
  S('sensor.plant_watering_status', 'due', { friendly_name: 'Plants' }),
  S('binary_sensor.heating_active', 'on', { friendly_name: 'Heating' }),
  S('binary_sensor.hot_water_active', 'off', { friendly_name: 'Hot water' }),
  S('vacuum.downstairs', 'cleaning', { friendly_name: 'Downstairs vacuum' }),
  S('vacuum.upstairs', 'docked', { friendly_name: 'Upstairs vacuum' }),
  S('lawn_mower.garden', 'docked', { friendly_name: 'Garden mower' }),
  S('binary_sensor.front_door', 'on', { friendly_name: 'Front door', device_class: 'door' }, 4),
  S('binary_sensor.back_door', 'off', { friendly_name: 'Back door', device_class: 'door' }, 300),
  S('binary_sensor.kitchen_window', 'off', { friendly_name: 'Kitchen window', device_class: 'window' }, 200),
  S('binary_sensor.hall_motion', 'off', { friendly_name: 'Hall motion', device_class: 'motion' }, 8),
  S('binary_sensor.garden_motion', 'on', { friendly_name: 'Garden motion', device_class: 'motion' }, 1),

  // Heat pump and rooms
  S('climate.heat_pump', 'heat', { friendly_name: 'Heat pump', hvac_action: 'heating', temperature: 21, current_temperature: 19.4 }),
  S('sensor.heat_pump_cop', '3.8', { friendly_name: 'Heat pump COP' }),
  temp('sensor.main_bed_temperature', 'Main bedroom', 21.3), hum('sensor.main_bed_humidity', 'Main bedroom', 58),
  temp('sensor.guest_temperature', 'Guest room', 18.8), hum('sensor.guest_humidity', 'Guest room', 52),
  temp('sensor.bathroom_temperature', 'Bathroom', 23.1), hum('sensor.bathroom_humidity', 'Bathroom', 71),
  temp('sensor.office_temperature', 'Office', 19.5), hum('sensor.office_humidity', 'Office', 55),
  temp('sensor.kitchen_temperature', 'Kitchen', 20.1), hum('sensor.kitchen_humidity', 'Kitchen', 60),

  // Departures (minutes, or a time)
  S('sensor.bus_42_next', new Date(now + 3 * 60000).toISOString(), { friendly_name: '42 next', device_class: 'timestamp' }),
  S('sensor.bus_42_next2', '20', { unit_of_measurement: 'min' }),
  S('sensor.train_next', '9', { unit_of_measurement: 'min' }), S('sensor.train_next2', '39', { unit_of_measurement: 'min' }),
  S('sensor.bus_7_next', '31', { unit_of_measurement: 'min' }), S('sensor.bus_7_next2', '47', { unit_of_measurement: 'min' }),

  // Calendars (the family one, and the office's meeting rooms)
  S('calendar.family', 'off', { friendly_name: 'Family' }),
  S('calendar.boardroom', 'on', { friendly_name: 'Boardroom' }),
  S('binary_sensor.boardroom_occupied', 'on', { friendly_name: 'Boardroom occupancy', device_class: 'occupancy' }, 25),
  S('climate.boardroom', 'heat', { friendly_name: 'Boardroom', current_temperature: 21.6, temperature: 21 }),
  S('sensor.boardroom_co2', '1180', { friendly_name: 'Boardroom CO2', unit_of_measurement: 'ppm', device_class: 'carbon_dioxide' }),
  S('sensor.boardroom_humidity', '48', { friendly_name: 'Boardroom humidity', unit_of_measurement: '%' }),
  S('calendar.focus', 'off', { friendly_name: 'Focus room' }),
  // The kitchen dashboard (the viewport's default layout) and its entities.
  S('sensor.solar_generation', '11.8', { friendly_name: 'Solar generation', unit_of_measurement: 'kWh' }),
  S('sensor.load_today', '9.1', { friendly_name: 'Load today', unit_of_measurement: 'kWh' }),
  S('sensor.grid_import', '0.6', { friendly_name: 'Grid import', unit_of_measurement: 'kWh' }),
  S('sensor.grid_export', '3.4', { friendly_name: 'Grid export', unit_of_measurement: 'kWh' }),
  S('sensor.battery_power', '-1250', { friendly_name: 'Battery power', unit_of_measurement: 'W' }),
  S('sensor.battery_charge_eta', new Date(now + 70 * 60000).toISOString(), { friendly_name: 'Battery full at', device_class: 'timestamp' }),
  S('sensor.battery_discharge_eta', 'unknown', { friendly_name: 'Battery empty at', device_class: 'timestamp' }),
  S('sensor.home_alarm_state', 'disarmed', { friendly_name: 'Alarm state' }, 300),
  S('sensor.home_alarm_event', 'Disarmed by Alex at the front door', { friendly_name: 'Alarm event' }, 300),
  S('alarm_control_panel.home_alarm', 'disarmed', { friendly_name: 'Home alarm' }, 300),
  S('climate.whole_house', 'heat', { friendly_name: 'Whole house', current_temperature: 19.6, temperature: 20.5, active_member_count: 8 }),
  S('water_heater.home_tank', 'eco', { friendly_name: 'Hot water', operation_mode: 'heating', current_temperature: 47.6, temperature: 55 }),
  ...[
    ['kitchen', 'Kitchen', 19.4, 21, 'heat'], ['living_room', 'Living Room', 20.5, 21, 'heat'], ['hall', 'Hall', 17.2, 18.5, 'auto'],
    ['bathroom', 'Bathroom', 21.8, 22, 'heat'], ['landing', 'Landing', 18.1, 18, 'heat'], ['bedroom', 'Bedroom', 18.6, 18, 'heat'],
    ['bedroom_2', 'Bedroom 2', 17.9, 16, 'off'], ['office', 'Office', 20.2, 20, 'heat']
  ].map(([k, name, cur, tgt, mode]) => S(`climate.${k}`, mode, { friendly_name: name, current_temperature: cur, temperature: tgt })),
  ...['side', 'living_room', 'kitchen', 'office_left', 'office_right', 'bedroom_left', 'bedroom_right'].map((w, i) => S(`binary_sensor.window_${w}`, i === 1 ? 'on' : 'off', { device_class: 'window' }, 40 + i * 30)),
  S('sensor.plant_soil_moisture', 'Almost Dry', { friendly_name: 'House plant' }),
  S('vacuum.vacuum1', 'cleaning', { friendly_name: 'Vacuum 1' }, 12),
  S('sensor.vacuum1_battery', '72', { unit_of_measurement: '%' }),
  S('binary_sensor.vacuum1_charging', 'off'),
  S('vacuum.vacuum2', 'docked', { friendly_name: 'Vacuum 2' }),
  S('sensor.vacuum2_battery', '100', { unit_of_measurement: '%' }),
  S('lawn_mower.mower', 'docked', { friendly_name: 'Mower' }),
  S('sensor.mower_battery', '64', { unit_of_measurement: '%' }),
  S('binary_sensor.mower_charging', 'on'),
  ...[['front_door_motion', 3], ['hall_motion', 8], ['landing_motion', 95], ['recessed_landing_motion', 180], ['back_garden_motion', 1]].map(([m, ago]) => S(`binary_sensor.${m}`, ago < 5 ? 'on' : 'off', { device_class: 'motion' }, ago)),
  ...[['camera_front_motion', 22], ['camera_back_motion', 140], ['camera_kitchen_motion', 61], ['doorbell_recent_motion', 3]].map(([m, ago]) => S(`binary_sensor.${m}`, ago < 5 ? 'on' : 'off', { device_class: 'motion' }, ago)),
  S('calendar.home_schedule', 'off', { friendly_name: 'Home schedule' }),
  S('calendar.work', 'off', { friendly_name: 'Work' }),
  S('calendar.birthdays', 'off', { friendly_name: 'Birthdays' }),
  S('calendar.holidays', 'off', { friendly_name: 'Holidays' }),
  S('calendar.quiet', 'off', { friendly_name: 'Quiet room' }),
  S('calendar.huddle', 'off', { friendly_name: 'Huddle' }),
  S('binary_sensor.huddle_occupied', 'on', { friendly_name: 'Huddle occupancy', device_class: 'occupancy' }, 5)
].reduce((list, st) => {
  // One state per entity, as in a real Home Assistant: an entity listed
  // again (the kitchen dashboard's zones and sensors reuse a few of the
  // rooms') merges into the first.
  const first = list.find((x) => x.entity_id === st.entity_id);
  if (!first) list.push(st);
  else Object.assign(first, { ...st, attributes: { ...first.attributes, ...st.attributes } });
  return list;
}, []);
const byId = Object.fromEntries(states.map((s) => [s.entity_id, s]));

// Pictures: album art, box art. Drawn as SVG, so there's nothing to ship.
const PICTURES = {
  moon: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#1c2540"/>
    <circle cx="320" cy="160" r="90" fill="#f3ecd2"/><circle cx="290" cy="140" r="16" fill="#d9d0b0"/><circle cx="350" cy="190" r="10" fill="#d9d0b0"/>
    <path d="M0 360 Q120 300 240 350 T480 330 V480 H0 Z" fill="#3b4a6b"/><text x="40" y="440" font-family="serif" font-size="44" fill="#f3ecd2">DEBUSSY</text></svg>`,
  forza: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#f6c143"/>
    <rect y="300" width="480" height="180" fill="#3c3c3c"/><path d="M60 300 Q240 170 420 300 Z" fill="#d6452b"/>
    <circle cx="140" cy="310" r="40" fill="#111"/><circle cx="340" cy="310" r="40" fill="#111"/>
    <text x="40" y="440" font-family="sans-serif" font-weight="bold" font-size="54" fill="#fff">FORZA 5</text></svg>`,
  halo: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#3b5f7a"/>
    <circle cx="240" cy="200" r="130" fill="none" stroke="#e6f0f5" stroke-width="30"/><rect y="360" width="480" height="120" fill="#16222c"/>
    <text x="40" y="440" font-family="sans-serif" font-weight="bold" font-size="54" fill="#fff">HALO</text></svg>`,
  minecraft: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#7cc4f0"/>
    <rect y="260" width="480" height="80" fill="#5fa640"/><rect y="340" width="480" height="140" fill="#8a5a33"/>
    <rect x="80" y="180" width="80" height="80" fill="#2e7d32"/><rect x="300" y="200" width="60" height="60" fill="#9e9e9e"/></svg>`,
  starfield: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#101522"/>
    <circle cx="330" cy="160" r="90" fill="#d9a441"/><circle cx="80" cy="80" r="3" fill="#fff"/><circle cx="200" cy="60" r="2" fill="#fff"/>
    <circle cx="420" cy="380" r="3" fill="#fff"/><text x="40" y="440" font-family="sans-serif" font-size="46" fill="#fff">STARFIELD</text></svg>`,
  sea: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="#aee0e8"/>
    <path d="M0 300 Q120 250 240 300 T480 300 V480 H0 Z" fill="#1d6e8c"/><circle cx="360" cy="120" r="60" fill="#fff4c2"/></svg>`
};
const pictureCache = {};
async function picture(name) {
  if (!pictureCache[name]) pictureCache[name] = await sharp(Buffer.from(PICTURES[name] || PICTURES.sea)).png().toBuffer();
  return pictureCache[name];
}

const HISTORY = {
  'sensor.solar_power': (h) => Math.max(0, 3000 * Math.sin(((h - 6) / 13) * Math.PI)),
  'sensor.home_power': (h) => 400 + (h > 7 && h < 9 ? 1800 : 0) + (h > 17 && h < 20 ? 2200 : 0),
  'sensor.grid_import_power': (h) => (h < 2 || h > 21 ? 450 : h > 7 && h < 8.5 ? 900 : 0),
  'sensor.grid_export_power': (h) => Math.max(0, 3000 * Math.sin(((h - 6) / 13) * Math.PI) - 1400),
  'sensor.battery_discharge_power': (h) => (h >= 2 && h < 7 ? 400 : h >= 7 && h < 8.5 ? 600 : 0),
  'sensor.battery_charge_power': (h) => Math.max(0, Math.min(700, 3000 * Math.sin(((h - 6) / 13) * Math.PI) - 700))
};

function calendar(id) {
  const t0 = Math.floor(now / 1800000) * 1800000;
  const at = (m) => new Date(t0 + m * 60000).toISOString();
  const day = (d) => new Date(now + d * 86400000).toISOString().slice(0, 10);
  const ev = (from, to, summary) => ({ start: { dateTime: at(from) }, end: { dateTime: at(to) }, summary });
  switch (id) {
    case 'calendar.family':
      return [ev(270, 330, 'Football practice'), { start: { date: day(1) }, end: { date: day(2) }, summary: 'Bin day: recycling' }, ev(1500, 1560, 'Dentist'), ev(2940, 3060, "Sam's birthday dinner")];
    case 'calendar.home_schedule':
      return [ev(-300, -270, 'School run'), ev(270, 330, 'Football practice')];
    case 'calendar.work':
      return [{ ...ev(60, 90, 'Weekly planning'), description: 'Agenda in the shared drive, bring the roadmap' }];
    case 'calendar.birthdays':
      return [{ start: { date: day(0) }, end: { date: day(1) }, summary: "Gran's birthday" }];
    case 'calendar.boardroom':
      return [ev(-30, 30, 'Quarterly review'), ev(30, 60, 'Design sync'), ev(180, 240, 'Hiring panel')];
    case 'calendar.focus':
      return [ev(60, 120, 'Focus time')];
    case 'calendar.huddle':
      return [ev(-15, 45, 'Stand-up')];
    default:
      return [];
  }
}

http.createServer((req, res) => {
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const png = (buf) => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length }); res.end(buf); };
  const url = new URL(req.url, 'http://ha');
  if (url.pathname === '/feed.xml') {
    const item = (h, title, summary) => `<item><title>${title}</title><description>${summary}</description><pubDate>${new Date(now - h * 3600000).toUTCString()}</pubDate><link>http://intranet.example/news</link></item>`;
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Company news</title>${[
      item(2, 'New bike shelter opens on Monday', 'Forty covered spaces behind building B, with charging for e-bikes.'),
      item(26, 'All-hands moves to Thursday', 'Same time, 10:00, in the atrium. Questions to the people team.'),
      item(70, 'Fire drill this Friday at 11:00', 'Leave by the nearest exit and meet at the car park.')
    ].join('')}</channel></rss>`);
  }
  // A calendar link, as Google, Outlook or iCloud publish one (no token: the
  // address is the secret): the Quiet room's bookings, including a daily
  // stand-up that repeats.
  if (url.pathname === '/ical/quiet-room.ics') {
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const t0 = Math.floor(now / 1800000) * 1800000;
    const ev = (uid, from, to, summary, extra = []) => ['BEGIN:VEVENT', `UID:${uid}@demo`, `DTSTART:${stamp(t0 + from * 60000)}`, `DTEND:${stamp(t0 + to * 60000)}`, `SUMMARY:${summary}`, ...extra, 'END:VEVENT'];
    res.writeHead(200, { 'content-type': 'text/calendar' });
    return res.end([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Demo//EN', 'X-WR-CALNAME:Quiet room',
      ...ev('standup', -24 * 60 * 7 + 90, -24 * 60 * 7 + 105, 'Daily stand-up', ['RRULE:FREQ=DAILY']),
      ...ev('1on1', 150, 180, '1:1'),
      'END:VCALENDAR'
    ].join('\r\n'));
  }
  if (url.pathname.startsWith('/art/')) return picture(url.pathname.slice(5).replace(/\.png$/, '')).then(png);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
  if (url.pathname.startsWith('/api/media_player_proxy/')) return picture(url.searchParams.get('cache') || 'sea').then(png);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (url.pathname === '/api/' || url.pathname === '/api') return json({ message: 'API running.' });
    if (url.pathname === '/api/config') return json({ location_name: 'Demo house', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, unit_system: { temperature: '°C' }, version: '2026.9.0' });
    if (url.pathname === '/api/states') return json(states);
    if (url.pathname.startsWith('/api/states/')) {
      const id = decodeURIComponent(url.pathname.slice(12));
      // Set or remove a state, as Switchboard's battery publishing does.
      if (req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        const st = S(id, String(b.state), b.attributes || {}, 0);
        if (!byId[id]) states.push(st);
        else states[states.indexOf(byId[id])] = st;
        byId[id] = st;
        return json(st, 201);
      }
      if (req.method === 'DELETE') {
        if (!byId[id]) return json({ message: 'Entity not found.' }, 404);
        states.splice(states.indexOf(byId[id]), 1);
        delete byId[id];
        return json({ message: 'Entity removed.' });
      }
      const st = byId[id];
      return st ? json(st) : json({ message: 'Entity not found.' }, 404);
    }
    if (url.pathname.startsWith('/api/services/weather/get_forecasts')) {
      const b = JSON.parse(body || '{}');
      const conds = ['partlycloudy', 'rainy', 'sunny', 'cloudy', 'sunny', 'partlycloudy', 'rainy'];
      const forecast = b.type === 'hourly'
        ? [0, 1, 2, 3, 4, 5].map((h) => ({ datetime: new Date(Math.floor(now / 3600000) * 3600000 + h * 3600000).toISOString(), condition: h > 3 ? 'rainy' : 'partlycloudy', temperature: 16 - h * 0.4, precipitation: h > 3 ? 1.2 : 0, precipitation_probability: h > 3 ? 70 : 10 }))
        : conds.map((c, d) => ({ datetime: new Date(now + d * 86400000).toISOString(), condition: c, temperature: 17 + (d % 3), templow: 9 + (d % 2) }));
      return json({ service_response: { [b.entity_id]: { forecast } } });
    }
    if (url.pathname.startsWith('/api/services/')) return json([]);
    if (url.pathname === '/api/calendars') return json(states.filter((s) => s.entity_id.startsWith('calendar.')).map((s) => ({ entity_id: s.entity_id, name: s.attributes.friendly_name })));
    if (url.pathname.startsWith('/api/calendars/')) return json(calendar(decodeURIComponent(url.pathname.slice(15))));
    if (url.pathname.startsWith('/api/history/period/')) {
      const start = Date.parse(decodeURIComponent(url.pathname.split('/').pop()));
      const ids = (url.searchParams.get('filter_entity_id') || '').split(',');
      return json(ids.filter((id) => HISTORY[id]).map((id) => {
        const pts = [];
        for (let t = start; t <= now; t += 15 * 60000) {
          const d = new Date(t);
          pts.push({ state: String(Math.round(HISTORY[id](d.getHours() + d.getMinutes() / 60))), last_changed: d.toISOString() });
        }
        pts[0].entity_id = id;
        return pts;
      }));
    }
    json({ message: 'Not found' }, 404);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Fake Home Assistant on http://127.0.0.1:${PORT} (token ${TOKEN})`));
