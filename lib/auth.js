'use strict';

/**
 * Admin web-portal auth (single shared password, session cookie) and device
 * pairing auth (bearer token per approved device). No new dependencies -
 * confirmed nothing auth-related (express-session, cookie-parser, bcrypt) is
 * already vendored anywhere in this project, so this hand-rolls sessions and
 * cookies on top of Node's built-in crypto, same "small, few deps" style as
 * the rest of the server.
 *
 * Two middlewares cover every route:
 *   requireAdminSession  - browser only (device registry management, auth
 *                          endpoints, theme compile).
 *   requireAdminOrDevice - browser session OR a paired device's bearer token
 *                          (the endpoints both the admin UI and firmware hit:
 *                          /api/devices, /api/devices/:slug/config GET,
 *                          /api/globals GET, /api/theme*). Also touches the
 *                          matching device's lastSeenAt/lastIp on every
 *                          successful bearer-authenticated request, so
 *                          "last seen" stays fresh with no separate
 *                          heartbeat endpoint.
 */

const crypto = require('crypto');
const store = require('./store');

const SESSION_COOKIE = 'sb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

// token -> { expiresAt }. In-memory by design: restarting the server just
// means everyone re-logs in, which is fine at this scale (a household admin
// tool, not something restarted mid-session often).
const sessions = new Map();

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { passwordHash: scryptHash(password, salt), passwordSalt: salt };
}

function verifyPassword(password, passwordHash, passwordSalt) {
  if (!passwordHash || !passwordSalt) return false;
  const candidate = scryptHash(password, passwordSalt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Seeds/overwrites the stored password from ADMIN_PASSWORD on every boot
// when that env var is set - lets an operator rotate the password via
// docker-compose the same way every other config value here works. Also
// makes sure a sessionSecret exists (generated once, kept thereafter).
function ensureSettings() {
  const settings = store.getSettings();
  let changed = false;

  if (!settings.sessionSecret) {
    settings.sessionSecret = crypto.randomBytes(32).toString('hex');
    changed = true;
  }

  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword) {
    const { passwordHash, passwordSalt } = hashPassword(envPassword);
    settings.passwordHash = passwordHash;
    settings.passwordSalt = passwordSalt;
    changed = true;
  }

  if (changed) {
    settings.updatedAt = new Date().toISOString();
    store.saveSettings(settings);
  }
  return settings;
}

function isSetupRequired() {
  const settings = store.getSettings();
  return !settings.passwordHash;
}

function setPassword(password) {
  const { passwordHash, passwordSalt } = hashPassword(password);
  const settings = store.getSettings();
  settings.passwordHash = passwordHash;
  settings.passwordSalt = passwordSalt;
  settings.updatedAt = settings.passwordChangedAt = new Date().toISOString();
  store.saveSettings(settings);
}

function checkPassword(password) {
  const settings = store.getSettings();
  return verifyPassword(password, settings.passwordHash, settings.passwordSalt);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

// Every session but `keep` — after a password change, other browsers signed
// in with the old one are signed out.
function destroyOtherSessions(keep) {
  for (const token of [...sessions.keys()]) if (token !== keep) sessions.delete(token);
}

// Whether ADMIN_PASSWORD is set: it replaces the stored password on every
// start, so a password changed in the admin UI lasts only until a restart.
function passwordFromEnv() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function touchSession(token) {
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  s.expiresAt = Date.now() + SESSION_TTL_MS; // sliding expiry
  return true;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  // httpOnly + SameSite=Lax; no Secure - this stays plain HTTP by design
  // (LAN-only admin tool, same trust model as the rest of this server).
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return touchSession(token) ? token : null;
}

function bearerFromRequest(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

// Returns the device record matching a raw bearer token, or null. Only
// "approved" devices carry a tokenHash that can match - a revoked device's
// tokenHash was cleared, so its old token stops matching immediately.
function deviceForToken(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const devices = store.getDevices();
  for (const mac of Object.keys(devices)) {
    const d = devices[mac];
    if (d.status === 'approved' && d.tokenHash && d.tokenHash === tokenHash) {
      return { mac, devices };
    }
  }
  return null;
}

function requireAdminSession(req, res, next) {
  const token = sessionFromRequest(req);
  if (!token) return res.status(401).json({ error: 'not authenticated' });
  next();
}

// Battery %, temperature, Wi-Fi signal and firmware, as any paired device
// (remote or viewport) reports them in headers on its requests — for the
// Home page's battery warnings. (Required here, not at the top: pairing
// needs this module's neighbours loaded first.)
function noteHealth(req, mac) {
  const reported = {
    battery: req.get('X-Battery'),
    temperature: req.get('X-Temperature'),
    rssi: req.get('X-RSSI'),
    firmware: req.get('X-Firmware')
  };
  if (Object.values(reported).every((v) => v == null || v === '')) return;
  require('./pairing').recordHealth(mac, reported);
}

function requireAdminOrDevice(req, res, next) {
  const sessionToken = sessionFromRequest(req);
  if (sessionToken) return next();

  const bearer = bearerFromRequest(req);
  const match = deviceForToken(bearer);
  if (!match) return res.status(401).json({ error: 'not authenticated' });

  const { mac, devices } = match;
  if (store.touchLastSeen(devices[mac], req.ip)) store.saveDevices(devices);
  req.device = devices[mac];
  req.deviceMac = mac;
  noteHealth(req, mac);
  next();
}

module.exports = {
  ensureSettings,
  destroyOtherSessions,
  passwordFromEnv,
  isSetupRequired,
  setPassword,
  checkPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  sessionFromRequest,
  bearerFromRequest,
  deviceForToken,
  requireAdminSession,
  requireAdminOrDevice
};
