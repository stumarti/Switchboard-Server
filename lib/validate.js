'use strict';

/**
 * Normalizes/validates an incoming profile or globals body (from the admin
 * UI) into its canonical shape before being merged over the stored record
 * and written to disk. Deliberately permissive - tolerant of missing
 * fields, coerces types rather than rejecting.
 *
 * Trimmed scope: this container only manages device identity, Home
 * Assistant connection, Standby screen settings, Lighting, Blinds, Media,
 * Climate, TV, Xbox, and per-room active-screen flags (see lib/store.js's
 * defaultProfile doc comment), plus one household-wide Globals record
 * (WiFi + a default Home Assistant connection, see lib/store.js's
 * defaultGlobals doc comment) that a room can opt out of via its own
 * homeAssistant.useGlobal flag.
 */

const { randomUUID } = require('crypto');

const STANDBY_REFRESH_OPTIONS = [15, 30, 60];

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function standbyRefreshMin(v, fallback) {
  const n = num(v, fallback);
  return STANDBY_REFRESH_OPTIONS.includes(n) ? n : fallback;
}

// --- Lighting -------------------------------------------------------------
//
// Deliberately more flexible than the fixed "3 lights + 1 group" shape the
// very first build of this container had: an unbounded list of individual
// lights, an unbounded list of scene shortcuts, and one whole-room group
// control - all three optional, all editable from the admin UI's Lighting
// card. Every light and the group always support on/off (not worth a
// checkbox); `controls` is just which *extra* stuff that light/group has -
// brightness, color temperature, RGB color, effects/presets - since a
// plain on/off plug and a full-color bulb aren't the same thing and
// shouldn't be forced into the same form.

function normalizeLightControls(c, fallback) {
  const cc = c || {};
  const fb = fallback || {};
  return {
    brightness: bool(cc.brightness, fb.brightness || false),
    colorTemp: bool(cc.colorTemp, fb.colorTemp || false),
    color: bool(cc.color, fb.color || false),
    effects: bool(cc.effects, fb.effects || false)
  };
}

function normalizeLightGroup(g, existing) {
  const gg = g || {};
  const eg = existing || {};
  return {
    enabled: bool(gg.enabled, eg.enabled || false),
    name: str(gg.name, eg.name || 'All lights'),
    entity: str(gg.entity, eg.entity || ''),
    controls: normalizeLightControls(gg.controls, eg.controls)
  };
}

// Shared by the `lights` and `scenes` lists: matches incoming items back to
// their existing stored item by id (so editing a light doesn't churn its
// id), and assigns a fresh id to anything new (no id, or an id that
// doesn't match anything on record). The lists are always saved as a full
// replacement, not a diff/patch, so an item dropped from the incoming
// array is simply gone from the saved list - that's how the admin UI's
// "Remove" button works, nothing more is needed here.
function normalizeItemList(list, existingList, normalizeItem) {
  const arr = Array.isArray(list) ? list : [];
  const existingById = new Map(
    (Array.isArray(existingList) ? existingList : [])
      .filter((x) => x && typeof x.id === 'string')
      .map((x) => [x.id, x])
  );
  return arr.map((item) => {
    const it = item || {};
    const existing = (typeof it.id === 'string' && existingById.get(it.id)) || {};
    const id = typeof it.id === 'string' && it.id ? it.id : existing.id || randomUUID();
    return normalizeItem(it, existing, id);
  });
}

function normalizeLightsList(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    entity: str(it.entity, existing.entity || ''),
    // Optional MDI icon name (admin UI's icon picker) - shown on the chip in
    // place of the default on/off bulb glyph. Blank means "no override",
    // same convention as every other optional string field here.
    icon: str(it.icon, existing.icon || ''),
    controls: normalizeLightControls(it.controls, existing.controls)
  }));
}

function normalizeScenesList(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    entity: str(it.entity, existing.entity || ''),
    icon: str(it.icon, existing.icon || '')
  }));
}

function normalizeLighting(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    group: normalizeLightGroup(b.group, e.group),
    lights: normalizeLightsList(b.lights, e.lights),
    scenes: normalizeScenesList(b.scenes, e.scenes)
  };
}

