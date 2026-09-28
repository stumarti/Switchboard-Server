'use strict';

/**
 * A viewport's dashboard layout — what a colour wall-mounted e-ink display
 * (e.g. the reTerminal E1002 kitchen panel, or a meeting room door sign)
 * shows. The device draws; this is everything behind what it draws.
 *
 *   carousel   the screens it pages through (buttons step left/right). By
 *              default it just refreshes the screen it's on; it can instead
 *              auto-advance, or return to the first screen, every N minutes.
 *   screens    each one either
 *                - `sections`: a template (sidebar | columns | single) whose
 *                  columns hold any sections, in any order, each fully
 *                  configured (weather, energy, energy graph, battery, status
 *                  icons, alerts, calendar, heat pump, room climate, room
 *                  list, people, now playing, departures, alarm, openings,
 *                  motion, cameras) — the same type can appear any number
 *                  of times, with its own settings each time; or
 *                - `meetingRoom`: a whole-screen room booking status, with
 *                  its status icon, an optional 1-3 hour timeline and the
 *                  room's climate; or
 *                - `roomFinder`: which other rooms are free now — the
 *                  screen a meeting-room sign's button toggles to.
 *   thresholds shared numbers the rules use (battery %, "recent" motion...)
 *
 * lib/dashboard-state.js turns this plus live Home Assistant state into the
 * finished values each section draws, so the device holds no rules.
 *
 * Colours are the panel's palette indices: 0 white, 1 black, 2 red,
 * 3 yellow, 4 green, 5 blue.
 */

const { randomUUID } = require('crypto');

const COLORS = [0, 1, 2, 3, 4, 5];
const CONDITIONS = ['eq', 'ne', 'contains', 'gt', 'lt'];
const FLOORS = ['upstairs', 'downstairs'];
const REFRESH_CHOICES = [5, 10, 15, 30, 60];
const CAROUSEL_MODES = ['stay', 'advance', 'returnFirst'];
const SCREEN_KINDS = ['sections', 'meetingRoom', 'roomFinder'];
const TIMELINE_HOURS = [0, 1, 2, 3];
// A meeting room's status icons. Free and in use are the user's to pick;
// the in-between states have fixed ones.
const MEETING_ICONS = { free: 'door-open', occupied: 'account-group', soon: 'clock-alert-outline', bookedEmpty: 'account-off-outline' };
// What the status bar says for each state — editable, e.g. "Free" / "Busy",
// or another language. The room finder says "Free" for any room free now.
const MEETING_LABELS = {
  free: 'Available',
  soon: 'Starting soon',
  busy: 'In use',
  bookedEmpty: 'Booked — no one here',
  occupied: 'In use — not booked'
};
const FINDER_LABELS = { ...MEETING_LABELS, free: 'Free', soon: 'Free' };
const LABEL_MAX = 40;

function normalizeLabels(v, defaults) {
  const x = obj(v);
  const out = {};
  for (const k of Object.keys(defaults)) out[k] = str(x[k]).slice(0, LABEL_MAX) || defaults[k];
  return out;
}
const TEMPLATES = { sidebar: 2, columns: 2, single: 1 };
const SERIES_KINDS = ['power', 'energy'];

const LIMITS = {
  screens: 12,
  sectionsPerColumn: 8,
  statusIcons: 12,
  rules: 8,
  alerts: 12,
  alertEntities: 8,
  calendars: 8,
  rooms: 12,
  people: 8,
  media: 3,
  transport: 4,
  items: 10,
  finderRooms: 12
};

const DEFAULT_THRESHOLDS = {
  batteryCritical: 10,
  batteryLow: 20,
  transportUrgentMin: 5,
  motionRecentMin: 30,
  climateTolerance: 1
};

const DEFAULT_BATTERY_COLORS = { charging: 4, full: 4, discharging: 3, critical: 2, idle: 1 };
// Top panel: actual solar bars against the forecast line. Bottom panel:
// consumption stacked by where it came from, export below the line.
const DEFAULT_GRAPH_COLORS = { solar: 3, forecast: 5, fromSolar: 3, fromBattery: 5, fromGrid: 2, gridExport: 4 };
const GRAPH_SERIES = ['solar', 'load', 'gridImport', 'gridExport', 'batteryCharge', 'batteryDischarge'];

