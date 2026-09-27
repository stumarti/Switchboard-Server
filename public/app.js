'use strict';

/**
 * Admin UI for homeremote-server. Vanilla JS, no build step - this is a
 * small internal tool served directly by the container, so keeping it
 * dependency-free keeps the Docker image simple.
 *
 * Trimmed scope: this UI manages a room's name, its Home Assistant
 * connection, the Standby screen's settings, Climate (a main temperature
 * sensor plus an unbounded list of additional ones), Lighting, Blinds,
 * Media (an enable flag, a name, and its media_player entity - backs the
 * on-device Music screen, but named `media` rather than `music`), TV (an
 * Android TV's media_player + remote entities, plus three fixed app-
 * launch shortcuts), Xbox (the same media_player + remote split, plus an
 * unbounded games list), the Quick Access hub (a global enable flag plus
 * an unbounded, ordered list of launcher buttons, each opening a screen
 * and firing an optional quick action), and which on-device carousel
 * screens the room has enabled, plus one household-wide Globals record
 * (WiFi + a default Home
 * Assistant connection every room uses unless it switches on its own,
 * the clock's NTP server, and an unbounded list of WiFi networks for a
 * shared on-device WiFi screen). See lib/store.js's defaultProfile /
 * defaultGlobals doc comments and README.md.
 */

const state = {
  profiles: [],
  currentSlug: null,
  showingGlobals: false,
  showingDevices: false,
  showingTheme: false,
  devices: [],
  iconSlots: null,
  iconOverrides: {},
  iconPreviews: {},
  activeIconSlot: null,
  devicePreviewIndex: 0
};

const els = {
  profileList: document.getElementById('profile-list'),
  newProfileBtn: document.getElementById('new-profile-btn'),
  globalsNavBtn: document.getElementById('globals-nav-btn'),
  uploadInput: document.getElementById('upload-input'),
  mdnsHint: document.getElementById('mdns-hint'),
  versionHint: document.getElementById('version-hint'),
  emptyState: document.getElementById('empty-state'),
  form: document.getElementById('profile-form'),
  name: document.getElementById('field-name'),
  description: document.getElementById('field-description'),
  slug: document.getElementById('field-slug'),
  mdnsHost: document.getElementById('field-mdns-host'),
  saveStatus: document.getElementById('save-status'),
  downloadBtn: document.getElementById('download-btn'),
  deleteBtn: document.getElementById('delete-btn'),
  screensControls: document.getElementById('screens-controls'),
  haUseGlobal: document.getElementById('ha-use-global'),
  haGlobalLink: document.getElementById('ha-global-link'),
  haHost: document.getElementById('ha-host'),
  haPort: document.getElementById('ha-port'),
  haToken: document.getElementById('ha-token'),
  haTokenToggle: document.getElementById('ha-token-toggle'),
  standbyWeatherEntity: document.getElementById('standby-weather-entity'),
  standbyClimateEntity: document.getElementById('standby-climate-entity'),
  standbyRefresh: document.getElementById('standby-refresh'),
  climateEntity: document.getElementById('climate-entity'),
  climateSensorsList: document.getElementById('climate-sensors-list'),
  climateAddSensor: document.getElementById('climate-add-sensor'),
  lightingGroupEnabled: document.getElementById('lighting-group-enabled'),
  lightingGroupName: document.getElementById('lighting-group-name'),
  lightingGroupEntity: document.getElementById('lighting-group-entity'),
  lightingGroupControls: document.getElementById('lighting-group-controls'),
  lightingLightsList: document.getElementById('lighting-lights-list'),
  lightingScenesList: document.getElementById('lighting-scenes-list'),
  lightingAddLight: document.getElementById('lighting-add-light'),
  lightingAddScene: document.getElementById('lighting-add-scene'),
  blindsGroupEnabled: document.getElementById('blinds-group-enabled'),
  blindsGroupName: document.getElementById('blinds-group-name'),
  blindsGroupEntity: document.getElementById('blinds-group-entity'),
  blindsItemsList: document.getElementById('blinds-items-list'),
  blindsAddItem: document.getElementById('blinds-add-item'),
  mediaEnabled: document.getElementById('media-enabled'),
  mediaName: document.getElementById('media-name'),
  mediaEntity: document.getElementById('media-entity'),
  tvMediaPlayerEntity: document.getElementById('tv-media-player-entity'),
  tvRemoteEntity: document.getElementById('tv-remote-entity'),
  tvAppYoutube: document.getElementById('tv-app-youtube'),
  tvAppNetflix: document.getElementById('tv-app-netflix'),
  tvAppTvMate: document.getElementById('tv-app-tvmate'),
  xboxEnabled: document.getElementById('xbox-enabled'),
  xboxName: document.getElementById('xbox-name'),
  xboxMediaPlayerEntity: document.getElementById('xbox-media-player-entity'),
  xboxRemoteEntity: document.getElementById('xbox-remote-entity'),
  xboxListSource: document.getElementById('xbox-list-source'),
  xboxGamesList: document.getElementById('xbox-games-list'),
  xboxAddGame: document.getElementById('xbox-add-game'),
  hubQuickActionsEnabled: document.getElementById('hub-quick-actions-enabled'),
  hubItemsList: document.getElementById('hub-items-list'),
  hubAddItem: document.getElementById('hub-add-item'),
  globalsForm: document.getElementById('globals-form'),
  globalsSaveStatus: document.getElementById('globals-save-status'),
  wifiSsid: document.getElementById('wifi-ssid'),
  wifiPassword: document.getElementById('wifi-password'),
  wifiPasswordToggle: document.getElementById('wifi-password-toggle'),
  wifiNetworksList: document.getElementById('wifi-networks-list'),
  wifiNetworksAdd: document.getElementById('wifi-networks-add'),
  globalHaHost: document.getElementById('global-ha-host'),
  globalHaPort: document.getElementById('global-ha-port'),
  globalHaToken: document.getElementById('global-ha-token'),
  globalHaTokenToggle: document.getElementById('global-ha-token-toggle'),
  ntpServer: document.getElementById('ntp-server'),

  authGate: document.getElementById('auth-gate'),
  authForm: document.getElementById('auth-form'),
  authHeading: document.getElementById('auth-heading'),
  authPassword: document.getElementById('auth-password'),
  authConfirmLabel: document.getElementById('auth-confirm-label'),
  authPasswordConfirm: document.getElementById('auth-password-confirm'),
  authError: document.getElementById('auth-error'),
  authSubmit: document.getElementById('auth-submit'),
  logoutBtn: document.getElementById('logout-btn'),

  devicesNavBtn: document.getElementById('devices-nav-btn'),
  devicesView: document.getElementById('devices-view'),
  devicesList: document.getElementById('devices-list'),

  themeNavBtn: document.getElementById('theme-nav-btn'),
  themeView: document.getElementById('theme-view'),
  themeFontFile: document.getElementById('theme-font-file'),
  themeGoogleFont: document.getElementById('theme-google-font'),
  themeFontCompile: document.getElementById('theme-font-compile'),
  themeFontStatus: document.getElementById('theme-font-status'),
  themeFontsVersion: document.getElementById('theme-fonts-version'),
  themeIconSearch: document.getElementById('theme-icon-search'),
  themeIconUpload: document.getElementById('theme-icon-upload'),
  themeIconSearchResults: document.getElementById('theme-icon-search-results'),
  themeCustomIconsList: document.getElementById('theme-custom-icons-list'),
  themeIconSlots: document.getElementById('theme-icon-slots'),
  themeIconsCompile: document.getElementById('theme-icons-compile'),
  themeIconsStatus: document.getElementById('theme-icons-status'),
  themeIconsVersion: document.getElementById('theme-icons-version'),

  devicePreview: document.getElementById('device-preview'),
  devicePreviewPrev: document.getElementById('device-preview-prev'),
  devicePreviewNext: document.getElementById('device-preview-next'),
  devicePreviewLabel: document.getElementById('device-preview-label'),
  devicePreviewScreen: document.getElementById('device-preview-screen')
};

// --- API helpers ---------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/setup') {
    showAuthGate();
    throw new Error('not authenticated');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch (_) {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- Auth (single shared admin password, session cookie) -----------------
//
// The auth gate is a full-screen overlay, not a separate page - simplest
// thing that works given this file's no-router, flip-.hidden style. api()
// above redirects here on any 401 (an expired/missing session, or an
// admin-only endpoint hit without one). setupRequired (no password set yet)
// swaps the form to a one-time "set a password" mode with a confirm field.

function showAuthGate() {
  document.querySelector('.app').hidden = true;
  els.authGate.hidden = false;
}

async function checkAuth() {
  const status = await fetch('/api/auth/status').then((r) => r.json());
  if (!status.authenticated) {
    els.authHeading.textContent = status.setupRequired
      ? 'Set an admin password'
      : 'Sign in';
    els.authConfirmLabel.hidden = !status.setupRequired;
    els.authSubmit.textContent = status.setupRequired ? 'Set password' : 'Sign in';
    els.authForm.dataset.mode = status.setupRequired ? 'setup' : 'login';
    showAuthGate();
    return false;
  }
  document.querySelector('.app').hidden = false;
  els.authGate.hidden = true;
  return true;
}

els.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.authError.hidden = true;
  const mode = els.authForm.dataset.mode;
  const password = els.authPassword.value;
  if (mode === 'setup' && password !== els.authPasswordConfirm.value) {
    els.authError.textContent = 'Passwords do not match.';
    els.authError.hidden = false;
    return;
  }
  try {
    await api(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    // Full reload rather than toggling state in place - same reasoning as
    // the logout handler below: guarantees a clean re-fetch of everything
    // against the now-authenticated session, no risk of any DOM state
    // (nav highlights, cached lists) left over from the logged-out gate.
    location.reload();
  } catch (err) {
    els.authError.textContent = err.message;
    els.authError.hidden = false;
  }
});