// --- Blinds -----------------------------------------------------------
//
// Same whole-room-group + unbounded-individual-list shape as Lighting,
// but simpler: every blind (and the group) just gets Open/Close/Stop, so
// there's no per-item `controls` flags to normalize here - Stu confirmed
// no position/tilt sliders are wanted, since Stop already doubles as "go
// to favorite position" on real cover hardware/Home Assistant when the
// blind isn't moving. Reuses the same normalizeItemList() id-preserving
// helper Lighting's lights/scenes lists use.

function normalizeBlindsGroup(g, existing) {
  const gg = g || {};
  const eg = existing || {};
  return {
    enabled: bool(gg.enabled, eg.enabled || false),
    name: str(gg.name, eg.name || 'All blinds'),
    entity: str(gg.entity, eg.entity || '')
  };
}

function normalizeBlindsList(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    entity: str(it.entity, existing.entity || ''),
    icon: str(it.icon, existing.icon || '')
  }));
}

function normalizeBlinds(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    group: normalizeBlindsGroup(b.group, e.group),
    items: normalizeBlindsList(b.items, e.items)
  };
}

// --- Active screens (per-room on/off flags) --------------------------------
//
// Which carousel screens a room actually has - Lighting/Climate/Blinds/
// Music/TV/Xbox - so a room without an Xbox, say, can skip that screen on
// the device instead of showing an empty one. Deliberately just booleans:
// Climate/Music/TV/Xbox aren't configured by this container at all (see
// README's Scope note - that's still entirely on-device), and this is
// independent of the Lighting/Blinds cards' own config, not a show/hide
// toggle for them. Default true (every screen shown) so an existing
// profile saved before this field existed doesn't lose any screens the
// first time it's re-saved - only a value explicitly set to false sticks.

const SCREEN_KEYS = ['lighting', 'climate', 'blinds', 'music', 'tv', 'xbox', 'wifi', 'receiver'];
// Pages that start hidden until switched on: the receiver page is empty in
// a room without an Enigma2 box, so an existing room doesn't grow one.
const SCREENS_OFF_BY_DEFAULT = ['receiver'];

// Every carousel page a remote can show, in the firmware's default order
// (lib/clients.js's REMOTE_PAGES pairs each with its screens.* flag).
const REMOTE_PAGE_IDS = ['status', 'lighting', 'blinds', 'music', 'tv', 'xbox', 'wifi', 'climate', 'receiver'];

// `order` is the room's carousel order for its remotes: page ids, each once
// (empty = the firmware's default order).
function normalizePageOrder(v, fallback) {
  if (!Array.isArray(v)) return Array.isArray(fallback) ? fallback : [];
  const seen = new Set();
  return v.filter((id) => REMOTE_PAGE_IDS.includes(id) && !seen.has(id) && seen.add(id));
}

function normalizeScreens(s, existing) {
  const ss = s || {};
  const es = existing || {};
  const result = {};
  SCREEN_KEYS.forEach((key) => {
    const fallback = typeof es[key] === 'boolean' ? es[key] : !SCREENS_OFF_BY_DEFAULT.includes(key);
    result[key] = bool(ss[key], fallback);
  });
  result.order = normalizePageOrder(ss.order, es.order);
  return result;
}

// --- Media --------------------------------------------------------------
//
// The entity behind this room's on-device Music screen - almost always a
// Spotify Connect media_player. Named `media` (not `music`) since it's
// meant to cover any media player, not just Spotify - see
// lib/store.js's defaultProfile doc comment for how that's distinct from
// the `screens.music` on/off flag, which keeps the "Music" name. `enabled`/
// `name` match the same shape as Lighting's/Blinds' `group` object; still
// no separate `controls` object here - a media_player entity's own Home
// Assistant `supported_features` already describe what it can do
// (play/pause, next/previous, volume, ...), same reasoning as Blinds
// needing none either.

function normalizeMedia(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    enabled: bool(b.enabled, e.enabled || false),
    name: str(b.name, e.name || 'Media player'),
    entity: str(b.entity, e.entity || '')
  };
}

// --- Climate (main sensor + additional temperatures for display) -----
//
// One main `entity` (the room's primary temperature sensor for the
// Climate screen) plus an unbounded `additionalSensors` list for any
// extra readings shown alongside it - read-only display data, so there's
// no `controls` object anywhere here (a sensor has nothing to toggle),
// same reasoning as Blinds/Music. The list reuses the same id-preserving
// normalizeItemList() helper as Lighting's/Blinds' lists.

function normalizeClimateSensors(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    entity: str(it.entity, existing.entity || '')
  }));
}