// --- Coercion helpers -------------------------------------------------------

const str = (v, fb = '') => (typeof v === 'string' ? v.trim() : v == null ? fb : String(v).trim());
const bool = (v, fb) => (typeof v === 'boolean' ? v : v === 1 || v === '1' ? true : v === 0 || v === '0' ? false : fb);
function num(v, fb) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fb;
}
const clamp = (v, lo, hi, fb) => Math.min(Math.max(num(v, fb), lo), hi);
const color = (v, fb) => {
  const n = num(v, fb);
  return COLORS.includes(n) ? n : fb;
};
const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const id = (v) => (typeof v === 'string' && v ? v.slice(0, 64) : randomUUID());

function list(v, max, fn) {
  return arr(v)
    .filter((x) => x && typeof x === 'object')
    .slice(0, max)
    .map(fn);
}

const named = (max, extra = () => ({})) => (v) =>
  list(v, max, (x) => ({ id: id(x.id), name: str(x.name), entity: str(x.entity), ...extra(x) }));

// --- Pieces shared by several sections --------------------------------------------

// "When the state (or attribute) is X": a colour, optionally a different
// icon, or hide the icon altogether.
function normalizeRule(r) {
  const x = obj(r);
  return {
    cond: oneOf(x.cond, CONDITIONS, 'eq'),
    value: str(x.value),
    color: color(x.color, 1),
    icon: str(x.icon),
    hide: bool(x.hide, false)
  };
}

function normalizeStatusIcon(s) {
  const x = obj(s);
  return {
    id: id(x.id),
    name: str(x.name),
    entity: str(x.entity),
    attribute: str(x.attribute),
    icon: str(x.icon),
    color: color(x.color ?? x.defaultColor, 1),
    // Shown when no rule matches? Off = only when a rule says so.
    showByDefault: bool(x.showByDefault, true),
    rules: list(x.rules, LIMITS.rules, normalizeRule)
  };
}

function normalizeAlert(a) {
  const x = obj(a);
  return {
    id: id(x.id),
    enabled: bool(x.enabled, true),
    suffix: str(x.suffix),
    cond: oneOf(x.cond, CONDITIONS, 'eq'),
    value: str(x.value, 'on'),
    color: color(x.color, 2),
    entities: list(x.entities, LIMITS.alertEntities, (e) => ({ entity: str(e.entity), name: str(e.name) }))
  };
}

function normalizeRoom(r) {
  const x = obj(r);
  return {
    id: id(x.id),
    name: str(x.name),
    icon: str(x.icon),
    floor: oneOf(x.floor, FLOORS, 'downstairs'),
    temperature: str(x.temperature),
    humidity: str(x.humidity),
    // A thermostat/TRV (climate.*) gives the target and whether the room is
    // calling for heat; without one, `target` is a fixed setpoint.
    climate: str(x.climate),
    target: num(x.target, null)
  };
}

function normalizeTransport(t) {
  const x = obj(t);
  return {
    id: id(x.id),
    name: str(x.name),
    stop: str(x.stop),
    icon: str(x.icon, 'bus'),
    color: color(x.color, 4),
    departure1: str(x.departure1),
    departure2: str(x.departure2)
  };
}

// One line on the energy graph: a power sensor (W/kW, averaged per bucket)
// or an energy meter (kWh, differenced per bucket).
function normalizeSeries(s) {
  const x = obj(s);
  return { entity: str(x.entity), kind: oneOf(x.kind, SERIES_KINDS, 'power') };
}

// --- Sections ------------------------------------------------------------------------

