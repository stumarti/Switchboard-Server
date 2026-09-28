'use strict';

/**
 * A viewport's dashboard layout — what the colour wall-mounted e-ink display
 * (the reTerminal E1002 kitchen panel) shows. The device draws the same
 * four fixed screens it always has; this is the configuration behind them,
 * which used to live in the device's own web UI (NVS), hard-coded YAML
 * entity ids and a Home Assistant template package.
 *
 *   main       weather + forecast, energy, home battery, the status icon row,
 *              alert lines, calendar
 *   climate    heat pump + every room against its target
 *   presence   room temperatures, people, now playing, next departures
 *   security   alarm, doors, windows, motion, cameras
 *
 * lib/dashboard-state.js turns this plus live Home Assistant state into the
 * finished values each screen draws (colours, sentences, times), so the
 * device holds no rules of its own.
 *
 * Colours are the panel's palette indices, the same numbers the device's
 * old config used: 0 white, 1 black, 2 red, 3 yellow, 4 green, 5 blue.
 */

const { randomUUID } = require('crypto');

const SCREENS = ['main', 'climate', 'presence', 'security'];
const COLORS = [0, 1, 2, 3, 4, 5];
const CONDITIONS = ['eq', 'ne', 'contains', 'gt', 'lt'];
const FLOORS = ['upstairs', 'downstairs'];
const REFRESH_CHOICES = [5, 10, 15, 30, 60];

const LIMITS = {
  statusIcons: 9,
  alerts: 9,
  alertEntities: 8,
  calendars: 8,
  rooms: 12,
  people: 8,
  media: 3,
  transport: 3,
  doors: 8,
  windows: 8,
  motion: 8,
  cameras: 6,
  rules: 8
};

const DEFAULT_THRESHOLDS = {
  batteryCritical: 10,
  batteryLow: 20,
  solarPeak: 52,
  transportUrgentMin: 5,
  motionRecentMin: 30,
  climateTolerance: 1
};

const DEFAULT_BATTERY_COLORS = { charging: 4, full: 4, discharging: 3, critical: 2, idle: 1 };

// --- Coercion helpers -------------------------------------------------------

const str = (v, fb = '') => (typeof v === 'string' ? v.trim() : v == null ? fb : String(v).trim());
const bool = (v, fb) => (typeof v === 'boolean' ? v : v === 1 || v === '1' ? true : v === 0 || v === '0' ? false : fb);
function num(v, fb) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fb;
}
const color = (v, fb) => {
  const n = num(v, fb);
  return COLORS.includes(n) ? n : fb;
};
const oneOf = (v, list, fb) => (list.includes(v) ? v : fb);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const id = (v) => (typeof v === 'string' && v ? v : randomUUID());

function list(v, max, fn) {
  return arr(v)
    .filter((x) => x && typeof x === 'object')
    .slice(0, max)
    .map(fn);
}

// --- Pieces -----------------------------------------------------------------

function normalizeRule(r) {
  const x = obj(r);
  return {
    cond: oneOf(x.cond, CONDITIONS, 'eq'),
    value: str(x.value),
    color: color(x.color, 1)
  };
}