els.logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

// --- Profile list ----------------------------------------------------------

async function loadProfileList() {
  state.profiles = await api('/api/devices');
  renderProfileList();
}

function renderProfileList() {
  els.profileList.innerHTML = '';
  for (const p of state.profiles) {
    const li = document.createElement('li');
    li.className = !state.showingGlobals && p.slug === state.currentSlug ? 'active' : '';
    li.innerHTML = `
      <div class="p-name"></div>
      <div class="p-meta"></div>
    `;
    li.querySelector('.p-name').textContent = p.name;
    li.querySelector('.p-meta').textContent = p.updatedAt
      ? `Updated ${new Date(p.updatedAt).toLocaleString()}`
      : 'Never saved';
    li.addEventListener('click', () => selectProfile(p.slug));
    els.profileList.appendChild(li);
  }
}

function hideAllViews() {
  els.emptyState.hidden = true;
  els.form.hidden = true;
  els.globalsForm.hidden = true;
  els.devicesView.hidden = true;
  els.themeView.hidden = true;
  els.globalsNavBtn.classList.remove('active');
  els.devicesNavBtn.classList.remove('active');
  els.themeNavBtn.classList.remove('active');
  stopDevicesPolling();
}

async function selectProfile(slug) {
  const switchingRooms = state.currentSlug !== slug;
  state.currentSlug = slug;
  state.showingGlobals = false;
  state.showingDevices = false;
  state.showingTheme = false;
  renderProfileList();
  const profile = await api(`/api/devices/${encodeURIComponent(slug)}/config`);
  await preloadIconPreviews(profile);
  fillForm(profile);
  hideAllViews();
  els.form.hidden = false;
  if (switchingRooms) {
    state.devicePreviewIndex = 0;
    state.devicePreviewLightingTab = 'scenes';
  }
  renderDevicePreview();
}

// --- Form <-> profile object ---------------------------------------------

function applyHaUseGlobalState() {
  const usingGlobal = els.haUseGlobal.checked;
  for (const el of [els.haHost, els.haPort, els.haToken, els.haTokenToggle]) {
    el.disabled = usingGlobal;
  }
}

// --- Climate (main sensor + unbounded additional-temperatures list) ------
//
// Read-only display data for the on-device Climate screen - no controls,
// just a main entity plus name+entity rows for any additional sensors,
// same row-per-item DOM approach as Lighting/Blinds.

function createSensorRow(sensor) {
  const row = document.createElement('div');
  row.className = 'climate-item';
  row.dataset.id = (sensor && sensor.id) || '';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="sensor-name" value="${escapeAttr(sensor && sensor.name)}" placeholder="Living Room Floor" /></label>
      <label>Entity<input type="text" class="sensor-entity" value="${escapeAttr(sensor && sensor.entity)}" placeholder="sensor.living_room_temp" /></label>
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
  `;
  return row;
}

function renderClimateSensors(sensors) {
  els.climateSensorsList.innerHTML = '';
  (sensors || []).forEach((s) => els.climateSensorsList.appendChild(createSensorRow(s)));
}

function readClimateSensors() {
  return Array.from(els.climateSensorsList.querySelectorAll('.climate-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.sensor-name').value.trim(),
    entity: row.querySelector('.sensor-entity').value.trim()
  }));
}

function fillClimate(climate) {
  const c = climate || {};
  els.climateEntity.value = c.entity || '';
  renderClimateSensors(c.additionalSensors);
}

function readClimate() {
  return {
    entity: els.climateEntity.value.trim(),
    additionalSensors: readClimateSensors()
  };
}

// --- TV (Android TV: media_player + remote, plus 3 fixed app shortcuts) --
//
// Standard D-pad/Home/Back/volume controls come from the two entities'
// own Home Assistant capabilities - nothing to render here beyond the
// two entity fields. `apps` is a fixed trio, not a list, so no add/
// remove UI - just three plain text inputs.

function fillTv(tv) {
  const t = tv || {};
  const apps = t.apps || {};
  els.tvMediaPlayerEntity.value = t.mediaPlayerEntity || '';
  els.tvRemoteEntity.value = t.remoteEntity || '';
  els.tvAppYoutube.value = apps.youtube || '';
  els.tvAppNetflix.value = apps.netflix || '';
  els.tvAppTvMate.value = apps.tvMate || '';
}

function readTv() {
  return {
    mediaPlayerEntity: els.tvMediaPlayerEntity.value.trim(),
    remoteEntity: els.tvRemoteEntity.value.trim(),
    apps: {
      youtube: els.tvAppYoutube.value.trim(),
      netflix: els.tvAppNetflix.value.trim(),
      tvMate: els.tvAppTvMate.value.trim()
    }
  };
}

// --- Xbox (media_player + remote, plus an unbounded games list) ---------
//
// Same two-entity split as TV, no controls checkboxes for the same reason
// (the media_player's and remote's own Home Assistant capabilities already
// cover launch and power). Games are an unbounded list, not TV's fixed
// trio, so they get the same row-per-item, read-straight-from-the-DOM
// treatment as Lighting/Blinds/Climate. Each game's `art` field is only
// for its library row - the now-playing hero art is read live from the
// media_player entity on-device, never stored here.

function createGameRow(game) {
  const row = document.createElement('div');
  row.className = 'xbox-item';
  row.dataset.id = (game && game.id) || '';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="game-name" value="${escapeAttr(game && game.name)}" placeholder="Halo Infinite" /></label>
      <label>Product ID<input type="text" class="game-product-id" value="${escapeAttr(game && game.productId)}" placeholder="9PP5TF5D0S0X or Home" /></label>
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
    <div class="row">
      <label>Box art URL (optional)<input type="text" class="game-art" value="${escapeAttr(game && game.art)}" placeholder="https://... or /api/..." /></label>
    </div>
  `;
  return row;
}

function renderGamesList(games) {
  els.xboxGamesList.innerHTML = '';
  (games || []).forEach((game) => els.xboxGamesList.appendChild(createGameRow(game)));
}

function readGamesList() {
  return Array.from(els.xboxGamesList.querySelectorAll('.xbox-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.game-name').value.trim(),
    productId: row.querySelector('.game-product-id').value.trim(),
    art: row.querySelector('.game-art').value.trim()
  }));
}

function fillXbox(xbox) {
  const x = xbox || {};
  els.xboxEnabled.checked = Boolean(x.enabled);
  els.xboxName.value = x.name || '';
  els.xboxMediaPlayerEntity.value = x.mediaPlayerEntity || '';
  els.xboxRemoteEntity.value = x.remoteEntity || '';
  els.xboxListSource.value = x.listSource || 'configured';
  renderGamesList(x.games);
}

function readXbox() {
  return {
    enabled: els.xboxEnabled.checked,
    name: els.xboxName.value.trim(),
    mediaPlayerEntity: els.xboxMediaPlayerEntity.value.trim(),
    remoteEntity: els.xboxRemoteEntity.value.trim(),
    listSource: els.xboxListSource.value,
    games: readGamesList()
  };
}

// --- Quick Access hub (device home/launcher screen) ---------------------
//
// An unbounded, ordered list of buttons - each one's top two-thirds opens
// a `target` screen, its bottom third fires a quick `action`. Same
// row-per-item, read-straight-from-the-DOM treatment as Lighting/Blinds/
// Climate/Xbox. `target` is a free-form string server-side, but the row
// offers a select of the currently-known screens; if a stored item's
// target isn't one of those (a newer screen this admin UI doesn't know
// about yet), an extra option is added so the value isn't silently
// changed out from under it just by opening the row. The entity/service/
// data fields are only shown once an action type is picked - same
// show/hide-by-value idea as the "Use global connection" checkbox above,
// just hiding rather than disabling since there's nothing to fill in at
// all when the action type is "None".

const HUB_TARGETS = ['media', 'climate', 'lighting', 'tv', 'xbox', 'guestwifi', 'vacuum'];

function hubTargetOptionsHtml(current) {
  const targets = HUB_TARGETS.includes(current) || !current
    ? HUB_TARGETS
    : [...HUB_TARGETS, current];
  return targets
    .map((t) => `<option value="${escapeAttr(t)}" ${t === current ? 'selected' : ''}>${escapeAttr(t)}</option>`)
    .join('');
}

function applyHubRowActionState(row) {
  const type = row.querySelector('.hub-item-action-type').value;
  row.querySelector('.hub-item-action-fields').hidden = type === 'none';
}

