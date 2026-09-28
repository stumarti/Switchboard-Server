'use strict';

/**
 * homeremote-server
 *
 * Home server companion container for the Xteink X4 Pro HA Room Remote,
 * per x4pro-ha-remote-spec.md section 8b. One instance runs per household
 * (not per remote): it stores every room's profile centrally and serves
 * a browser-friendly admin UI, so a multi-remote home authors each room's
 * config in one place instead of re-entering the whole on-device form by
 * hand on every physical unit. It also advertises itself on the LAN as
 * `homeremote.local` via mDNS so devices (and this admin UI) can find it
 * without knowing an IP address.
 *
 * API surface (mirrors spec section 8b):
 *   GET    /api/devices                 -> list of saved profiles
 *   GET    /api/devices/:slug/config    -> one profile, full shape, unmasked
 *   POST   /api/devices/:slug/config    -> create/update a profile
 *   DELETE /api/devices/:slug           -> remove a profile (addition beyond
 *                                           the spec's exact list, needed by
 *                                           the admin UI)
 *   POST   /api/devices                 -> { name } -> creates a new profile
 *                                           with an auto-generated unique
 *                                           slug (addition; the spec's own
 *                                           POST .../config also works if a
 *                                           caller already knows the slug it
 *                                           wants)
 *   GET    /api/globals                 -> the shared Globals record (WiFi
 *                                           + a default Home Assistant
 *                                           connection every room profile
 *                                           uses unless it sets its own
 *                                           homeAssistant.useGlobal: false;
 *                                           addition beyond the spec, not a
 *                                           per-device endpoint)
 *   POST   /api/globals                 -> create/update the Globals record
 *   /api/auth/*, /api/pairing/*, /api/theme*, /api/assets/*
 *                                        -> admin login + device pairing +
 *                                           the runtime icon/font theme
 *                                           compiler; see lib/auth.js,
 *                                           lib/pairing.js, lib/assets/*.js.
 *
 * Auth: a single shared admin password protects the browser UI (session
 * cookie), and every physical remote pairs once (admin-approved) to get a
 * long-lived bearer token it sends on every request from then on - see
 * lib/auth.js's requireAdminSession/requireAdminOrDevice. This replaces the
 * "plain HTTP, no auth" posture the spec originally shipped with: this
 * server aggregates every room's HA token plus household WiFi passwords, so
 * closing that hole was worth the migration cost (existing already-flashed
 * remotes need reflashing + pairing once this ships - see README.md).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const store = require('./lib/store');
const { normalizeProfile, normalizeGlobals } = require('./lib/validate');
const { startMdnsResponder } = require('./lib/mdns');
const auth = require('./lib/auth');
const pairing = require('./lib/pairing');
const haState = require('./lib/ha-state');
const clients = require('./lib/clients');
const dashboard = require('./lib/dashboard');
const dashboardState = require('./lib/dashboard-state');
const art = require('./lib/art');
const haMonitor = require('./lib/ha-monitor');
const overview = require('./lib/overview');
const iconSlots = require('./lib/assets/icon-slots');
const iconsCompiler = require('./lib/assets/icons');
const fontsCompiler = require('./lib/assets/fonts');
const googleFonts = require('./lib/assets/google-fonts');

const APP_VERSION = process.env.APP_VERSION || 'dev';
const PORT = Number(process.env.PORT) || 45678;
const HOST = process.env.HOST || '0.0.0.0';
const MDNS_HOSTNAME = process.env.MDNS_HOSTNAME || 'switchboard.local';
const MDNS_IP = process.env.MDNS_IP || undefined;
const MDNS_INTERFACE = process.env.MDNS_INTERFACE || undefined;
const MDNS_SERVICE_TYPE = process.env.MDNS_SERVICE_TYPE || 'switchboard';
const MDNS_INSTANCE_NAME = process.env.MDNS_INSTANCE_NAME || undefined;
const DISABLE_MDNS = /^(1|true|yes)$/i.test(process.env.DISABLE_MDNS || '');

// Seed/refresh admin auth settings (ADMIN_PASSWORD env override, or
// generate a sessionSecret on first-ever boot) before the app starts
// accepting requests.
auth.ensureSettings();

const app = express();
// 3mb (not the original 1mb) - a base64-encoded font upload (POST
// /api/assets/fonts/compile) can run a few hundred KB inflated ~33% by
// base64; everything else here is tiny by comparison.
app.use(express.json({ limit: '3mb' }));
app.set('trust proxy', true); // req.ip reflects X-Forwarded-For behind a reverse proxy, for device lastIp
app.use(express.static(path.join(__dirname, 'public')));
// The admin UI's libraries, straight from node_modules — no build step:
// Preact + htm as ES modules (index.html's import map points at these), and
// every Material Design Icon as an SVG the UI draws with a CSS mask.
// A package's install folder, found the way require() would (some packages'
// "exports" hide package.json from require.resolve).
const moduleDir = (pkg) => {
  for (const dir of require.resolve.paths(pkg) || []) {
    const candidate = path.join(dir, pkg);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`${pkg} is not installed (run npm install)`);
};
const vendorStatic = (dir) => express.static(dir, { maxAge: '7d', immutable: true });
app.use('/vendor/preact', vendorStatic(moduleDir('preact')));
app.use('/vendor/htm', vendorStatic(path.join(moduleDir('htm'), 'dist')));
app.use('/mdi', vendorStatic(path.join(moduleDir('@mdi/svg'), 'svg')));

// --- Auth ----------------------------------------------------------------

app.get('/api/auth/status', (req, res) => {
  const authenticated = Boolean(auth.sessionFromRequest(req));
  res.json({ authenticated, setupRequired: auth.isSetupRequired() });
});

app.post('/api/auth/setup', (req, res) => {
  if (!auth.isSetupRequired()) {
    return res.status(400).json({ error: 'a password is already set' });
  }
  const password = req.body && req.body.password;
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  auth.setPassword(String(password));
  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const password = req.body && req.body.password;
  if (!password || !auth.checkPassword(String(password))) {
    return res.status(401).json({ error: 'incorrect password' });
  }
  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(auth.sessionFromRequest(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Pairing (device identity, admin-approved) ---------------------------

// No auth: this is a device's very first-ever contact, before it has a
// token. Also polled (still unauthenticated) while pending/revoked.
app.post('/api/pairing/register', (req, res) => {
  const result = pairing.register(req.body && req.body.mac, req.ip, req.body && req.body.type);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/pairing/devices', auth.requireAdminSession, (req, res) => {
  res.json(pairing.list());
});

app.post('/api/pairing/:mac/approve', auth.requireAdminSession, (req, res) => {
  const result = pairing.approve(req.params.mac, req.body && req.body.slug);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/pairing/:mac/assign', auth.requireAdminSession, (req, res) => {
  const result = pairing.assign(req.params.mac, req.body && req.body.slug);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/pairing/:mac/rename', auth.requireAdminSession, (req, res) => {
  const result = pairing.rename(req.params.mac, req.body && req.body.name);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.post('/api/pairing/:mac/revoke', auth.requireAdminSession, (req, res) => {
  const result = pairing.revoke(req.params.mac);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

app.delete('/api/pairing/:mac', auth.requireAdminSession, (req, res) => {
  const result = pairing.remove(req.params.mac);
  if (result.error) return res.status(404).json(result);
  res.status(204).end();
});

// --- Home Assistant lookups for the admin UI (entity pickers) -----------
//
// The server holds the HA token, so the browser never needs it: these proxy
// HA's own entity list, trimmed to what the pickers show.

app.get('/api/ha/status', auth.requireAdminSession, async (req, res) => {
  res.json(await haState.checkConnection(store.getGlobals()));
});

app.get('/api/ha/entities', auth.requireAdminSession, async (req, res) => {
  try {
    const domains = String(req.query.domains || '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    res.json(
      await haState.searchEntities(store.getGlobals(), {
        domains,
        q: String(req.query.q || ''),
        deviceClass: String(req.query.deviceClass || ''),
        limit: Math.min(Number(req.query.limit) || 50, 500)
      })
    );
  } catch (e) {
    res.status(e.code === 'NO_HA' ? 409 : 502).json({ error: e.message });
  }
});

app.post('/api/ha/lookup', auth.requireAdminSession, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((i) => typeof i === 'string') : [];
    res.json(await haState.lookupEntities(store.getGlobals(), ids.slice(0, 500)));
  } catch (e) {
    res.status(e.code === 'NO_HA' ? 409 : 502).json({ error: e.message });
  }
});

// --- Clients (remotes + viewports: every paired device, with its layout) --

// Every device, each with its effective layout (its own, or the default
// derived from its room / type) — what the Remotes and Viewports pages list.
app.get('/api/clients', auth.requireAdminSession, (req, res) => {
  res.json(
    pairing.list().map((d) => ({
      ...d,
      type: clients.normalizeType(d.type),
      layout: clients.normalizeType(d.type) === 'viewport'
        ? viewportLayout(d)
        : clients.layoutFor(d, d.assignedSlug ? store.getProfile(d.assignedSlug) : null),
      layoutCustomized: Boolean(d.layout)
    }))
  );
});

app.put('/api/clients/:mac', auth.requireAdminSession, (req, res) => {
  const result = pairing.update(req.params.mac, req.body);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

// The option lists the admin UI's builders offer.
app.get('/api/clients/schema', auth.requireAdminSession, (req, res) => {
  res.json({
    types: clients.CLIENT_TYPES,
    remotePages: clients.REMOTE_PAGES.map((p) => p.id),
    dashboard: {
      sectionTypes: dashboard.SECTION_TYPES,
      templates: Object.keys(dashboard.TEMPLATES),
      carouselModes: dashboard.CAROUSEL_MODES,
      colors: dashboard.COLORS,
      conditions: dashboard.CONDITIONS,
      limits: dashboard.LIMITS,
      iconPresets: dashboard.ICON_PRESETS
    },
    refreshChoices: clients.REFRESH_CHOICES
  });
});

// --- Viewports (the colour wall display's dashboard) ----------------------
//
// A viewport device calls these with its own token, as `me` (or its own
// MAC); the admin UI calls them for any viewport. Two requests per wake,
// like a remote: the bundle (its layout, plus the Wi-Fi networks and clock
// server; Express answers an unchanged one with a bodyless 304) and the
// state — every screen's finished values, each with its own ETag, so the
// device can skip the panel refresh for a screen that hasn't changed.

// A viewport device's layout: its assigned dashboard's (the UI is defined
// on the server, the hardware just draws it).
function viewportLayout(device) {
  const dash = device.dashboard ? store.getDashboard(device.dashboard) : null;
  return clients.layoutFor({ ...device, type: 'viewport' }, null, dash && dash.layout);
}

// The viewport a request is about, or null after answering the error.
function viewportFor(req, res) {
  const param = String(req.params.mac || '');
  if (req.device) {
    if (param !== 'me' && store.normalizeMac(param) !== req.device.mac) {
      res.status(403).json({ error: 'a device can only read its own viewport' });
      return null;
    }
    return req.device;
  }
  const d = store.getDevices()[store.normalizeMac(param)];
  if (!d) {
    res.status(404).json({ error: 'no such device' });
    return null;
  }
  return d;
}

// (Battery, temperature, Wi-Fi signal and firmware headers are recorded for
// every device in lib/auth.js.)
app.get('/api/viewports/:mac/bundle', auth.requireAdminOrDevice, (req, res) => {
  const device = viewportFor(req, res);
  if (!device) return;
  const globals = store.getGlobals();
  const layout = viewportLayout(device);
  const dash = device.dashboard ? store.getDashboard(device.dashboard) : null;
  res.json({
    // false until a dashboard is assigned: the device shows a "not set up"
    // screen (the placeholder layout's title says so).
    assigned: Boolean(dash),
    dashboard: dash ? { slug: dash.slug, name: dash.name } : null,
    name: device.name,
    mac: device.mac,
    layout,
    // Every icon the screens can show, to fetch (and cache) up front from
    // /api/icons/mdi/:name.
    icons: dashboardState.iconsUsed(layout),
    wifiNetworks: globals.wifiNetworks || [],
    ntpServer: globals.ntpServer || 'pool.ntp.org',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
});

// `slug`: the saved layout being drawn, so entities HA doesn't have are
// reported on the Home page (not for an unsaved preview).
async function viewportScreens(layout, slug) {
  const inputs = await dashboardState.fetchInputs(layout, store.getGlobals());
  const screens = dashboardState.buildScreens(layout, inputs);
  if (slug && inputs.states && Object.keys(inputs.states).length) {
    const missing = dashboardState.missingEntities(layout, inputs.states);
    haMonitor.noteEntities({ kind: 'layout', slug }, Object.fromEntries(missing.map((id) => [id, 'HTTP 404'])));
  }
  return { screens, errors: inputs.errors, generatedAt: inputs.now.toISOString() };
}

function haError(res, e) {
  res.status(e.code === 'NO_HA' ? 409 : 502).json({ error: e.message });
}

// ?screen=<id> -> that screen alone ({screen, etag, refreshInSec, data}),
// with an ETag header and a bodyless 304 when it matches If-None-Match.
// No `screen` -> every screen at once, each with its etag, for a device that
// caches them all so page turns need no network. refreshInSec is when to
// wake next: the refresh interval, or sooner when a screen will change on
// its own (a meeting starting or ending).
app.get('/api/viewports/:mac/state', auth.requireAdminOrDevice, async (req, res) => {
  const device = viewportFor(req, res);
  if (!device) return;
  const layout = viewportLayout(device);
  const interval = layout.refreshIntervalMin * 60;
  const soonest = (list) => Math.min(interval, ...list.filter((n) => n != null && n > 0));
  try {
    const { screens, errors, generatedAt } = await viewportScreens(layout, device.dashboard || '');
    const wanted = req.query.screen ? String(req.query.screen) : '';
    if (wanted) {
      const screen = screens[wanted];
      if (!screen) return res.status(404).json({ error: 'no such screen' });
      const etag = dashboardState.screenEtag(screen);
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache');
      res.set('X-Refresh-In', String(soonest([screen.nextChangeInSec])));
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      return res.json({ screen: wanted, etag, refreshInSec: soonest([screen.nextChangeInSec]), generatedAt, data: screen });
    }
    const out = {};
    for (const sc of layout.screens.filter((x) => x.enabled)) {
      out[sc.id] = { etag: dashboardState.screenEtag(screens[sc.id]), data: screens[sc.id] };
    }
    const next = layout.screens.filter((x) => x.enabled).map((x) => screens[x.id].nextChangeInSec);
    res.json({ refreshInSec: soonest(next), generatedAt, errors, screens: out });
  } catch (e) {
    haError(res, e);
  }
});

// The admin UI's live preview: the state an unsaved layout would produce.
app.post('/api/viewports/:mac/preview', auth.requireAdminSession, async (req, res) => {
  const device = viewportFor(req, res);
  if (!device) return;
  try {
    const layout = dashboard.normalizeLayout(req.body && req.body.layout);
    res.json(await viewportScreens(layout));
  } catch (e) {
    haError(res, e);
  }
});

// The kitchen panel's own settings (its GET /api/config JSON) as a layout,
// for the admin UI to review and save.
app.post('/api/viewports/import', auth.requireAdminSession, (req, res) => {
  const config = req.body && req.body.config;
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config (the panel\'s /api/config JSON) is required' });
  res.json({ layout: dashboard.fromKitchenPanel(config) });
});

// ?kind=meetingRoom -> a single meeting-room screen (a door sign);
// otherwise the kitchen panel's screens.
app.get('/api/viewports/defaults', auth.requireAdminSession, (req, res) => {
  res.json({ layout: req.query.kind === 'meetingRoom' ? dashboard.meetingRoomLayout() : dashboard.defaultLayout() });
});

// --- Dashboards (viewport UIs, defined before or without hardware) ------------

function dashboardSummary(d) {
  const layout = dashboard.normalizeLayout(d.layout);
  const devices = Object.values(store.getDevices()).filter((x) => x.dashboard === d.slug);
  return {
    slug: d.slug,
    name: d.name,
    updatedAt: d.updatedAt || null,
    screens: layout.screens.map((sc) => ({ title: sc.title, kind: sc.kind, enabled: sc.enabled })),
    // Its meeting rooms, so another sign's room finder can list them.
    meetingRooms: layout.screens
      .filter((sc) => sc.kind === 'meetingRoom' && sc.meeting.calendar)
      .map((sc) => ({ calendar: sc.meeting.calendar, name: sc.meeting.name, occupancy: sc.meeting.occupancy })),
    devices: devices.map((x) => ({ mac: x.mac, name: x.name }))
  };
}

app.get('/api/dashboards', auth.requireAdminSession, (req, res) => {
  res.json(store.listDashboards().map(dashboardSummary));
});

// {name, template: kitchen|meetingRoom|blank} or {name, copyFrom: slug}.
app.post('/api/dashboards', auth.requireAdminSession, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  let layout;
  if (b.copyFrom) {
    const src = store.getDashboard(String(b.copyFrom));
    if (!src) return res.status(404).json({ error: 'no such dashboard to copy' });
    layout = dashboard.normalizeLayout(src.layout);
  } else if (b.layout) {
    layout = dashboard.normalizeLayout(b.layout);
  } else {
    layout = b.template === 'meetingRoom' ? dashboard.meetingRoomLayout() : b.template === 'blank' ? dashboard.blankLayout() : dashboard.defaultLayout();
  }
  const slug = store.newDashboardSlug(name);
  const now = new Date().toISOString();
  store.saveDashboard(slug, { name, createdAt: now, updatedAt: now, layout });
  res.status(201).json(store.getDashboard(slug));
});

app.get('/api/dashboards/:slug', auth.requireAdminSession, (req, res) => {
  const d = store.getDashboard(req.params.slug);
  if (!d) return res.status(404).json({ error: 'no such dashboard' });
  res.json({ ...d, layout: dashboard.normalizeLayout(d.layout), devices: dashboardSummary(d).devices });
});

app.put('/api/dashboards/:slug', auth.requireAdminSession, (req, res) => {
  const d = store.getDashboard(req.params.slug);
  if (!d) return res.status(404).json({ error: 'no such dashboard' });
  const b = req.body || {};
  const next = {
    ...d,
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : d.name,
    layout: b.layout !== undefined ? dashboard.normalizeLayout(b.layout) : dashboard.normalizeLayout(d.layout),
    updatedAt: new Date().toISOString()
  };
  store.saveDashboard(d.slug, next);
  res.json(next);
});

// Displays assigned to a deleted dashboard go back to "not set up".
app.delete('/api/dashboards/:slug', auth.requireAdminSession, (req, res) => {
  if (!store.deleteDashboard(req.params.slug)) return res.status(404).json({ error: 'no such dashboard' });
  const devices = store.getDevices();
  let changed = false;
  for (const d of Object.values(devices)) {
    if (d.dashboard === req.params.slug) {
      d.dashboard = '';
      changed = true;
    }
  }
  if (changed) store.saveDevices(devices);
  res.status(204).end();
});

// The admin UI's live preview of an unsaved dashboard layout.
app.post('/api/dashboards/preview', auth.requireAdminSession, async (req, res) => {
  try {
    res.json(await viewportScreens(dashboard.normalizeLayout(req.body && req.body.layout)));
  } catch (e) {
    haError(res, e);
  }
});

// --- Pictures, prepared for the device (album art, box art) ----------------
//
// GET /api/art?src=<entity_picture path or http(s) URL>&size=280 (or w=&h=)
// &fmt=mask1|spectra|png — the picture resized and dithered into exactly
// what the device draws (lib/art.js), so it never decodes a JPEG. Cached,
// with an ETag, so a repeat is a bodyless 304.
app.get('/api/art', auth.requireAdminOrDevice, async (req, res) => {
  const src = String(req.query.src || '');
  if (!src) return res.status(400).json({ error: 'src is required' });
  const size = Number(req.query.size) || 0;
  try {
    const img = await art.prepare(src, {
      width: Number(req.query.w) || size || 120,
      height: Number(req.query.h) || size || 120,
      format: String(req.query.fmt || 'mask1')
    }, store.getGlobals());
    const etag = `"${img.key.slice(0, 20)}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Width', String(img.width));
    res.set('X-Height', String(img.height));
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.type(img.type).send(img.body);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// --- Theme (compiled icon/font packs a paired device downloads) ---------

app.get('/api/theme', auth.requireAdminOrDevice, (req, res) => {
  const theme = store.getTheme();
  const out = { iconsVersion: theme.iconsVersion, fontsVersion: theme.fontsVersion };
  // The admin UI also gets the slot overrides the current pack was built
  // from, so the Theme page reopens with them instead of starting blank.
  if (!req.device) out.iconOverrides = theme.iconOverrides || {};
  res.json(out);
});

app.get('/api/theme/icons.pack', auth.requireAdminOrDevice, (req, res) => {
  const buf = store.getIconsPack();
  if (!buf) return res.status(404).json({ error: 'no icons pack compiled yet' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('ETag', store.getTheme().iconsVersion || '');
  res.send(buf);
});

app.get('/api/theme/fonts.pack', auth.requireAdminOrDevice, (req, res) => {
  const buf = store.getFontsPack();
  if (!buf) return res.status(404).json({ error: 'no fonts pack compiled yet' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('ETag', store.getTheme().fontsVersion || '');
  res.send(buf);
});

// Single-icon fetch for a per-item picker (Quick Access hub buttons,
// individual lights/scenes, individual blinds items - see the admin UI's
// shared icon-picker widget and the firmware's include/mdi_icon.h). Device-
// reachable, unlike the rest of /api/assets/* below, since the device is
// what actually needs this bitmap - the admin UI only needs the PNG preview
// (icons/search, icons/preview) to build the picker.
//
// The path/param name predate custom icon uploads - `:name` is resolved
// against custom uploads first, then the bundled MDI library (see
// iconsCompiler.compileSingleIcon -> resolveIconSvg), so this one route
// already serves both without the firmware needing to know which is which.
app.get('/api/icons/mdi/:name', auth.requireAdminOrDevice, async (req, res) => {
  const size = Math.min(Math.max(Number(req.query.size) || 40, 8), 128);
  try {
    const buf = await iconsCompiler.compileSingleIcon(req.params.name, size);
    res.set('Content-Type', 'application/octet-stream');
    res.send(buf);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Asset compiler (admin only) -----------------------------------------

app.get('/api/assets/icon-slots', auth.requireAdminSession, (req, res) => {
  res.json(iconSlots.listSlots());
});

app.get('/api/assets/icons/search', auth.requireAdminSession, async (req, res) => {
  const matches = iconsCompiler.searchMdiIcons(req.query.q, 40);
  try {
    const results = await Promise.all(
      matches.map(async (m) => ({
        name: m.name,
        source: m.source,
        preview: await iconsCompiler.renderPreviewPng(m.name)
      }))
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Custom icon uploads (admin-provided SVG, alongside the bundled MDI
// library) - see lib/assets/icons.js's resolveIconSvg() doc comment for how
// these become usable anywhere an MDI name already is, with zero changes to
// any consumer (the Theme page's slot picker, every per-item icon picker,
// and the device-facing single-icon endpoint below).
app.get('/api/assets/icons/custom', auth.requireAdminSession, (req, res) => {
  res.json(store.listCustomIcons());
});

app.post('/api/assets/icons/custom', auth.requireAdminSession, async (req, res) => {
  const name = req.body && req.body.name;
  const svg = req.body && req.body.svg;
  if (!store.isValidCustomIconName(name)) {
    return res
      .status(400)
      .json({ error: 'name must be lowercase letters, digits, and hyphens only (max 64 chars)' });
  }
  if (!svg || typeof svg !== 'string' || svg.length > 200 * 1024) {
    return res.status(400).json({ error: 'svg is required (max 200KB)' });
  }
  try {
    // Rasterize once up front so a malformed SVG fails the upload instead of
    // silently sitting in the library until the first thing that tries to
    // use it (a Theme compile, or a device's own icon fetch) breaks instead.
    const preview = await iconsCompiler.validateAndPreviewCustomSvg(svg);
    store.saveCustomIcon(name, svg);
    res.json({ ok: true, name, preview });
  } catch (err) {
    res.status(400).json({ error: `not a usable SVG: ${err.message}` });
  }
});

app.delete('/api/assets/icons/custom/:name', auth.requireAdminSession, (req, res) => {
  const ok = store.deleteCustomIcon(req.params.name);
  if (!ok) return res.status(404).json({ error: 'no such custom icon' });
  res.status(204).end();
});

// Batch preview - the Theme page's slot list renders a "currently" preview
// for every one of the ~107 named slots in one round trip instead of one
// request per row.
app.post('/api/assets/icons/preview', auth.requireAdminSession, async (req, res) => {
  const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
  try {
    const results = await Promise.all(
      names.map(async (name) => ({ name, preview: await iconsCompiler.renderPreviewPng(name) }))
    );
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/assets/icons/compile', auth.requireAdminSession, async (req, res) => {
  try {
    const overrides = (req.body && req.body.overrides) || {};
    const buf = await iconsCompiler.compileIconsPack(overrides);
    const version = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16);
    store.saveIconsPack(buf);
    const theme = store.getTheme();
    theme.iconsVersion = version;
    theme.iconOverrides = overrides;
    theme.updatedAt = new Date().toISOString();
    store.saveTheme(theme);
    res.json({ ok: true, version });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/assets/fonts/compile', auth.requireAdminSession, async (req, res) => {
  try {
    let ttfBuffer;
    if (req.body && req.body.ttfBase64) {
      ttfBuffer = Buffer.from(req.body.ttfBase64, 'base64');
    } else if (req.body && req.body.googleFont) {
      ttfBuffer = await googleFonts.fetchGoogleFontTtf(req.body.googleFont);
    } else {
      return res.status(400).json({ error: 'ttfBase64 or googleFont is required' });
    }
    const buf = await fontsCompiler.compileFontsPack(ttfBuffer);
    const version = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16);
    store.saveFontsPack(buf);
    const theme = store.getTheme();
    theme.fontsVersion = version;
    theme.updatedAt = new Date().toISOString();
    store.saveTheme(theme);
    res.json({ ok: true, version });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Rooms / Globals -------------------------------------------------------

app.get('/api/devices', auth.requireAdminOrDevice, (req, res) => {
  res.json(store.listProfiles());
});

app.post('/api/devices', auth.requireAdminSession, (req, res) => {
  const name = req.body && req.body.name;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const profile = store.createProfile(String(name).trim());
  res.status(201).json(profile);
});

// A device gets the room with its own layout folded in (lib/clients.js's
// composeDeviceConfig); the admin UI gets the room exactly as stored.
app.get('/api/devices/:slug/config', auth.requireAdminOrDevice, (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  res.json(req.device ? clients.composeDeviceConfig(profile, req.device) : profile);
});

// Everything a remote needs to know about its room, in one response: the
// room config, the shared globals (HA connection, Wi-Fi networks) and the
// theme pack versions — what /config + /api/globals + /api/theme return
// separately. Express's ETag handling answers an unchanged bundle with a
// bodyless 304 when the device sends If-None-Match, so a routine refresh
// with nothing new costs a few hundred bytes.
app.get('/api/devices/:slug/bundle', auth.requireAdminOrDevice, (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  const theme = store.getTheme();
  res.json({
    config: req.device ? clients.composeDeviceConfig(profile, req.device) : profile,
    globals: store.getGlobals(),
    theme: {
      iconsVersion: theme.iconsVersion || '',
      fontsVersion: theme.fontsVersion || ''
    }
  });
});

// Live Home Assistant state for every entity this room's pages show,
// fetched in parallel here and trimmed to what the firmware reads (see
// lib/ha-state.js) — one request per device refresh instead of a dozen-plus.
// 502 when HA can't be reached from the server at all: the device then
// falls back to asking HA directly.
//
// `live` says which pages are live right now (a player playing, blinds
// moving) and which are passive (they only change when someone presses a
// button), so a remote knows when watching is worth the radio time.
//
// ?page=music|xbox|blinds — just that page's entities (no forecast): what a
// remote re-reads while it has a live page on screen.
// ?wait=N (up to 25 s) with If-None-Match — held open until the state
// differs from the ETag the device has, else a bodyless 304 after N
// seconds: one request that answers the moment the track changes, instead
// of the device asking every few seconds. The server does the polling (HA
// is on the LAN; the device's radio is what costs).
const STATE_WAIT_MAX_S = 25;
const STATE_WAIT_STEP_MS = 2000;
app.get('/api/devices/:slug/state', auth.requireAdminOrDevice, async (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  const page = req.query.page ? String(req.query.page) : '';
  const pages = haState.pageEntities(profile);
  if (page && !pages[page]) return res.status(400).json({ error: 'unknown page' });
  const only = page ? pages[page] : null;
  const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), STATE_WAIT_MAX_S);
  const have = req.get('If-None-Match');
  const etagOf = (r) => `"${require('crypto').createHash('sha1').update(JSON.stringify([r.states, r.forecast, r.live])).digest('hex').slice(0, 20)}"`;
  const globals = store.getGlobals();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  try {
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const result = await haState.fetchRoomState(profile, globals, { only });
      const total = Object.keys(result.states).length;
      const failed = Object.keys(result.errors).length;
      // Entities HA says it doesn't have: a Home page warning for the room.
      if (!only && total > 0) haMonitor.noteEntities({ kind: 'room', slug: req.params.slug }, result.errors);
      if (total === 0 && failed > 0) {
        return res.status(502).json({ error: 'Home Assistant unreachable', errors: result.errors });
      }
      const etag = etagOf(result);
      if (have !== etag) {
        res.set('ETag', etag);
        return res.json(result);
      }
      if (closed) return undefined;
      const left = deadline - Date.now();
      if (left <= 0) {
        res.set('ETag', etag);
        return res.status(304).end();
      }
      await new Promise((r) => setTimeout(r, Math.min(STATE_WAIT_STEP_MS, left)));
      if (closed) return undefined;
    }
  } catch (e) {
    res.status(e.code === 'NO_HA' ? 409 : 502).json({ error: e.message });
  }
});

app.post('/api/devices/:slug/config', auth.requireAdminSession, (req, res) => {
  const { slug } = req.params;
  if (!store.isValidSlug(slug)) {
    return res.status(400).json({ error: 'invalid slug' });
  }

  const existing = store.getProfile(slug);
  const normalized = normalizeProfile(req.body, existing);

  const now = new Date().toISOString();
  const profile = {
    slug,
    name: normalized.name || slug,
    description: normalized.description,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
    homeAssistant: normalized.homeAssistant,
    standby: normalized.standby,
    lighting: normalized.lighting,
    blinds: normalized.blinds,
    screens: normalized.screens,
    media: normalized.media,
    climate: normalized.climate,
    tv: normalized.tv,
    xbox: normalized.xbox,
    receiver: normalized.receiver,
    hub: normalized.hub
  };

  store.saveProfile(slug, profile);
  res.json(profile);
});

app.get('/api/globals', auth.requireAdminOrDevice, (req, res) => {
  res.json(store.getGlobals());
});

app.post('/api/globals', auth.requireAdminSession, (req, res) => {
  const existing = store.getGlobals();
  const normalized = normalizeGlobals(req.body, existing);

  const globals = {
    updatedAt: new Date().toISOString(),
    wifi: normalized.wifi,
    homeAssistant: normalized.homeAssistant,
    ntpServer: normalized.ntpServer,
    wifiNetworks: normalized.wifiNetworks
  };

  store.saveGlobals(globals);
  res.json(globals);
});

app.delete('/api/devices/:slug', auth.requireAdminSession, (req, res) => {
  const ok = store.deleteProfile(req.params.slug);
  if (!ok) {
    return res.status(404).json({ error: 'no such profile' });
  }
  res.status(204).end();
});

// The admin Home page: device stats, battery and offline warnings, devices
// waiting for approval, how talking to Home Assistant is going, and
// anything else that needs attention (lib/overview.js).
const STARTED_AT = new Date();
app.get('/api/overview', auth.requireAdminSession, (req, res) => {
  const rooms = Object.fromEntries(store.listProfiles().map((p) => [p.slug, p.name]));
  const dashes = store.listDashboards();
  const layouts = Object.fromEntries(dashes.map((d) => [d.slug, d.name]));
  const refreshOf = Object.fromEntries(dashes.map((d) => [d.slug, dashboard.normalizeLayout(d.layout).refreshIntervalMin]));
  const devices = pairing.list().map((d) => ({
    ...d,
    type: clients.normalizeType(d.type),
    refreshMin: d.dashboard ? refreshOf[d.dashboard] : null
  }));
  const globals = store.getGlobals();
  const haCfg = globals.homeAssistant || {};
  res.json(
    overview.build({
      devices,
      rooms,
      layouts,
      ha: haMonitor.snapshot(),
      haConfigured: Boolean(haCfg.host && haCfg.token),
      server: {
        version: APP_VERSION,
        startedAt: STARTED_AT.toISOString(),
        mdnsHostname: MDNS_HOSTNAME,
        port: PORT,
        haHost: haCfg.host ? `${haCfg.host}:${haCfg.port || 8123}` : ''
      }
    })
  );
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    mdnsHostname: MDNS_HOSTNAME,
    port: PORT,
    mdnsServiceType: require('./lib/mdns').normalizeServiceType(MDNS_SERVICE_TYPE),
    dataDir: store.DATA_DIR
  });
});

// SPA fallback for the admin UI (any non-API GET that isn't a missing
// file, so a bad script path 404s instead of coming back as HTML).
app.get(/^(?!\/api\/)(?!.*\.[a-z0-9]+$).*/i, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Startup -------------------------------------------------------------