const SECTIONS = {
  weather: (x) => ({ entity: str(x.entity), later: bool(x.later, true), days: clamp(x.days, 0, 5, 2) }),
  energy: (x) => ({
    // "grid": a 2×2 block of tiles; "list": one row per figure (a sidebar).
    style: oneOf(x.style, ['grid', 'list'], 'grid'),
    solarToday: str(x.solarToday),
    solarExpected: str(x.solarExpected),
    loadToday: str(x.loadToday),
    gridExport: str(x.gridExport),
    gridImport: str(x.gridImport)
  }),
  energyGraph: (x) => {
    const f = obj(x.forecast);
    const c = obj(x.colors);
    return {
      range: oneOf(x.range, ['today', '24h'], 'today'),
      bucketMin: oneOf(num(x.bucketMin, 60), [15, 30, 60], 60),
      // Solar production, house consumption, grid import/export and
      // (optionally) battery charge/discharge — enough to split each bar of
      // consumption into from-solar, from-battery and from-grid.
      ...Object.fromEntries(GRAPH_SERIES.map((k) => [k, normalizeSeries(x[k])])),
      // Hourly (or finer) solar forecast from an entity's attribute: a list
      // of {period_start|datetime|time, pv_estimate|value|watts...} or a map
      // of {time: value} (Solcast, Open-Meteo Solar Forecast and similar).
      forecast: { entity: str(f.entity), attribute: str(f.attribute), unit: oneOf(f.unit, ['auto', 'kW', 'W'], 'auto') },
      colors: Object.fromEntries(Object.entries(DEFAULT_GRAPH_COLORS).map(([k, d]) => [k, color(c[k], d)]))
    };
  },
  battery: (x) => ({
    soc: str(x.soc),
    status: str(x.status),
    eta: str(x.eta),
    colors: Object.fromEntries(Object.entries(DEFAULT_BATTERY_COLORS).map(([k, d]) => [k, color(obj(x.colors)[k], d)]))
  }),
  statusIcons: (x) => ({ icons: list(x.icons, LIMITS.statusIcons, normalizeStatusIcon) }),
  alerts: (x) => ({
    slots: list(x.slots, LIMITS.alerts, normalizeAlert),
    maxLines: clamp(x.maxLines, 1, 10, 6),
    allClear: str(x.allClear, 'All clear')
  }),
  calendar: (x) => ({
    entities: arr(x.entities).map((v) => str(v)).filter(Boolean).slice(0, LIMITS.calendars),
    days: clamp(x.days, 1, 31, 7),
    lines: clamp(x.lines, 1, 8, 4),
    // Fewer lines while a conditional section in the same column shows (0 =
    // keep them all), making room for it — e.g. Now playing below.
    shrinkTo: clamp(x.shrinkTo, 0, 8, 2)
  }),
  heatPump: (x) => ({ entity: str(x.entity), outsideTemperature: str(x.outsideTemperature), cop: str(x.cop) }),
  roomClimate: (x) => ({ rooms: list(x.rooms, LIMITS.rooms, normalizeRoom) }),
  roomList: (x) => ({ rooms: list(x.rooms, LIMITS.rooms, normalizeRoom), byFloor: bool(x.byFloor, true) }),
  people: (x) => ({ people: named(LIMITS.people)(x.people) }),
  media: (x) => ({ players: named(LIMITS.media, (p) => ({ icon: str(p.icon) }))(x.players) }),
  transport: (x) => ({ routes: list(x.routes, LIMITS.transport, normalizeTransport) }),
  alarm: (x) => ({
    entity: str(x.entity),
    lastArmed: str(x.lastArmed),
    lastDisarmed: str(x.lastDisarmed),
    lastTriggered: str(x.lastTriggered)
  }),
  // Doors, windows, gates, garage doors...: red when open.
  openings: (x) => ({
    items: named(LIMITS.items)(x.items),
    openColor: color(x.openColor, 2),
    closedColor: color(x.closedColor, 4)
  }),
  motion: (x) => ({ sensors: named(LIMITS.items)(x.sensors) }),
  cameras: (x) => ({ cameras: named(LIMITS.items)(x.cameras) })
};
const SECTION_TYPES = Object.keys(SECTIONS);

// When a section shows at all — any section can be conditional:
//   always    (the default)
//   playing   while one of its media players is playing (Now playing only)
//   entity    while an entity's state matches (the status-icon conditions)
// `liveMin`: while a conditional section is showing, the display wakes this
// often (1-30 min) to keep it current, then goes back to its normal refresh
// once it's gone. 0 = no extra wakes.
const SHOW_MODES = ['always', 'playing', 'entity'];