function normalizeClimate(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    entity: str(b.entity, e.entity || ''),
    additionalSensors: normalizeClimateSensors(b.additionalSensors, e.additionalSensors)
  };
}

// --- TV (Android TV: media_player + remote, plus app shortcuts) ----------
//
// Two entities, same reasoning as everywhere else in this file: a
// media_player's and a remote's own Home Assistant `supported_features`
// already describe volume/play-pause/D-pad/Home/Back, so there's no
// `controls` object to normalize here.
//
// `appList` is the app row: up to four apps, each a name, a launch value (an
// Android package name or intent, sent through the media player's
// play_media) and an optional MDI icon. `apps` is the older fixed trio
// (YouTube / Netflix / TV Mate, name -> launch value), still written from
// the list so firmware from before the list keeps working; a room saved
// before the list existed gets its list from it.

const TV_APP_KEYS = ['youtube', 'netflix', 'tvMate'];
const TV_APP_MAX = 4;
const TV_APP_DEFAULTS = {
  youtube: { name: 'YouTube', icon: 'youtube' },
  netflix: { name: 'Netflix', icon: 'netflix' },
  tvMate: { name: 'TV Mate', icon: 'television-guide' }
};

function tvAppsFromLegacy(apps) {
  const a = apps || {};
  return TV_APP_KEYS.filter((k) => str(a[k], '')).map((k) => ({ id: k, name: TV_APP_DEFAULTS[k].name, launch: str(a[k], ''), icon: TV_APP_DEFAULTS[k].icon }));
}

function normalizeTvAppList(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || '').slice(0, 19),
    launch: str(it.launch, existing.launch || ''),
    icon: str(it.icon, existing.icon || '')
  })).slice(0, TV_APP_MAX);
}

// The legacy map for older firmware: each app's name -> launch value.
function tvAppsMap(appList) {
  const out = {};
  for (const a of appList) if (a.name && a.launch && !(a.name in out)) out[a.name] = a.launch;
  return out;
}

function normalizeTv(body, existing) {
  const b = body || {};
  const e = existing || {};
  const existingList = Array.isArray(e.appList) ? e.appList : tvAppsFromLegacy(e.apps);
  const appList = Array.isArray(b.appList) ? normalizeTvAppList(b.appList, existingList) : Array.isArray(e.appList) ? e.appList : b.apps ? tvAppsFromLegacy(b.apps) : existingList;
  return {
    mediaPlayerEntity: str(b.mediaPlayerEntity, e.mediaPlayerEntity || ''),
    remoteEntity: str(b.remoteEntity, e.remoteEntity || ''),
    appList,
    apps: tvAppsMap(appList)
  };
}

// --- Receiver (an Enigma2 satellite/cable box: one media_player) --------
//
// Home Assistant's enigma2 integration is a media_player: channel up/down
// are its next/previous track, the channel list is its source list, plus
// volume, mute and power. `channels` are the favourites the page shows as
// buttons — each a name, the source to select (the channel's name in the
// box's bouquet, as HA lists it) and an optional MDI icon.

const RECEIVER_CHANNEL_MAX = 6;

function normalizeReceiverChannels(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || '').slice(0, 23),
    source: str(it.source, existing.source || ''),
    icon: str(it.icon, existing.icon || ''),
    // Show the channel's own picon from the box (needs boxUrl) instead of `icon`.
    usePicon: bool(it.usePicon, existing.usePicon || false)
  })).slice(0, RECEIVER_CHANNEL_MAX);
}

function normalizeReceiver(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    name: str(b.name, e.name || 'Receiver').slice(0, 23),
    mediaPlayerEntity: str(b.mediaPlayerEntity, e.mediaPlayerEntity || ''),
    // Optional: the box's own web interface (OpenWebif), for the programme
    // on next and picons — "http://192.168.1.50", credentials allowed.
    boxUrl: str(b.boxUrl, e.boxUrl || ''),
    channels: normalizeReceiverChannels(b.channels, e.channels)
  };
}