function createHubRow(item) {
  const it = item || {};
  const action = it.action || {};
  const row = document.createElement('div');
  row.className = 'hub-item';
  row.dataset.id = it.id || '';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="hub-item-name" value="${escapeAttr(it.name)}" placeholder="Movie Mode" /></label>
      ${iconPickerHtml(it.icon)}
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
    <div class="row">
      <label>Opens screen
        <select class="hub-item-target">${hubTargetOptionsHtml(it.target)}</select>
      </label>
      <label class="narrow">Quick action
        <select class="hub-item-action-type">
          <option value="toggle" ${action.type === 'toggle' ? 'selected' : ''}>Toggle</option>
          <option value="run" ${action.type === 'run' ? 'selected' : ''}>Run</option>
          <option value="none" ${!action.type || action.type === 'none' ? 'selected' : ''}>None</option>
        </select>
      </label>
    </div>
    <div class="row hub-item-action-fields">
      <label>Entity<input type="text" class="hub-item-action-entity" value="${escapeAttr(action.entity)}" placeholder="light.lamp" /></label>
      <label>Service (optional)<input type="text" class="hub-item-action-service" value="${escapeAttr(action.service)}" placeholder="light.turn_on" /></label>
      <label>Data (optional, JSON)<input type="text" class="hub-item-action-data" value="${escapeAttr(action.data)}" placeholder='{"brightness": 200}' /></label>
    </div>
  `;
  applyHubRowActionState(row);
  return row;
}

function renderHubList(items) {
  els.hubItemsList.innerHTML = '';
  (items || []).forEach((item) => els.hubItemsList.appendChild(createHubRow(item)));
}

function readHubList() {
  return Array.from(els.hubItemsList.querySelectorAll('.hub-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.hub-item-name').value.trim(),
    icon: row.querySelector('.icon-picker-value').value.trim(),
    target: row.querySelector('.hub-item-target').value,
    action: {
      type: row.querySelector('.hub-item-action-type').value,
      entity: row.querySelector('.hub-item-action-entity').value.trim(),
      service: row.querySelector('.hub-item-action-service').value.trim(),
      data: row.querySelector('.hub-item-action-data').value.trim()
    }
  }));
}

function fillHub(hub) {
  const h = hub || {};
  els.hubQuickActionsEnabled.checked = h.quickActionsEnabled !== false;
  renderHubList(h.items);
}

function readHub() {
  return {
    quickActionsEnabled: els.hubQuickActionsEnabled.checked,
    items: readHubList()
  };
}

// --- Lighting (whole-room group + unbounded lights/scenes lists) ---------
//
// Every light and the group always support on/off (not worth a checkbox);
// `controls` below is just the *extra* stuff - brightness, color
// temperature, RGB color, effects/presets - since real lights vary (a
// dumb on/off plug next to a full-color bulb) and each one should only
// show the controls it actually has. Lights and scenes are unbounded
// lists rendered as rows of plain inputs, built/read straight from the
// DOM rather than kept in a parallel JS array, matching this file's
// existing no-framework style.

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Shared icon picker (Hub buttons, Lighting lights/scenes, Blinds items)
//
// Type in a row's own search box, click one of the results to assign it -
// same two-step search-then-pick idea as the Theme page's slot picker, just
// scoped to each row's own DOM (`.icon-picker-wrap`) instead of a shared
// "active slot" state, since these rows are an unbounded, independent list
// rather than the Theme page's fixed, known set of ~107 slots. Reuses
// state.iconPreviews as a cross-page cache so an icon already looked up
// anywhere (Theme page, another row) doesn't refetch its preview.
// wireIconPicker(container) attaches once per list container (hub items,
// lighting lights, lighting scenes, blinds items) - event delegation, so it
// keeps working for rows added later via "+ Add".

function iconPickerHtml(iconName) {
  const preview = iconName && state.iconPreviews[iconName];
  return `
    <div class="icon-picker-wrap">
      <span class="icon-picker-label">Icon</span>
      <div class="icon-picker-row">
        <div class="icon-picker-preview">${preview ? `<img src="${preview}" width="24" height="24" alt="" />` : ''}</div>
        <input type="text" class="icon-picker-search" placeholder="search, e.g. movie (optional)" />
        <label class="icon-picker-upload-btn" title="Upload a custom SVG icon">
          +
          <input type="file" class="icon-picker-upload" accept=".svg,image/svg+xml" hidden />
        </label>
      </div>
      <input type="hidden" class="icon-picker-value" value="${escapeAttr(iconName)}" />
      <div class="icon-picker-results"></div>
    </div>
  `;
}

// Turns an uploaded filename into a valid icon id: lowercase, non-alnum
// runs collapsed to one hyphen, trimmed of leading/trailing hyphens, capped
// at the 64-char limit store.isValidCustomIconName enforces server-side.
function sanitizeIconName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '') // strip a file extension, if any
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Reads `file` as an SVG, asks for a name (prefilled from the filename),
// and uploads it - shared by the per-item icon pickers and the Theme
// page's own upload button. Returns {name, preview} on success (and caches
// the preview into state.iconPreviews), or null if the admin cancelled the
// name prompt or the upload failed (alerted already). The newly uploaded
// icon is immediately usable and, since it's now stored server-side,
// findable again later from any picker's search box without re-uploading.
async function promptAndUploadCustomIcon(file) {
  if (!file) return null;
  const svg = await file.text();
  const suggested = sanitizeIconName(file.name) || 'icon';
  const name = prompt('Name this icon (letters, digits, hyphens only):', suggested);
  if (!name) return null;
  const cleaned = sanitizeIconName(name);
  if (!cleaned) {
    alert('That name has no usable letters/digits.');
    return null;
  }
  try {
    const result = await api('/api/assets/icons/custom', {
      method: 'POST',
      body: JSON.stringify({ name: cleaned, svg })
    });
    state.iconPreviews[result.name] = result.preview;
    return result;
  } catch (err) {
    alert(`Could not upload icon: ${err.message}`);
    return null;
  }
}

async function uploadCustomIconInto(wrap, file) {
  const result = await promptAndUploadCustomIcon(file);
  if (!result) return;
  wrap.querySelector('.icon-picker-value').value = result.name;
  wrap.querySelector('.icon-picker-preview').innerHTML =
    `<img src="${result.preview}" width="24" height="24" alt="" />`;
}

function wireIconPicker(container) {
  let searchTimer = null;
  container.addEventListener('input', (e) => {
    if (!e.target.classList.contains('icon-picker-search')) return;
    const wrap = e.target.closest('.icon-picker-wrap');
    const results = wrap.querySelector('.icon-picker-results');
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      results.innerHTML = '';
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const matches = await api(`/api/assets/icons/search?q=${encodeURIComponent(q)}`);
        results.innerHTML = matches
          .map(
            (m) =>
              `<button type="button" class="icon-search-result ${m.source === 'custom' ? 'icon-search-result-custom' : ''}" data-name="${escapeAttr(m.name)}" title="${escapeAttr(m.name)}${m.source === 'custom' ? ' (custom)' : ''}"><img src="${m.preview}" width="24" height="24" alt="" /></button>`
          )
          .join('');
        for (const m of matches) state.iconPreviews[m.name] = m.preview;
      } catch (err) {
        /* best-effort search, ignore */
      }
    }, 250);
  });

  container.addEventListener('change', (e) => {
    if (!e.target.classList.contains('icon-picker-upload')) return;
    const wrap = e.target.closest('.icon-picker-wrap');
    const file = e.target.files[0];
    uploadCustomIconInto(wrap, file).finally(() => {
      e.target.value = '';
    });
  });

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.icon-search-result');
    if (!btn) return;
    const wrap = btn.closest('.icon-picker-wrap');
    wrap.querySelector('.icon-picker-value').value = btn.dataset.name;
    wrap.querySelector('.icon-picker-preview').innerHTML =
      `<img src="${state.iconPreviews[btn.dataset.name]}" width="24" height="24" alt="" />`;
    wrap.querySelector('.icon-picker-search').value = '';
    wrap.querySelector('.icon-picker-results').innerHTML = '';
  });
}

// Batch-fetches previews for every non-empty icon name already set on the
// profile being opened (hub items + lighting lights/scenes + blinds items),
// BEFORE the lists render - so existing picks show their glyph immediately
// instead of just a bare name. One round trip regardless of how many items
// reference icons; a name already cached (e.g. from an earlier profile,
// or the Theme page) is skipped.
async function preloadIconPreviews(profile) {
  const names = new Set();
  const collect = (list) => (list || []).forEach((it) => it && it.icon && names.add(it.icon));
  collect(profile.hub && profile.hub.items);
  collect(profile.lighting && profile.lighting.lights);
  collect(profile.lighting && profile.lighting.scenes);
  collect(profile.blinds && profile.blinds.items);

  const missing = Array.from(names).filter((n) => !state.iconPreviews[n]);
  if (!missing.length) return;
  try {
    const results = await api('/api/assets/icons/preview', {
      method: 'POST',
      body: JSON.stringify({ names: missing })
    });
    for (const r of results) state.iconPreviews[r.name] = r.preview;
  } catch (err) {
    /* best-effort - rows just show without a preview image if this fails */
  }
}

function controlCheckboxesHtml(controls) {
  const c = controls || {};
  const box = (key, label) =>
    `<label class="checkbox-label"><input type="checkbox" data-control="${key}" ${c[key] ? 'checked' : ''} /> ${label}</label>`;
  return [
    box('brightness', 'Brightness'),
    box('colorTemp', 'Color temperature'),
    box('color', 'RGB color'),
    box('effects', 'Effects')
  ].join('');
}

function readControlCheckboxes(container) {
  const result = {};
  container.querySelectorAll('input[data-control]').forEach((input) => {
    result[input.dataset.control] = input.checked;
  });
  return result;
}

function setControlCheckboxes(container, controls) {
  const c = controls || {};
  container.querySelectorAll('input[data-control]').forEach((input) => {
    input.checked = Boolean(c[input.dataset.control]);
  });
}

function applyLightingGroupState() {
  const enabled = els.lightingGroupEnabled.checked;
  els.lightingGroupName.disabled = !enabled;
  els.lightingGroupEntity.disabled = !enabled;
  els.lightingGroupControls.querySelectorAll('input').forEach((input) => {
    input.disabled = !enabled;
  });
}

function createLightRow(light) {
  const row = document.createElement('div');
  row.className = 'lighting-item';
  row.dataset.id = (light && light.id) || '';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="light-name" value="${escapeAttr(light && light.name)}" placeholder="Lamp" /></label>
      <label>Entity<input type="text" class="light-entity" value="${escapeAttr(light && light.entity)}" placeholder="light.lamp" /></label>
      ${iconPickerHtml(light && light.icon)}
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
    <div class="control-checkboxes light-controls">${controlCheckboxesHtml(light && light.controls)}</div>
  `;
  return row;
}

