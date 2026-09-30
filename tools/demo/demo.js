'use strict';

/**
 * A demo Switchboard: the pretend Home Assistant (fake-ha.js) and this
 * server, on a throwaway data folder, seeded with a house's rooms, remotes,
 * wall displays, battery history and a firmware release. For trying the
 * admin UI without any hardware, and for the manual's screenshots
 * (screenshots.js here, and the firmware repo's tools/screenshots).
 *
 *   node tools/demo/demo.js            admin UI on http://localhost:45680, password "demo"
 *
 * Environment: DEMO_PORT (45680), FAKE_HA_PORT (48123), DEMO_DATA (a new
 * temp folder). Ctrl-C stops both.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.DEMO_PORT || 45680);
const HA_PORT = Number(process.env.FAKE_HA_PORT || 48123);
const DATA = process.env.DEMO_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-demo-'));
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'demo';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Every device in the house: remotes by room, and the wall displays.
const REMOTES = [
  { mac: 'a0:b1:c2:00:00:01', name: 'Living room remote', room: 'living-room', battery: 82, rssi: -54, drainPerDay: 1.6 },
  { mac: 'a0:b1:c2:00:00:02', name: 'Sofa remote', room: 'living-room', battery: 64, rssi: -61, drainPerDay: 2.1 },
  { mac: 'a0:b1:c2:00:00:03', name: 'Kitchen remote', room: 'kitchen', battery: 18, rssi: -67, drainPerDay: 3.2 },
  { mac: 'a0:b1:c2:00:00:04', name: 'Bedroom remote', room: 'bedroom', battery: 91, rssi: -72, drainPerDay: 1.1 }
];
const VIEWPORTS = [
  { mac: 'a0:b1:c2:00:01:01', name: 'Kitchen panel', layout: 'kitchen-panel', battery: 76, rssi: -58, drainPerDay: 2.4 },
  { mac: 'a0:b1:c2:00:01:02', name: 'Boardroom sign', layout: 'boardroom', battery: 57, rssi: -63, drainPerDay: 1.8 }
];
const PENDING = { mac: 'a0:b1:c2:00:00:09' };
const FIRMWARE = { current: 'v1.3.0', release: 'v1.4.0' };

function start(label, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.DEMO_VERBOSE && process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  return child;
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`${url} never came up`);
}

let cookie = '';
async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers.authorization ? {} : { cookie }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (!res.ok && res.status !== 304) throw new Error(`${method} ${url}: ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Weeks of battery readings, so Home shows the days each device has left.
function batteryHistory() {
  const now = Date.now();
  const devices = {};
  for (const d of [...REMOTES, ...VIEWPORTS]) {
    const samples = [];
    const days = Math.min(20, (100 - d.battery) / d.drainPerDay);
    for (let t = now - days * DAY; t <= now - HOUR; t += HOUR) {
      samples.push({ t, p: Math.round(d.battery + ((now - t) / DAY) * d.drainPerDay) });
    }
    devices[d.mac] = { samples, learnedRate: d.drainPerDay * 1.05, discharges: 3, lastChargedAt: samples[0].t };
  }
  fs.writeFileSync(path.join(DATA, '_battery-history.json'), JSON.stringify({ devices }));
}

// A minimal image the server accepts as a Switchboard remote build (the
// firmware repo's release workflow makes real ones).
function firmwareImage(version) {
  const b = Buffer.alloc(200 * 1024, 0xff);
  b[0] = 0xe9;
  b.writeUInt16LE(9, 12);
  b.writeUInt32LE(0xabcd5432, 32);
  b.write(`SWITCHBOARD_FW:${version}\0`, 4096, 'latin1');
  return b;
}

async function room(name, patch) {
  const created = await api('POST', '/api/devices', { name });
  const current = await api('GET', `/api/devices/${created.slug}/config`);
  await api('POST', `/api/devices/${created.slug}/config`, { ...current, ...patch });
  return created.slug;
}

async function seed() {
  await api('POST', '/api/auth/setup', { password: PASSWORD }).catch(() => api('POST', '/api/auth/login', { password: PASSWORD }));
  await api('POST', '/api/globals', {
    homeAssistant: { host: '127.0.0.1', port: HA_PORT, token: 'demo-token', publishBattery: true },
    wifi: { ssid: 'Home', password: 'correct-horse' },
    wifiNetworks: [
      { name: 'Home', password: 'correct-horse' },
      { name: 'Home-Guest', password: 'welcome-in' }
    ],
    ntpServer: 'pool.ntp.org'
  });

  const light = (name, entity, icon = '', extra = {}) => ({ name, entity, icon, controls: { brightness: true, colorTemp: true, color: false, effects: false, ...extra } });
  const scene = (name, entity, icon) => ({ name, entity, icon });
  await room('Living Room', {
    description: 'Sofa, TV and the bay window',
    standby: { weatherEntity: 'weather.home', climateEntity: 'climate.living_room', refreshIntervalMin: 30, refreshAligned: true },
    lighting: {
      group: { enabled: true, name: 'All lights', entity: 'light.living_room', controls: { brightness: true, colorTemp: true, color: true, effects: true } },
      lights: [
        light('Ceiling', 'light.ceiling', 'ceiling-light'),
        light('Floor lamp', 'light.floor_lamp', 'floor-lamp'),
        light('Reading', 'light.reading_lamp', 'desk-lamp'),
        light('Shelf', 'light.shelf', 'led-strip-variant', { color: true, effects: true }),
        light('TV glow', 'light.tv_backlight', 'television-ambient-light'),
        light('Window', 'light.window', 'lamp')
      ],
      scenes: [
        scene('Movie night', 'scene.movie_night', 'movie-open'),
        scene('Reading', 'scene.reading', 'book-open-variant'),
        scene('Relax', 'scene.relax', 'sofa'),
        scene('Bright', 'scene.bright', 'white-balance-sunny'),
        scene('Goodnight', 'scene.goodnight', 'weather-night')
      ]
    },
    blinds: {
      group: { enabled: true, name: 'All blinds', entity: 'cover.living_room_blinds' },
      items: [
        { name: 'Bay window', entity: 'cover.bay_window', icon: 'blinds' },
        { name: 'Side window', entity: 'cover.side_window', icon: 'blinds' }
      ]
    },
    screens: { lighting: true, climate: true, blinds: true, music: true, tv: true, xbox: true, receiver: true, wifi: true, order: [] },
    media: { enabled: true, name: 'Living room speaker', entity: 'media_player.living_room_speaker' },
    climate: {
      entity: 'climate.living_room',
      additionalSensors: [
        { name: 'Hall', entity: 'sensor.hall_temperature' },
        { name: 'Outside', entity: 'sensor.outside_temperature' }
      ]
    },
    tv: {
      mediaPlayerEntity: 'media_player.living_room_tv',
      remoteEntity: 'remote.living_room_tv',
      appList: [
        { name: 'YouTube', launch: 'com.google.android.youtube.tv', icon: 'youtube' },
        { name: 'Netflix', launch: 'com.netflix.ninja', icon: 'netflix' },
        { name: 'Plex', launch: 'com.plexapp.android', icon: 'plex' },
        { name: 'Spotify', launch: 'com.spotify.tv.android', icon: 'spotify' }
      ]
    },
    xbox: {
      enabled: true,
      name: 'Xbox',
      mediaPlayerEntity: 'media_player.xbox',
      remoteEntity: 'remote.xbox',
      listSource: 'configured',
      games: [
        { name: 'Forza Horizon 5', productId: '9NKX70BBCDRN', art: `http://127.0.0.1:${HA_PORT}/art/forza.png` },
        { name: 'Halo Infinite', productId: '9PP5G1F0C2B6', art: `http://127.0.0.1:${HA_PORT}/art/halo.png` },
        { name: 'Minecraft', productId: '9NBLGGH2JHXJ', art: `http://127.0.0.1:${HA_PORT}/art/minecraft.png` },
        { name: 'Starfield', productId: '9NCJSXWZTP88', art: `http://127.0.0.1:${HA_PORT}/art/starfield.png` }
      ]
    },
    receiver: {
      name: 'Vu+ Uno',
      mediaPlayerEntity: 'media_player.vu_uno',
      boxUrl: '',
      channels: [
        { name: 'BBC One', source: 'BBC One HD', icon: 'television-classic' },
        { name: 'BBC Two', source: 'BBC Two HD', icon: 'television-classic' },
        { name: 'ITV1', source: 'ITV1 HD', icon: 'television-classic' },
        { name: 'Channel 4', source: 'Channel 4 HD', icon: 'television-classic' },
        { name: 'Sky News', source: 'Sky News', icon: 'newspaper-variant-outline' },
        { name: 'Eurosport', source: 'Eurosport 1', icon: 'soccer' }
      ]
    },
    hub: {
      quickActionsEnabled: true,
      items: [
        { name: 'Lights', icon: 'lightbulb-group-outline', target: 'lighting', action: { type: 'toggle', entity: 'light.living_room' } },
        { name: 'Blinds', icon: 'blinds', target: 'blinds', action: { type: 'toggle', entity: 'cover.living_room_blinds' } },
        { name: 'Music', icon: 'music-circle-outline', target: 'media', action: { type: 'toggle', entity: 'media_player.living_room_speaker' } },
        { name: 'TV', icon: 'television', target: 'tv', action: { type: 'none' } },
        { name: 'Coffee', icon: 'coffee-maker', target: '', action: { type: 'toggle', entity: 'switch.coffee_machine' } },
        { name: 'Front door', icon: 'lock', target: '', action: { type: 'toggle', entity: 'lock.front_door' } },
        { name: 'Movie night', icon: 'movie-open', target: '', action: { type: 'run', service: 'scene.turn_on', entity: 'scene.movie_night' } },
        { name: 'Settings', icon: 'cog-outline', target: 'settings', action: { type: 'none' } }
      ]
    }
  });
  await room('Kitchen', {
    standby: { weatherEntity: 'weather.home', climateEntity: 'climate.living_room', refreshIntervalMin: 30 },
    lighting: { group: { enabled: true, name: 'Kitchen lights', entity: 'light.living_room', controls: { brightness: true, colorTemp: true } }, lights: [], scenes: [scene('Bright', 'scene.bright', 'white-balance-sunny')] },
    screens: { lighting: true, climate: true, blinds: false, music: true, tv: false, xbox: false, receiver: false },
    media: { enabled: true, name: 'Kitchen speaker', entity: 'media_player.living_room_speaker' },
    climate: { entity: 'climate.living_room', additionalSensors: [] }
  });
  await room('Bedroom', {
    standby: { weatherEntity: 'weather.home', climateEntity: 'climate.living_room', refreshIntervalMin: 60 },
    screens: { lighting: true, climate: true, blinds: true, music: true, tv: false, xbox: false, receiver: false }
  });

  // Wall displays: the kitchen panel, and a meeting-room sign.
  const kitchen = await api('POST', '/api/dashboards', { name: 'Kitchen panel', template: 'kitchen' });
  const k = await api('GET', `/api/dashboards/${kitchen.slug}`);
  const home = k.layout.screens.find((s) => s.id === 'home');
  const cal = home.columns[1].find((s) => s.type === 'calendar');
  if (cal) cal.entities = ['calendar.family'];
  const climate = k.layout.screens.find((s) => s.id === 'climate');
  const hp = climate && climate.columns[0].find((s) => s.type === 'heatPump');
  if (hp) Object.assign(hp, { outsideTemperature: 'sensor.outside_temperature', cop: 'sensor.heat_pump_cop' });
  const presence = k.layout.screens.find((s) => s.id === 'presence');
  if (presence) {
    const people = presence.columns[1].find((s) => s.type === 'people');
    if (people) people.people = [{ entity: 'person.alex', name: 'Alex' }, { entity: 'person.sam', name: 'Sam' }, { entity: 'person.jo', name: 'Jo' }];
    const media = presence.columns[1].find((s) => s.type === 'media');
    if (media) media.players = [{ entity: 'media_player.living_room_speaker', name: 'Living room' }];
  }
  const security = k.layout.screens.find((s) => s.id === 'security');
  if (security) {
    const [left, right] = security.columns;
    const doors = left.find((s) => s.title === 'Doors');
    if (doors) doors.items = [{ entity: 'binary_sensor.front_door', name: 'Front door' }, { entity: 'binary_sensor.back_door', name: 'Back door' }];
    const windows = left.find((s) => s.title === 'Windows');
    if (windows) windows.items = [{ entity: 'binary_sensor.kitchen_window', name: 'Kitchen window' }];
    const motion = right.find((s) => s.type === 'motion');
    if (motion) motion.sensors = [{ entity: 'binary_sensor.hall_motion', name: 'Hall' }, { entity: 'binary_sensor.garden_motion', name: 'Garden' }];
  }
  await api('PUT', `/api/dashboards/${kitchen.slug}`, { name: 'Kitchen panel', layout: k.layout });

  const board = await api('POST', '/api/dashboards', { name: 'Boardroom', template: 'meetingRoom' });
  const b = await api('GET', `/api/dashboards/${board.slug}`);
  const meeting = b.layout.screens.find((s) => s.kind === 'meetingRoom');
  Object.assign(meeting.meeting, {
    calendar: 'calendar.boardroom', name: 'Boardroom', occupancy: 'binary_sensor.boardroom_occupied', timelineHours: 3,
    climate: { show: true, temperature: 'climate.boardroom', humidity: 'sensor.boardroom_humidity', co2: 'sensor.boardroom_co2' }
  });
  const finder = b.layout.screens.find((s) => s.kind === 'roomFinder');
  finder.finder.rooms = [
    { calendar: 'calendar.focus', name: 'Focus room' },
    { calendar: 'calendar.quiet', name: 'Quiet room' },
    { calendar: 'calendar.huddle', name: 'Huddle', occupancy: 'binary_sensor.huddle_occupied' }
  ];
  await api('PUT', `/api/dashboards/${board.slug}`, { name: 'Boardroom', layout: b.layout });

  const office = await api('POST', '/api/dashboards', { name: 'Reception', template: 'blank' });
  const o = await api('GET', `/api/dashboards/${office.slug}`);
  o.layout.screens[0].title = 'Reception';
  o.layout.screens[0].template = 'sidebar';
  o.layout.screens[0].columns = [
    [{ type: 'weather', entity: 'weather.home' }, { type: 'calendar', entities: ['calendar.boardroom'], days: 1, lines: 4 }],
    [{ type: 'announcements', title: 'Company news', url: `http://127.0.0.1:${HA_PORT}/feed.xml`, count: 3 }]
  ];
  await api('PUT', `/api/dashboards/${office.slug}`, { name: 'Reception', layout: o.layout });

  // Pair every device, and have each check in once with its health.
  const tokens = {};
  for (const d of [...REMOTES, ...VIEWPORTS]) {
    const type = d.layout ? 'viewport' : 'remote';
    await api('POST', '/api/pairing/register', { mac: d.mac, type });
    await api('POST', `/api/pairing/${encodeURIComponent(d.mac)}/approve`, { slug: d.room || '' });
    await api('POST', `/api/pairing/${encodeURIComponent(d.mac)}/rename`, { name: d.name });
    await api('PUT', `/api/clients/${encodeURIComponent(d.mac)}`, d.layout ? { type, dashboard: d.layout } : { type, room: d.room });
    tokens[d.mac] = (await api('POST', '/api/pairing/register', { mac: d.mac, type })).token;
  }
  await api('POST', '/api/pairing/register', { mac: PENDING.mac, type: 'remote' });

  // Remote updates: two builds, the new one out to the pilot remote so far.
  await api('POST', '/api/firmware/upload', firmwareImage(FIRMWARE.current), { 'content-type': 'application/octet-stream' });
  await api('POST', '/api/firmware/upload', firmwareImage(FIRMWARE.release), { 'content-type': 'application/octet-stream' });
  await api('PUT', '/api/firmware/settings', { enabled: true, release: FIRMWARE.release, pilot: [REMOTES[0].mac], schedule: { enabled: true, fromHour: 2, toHour: 5 } });

  for (const d of [...REMOTES, ...VIEWPORTS]) {
    const fw = d.layout ? 'v0.9.2' : d === REMOTES[0] ? FIRMWARE.release : FIRMWARE.current;
    const headers = { authorization: `Bearer ${tokens[d.mac]}`, 'x-battery': String(d.battery), 'x-rssi': String(d.rssi), 'x-firmware': fw };
    if (d.layout) await api('GET', '/api/viewports/me/bundle', undefined, headers);
    else await api('GET', `/api/devices/${d.room}/bundle`, undefined, headers);
  }
  await api('POST', '/api/firmware/report', { version: FIRMWARE.release, from: FIRMWARE.current, ok: true }, { authorization: `Bearer ${tokens[REMOTES[0].mac]}` });
}

const children = [];
async function main() {
  batteryHistory();
  const ha = start('ha', [path.join(__dirname, 'fake-ha.js'), String(HA_PORT)]);
  await waitFor(`http://127.0.0.1:${HA_PORT}/api/`);
  const server = start('server', ['server.js'], { PORT: String(PORT), DATA_DIR: DATA, DISABLE_MDNS: '1', ADMIN_PASSWORD: '' });
  children.push(ha, server);
  const stop = () => {
    children.forEach((c) => c.kill());
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await waitFor(`${BASE}/api/health`);
  await seed();
  console.log(`Demo Switchboard on ${BASE} (password "${PASSWORD}"), data in ${DATA}`);
}

main().catch((e) => {
  console.error(e);
  children.forEach((c) => c.kill());
  process.exit(1);
});