// --- Xbox (media_player + remote, plus an unbounded games/apps list) ----
//
// Same two-entity split as TV, and the same no-`controls`-object reasoning
// (the media_player's and remote's own `supported_features` already cover
// launch and power). Unlike TV's fixed three-app trio, games are an
// unbounded list - a console's library keeps growing - reusing the same
// id-preserving normalizeItemList() helper as Lighting's/Blinds'/Climate's
// lists. `listSource` picks "configured" (this list) vs "browse" (live
// browse_media on-device) and is whitelisted, falling back to whatever was
// already stored (then "configured") on anything else. `art` is optional
// box-art for a game's library row - trimmed like every other string
// field, blank allowed - and is unrelated to the now-playing hero art,
// which the device reads live from the media_player entity itself.

const XBOX_LIST_SOURCES = ['configured', 'browse'];

function normalizeXboxListSource(v, fallback) {
  return XBOX_LIST_SOURCES.includes(v) ? v : fallback;
}

function normalizeXboxGames(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    productId: str(it.productId, existing.productId || ''),
    art: str(it.art, existing.art || '')
  }));
}

function normalizeXbox(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    enabled: bool(b.enabled, e.enabled || false),
    name: str(b.name, e.name || 'Xbox'),
    mediaPlayerEntity: str(b.mediaPlayerEntity, e.mediaPlayerEntity || ''),
    remoteEntity: str(b.remoteEntity, e.remoteEntity || ''),
    listSource: normalizeXboxListSource(b.listSource, normalizeXboxListSource(e.listSource, 'configured')),
    games: normalizeXboxGames(b.games, e.games)
  };
}

// --- Quick Access hub (the device's home/launcher screen) ---------------
//
// An unbounded, ordered list of buttons - reuses the same id-preserving
// normalizeItemList() helper as Lighting's/Blinds'/Climate's/Xbox's lists.
// `target` (the screen the button's top 2/3 opens) is a plain string, not
// whitelisted here - a future screen id shouldn't get rejected by a server
// that hasn't been updated with the new name yet; the admin UI's select
// just offers the currently-known set. `action` (the bottom-third quick
// action) is its own nested object: `type` is whitelisted the same way
// Xbox's `listSource` is, `entity`/`service`/`data` are plain string
// coercions (blank allowed) - same reasoning as everywhere else in this
// file, no `controls` object since there's nothing per-item to toggle
// beyond what `type` already picks. `data` is stored as raw JSON text and
// parsed by the device, not validated here.

const HUB_ACTION_TYPES = ['toggle', 'run', 'none'];

function normalizeHubActionType(v, fallback) {
  return HUB_ACTION_TYPES.includes(v) ? v : fallback;
}

function normalizeHubAction(action, existing) {
  const e = (existing && typeof existing === 'object') ? existing : {};
  if (!action || typeof action !== 'object') {
    return { type: 'none', entity: '', service: '', data: '' };
  }
  return {
    type: normalizeHubActionType(action.type, normalizeHubActionType(e.type, 'none')),
    entity: str(action.entity, e.entity || ''),
    service: str(action.service, e.service || ''),
    data: str(action.data, e.data || '')
  };
}

function normalizeHubItems(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    icon: str(it.icon, existing.icon || ''),
    target: str(it.target, existing.target || ''),
    action: normalizeHubAction(it.action, existing.action)
  }));
}

function normalizeHub(body, existing) {
  const b = body || {};
  const e = existing || {};
  const fallbackEnabled = typeof e.quickActionsEnabled === 'boolean' ? e.quickActionsEnabled : true;
  return {
    quickActionsEnabled: bool(b.quickActionsEnabled, fallbackEnabled),
    items: normalizeHubItems(b.items, e.items)
  };
}

/**
 * @param {object} body - raw request body
 * @param {object} existing - previously stored profile (for defaults/merge)
 */