function createSceneRow(scene) {
  const row = document.createElement('div');
  row.className = 'lighting-item';
  row.dataset.id = (scene && scene.id) || '';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="scene-name" value="${escapeAttr(scene && scene.name)}" placeholder="Movie Night" /></label>
      <label>Entity<input type="text" class="scene-entity" value="${escapeAttr(scene && scene.entity)}" placeholder="scene.movie_night" /></label>
      ${iconPickerHtml(scene && scene.icon)}
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
  `;
  return row;
}

function renderLightsList(lights) {
  els.lightingLightsList.innerHTML = '';
  (lights || []).forEach((light) => els.lightingLightsList.appendChild(createLightRow(light)));
}

function renderScenesList(scenes) {
  els.lightingScenesList.innerHTML = '';
  (scenes || []).forEach((scene) => els.lightingScenesList.appendChild(createSceneRow(scene)));
}

function readLightsList() {
  return Array.from(els.lightingLightsList.querySelectorAll('.lighting-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.light-name').value.trim(),
    entity: row.querySelector('.light-entity').value.trim(),
    icon: row.querySelector('.icon-picker-value').value.trim(),
    controls: readControlCheckboxes(row.querySelector('.light-controls'))
  }));
}

function readScenesList() {
  return Array.from(els.lightingScenesList.querySelectorAll('.lighting-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.scene-name').value.trim(),
    entity: row.querySelector('.scene-entity').value.trim(),
    icon: row.querySelector('.icon-picker-value').value.trim()
  }));
}

function fillLighting(lighting) {
  const l = lighting || {};
  const group = l.group || {};
  els.lightingGroupEnabled.checked = Boolean(group.enabled);
  els.lightingGroupName.value = group.name || '';
  els.lightingGroupEntity.value = group.entity || '';
  setControlCheckboxes(els.lightingGroupControls, group.controls);
  applyLightingGroupState();
  renderLightsList(l.lights);
  renderScenesList(l.scenes);
}

function readLighting() {
  return {
    group: {
      enabled: els.lightingGroupEnabled.checked,
      name: els.lightingGroupName.value.trim(),
      entity: els.lightingGroupEntity.value.trim(),
      controls: readControlCheckboxes(els.lightingGroupControls)
    },
    lights: readLightsList(),
    scenes: readScenesList()
  };
}

// --- Blinds (whole-room group + unbounded individual list) ---------------
//
// Simpler than Lighting: every blind (and the group) just gets
// Open/Close/Stop, so there are no per-item control checkboxes - Stop
// already doubles as "go to favorite position" on real cover hardware/
// Home Assistant once the blind isn't moving. Same row-per-item,
// read-straight-from-the-DOM approach as Lighting's lights/scenes lists.

function createBlindRow(item) {
  const row = document.createElement('div');
  row.className = 'blinds-item';
  row.dataset.id = (item && item.id) || '';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="blind-name" value="${escapeAttr(item && item.name)}" placeholder="Living Room Blind" /></label>
      <label>Entity<input type="text" class="blind-entity" value="${escapeAttr(item && item.entity)}" placeholder="cover.living_room_blind" /></label>
      ${iconPickerHtml(item && item.icon)}
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
  `;
  return row;
}

function renderBlindsList(items) {
  els.blindsItemsList.innerHTML = '';
  (items || []).forEach((item) => els.blindsItemsList.appendChild(createBlindRow(item)));
}

function readBlindsList() {
  return Array.from(els.blindsItemsList.querySelectorAll('.blinds-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.blind-name').value.trim(),
    entity: row.querySelector('.blind-entity').value.trim(),
    icon: row.querySelector('.icon-picker-value').value.trim()
  }));
}

function applyBlindsGroupState() {
  const enabled = els.blindsGroupEnabled.checked;
  els.blindsGroupName.disabled = !enabled;
  els.blindsGroupEntity.disabled = !enabled;
}

function fillBlinds(blinds) {
  const b = blinds || {};
  const group = b.group || {};
  els.blindsGroupEnabled.checked = Boolean(group.enabled);
  els.blindsGroupName.value = group.name || '';
  els.blindsGroupEntity.value = group.entity || '';
  applyBlindsGroupState();
  renderBlindsList(b.items);
}

function readBlinds() {
  return {
    group: {
      enabled: els.blindsGroupEnabled.checked,
      name: els.blindsGroupName.value.trim(),
      entity: els.blindsGroupEntity.value.trim()
    },
    items: readBlindsList()
  };
}

// --- Active screens (per-room on/off flags) -------------------------------
//
// Deliberately independent of the Lighting/Blinds cards - this doesn't
// show/hide anything else on the form, it's just a flag set for the
// device's carousel. Climate/Media/TV/Xbox have no config tied to this
// flag (see this file's header comment) - just the checkbox. Note
// `screens.music` keeps that name (the on-device screen is still called
// "Music") even though the config object behind it below is `media`.

function fillScreens(screens) {
  const s = screens || {};
  els.screensControls.querySelectorAll('input[data-screen]').forEach((input) => {
    input.checked = s[input.dataset.screen] !== false;
  });
}

function readScreens() {
  const result = {};
  els.screensControls.querySelectorAll('input[data-screen]').forEach((input) => {
    result[input.dataset.screen] = input.checked;
  });
  return result;
}

// --- Media ----------------------------------------------------------------
//
// One player, same enabled/name/entity shape as Lighting's/Blinds' `group`
// object - no per-item list, no controls flags (a media_player entity's
// own Home Assistant supported_features already cover that).

function fillMedia(media) {
  const m = media || {};
  els.mediaEnabled.checked = Boolean(m.enabled);
  els.mediaName.value = m.name || '';
  els.mediaEntity.value = m.entity || '';
}

function readMedia() {
  return {
    enabled: els.mediaEnabled.checked,
    name: els.mediaName.value.trim(),
    entity: els.mediaEntity.value.trim()
  };
}

function fillForm(profile) {
  els.name.value = profile.name || '';
  els.description.value = profile.description || '';
  els.slug.textContent = profile.slug;

  fillScreens(profile.screens);

  els.haUseGlobal.checked = Boolean(
    profile.homeAssistant && profile.homeAssistant.useGlobal
  );
  els.haHost.value = (profile.homeAssistant && profile.homeAssistant.host) || '';
  els.haPort.value = (profile.homeAssistant && profile.homeAssistant.port) || 8123;
  els.haToken.value = (profile.homeAssistant && profile.homeAssistant.token) || '';
  els.haToken.type = 'password';
  els.haTokenToggle.textContent = 'Show';
  applyHaUseGlobalState();

  els.standbyWeatherEntity.value = (profile.standby && profile.standby.weatherEntity) || '';
  els.standbyClimateEntity.value = (profile.standby && profile.standby.climateEntity) || '';
  els.standbyRefresh.value = String((profile.standby && profile.standby.refreshIntervalMin) || 30);

  fillClimate(profile.climate);
  fillLighting(profile.lighting);
  fillBlinds(profile.blinds);
  fillMedia(profile.media);
  fillTv(profile.tv);
  fillXbox(profile.xbox);
  fillHub(profile.hub);

  els.saveStatus.textContent = '';
}

function readForm() {
  return {
    name: els.name.value.trim(),
    description: els.description.value.trim(),
    homeAssistant: {
      useGlobal: els.haUseGlobal.checked,
      host: els.haHost.value.trim(),
      port: Number(els.haPort.value) || 8123,
      token: els.haToken.value
    },
    standby: {
      weatherEntity: els.standbyWeatherEntity.value.trim(),
      climateEntity: els.standbyClimateEntity.value.trim(),
      refreshIntervalMin: Number(els.standbyRefresh.value) || 30
    },
    lighting: readLighting(),
    blinds: readBlinds(),
    screens: readScreens(),
    media: readMedia(),
    climate: readClimate(),
    tv: readTv(),
    xbox: readXbox(),
    hub: readHub()
  };
}

// --- Globals (WiFi + default Home Assistant connection) ------------------

async function selectGlobals() {
  state.showingGlobals = true;
  state.showingDevices = false;
  state.showingTheme = false;
  state.currentSlug = null;
  renderProfileList();
  const globals = await api('/api/globals');
  fillGlobalsForm(globals);
  hideAllViews();
  els.globalsNavBtn.classList.add('active');
  els.globalsForm.hidden = false;
}

// --- WiFi networks (household-wide list, for a shared on-device screen) --
//
// {name, password} pairs, unbounded, same row-per-item DOM approach as
// Lighting/Blinds/Climate - `name` doubles as the SSID. Each row gets its
// own password show/hide toggle (unlike the single WiFi field above,
// there's no one shared input to wire a single toggle button to).