function normalizeStatusIcon(s) {
  const x = obj(s);
  return {
    id: id(x.id),
    name: str(x.name),
    icon: str(x.icon),
    entity: str(x.entity),
    rules: list(x.rules, LIMITS.rules, normalizeRule),
    defaultColor: color(x.defaultColor, 1)
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

const named = (max, extra = () => ({})) => (v) =>
  list(v, max, (x) => ({ id: id(x.id), name: str(x.name), entity: str(x.entity), ...extra(x) }));

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

function normalizeScreens(v) {
  const seen = new Set();
  const out = [];
  for (const s of arr(v)) {
    const sid = s && s.screen;
    if (!SCREENS.includes(sid) || seen.has(sid)) continue;
    seen.add(sid);
    out.push({ screen: sid, enabled: sid === 'main' ? true : bool(s.enabled, true) });
  }
  for (const sid of SCREENS) if (!seen.has(sid)) out.push({ screen: sid, enabled: sid === 'main' });
  return out;
}

// --- Whole layout -------------------------------------------------------------

/**
 * The layout, every field present and in range. `existing` fills in any
 * top-level section the body leaves out (so a partial PUT only changes what
 * it sends); within a section the body is taken as the whole section.
 */
function normalizeLayout(body, existing) {
  const e = obj(existing);
  const b = { ...e, ...obj(body) };
  const w = obj(b.weather);
  const en = obj(b.energy);
  const bat = obj(b.battery);
  const cal = obj(b.calendar);
  const hp = obj(b.heatPump);
  const sec = obj(b.security);
  const th = obj(b.thresholds);
  return {
    screens: normalizeScreens(b.screens),
    refreshIntervalMin: oneOf(num(b.refreshIntervalMin, 30), REFRESH_CHOICES, 30),
    thresholds: Object.fromEntries(
      Object.entries(DEFAULT_THRESHOLDS).map(([k, d]) => [k, num(th[k], d)])
    ),
    weather: { entity: str(w.entity) },
    energy: {
      solarToday: str(en.solarToday),
      solarExpected: str(en.solarExpected),
      loadToday: str(en.loadToday),
      gridExport: str(en.gridExport),
      gridImport: str(en.gridImport)
    },
    battery: {
      soc: str(bat.soc),
      status: str(bat.status),
      eta: str(bat.eta),
      colors: Object.fromEntries(
        Object.entries(DEFAULT_BATTERY_COLORS).map(([k, d]) => [k, color(obj(bat.colors)[k], d)])
      )
    },
    statusIcons: list(b.statusIcons, LIMITS.statusIcons, normalizeStatusIcon),
    alerts: list(b.alerts, LIMITS.alerts, normalizeAlert),
    calendar: {
      entities: arr(cal.entities).map((x) => str(x)).filter(Boolean).slice(0, LIMITS.calendars),
      days: Math.min(Math.max(num(cal.days, 7), 1), 31),
      lines: Math.min(Math.max(num(cal.lines, 4), 0), 6)
    },
    heatPump: {
      entity: str(hp.entity),
      outsideTemperature: str(hp.outsideTemperature),
      cop: str(hp.cop)
    },
    rooms: list(b.rooms, LIMITS.rooms, normalizeRoom),
    people: named(LIMITS.people)(b.people),
    media: named(LIMITS.media, (x) => ({ icon: str(x.icon) }))(b.media),
    transport: list(b.transport, LIMITS.transport, normalizeTransport),
    security: {
      alarm: str(sec.alarm),
      lastArmed: str(sec.lastArmed),
      lastDisarmed: str(sec.lastDisarmed),
      lastTriggered: str(sec.lastTriggered),
      doors: named(LIMITS.doors)(sec.doors),
      windows: named(LIMITS.windows)(sec.windows),
      motion: named(LIMITS.motion)(sec.motion),
      cameras: named(LIMITS.cameras)(sec.cameras)
    }
  };
}

// --- Defaults: the kitchen panel's own out-of-the-box configuration ----------------

const rule = (cond, value, c) => ({ cond, value, color: c });

// The nine status icons, with the colour rules the panel hard-coded.
function defaultStatusIcons(e = {}, c = {}, icons = {}) {
  const col = (k, d) => color(c[k], d);
  const robot = (key, iconKey, icon, entity, name) => ({
    name,
    icon: icons[iconKey] || icon,
    entity,
    rules: [
      rule('eq', 'cleaning', col(`${key}_running`, 4)),
      rule('eq', 'mowing', col(`${key}_running`, 4)),
      rule('eq', 'scheduled', col(`${key}_scheduled`, 5)),
      rule('eq', 'error', col(`${key}_error`, 2))
    ],
    defaultColor: col(`${key}_inactive`, 1)
  });
  const onOff = (key, colorKey, icon, entity, name, onDefault) => ({
    name,
    icon: icons[key] || icon,
    entity,
    rules: [rule('eq', 'on', col(`${colorKey}_${colorKey === 'door' || colorKey === 'window' ? 'open' : 'active'}`, onDefault))],
    defaultColor: col(`${colorKey}_inactive`, 1)
  });
  return [
    {
      name: 'Alarm',
      icon: icons.alarm || 'shield-home',
      entity: e.alarm || 'alarm_control_panel.home',
      rules: [
        rule('eq', 'triggered', col('alarm_triggered', 2)),
        rule('contains', 'armed_', col('alarm_armed', 2)),
        rule('eq', 'arming', col('alarm_arming', 3)),
        rule('eq', 'disarmed', col('alarm_disarmed', 4))
      ],
      defaultColor: col('alarm_inactive', 1)
    },
    onOff('door', 'door', 'door-open', e.door || 'binary_sensor.any_door_open', 'Doors', 2),
    onOff('window', 'window', 'window-open', e.window || 'binary_sensor.any_window_open', 'Windows', 5),
    {
      name: 'Plants',
      icon: icons.plant || 'flower',
      entity: e.plant || 'sensor.plant_watering_status',
      rules: [
        rule('eq', 'due', col('plant_due', 2)),
        rule('eq', 'watered', col('plant_watered', 4)),
        rule('eq', 'ok', col('plant_ok', 1))
      ],
      defaultColor: col('plant_inactive', 1)
    },
    onOff('heating', 'heating', 'radiator', e.heating || 'binary_sensor.heating_active', 'Heating', 2),
    onOff('hotwater', 'hotwater', 'water-boiler', e.hotwater || 'binary_sensor.hot_water_active', 'Hot water', 2),
    robot('vac1', 'vacuum1', 'robot-vacuum', e.vacuum1 || 'vacuum.downstairs', 'Vacuum 1'),
    robot('vac2', 'vacuum2', 'robot-vacuum-variant', e.vacuum2 || 'vacuum.upstairs', 'Vacuum 2'),
    robot('mower', 'mower', 'robot-mower', e.mower || 'lawn_mower.garden', 'Mower')
  ];
}

// One alert slot per status icon, as the panel paired them: the slot's
// colour is its icon's "active" colour (for the alarm, "armed").
function defaultAlerts(icons, slots = {}) {
  const suffixes = ['armed', 'open', 'open', 'need water', 'on', 'on', 'running', 'running', 'mowing'];
  // "armed_" matches armed_away/_home/_night but not "disarmed".
  const values = ['armed_', 'on', 'on', 'due', 'on', 'on', 'cleaning', 'cleaning', 'mowing'];
  const conds = ['contains', 'eq', 'eq', 'eq', 'eq', 'eq', 'eq', 'eq', 'eq'];
  return icons.map((ic, i) => {
    const s = obj(slots[`slot${i + 1}`]);
    const active = ic.rules[i === 0 ? 1 : 0];
    const activeColor = (active && active.color) || 2;
    return {
      enabled: s.enabled !== undefined ? bool(s.enabled, true) : i < 3,
      suffix: str(s.label) || suffixes[i],
      cond: oneOf(s.cond, CONDITIONS, conds[i]),
      value: s.value !== undefined ? str(s.value) : values[i],
      color: activeColor,
      entities: Array.isArray(s.entities)
        ? s.entities
        : [{ entity: ic.entity, name: ic.name }]
    };
  });
}

// Fixed ids for the default lists, so an untouched default layout is the
// same object every time (a device's bundle ETag stays put).
function withIds(list, prefix) {
  return list.map((x, i) => ({ ...x, id: x.id || `${prefix}-${i + 1}` }));
}

function defaultLayout() {
  const icons = withIds(defaultStatusIcons(), 'icon');
  const room = (name, floor, icon, key) => ({
    name,
    floor,
    icon,
    temperature: `sensor.${key}_temperature`,
    humidity: `sensor.${key}_humidity`,
    target: 21
  });
  return normalizeLayout({
    screens: SCREENS.map((s) => ({ screen: s, enabled: true })),
    refreshIntervalMin: 30,
    weather: { entity: 'weather.home' },
    energy: {
      solarToday: 'sensor.solar_energy_today',
      solarExpected: 'sensor.solar_forecast_today',
      loadToday: 'sensor.home_consumption_today',
      gridExport: 'sensor.grid_export_today',
      gridImport: 'sensor.grid_import_today'
    },
    battery: { soc: 'sensor.battery_soc', status: 'sensor.battery_status', eta: 'sensor.battery_time_to_full' },
    statusIcons: icons,
    alerts: withIds(defaultAlerts(icons), 'alert'),
    calendar: { entities: [], days: 7, lines: 4 },
    heatPump: { entity: 'climate.heat_pump' },
    rooms: withIds([
      room('Main Bed', 'upstairs', 'bed', 'main_bed'),
      room('Guest', 'upstairs', 'bed', 'guest'),
      room('Bathroom', 'upstairs', 'shower', 'bathroom'),
      room('Office', 'upstairs', 'desk', 'office'),
      room('Living', 'downstairs', 'sofa', 'living'),
      room('Kitchen', 'downstairs', 'fridge-outline', 'kitchen')
    ], 'room'),
    transport: withIds([
      { name: '42 · City Centre', icon: 'bus', color: 4, departure1: 'sensor.bus_42_next', departure2: 'sensor.bus_42_next2' },
      { name: 'Overground · Waterloo', icon: 'train', color: 5, departure1: 'sensor.train_next', departure2: 'sensor.train_next2' },
      { name: '7 · Airport', icon: 'bus', color: 4, departure1: 'sensor.bus_7_next', departure2: 'sensor.bus_7_next2' }
    ], 'transport'),
    security: { alarm: 'alarm_control_panel.home' }
  });
}

/**
 * The kitchen panel's own settings (its GET /api/config JSON) as a layout:
 * entity ids, icons, colours, thresholds and alert slots carry straight over;
 * everything the panel had hard-coded (rooms, transport, the forecast
 * template sensors) comes from defaultLayout(). The panel's API doesn't list
 * each alert slot's entities, so a slot starts with its status icon's entity
 * (the pairing the panel's own drawing used) unless `entities` is given.
 */
function fromKitchenPanel(config) {
  const cfg = obj(config);
  const s = obj(cfg.sensors);
  const c = obj(cfg.colors);
  const t = obj(cfg.thresholds);
  const icons = withIds(defaultStatusIcons(
    {
      alarm: str(s.alarm),
      door: str(s.door),
      window: str(s.window),
      plant: str(s.plant),
      heating: str(s.heating),
      hotwater: str(s.hotwater),
      vacuum1: str(s.vacuum1),
      vacuum2: str(s.vacuum2),
      mower: str(s.mower)
    },
    c,
    obj(cfg.icons)
  ), 'icon');
  const base = defaultLayout();
  const pick = (v, fb) => str(v) || fb;
  return normalizeLayout({
    ...base,
    weather: { entity: pick(s.weather, base.weather.entity) },
    energy: {
      solarToday: pick(s.solar_today, base.energy.solarToday),
      solarExpected: pick(s.solar_expected, base.energy.solarExpected),
      loadToday: pick(s.load_today, base.energy.loadToday),
      gridExport: pick(s.grid_export, base.energy.gridExport),
      gridImport: pick(s.grid_import, base.energy.gridImport)
    },
    battery: {
      soc: pick(s.battery_soc, base.battery.soc),
      status: pick(s.battery_status, base.battery.status),
      eta: pick(s.battery_eta, base.battery.eta),
      colors: {
        charging: c.battery_charging,
        full: c.battery_full,
        discharging: c.battery_discharging,
        critical: c.battery_critical,
        idle: c.battery_idle
      }
    },
    statusIcons: icons,
    alerts: withIds(defaultAlerts(icons, obj(cfg.alerts)), 'alert'),
    heatPump: { ...base.heatPump, entity: pick(s.heatpump, base.heatPump.entity) },
    thresholds: {
      batteryCritical: t.battery_critical,
      batteryLow: t.battery_low,
      solarPeak: t.solar_peak,
      transportUrgentMin: t.transport_urgent,
      motionRecentMin: t.motion_recent,
      climateTolerance: t.climate_tolerance
    },
    security: { ...base.security, alarm: pick(s.alarm, base.security.alarm) }
  });
}

module.exports = {
  SCREENS,
  COLORS,
  CONDITIONS,
  FLOORS,
  REFRESH_CHOICES,
  LIMITS,
  DEFAULT_THRESHOLDS,
  normalizeLayout,
  defaultLayout,
  fromKitchenPanel
};
