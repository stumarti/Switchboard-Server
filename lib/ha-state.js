'use strict';

/**
 * Live Home Assistant state for one room, fetched here on the server so a
 * remote can refresh every carousel page in ONE request
 * (GET /api/devices/:slug/state) instead of a dozen-plus sequential ones —
 * each of which, on the device, is a Wi-Fi wake-up's worth of radio time.
 *
 * The entity list mirrors exactly what the firmware reads for each page
 * (see its app/data_refresh.h). Every entity is fetched in parallel from
 * HA's REST API with the HA connection in /api/globals (the same one the
 * device itself uses), and trimmed to the attributes the firmware parses,
 * so the response stays a few KB. The daily forecast comes from the
 * weather.get_forecasts service, same as the device's own call.
 *
 * Nothing is cached: the device decides how often to ask.
 */

const haMonitor = require('./ha-monitor');

const HA_TIMEOUT_MS = 6000;

// Every attribute any firmware page reads (see its ha_client.h filters).
const ATTRIBUTES = [
  // weather
  'temperature', 'humidity', 'wind_speed', 'wind_speed_unit', 'uv_index',
  // climate
  'current_temperature', 'min_temp', 'max_temp', 'target_temp_step', 'hvac_modes',
  // light
  'brightness',
  // cover
  'current_position',
  // media players
  'media_title', 'media_artist', 'entity_picture', 'volume_level', 'is_volume_muted',
  // an Enigma2 receiver: the channel, the programme on it, the selected source
  'media_channel', 'media_series_title', 'source',
  // air quality
  'air_quality_index', 'aqi'
];

const FORECAST_DAYS = 3;
const FORECAST_FIELDS = ['datetime', 'condition', 'temperature', 'templow'];

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// The entity ids a room's pages show — the same set, and the same
// conditions, as the firmware's refresh.
function roomEntities(profile) {
  const p = profile || {};
  const out = new Set();
  const add = (e) => {
    const id = str(e);
    if (id) out.add(id);
  };
  const standby = p.standby || {};
  add(standby.weatherEntity);
  add(standby.climateEntity);
  add(standby.airQualityEntity);

  const lighting = p.lighting || {};
  if (lighting.group && lighting.group.enabled) add(lighting.group.entity);
  for (const l of lighting.lights || []) add(l && l.entity);

  const blinds = p.blinds || {};
  if (blinds.group && blinds.group.enabled) add(blinds.group.entity);
  const items = (blinds.items || []).filter((it) => it && str(it.entity));
  if (items.length === 2) items.forEach((it) => add(it.entity));

  const climate = p.climate || {};
  for (const s of (climate.additionalSensors || []).slice(0, 6)) add(s && s.entity);

  if (p.media && p.media.enabled) add(p.media.entity);
  if (p.xbox) add(p.xbox.mediaPlayerEntity);
  if (p.receiver) add(p.receiver.mediaPlayerEntity);

  const hub = p.hub || {};
  for (const it of hub.items || []) {
    const act = (it && it.action) || {};
    if (act.type === 'toggle') add(act.entity);
  }
  return [...out];
}

function haBase(globals) {
  const ha = (globals && globals.homeAssistant) || {};
  const host = str(ha.host);
  const token = str(ha.token);
  if (!host || !token) return null;
  const port = Number(ha.port) || 8123;
  return { url: `http://${host}:${port}`, token };
}

// Every call's outcome goes to lib/ha-monitor.js for the Home page. A 404
// is HA answering (an entity it doesn't have), not HA being down.
async function haRequest(base, path, init = {}) {
  const started = Date.now();
  try {
    const res = await fetch(base.url + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${base.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      },
      signal: AbortSignal.timeout(HA_TIMEOUT_MS)
    });
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'HTTP 401 (token rejected)' : `HTTP ${res.status}`);
      err.answered = res.status === 404;
      throw err;
    }
    const body = await res.json();
    haMonitor.record(path, Date.now() - started, null);
    return body;
  } catch (e) {
    const msg =
      e.name === 'TimeoutError' ? `no answer in ${HA_TIMEOUT_MS / 1000} s` : e.cause && e.cause.code ? `${e.message} (${e.cause.code})` : e.message;
    haMonitor.record(path, Date.now() - started, e.answered ? null : new Error(msg));
    // A timeout's DOMException message is read-only: rethrow a plain Error.
    throw msg === e.message ? e : Object.assign(new Error(msg), { answered: e.answered });
  }
}