function createWifiNetworkRow(network) {
  const row = document.createElement('div');
  row.className = 'wifi-item';
  row.dataset.id = (network && network.id) || '';
  row.innerHTML = `
    <div class="row">
      <label>Network name (SSID)<input type="text" class="wifi-name" value="${escapeAttr(network && network.name)}" placeholder="Guest" /></label>
      <label>Password
        <div class="token-row">
          <input type="password" class="wifi-item-password" autocomplete="new-password" value="${escapeAttr(network && network.password)}" />
          <button type="button" class="btn btn-secondary btn-small wifi-item-password-toggle">Show</button>
        </div>
      </label>
      <button type="button" class="btn btn-danger btn-small remove-item">Remove</button>
    </div>
  `;
  return row;
}

function renderWifiNetworks(networks) {
  els.wifiNetworksList.innerHTML = '';
  (networks || []).forEach((n) => els.wifiNetworksList.appendChild(createWifiNetworkRow(n)));
}

function readWifiNetworks() {
  return Array.from(els.wifiNetworksList.querySelectorAll('.wifi-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.wifi-name').value.trim(),
    password: row.querySelector('.wifi-item-password').value
  }));
}

function fillGlobalsForm(globals) {
  els.wifiSsid.value = (globals.wifi && globals.wifi.ssid) || '';
  els.wifiPassword.value = (globals.wifi && globals.wifi.password) || '';
  els.wifiPassword.type = 'password';
  els.wifiPasswordToggle.textContent = 'Show';

  renderWifiNetworks(globals.wifiNetworks);

  els.globalHaHost.value = (globals.homeAssistant && globals.homeAssistant.host) || '';
  els.globalHaPort.value = (globals.homeAssistant && globals.homeAssistant.port) || 8123;
  els.globalHaToken.value = (globals.homeAssistant && globals.homeAssistant.token) || '';
  els.globalHaToken.type = 'password';
  els.globalHaTokenToggle.textContent = 'Show';

  els.ntpServer.value = globals.ntpServer || '';

  els.globalsSaveStatus.textContent = '';
}

function readGlobalsForm() {
  return {
    wifi: {
      ssid: els.wifiSsid.value.trim(),
      password: els.wifiPassword.value
    },
    wifiNetworks: readWifiNetworks(),
    homeAssistant: {
      host: els.globalHaHost.value.trim(),
      port: Number(els.globalHaPort.value) || 8123,
      token: els.globalHaToken.value
    },
    ntpServer: els.ntpServer.value.trim()
  };
}

// --- Devices (every remote that has contacted this server) ---------------
//
// Approving a pending device is also how its default room gets assigned
// (the "room" select below doubles as both). Same row-per-item DOM
// approach as everywhere else in this file, but read-and-acted-on
// individually (each button posts immediately) rather than batched behind
// one form Save button, since these are independent admin actions on
// independent devices, not one record being edited.

function roomOptionsHtml(selected) {
  const opts = ['<option value="">— none —</option>'];
  for (const p of state.profiles) {
    opts.push(`<option value="${escapeAttr(p.slug)}" ${p.slug === selected ? 'selected' : ''}>${escapeAttr(p.name)}</option>`);
  }
  return opts.join('');
}

function createDeviceRow(device) {
  const row = document.createElement('div');
  row.className = 'device-item';
  row.dataset.mac = device.mac;
  const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'never';
  row.innerHTML = `
    <div class="row">
      <label>Name<input type="text" class="device-name" value="${escapeAttr(device.name)}" /></label>
      <label class="narrow">Status<span class="device-status-badge device-status-${escapeAttr(device.status)}">${escapeAttr(device.status)}</span></label>
      <label>Room<select class="device-room">${roomOptionsHtml(device.assignedSlug)}</select></label>
    </div>
    <p class="hint device-meta">MAC ${escapeAttr(device.mac)} · last seen ${lastSeen} · IP ${escapeAttr(device.lastIp || '—')}</p>
    <div class="row device-actions">
      ${device.status === 'pending' ? '<button type="button" class="btn btn-primary btn-small device-approve">Approve</button>' : ''}
      <button type="button" class="btn btn-secondary btn-small device-save-name">Save name</button>
      ${device.status === 'approved' ? '<button type="button" class="btn btn-secondary btn-small device-assign">Save room</button>' : ''}
      ${device.status === 'approved' ? '<button type="button" class="btn btn-danger btn-small device-revoke">Revoke</button>' : ''}
      <button type="button" class="btn btn-danger btn-small device-delete">Delete</button>
    </div>
  `;
  return row;
}

function renderDevicesList() {
  els.devicesList.innerHTML = '';
  state.devices.forEach((d) => els.devicesList.appendChild(createDeviceRow(d)));
}

async function loadDevices() {
  if (!state.profiles.length) await loadProfileList();
  state.devices = await api('/api/pairing/devices');
  renderDevicesList();
}

// A device shows up here the moment it registers (POST /api/pairing/
// register) - typically while an admin is sitting on this exact page
// waiting to approve it. Without polling, that only ever showed up after a
// manual nav-away-and-back; a physical remote pairing was invisible until
// then. Skips the re-render (but still refreshes state.devices) while a
// field in the list has focus, so a poll tick can't wipe out an in-progress
// rename.
let devicesPollTimer = null;
function startDevicesPolling() {
  stopDevicesPolling();
  devicesPollTimer = setInterval(async () => {
    if (!state.showingDevices) return;
    try {
      state.devices = await api('/api/pairing/devices');
      if (!els.devicesList.contains(document.activeElement)) renderDevicesList();
    } catch (err) {
      /* best-effort - a transient fetch failure just skips this tick */
    }
  }, 4000);
}
function stopDevicesPolling() {
  clearInterval(devicesPollTimer);
  devicesPollTimer = null;
}

async function selectDevices() {
  state.showingGlobals = false;
  state.showingDevices = true;
  state.showingTheme = false;
  state.currentSlug = null;
  renderProfileList();
  await loadDevices();
  hideAllViews();
  els.devicesNavBtn.classList.add('active');
  els.devicesView.hidden = false;
  startDevicesPolling();
}

els.devicesNavBtn.addEventListener('click', () => selectDevices());

