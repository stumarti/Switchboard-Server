'use strict';

/**
 * Over-the-air updates for remotes: the builds this server holds, which one
 * remotes should run, and who gets it when.
 *
 * Safety, since one release reaches every remote:
 *   - Off until switched on (settings.enabled).
 *   - A build is only accepted if it's a Switchboard remote image for the
 *     ESP32-S3: the image and app-descriptor magic numbers, the chip id, a
 *     size that fits the OTA slot, and the "SWITCHBOARD_FW:<version>" marker
 *     the firmware embeds. Its version comes from that marker, never from
 *     what someone typed.
 *   - Staged: a release goes to the pilot remotes first; everyone only after
 *     someone promotes it (stage "everyone").
 *   - The remote checks the SHA-256 before switching, needs enough battery,
 *     and rolls back by itself if the new firmware can't reach this server
 *     on its first run (the firmware's ota_update.h).
 *   - Remotes report each attempt (report()), so a failing release shows on
 *     the Remote updates page and the Home page.
 *
 * Files: <DATA_DIR>/firmware/<version>.bin, plus firmware.json (settings,
 * the build list and the last report from each remote).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const DIR = path.join(store.DATA_DIR, 'firmware');
const INDEX = path.join(DIR, 'firmware.json');
// The OTA slot in default_16MB.csv (app0/app1: 0x640000 bytes each).
const MAX_IMAGE = 0x640000;
const MIN_IMAGE = 64 * 1024;
const ESP32S3_CHIP_ID = 9;
const MARKER = Buffer.from('SWITCHBOARD_FW:');
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DEFAULT_REPO = 'stumarti/Switchboard';

function defaults() {
  return {
    settings: {
      enabled: false,
      release: '', // the version remotes should run
      stage: 'pilot', // pilot | everyone
      pilot: [], // MACs that get a release first
      button: true, // Settings -> Firmware update on the remote
      schedule: { enabled: false, fromHour: 2, toHour: 5 }, // local time, on a timer wake
      minBattery: 30,
      repo: DEFAULT_REPO
    },
    builds: [], // {version, sha256, size, addedAt, source}
    reports: {} // mac -> {version, ok, error, at, from}
  };
}

function load() {
  const d = store.readJsonFile(INDEX, defaults);
  const base = defaults();
  return { settings: { ...base.settings, ...(d.settings || {}), schedule: { ...base.settings.schedule, ...((d.settings && d.settings.schedule) || {}) } }, builds: d.builds || [], reports: d.reports || {} };
}

function save(d) {
  fs.mkdirSync(DIR, { recursive: true });
  store.writeJsonAtomic(INDEX, d);
}

function imagePath(version) {
  if (!VERSION_RE.test(version)) throw Object.assign(new Error('bad version'), { status: 400 });
  return path.join(DIR, `${version}.bin`);
}

/**
 * Checks a firmware image and reads its version. Throws (status 400) with a
 * reason a person can act on.
 */
function inspect(buf) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!Buffer.isBuffer(buf) || buf.length < MIN_IMAGE) throw bad('That file is too small to be remote firmware.');
  if (buf.length > MAX_IMAGE) throw bad(`That file is ${(buf.length / 1048576).toFixed(1)} MB; the remote's update slot holds ${(MAX_IMAGE / 1048576).toFixed(2)} MB.`);
  // esp_image_header_t: magic 0xE9; chip_id (uint16) at byte 12.
  if (buf[0] !== 0xe9) throw bad('Not an ESP32 app image. Use the "app" build (switchboard-app-<version>.bin), not the full flasher image.');
  if (buf.readUInt16LE(12) !== ESP32S3_CHIP_ID) throw bad('That image is for a different chip; remotes are ESP32-S3.');
  // esp_app_desc_t follows the 24-byte header and the first 8-byte segment header.
  if (buf.readUInt32LE(32) !== 0xabcd5432) throw bad('That image has no app description; it may be damaged.');
  const at = buf.indexOf(MARKER);
  if (at < 0) throw bad("That isn't Switchboard remote firmware (no Switchboard version marker in it).");
  let end = at + MARKER.length;
  while (end < buf.length && end - at < 96 && buf[end] !== 0) end += 1;
  const version = buf.slice(at + MARKER.length, end).toString('latin1');
  if (!VERSION_RE.test(version)) throw bad(`The firmware's version (${version || 'none'}) can't be used.`);
  if (/-dirty$/.test(version)) throw bad(`${version} was built from uncommitted changes; release a tagged build instead.`);
  return { version, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Adds a build (checked by inspect()); the same version again replaces it. */
function addBuild(buf, source) {
  const info = inspect(buf);
  fs.mkdirSync(DIR, { recursive: true });
  store.writeFileAtomic(imagePath(info.version), buf);
  const d = load();
  d.builds = d.builds.filter((b) => b.version !== info.version);
  d.builds.unshift({ ...info, addedAt: new Date().toISOString(), source: String(source || 'upload').slice(0, 120) });
  save(d);
  return info;
}

function removeBuild(version) {
  const d = load();
  if (d.settings.release === version) throw Object.assign(new Error('That build is the current release; choose another first.'), { status: 409 });
  d.builds = d.builds.filter((b) => b.version !== version);
  save(d);
  try {
    fs.unlinkSync(imagePath(version));
  } catch {
    /* already gone */
  }
}

function build(version) {
  return load().builds.find((b) => b.version === version) || null;
}

function readImage(version) {
  const b = build(version);
  if (!b) return null;
  try {
    return { build: b, file: imagePath(version) };
  } catch {
    return null;
  }
}

const HOUR = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : d);

