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
  const result = pairing.register(req.body && req.body.mac, req.ip);
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

// --- Asset compiler (admin only) -----------------------------------------

app.get('/api/assets/icon-slots', auth.requireAdminSession, (req, res) => {
  res.json(iconSlots.listSlots());
});

app.get('/api/assets/icons/search', auth.requireAdminSession, async (req, res) => {
  const matches = iconsCompiler.searchMdiIcons(req.query.q, 40);
  try {
    const results = await Promise.all(
      matches.map(async (name) => ({ name, preview: await iconsCompiler.renderPreviewPng(name) }))
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.get('/api/devices/:slug/config', auth.requireAdminOrDevice, (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  res.json(profile);
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
