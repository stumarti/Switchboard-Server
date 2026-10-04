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
const enigma2 = require('./lib/enigma2');
const feeds = require('./lib/feeds');
const ical = require('./lib/ical');
const houseTz = require('./lib/house-tz');
const meetingRooms = require('./lib/meeting-rooms');
const firmware = require('./lib/firmware');
const batteryHistory = require('./lib/battery-history');
const haPublish = require('./lib/ha-publish');
const netguard = require('./lib/netguard');
const security = require('./lib/security');
const xboxLibrary = require('./lib/xbox-library');
const iconSlots = require('./lib/assets/icon-slots');
const fontSlots = require('./lib/assets/font-slots');
const viewportSlots = require('./lib/assets/viewport-slots');
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
// Behind a reverse proxy, TRUST_PROXY names it (its address(es), or e.g.
// "loopback"), so req.ip is the forwarded client's — what Settings →
// Security's allowed networks then check. Without it, req.ip still follows
// X-Forwarded-For for a device's last address (cosmetic), but the allowed
// networks check the connection's own address, which can't be faked.
app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map((x) => x.trim()) : true);
// Allowed networks (lib/netguard.js): before anything else answers.
app.use(netguard.middleware);
// 3mb (not the original 1mb) - a base64-encoded font upload (POST
// /api/assets/fonts/compile) can run a few hundred KB inflated ~33% by
// base64; everything else here is tiny by comparison.
app.use(express.json({ limit: '3mb' }));
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
  // Too many wrong passwords from this address lately (Settings → Security).
  const from = netguard.clientAddress(req);
  const wait = security.lockedFor(from);
  if (wait) return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60000)} min.` });
  const password = req.body && req.body.password;
  if (!password || !auth.checkPassword(String(password))) {
    const locked = security.noteFailure(from);
    return res.status(401).json({ error: locked ? `incorrect password; too many tries, so wait ${Math.ceil(locked / 60000)} min` : 'incorrect password' });
  }
  security.noteSuccess(from);
  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  res.json({ ok: true });
});

// Change the admin password: the current one first. Other signed-in browsers
// are signed out; this one stays signed in.
app.post('/api/auth/password', auth.requireAdminSession, (req, res) => {
  const b = req.body || {};
  if (!auth.checkPassword(String(b.current || ''))) return res.status(403).json({ error: 'the current password is wrong' });
  const next = String(b.password || '');
  if (next.length < 8) return res.status(400).json({ error: 'the new password must be at least 8 characters' });
  auth.setPassword(next);
  auth.destroyOtherSessions(auth.sessionFromRequest(req));
  res.json({ ok: true, fromEnv: auth.passwordFromEnv() });
});

app.get('/api/auth/account', auth.requireAdminSession, (req, res) => {
  const settings = store.getSettings();
  res.json({ passwordFromEnv: auth.passwordFromEnv(), passwordChangedAt: settings.passwordChangedAt || null });
});

// The server's clock, to check it against yours: remotes set their clock from
// its HTTP Date header, and it formats every time a viewport shows.
app.get('/api/time', auth.requireAdminSession, (req, res) => {
  const tz = houseTz.current();
  res.json({
    now: new Date().toISOString(),
    timeZone: tz.timeZone,
    // Where it came from: env (TZ), setting, homeAssistant or default.
    timeZoneSource: tz.source,
    timeZoneSetting: store.getGlobals().timeZone || '',
    ntpServer: store.getGlobals().ntpServer || 'pool.ntp.org'
  });
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
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
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
  haPublish.kick(); // its Home Assistant sensors follow the new name
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
  batteryHistory.forget(req.params.mac);
  haPublish.kick(); // and its Home Assistant sensors go
  res.status(204).end();
});

// --- Home Assistant lookups for the admin UI (entity pickers) -----------
//
// The server holds the HA token, so the browser never needs it: these proxy
// HA's own entity list, trimmed to what the pickers show.

// Settings → Security: the networks the server answers (lib/netguard.js).
// `you` is the address this browser is seen from, so the UI can say whether
// a list would include it (a save that wouldn't is refused).
// The rest (sign-in length, the failed sign-in limit, accepting new
// devices) is lib/security.js, at /api/security/settings.
function securityView(req) {
  return {
    ...netguard.current(),
    you: netguard.clientAddress(req),
    private: netguard.PRIVATE,
    trustProxy: process.env.TRUST_PROXY || '',
    settings: security.get(),
    sessionChoices: security.SESSION_CHOICES,
    sessions: auth.sessionCount()
  };
}

app.get('/api/security', auth.requireAdminSession, (req, res) => {
  res.json(securityView(req));
});

app.put('/api/security', auth.requireAdminSession, (req, res) => {
  try {
    netguard.save(req.body, netguard.clientAddress(req));
    res.json(securityView(req));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.put('/api/security/settings', auth.requireAdminSession, (req, res) => {
  try {
    security.save(req.body);
    res.json(securityView(req));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Sign out every other browser; this one stays signed in.
app.post('/api/security/sign-out-others', auth.requireAdminSession, (req, res) => {
  auth.destroyOtherSessions(auth.sessionFromRequest(req));
  res.json(securityView(req));
});

// Battery sensors published to Home Assistant (lib/ha-publish.js): whether
// it's on, when it last synced, which entities, and any error.
app.get('/api/ha/publish', auth.requireAdminSession, (req, res) => {
  res.json(haPublish.getStatus());
});

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
      layoutCustomized: Boolean(d.layout),
      batteryLife: batteryHistory.estimate(d.mac)
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
      quietChoices: dashboard.QUIET_CHOICES,
      nowKinds: dashboard.NOW_KINDS,
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
    layout: dashboardState.deviceLayout(layout),
    // Every icon the screens can show, to fetch (and cache) up front from
    // /api/icons/mdi/:name.
    icons: dashboardState.iconsUsed(layout),
    wifiNetworks: globals.wifiNetworks || [],
    ntpServer: globals.ntpServer || 'pool.ntp.org',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // The server's offset from UTC now (minutes), for the device's clock:
    // it re-reads it every wake, so a DST change follows within one.
    utcOffsetMin: clients.utcOffsetMin(),
    // Over-the-air updates, as a remote gets them: an offer only for a
    // display whose firmware says its board (X-Board) and has a release.
    firmware: firmware.configFor(device.mac, req.device ? deviceNow(req) : device)
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
  const { quiet, interval } = dashboardState.refreshPlan(layout, new Date(), undefined, {
    staggerSec: clients.viewportStaggerFor(store.normalizeMac(device.mac), store.getDevices())
  });
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
      res.set('X-Quiet', quiet ? '1' : '0');
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      return res.json({ screen: wanted, etag, refreshInSec: soonest([screen.nextChangeInSec]), quiet, generatedAt, data: screen });
    }
    const out = {};
    for (const sc of layout.screens.filter((x) => x.enabled)) {
      out[sc.id] = { etag: dashboardState.screenEtag(screens[sc.id]), data: screens[sc.id] };
    }
    const next = layout.screens.filter((x) => x.enabled).map((x) => screens[x.id].nextChangeInSec);
    res.json({ refreshInSec: soonest(next), quiet, generatedAt, errors, screens: out });
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

// --- Meeting rooms, many at once (lib/meeting-rooms.js) ------------------------

// A pasted room list, read: each line's room, and anything wrong with it;
// which rooms already have a layout (they'd be updated); what each listed
// display is now.
app.post('/api/meeting-rooms/parse', auth.requireAdminSession, (req, res) => {
  const rooms = meetingRooms.parseRoomList(req.body && req.body.text);
  const names = new Set(store.listDashboards().map((d) => d.name.trim().toLowerCase()));
  const devices = store.getDevices();
  res.json({
    rooms: rooms.map((r) => {
      const d = r.mac ? devices[store.normalizeMac(r.mac)] : null;
      return { ...r, exists: names.has(r.name.toLowerCase()), display: d ? (d.lastSeenAt ? d.status : 'expected') : r.mac ? 'new' : '' };
    })
  });
});

// {text | rooms, finder, approve, settings} -> a layout per room (made, or
// updated by name), and its display set up: {results: [{name, slug, layout, display}]}.
app.post('/api/meeting-rooms', auth.requireAdminSession, (req, res) => {
  const b = req.body || {};
  const rooms = Array.isArray(b.rooms)
    ? b.rooms.map((r) => ({ name: String(r.name || '').trim(), calendar: String(r.calendar || '').trim(), occupancy: String(r.occupancy || '').trim(), mac: String(r.mac || '').trim(), problems: r.name && r.calendar ? [] : ['a name and a calendar are needed'] }))
    : meetingRooms.parseRoomList(b.text);
  if (!rooms.some((r) => !r.problems.length)) return res.status(400).json({ error: 'no rooms to set up: each needs a name and a calendar' });
  const results = meetingRooms.apply(rooms, { finder: b.finder !== false, approve: b.approve === true, settings: b.settings }, pairing);
  res.status(201).json({ results, skipped: rooms.filter((r) => r.problems.length).map((r) => ({ line: r.line, name: r.name, problems: r.problems })) });
});

// Test a calendar link (or a Home Assistant calendar is left to HA): its
// name, and its next few events. The link itself is never logged.
app.post('/api/calendars/check', auth.requireAdminSession, async (req, res) => {
  const link = String((req.body && req.body.calendar) || '').trim();
  if (!ical.isCalendarUrl(link)) return res.status(400).json({ error: 'not a calendar link (https://, http:// or webcal://)' });
  await ical.refresh(link);
  const now = new Date();
  const r = await ical.eventsFor(link, { start: now, end: new Date(now.getTime() + 14 * 86400000) }, Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (r.error && !r.events.length) return res.status(502).json({ error: r.error });
  res.json({ name: r.name, count: r.events.length, next: r.events.slice(0, 3).map((e) => ({ title: e.summary, start: e.start.dateTime || e.start.date })) });
});

// Approve several waiting displays at once: [{mac, name, dashboard}].
app.post('/api/pairing/approve-many', auth.requireAdminSession, (req, res) => {
  const list = Array.isArray(req.body && req.body.devices) ? req.body.devices : [];
  const results = list.slice(0, 200).map((x) => {
    const mac = store.normalizeMac(x && x.mac);
    if (!store.getDevices()[mac]) return { mac, error: 'no such device' };
    const a = pairing.approve(mac, '');
    if (a.error) return { mac, error: a.error };
    pairing.update(mac, { type: 'viewport', ...(x.name ? { name: String(x.name) } : {}), dashboard: String(x.dashboard || '') });
    return { mac, ok: true };
  });
  res.json({ results });
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
// &fmt=mask1|spectra|png|mask1png — the picture resized and dithered into exactly
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
      format: String(req.query.fmt || 'mask1'),
      fit: req.query.fit === 'contain' ? 'contain' : 'cover'
    }, store.getGlobals(), (s) => enigma2.resolvePiconSrc(s, store.getProfile));
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

// Which kind of device's theme a request is for: a device gets its own
// (remotes and viewports draw different icons at different sizes); the
// admin UI says which with ?kind=.
function themeKindOf(req) {
  if (req.device) return clients.normalizeType(req.device.type) === 'viewport' ? 'viewport' : 'remote';
  return store.themeKind(String(req.query.kind || (req.body && req.body.kind) || 'remote'));
}
const slotsFor = (kind) => (kind === 'viewport' ? viewportSlots : iconSlots);

app.get('/api/theme', auth.requireAdminOrDevice, (req, res) => {
  const theme = store.getTheme();
  const kind = themeKindOf(req);
  const t = store.themeFor(theme, kind);
  const out = { iconsVersion: t.iconsVersion, fontsVersion: t.fontsVersion };
  // The admin UI also gets the slot overrides the current pack was built
  // from, so the Theme page reopens with them instead of starting blank.
  if (!req.device) {
    out.kind = kind;
    out.iconOverrides = t.iconOverrides;
  }
  res.json(out);
});

app.get('/api/theme/icons.pack', auth.requireAdminOrDevice, (req, res) => {
  const kind = themeKindOf(req);
  const buf = store.getIconsPack(kind);
  if (!buf) return res.status(404).json({ error: 'no icons pack compiled yet' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('ETag', store.themeFor(store.getTheme(), kind).iconsVersion);
  res.send(buf);
});

app.get('/api/theme/fonts.pack', auth.requireAdminOrDevice, (req, res) => {
  const kind = themeKindOf(req);
  const buf = store.getFontsPack(kind);
  if (!buf) return res.status(404).json({ error: 'no fonts pack compiled yet' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('ETag', store.themeFor(store.getTheme(), kind).fontsVersion);
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
  res.json(slotsFor(themeKindOf(req)).listSlots());
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
    const kind = themeKindOf(req);
    // A viewport's pack carries only the slots you changed (its built-in
    // art is in colour); a remote's, every slot.
    const slots = kind === 'viewport' ? viewportSlots.packSlots(overrides) : slotsFor(kind).listSlots();
    const buf = await iconsCompiler.compileIconsPack(overrides, slots);
    const version = require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16);
    store.saveIconsPack(buf, kind);
    const theme = store.getTheme();
    if (kind === 'viewport') {
      theme.viewport = { ...(theme.viewport || {}), iconsVersion: version, iconOverrides: overrides };
    } else {
      theme.iconsVersion = version;
      theme.iconOverrides = overrides;
    }
    theme.updatedAt = new Date().toISOString();
    store.saveTheme(theme);
    res.json({ ok: true, version });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/assets/fonts/compile', auth.requireAdminSession, async (req, res) => {
  try {
    // One font for every device: the remote's faces, and the viewport's in
    // its regular and bold weights (a Google Font's 700, or an uploaded bold
    // file; else the same font).
    let ttfBuffer;
    let boldBuffer = null;
    if (req.body && req.body.ttfBase64) {
      ttfBuffer = Buffer.from(req.body.ttfBase64, 'base64');
      if (req.body.boldTtfBase64) boldBuffer = Buffer.from(req.body.boldTtfBase64, 'base64');
    } else if (req.body && req.body.googleFont) {
      ttfBuffer = await googleFonts.fetchGoogleFontTtf(req.body.googleFont);
      boldBuffer = await googleFonts.fetchGoogleFontTtf(req.body.googleFont, 700).catch(() => null);
    } else {
      return res.status(400).json({ error: 'ttfBase64 or googleFont is required' });
    }
    const hash = (b) => require('crypto').createHash('sha256').update(b).digest('hex').slice(0, 16);
    const buf = await fontsCompiler.compileFontsPack(ttfBuffer, fontSlots.listFaces());
    const vbuf = await fontsCompiler.compileFontsPack(ttfBuffer, viewportSlots.listFaces(), boldBuffer);
    const version = hash(buf);
    store.saveFontsPack(buf, 'remote');
    store.saveFontsPack(vbuf, 'viewport');
    const theme = store.getTheme();
    theme.fontsVersion = version;
    theme.viewport = { ...(theme.viewport || {}), fontsVersion: hash(vbuf) };
    theme.updatedAt = new Date().toISOString();
    store.saveTheme(theme);
    res.json({ ok: true, version, viewportVersion: theme.viewport.fontsVersion });
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
// A room whose Xbox library is "Browse" gets the console's games from Home
// Assistant's media browser (lib/xbox-library.js), cached here.
// A remote also learns when to wake if its room refreshes on the clock: its
// place in the house's stagger (lib/clients.js staggerFor) and the local UTC
// offset.
// ...and whether there's firmware for it to install (lib/firmware.js).
function deviceConfig(profile, device, mac) {
  const base = haState.haBase(store.getGlobals());
  const cfg = clients.composeDeviceConfig(xboxLibrary.withLibrary(profile, base), device, {
    staggerSec: clients.staggerFor(mac, store.getDevices())
  });
  if (cfg && clients.normalizeType(device.type) === 'remote') cfg.firmware = firmware.configFor(mac, device);
  return cfg;
}
app.get('/api/devices/:slug/config', auth.requireAdminOrDevice, (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  res.json(req.device ? deviceConfig(profile, deviceNow(req), req.deviceMac) : profile);
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
    config: req.device ? deviceConfig(profile, deviceNow(req), req.deviceMac) : profile,
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
  const etagOf = (r) => `"${require('crypto').createHash('sha1').update(JSON.stringify([r.states, r.forecast, r.live, r.receiver])).digest('hex').slice(0, 20)}"`;
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
      // The receiver page's now / next and picons: from the box when the room
      // has its address, else from Home Assistant (lib/enigma2.js).
      const rx = profile.receiver;
      if (!only && rx && rx.mediaPlayerEntity) {
        result.receiver = await enigma2.receiverInfo(rx, {
          haState: result.states[rx.mediaPlayerEntity],
          piconSrc: enigma2.piconSrcFor(req.params.slug)
        });
      }
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

// The room editor's screen previews: the state the remote would get for the
// room as it is in the editor, saved or not — the same entities and the same
// trimming as /state, so the preview shows what the device would draw.
app.post('/api/devices/:slug/state/preview', auth.requireAdminSession, async (req, res) => {
  const existing = store.getProfile(req.params.slug);
  const profile = normalizeProfile(req.body, existing);
  try {
    const result = await haState.fetchRoomState(profile, store.getGlobals());
    const rx = profile.receiver;
    if (rx && rx.mediaPlayerEntity) {
      result.receiver = await enigma2.receiverInfo(rx, {
        haState: result.states[rx.mediaPlayerEntity],
        piconSrc: enigma2.piconSrcFor(req.params.slug)
      });
    }
    res.json(result);
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
    hub: normalized.hub,
    developerMenu: normalized.developerMenu
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
    timeZone: normalized.timeZone,
    wifiNetworks: normalized.wifiNetworks
  };

  store.saveGlobals(globals);
  haPublish.kick(); // publishing to Home Assistant may have been switched
  // A new time zone (or Home Assistant connection) takes effect at once.
  houseTz.apply(globals).catch(() => null);
  res.json(globals);
});

app.delete('/api/devices/:slug', auth.requireAdminSession, (req, res) => {
  const ok = store.deleteProfile(req.params.slug);
  if (!ok) {
    return res.status(404).json({ error: 'no such profile' });
  }
  res.status(204).end();
});

// The Receiver card's "Check": what an (unsaved) receiver config gets from
// its box — now / next, and how many channels and picons it lists.
// --- Remote firmware updates (lib/firmware.js) -----------------------------
//
// A remote asks what to install (/offer: 204 = nothing), downloads that one
// build (/image/<version>, only the one it's offered), checks its SHA-256,
// and reports how it went (/report). Everything else is the admin UI's.

// The requesting device as it is now: the firmware and board it says it
// runs on this request (X-Firmware, X-Board), not the last ones recorded.
function deviceNow(req) {
  const running = req.get('X-Firmware');
  const board = req.get('X-Board');
  if (!req.device || (!running && !board)) return req.device;
  const health = { ...(req.device.health || {}) };
  if (running) health.firmware = String(running).slice(0, 64);
  if (board && /^[a-z0-9][a-z0-9-]{0,23}$/.test(board)) health.board = board;
  return { ...req.device, health };
}

app.get('/api/firmware/offer', auth.requireAdminOrDevice, (req, res) => {
  if (!req.device) return res.status(400).json({ error: 'for devices' });
  const offer = firmware.offerFor(req.deviceMac, deviceNow(req));
  if (!offer) return res.status(204).end();
  res.json(offer);
});

app.get('/api/firmware/image/:version', auth.requireAdminOrDevice, (req, res) => {
  const version = String(req.params.version);
  // A device gets its own board's build; the admin UI names the board.
  let board = String(req.query.board || firmware.LEGACY_BOARD);
  if (req.device) {
    const offer = firmware.offerFor(req.deviceMac, deviceNow(req));
    if (!offer || offer.version !== version) return res.status(403).json({ error: 'not offered to this device' });
    board = offer.board;
  }
  const img = firmware.readImage(board, version);
  if (!img) return res.status(404).json({ error: 'no such build' });
  res.set('Content-Type', 'application/octet-stream');
  res.set('X-Sha256', img.build.sha256);
  res.set('Cache-Control', 'no-store');
  res.sendFile(img.file, { headers: { 'Content-Length': String(img.build.size) } }, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

app.post('/api/firmware/report', auth.requireAdminOrDevice, (req, res) => {
  if (!req.device) return res.status(400).json({ error: 'for devices' });
  firmware.report(req.deviceMac, req.body, deviceNow(req));
  res.json({ ok: true });
});

app.get('/api/firmware', auth.requireAdminSession, (req, res) => {
  const devices = store.getDevices();
  res.json({ ...firmware.overview(devices), remotes: firmware.status(devices), maxImage: firmware.MAX_IMAGE });
});

app.put('/api/firmware/settings', auth.requireAdminSession, (req, res) => {
  try {
    res.json({ settings: firmware.updateSettings(req.body) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// "Update now" (the Home page): every remote offered the release installs it
// at its next wake, whatever the schedule. DELETE takes it back.
app.post('/api/firmware/update-now', auth.requireAdminSession, (req, res) => {
  try {
    firmware.updateNow({ board: String((req.body && req.body.board) || firmware.LEGACY_BOARD), everyone: Boolean(req.body && req.body.everyone) });
    res.json(firmware.summary(store.getDevices()));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/firmware/update-now', auth.requireAdminSession, (req, res) => {
  firmware.cancelUpdateNow(String(req.query.board || firmware.LEGACY_BOARD));
  res.json(firmware.summary(store.getDevices()));
});

app.post('/api/firmware/upload', auth.requireAdminSession, express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => {
  try {
    res.json({ build: firmware.addBuild(req.body, `upload ${new Date().toISOString().slice(0, 10)}`) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/firmware/builds/:version', auth.requireAdminSession, (req, res) => {
  try {
    firmware.removeBuild(String(req.query.board || firmware.LEGACY_BOARD), String(req.params.version));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/firmware/releases', auth.requireAdminSession, async (req, res) => {
  try {
    res.json({ releases: await firmware.githubReleases({ repo: req.query.repo ? String(req.query.repo) : '' }) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// The Home page's "Get latest": the newest GitHub release, as a build.
app.post('/api/firmware/latest', auth.requireAdminSession, async (req, res) => {
  try {
    res.json({ results: await firmware.importLatest({ repo: req.body && req.body.repo ? String(req.body.repo) : '' }) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post('/api/firmware/import', auth.requireAdminSession, async (req, res) => {
  const tag = String((req.body && req.body.tag) || '');
  if (!tag) return res.status(400).json({ error: 'tag is required' });
  try {
    res.json({ builds: await firmware.importRelease(tag, { repo: req.body && req.body.repo ? String(req.body.repo) : '' }) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// The viewport editor's "Check feed": read an RSS/Atom address now (not from
// the cache) and say what it found.
app.post('/api/feeds/check', auth.requireAdminSession, async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Enter the feed’s full address, e.g. https://example.com/news/rss' });
  }
  const f = await feeds.refresh(url);
  if (f.error) return res.status(502).json({ error: f.error });
  res.json({ count: f.items.length, latest: f.items.slice(0, 3).map((it) => ({ title: it.title, date: it.date })) });
});

app.post('/api/receiver/check', auth.requireAdminSession, async (req, res) => {
  const b = (req.body && req.body.receiver) || {};
  const box = enigma2.boxBase(b.boxUrl);
  if (!box) return res.status(400).json({ error: 'Enter the box’s address, e.g. http://192.168.1.50' });
  try {
    const cur = await enigma2.current(box);
    let list = null;
    try {
      list = await enigma2.channels(box);
    } catch {
      list = null;
    }
    const info = await enigma2.receiverInfo({ ...b, mediaPlayerEntity: b.mediaPlayerEntity || 'x' }, { piconSrc: (p) => p });
    res.json({
      channel: cur.name,
      now: info && info.now,
      next: info && info.next,
      channels: list ? list.byName.size : null,
      favourites: (b.channels || []).map((ch) => {
        const hit = list && list.byName.get(String(ch.source || '').toLowerCase());
        return { found: Boolean(hit), picon: Boolean(hit && hit.picon) };
      })
    });
  } catch (e) {
    res.status(502).json({ error: `The box didn’t answer: ${e.message}` });
  }
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
    refreshMin: d.dashboard ? refreshOf[d.dashboard] : null,
    batteryLife: batteryHistory.estimate(d.mac)
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
      // Remotes always need it; viewport layouts only if they use entities.
      haNeeded: store.listProfiles().length > 0 || dashes.some((d) => dashboardState.usesHomeAssistant(dashboard.normalizeLayout(d.layout))),
      timeZone: houseTz.current(),
      updates: firmware.overview(store.getDevices()).settings.enabled ? firmware.status(store.getDevices()) : [],
      updateSummary: firmware.summary(store.getDevices()),
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

// The battery history is written at most every few minutes: keep the last
// readings when the container stops.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    try {
      batteryHistory.flush(true);
    } finally {
      process.exit(0);
    }
  });
}

haPublish.start();

app.listen(PORT, HOST, () => {
  console.log(`homeremote-server listening on http://${HOST}:${PORT}`);
  // The house's time zone from Home Assistant, unless TZ is set.
  houseTz.start(() => store.getGlobals());
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