function normalizeProfile(body, existing) {
  const base = existing || {};
  const b = body || {};

  return {
    name: str(b.name, base.name || ''),
    description: str(b.description, base.description || ''),
    homeAssistant: {
      // Defaults to false (room-specific) rather than true when missing,
      // so a profile saved before Globals existed doesn't silently switch
      // from its own already-configured connection to the (empty) global
      // one the first time it's re-saved. Brand-new profiles get
      // `useGlobal: true` explicitly from store.js's defaultProfile()
      // instead, so the recommended default only applies going forward.
      useGlobal: bool(
        b.homeAssistant && b.homeAssistant.useGlobal,
        (base.homeAssistant && base.homeAssistant.useGlobal) || false
      ),
      host: str(
        b.homeAssistant && b.homeAssistant.host,
        (base.homeAssistant && base.homeAssistant.host) || ''
      ),
      port: num(
        b.homeAssistant && b.homeAssistant.port,
        (base.homeAssistant && base.homeAssistant.port) || 8123
      ),
      token: str(
        b.homeAssistant && b.homeAssistant.token,
        (base.homeAssistant && base.homeAssistant.token) || ''
      )
    },
    standby: {
      weatherEntity: str(
        b.standby && b.standby.weatherEntity,
        (base.standby && base.standby.weatherEntity) || ''
      ),
      climateEntity: str(
        b.standby && b.standby.climateEntity,
        (base.standby && base.standby.climateEntity) || ''
      ),
      refreshIntervalMin: standbyRefreshMin(
        b.standby && b.standby.refreshIntervalMin,
        (base.standby && base.standby.refreshIntervalMin) || 30
      ),
      // Timer refreshes on the clock (:00 and :30 for every 30 min), each
      // remote a few seconds apart; off = N minutes after it went to sleep.
      refreshAligned: bool(b.standby && b.standby.refreshAligned, (base.standby && base.standby.refreshAligned) || false)
    },
    lighting: normalizeLighting(b.lighting, base.lighting),
    blinds: normalizeBlinds(b.blinds, base.blinds),
    screens: normalizeScreens(b.screens, base.screens),
    media: normalizeMedia(b.media, base.media),
    climate: normalizeClimate(b.climate, base.climate),
    tv: normalizeTv(b.tv, base.tv),
    xbox: normalizeXbox(b.xbox, base.xbox),
    receiver: normalizeReceiver(b.receiver, base.receiver),
    hub: normalizeHub(b.hub, base.hub)
  };
}

// --- WiFi networks (household-wide list, for a shared on-device screen) --
//
// Just {name, password} pairs - `name` doubles as the SSID a device
// actually connects to, same as how a real WiFi network's "name" and
// SSID are the same thing. Reuses the same id-preserving
// normalizeItemList() helper Lighting's/Blinds'/Climate's lists use.

function normalizeWifiNetworks(list, existingList) {
  return normalizeItemList(list, existingList, (it, existing, id) => ({
    id,
    name: str(it.name, existing.name || ''),
    password: str(it.password, existing.password || '')
  }));
}

/**
 * Normalizes/validates an incoming Globals body (WiFi + the default Home
 * Assistant connection every room profile falls back to). Same
 * permissive-coercion style as normalizeProfile above.
 *
 * @param {object} body - raw request body
 * @param {object} existing - previously stored globals (for defaults/merge)
 */
function normalizeGlobals(body, existing) {
  const base = existing || {};
  const b = body || {};

  return {
    wifi: {
      ssid: str(b.wifi && b.wifi.ssid, (base.wifi && base.wifi.ssid) || ''),
      password: str(
        b.wifi && b.wifi.password,
        (base.wifi && base.wifi.password) || ''
      )
    },
    homeAssistant: {
      host: str(
        b.homeAssistant && b.homeAssistant.host,
        (base.homeAssistant && base.homeAssistant.host) || ''
      ),
      port: num(
        b.homeAssistant && b.homeAssistant.port,
        (base.homeAssistant && base.homeAssistant.port) || 8123
      ),
      token: str(
        b.homeAssistant && b.homeAssistant.token,
        (base.homeAssistant && base.homeAssistant.token) || ''
      ),
      // Publish each device's battery back to Home Assistant as sensors
      // (lib/ha-publish.js). Off unless switched on.
      publishBattery: bool(
        b.homeAssistant && b.homeAssistant.publishBattery,
        Boolean(base.homeAssistant && base.homeAssistant.publishBattery)
      )
    },
    // NTP server for the on-device live clock (see lib/store.js's
    // defaultGlobals doc comment) - not a Home Assistant entity, just a
    // hostname/IP, so a plain string coercion same as everything else here.
    ntpServer: str(b.ntpServer, base.ntpServer || 'pool.ntp.org'),
    // WiFi networks list (see lib/store.js's defaultGlobals doc comment) -
    // household-wide, unbounded, reuses the same id-preserving
    // normalizeItemList() helper as every list elsewhere in this file.
    wifiNetworks: normalizeWifiNetworks(b.wifiNetworks, base.wifiNetworks)
  };
}

module.exports = {
  REMOTE_PAGE_IDS,
  normalizeProfile,
  normalizeGlobals,
  normalizeHub,
  str,
  bool,
  num
};
