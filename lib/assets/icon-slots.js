'use strict';

/**
 * The exact set of named icon slots the Switchboard firmware renders -
 * mirrors include/default_icon_table.h in the firmware repo one-to-one
 * (that file is the runtime fallback; this manifest is what the admin picks
 * replacements against). Each slot's `key` is what the firmware's
 * `icons::get(key)` looks up and is derived mechanically from the existing
 * compile-time identifier (see the Switchboard-Server plan's Part B): strip
 * the leading `k`, lowercase it - `kWx_ui_cog` -> `wx_ui_cog`, `kNav_status`
 * -> `nav_status`, `kMode_heat` -> `mode_heat`, `kLogoRemote` -> `logoremote`.
 *
 * `defaultMdi` is the MDI icon name (`@mdi/svg`) that slot currently renders
 * as - an unmodified slot compiles back to the same look. `size` is the
 * pixel size that slot is drawn at in the firmware today.
 *
 * MAINTENANCE NOTE: this is a second copy of knowledge that otherwise only
 * lives in the firmware's icon call sites (weather_icons.h/assets.h + every
 * screen_*.h that references them). If a future firmware change adds a new
 * icon slot, this manifest needs a matching entry added by hand - there is
 * no shared schema file enforcing that today.
 */

function slot(key, category, label, defaultMdi, size) {
  return { key, category, label, defaultMdi, size };
}

// --- weather_icons.h: hero + forecast condition glyphs (same MDI source,
// two sizes) -----------------------------------------------------------
const WEATHER = [
  ['clear_night', 'weather-night'],
  ['cloudy', 'weather-cloudy'],
  ['exceptional', 'alert-circle-outline'],
  ['fog', 'weather-fog'],
  ['hail', 'weather-hail'],
  ['lightning', 'weather-lightning'],
  ['lightning_rainy', 'weather-lightning-rainy'],
  ['partlycloudy', 'weather-partly-cloudy'],
  ['pouring', 'weather-pouring'],
  ['rainy', 'weather-rainy'],
  ['snowy', 'weather-snowy'],
  ['snowy_rainy', 'weather-snowy-rainy'],
  ['sunny', 'weather-sunny'],
  ['windy', 'weather-windy'],
  ['windy_variant', 'weather-windy-variant'],
  ['night_partlycloudy', 'weather-night-partly-cloudy']
];

