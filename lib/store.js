'use strict';

/**
 * Flat-JSON-file profile store, per spec x4pro-ha-remote-spec.md section 8b:
 * "Flat JSON files under the mounted /data volume are plenty at this scale
 * (a handful of rooms); no database needed."
 *
 * One file per profile: <DATA_DIR>/<slug>.json
 *
 * Scope note: the spec's own settings.json shape (section 10) covers a lot
 * more than this container currently manages (wifi, media sources,
 * climate, device behavior). This was deliberately trimmed down to device
 * identity + Home Assistant connection, with Standby and Lighting added
 * back in afterward as their own narrow sections - see README.md.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// --- File I/O -------------------------------------------------------------
//
// Every write goes to a temp file first and is renamed over the real one, so
// a crash, container stop or power cut mid-write can never leave a truncated
// file behind. (A plain writeFileSync truncates first: interrupted, it left
// e.g. an empty _devices.json, which read back as "no devices" — every
// remote's token then 401'd and they all fell back to "waiting for
// approval".) rename() is atomic within one filesystem, and the temp file
// sits next to the target, so it always is.
function writeFileAtomic(filePath, data, encoding) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, encoding);
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// Read a JSON file, or `fallback()` if it doesn't exist. An unreadable file
// is NOT silently treated as empty and later overwritten: it's logged, and a
// copy is kept next to it (<name>.corrupt-<timestamp>) so the data can be
// recovered by hand.
const reportedCorrupt = new Set();  // one copy + log line per file per process
function readJsonFile(filePath, fallback) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) return fallback();
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    if (reportedCorrupt.has(filePath)) return fallback();
    reportedCorrupt.add(filePath);
    const keep = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.error(`[store] ${path.basename(filePath)} is unreadable (${err.message}); ` +
      `keeping a copy at ${path.basename(keep)} and using defaults`);
    try {
      fs.writeFileSync(keep, text, 'utf8');
    } catch (copyErr) {
      console.error(`[store] couldn't keep a copy: ${copyErr.message}`);
    }
    return fallback();
  }
}

// Globals (WiFi + a default Home Assistant connection, shared across every
// room) live in their own file, not a room profile - a leading underscore
// keeps it out of the way of slugify()'d room slugs (which are lowercase
// a-z0-9- only, per isValidSlug below) and it's explicitly excluded from
// listProfiles()'s directory scan.
const GLOBALS_FILENAME = '_globals.json';
const GLOBALS_PATH = path.join(DATA_DIR, GLOBALS_FILENAME);

// Same leading-underscore singleton-file convention as Globals, for the new
// device registry (MAC -> pairing/room state), admin auth settings, and the
// active theme's version stamps. All three are excluded from listProfiles()'s
// directory scan below, same as _globals.json.
const DEVICES_FILENAME = '_devices.json';
const DEVICES_PATH = path.join(DATA_DIR, DEVICES_FILENAME);
const SETTINGS_FILENAME = '_settings.json';
const SETTINGS_PATH = path.join(DATA_DIR, SETTINGS_FILENAME);
const THEME_FILENAME = '_theme.json';
const THEME_PATH = path.join(DATA_DIR, THEME_FILENAME);
// Compiled theme pack binaries (not JSON) - the actual bytes a device
// downloads from GET /api/theme/icons.pack|fonts.pack.
const THEME_DIR = path.join(DATA_DIR, '_theme');
const THEME_ICONS_PACK_PATH = path.join(THEME_DIR, 'icons.pack');
const THEME_FONTS_PACK_PATH = path.join(THEME_DIR, 'fonts.pack');

// Admin-uploaded custom icons (lib/assets/icons.js's resolveIconSvg() checks
// here before falling back to the bundled @mdi/svg library, so a custom
// name works anywhere an MDI name does - the Theme page's slot picker, and
// every per-item icon picker - with zero changes to how those consumers
// look an icon up). One raw SVG file per icon, named by its picked id.
const CUSTOM_ICONS_DIR = path.join(DATA_DIR, '_icons');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'room';
}

function uniqueSlug(baseSlug) {
  ensureDataDir();
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(profilePath(slug))) {
    slug = `${baseSlug}-${n}`;
    n += 1;
  }
  return slug;
}

function profilePath(slug) {
  return path.join(DATA_DIR, `${slug}.json`);
}

function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9-]{1,64}$/.test(slug);
}

// Trimmed profile shape: device identity + Home Assistant connection +
// Standby screen settings + Lighting + Blinds + which carousel screens
// are active. The on-device settings.json schema in spec section 10 has
// a lot more (wifi, media sources, climate, device behavior) - this
// container deliberately doesn't manage those anymore (scope reduction
// requested by Stu). See README.md's "Scope" note. Standby was added
// back in as its own narrow section (spec section 5's "Standby
// (deep-sleep dashboard)") - it needs a weather entity and an indoor
// climate entity to render, plus its own refresh interval (spec section
// 5's Device settings row, scoped down to just Standby's own knob rather
// than reintroducing the whole Device section). Lighting was added back
// in later still, this time deliberately more flexible than the original
// build's fixed 3-lights-plus-group shape - see the `lighting` field
// below. Blinds followed the same whole-room-group + unbounded-list
// shape, simplified down to just Open/Close/Stop - see `blinds` below.
// `screens` are simple per-room on/off flags for which carousel screens
// (Lighting/Climate/Blinds/Music/TV/Xbox) a room actually has -
// deliberately just booleans, not configuration, and independent of the
// `lighting`/`blinds`/`media` objects' own settings (note `screens.music`
// keeps that name - it's the on-device Music screen's own on/off flag -
// even though the config object behind it below is named `media`, not
// `music`; see that field's own comment for why). `media` covers the
// entity behind that Music screen, plus an `enabled`/`name` pair matching
// Lighting's/Blinds' `group` shape - no controls flags (see the field's
// own comment below).
function defaultProfile(name, slug) {
  const now = new Date().toISOString();
  return {
    slug,
    name: name || slug,
    description: '',
    createdAt: now,
    updatedAt: now,
    homeAssistant: {
      // New rooms default to the shared Globals connection (see
      // getGlobals/saveGlobals below) rather than needing their own - a
      // room only needs host/port/token filled in here when useGlobal is
      // switched off. See README.md's "Globals" section.
      useGlobal: true,
      host: '',
      port: 8123,
      token: ''
    },
    standby: {
      weatherEntity: '',
      climateEntity: '',
      refreshIntervalMin: 30
    },
    // Lighting: a whole-room "group" control (e.g. one entity covering
    // every light in the room) plus two unbounded lists - individual
    // lights, and Home Assistant scenes to activate as one-tap shortcuts.
    // Every light and the group always support on/off; the `controls`
    // flags are only for the *extra* stuff (brightness, color
    // temperature, RGB color, effects/presets) since real lights vary -
    // a dumb on/off plug next to a tunable-white or full-color bulb - so
    // each light (and the group) picks only the extras it actually has.
    // See README.md's "Lighting" section and lib/validate.js's
    // normalizeProfile() for how the lists are merged on save.
    lighting: {
      group: {
        enabled: false,
        name: 'All lights',
        entity: '',
        controls: {
          brightness: false,
          colorTemp: false,
          color: false,
          effects: false
        }
      },
      lights: [],
      scenes: []
    },
    // Blinds: same whole-room-group + unbounded-individual-list shape as
    // Lighting, but simpler - every blind (and the group) just gets
    // Open/Close/Stop, no per-item `controls` flags, since Stop already
    // doubles as "go to favorite position" on real cover hardware/Home
    // Assistant when the blind isn't moving (Stu's call, after Lighting's
    // brightness/color/effects flags turned out not to apply here - no
    // position or tilt sliders wanted). See README.md's "Blinds" section.
    blinds: {
      group: {
        enabled: false,
        name: 'All blinds',
        entity: ''
      },
      items: []
    },
    // Which of the on-device Active-screen carousel items this room
    // actually has - lets a room with no Xbox, say, skip that screen
    // entirely instead of showing an empty/non-functional one. Simple
    // on/off flags only, independent of the Lighting/Blinds cards above -
    // this container still doesn't configure Climate/Music/TV/Xbox
    // themselves (see README's Scope note), enabling one here just tells
    // the device to include that screen in this room's carousel. All
    // default to true (every screen shown) so nothing disappears for an
    // existing room until deliberately turned off.
    screens: {
      lighting: true,
      climate: true,
      blinds: true,
      music: true,
      tv: true,
      xbox: true
    },
    // Media: the entity behind this room's on-device Music screen -
    // almost always a Spotify Connect media_player (e.g.
    // media_player.spotify). Named `media` rather than `music` since it's
    // meant to cover any media player, not just Spotify - the on-device
    // screen itself keeps the "Music" name (see `screens.music` above,
    // which independently toggles whether that screen shows at all and
    // is unrelated to this object's name). `enabled`/`name` sit alongside
    // `entity` to match the same shape as Lighting's/Blinds' whole-room
    // `group` object; still no separate `controls` object, since a
    // media_player entity's own Home Assistant `supported_features`
    // already say what it can do (play/pause, next/previous, volume,
    // etc.) - same reasoning Stu gave for Blinds not needing per-item
    // controls either.
    media: {
      enabled: false,
      name: 'Media player',
      entity: ''
    },
    // Climate: the on-device Climate screen's main temperature sensor,
    // plus any number of additional ones shown alongside it - distinct
    // from Standby's single indoor climate entity above, and independent
    // of the `screens.climate` on/off flag. All read-only display data,
    // so no `controls` object anywhere here - a sensor has nothing to
    // toggle, same reasoning as Blinds/Music.
    climate: {
      entity: '',
      additionalSensors: []
    },
    // TV: the on-device TV screen's Android TV device, split across two
    // Home Assistant entities the way a real Android TV integration
    // usually is - a `mediaPlayerEntity` (volume, play/pause, source)
    // and a separate `remoteEntity` (D-pad, Home/Back, and launching
    // apps by activity/intent) - plus a fixed set of three app-launch
    // shortcuts (YouTube, Netflix, "TV mate"), each just a launch value
    // (an Android package name or intent string) sent through the
    // remote entity's own launch/activity command. No `controls` object
    // for the standard D-pad/Home/Back/volume controls - same reasoning
    // as Blinds/Media: those two entities' own Home Assistant
    // `supported_features` already describe what they can do. The apps
    // are a fixed trio, not an open list - Stu named exactly these
    // three, unlike Lighting's/Blinds' unbounded lists.
    tv: {
      mediaPlayerEntity: '',
      remoteEntity: '',
      apps: {
        youtube: '',
        netflix: '',
        tvMate: ''
      }
    },
    // Xbox: same two-entity split as TV - a `mediaPlayerEntity` (now-playing
    // state, and launching games/apps via play_media) and a separate
    // `remoteEntity` (power on/off) - but games are an unbounded list
    // rather than TV's fixed three-app trio, since a console's library
    // keeps growing. Each game is really just an app to Xbox: `productId`
    // is whatever media_content_id play_media needs to launch it (or the
    // literal "Home" to back out to the dashboard). `listSource` picks
    // whether the on-device library screen shows this configured list or
    // browses the console live via Home Assistant's browse_media - either
    // way, no `controls` object, same reasoning as TV/Media/Blinds: the
    // media_player's and remote's own `supported_features` already cover
    // launch and power. `art` is an optional box-art URL for a game's
    // library row only, and only used when listSource is "configured" (in
    // "browse" mode row thumbnails come from browse_media instead) - the
    // now-playing hero art is never stored here, the device reads that
    // live from the media_player's own entity_picture/media_image_url.
    xbox: {
      enabled: false,
      name: 'Xbox',
      mediaPlayerEntity: '',
      remoteEntity: '',
      listSource: 'configured',
      games: []
    },
    // Quick Access hub: the device's home/launcher screen. `items` is an
    // unbounded, ordered list (the device shows 10 per screen) of buttons -
    // each one's top 2/3 opens a `target` screen (media/climate/lighting/
    // tv/xbox/guestwifi/vacuum, as more screens are added) and its bottom
    // third fires a quick `action` without leaving the hub. `target` is
    // stored as a plain string rather than whitelisted, so a future screen
    // id isn't rejected by a server that hasn't been updated yet - the
    // admin UI's select just offers the currently-known set. `action` is
    // its own nested object rather than flattened fields, same reasoning
    // as everywhere else in this file: `type` picks what the bottom third
    // does (toggle an entity, run a service call, or nothing), `entity`
    // is the target for toggle/run, `service` is an optional override
    // (blank lets the device infer one from the entity's domain), and
    // `data` is the service-call payload as raw JSON text - the device
    // parses it, not this container. `quickActionsEnabled` is a global
    // on/off for the whole bottom-third quick-action zone across every
    // hub button; it lives here rather than a Device section since this
    // container doesn't have one (see README's Scope note - only
    // Standby's own refresh knob came back after that cut).
    hub: {
      quickActionsEnabled: true,
      items: []
    }
  };
}

// Globals: WiFi credentials + a default Home Assistant connection, shared
// by every room profile unless a room switches its own `useGlobal: false`
// override on (see defaultProfile's homeAssistant.useGlobal above and
// normalizeProfile in lib/validate.js). Not itself a "profile" - no slug,
// no createdAt, nothing device-specific - so it gets its own small
// get/save pair rather than reusing get/saveProfile.
function defaultGlobals() {
  return {
    updatedAt: null,
    wifi: {
      ssid: '',
      password: ''
    },
    homeAssistant: {
      host: '',
      port: 8123,
      token: ''
    },
    // Clock: the on-device live clock (spec section 5's "persistent chrome
    // ... live clock + battery on the right" on every Active screen) is
    // NOT sourced from Home Assistant over the WebSocket - it's the
    // device's own onboard RTC, kept accurate over WiFi via NTP. One NTP
    // server, household-wide, same reasoning as WiFi/Home Assistant above.
    ntpServer: 'pool.ntp.org',
    // WiFi networks: an unbounded, household-wide list of {name, password}
    // pairs for a new on-device WiFi screen that shows/shares them (e.g.
    // "Main" + "Guest") - distinct from `wifi` above, which is this
    // container's own single network for its device-provisioning flow,
    // not something meant to be listed/shared on-screen. `name` doubles
    // as the network's SSID (the name a device actually connects to),
    // same id-preserving list shape as every other list in this file.
    wifiNetworks: []
  };
}

function getGlobals() {
  return readJsonFile(GLOBALS_PATH, defaultGlobals);
}

function saveGlobals(globals) {
  ensureDataDir();
  writeJsonAtomic(GLOBALS_PATH, globals);
  return globals;
}

// --- Devices (MAC -> pairing/room state) ---------------------------------
//
// One record per physical remote that has ever contacted the server, keyed
// by normalized MAC address (lowercase, colon-separated). This is both "the
// list of remotes that have contacted the server" and the MAC -> default
// room mapping in one place: approving a pending device is where its room
// gets assigned (see server.js's /api/pairing/* routes). `tokenHash` is a
// sha256 of the device's bearer token - the plaintext token is only ever
// handed to the device (and once, at issuance time, to the admin for
// visibility) and never stored.
function normalizeMac(mac) {
  return String(mac || '').trim().toLowerCase();
}

function isValidMac(mac) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalizeMac(mac));
}

function defaultDevices() {
  return {};
}

function getDevices() {
  return readJsonFile(DEVICES_PATH, defaultDevices);
}

function saveDevices(devices) {
  ensureDataDir();
  writeJsonAtomic(DEVICES_PATH, devices);
  return devices;
}

// A device's lastSeenAt/lastIp are refreshed on every request it makes, but
// only written back when they meaningfully change: its IP moved, or the
// stored time is more than a minute old. (Rewriting _devices.json on every
// single request — each data refresh is several — was needless disk churn.)
// Mutates `device`; returns true if the caller should saveDevices().
const LAST_SEEN_WRITE_MS = 60 * 1000;
function touchLastSeen(device, ip) {
  const ipChanged = Boolean(ip) && ip !== device.lastIp;
  const last = Date.parse(device.lastSeenAt || '');
  const stale = !Number.isFinite(last) || Date.now() - last >= LAST_SEEN_WRITE_MS;
  if (!ipChanged && !stale) return false;
  device.lastSeenAt = new Date().toISOString();
  if (ip) device.lastIp = ip;
  return true;
}

// --- Settings (admin web-portal auth) ------------------------------------
//
// One household-wide admin password (see lib/auth.js), same single-record
// shape as Globals/Devices/Theme.
function defaultSettings() {
  return {
    passwordHash: '',
    passwordSalt: '',
    sessionSecret: '',
    updatedAt: null
  };
}

function getSettings() {
  return readJsonFile(SETTINGS_PATH, defaultSettings);
}

function saveSettings(settings) {
  ensureDataDir();
  writeJsonAtomic(SETTINGS_PATH, settings);
  return settings;
}

// --- Theme (compiled icon/font pack version stamps + the pack bytes) ----
//
// One household-wide theme, same model as Globals - `iconsVersion`/
// `fontsVersion` are short content hashes of the compiled pack bytes, so a
// device can cheaply compare "have I got this" without downloading the
// whole pack (see lib/assets/*.js and server.js's /api/theme* routes). The
// pack bytes themselves are plain binary files under THEME_DIR, not JSON.
function defaultTheme() {
  return {
    iconsVersion: '',
    fontsVersion: '',
    updatedAt: null
  };
}

function getTheme() {
  return readJsonFile(THEME_PATH, defaultTheme);
}

function saveTheme(theme) {
  ensureDataDir();
  writeJsonAtomic(THEME_PATH, theme);
  return theme;
}

function ensureThemeDir() {
  fs.mkdirSync(THEME_DIR, { recursive: true });
}

function saveIconsPack(buffer) {
  ensureThemeDir();
  writeFileAtomic(THEME_ICONS_PACK_PATH, buffer);
}

function saveFontsPack(buffer) {
  ensureThemeDir();
  writeFileAtomic(THEME_FONTS_PACK_PATH, buffer);
}

function getIconsPack() {
  return fs.existsSync(THEME_ICONS_PACK_PATH) ? fs.readFileSync(THEME_ICONS_PACK_PATH) : null;
}

function getFontsPack() {
  return fs.existsSync(THEME_FONTS_PACK_PATH) ? fs.readFileSync(THEME_FONTS_PACK_PATH) : null;
}

// --- Custom icons (admin uploads, alongside the bundled MDI library) -----
//
// Same lowercase-alnum-plus-hyphen charset as a real MDI icon name (see
// isValidMac's sibling validators above) - both because it's a sane id
// charset generally, and because it's what keeps a custom name usable
// anywhere an MDI name is (path-safe on both this server and the device's
// own SD cache filenames, see mdi_icon.h).
function isValidCustomIconName(name) {
  return typeof name === 'string' && /^[a-z0-9-]{1,64}$/.test(name);
}

function ensureCustomIconsDir() {
  fs.mkdirSync(CUSTOM_ICONS_DIR, { recursive: true });
}

function customIconPath(name) {
  return path.join(CUSTOM_ICONS_DIR, `${name}.svg`);
}

function saveCustomIcon(name, svgText) {
  if (!isValidCustomIconName(name)) throw new Error(`invalid icon name: ${name}`);
  ensureCustomIconsDir();
  writeFileAtomic(customIconPath(name), svgText, 'utf8');
}

function getCustomIconSvg(name) {
  if (!isValidCustomIconName(name)) return null;
  const p = customIconPath(name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function listCustomIcons() {
  ensureCustomIconsDir();
  return fs
    .readdirSync(CUSTOM_ICONS_DIR)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => {
      const name = f.slice(0, -4);
      const stat = fs.statSync(path.join(CUSTOM_ICONS_DIR, f));
      return { name, updatedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function deleteCustomIcon(name) {
  if (!isValidCustomIconName(name)) return false;
  const p = customIconPath(name);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function listProfiles() {
  ensureDataDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter(
      (f) =>
        f.endsWith('.json') &&
        f !== GLOBALS_FILENAME &&
        f !== DEVICES_FILENAME &&
        f !== SETTINGS_FILENAME &&
        f !== THEME_FILENAME
    )
    .map((f) => {
      const slug = f.slice(0, -5);
      try {
        const data = JSON.parse(fs.readFileSync(profilePath(slug), 'utf8'));
        return {
          slug,
          name: data.name || slug,
          updatedAt: data.updatedAt || null
        };
      } catch (err) {
        return { slug, name: slug, updatedAt: null, error: 'unreadable' };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getProfile(slug) {
  if (!isValidSlug(slug)) return null;
  const p = profilePath(slug);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveProfile(slug, profile) {
  ensureDataDir();
  writeJsonAtomic(profilePath(slug), profile);
  return profile;
}

function deleteProfile(slug) {
  if (!isValidSlug(slug)) return false;
  const p = profilePath(slug);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// --- Dashboards (viewport UIs) ----------------------------------------------
//
// A viewport's whole UI, defined here before (or without) any hardware; a
// viewport device is then assigned one by slug. One file per dashboard
// under _dashboards/, the same slug rules as rooms. The layout inside is
// lib/dashboard.js's shape.
const DASHBOARDS_DIR = path.join(DATA_DIR, '_dashboards');

function dashboardPath(slug) {
  return path.join(DASHBOARDS_DIR, `${slug}.json`);
}

function ensureDashboardsDir() {
  ensureDataDir();
  if (!fs.existsSync(DASHBOARDS_DIR)) fs.mkdirSync(DASHBOARDS_DIR, { recursive: true });
}

function listDashboards() {
  ensureDashboardsDir();
  return fs
    .readdirSync(DASHBOARDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => getDashboard(f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getDashboard(slug) {
  if (!isValidSlug(slug)) return null;
  ensureDashboardsDir();
  const d = readJsonFile(dashboardPath(slug), () => null);
  return d ? { ...d, slug } : null;
}

function saveDashboard(slug, dashboard) {
  ensureDashboardsDir();
  writeJsonAtomic(dashboardPath(slug), { ...dashboard, slug });
}

function deleteDashboard(slug) {
  if (!isValidSlug(slug) || !fs.existsSync(dashboardPath(slug))) return false;
  fs.unlinkSync(dashboardPath(slug));
  return true;
}

// A free slug for a new dashboard named `name`.
function newDashboardSlug(name) {
  ensureDashboardsDir();
  const base = slugify(name) || 'dashboard';
  let slug = base;
  for (let n = 2; fs.existsSync(dashboardPath(slug)); n += 1) slug = `${base}-${n}`;
  return slug;
}

function createProfile(name) {
  ensureDataDir();
  const slug = uniqueSlug(slugify(name));
  const profile = defaultProfile(name, slug);
  saveProfile(slug, profile);
  return profile;
}

module.exports = {
  DATA_DIR,
  slugify,
  isValidSlug,
  defaultProfile,
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  createProfile,
  defaultGlobals,
  getGlobals,
  saveGlobals,
  normalizeMac,
  isValidMac,
  defaultDevices,
  getDevices,
  saveDevices,
  touchLastSeen,
  defaultSettings,
  getSettings,
  saveSettings,
  defaultTheme,
  getTheme,
  saveTheme,
  saveIconsPack,
  saveFontsPack,
  getIconsPack,
  getFontsPack,
  isValidCustomIconName,
  saveCustomIcon,
  getCustomIconSvg,
  listCustomIcons,
  deleteCustomIcon,
  listDashboards,
  getDashboard,
  saveDashboard,
  deleteDashboard,
  newDashboardSlug
};
