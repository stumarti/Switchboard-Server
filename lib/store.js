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

// Globals (WiFi + a default Home Assistant connection, shared across every
// room) live in their own file, not a room profile - a leading underscore
// keeps it out of the way of slugify()'d room slugs (which are lowercase
// a-z0-9- only, per isValidSlug below) and it's explicitly excluded from
// listProfiles()'s directory scan.
const GLOBALS_FILENAME = '_globals.json';
const GLOBALS_PATH = path.join(DATA_DIR, GLOBALS_FILENAME);

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
  ensureDataDir();
  if (!fs.existsSync(GLOBALS_PATH)) return defaultGlobals();
  try {
    return JSON.parse(fs.readFileSync(GLOBALS_PATH, 'utf8'));
  } catch (err) {
    return defaultGlobals();
  }
}

function saveGlobals(globals) {
  ensureDataDir();
  fs.writeFileSync(GLOBALS_PATH, JSON.stringify(globals, null, 2), 'utf8');
  return globals;
}

function listProfiles() {
  ensureDataDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && f !== GLOBALS_FILENAME)
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
  fs.writeFileSync(profilePath(slug), JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}

function deleteProfile(slug) {
  if (!isValidSlug(slug)) return false;
  const p = profilePath(slug);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
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
  saveGlobals
};