// HA's media_player_proxy URL carries an access token that HA rotates every
// few minutes. The art is fetched with HA's bearer token anyway (lib/art.js,
// and the old firmware's direct fetch), so drop it: otherwise the picture —
// and the state's ETag — would change with no new track, costing a held-open
// remote an art download and a full refresh each time.
function stablePicture(pic) {
  if (typeof pic !== 'string' || !pic.includes('token=')) return pic;
  const [path, query = ''] = pic.split('?');
  const kept = query.split('&').filter((p) => p && !p.startsWith('token='));
  return kept.length ? `${path}?${kept.join('&')}` : path;
}

function trimState(raw) {
  const attrs = (raw && raw.attributes) || {};
  const attributes = {};
  for (const k of ATTRIBUTES) {
    if (attrs[k] !== undefined) attributes[k] = attrs[k];
  }
  if (attributes.entity_picture !== undefined) attributes.entity_picture = stablePicture(attributes.entity_picture);
  return { state: raw && raw.state != null ? String(raw.state) : '', attributes };
}

function trimForecast(days) {
  return (Array.isArray(days) ? days : []).slice(0, FORECAST_DAYS).map((d) => {
    const out = {};
    for (const k of FORECAST_FIELDS) if (d && d[k] !== undefined) out[k] = d[k];
    return out;
  });
}

/**
 * Returns { states: {entity: {state, attributes}}, forecast: {weatherEntity:
 * [days]}, errors: {entity: message} }. An entity HA couldn't give us goes
 * in `errors` (the device shows that page's "unavailable" placeholder, same
 * as a failed direct fetch); throws only if HA isn't configured at all.
 */
// The entities behind each page that can be "live" (change on their own
// while someone watches): what a remote re-reads, and only that, while the
// page is on screen.
function pageEntities(profile) {
  const p = profile || {};
  const out = { music: [], xbox: [], blinds: [] };
  if (p.media && p.media.enabled && str(p.media.entity)) out.music.push(str(p.media.entity));
  if (p.xbox && str(p.xbox.mediaPlayerEntity)) out.xbox.push(str(p.xbox.mediaPlayerEntity));
  const blinds = p.blinds || {};
  if (blinds.group && blinds.group.enabled && str(blinds.group.entity)) out.blinds.push(str(blinds.group.entity));
  const items = (blinds.items || []).filter((it) => it && str(it.entity));
  if (items.length === 2) items.forEach((it) => out.blinds.push(str(it.entity)));
  return out;
}

const PLAYING = new Set(['playing']);
const MOVING = new Set(['opening', 'closing']);

/**
 * Which pages are live right now: a player that's playing, blinds that are
 * moving. Everything else is passive — it only changes when someone presses
 * a button, so a remote has no reason to keep asking. Pages whose entities
 * aren't in `states` are left out (unknown).
 */
function livePages(profile, states) {
  const pages = pageEntities(profile);
  const out = {};
  for (const [page, ids] of Object.entries(pages)) {
    const known = ids.filter((id) => states[id]);
    if (!known.length) continue;
    const moving = page === 'blinds' ? MOVING : PLAYING;
    out[page] = known.some((id) => moving.has(states[id].state)) ? 'live' : 'passive';
  }
  return out;
}

/**
 * `only`: fetch just these entities (and no forecast) — a remote watching
 * one live page. Returns { states, forecast, errors, live }.
 */
async function fetchRoomState(profile, globals, { only } = {}) {
  const base = haBase(globals);
  if (!base) {
    const err = new Error('Home Assistant host/token not configured');
    err.code = 'NO_HA';
    throw err;
  }

  const entities = only ? roomEntities(profile).filter((e) => only.includes(e)) : roomEntities(profile);
  const states = {};
  const errors = {};
  const forecast = {};

  const weatherEntity = only ? '' : str(profile && profile.standby && profile.standby.weatherEntity);

  const jobs = entities.map(async (entity) => {
    try {
      states[entity] = trimState(await haRequest(base, `/api/states/${encodeURIComponent(entity)}`));
    } catch (e) {
      errors[entity] = e.message;
    }
  });

  if (weatherEntity) {
    jobs.push(
      (async () => {
        try {
          const body = JSON.stringify({ entity_id: weatherEntity, type: 'daily' });
          const r = await haRequest(base, '/api/services/weather/get_forecasts?return_response', {
            method: 'POST',
            body
          });
          const days = r && r.service_response && r.service_response[weatherEntity]
            ? r.service_response[weatherEntity].forecast
            : [];
          forecast[weatherEntity] = trimForecast(days);
        } catch (e) {
          errors[`forecast:${weatherEntity}`] = e.message;
        }
      })()
    );
  }

  await Promise.all(jobs);
  return { states, forecast, errors, live: livePages(profile, states) };
}