function normalizeShowWhen(v, type) {
  const x = obj(v);
  let mode = oneOf(x.mode, SHOW_MODES, 'always');
  if (mode === 'playing' && type !== 'media') mode = 'always';
  return {
    mode,
    entity: str(x.entity),
    cond: oneOf(x.cond, CONDITIONS, 'eq'),
    value: str(x.value),
    liveMin: mode === 'always' ? 0 : clamp(x.liveMin, 0, 30, 3)
  };
}

function normalizeSection(s) {
  const x = obj(s);
  const type = SECTION_TYPES.includes(x.type) ? x.type : null;
  if (!type) return null;
  return { id: id(x.id), type, title: str(x.title), ...SECTIONS[type](x), showWhen: normalizeShowWhen(x.showWhen, type) };
}

function normalizeMeeting(m) {
  const x = obj(m);
  return {
    calendar: str(x.calendar),
    name: str(x.name),
    occupancy: str(x.occupancy),
    hideTitles: bool(x.hideTitles, false),
    soonMin: clamp(x.soonMin, 0, 60, 10),
    emptyMin: clamp(x.emptyMin, 0, 60, 10),
    upcoming: clamp(x.upcoming, 0, 8, 4),
    freeIcon: str(x.freeIcon) || MEETING_ICONS.free,
    occupiedIcon: str(x.occupiedIcon) || MEETING_ICONS.occupied,
    labels: normalizeLabels(x.labels, MEETING_LABELS),
    timelineHours: oneOf(num(x.timelineHours, 2), TIMELINE_HOURS, 2),
    climate: normalizeMeetingClimate(x.climate)
  };
}

// The room's climate, bottom right: a thermostat or a temperature sensor,
// plus optional humidity and CO2 sensors.
function normalizeMeetingClimate(c) {
  const x = obj(c);
  return { show: bool(x.show, false), temperature: str(x.temperature), humidity: str(x.humidity), co2: str(x.co2) };
}

// The other rooms, each by its calendar (and occupancy sensor, if any).
function normalizeFinder(f) {
  const x = obj(f);
  return {
    rooms: list(x.rooms, LIMITS.finderRooms, (r) => ({ id: id(r.id), calendar: str(r.calendar), name: str(r.name), occupancy: str(r.occupancy) })),
    showBusy: bool(x.showBusy, true),
    soonMin: clamp(x.soonMin, 0, 60, 10),
    emptyMin: clamp(x.emptyMin, 0, 60, 10),
    freeIcon: str(x.freeIcon) || MEETING_ICONS.free,
    occupiedIcon: str(x.occupiedIcon) || MEETING_ICONS.occupied,
    labels: normalizeLabels(x.labels, FINDER_LABELS)
  };
}

function normalizeScreen(s) {
  const x = obj(s);
  const kind = oneOf(x.kind, SCREEN_KINDS, 'sections');
  const base = { id: id(x.id), title: str(x.title), enabled: bool(x.enabled, true), kind };
  if (kind === 'meetingRoom') return { ...base, meeting: normalizeMeeting(x.meeting) };
  if (kind === 'roomFinder') return { ...base, finder: normalizeFinder(x.finder) };
  const template = Object.keys(TEMPLATES).includes(x.template) ? x.template : 'sidebar';
  const n = TEMPLATES[template];
  const cols = arr(x.columns);
  const columns = [];
  for (let i = 0; i < n; i++) {
    columns.push(arr(cols[i]).slice(0, LIMITS.sectionsPerColumn).map(normalizeSection).filter(Boolean));
  }
  // A template with fewer columns than before keeps the extra sections, in
  // its last column.
  for (let i = n; i < cols.length; i++) {
    columns[n - 1].push(...arr(cols[i]).map(normalizeSection).filter(Boolean));
  }
  columns[n - 1] = columns[n - 1].slice(0, LIMITS.sectionsPerColumn * 2);
  return { ...base, template, columns };
}

// --- Whole layout -------------------------------------------------------------