const ICON_SLOTS = [
  ...WEATHER.map(([alias, mdi]) =>
    slot(`wx_${alias}`, 'Weather (hero)', alias.replace(/_/g, ' '), mdi, 120)
  ),
  ...WEATHER.map(([alias, mdi]) =>
    slot(`wxf_${alias}`, 'Weather (forecast)', alias.replace(/_/g, ' '), mdi, 44)
  ),

  // Standby detail-row chrome
  slot('wx_ui_wind', 'Standby chrome', 'Wind', 'weather-windy', 24),
  slot('wx_ui_humidity', 'Standby chrome', 'Humidity', 'water-percent', 24),
  slot('wx_ui_indoor', 'Standby chrome', 'Indoor', 'home-thermometer-outline', 24),
  slot('wx_ui_air', 'Standby chrome', 'Air quality', 'air-filter', 24),

  // Control-shade / settings chrome
  slot('wx_ui_light', 'Chrome', 'Light', 'lightbulb-on-outline', 28),
  slot('wx_ui_bright', 'Chrome', 'Brightness', 'brightness-6', 28),
  slot('wx_ui_dimmer', 'Lighting', 'Darker', 'brightness-4', 28),
  slot('wx_ui_brighter', 'Lighting', 'Brighter', 'brightness-7', 28),
  slot('wx_ui_warm', 'Chrome', 'Warm', 'thermometer', 28),
  slot('wx_ui_refresh', 'Chrome', 'Refresh', 'refresh', 28),
  slot('wx_ui_cog', 'Chrome', 'Settings', 'cog', 28),
  slot('wx_ui_chevron_up', 'Chrome', 'Chevron up', 'chevron-up', 28),
  slot('wx_ui_temp_warm', 'Lighting', 'Warm preset', 'white-balance-incandescent', 28),
  slot('wx_ui_temp_daylight', 'Lighting', 'Daylight preset', 'white-balance-sunny', 28),
  slot('wx_ui_temp_cool', 'Lighting', 'Cool preset', 'white-balance-iridescent', 28),
  slot('wx_ui_room', 'Settings', 'Select room', 'home-outline', 28),
  slot('wx_ui_info', 'Settings', 'Device info', 'information-outline', 28),
  slot('wx_ui_wifi', 'Settings', 'WiFi setup', 'wifi', 28),
  slot('wx_ui_restart', 'Settings', 'Restart', 'restart', 28),
  slot('wx_ui_back', 'Chrome', 'Back', 'arrow-left', 28),

  // Lighting card's group bulb (on/off state)
  slot('wx_ui_bulb_on', 'Lighting', 'Bulb on', 'lightbulb-on', 36),
  slot('wx_ui_bulb_off', 'Lighting', 'Bulb off', 'lightbulb-outline', 36),

  // Climate page
  slot('wx_climate_off', 'Climate', 'Mode: off', 'power', 30),
  slot('wx_climate_heat', 'Climate', 'Mode: heat', 'fire', 30),
  slot('wx_climate_cool', 'Climate', 'Mode: cool', 'snowflake', 30),
  slot('wx_climate_auto', 'Climate', 'Mode: auto', 'thermostat-auto', 30),
  slot('wx_climate_fan', 'Climate', 'Mode: fan', 'fan', 30),
  slot('wx_climate_thermo', 'Climate', 'Thermometer', 'thermometer', 40),

  // Blinds page
  slot('wx_blinds_open', 'Blinds', 'Open', 'blinds-open', 64),
  slot('wx_blinds_closed', 'Blinds', 'Closed', 'blinds', 64),

  // Music page
  slot('wx_music_vol_on', 'Music', 'Volume on', 'volume-high', 36),
  slot('wx_music_vol_off', 'Music', 'Muted', 'volume-off', 36),
  slot('wx_music_vol_minus', 'Music', 'Volume down', 'volume-minus', 28),
  slot('wx_music_vol_plus', 'Music', 'Volume up', 'volume-plus', 28),
  slot('wx_music_play', 'Music', 'Play', 'play', 42),
  slot('wx_music_pause', 'Music', 'Pause', 'pause', 42),
  slot('wx_music_next', 'Music', 'Next', 'skip-next', 42),
  slot('wx_music_prev', 'Music', 'Previous', 'skip-previous', 42),

  // TV page
  slot('wx_tv_app_netflix', 'TV', 'Netflix', 'netflix', 36),
  slot('wx_tv_app_youtube', 'TV', 'YouTube', 'youtube', 36),
  slot('wx_tv_app_generic', 'TV', 'Generic app', 'television', 36),
  slot('wx_tv_back', 'TV', 'Back', 'arrow-left', 42),
  slot('wx_tv_home', 'TV', 'Home', 'home', 42),
  slot('wx_tv_power', 'TV', 'Power', 'power', 42),

  // Jump-to / Quick Access grid
  slot('wx_jump_status', 'Jump grid', 'Status', 'view-dashboard-outline', 40),
  slot('wx_jump_lighting', 'Jump grid', 'Lighting', 'lightbulb-on-outline', 40),
  slot('wx_jump_blinds', 'Jump grid', 'Blinds', 'blinds', 40),
  slot('wx_jump_music', 'Jump grid', 'Music', 'music-note-outline', 40),
  slot('wx_jump_tv', 'Jump grid', 'TV', 'television', 40),
  slot('wx_jump_xbox', 'Jump grid', 'Xbox', 'microsoft-xbox', 40),
  slot('wx_jump_climate', 'Jump grid', 'Climate', 'thermostat', 40),
  slot('wx_jump_wifi', 'Jump grid', 'WiFi', 'wifi', 40),
  slot('wx_jump_settings', 'Jump grid', 'Settings', 'cog', 40),
  slot('wx_jump_selftest', 'Jump grid', 'Self-test', 'progress-check', 40),
  slot('wx_jump_errors', 'Jump grid', 'Errors', 'alert-circle-outline', 40),

  // assets.h: boot/chrome icons (hand-drawn originally; MDI equivalents below
  // seed a sane default look for anyone who re-skins without touching them)
  slot('logoremote', 'Boot', 'Switchboard logo', 'remote', 120),
  slot('wifiglyph', 'Boot', 'WiFi (large)', 'wifi', 96),
  slot('wifiradiating', 'Status bar', 'WiFi connected', 'wifi', 24),
  slot('wifiempty', 'Status bar', 'WiFi disconnected', 'wifi-off', 24),
  slot('moon', 'Status bar', 'Asleep', 'weather-night', 22),
  slot('nav_status', 'Carousel nav', 'Status', 'view-dashboard-outline', 22),
  slot('nav_climate', 'Carousel nav', 'Climate', 'thermostat', 22),
  slot('nav_music', 'Carousel nav', 'Music', 'music-note-outline', 22),
  slot('nav_tv', 'Carousel nav', 'TV', 'television', 22),
  slot('nav_xbox', 'Carousel nav', 'Xbox', 'microsoft-xbox', 22),
  slot('nav_lighting', 'Carousel nav', 'Lighting', 'lightbulb-on-outline', 22),
  slot('nav_wifi', 'Carousel nav', 'WiFi', 'wifi', 22),
  slot('nav_blinds', 'Carousel nav', 'Blinds', 'blinds', 22),
  slot('mode_heat', 'Climate (alt)', 'Heat', 'fire', 26),
  slot('mode_cool', 'Climate (alt)', 'Cool', 'snowflake', 26),
  slot('mode_off', 'Climate (alt)', 'Off', 'power', 26),
  slot('mode_auto', 'Climate (alt)', 'Auto', 'thermostat-auto', 26),
  slot('err_battery', 'Errors', 'Battery', 'battery-alert', 26),
  slot('err_cloud', 'Errors', 'Cloud/connectivity', 'cloud-alert', 26),
  slot('err_server', 'Errors', 'Server', 'server-network-off', 26)
];

function listSlots() {
  return ICON_SLOTS;
}

function findSlot(key) {
  return ICON_SLOTS.find((s) => s.key === key) || null;
}

module.exports = { listSlots, findSlot };