function updateSettings(body) {
  const d = load();
  const b = body || {};
  const s = { ...d.settings };
  if (b.enabled !== undefined) s.enabled = Boolean(b.enabled);
  if (b.release !== undefined) {
    const v = String(b.release || '');
    if (v && !d.builds.some((x) => x.version === v)) throw Object.assign(new Error('No such build.'), { status: 400 });
    // A new release starts again with the pilot remotes.
    if (v !== s.release) s.stage = 'pilot';
    s.release = v;
  }
  if (b.stage !== undefined) s.stage = b.stage === 'everyone' ? 'everyone' : 'pilot';
  if (b.pilot !== undefined) s.pilot = (Array.isArray(b.pilot) ? b.pilot : []).map((m) => store.normalizeMac(String(m))).filter(Boolean).slice(0, 50);
  if (b.button !== undefined) s.button = Boolean(b.button);
  if (b.schedule !== undefined) {
    const x = b.schedule || {};
    s.schedule = { enabled: Boolean(x.enabled), fromHour: HOUR(x.fromHour, 2), toHour: HOUR(x.toHour, 5) };
  }
  if (b.minBattery !== undefined) s.minBattery = Math.min(Math.max(Number(b.minBattery) || 0, 10), 90);
  if (b.repo !== undefined) {
    const r = String(b.repo || '').trim();
    if (r && !/^[\w.-]+\/[\w.-]+$/.test(r)) throw Object.assign(new Error('The repository is owner/name, e.g. stumarti/Switchboard.'), { status: 400 });
    s.repo = r || DEFAULT_REPO;
  }
  d.settings = s;
  save(d);
  return s;
}

/**
 * What a remote should install now, or null: the release, when updates are
 * on, this remote is in the current stage, and it isn't already running it.
 * (A release older than what a remote runs is offered too: that's how a bad
 * release is rolled back everywhere.)
 */
function offerFor(mac, device, d = load()) {
  const s = d.settings;
  if (!s.enabled || !s.release || !device || (device.type && device.type !== 'remote')) return null;
  if (s.stage !== 'everyone' && !s.pilot.includes(store.normalizeMac(mac))) return null;
  const b = d.builds.find((x) => x.version === s.release);
  if (!b) return null;
  const running = device.health && device.health.firmware;
  // Firmware too old to say its version can't update itself either.
  if (!running || running === b.version) return null;
  return { version: b.version, size: b.size, sha256: b.sha256 };
}

// The `firmware` block of a remote's config (lib/clients.js composes it in).
function configFor(mac, device) {
  const d = load();
  const s = d.settings;
  if (!s.enabled) return { enabled: false };
  return {
    enabled: true,
    offer: offerFor(mac, device, d),
    button: s.button,
    schedule: s.schedule.enabled ? { fromHour: s.schedule.fromHour, toHour: s.schedule.toHour } : null,
    minBattery: s.minBattery
  };
}