/**
 * The layout, every field present and in range. `existing` fills in any
 * top-level key the body leaves out (a partial PUT only changes what it
 * sends). A layout saved before screens were made of sections (the fixed
 * main/climate/presence/security shape) is converted.
 */
function normalizeLayout(body, existing) {
  let b = { ...obj(existing), ...obj(body) };
  if (!Array.isArray(b.screens) || (b.screens.length && b.screens[0] && b.screens[0].screen)) {
    if (b.statusIcons || b.weather || b.rooms) b = { ...b, ...fromFlat(b) };
  }
  const c = obj(b.carousel);
  const th = obj(b.thresholds);
  const screens = list(b.screens, LIMITS.screens, normalizeScreen);
  return {
    version: 2,
    refreshIntervalMin: oneOf(num(b.refreshIntervalMin, 30), REFRESH_CHOICES, 30),
    carousel: {
      mode: oneOf(c.mode, CAROUSEL_MODES, 'stay'),
      everyMin: clamp(c.everyMin, 5, 240, 30)
    },
    thresholds: Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS).map(([k, d]) => [k, num(th[k], d)])),
    screens: screens.length ? screens : [normalizeScreen({ title: 'Home', template: 'single', columns: [[]] })]
  };
}

// Every entity the layout reads — for fetching, and for the admin UI.
function screenSections(screen) {
  return screen.kind === 'sections' ? screen.columns.flat() : [];
}

// --- Presets + defaults -------------------------------------------------------

const rule = (cond, value, c, extra = {}) => ({ cond, value, color: c, ...extra });

// Starting points for a status icon; every field stays editable.
const ICON_PRESETS = {
  alarm: { name: 'Alarm', icon: 'shield-home', rules: [rule('eq', 'triggered', 2, { icon: 'shield-alert' }), rule('contains', 'armed_', 2), rule('eq', 'arming', 3), rule('eq', 'disarmed', 4, { icon: 'shield-off-outline' })] },
  door: { name: 'Door', icon: 'door-closed', rules: [rule('eq', 'on', 2, { icon: 'door-open' })] },
  window: { name: 'Window', icon: 'window-closed-variant', rules: [rule('eq', 'on', 5, { icon: 'window-open-variant' })] },
  lock: { name: 'Lock', icon: 'lock', rules: [rule('eq', 'unlocked', 2, { icon: 'lock-open-variant' }), rule('eq', 'jammed', 2, { icon: 'lock-alert' })] },
  vacuum: { name: 'Vacuum', icon: 'robot-vacuum', rules: [rule('eq', 'cleaning', 4), rule('eq', 'returning', 5), rule('eq', 'error', 2, { icon: 'robot-vacuum-alert' })] },
  mower: { name: 'Mower', icon: 'robot-mower', rules: [rule('eq', 'mowing', 4), rule('eq', 'error', 2)] },
  plant: { name: 'Plants', icon: 'flower', rules: [rule('eq', 'due', 2, { icon: 'watering-can' }), rule('eq', 'watered', 4)] },
  onOff: { name: 'Switch', icon: 'power', rules: [rule('eq', 'on', 2)] },
  onlyWhenOn: { name: 'Alert', icon: 'alert', showByDefault: false, rules: [rule('eq', 'on', 2)] }
};