els.devicesList.addEventListener('click', async (e) => {
  const row = e.target.closest('.device-item');
  if (!row) return;
  const mac = row.dataset.mac;
  try {
    if (e.target.classList.contains('device-approve')) {
      const slug = row.querySelector('.device-room').value;
      await api(`/api/pairing/${encodeURIComponent(mac)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ slug })
      });
      await loadDevices();
    } else if (e.target.classList.contains('device-save-name')) {
      const name = row.querySelector('.device-name').value.trim();
      await api(`/api/pairing/${encodeURIComponent(mac)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      await loadDevices();
    } else if (e.target.classList.contains('device-assign')) {
      const slug = row.querySelector('.device-room').value;
      await api(`/api/pairing/${encodeURIComponent(mac)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ slug })
      });
      await loadDevices();
    } else if (e.target.classList.contains('device-revoke')) {
      if (!confirm(`Revoke "${row.querySelector('.device-name').value}"? It will need to be re-approved before it can fetch config again.`)) return;
      await api(`/api/pairing/${encodeURIComponent(mac)}/revoke`, { method: 'POST' });
      await loadDevices();
    } else if (e.target.classList.contains('device-delete')) {
      if (!confirm(`Delete "${row.querySelector('.device-name').value}"? This cannot be undone.`)) return;
      await api(`/api/pairing/${encodeURIComponent(mac)}`, { method: 'DELETE' });
      await loadDevices();
    }
  } catch (err) {
    alert(`Could not update device: ${err.message}`);
  }
});

// --- Theme (runtime icon/font pack the firmware downloads) ---------------
//
// Icons: pick a slot (click its row), then search-and-click a replacement
// MDI icon - same "select a target, then act on it" two-step as nothing
// else in this file needs, since there's no free-form alias field (see
// lib/assets/icon-slots.js's doc comment for why: slots are fixed, named,
// and firmware-defined). Fonts: one uploaded/fetched file produces every
// face at once, so there's no per-slot picking at all.

function effectiveIconFor(slot) {
  return state.iconOverrides[slot.key] || slot.defaultMdi;
}

function iconSlotRowHtml(slot) {
  const mdi = effectiveIconFor(slot);
  const preview = state.iconPreviews[mdi];
  const active = state.activeIconSlot === slot.key;
  return `
    <div class="icon-slot-row ${active ? 'active' : ''}" data-key="${escapeAttr(slot.key)}">
      <div class="icon-slot-preview">${preview ? `<img src="${preview}" width="28" height="28" alt="" />` : ''}</div>
      <div class="icon-slot-label">
        <div class="icon-slot-name">${escapeAttr(slot.label)}</div>
        <div class="hint">${escapeAttr(slot.key)} · currently ${escapeAttr(mdi)}</div>
      </div>
    </div>
  `;
}

function renderIconSlots() {
  const byCategory = new Map();
  for (const slot of state.iconSlots) {
    if (!byCategory.has(slot.category)) byCategory.set(slot.category, []);
    byCategory.get(slot.category).push(slot);
  }
  let html = '';
  for (const [category, slots] of byCategory) {
    html += `<div class="icon-slot-category">${escapeAttr(category)}</div>`;
    html += slots.map(iconSlotRowHtml).join('');
  }
  els.themeIconSlots.innerHTML = html;
}

async function fetchIconPreviews(mdiNames) {
  const missing = mdiNames.filter((n) => !state.iconPreviews[n]);
  if (!missing.length) return;
  const results = await api('/api/assets/icons/preview', {
    method: 'POST',
    body: JSON.stringify({ names: missing })
  });
  for (const r of results) state.iconPreviews[r.name] = r.preview;
}

// The admin's own uploaded icon library - findable from any picker's search
// box (see lib/assets/icons.js's resolveIconSvg()), managed here since the
// Theme page is where every other named/reusable asset (fonts, the icon
// slots themselves) already lives.
async function renderCustomIconsList() {
  const icons = await api('/api/assets/icons/custom');
  await fetchIconPreviews(icons.map((i) => i.name));
  els.themeCustomIconsList.innerHTML = icons
    .map(
      (i) => `
      <div class="custom-icon-item" data-name="${escapeAttr(i.name)}">
        <img src="${state.iconPreviews[i.name] || ''}" width="24" height="24" alt="" />
        <span>${escapeAttr(i.name)}</span>
        <button type="button" class="btn btn-danger btn-small custom-icon-delete">Delete</button>
      </div>`
    )
    .join('');
}

async function loadThemeData() {
  const theme = await api('/api/theme');
  els.themeIconsVersion.textContent = theme.iconsVersion ? `published: ${theme.iconsVersion}` : 'not published yet';
  els.themeFontsVersion.textContent = theme.fontsVersion ? `published: ${theme.fontsVersion}` : 'not published yet';

  if (!state.iconSlots) state.iconSlots = await api('/api/assets/icon-slots');
  await fetchIconPreviews(state.iconSlots.map(effectiveIconFor));
  renderIconSlots();
  await renderCustomIconsList();
}

async function selectTheme() {
  state.showingGlobals = false;
  state.showingDevices = false;
  state.showingTheme = true;
  state.currentSlug = null;
  renderProfileList();
  await loadThemeData();
  hideAllViews();
  els.themeNavBtn.classList.add('active');
  els.themeView.hidden = false;
}

els.themeNavBtn.addEventListener('click', () => selectTheme());

els.themeIconSlots.addEventListener('click', (e) => {
  const row = e.target.closest('.icon-slot-row');
  if (!row) return;
  state.activeIconSlot = row.dataset.key;
  els.themeIconSlots.querySelectorAll('.icon-slot-row').forEach((r) => {
    r.classList.toggle('active', r === row);
  });
  els.themeIconSearch.focus();
});

let iconSearchTimer = null;
els.themeIconSearch.addEventListener('input', () => {
  clearTimeout(iconSearchTimer);
  const q = els.themeIconSearch.value.trim();
  if (!q) {
    els.themeIconSearchResults.innerHTML = '';
    return;
  }
  iconSearchTimer = setTimeout(async () => {
    try {
      const results = await api(`/api/assets/icons/search?q=${encodeURIComponent(q)}`);
      els.themeIconSearchResults.innerHTML = results
        .map(
          (r) => `
        <button type="button" class="icon-search-result ${r.source === 'custom' ? 'icon-search-result-custom' : ''}" data-name="${escapeAttr(r.name)}" title="${escapeAttr(r.name)}${r.source === 'custom' ? ' (custom)' : ''}">
          <img src="${r.preview}" width="28" height="28" alt="" />
        </button>
      `
        )
        .join('');
      for (const r of results) state.iconPreviews[r.name] = r.preview;
    } catch (err) {
      els.themeIconSearchResults.innerHTML = '';
    }
  }, 250);
});

els.themeIconSearchResults.addEventListener('click', (e) => {
  const btn = e.target.closest('.icon-search-result');
  if (!btn) return;
  if (!state.activeIconSlot) {
    alert('Click an icon slot below first, then pick its replacement.');
    return;
  }
  state.iconOverrides[state.activeIconSlot] = btn.dataset.name;
  renderIconSlots();
});

els.themeIconUpload.addEventListener('change', async () => {
  const file = els.themeIconUpload.files[0];
  els.themeIconUpload.value = '';
  const result = await promptAndUploadCustomIcon(file);
  if (!result) return;
  if (state.activeIconSlot) {
    state.iconOverrides[state.activeIconSlot] = result.name;
    renderIconSlots();
  }
  await renderCustomIconsList();
});

els.themeCustomIconsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.custom-icon-delete');
  if (!btn) return;
  const name = btn.closest('.custom-icon-item').dataset.name;
  if (
    !confirm(
      `Delete the custom icon "${name}"? Anything still overridden to it (a Theme slot, a hub button, a light/scene/blind) won't find it next time it's compiled or fetched.`
    )
  )
    return;
  try {
    await api(`/api/assets/icons/custom/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await renderCustomIconsList();
  } catch (err) {
    alert(`Could not delete: ${err.message}`);
  }
});

els.themeIconsCompile.addEventListener('click', async () => {
  els.themeIconsStatus.textContent = 'Compiling…';
  try {
    const result = await api('/api/assets/icons/compile', {
      method: 'POST',
      body: JSON.stringify({ overrides: state.iconOverrides })
    });
    els.themeIconsVersion.textContent = `published: ${result.version}`;
    els.themeIconsStatus.textContent = 'Published ✓';
    setTimeout(() => {
      if (els.themeIconsStatus.textContent === 'Published ✓') els.themeIconsStatus.textContent = '';
    }, 2500);
  } catch (err) {
    els.themeIconsStatus.textContent = '';
    alert(`Could not compile icons: ${err.message}`);
  }
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

els.themeFontCompile.addEventListener('click', async () => {
  const file = els.themeFontFile.files[0];
  const googleFont = els.themeGoogleFont.value.trim();
  if (!file && !googleFont) {
    alert('Upload a font file or enter a Google Font name.');
    return;
  }
  els.themeFontStatus.textContent = 'Compiling…';
  try {
    const body = file ? { ttfBase64: await readFileAsBase64(file) } : { googleFont };
    const result = await api('/api/assets/fonts/compile', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    els.themeFontsVersion.textContent = `published: ${result.version}`;
    els.themeFontStatus.textContent = 'Published ✓';
    setTimeout(() => {
      if (els.themeFontStatus.textContent === 'Published ✓') els.themeFontStatus.textContent = '';
    }, 2500);
  } catch (err) {
    els.themeFontStatus.textContent = '';
    alert(`Could not compile font: ${err.message}`);
  }
});

// --- Device preview (live mockup, navigable screen by screen) ------------
//
// Not pixel-accurate to the firmware's real layout - just visually
// recognizable enough to navigate by. Renders from the SAME read*()
// functions the form's own Save button uses (readLighting/readBlinds/
// readHub/readMedia/readClimate/readTv/readXbox/readScreens), so it always
// reflects what you're about to save, not a separate parallel data model.
// Clicking an icon in the mockup scrolls the real form to that item's row
// and focuses its icon-picker search box; clicking anything else just
// scrolls/highlights the relevant field(s) - see jumpTo() below.

function dvIconHtml(iconName) {
  const preview = iconName && state.iconPreviews[iconName];
  return preview ? `<img src="${preview}" width="18" height="18" alt="" />` : '';
}

// Each render*() below follows the real screen_*.h draw() order/shape (see
// include/screen_lighting.h, screen_blinds.h, screen_music.h,
// screen_climate.h, screen_tv.h, screen_xbox.h, screen_status.h, and
// main.cpp's drawHubGrid() in the Switchboard firmware repo) - not
// pixel-accurate (this is auto-flowed HTML, the real thing is absolute-
// positioned), but the same elements in the same order: a toggle row here
// is a toggle row there, a 3-segment action bar here is CLOSE/STOP/OPEN or
// PREV/PLAY/NEXT there, etc.

function dvIconHtml(iconName) {
  const preview = iconName && state.iconPreviews[iconName];
  return preview ? `<img src="${preview}" width="18" height="18" alt="" />` : '';
}

function dvToggleRow(jumpKind, name, placeholder, on) {
  return `
    <div class="dv-toggle-row" data-jump="${jumpKind}">
      <span class="dv-chip-bulb" style="${on ? 'background:#000;' : ''}"></span>
      <div class="dv-toggle-row-name">${escapeAttr(name || placeholder)}</div>
      <div class="dv-toggle ${on ? 'on' : ''}"></div>
    </div>`;
}

// col0/col1 icon buttons flanking a level bar - Lighting's DARKER/bar/
// BRIGHTER and Music's VOL-/blocks/VOL+ are the same shape.
function dvStepRow(leftGlyph, rightGlyph, pct) {
  return `
    <div class="dv-step-row">
      <div class="dv-icon-btn">${leftGlyph}</div>
      <div class="dv-bar-track"><div class="dv-bar-fill" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
      <div class="dv-icon-btn">${rightGlyph}</div>
    </div>`;
}

// The real device's recurring 3-equal-segment bottom bar shape - WARM/DAY/
// COOL, CLOSE/STOP/OPEN, PREV/PLAY/NEXT, BACK/HOME/POWER.
function dvPresetRow(labels) {
  return `<div class="dv-preset-row">${labels.map((l) => `<div class="dv-preset-seg">${escapeAttr(l)}</div>`).join('')}</div>`;
}

function dvChipGrid(items, kind, fallbackBulb) {
  if (!items.length) return `<div class="dv-empty">None yet</div>`;
  return `<div class="dv-chip-grid">${items
    .map(
      (item, i) => `
      <div class="dv-chip" data-jump="${kind}" data-index="${i}">
        <div class="dv-chip-icon" data-jump-icon="${kind}" data-index="${i}">
          ${dvIconHtml(item.icon) || (fallbackBulb ? '<span class="dv-chip-bulb"></span>' : '')}
        </div>
        <div class="dv-chip-label">${escapeAttr(item.name || '(unnamed)')}</div>
      </div>`
    )
    .join('')}</div>`;
}

function renderLightingScreen() {
  const l = readLighting();
  // Real device order: Scenes tab first, then Lights (screen_lighting.h's
  // `tab` 0 = Scenes, 1 = Lights) - kept the same here.
  const tab = state.devicePreviewLightingTab || 'scenes';
  let html = `<div class="dv-statusbar">Lighting</div>`;
  html += dvToggleRow('lightingGroup', l.group.name, 'All lights', l.group.enabled);
  html += dvStepRow('−', '+', l.group.enabled ? 60 : 0);
  html += dvPresetRow(['WARM', 'DAY', 'COOL']);
  html += `<div class="dv-rule"></div>`;
  html += `<div class="dv-tabs">
    <span class="${tab === 'scenes' ? 'active' : ''}" data-tab="scenes">Scenes</span>
    <span class="${tab === 'lights' ? 'active' : ''}" data-tab="lights">Lights</span>
  </div>`;
  html += tab === 'scenes' ? dvChipGrid(l.scenes, 'scene', false) : dvChipGrid(l.lights, 'light', true);
  return html;
}

function renderBlindsScreen() {
  const b = readBlinds();
  let html = `<div class="dv-statusbar">Blinds</div>`;
  html += `<div class="dv-now-title" style="text-align:center;margin-top:10px;" data-jump="blindsGroup">${escapeAttr(b.group.name || 'All blinds')}</div>`;
  html += `<div class="dv-hero">OPEN/CLOSED icon</div>`;
  html += `<div class="dv-rule"></div>`;
  html += dvChipGrid(b.items, 'blind', false);
  html += dvPresetRow(['CLOSE', 'STOP', 'OPEN']);
  return html;
}

function renderHubScreenPreview() {
  const h = readHub();
  let html = `<div class="dv-statusbar">Quick Access</div>`;
  if (!h.items.length) {
    html += `<div class="dv-empty">No custom buttons - the device shows its built-in jump grid instead</div>`;
    return html;
  }
  html += `<div class="dv-hub-grid">${h.items
    .map(
      (item, i) => `
      <div class="dv-tile" data-jump="hub" data-index="${i}">
        <div class="dv-tile-icon" data-jump-icon="hub" data-index="${i}">${dvIconHtml(item.icon)}</div>
        <div class="dv-tile-label">${escapeAttr(item.name || '(unnamed)')}</div>
      </div>`
    )
    .join('')}</div>`;
  return html;
}

function renderMediaScreenPreview() {
  const m = readMedia();
  let html = `<div class="dv-statusbar">Music</div>`;
  html += dvToggleRow('media', m.name, 'Music', false);
  html += `<div class="dv-hero" data-jump="media">album art</div>`;
  html += `<div class="dv-now-playing" data-jump="media">
      <div class="dv-now-title">${m.enabled ? 'Now playing' : 'Not configured'}</div>
      <div class="dv-now-artist">${escapeAttr(m.entity || 'no entity set')}</div>
    </div>`;
  html += dvStepRow('−', '+', 50);
  html += dvPresetRow(['PREV', '▶', 'NEXT']);
  return html;
}

function renderClimateScreenPreview() {
  const c = readClimate();
  let html = `<div class="dv-statusbar">Climate</div>`;
  html += `<div class="dv-dial-wrap">
      <div class="dv-dial">
        <div class="dv-dial-center" data-jump="climate">
          <div class="dv-dial-mode">AUTO</div>
          <div class="dv-dial-temp">21°</div>
        </div>
      </div>
    </div>`;
  html += `<div class="dv-now-artist" style="text-align:center;" data-jump="climate">${escapeAttr(c.entity || 'no main sensor entity set')}</div>`;
  html += dvMinusPlusRow();
  html += dvModeRow();
  if (c.additionalSensors.length) {
    html += `<div class="dv-rule"></div><div class="dv-list">`;
    c.additionalSensors.forEach((s) => {
      html += `<div class="dv-list-row">${escapeAttr(s.name || s.entity || '(unnamed)')}</div>`;
    });
    html += `</div>`;
  }
  return html;
}

// MINUS/PLUS circular step buttons sitting in the dial's open gap.
function dvMinusPlusRow() {
  return `<div class="dv-step-row" style="justify-content:center;">
    <div class="dv-icon-btn" style="border-radius:50%;">−</div>
    <div class="dv-icon-btn" style="border-radius:50%;">+</div>
  </div>`;
}

function dvModeRow() {
  const modes = [
    ['power', 'Off'],
    ['fire', 'Heat'],
    ['snowflake', 'Cool'],
    ['fan', 'Fan']
  ];
  return `<div class="dv-mode-row">${modes
    .map(([, label], i) => `<div class="dv-mode-btn ${i === 1 ? 'active' : ''}">${escapeAttr(label)}</div>`)
    .join('')}</div>`;
}

function renderTvScreenPreview() {
  const t = readTv();
  let html = `<div class="dv-statusbar">TV</div>`;
  html += `<div class="dv-now-artist" style="text-align:center;margin-top:8px;" data-jump="tv">${escapeAttr(t.mediaPlayerEntity || 'no media player entity')} / ${escapeAttr(t.remoteEntity || 'no remote entity')}</div>`;
  html += `<div class="dv-dpad">
      <span class="dv-dpad-empty"></span><div class="dv-dpad-btn">▲</div><span class="dv-dpad-empty"></span>
      <div class="dv-dpad-btn">◀</div><div class="dv-dpad-btn center">OK</div><div class="dv-dpad-btn">▶</div>
      <span class="dv-dpad-empty"></span><div class="dv-dpad-btn">▼</div><span class="dv-dpad-empty"></span>
    </div>`;
  html += dvPresetRow(['YouTube', 'Netflix', 'TV mate']);
  html += dvStepRow('−', '+', 50);
  html += dvPresetRow(['BACK', 'HOME', 'POWER']);
  html += `<p class="hint" style="padding: 4px 12px;">App icons are shared across every room - re-skin them from the Theme page.</p>`;
  return html;
}

function renderXboxScreenPreview() {
  const x = readXbox();
  let html = `<div class="dv-statusbar">Xbox</div>`;
  html += `<div class="dv-hero" data-jump="xbox">hero art</div>`;
  html += `<div class="dv-now-playing" data-jump="xbox">
      <div class="dv-now-title">${escapeAttr(x.name || 'Xbox')}</div>
      <div class="dv-now-artist">${x.enabled ? 'Enabled' : 'Disabled, won’t show on device'}</div>
    </div>`;
  if (x.games.length) {
    html += `<div class="dv-rule"></div><div class="dv-list">`;
    x.games.slice(0, 8).forEach((g) => {
      html += `<div class="dv-list-row">${escapeAttr(g.name || g.productId || '(unnamed)')}</div>`;
    });
    html += `</div>`;
  }
  return html;
}

function renderStatusScreenPreview() {
  return `<div class="dv-statusbar">Status</div>
    <div class="dv-standby" data-jump="standby">
      <div class="dv-standby-temp">72°</div>
      <div class="dv-standby-sub">Weather &amp; indoor temperature</div>
    </div>
    <div class="dv-rule"></div>
    <div class="dv-now-artist" style="text-align:center;">Wind · Humidity · 3-day outlook</div>`;
}

const DEVICE_SCREENS = [
  { id: 'status', flag: null, label: 'Status', render: renderStatusScreenPreview },
  { id: 'lighting', flag: 'lighting', label: 'Lighting', render: renderLightingScreen },
  { id: 'blinds', flag: 'blinds', label: 'Blinds', render: renderBlindsScreen },
  { id: 'media', flag: 'music', label: 'Music', render: renderMediaScreenPreview },
  { id: 'climate', flag: 'climate', label: 'Climate', render: renderClimateScreenPreview },
  { id: 'tv', flag: 'tv', label: 'TV', render: renderTvScreenPreview },
  { id: 'xbox', flag: 'xbox', label: 'Xbox', render: renderXboxScreenPreview },
  { id: 'hub', flag: null, label: 'Quick Access', render: renderHubScreenPreview }
];

function visibleDeviceScreens() {
  const screens = readScreens();
  return DEVICE_SCREENS.filter((s) => !s.flag || screens[s.flag] !== false);
}

function renderDevicePreview() {
  if (!state.currentSlug || state.showingGlobals || state.showingDevices || state.showingTheme) return;
  const screens = visibleDeviceScreens();
  if (!screens.length) {
    els.devicePreviewLabel.textContent = '—';
    els.devicePreviewScreen.innerHTML = '<div class="dv-empty">Every screen is turned off for this room.</div>';
    return;
  }
  if (state.devicePreviewIndex >= screens.length) state.devicePreviewIndex = 0;
  const screen = screens[state.devicePreviewIndex];
  els.devicePreviewLabel.textContent = screen.label;
  els.devicePreviewScreen.innerHTML = screen.render();
}

function jumpToRow(listEl, rowSelector, index, focusIcon) {
  const rows = listEl.querySelectorAll(rowSelector);
  const row = rows[index];
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('jump-highlight');
  setTimeout(() => row.classList.remove('jump-highlight'), 1100);
  if (focusIcon) {
    const search = row.querySelector('.icon-picker-search');
    if (search) search.focus();
  }
}

function jumpToField(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('jump-highlight');
  setTimeout(() => el.classList.remove('jump-highlight'), 1100);
  el.focus();
}

function devicePreviewJump(kind, index, focusIcon) {
  switch (kind) {
    case 'light':
      return jumpToRow(els.lightingLightsList, '.lighting-item', index, focusIcon);
    case 'scene':
      return jumpToRow(els.lightingScenesList, '.lighting-item', index, focusIcon);
    case 'blind':
      return jumpToRow(els.blindsItemsList, '.blinds-item', index, focusIcon);
    case 'hub':
      return jumpToRow(els.hubItemsList, '.hub-item', index, focusIcon);
    case 'lightingGroup':
      return jumpToField(els.lightingGroupName);
    case 'blindsGroup':
      return jumpToField(els.blindsGroupName);
    case 'media':
      return jumpToField(els.mediaName);
    case 'climate':
      return jumpToField(els.climateEntity);
    case 'tv':
      return jumpToField(els.tvMediaPlayerEntity);
    case 'xbox':
      return jumpToField(els.xboxName);
    case 'standby':
      return jumpToField(els.standbyWeatherEntity);
    default:
      return undefined;
  }
}

els.devicePreviewScreen.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    state.devicePreviewLightingTab = tab.dataset.tab;
    renderDevicePreview();
    return;
  }
  const iconTarget = e.target.closest('[data-jump-icon]');
  if (iconTarget) {
    devicePreviewJump(iconTarget.dataset.jumpIcon, Number(iconTarget.dataset.index), true);
    return;
  }
  const target = e.target.closest('[data-jump]');
  if (target) {
    const index = target.dataset.index ? Number(target.dataset.index) : null;
    devicePreviewJump(target.dataset.jump, index, false);
  }
});

els.devicePreviewPrev.addEventListener('click', () => {
  const screens = visibleDeviceScreens();
  if (!screens.length) return;
  state.devicePreviewIndex = (state.devicePreviewIndex - 1 + screens.length) % screens.length;
  renderDevicePreview();
});

els.devicePreviewNext.addEventListener('click', () => {
  const screens = visibleDeviceScreens();
  if (!screens.length) return;
  state.devicePreviewIndex = (state.devicePreviewIndex + 1) % screens.length;
  renderDevicePreview();
});

// Live-updates on any change anywhere in the form - add/remove item clicks,
// icon picks, text edits, checkbox toggles - without tracking every
// individual field. Debounced slightly since typing fires many 'input'
// events in a row.
let devicePreviewRenderTimer = null;
function scheduleDevicePreviewRender() {
  clearTimeout(devicePreviewRenderTimer);
  devicePreviewRenderTimer = setTimeout(renderDevicePreview, 120);
}
els.form.addEventListener('input', scheduleDevicePreviewRender);
els.form.addEventListener('change', scheduleDevicePreviewRender);
els.form.addEventListener('click', scheduleDevicePreviewRender);

// --- Actions ---------------------------------------------------------------

els.newProfileBtn.addEventListener('click', async () => {
  const name = prompt('Room name for the new profile (e.g. "Bedroom"):');
  if (!name || !name.trim()) return;
  try {
    const profile = await api('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() })
    });
    await loadProfileList();
    await selectProfile(profile.slug);
  } catch (err) {
    alert(`Could not create profile: ${err.message}`);
  }
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentSlug) return;
  els.saveStatus.textContent = 'Saving…';
  try {
    const body = readForm();
    await api(`/api/devices/${encodeURIComponent(state.currentSlug)}/config`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    els.saveStatus.textContent = 'Saved ✓';
    await loadProfileList();
    setTimeout(() => {
      if (els.saveStatus.textContent === 'Saved ✓') els.saveStatus.textContent = '';
    }, 2500);
  } catch (err) {
    els.saveStatus.textContent = '';
    alert(`Could not save: ${err.message}`);
  }
});

els.deleteBtn.addEventListener('click', async () => {
  if (!state.currentSlug) return;
  if (!confirm(`Delete the "${els.name.value}" profile? This cannot be undone.`)) return;
  try {
    await api(`/api/devices/${encodeURIComponent(state.currentSlug)}`, { method: 'DELETE' });
    state.currentSlug = null;
    els.form.hidden = true;
    els.emptyState.hidden = false;
    await loadProfileList();
  } catch (err) {
    alert(`Could not delete: ${err.message}`);
  }
});

els.downloadBtn.addEventListener('click', () => {
  if (!state.currentSlug) return;
  const body = { slug: state.currentSlug, ...readForm() };
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.currentSlug}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

els.uploadInput.addEventListener('change', async () => {
  const file = els.uploadInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const name = parsed.name || file.name.replace(/\.json$/i, '');
    const created = await api('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    await api(`/api/devices/${encodeURIComponent(created.slug)}/config`, {
      method: 'POST',
      body: JSON.stringify(parsed)
    });
    await loadProfileList();
    await selectProfile(created.slug);
  } catch (err) {
    alert(`Could not import file: ${err.message}`);
  } finally {
    els.uploadInput.value = '';
  }
});

els.haTokenToggle.addEventListener('click', () => {
  const showing = els.haToken.type === 'text';
  els.haToken.type = showing ? 'password' : 'text';
  els.haTokenToggle.textContent = showing ? 'Show' : 'Hide';
});

els.haUseGlobal.addEventListener('change', applyHaUseGlobalState);

els.climateAddSensor.addEventListener('click', () => {
  els.climateSensorsList.appendChild(createSensorRow(null));
});

els.climateSensorsList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.climate-item').remove();
  }
});