// --- Entity lookup for the admin UI's pickers -----------------------------
//
// One GET /api/states (every entity) cached for a few seconds, so typing in
// several pickers in a row doesn't hammer HA. Each entity comes back with
// what the pickers show (friendly name, state, icon) and what the room
// editor can fill in for you (capabilities).

const ENTITY_CACHE_MS = 15000;
let entityCache = { at: 0, key: '', list: null };

// What the room editor can infer from an entity instead of asking.
function capabilitiesOf(entity) {
  const [domain] = entity.entity_id.split('.');
  const a = entity.attributes || {};
  const caps = {};
  if (domain === 'light') {
    const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
    caps.brightness = modes.some((m) => m !== 'onoff');
    caps.colorTemp = modes.includes('color_temp');
    caps.color = modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m));
    caps.effects = Array.isArray(a.effect_list) && a.effect_list.length > 0;
  } else if (domain === 'climate') {
    caps.hvacModes = Array.isArray(a.hvac_modes) ? a.hvac_modes : [];
  } else if (domain === 'cover') {
    // CoverEntityFeature.SET_POSITION = 4
    caps.position = (Number(a.supported_features) & 4) === 4;
  } else if (domain === 'media_player') {
    // An Enigma2 box lists its whole bouquet here: keep enough to pick from.
    caps.sources = Array.isArray(a.source_list) ? a.source_list.slice(0, 500) : [];
  } else if (domain === 'sensor') {
    caps.deviceClass = a.device_class || '';
    caps.unit = a.unit_of_measurement || '';
  }
  return caps;
}

async function allEntities(globals) {
  const base = haBase(globals);
  if (!base) {
    const err = new Error('Home Assistant host/token not configured');
    err.code = 'NO_HA';
    throw err;
  }
  const key = `${base.url}|${base.token}`;
  if (entityCache.list && entityCache.key === key && Date.now() - entityCache.at < ENTITY_CACHE_MS) {
    return entityCache.list;
  }
  const raw = await haRequest(base, '/api/states');
  const list = (Array.isArray(raw) ? raw : []).map((e) => {
    const a = e.attributes || {};
    return {
      entity_id: e.entity_id,
      domain: e.entity_id.split('.')[0],
      name: a.friendly_name || e.entity_id,
      state: e.state,
      icon: typeof a.icon === 'string' && a.icon.startsWith('mdi:') ? a.icon.slice(4) : '',
      deviceClass: a.device_class || '',
      unit: a.unit_of_measurement || '',
      capabilities: capabilitiesOf(e),
      // States it can take, where HA says (select/enum sensors), and its
      // attribute names — for the admin UI's rule editors.
      options: Array.isArray(a.options) ? a.options.slice(0, 50).map(String) : undefined,
      attributes: Object.keys(a).filter((k) => !['friendly_name', 'icon', 'entity_picture', 'supported_features'].includes(k)).slice(0, 40)
    };
  });
  list.sort((x, y) => x.name.localeCompare(y.name));
  entityCache = { at: Date.now(), key, list };
  return list;
}

// Entities in any of `domains` (all if empty), optionally matching `q` in
// their id or friendly name, optionally only sensors of `deviceClass`.
async function searchEntities(globals, { domains = [], q = '', deviceClass = '', limit = 50 } = {}) {
  const needle = q.trim().toLowerCase();
  return (await allEntities(globals))
    .filter((e) => !domains.length || domains.includes(e.domain))
    .filter((e) => !deviceClass || e.deviceClass === deviceClass)
    .filter((e) => !needle || e.entity_id.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle))
    .slice(0, limit);
}

// Look up specific ids (the room editor's validity badges): each is the
// entity, or null if HA doesn't have it.
async function lookupEntities(globals, ids) {
  const byId = new Map((await allEntities(globals)).map((e) => [e.entity_id, e]));
  const out = {};
  for (const id of ids) out[id] = byId.get(id) || null;
  return out;
}

// Can the server reach HA with the configured connection?
async function checkConnection(globals) {
  const base = haBase(globals);
  if (!base) return { ok: false, error: 'Home Assistant host/token not configured' };
  try {
    const r = await haRequest(base, '/api/');
    return { ok: true, message: (r && r.message) || 'API running.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  pageEntities,
  livePages,
  haBase,
  haRequest,
  roomEntities,
  fetchRoomState,
  ATTRIBUTES,
  stablePicture,
  searchEntities,
  lookupEntities,
  checkConnection
};