// The kitchen panel's nine icons (entity ids and colours overridable, as its
// own config allowed), as ordinary user-editable status icons.
function kitchenIcons(e = {}, c = {}, icons = {}) {
  const col = (k, d) => color(c[k], d);
  const onRule = (key, d) => [rule('eq', 'on', col(key, d))];
  const robot = (k, run, name, icon, entity) => ({
    name,
    icon,
    entity,
    color: col(`${k}_inactive`, 1),
    rules: [rule('eq', run, col(`${k}_running`, 4)), rule('eq', 'scheduled', col(`${k}_scheduled`, 5)), rule('eq', 'error', col(`${k}_error`, 2))]
  });
  return [
    {
      name: 'Alarm',
      icon: icons.alarm || 'shield-home',
      entity: e.alarm || 'alarm_control_panel.home',
      color: col('alarm_inactive', 1),
      rules: [rule('eq', 'triggered', col('alarm_triggered', 2)), rule('contains', 'armed_', col('alarm_armed', 2)), rule('eq', 'arming', col('alarm_arming', 3)), rule('eq', 'disarmed', col('alarm_disarmed', 4))]
    },
    { name: 'Doors', icon: icons.door || 'door-open', entity: e.door || 'binary_sensor.any_door_open', color: col('door_inactive', 1), rules: onRule('door_open', 2) },
    { name: 'Windows', icon: icons.window || 'window-open', entity: e.window || 'binary_sensor.any_window_open', color: col('window_inactive', 1), rules: onRule('window_open', 5) },
    {
      name: 'Plants',
      icon: icons.plant || 'flower',
      entity: e.plant || 'sensor.plant_watering_status',
      color: col('plant_inactive', 1),
      rules: [rule('eq', 'due', col('plant_due', 2)), rule('eq', 'watered', col('plant_watered', 4)), rule('eq', 'ok', col('plant_ok', 1))]
    },
    { name: 'Heating', icon: icons.heating || 'radiator', entity: e.heating || 'binary_sensor.heating_active', color: col('heating_inactive', 1), rules: onRule('heating_active', 2) },
    { name: 'Hot water', icon: icons.hotwater || 'water-boiler', entity: e.hotwater || 'binary_sensor.hot_water_active', color: col('hotwater_inactive', 1), rules: onRule('hotwater_active', 2) },
    robot('vac1', 'cleaning', 'Vacuum 1', icons.vacuum1 || 'robot-vacuum', e.vacuum1 || 'vacuum.downstairs'),
    robot('vac2', 'cleaning', 'Vacuum 2', icons.vacuum2 || 'robot-vacuum-variant', e.vacuum2 || 'vacuum.upstairs'),
    robot('mower', 'mowing', 'Mower', icons.mower || 'robot-mower', e.mower || 'lawn_mower.garden')
  ];
}

// The panel paired an alert slot with each icon; the slot's colour is its
// icon's "active" colour (for the alarm, "armed").
function kitchenAlerts(icons, slots = {}) {
  const suffixes = ['armed', 'open', 'open', 'need water', 'on', 'on', 'running', 'running', 'mowing'];
  // "armed_" matches armed_away/_home/_night but not "disarmed".
  const values = ['armed_', 'on', 'on', 'due', 'on', 'on', 'cleaning', 'cleaning', 'mowing'];
  return icons.map((ic, i) => {
    const s = obj(slots[`slot${i + 1}`]);
    const active = ic.rules[i === 0 ? 1 : 0];
    return {
      id: `alert-${i + 1}`,
      enabled: s.enabled !== undefined ? bool(s.enabled, true) : i < 3,
      suffix: str(s.label) || suffixes[i],
      cond: oneOf(s.cond, CONDITIONS, i === 0 ? 'contains' : 'eq'),
      value: s.value !== undefined ? str(s.value) : values[i],
      color: (active && active.color) || 2,
      entities: Array.isArray(s.entities) ? s.entities : [{ entity: ic.entity, name: ic.name }]
    };
  });
}

const withIds = (items, prefix) => items.map((x, i) => ({ ...x, id: x.id || `${prefix}-${i + 1}` }));
const section = (sid, type, settings = {}) => ({ id: sid, type, ...settings });

/**
 * The kitchen panel's own screens, from its flat settings (the shape of its
 * config, and of the layouts saved before screens were made of sections):
 * Home, Energy, Climate, Presence, Security.
 */
