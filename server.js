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

const path = require('path');
const express = require('express');

const store = require('./lib/store');
const { normalizeProfile, normalizeGlobals } = require('./lib/validate');
const { startMdnsResponder } = require('./lib/mdns');
const auth = require('./lib/auth');
const pairing = require('./lib/pairing');
const haState = require('./lib/ha-state');
const clients = require('./lib/clients');
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
      layout: clients.layoutFor(d, d.assignedSlug ? store.getProfile(d.assignedSlug) : null),
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
    viewportTileTypes: clients.VIEWPORT_TILE_TYPES,
    viewportTileSizes: clients.VIEWPORT_TILE_SIZES,
    refreshChoices: clients.REFRESH_CHOICES
  });
});

// --- Theme (compiled icon/font packs a paired device downloads) ---------

app.get('/api/theme', auth.requireAdminOrDevice, (req, res) => {
  const theme = store.getTheme();
  res.json({ iconsVersion: theme.iconsVersion, fontsVersion: theme.fontsVersion });
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
// falls back to asking HA directly, entity by entity.
app.get('/api/devices/:slug/state', auth.requireAdminOrDevice, async (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  try {
    const result = await haState.fetchRoomState(profile, store.getGlobals());
    const total = Object.keys(result.states).length;
    const failed = Object.keys(result.errors).length;
    if (total === 0 && failed > 0) {
      return res.status(502).json({ error: 'Home Assistant unreachable', errors: result.errors });
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

// SPA fallback for the admin UI (any non-API GET) -> index.html
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Startup -------------------------------------------------------------

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