els.lightingGroupEnabled.addEventListener('change', applyLightingGroupState);

els.lightingAddLight.addEventListener('click', () => {
  els.lightingLightsList.appendChild(createLightRow(null));
});

els.lightingAddScene.addEventListener('click', () => {
  els.lightingScenesList.appendChild(createSceneRow(null));
});

els.lightingLightsList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.lighting-item').remove();
  }
});

els.lightingScenesList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.lighting-item').remove();
  }
});

els.blindsGroupEnabled.addEventListener('change', applyBlindsGroupState);

els.blindsAddItem.addEventListener('click', () => {
  els.blindsItemsList.appendChild(createBlindRow(null));
});

els.blindsItemsList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.blinds-item').remove();
  }
});

els.xboxAddGame.addEventListener('click', () => {
  els.xboxGamesList.appendChild(createGameRow(null));
});

els.xboxGamesList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.xbox-item').remove();
  }
});

els.hubAddItem.addEventListener('click', () => {
  els.hubItemsList.appendChild(createHubRow(null));
});

els.hubItemsList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.hub-item').remove();
  }
});

els.hubItemsList.addEventListener('change', (e) => {
  if (e.target.classList.contains('hub-item-action-type')) {
    applyHubRowActionState(e.target.closest('.hub-item'));
  }
});

