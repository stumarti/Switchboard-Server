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
  showingGlobals: false
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
  ntpServer: document.getElementById('ntp-server')
};

// --- API helpers ---------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
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

async function selectProfile(slug) {
  state.currentSlug = slug;
  state.showingGlobals = false;
  els.globalsNavBtn.classList.remove('active');
  renderProfileList();
  const profile = await api(`/api/devices/${encodeURIComponent(slug)}/config`);
  fillForm(profile);
  els.emptyState.hidden = true;
  els.globalsForm.hidden = true;
  els.form.hidden = false;
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
      <label>Icon<input type="text" class="hub-item-icon" value="${escapeAttr(it.icon)}" placeholder="icon name, e.g. movie" /></label>
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
    icon: row.querySelector('.hub-item-icon').value.trim(),
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
    controls: readControlCheckboxes(row.querySelector('.light-controls'))
  }));
}

function readScenesList() {
  return Array.from(els.lightingScenesList.querySelectorAll('.lighting-item')).map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector('.scene-name').value.trim(),
    entity: row.querySelector('.scene-entity').value.trim()
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
    entity: row.querySelector('.blind-entity').value.trim()
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
  state.currentSlug = null;
  els.globalsNavBtn.classList.add('active');
  renderProfileList();
  const globals = await api('/api/globals');
  fillGlobalsForm(globals);
  els.emptyState.hidden = true;
  els.form.hidden = true;
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
