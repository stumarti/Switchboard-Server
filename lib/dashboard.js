'use strict';

/**
 * A viewport's dashboard layout — what a colour wall-mounted e-ink display
 * (e.g. the reTerminal E1002 kitchen panel, or a meeting room door sign)
 * shows. The device draws; this is everything behind what it draws.
 *
 *   carousel   the screens it pages through (the display's buttons: left
 *              previous, middle next, the green one home). By
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
// `in`: one of a comma-separated list ("heat,auto"); `startsWith`: a prefix.
const CONDITIONS = ['eq', 'ne', 'contains', 'gt', 'lt', 'in', 'startsWith'];
const FLOORS = ['upstairs', 'downstairs'];
const REFRESH_CHOICES = [5, 10, 15, 30, 60];
const QUIET_CHOICES = [30, 60, 120, 240];
const CAROUSEL_MODES = ['stay', 'advance', 'returnFirst'];
const SCREEN_KINDS = ['sections', 'meetingRoom', 'roomFinder'];
const SCREEN_ICONS = { sections: 'view-dashboard-outline', meetingRoom: 'calendar-account-outline', roomFinder: 'door-sliding-open' };
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
const TEMPLATES = { sidebar: 2, columns: 2, single: 1, triple: 3 };
const SERIES_KINDS = ['power', 'energy'];

// Air quality readings the airQuality section knows the limits of.
const AIR_KINDS = ['auto', 'co2', 'pm25', 'pm10', 'voc', 'aqi', 'humidity', 'pollen', 'other'];

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
  finderRooms: 12,
  nowItems: 12,
  zones: 16,
  iconEntities: 12,
  bins: 8,
  airItems: 10
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
const DEFAULT_GRAPH_COLORS = { solar: 3, forecast: 5, fromSolar: 3, fromBattery: 5, fromGrid: 2, gridExport: 4, toBattery: 5 };
// batteryPower: one signed sensor in place of batteryCharge/batteryDischarge.
const GRAPH_SERIES = ['solar', 'load', 'gridImport', 'gridExport', 'batteryCharge', 'batteryDischarge', 'batteryPower'];

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
// A rule reads its icon's entity (any of them, for an icon following
// several) unless it names its own; `also` is a second condition that must
// hold too, on the same entity or another (a vacuum charging AND below 100%).
function normalizeCheck(c) {
  const x = obj(c);
  return { entity: str(x.entity), attribute: str(x.attribute), cond: oneOf(x.cond, CONDITIONS, 'eq'), value: str(x.value) };
}

function normalizeRule(r) {
  const x = obj(r);
  const also = x.also && (obj(x.also).cond || obj(x.also).entity || obj(x.also).attribute) ? normalizeCheck(x.also) : null;
  return {
    cond: oneOf(x.cond, CONDITIONS, 'eq'),
    value: str(x.value),
    entity: str(x.entity),
    attribute: str(x.attribute),
    also,
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
    // More entities the icon follows: a rule matches when ANY of them does
    // ("a door is open", "a plant is dry").
    entities: arr(x.entities).map((v) => str(typeof v === 'object' && v ? v.entity : v)).filter(Boolean).slice(0, LIMITS.iconEntities),
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
    // Each departure: an entity, or one of its attributes (a stop sensor
    // whose state is the next bus and an attribute the one after, as Home
    // Assistant's Dublin Bus sensor's "Next bus").
    departure1: str(x.departure1),
    departure1Attribute: str(x.departure1Attribute),
    departure2: str(x.departure2),
    departure2Attribute: str(x.departure2Attribute),
    // Or a stop sensor with every arrival in a list attribute (TFI / GTFS
    // style: {route, headsign, real_time_arrival, scheduled_arrival}): the
    // entity, the attribute, and optionally only some routes ("C3, 66").
    stopEntity: str(x.stopEntity),
    listAttribute: str(x.listAttribute, 'arrivals'),
    routes: str(x.routes),
    // Unnamed, a stop is a line per route and headsign (what the front of
    // the bus says), soonest first: at most this many.
    lines: clamp(x.lines, 1, 6, 3)
  };
}

// One line on the energy graph: a power sensor (W/kW, averaged per bucket)
// or an energy meter (kWh, differenced per bucket).
function normalizeSeries(s) {
  const x = obj(s);
  return { entity: str(x.entity), kind: oneOf(x.kind, SERIES_KINDS, 'power') };
}

// A "now" item. Kinds:
//   alarm     always shown: armed / part set / disarmed, and the last event
//   heating   while any of its zones is calling for heat: "N zones heating"
//   hotWater  while the water heater is heating: "56C / 60C target"
//   openings  while any of its items is open (on): "Door open", "Front & back"
//             (join "and") or "3 windows open", "Kitchen, Side" (join "list")
//   plants    while any plant's state contains `value` ("Dry")
//   robot     while a vacuum or mower is in its `active` state, with battery
//   entity    while an entity matches a condition, worded by `title`/`detail`
// `title`/`titleMany`/`detail` can use {n} (how many), {names}, {state} and
// {battery}.
const NOW_KINDS = ['alarm', 'heating', 'hotWater', 'openings', 'plants', 'robot', 'entity'];
const NOW_DEFAULTS = {
  alarm: { icon: 'shield-check', color: 1 },
  heating: { icon: 'radiator', color: 2, title: 'Heating', detail: '{n} zones heating' },
  hotWater: { icon: 'water-boiler', color: 2, title: 'Hot water' },
  openings: { icon: 'door-open', color: 2, title: 'Open', titleMany: '{n} open' },
  plants: { icon: 'watering-can', color: 5, title: 'Plant needs water', titleMany: 'Plants need water', value: 'Dry' },
  robot: { icon: 'robot-vacuum', color: 4, title: '{name} active', detail: '{battery}% battery', value: 'cleaning' },
  entity: { icon: 'alert', color: 2, title: '{name}', detail: '{state}', value: 'on' }
};

function normalizeNowItem(v) {
  const x = obj(v);
  const kind = oneOf(x.kind, NOW_KINDS, 'entity');
  const d = NOW_DEFAULTS[kind];
  return {
    id: id(x.id),
    kind,
    name: str(x.name),
    icon: str(x.icon) || d.icon,
    color: color(x.color, d.color),
    title: str(x.title) || d.title || '',
    titleMany: str(x.titleMany) || d.titleMany || '',
    detail: x.detail === undefined ? d.detail || '' : str(x.detail),
    entity: str(x.entity),
    // alarm: the last event's message; robot: its battery sensor.
    eventEntity: str(x.eventEntity),
    battery: str(x.battery),
    attribute: str(x.attribute),
    cond: oneOf(x.cond, CONDITIONS, kind === 'plants' ? 'contains' : 'eq'),
    value: x.value === undefined ? d.value || '' : str(x.value),
    // openings / plants / heating zones.
    items: named(LIMITS.items)(x.items),
    join: oneOf(x.join, ['and', 'list'], 'list'),
    callingDelta: clamp(x.callingDelta, 0, 5, 0.5),
    maxChars: clamp(x.maxChars, 10, 120, 50)
  };
}

// --- Sections ------------------------------------------------------------------------

// A photo from Immich (lib/immich.js): its source, how often it changes, and
// a caption. `height` 0 = the rest of its column.
const PHOTO_CAPTIONS = ['none', 'date', 'place', 'both'];
const PHOTO_KINDS = ['album', 'favorites', 'person', 'memories', 'random'];
function immichSource(v) {
  const x = obj(v);
  return { kind: oneOf(x.kind, PHOTO_KINDS, 'favorites'), album: str(x.album).slice(0, 64), person: str(x.person).slice(0, 64) };
}
function normalizePhoto(x) {
  return {
    source: immichSource(x.source),
    every: clamp(x.every, 5, 10080, 60),
    caption: oneOf(x.caption, PHOTO_CAPTIONS, 'none'),
    height: clamp(x.height, 0, 480, 0)
  };
}

const SECTIONS = {
  weather: (x) => ({
    entity: str(x.entity),
    later: bool(x.later, true),
    days: clamp(x.days, 0, 5, 2),
    // The hourly forecast for "Later" and for rain (another weather entity
    // can carry it; blank = the same one).
    hourlyEntity: str(x.hourlyEntity),
    // "Rain at 14:00" / "Rain stops 16:00" / "Rain continuing": the first
    // change between wet and dry in the next `rainHours` of the hourly
    // forecast, wet being more than `rainThresholdMm` an hour.
    rain: bool(x.rain, false),
    rainHours: clamp(x.rainHours, 1, 24, 12),
    rainThresholdMm: clamp(x.rainThresholdMm, 0, 10, 0.1),
    // When it's dry, "Expecting 12.3 kWh today" from a solar forecast.
    solarForecast: str(x.solarForecast)
  }),
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
      // Which sign batteryPower has while charging (most: negative).
      batteryChargingWhen: oneOf(x.batteryChargingWhen, ['negative', 'positive'], 'negative'),
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
    // Or the status from a power sensor: below -idleWatts charging, above it
    // discharging (W, negative = charging), with "full at"/"empty at" times
    // from timestamp sensors.
    power: str(x.power),
    idleWatts: clamp(x.idleWatts, 0, 10000, 100),
    // Which sign the power sensor gives while charging (most: negative).
    chargingWhen: oneOf(x.chargingWhen, ['negative', 'positive'], 'negative'),
    chargeEta: str(x.chargeEta),
    dischargeEta: str(x.dischargeEta),
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
    // A colour per calendar (entity -> colour); black when not set.
    colors: Object.fromEntries(Object.entries(obj(x.colors)).map(([k, v]) => [str(k), color(v, 1)]).filter(([k]) => k)),
    days: clamp(x.days, 1, 31, 7),
    lines: clamp(x.lines, 1, 20, 4),
    // Today only, including what's already happened today, timed events
    // first; the description's first words under each.
    today: bool(x.today, false),
    timedFirst: bool(x.timedFirst, false),
    descriptions: bool(x.descriptions, false),
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
    // Under the badge: a count line for each doors / windows / motion /
    // cameras section on the same screen.
    summary: bool(x.summary, false),
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
  cameras: (x) => ({ cameras: named(LIMITS.items)(x.cameras) }),
  // A gap of `height` px, to move what follows down its column.
  spacer: (x) => ({ height: clamp(x.height, 0, 400, 20) }),
  // What's happening now: one two-line item per thing that's active (the
  // alarm always), each from a kind that knows how to word it.
  now: (x) => ({ items: list(x.items, LIMITS.nowItems, normalizeNowItem) }),
  // The heating: a whole-house thermostat, each zone against its setpoint
  // (calling when more than `callingDelta` below it, in heat or auto) on a
  // shared scale, and the hot water.
  heating: (x) => ({
    entity: str(x.entity),
    // Each zone: its thermostat, its label and, if you like, an icon drawn
    // beside the label.
    zones: named(LIMITS.zones, (z) => ({ icon: str(z.icon) }))(x.zones),
    hotWater: str(x.hotWater),
    callingDelta: clamp(x.callingDelta, 0, 5, 0.5),
    houseTemps: x.houseTemps !== false
  }),
  // Company announcements: the newest items of an RSS or Atom feed, read by
  // the server (lib/feeds.js).
  announcements: (x) => ({
    url: str(x.url).slice(0, 500),
    count: clamp(x.count, 1, 6, 3),
    summary: bool(x.summary, true),
    // Leave out anything older than this many days (0 = no limit).
    maxAgeDays: clamp(x.maxAgeDays, 0, 365, 0),
    showDate: bool(x.showDate, true),
    color: color(x.color, 1)
  }),
  // A guest Wi-Fi network (Settings -> Wi-Fi networks) as a join QR code,
  // for a reception or a meeting room. `network`: its name; '' = the first.
  guestWifi: (x) => ({
    network: str(x.network),
    showPassword: bool(x.showPassword, true),
    caption: str(x.caption, 'Scan to join the Wi-Fi')
  }),
  // A few lines of text: fixed, or with {entity_id} filled in from Home
  // Assistant ("Bins out tonight", "Welcome, {input_text.visitor}").
  message: (x) => ({
    text: str(x.text).slice(0, 600),
    size: oneOf(x.size, ['normal', 'bold', 'large'], 'bold'),
    align: oneOf(x.align, ['left', 'center'], 'left'),
    color: color(x.color, 1),
    icon: str(x.icon)
  }),
  // Bin collection: each bin's next collection, from a calendar (a Home
  // Assistant calendar or a calendar link, events matched by words in their
  // title) or from its own sensor (a date, or days until).
  bins: (x) => ({
    calendar: calendarRef(x.calendar),
    bins: list(x.bins, LIMITS.bins, (b) => ({
      id: id(b.id),
      name: str(b.name),
      match: str(b.match),
      entity: str(b.entity),
      icon: str(b.icon),
      color: color(b.color, 1)
    })),
    days: clamp(x.days, 1, 60, 21),
    count: clamp(x.count, 1, 8, 3),
    // "Put out tonight" from this hour the day before (0 = never).
    tonightFrom: clamp(x.tonightFrom, 0, 23, 16)
  }),
  // Air quality and pollen: each reading coloured good / fair / poor by its
  // kind's usual limits (or your own).
  photo: normalizePhoto,
  airQuality: (x) => ({
    items: list(x.items, LIMITS.airItems, (it) => ({
      id: id(it.id),
      name: str(it.name),
      entity: str(it.entity),
      kind: oneOf(it.kind, AIR_KINDS, 'auto'),
      // Your own limits: fair from `fair`, poor from `poor` (blank = the kind's).
      fair: it.fair === '' || it.fair == null || !Number.isFinite(Number(it.fair)) ? null : Number(it.fair),
      poor: it.poor === '' || it.poor == null || !Number.isFinite(Number(it.poor)) ? null : Number(it.poor)
    })),
    showLevel: bool(x.showLevel, true)
  })
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

// A room's calendar: a Home Assistant calendar entity, or a calendar link
// (an iCal address from Google, Outlook / Microsoft 365, iCloud...; see
// lib/ical.js), kept as given.
const calendarRef = (v) => str(v).trim().slice(0, 2000);

function normalizeMeeting(m) {
  const x = obj(m);
  return {
    calendar: calendarRef(x.calendar),
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
    climate: normalizeMeetingClimate(x.climate),
    // Change this many minutes ahead: the display wakes that much before a
    // meeting starts or ends, so the panel has finished redrawing by then.
    aheadMin: clamp(x.aheadMin, 0, 10, 2)
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
    rooms: list(x.rooms, LIMITS.finderRooms, (r) => ({ id: id(r.id), calendar: calendarRef(r.calendar), name: str(r.name), occupancy: str(r.occupancy) })),
    showBusy: bool(x.showBusy, true),
    soonMin: clamp(x.soonMin, 0, 60, 10),
    emptyMin: clamp(x.emptyMin, 0, 60, 10),
    freeIcon: str(x.freeIcon) || MEETING_ICONS.free,
    occupiedIcon: str(x.occupiedIcon) || MEETING_ICONS.occupied,
    labels: normalizeLabels(x.labels, FINDER_LABELS),
    aheadMin: clamp(x.aheadMin, 0, 10, 2)
  };
}

function normalizeScreen(s) {
  const x = obj(s);
  const kind = oneOf(x.kind, SCREEN_KINDS, 'sections');
  // `icon`: the screen's mark in the display's footer, beside the others in
  // the carousel (the one showing underlined).
  const base = { id: id(x.id), title: str(x.title), icon: str(x.icon) || SCREEN_ICONS[kind], enabled: bool(x.enabled, true), kind };
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
  // A photo behind the whole screen, the sections on white cards over it.
  const bg = obj(x.background);
  const background = { enabled: bool(bg.enabled, false), ...normalizePhoto(bg) };
  delete background.height;
  return { ...base, template, columns, background };
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
  const q = obj(b.quietHours);
  const screens = list(b.screens, LIMITS.screens, normalizeScreen);
  return {
    version: 2,
    refreshIntervalMin: oneOf(num(b.refreshIntervalMin, 30), REFRESH_CHOICES, 30),
    // On the clock: refresh at the interval's marks (:00 and :30 for 30
    // minutes; quiet hours' too), each display a few seconds after the last,
    // instead of an interval after it last slept.
    refreshAligned: bool(b.refreshAligned, false),
    carousel: {
      mode: oneOf(c.mode, CAROUSEL_MODES, 'stay'),
      everyMin: clamp(c.everyMin, 5, 240, 30)
    },
    // Overnight the display wakes less often: from `start` to `end` (hours,
    // local, wrapping midnight) every `intervalMin` instead.
    quietHours: {
      enabled: bool(q.enabled, false),
      start: clamp(q.start, 0, 23, 23),
      end: clamp(q.end, 0, 23, 6),
      intervalMin: oneOf(num(q.intervalMin, 60), QUIET_CHOICES, 60),
      // Saturday and Sunday quiet all day too (an office).
      weekends: bool(q.weekends, false)
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

// The kitchen dashboard as the wall panel draws it: Status (weather, energy,
// home battery | status icons, what's happening now, today's calendar),
// Heating (the house against its setpoints, zone by zone, and hot water) and
// Security (the alarm | doors and windows | motion and cameras). The green
// button is Status, the middle next (Heating from Status), the left previous
// (Security); a timer wake goes back to Status. Every entity id is a
// placeholder to replace with your own.
const DASH = {
  weather: 'weather.home',
  hourly: 'weather.home',
  alarmState: 'sensor.home_alarm_state',
  alarmEvent: 'sensor.home_alarm_event',
  alarmPanel: 'alarm_control_panel.home_alarm',
  heating: 'climate.whole_house',
  hotWater: 'water_heater.home_tank'
};
const DASH_ZONES = [
  ['climate.kitchen', 'Kitchen'],
  ['climate.living_room', 'Living Room'],
  ['climate.hall', 'Hall'],
  ['climate.bathroom', 'Bathroom'],
  ['climate.landing', 'Landing'],
  ['climate.bedroom', 'Bedroom'],
  ['climate.bedroom_2', 'Bedroom 2'],
  ['climate.office', 'Office']
].map(([entity, name]) => ({ entity, name }));
const DASH_DOORS = [
  ['binary_sensor.front_door', 'Front door'],
  ['binary_sensor.back_door', 'Back door']
].map(([entity, name]) => ({ entity, name }));
const DASH_WINDOWS = [
  ['binary_sensor.window_side', 'Side'],
  ['binary_sensor.window_living_room', 'Living room'],
  ['binary_sensor.window_kitchen', 'Kitchen'],
  ['binary_sensor.window_office_left', 'Office left'],
  ['binary_sensor.window_office_right', 'Office right'],
  ['binary_sensor.window_bedroom_left', 'Master bed left'],
  ['binary_sensor.window_bedroom_right', 'Master bed right']
].map(([entity, name]) => ({ entity, name }));
const DASH_PLANTS = [{ entity: 'sensor.plant_soil_moisture', name: 'House plant' }];
const DASH_ROBOTS = [
  { name: 'Vacuum 1', entity: 'vacuum.vacuum1', battery: 'sensor.vacuum1_battery', charging: 'binary_sensor.vacuum1_charging', icon: 'robot-vacuum', active: 'cleaning' },
  { name: 'Vacuum 2', entity: 'vacuum.vacuum2', battery: 'sensor.vacuum2_battery', charging: '', icon: 'robot-vacuum-variant', active: 'cleaning' },
  { name: 'Mower', entity: 'lawn_mower.mower', battery: 'sensor.mower_battery', charging: 'binary_sensor.mower_charging', icon: 'robot-mower', active: 'mowing' }
];

// Green while working, red on an error, blue while charging below 100%
// (from a charging sensor, or — without one — docked and below 100%).
function robotIcon(r) {
  const charging = r.charging
    ? rule('eq', 'on', 5, { entity: r.charging, also: { entity: r.battery, cond: 'lt', value: '100' } })
    : rule('eq', 'docked', 5, { also: { entity: r.battery, cond: 'lt', value: '100' } });
  return { name: r.name, icon: r.icon, entity: r.entity, color: 1, rules: [rule('eq', r.active, 4), rule('eq', 'error', 2), charging] };
}

// Fixed ids for every list entry in a template (zones, doors, sensors...), so
// the same template always comes out the same.
function stampIds(v, path = 'x') {
  if (Array.isArray(v)) {
    return v.map((x, i) => {
      const p = `${path}-${i + 1}`;
      if (Array.isArray(x)) return stampIds(x, p);
      return x && typeof x === 'object' ? { id: p, ...stampIds(x, p) } : x;
    });
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stampIds(x, `${path}-${k}`)]));
  return v;
}

function kitchenDashLayout() {
  const alarmIcon = {
    name: 'Alarm',
    icon: 'shield-check',
    entity: DASH.alarmState,
    color: 1,
    rules: [rule('eq', 'disarmed', 4), rule('contains', 'partly', 2, { icon: 'shield-alert' }), rule('startsWith', 'partset', 2, { icon: 'shield-alert' }), rule('startsWith', 'armed', 2, { icon: 'shield-alert' })]
  };
  const anyOn = (name, closedIcon, openIcon, items) => ({
    name,
    icon: closedIcon,
    entity: items[0].entity,
    entities: items.slice(1).map((x) => x.entity),
    color: 1,
    rules: [rule('eq', 'on', 2, { icon: openIcon })]
  });
  const icons = [
    alarmIcon,
    anyOn('Doors', 'door-closed', 'door-open', DASH_DOORS),
    anyOn('Windows', 'window-closed', 'window-open', DASH_WINDOWS),
    { name: 'Heating', icon: 'radiator-off', entity: DASH.heating, color: 1, rules: [rule('in', 'heat,auto', 2, { icon: 'radiator', also: { attribute: 'active_member_count', cond: 'gt', value: '0' } })] },
    { name: 'Hot water', icon: 'water-boiler-off', entity: DASH.hotWater, attribute: 'operation_mode', color: 1, rules: [rule('eq', 'heating', 2, { icon: 'water-boiler' })] },
    { name: 'Plants', icon: 'flower', entity: DASH_PLANTS[0].entity, entities: DASH_PLANTS.slice(1).map((p) => p.entity), color: 1, rules: [rule('contains', 'Dry', 2)] },
    ...DASH_ROBOTS.map(robotIcon)
  ];
  const now = [
    { kind: 'alarm', entity: DASH.alarmState, eventEntity: DASH.alarmEvent, maxChars: 50 },
    { kind: 'heating', items: DASH_ZONES, title: 'Heating', detail: '{n} zones heating' },
    { kind: 'hotWater', entity: DASH.hotWater },
    { kind: 'openings', icon: 'door-open', items: [{ entity: DASH_DOORS[0].entity, name: 'Front' }, { entity: DASH_DOORS[1].entity, name: 'Back' }], title: 'Door open', titleMany: 'Door open', join: 'and' },
    { kind: 'openings', icon: 'window-open', items: DASH_WINDOWS, title: 'Window open', titleMany: '{n} windows open', join: 'list' },
    { kind: 'plants', items: DASH_PLANTS, value: 'Dry' },
    ...DASH_ROBOTS.map((r) => ({ kind: 'robot', name: r.name, icon: r.icon, entity: r.entity, battery: r.battery, value: r.active, title: r.active === 'mowing' ? `${r.name} active` : `${r.name} cleaning` }))
  ].map((x, i) => ({ id: `now-${i + 1}`, ...x }));
  return normalizeLayout(stampIds({
    refreshIntervalMin: 30,
    carousel: { mode: 'returnFirst', everyMin: 30 },
    quietHours: { enabled: true, start: 23, end: 6, intervalMin: 60 },
    screens: [
      {
        id: 'status',
        title: 'Status',
        template: 'sidebar',
        columns: [
          [
            section('status-weather', 'weather', { entity: DASH.weather, hourlyEntity: DASH.hourly, later: false, days: 3, rain: true, solarForecast: 'sensor.solar_forecast_today' }),
            section('status-energy', 'energy', { style: 'grid', solarToday: 'sensor.solar_generation', loadToday: 'sensor.load_today', gridImport: 'sensor.grid_import', gridExport: 'sensor.grid_export' }),
            section('status-battery', 'battery', {
              soc: 'sensor.battery_soc',
              power: 'sensor.battery_power',
              idleWatts: 100,
              chargeEta: 'sensor.battery_charge_eta',
              dischargeEta: 'sensor.battery_discharge_eta',
              colors: { charging: 4, full: 4, discharging: 2, critical: 2, idle: 1 }
            })
          ],
          [
            section('status-icons', 'statusIcons', { icons: withIds(icons, 'icon') }),
            section('status-now', 'now', { title: 'Now', items: now }),
            section('status-today', 'calendar', {
              title: 'Today',
              entities: ['calendar.home_schedule', 'calendar.work', 'calendar.birthdays', 'calendar.holidays_in_ireland'],
              colors: { 'calendar.home_schedule': 1, 'calendar.work': 5, 'calendar.birthdays': 2, 'calendar.holidays_in_ireland': 4 },
              today: true,
              timedFirst: true,
              descriptions: true,
              lines: 20
            })
          ]
        ]
      },
      {
        id: 'heating',
        title: 'Heating',
        icon: 'radiator',
        template: 'single',
        columns: [[section('heating-main', 'heating', { entity: DASH.heating, zones: DASH_ZONES, hotWater: DASH.hotWater, callingDelta: 0.5, houseTemps: false })]]
      },
      {
        id: 'security',
        title: 'Security',
        icon: 'shield-home-outline',
        template: 'triple',
        columns: [
          [section('security-alarm', 'alarm', { entity: DASH.alarmPanel, summary: true })],
          [
            section('security-doors', 'openings', { title: 'Doors', items: DASH_DOORS }),
            section('security-windows', 'openings', {
              title: 'Windows',
              items: [
                ['binary_sensor.window_kitchen', 'Kitchen'],
                ['binary_sensor.window_living_room', 'Living room'],
                ['binary_sensor.window_side', 'Side windows'],
                ['binary_sensor.window_bedroom_left', 'Bedroom L'],
                ['binary_sensor.window_bedroom_right', 'Bedroom R'],
                ['binary_sensor.window_office_left', 'Office L'],
                ['binary_sensor.window_office_right', 'Office R']
              ].map(([entity, name]) => ({ entity, name }))
            })
          ],
          [
            section('security-motion', 'motion', {
              title: 'Motion',
              sensors: [
                ['binary_sensor.front_door_motion', 'Front door'],
                ['binary_sensor.hall_motion', 'Hall'],
                ['binary_sensor.landing_motion', 'Landing'],
                ['binary_sensor.recessed_landing_motion', 'Rec. Landing'],
                ['binary_sensor.back_garden_motion', 'Back garden']
              ].map(([entity, name]) => ({ entity, name }))
            }),
            section('security-cameras', 'cameras', {
              title: 'Cameras',
              cameras: [
                ['binary_sensor.camera_front_motion', 'Front camera'],
                ['binary_sensor.camera_back_motion', 'Back camera'],
                ['binary_sensor.camera_kitchen_motion', 'Kitchen'],
                ['binary_sensor.doorbell_recent_motion', 'Doorbell']
              ].map(([entity, name]) => ({ entity, name }))
            })
          ]
        ]
      }
    ]
  }, 'dash'));
}

// What a new viewport layout starts from: the kitchen dashboard.
function defaultLayout() {
  return kitchenDashLayout();
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
  QUIET_CHOICES,
  NOW_KINDS,
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