// Icon picker (search + click a result) - one wiring per list container,
// works for rows added later via "+ Add" through event delegation.
wireIconPicker(els.hubItemsList);
wireIconPicker(els.lightingLightsList);
wireIconPicker(els.lightingScenesList);
wireIconPicker(els.blindsItemsList);

els.haGlobalLink.addEventListener('click', () => {
  selectGlobals();
});

els.globalsNavBtn.addEventListener('click', () => {
  selectGlobals();
});

els.globalsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.globalsSaveStatus.textContent = 'Saving…';
  try {
    const body = readGlobalsForm();
    await api('/api/globals', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    els.globalsSaveStatus.textContent = 'Saved ✓';
    setTimeout(() => {
      if (els.globalsSaveStatus.textContent === 'Saved ✓') els.globalsSaveStatus.textContent = '';
    }, 2500);
  } catch (err) {
    els.globalsSaveStatus.textContent = '';
    alert(`Could not save: ${err.message}`);
  }
});

els.wifiPasswordToggle.addEventListener('click', () => {
  const showing = els.wifiPassword.type === 'text';
  els.wifiPassword.type = showing ? 'password' : 'text';
  els.wifiPasswordToggle.textContent = showing ? 'Show' : 'Hide';
});

els.wifiNetworksAdd.addEventListener('click', () => {
  els.wifiNetworksList.appendChild(createWifiNetworkRow(null));
});

els.wifiNetworksList.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-item')) {
    e.target.closest('.wifi-item').remove();
    return;
  }
  if (e.target.classList.contains('wifi-item-password-toggle')) {
    const input = e.target.closest('.token-row').querySelector('.wifi-item-password');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    e.target.textContent = showing ? 'Show' : 'Hide';
  }
});

els.globalHaTokenToggle.addEventListener('click', () => {
  const showing = els.globalHaToken.type === 'text';
  els.globalHaToken.type = showing ? 'password' : 'text';
  els.globalHaTokenToggle.textContent = showing ? 'Show' : 'Hide';
});

// --- Init --------------------------------------------------------------

async function init() {
  const authenticated = await checkAuth();
  if (!authenticated) return;

  try {
    const health = await api('/api/health');
    els.mdnsHint.textContent = health.mdnsHostname;
    els.mdnsHost.textContent = health.mdnsHostname;
    if (health.version && els.versionHint) els.versionHint.textContent = `v${health.version}`;
  } catch (_) {
    /* health endpoint is best-effort for display purposes only */
  }
  await loadProfileList();
}

init();