/** A remote's account of an attempt: {version, ok, error, from}. */
function report(mac, body) {
  const d = load();
  const b = body || {};
  d.reports[store.normalizeMac(mac)] = {
    version: String(b.version || '').slice(0, 64),
    from: String(b.from || '').slice(0, 64),
    ok: Boolean(b.ok),
    error: String(b.error || '').slice(0, 160),
    at: new Date().toISOString()
  };
  save(d);
}

/** Per remote: what it runs, what it's offered, its last attempt. */
function status(devices) {
  const d = load();
  return Object.entries(devices || {})
    .filter(([, x]) => x && (x.type || 'remote') === 'remote' && x.status === 'approved')
    .map(([mac, x]) => {
      const offer = offerFor(mac, x, d);
      const running = (x.health && x.health.firmware) || '';
      const last = d.reports[mac] || null;
      let state = 'current';
      if (!running) state = 'unknown';
      else if (offer) state = last && !last.ok && last.version === offer.version ? 'failed' : 'pending';
      else if (d.settings.release && running !== d.settings.release) state = 'waiting'; // not in this stage yet
      return { mac, name: x.name || mac, running, offer: offer ? offer.version : '', pilot: d.settings.pilot.includes(mac), state, last };
    });
}

// --- GitHub releases (what the firmware repo's release workflow publishes) ----

const GH_TIMEOUT_MS = 20000;
async function gh(url, fetchImpl = fetch, asBuffer = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Switchboard', Accept: asBuffer ? 'application/octet-stream' : 'application/vnd.github+json' } });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests from this server; try again in an hour, or upload the file instead');
    if (res.status === 404) throw new Error("GitHub doesn't know that repository or release (a private repository can't be read from here; upload the file instead)");
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'GitHub took too long to answer' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

const APP_ASSET = /^switchboard-app-(.+)\.bin$/;

/** The firmware repo's releases that carry an app image: [{tag, name, date, prerelease}]. */
async function githubReleases({ fetchImpl } = {}) {
  const repo = load().settings.repo || DEFAULT_REPO;
  const list = await gh(`https://api.github.com/repos/${repo}/releases?per_page=15`, fetchImpl);
  return (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft && (r.assets || []).some((a) => APP_ASSET.test(a.name)))
    .map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, date: r.published_at, prerelease: Boolean(r.prerelease) }));
}

/**
 * Downloads a release's app image and its .sha256, checks one against the
 * other and the image itself, and adds it as a build.
 */
async function importRelease(tag, { fetchImpl } = {}) {
  const repo = load().settings.repo || DEFAULT_REPO;
  const r = await gh(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, fetchImpl);
  const bin = (r.assets || []).find((a) => APP_ASSET.test(a.name));
  const sum = bin && (r.assets || []).find((a) => a.name === `${bin.name}.sha256`);
  if (!bin || !sum) throw Object.assign(new Error(`Release ${tag} has no app image with a checksum (switchboard-app-*.bin + .sha256).`), { status: 400 });
  const [buf, sumText] = await Promise.all([gh(bin.browser_download_url, fetchImpl, true), gh(sum.browser_download_url, fetchImpl, true)]);
  const want = sumText.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (want !== got) throw Object.assign(new Error(`The download doesn't match its published checksum (${tag}); not added.`), { status: 502 });
  const info = inspect(buf);
  if (info.version !== tag) throw Object.assign(new Error(`Release ${tag} contains firmware ${info.version}; not added.`), { status: 400 });
  return addBuild(buf, `github:${repo}@${tag}`);
}

/**
 * The newest GitHub release (a full release over a pre-release), added as a
 * build if it isn't one yet: {version, added}.
 */
async function importLatest(opts = {}) {
  const list = await githubReleases(opts);
  const pick = list.find((r) => !r.prerelease) || list[0];
  if (!pick) throw Object.assign(new Error('The firmware repository has no releases with an app image yet.'), { status: 404 });
  if (build(pick.tag)) return { version: pick.tag, added: false };
  const b = await importRelease(pick.tag, opts);
  return { version: b.version, added: true };
}

function overview() {
  const d = load();
  return { settings: d.settings, builds: d.builds };
}

module.exports = {
  MAX_IMAGE,
  inspect,
  addBuild,
  removeBuild,
  build,
  readImage,
  updateSettings,
  offerFor,
  configFor,
  report,
  status,
  overview,
  githubReleases,
  importRelease,
  importLatest
};
