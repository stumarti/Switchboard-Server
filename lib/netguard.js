'use strict';

/**
 * Allowed networks: answer only requests from certain IP ranges
 * (Settings → Security; off until switched on).
 *
 * Everything is covered (the admin UI, the devices' API, pairing), so the
 * list must include every network a remote, viewport or browser reaches the
 * server from. This server itself (127.0.0.1, ::1) is always allowed: a
 * container health check, and a way back in from the host.
 *
 * Whose address: the connection's own, not X-Forwarded-For (which anyone
 * can send). Behind a reverse proxy, every request arrives from the proxy;
 * set TRUST_PROXY to the proxy's address(es) and its forwarded client
 * address is checked instead (Express's "trust proxy").
 *
 * Saved in <DATA_DIR>/_settings.json as `network: {enabled, allowed}`.
 * ALLOWED_NETWORKS (comma-separated, or "any") replaces the saved list on
 * every request while it's set: the way back in if a list ever locks you out.
 */

const net = require('net');
const store = require('./store');

// Every private and local range: the usual home and office networks,
// carrier-grade NAT and Tailscale (100.64.0.0/10), and their IPv6 kin.
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'];
const LOOPBACK = ['127.0.0.0/8', '::1/128'];
const MAX_ENTRIES = 64;

/** "192.168.1.0/24", "10.0.0.5", "fd00::/8" -> {address, prefix, family}, or throws. */
function parseEntry(text) {
  const raw = String(text || '').trim();
  const [address, bits, extra] = raw.split('/');
  const family = net.isIP(address);
  if (!family || extra !== undefined) throw Object.assign(new Error(`${raw || 'An empty line'} isn't an IP address or range (use e.g. 192.168.1.0/24).`), { status: 400 });
  const max = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
    throw Object.assign(new Error(`${raw} has a bad prefix length (0–${max}).`), { status: 400 });
  }
  return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

/** The tidy list ("10.0.0.5" -> "10.0.0.5/32"), duplicates dropped; throws on a bad entry. */
function normalizeList(list) {
  const out = [];
  for (const line of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
    if (!String(line).trim()) continue;
    const e = parseEntry(line);
    const tidy = `${e.address}/${e.prefix}`;
    if (!out.includes(tidy)) out.push(tidy);
  }
  if (out.length > MAX_ENTRIES) throw Object.assign(new Error(`Up to ${MAX_ENTRIES} entries.`), { status: 400 });
  return out;
}

function compile(list) {
  const bl = new net.BlockList();
  for (const entry of [...list, ...LOOPBACK]) {
    const e = parseEntry(entry);
    bl.addSubnet(e.address, e.prefix, e.family);
  }
  return bl;
}

// An IPv4 client on a dual-stack socket arrives as ::ffff:a.b.c.d.
function plain(address) {
  const a = String(address || '');
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(a) ? a.slice(7) : a;
}

/** Whether `address` is in `list` (or is this server itself). Pure. */
function allows(list, address) {
  const a = plain(address);
  const family = net.isIP(a);
  if (!family) return false;
  return compile(list).check(a, family === 4 ? 'ipv4' : 'ipv6');
}

/** What's in force: {enabled, allowed, fromEnv}. */
function current() {
  const env = process.env.ALLOWED_NETWORKS;
  if (env !== undefined && env.trim() !== '') {
    if (/^(any|all|off|\*)$/i.test(env.trim())) return { enabled: false, allowed: [], fromEnv: true };
    return { enabled: true, allowed: normalizeList(env), fromEnv: true };
  }
  const s = (store.getSettings().network || {});
  return { enabled: Boolean(s.enabled), allowed: Array.isArray(s.allowed) ? s.allowed : [], fromEnv: false };
}

// The compiled list, rebuilt when what's in force changes.
let cache = { key: null, list: null };
function compiled(cfg) {
  const key = JSON.stringify(cfg);
  if (cache.key !== key) cache = { key, list: compile(cfg.allowed) };
  return cache.list;
}

/** The address a request is judged by: the connection's, or (TRUST_PROXY) the proxy's forwarded one. */
function clientAddress(req) {
  return plain(process.env.TRUST_PROXY ? req.ip : req.socket && req.socket.remoteAddress);
}

/** Express middleware: a request from outside the list gets a 403 and nothing else. */
function middleware(req, res, next) {
  const cfg = current();
  if (!cfg.enabled) return next();
  const a = clientAddress(req);
  const family = net.isIP(a);
  if (family && compiled(cfg).check(a, family === 4 ? 'ipv4' : 'ipv6')) return next();
  res.status(403).type('text/plain').send('Not allowed from this network.\n');
}

/**
 * Saves {enabled, allowed} from the admin UI, refusing a list that would shut
 * out the address it's saved from (`from`).
 */
function save(body, from) {
  if (current().fromEnv) throw Object.assign(new Error('ALLOWED_NETWORKS is set on the server, so the list comes from there; change or remove it to edit here.'), { status: 409 });
  const b = body || {};
  const allowed = normalizeList(b.allowed);
  const enabled = Boolean(b.enabled);
  if (enabled && !allowed.length) throw Object.assign(new Error('Add at least one network, or switch this off.'), { status: 400 });
  if (enabled && !allows(allowed, from)) {
    throw Object.assign(new Error(`That list doesn't include your address (${plain(from)}), so it would shut you out. Add it, or a range with it, first.`), { status: 400 });
  }
  const s = store.getSettings();
  store.saveSettings({ ...s, network: { enabled, allowed } });
  return current();
}

module.exports = { PRIVATE, parseEntry, normalizeList, allows, current, clientAddress, middleware, save };