function fromFlat(flat) {
  const f = obj(flat);
  const icons = withIds(f.statusIcons ? arr(f.statusIcons) : kitchenIcons(), 'icon');
  const rooms = withIds(arr(f.rooms), 'room');
  const sec = obj(f.security);
  const en = obj(f.energy);
  const cal = obj(f.calendar);
  const hp = obj(f.heatPump);
  const scr = arr(f.screens);
  const on = (name) => {
    const s = scr.find((x) => x && x.screen === name);
    return s ? s.enabled !== false : true;
  };
  return {
    screens: [
      {
        id: 'home',
        title: 'Home',
        template: 'sidebar',
        columns: [
          [
            section('home-weather', 'weather', { entity: obj(f.weather).entity || 'weather.home' }),
            section('home-energy', 'energy', en),
            section('home-battery', 'battery', obj(f.battery))
          ],
          [
            section('home-icons', 'statusIcons', { icons }),
            section('home-alerts', 'alerts', { slots: f.alerts ? withIds(arr(f.alerts), 'alert') : kitchenAlerts(icons) }),
            section('home-calendar', 'calendar', cal)
          ]
        ]
      },
      {
        id: 'energy',
        title: 'Energy',
        template: 'sidebar',
        columns: [
          [section('energy-totals', 'energy', { ...en, style: 'list' })],
          [
            section('energy-graph', 'energyGraph', {
              solar: { entity: 'sensor.solar_power', kind: 'power' },
              load: { entity: 'sensor.home_power', kind: 'power' },
              gridImport: { entity: 'sensor.grid_import_power', kind: 'power' },
              gridExport: { entity: 'sensor.grid_export_power', kind: 'power' },
              batteryCharge: { entity: 'sensor.battery_charge_power', kind: 'power' },
              batteryDischarge: { entity: 'sensor.battery_discharge_power', kind: 'power' },
              forecast: { entity: en.solarExpected || 'sensor.solar_forecast_today', attribute: 'detailedForecast' }
            })
          ]
        ]
      },
      {
        id: 'climate',
        title: 'Climate',
        enabled: on('climate'),
        template: 'single',
        columns: [[section('climate-hp', 'heatPump', { entity: hp.entity || 'climate.heat_pump', outsideTemperature: hp.outsideTemperature, cop: hp.cop }), section('climate-rooms', 'roomClimate', { rooms })]]
      },
      {
        id: 'presence',
        title: 'Presence',
        enabled: on('presence'),
        template: 'sidebar',
        columns: [
          [section('presence-rooms', 'roomList', { rooms })],
          [
            section('presence-people', 'people', { people: arr(f.people) }),
            section('presence-media', 'media', { players: arr(f.media) }),
            section('presence-transport', 'transport', { routes: arr(f.transport) })
          ]
        ]
      },
      {
        id: 'security',
        title: 'Security',
        enabled: on('security'),
        template: 'columns',
        columns: [
          [
            section('security-alarm', 'alarm', { entity: sec.alarm || 'alarm_control_panel.home', lastArmed: sec.lastArmed, lastDisarmed: sec.lastDisarmed, lastTriggered: sec.lastTriggered }),
            section('security-doors', 'openings', { title: 'Doors', items: arr(sec.doors) }),
            section('security-windows', 'openings', { title: 'Windows', items: arr(sec.windows) })
          ],
          [section('security-motion', 'motion', { sensors: arr(sec.motion) }), section('security-cameras', 'cameras', { cameras: arr(sec.cameras) })]
        ]
      }
    ]
  };
}

function kitchenFlat(e = {}, c = {}, icons = {}, alertSlots) {
  const iconList = withIds(kitchenIcons(e, c, icons), 'icon');
  const room = (name, floor, icon, key) => ({ name, floor, icon, temperature: `sensor.${key}_temperature`, humidity: `sensor.${key}_humidity`, target: 21 });
  return {
    weather: { entity: e.weather || 'weather.home' },
    energy: {
      solarToday: e.solar_today || 'sensor.solar_energy_today',
      solarExpected: e.solar_expected || 'sensor.solar_forecast_today',
      loadToday: e.load_today || 'sensor.home_consumption_today',
      gridExport: e.grid_export || 'sensor.grid_export_today',
      gridImport: e.grid_import || 'sensor.grid_import_today'
    },
    battery: {
      soc: e.battery_soc || 'sensor.battery_soc',
      status: e.battery_status || 'sensor.battery_status',
      eta: e.battery_eta || 'sensor.battery_time_to_full',
      colors: { charging: c.battery_charging, full: c.battery_full, discharging: c.battery_discharging, critical: c.battery_critical, idle: c.battery_idle }
    },
    statusIcons: iconList,
    alerts: kitchenAlerts(iconList, alertSlots),
    calendar: { entities: [], days: 7, lines: 4 },
    heatPump: { entity: e.heatpump || 'climate.heat_pump' },
    rooms: [
      room('Main Bed', 'upstairs', 'bed', 'main_bed'),
      room('Guest', 'upstairs', 'bed', 'guest'),
      room('Bathroom', 'upstairs', 'shower', 'bathroom'),
      room('Office', 'upstairs', 'desk', 'office'),
      room('Living', 'downstairs', 'sofa', 'living'),
      room('Kitchen', 'downstairs', 'fridge-outline', 'kitchen')
    ],
    transport: withIds(
      [
        { name: '42 · City Centre', icon: 'bus', color: 4, departure1: 'sensor.bus_42_next', departure2: 'sensor.bus_42_next2' },
        { name: 'Overground · Waterloo', icon: 'train', color: 5, departure1: 'sensor.train_next', departure2: 'sensor.train_next2' },
        { name: '7 · Airport', icon: 'bus', color: 4, departure1: 'sensor.bus_7_next', departure2: 'sensor.bus_7_next2' }
      ],
      'transport'
    ),
    security: { alarm: e.alarm || 'alarm_control_panel.home' }
  };
}

