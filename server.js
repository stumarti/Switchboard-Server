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
 *
 * Security note (spec section 8b): this is plain HTTP, LAN-only, no auth by
 * default - same trust model as the on-device config server, carried over
 * for this first pass. This server aggregates every room's HA token, so an
 * admin password/PIN gate is flagged in the spec as a near-term follow-up,
 * not implemented here yet. Do not expose this container's port to the
 * internet.
 */

const path = require('path');
const express = require('express');

const store = require('./lib/store');
const { normalizeProfile, normalizeGlobals } = require('./lib/validate');
const { startMdnsResponder } = require('./lib/mdns');

const APP_VERSION = process.env.APP_VERSION || 'dev';
const PORT = Number(process.env.PORT) || 45678;
const HOST = process.env.HOST || '0.0.0.0';
const MDNS_HOSTNAME = process.env.MDNS_HOSTNAME || 'switchboard.local';
const MDNS_IP = process.env.MDNS_IP || undefined;
const MDNS_INTERFACE = process.env.MDNS_INTERFACE || undefined;
const MDNS_SERVICE_TYPE = process.env.MDNS_SERVICE_TYPE || 'switchboard';
const MDNS_INSTANCE_NAME = process.env.MDNS_INSTANCE_NAME || undefined;
const DISABLE_MDNS = /^(1|true|yes)$/i.test(process.env.DISABLE_MDNS || '');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API ---------------------------------------------------------------

app.get('/api/devices', (req, res) => {
  res.json(store.listProfiles());
});

app.post('/api/devices', (req, res) => {
  const name = req.body && req.body.name;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const profile = store.createProfile(String(name).trim());
  res.status(201).json(profile);
});

app.get('/api/devices/:slug/config', (req, res) => {
  const profile = store.getProfile(req.params.slug);
  if (!profile) {
    return res.status(404).json({ error: 'no such profile' });
  }
  res.json(profile);
});

app.post('/api/devices/:slug/config', (req, res) => {
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
    xbox: normalized.xbox
  };

  store.saveProfile(slug, profile);
  res.json(profile);
});

app.get('/api/globals', (req, res) => {
  res.json(store.getGlobals());
});

app.post('/api/globals', (req, res) => {
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

app.delete('/api/devices/:slug', (req, res) => {
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
