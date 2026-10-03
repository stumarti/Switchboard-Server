'use strict';

/**
 * The theme for viewports (the colour wall displays — Switchboard-Viewport's
 * firmware), next to the remote's (icon-slots.js / font-slots.js). A viewport
 * draws different things at different sizes, so it has its own slots and
 * faces, compiled into its own packs alongside the remote's whenever the
 * Theme page builds them, and handed to each device by its kind
 * (GET /api/theme/icons.pack, /api/theme/fonts.pack).
 *
 * Icons: the fixed chrome the firmware draws (weather, the detail row, the
 * energy grid, footer, heating and security pages, error screens), each at
 * the size it's drawn. Icons a layout picks per item (status icons, "now"
 * items, rooms...) aren't slots: the device fetches those one by one from
 * /api/icons/mdi/:name, as the remote does.
 *
 * Fonts: the four faces the panel draws with, at the pixel sizes of its
 * built-in fonts (Adafruit fontconvert's 9pt/12pt/42pt at 141 dpi), in the
 * theme font's regular and bold weights. Mirrors the firmware's
 * include/theme_slots.h — keep the two in step.
 */

function slot(key, category, label, defaultMdi, size) {
  return { key, category, label, defaultMdi, size };
}

// Weather conditions as Home Assistant names them (plus the night variant
// of partly cloudy), drawn large beside the temperature and small in the
// forecast strip.
const WEATHER = [
  ['sunny', 'weather-sunny'],
  ['clear_night', 'weather-night'],
  ['partlycloudy', 'weather-partly-cloudy'],
  ['night_partlycloudy', 'weather-night-partly-cloudy'],
  ['cloudy', 'weather-cloudy'],
  ['rainy', 'weather-rainy'],
  ['pouring', 'weather-pouring'],
  ['lightning', 'weather-lightning'],
  ['lightning_rainy', 'weather-lightning-rainy'],
  ['snowy', 'weather-snowy'],
  ['snowy_rainy', 'weather-snowy-rainy'],
  ['hail', 'weather-hail'],
  ['fog', 'weather-fog'],
  ['windy', 'weather-windy'],
  ['windy_variant', 'weather-windy-variant'],
  ['exceptional', 'alert-circle-outline']
];

const WIND = [
  ['n', 'arrow-up'],
  ['ne', 'arrow-top-right'],
  ['e', 'arrow-right'],
  ['se', 'arrow-bottom-right'],
  ['s', 'arrow-down'],
  ['sw', 'arrow-bottom-left'],
  ['w', 'arrow-left'],
  ['nw', 'arrow-top-left']
];

const ICON_SLOTS = [
  ...WEATHER.map(([k, mdi]) => slot(`vwx_${k}`, 'Weather (now)', k.replace(/_/g, ' '), mdi, 88)),
  ...WEATHER.map(([k, mdi]) => slot(`vwxm_${k}`, 'Weather (forecast)', k.replace(/_/g, ' '), mdi, 32)),

  slot('vd_humidity', 'Weather details', 'Humidity', 'water-percent', 24),
  slot('vd_wind', 'Weather details', 'Wind', 'weather-windy', 24),
  slot('vd_uv', 'Weather details', 'UV', 'sun-wireless', 24),
  ...WIND.map(([k, mdi]) => slot(`vd_wind_${k}`, 'Weather details', `Wind from ${k.toUpperCase()}`, mdi, 24)),
  slot('vd_rain', 'Weather details', 'Rain', 'water', 24),
  slot('vd_solar', 'Weather details', 'Solar forecast', 'solar-panel', 24),

  slot('ve_solar', 'Energy', 'Solar', 'solar-power-variant', 44),
  slot('ve_load', 'Energy', 'House use', 'home-lightning-bolt-outline', 44),
  slot('ve_import', 'Energy', 'From grid', 'transmission-tower-import', 44),
  slot('ve_export', 'Energy', 'To grid', 'transmission-tower-export', 44),
  slot('ve_battery', 'Energy', 'Home battery', 'battery-high', 24),

  slot('vf_battery', 'Footer', 'Device battery', 'battery', 24),
  slot('vf_refresh', 'Footer', 'Updated', 'refresh', 16),
  slot('vf_quiet', 'Footer', 'Quiet hours', 'bed-clock', 16),

  slot('vh_flame', 'Heating', 'Heating', 'fire', 64),
  slot('vh_water', 'Heating', 'Hot water', 'water', 64),
  slot('vh_calling', 'Heating', 'Zone calling', 'fire', 20),

  slot('vs_disarmed', 'Security', 'Disarmed', 'shield-check', 64),
  slot('vs_armed', 'Security', 'Armed', 'shield-alert', 64),
  slot('vs_door', 'Security', 'Door', 'door', 20),
  slot('vs_window', 'Security', 'Window', 'window-closed-variant', 20),
  slot('vs_motion', 'Security', 'Motion', 'motion-sensor', 20),
  slot('vs_camera', 'Security', 'Camera', 'cctv', 20),

  slot('vx_wifi_off', 'System', 'No Wi-Fi', 'wifi-off', 96),
  slot('vx_cloud_off', 'System', "Can't reach", 'cloud-off-outline', 96),
  slot('vx_plug', 'System', 'Charge me', 'power-plug', 96),
  slot('vx_wifi', 'System', 'Wi-Fi setup', 'wifi', 64),
  slot('vx_link', 'System', 'Pairing', 'link-variant', 64),
  slot('vx_update', 'System', 'Updating', 'download', 64)
];

// The faces, by slot name; `weight` picks the theme font's regular or bold.
const FONT_FACES = [
  { slot: 'regular18', size: 18, weight: 'regular', first: 0x20, last: 0x7e, alpha: false, label: 'Small text' },
  { slot: 'bold18', size: 18, weight: 'bold', first: 0x20, last: 0x7e, alpha: false, label: 'Small bold (headings, labels)' },
  { slot: 'bold24', size: 24, weight: 'bold', first: 0x20, last: 0x7e, alpha: false, label: 'Bold (item titles)' },
  { slot: 'bold82', size: 82, weight: 'bold', first: 0x20, last: 0x7e, alpha: false, label: 'Huge (temperature, ON/OFF)' }
];

module.exports = {
  listSlots: () => ICON_SLOTS,
  // The slots a viewport's icon pack carries: only those given another icon.
  // The rest stay the panel's built-in art, which is in colour (the yellow
  // sun, the blue moon and rain, the solar panel) where a pack's icons are
  // one colour.
  packSlots: (overrides = {}) => ICON_SLOTS.filter((s) => overrides[s.key]),
  findSlot: (key) => ICON_SLOTS.find((s) => s.key === key) || null,
  listFaces: () => FONT_FACES
};