function defaultLayout() {
  return normalizeLayout({ refreshIntervalMin: 30, ...fromFlat(kitchenFlat()) });
}

// A meeting-room sign, for a display beside a conference room door: the
// room itself, and the other rooms that are free — its button toggles
// between the two.
function meetingRoomLayout() {
  return normalizeLayout({
    refreshIntervalMin: 15,
    carousel: { mode: 'returnFirst', everyMin: 5 },
    screens: [
      { id: 'meeting', title: 'Meeting room', kind: 'meetingRoom', meeting: {} },
      { id: 'rooms', title: 'Other rooms', kind: 'roomFinder', finder: {} }
    ]
  });
}

// A blank dashboard: one empty screen to build on.
function blankLayout() {
  return normalizeLayout({ screens: [{ id: 'home', title: 'Home', template: 'sidebar', columns: [[], []] }] });
}

// What a viewport shows before it's assigned a dashboard: one screen whose
// title says so (the device draws screen titles).
function unassignedLayout() {
  return normalizeLayout({ screens: [{ id: 'unassigned', title: 'Not set up yet — assign a layout on the Switchboard server', template: 'single', columns: [[]] }] });
}

/**
 * The kitchen panel's own settings (its GET /api/config JSON) as a layout:
 * entity ids, icons, colours, thresholds and alert slots carry straight
 * over; what the panel had hard-coded (rooms, transport, the forecast
 * template sensors) comes from the defaults. The panel's API doesn't list an
 * alert slot's entities, so each slot starts with its status icon's entity
 * (the pairing the panel's own drawing used) unless `entities` is given.
 */
function fromKitchenPanel(config) {
  const cfg = obj(config);
  const t = obj(cfg.thresholds);
  const layout = normalizeLayout(fromFlat(kitchenFlat(obj(cfg.sensors), obj(cfg.colors), obj(cfg.icons), obj(cfg.alerts))));
  layout.thresholds = normalizeLayout({
    thresholds: {
      batteryCritical: t.battery_critical,
      batteryLow: t.battery_low,
      transportUrgentMin: t.transport_urgent,
      motionRecentMin: t.motion_recent,
      climateTolerance: t.climate_tolerance
    }
  }).thresholds;
  return layout;
}

module.exports = {
  COLORS,
  CONDITIONS,
  FLOORS,
  REFRESH_CHOICES,
  CAROUSEL_MODES,
  SCREEN_KINDS,
  SHOW_MODES,
  TIMELINE_HOURS,
  MEETING_ICONS,
  MEETING_LABELS,
  FINDER_LABELS,
  TEMPLATES,
  SECTION_TYPES,
  GRAPH_SERIES,
  LIMITS,
  DEFAULT_THRESHOLDS,
  ICON_PRESETS,
  normalizeLayout,
  normalizeSection,
  normalizeScreen,
  screenSections,
  defaultLayout,
  meetingRoomLayout,
  blankLayout,
  unassignedLayout,
  fromKitchenPanel
};
