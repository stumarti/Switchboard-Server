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

async function haRequest(base, path, init = {}) {
  const res = await fetch(base.url + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${base.token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(HA_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function trimState(raw) {
  const attrs = (raw && raw.attributes) || {};
  const attributes = {};
  for (const k of ATTRIBUTES) {
    if (attrs[k] !== undefined) attributes[k] = attrs[k];
  }
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
async function fetchRoomState(profile, globals) {
  const base = haBase(globals);
  if (!base) {
    const err = new Error('Home Assistant host/token not configured');
    err.code = 'NO_HA';
    throw err;
  }

  const entities = roomEntities(profile);
  const states = {};
  const errors = {};
  const forecast = {};

  const weatherEntity = str(profile && profile.standby && profile.standby.weatherEntity);

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
  return { states, forecast, errors };
}

module.exports = { roomEntities, fetchRoomState, ATTRIBUTES };