// Viewports saved before dashboards were their own thing carry their layout
// on the device record: move each into a dashboard of its own (named after
// the display) and assign it, once.
function migrateViewportLayouts() {
  const devices = store.getDevices();
  let changed = false;
  for (const d of Object.values(devices)) {
    if (clients.normalizeType(d.type) !== 'viewport' || d.dashboard || !d.layout || Array.isArray(d.layout.tiles)) continue;
    const name = d.name && d.name !== d.mac ? d.name : 'Viewport';
    const slug = store.newDashboardSlug(name);
    const now = new Date().toISOString();
    store.saveDashboard(slug, { name, createdAt: now, updatedAt: now, layout: dashboard.normalizeLayout(d.layout) });
    d.dashboard = slug;
    delete d.layout;
    changed = true;
    console.log(`[dashboards] moved ${d.mac}'s layout into dashboard "${slug}"`);
  }
  if (changed) store.saveDevices(devices);
}
migrateViewportLayouts();

app.listen(PORT, HOST, () => {
  console.log(`homeremote-server listening on http://${HOST}:${PORT}`);
  console.log(`profiles stored under ${store.DATA_DIR}`);

  if (DISABLE_MDNS) {
    console.log('[mdns] disabled via DISABLE_MDNS');
    return;
  }

  startMdnsResponder({
    hostname: MDNS_HOSTNAME,
    port: PORT,
    serviceType: MDNS_SERVICE_TYPE,
    instanceName: MDNS_INSTANCE_NAME,
    ip: MDNS_IP,
    iface: MDNS_INTERFACE
  });
});
