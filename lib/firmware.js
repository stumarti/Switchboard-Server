'use strict';

/**
 * Over-the-air updates: the builds this server holds, which one each kind of
 * device should run, and who gets it when.
 *
 * Boards. Every build is for one board (a kind of device: "x4pro", the X4
 * Pro remote, or any other a firmware repository builds for), named inside
 * the image as "SWITCHBOARD_FW:<board>:<version>". Every device says its
 * board (X-Board on its requests). A device is only ever offered a build for
 * its own board, and each board has its own release, stage and "Update now".
 * Builds and remotes from before boards (a marker with just a version, no
 * X-Board) are "x4pro", the one board there was.
 *
 * Safety, since one release reaches every device of its board:
 *   - Off until switched on (settings.enabled).
 *   - A build is only accepted if it's a Switchboard app image for an ESP32
 *     chip: the image and app-descriptor magic numbers, a size that fits the
 *     OTA slot, and the marker the firmware embeds. Its board and version
 *     come from that marker, never from what someone typed.
 *   - Staged: a release goes to the pilot remotes first; everyone only after
 *     someone promotes it (stage "everyone").
 *   - The remote checks the SHA-256 before switching, needs enough battery,
 *     and rolls back by itself if the new firmware can't reach this server
 *     on its first run (the firmware's ota_update.h).
 *   - Remotes report each attempt (report()), so a failing release shows on
 *     the Remote updates page and the Home page.
 *
 * Files: <DATA_DIR>/firmware/<board>-<version>.bin (<version>.bin for the
 * x4pro builds from before boards), plus firmware.json (settings, the build
 * list and the last report from each device).
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
// esp_image_header_t chip ids this accepts (what the board is, the marker says).
const CHIPS = { 0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6', 16: 'ESP32-H2' };
const MARKER = Buffer.from('SWITCHBOARD_FW:');
const BOARD_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
// The board of every build and remote from before boards had names.
const LEGACY_BOARD = 'x4pro';
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DEFAULT_REPO = 'stumarti/Switchboard';
// The wall displays' firmware (board e1002), listed from the start too.
const VIEWPORT_REPO = 'stumarti/Switchboard-Viewport';

function defaults() {
  return {
    settings: {
      enabled: false,
      // Per board: {release (the version its devices should run), stage
      // (pilot | everyone), updateNow}.
      boards: {},
      pilot: [], // MACs that get a release first (of their board)
      button: true, // Settings -> Firmware update on the remote
      schedule: { enabled: false, fromHour: 2, toHour: 5 }, // local time, on a timer wake
      minBattery: 30,
      // GitHub repositories whose releases can be added as builds (by a
      // button press only): the Switchboard firmware, and any of your own
      // (a fork). The first is the one "Get latest release" uses.
      // (A board's updateNow, from the Home page: {version, at, tried: [mac]}.
      // Every device offered that version installs it at its next wake,
      // whatever the schedule, until it reports an attempt; then it's in
      // `tried`. Cleared by a new release for the board.)
      repos: [DEFAULT_REPO, VIEWPORT_REPO],
      viewportRepoAdded: true
    },
    builds: [], // {board, version, chip, sha256, size, file, addedAt, source}
    reports: {} // mac -> {version, ok, error, at, from}
  };
}

function load() {
  const d = store.readJsonFile(INDEX, defaults);
  const base = defaults();
  const settings = { ...base.settings, ...(d.settings || {}), schedule: { ...base.settings.schedule, ...((d.settings && d.settings.schedule) || {}) } };
  // Settings from before there was a list had one `repo`.
  if (!Array.isArray((d.settings || {}).repos)) settings.repos = d.settings && d.settings.repo ? [d.settings.repo] : base.settings.repos;
  delete settings.repo;
  // A list saved before viewports had firmware gets its repository once
  // (and not again if someone removes it later).
  if (!settings.viewportRepoAdded) {
    if (!settings.repos.some((r) => r.toLowerCase() === VIEWPORT_REPO.toLowerCase()) && settings.repos.length < MAX_REPOS) settings.repos = [...settings.repos, VIEWPORT_REPO];
    settings.viewportRepoAdded = true;
  }
  // Settings from before boards had one release, for the one board there was.
  if (!settings.boards) settings.boards = {};
  if (settings.release !== undefined || settings.stage !== undefined || settings.updateNow !== undefined) {
    if (!settings.boards[LEGACY_BOARD] && (settings.release || settings.updateNow)) {
      settings.boards[LEGACY_BOARD] = { release: settings.release || '', stage: settings.stage || 'pilot', updateNow: settings.updateNow || null };
    }
    delete settings.release;
    delete settings.stage;
    delete settings.updateNow;
  }
  // Builds from before boards: x4pro, in <version>.bin.
  const builds = (d.builds || []).map((b) => (b.board ? b : { ...b, board: LEGACY_BOARD, file: `${b.version}.bin` }));
  return { settings, builds, reports: d.reports || {} };
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_REPOS = 10;
// "https://github.com/owner/name(.git)" or "owner/name" -> "owner/name".
function repoName(v) {
  let r = String(v || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!REPO_RE.test(r) || r.includes('..')) {
    throw Object.assign(new Error(`${v || 'That'} isn't a GitHub repository: use owner/name, e.g. stumarti/Switchboard.`), { status: 400 });
  }
  return r;
}
// A repository from the list, or an error: releases are only read from repos
// someone added here.
function listedRepo(repo, d = load()) {
  const want = repo ? repoName(repo) : d.settings.repos[0];
  const hit = d.settings.repos.find((r) => r.toLowerCase() === String(want || '').toLowerCase());
  if (!hit) throw Object.assign(new Error(want ? `${want} isn't in the repository list.` : 'Add a GitHub repository first.'), { status: 400 });
  return hit;
}

function save(d) {
  fs.mkdirSync(DIR, { recursive: true });
  store.writeJsonAtomic(INDEX, d);
}

function imagePath(b) {
  if (!VERSION_RE.test(b.version) || !BOARD_RE.test(b.board)) throw Object.assign(new Error('bad build'), { status: 400 });
  return path.join(DIR, b.file || `${b.board}-${b.version}.bin`);
}

/** The board a device runs, or null: what it said (X-Board), else x4pro for a remote from before boards. */
function boardOf(device) {
  if (!device) return null;
  const said = device.health && device.health.board;
  if (said && BOARD_RE.test(said)) return said;
  return (device.type || 'remote') === 'remote' ? LEGACY_BOARD : null;
}

/** A board's release: {release, stage, updateNow}. */
function boardSettings(d, board) {
  return { release: '', stage: 'pilot', updateNow: null, ...((d.settings.boards || {})[board] || {}) };
}
function setBoard(d, board, patch) {
  d.settings.boards = { ...(d.settings.boards || {}), [board]: { ...boardSettings(d, board), ...patch } };
}

/**
 * Checks a firmware image and reads its version. Throws (status 400) with a
 * reason a person can act on.
 */
function inspect(buf) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!Buffer.isBuffer(buf) || buf.length < MIN_IMAGE) throw bad('That file is too small to be device firmware.');
  if (buf.length > MAX_IMAGE) throw bad(`That file is ${(buf.length / 1048576).toFixed(1)} MB; the update slot holds ${(MAX_IMAGE / 1048576).toFixed(2)} MB.`);
  // esp_image_header_t: magic 0xE9; chip_id (uint16) at byte 12.
  if (buf[0] !== 0xe9) throw bad('Not an ESP32 app image. Use the "app" build (switchboard-<board>-app-<version>.bin), not the full flasher image.');
  const chip = CHIPS[buf.readUInt16LE(12)];
  if (!chip) throw bad("That image is for a chip this server doesn't know.");
  // esp_app_desc_t follows the 24-byte header and the first 8-byte segment header.
  if (buf.readUInt32LE(32) !== 0xabcd5432) throw bad('That image has no app description; it may be damaged.');
  // The first marker with something after it: firmware can hold the bare
  // prefix too (its own copy, to check downloads with), which isn't it.
  let tail = '';
  for (let at = buf.indexOf(MARKER); at >= 0 && !tail; at = buf.indexOf(MARKER, at + 1)) {
    let end = at + MARKER.length;
    while (end < buf.length && end - at < 96 && buf[end] !== 0) end += 1;
    tail = buf.slice(at + MARKER.length, end).toString('latin1');
  }
  if (!tail) throw bad("That isn't Switchboard firmware (no Switchboard marker in it).");
  const { board, version } = parseMarker(tail);
  if (!BOARD_RE.test(board)) throw bad(`The firmware's board (${board || 'none'}) can't be used.`);
  if (!VERSION_RE.test(version)) throw bad(`The firmware's version (${version || 'none'}) can't be used.`);
  if (/-dirty$/.test(version)) throw bad(`${version} was built from uncommitted changes; release a tagged build instead.`);
  return { board, version, chip, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

// What follows "SWITCHBOARD_FW:": "<board>:<version>", or just "<version>"
// in builds from before boards (x4pro).
function parseMarker(text) {
  const i = text.indexOf(':');
  return i < 0 ? { board: LEGACY_BOARD, version: text } : { board: text.slice(0, i), version: text.slice(i + 1) };
}

/** Adds a build (checked by inspect()); the same board and version again replaces it. */
function addBuild(buf, source) {
  const info = inspect(buf);
  const d = load();
  const old = d.builds.find((b) => b.board === info.board && b.version === info.version);
  const entry = { ...info, file: `${info.board}-${info.version}.bin`, addedAt: new Date().toISOString(), source: String(source || 'upload').slice(0, 120) };
  fs.mkdirSync(DIR, { recursive: true });
  store.writeFileAtomic(imagePath(entry), buf);
  if (old && old.file && old.file !== entry.file) {
    try {
      fs.unlinkSync(imagePath(old));
    } catch {
      /* already gone */
    }
  }
  d.builds = d.builds.filter((b) => b !== old);
  d.builds.unshift(entry);
  save(d);
  return info;
}

function removeBuild(board, version) {
  const d = load();
  const b = d.builds.find((x) => x.board === board && x.version === version);
  if (!b) return;
  if (boardSettings(d, board).release === version) throw Object.assign(new Error('That build is the current release; choose another first.'), { status: 409 });
  d.builds = d.builds.filter((x) => x !== b);
  save(d);
  try {
    fs.unlinkSync(imagePath(b));
  } catch {
    /* already gone */
  }
}

function build(board, version) {
  return load().builds.find((b) => b.board === board && b.version === version) || null;
}

function readImage(board, version) {
  const b = build(board, version);
  if (!b) return null;
  try {
    return { build: b, file: imagePath(b) };
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
  // A board's release and stage: {board, release} / {board, stage}.
  if (b.release !== undefined || b.stage !== undefined) {
    const board = String(b.board || LEGACY_BOARD);
    if (!BOARD_RE.test(board)) throw Object.assign(new Error('No such board.'), { status: 400 });
    const cur = boardSettings(d, board);
    const next = {};
    if (b.release !== undefined) {
      const v = String(b.release || '');
      if (v && !d.builds.some((x) => x.board === board && x.version === v)) throw Object.assign(new Error('No such build.'), { status: 400 });
      // A new release starts again with the pilots (and not "now").
      if (v !== cur.release) Object.assign(next, { stage: 'pilot', updateNow: null });
      next.release = v;
    }
    if (b.stage !== undefined) next.stage = b.stage === 'everyone' ? 'everyone' : 'pilot';
    d.settings = s;
    setBoard(d, board, next);
    s.boards = d.settings.boards;
  }
  if (b.pilot !== undefined) s.pilot = (Array.isArray(b.pilot) ? b.pilot : []).map((m) => store.normalizeMac(String(m))).filter(Boolean).slice(0, 50);
  if (b.button !== undefined) s.button = Boolean(b.button);
  if (b.schedule !== undefined) {
    const x = b.schedule || {};
    s.schedule = { enabled: Boolean(x.enabled), fromHour: HOUR(x.fromHour, 2), toHour: HOUR(x.toHour, 5) };
  }
  if (b.minBattery !== undefined) s.minBattery = Math.min(Math.max(Number(b.minBattery) || 0, 10), 90);
  if (b.repos !== undefined) {
    const seen = new Set();
    s.repos = (Array.isArray(b.repos) ? b.repos : [])
      .map(repoName)
      .filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
    if (s.repos.length > MAX_REPOS) throw Object.assign(new Error(`Up to ${MAX_REPOS} repositories.`), { status: 400 });
  }
  d.settings = s;
  save(d);
  return s;
}

/**
 * What a device should install now, or null: its board's release, when
 * updates are on, the device is in that release's stage, and it isn't
 * already running it. (A release older than what a device runs is offered
 * too: that's how a bad release is rolled back everywhere.)
 */
function offerFor(mac, device, d = load(), stageOverride) {
  const s = d.settings;
  const board = boardOf(device);
  if (!s.enabled || !board) return null;
  const bs = boardSettings(d, board);
  if (!bs.release) return null;
  if ((stageOverride || bs.stage) !== 'everyone' && !s.pilot.includes(store.normalizeMac(mac))) return null;
  const b = d.builds.find((x) => x.board === board && x.version === bs.release);
  if (!b) return null;
  const running = device.health && device.health.firmware;
  // Firmware too old to say its version can't update itself either.
  if (!running || running === b.version) return null;
  return { board, version: b.version, size: b.size, sha256: b.sha256 };
}

/**
 * Whether a remote should install its offer at its next wake, whatever the
 * schedule: "Update now" was pressed for this release, and the remote hasn't
 * tried it since (a failure isn't retried every wake; press again for that).
 */
function nowFor(mac, device, d = load()) {
  const board = boardOf(device);
  if (!board) return false;
  const bs = boardSettings(d, board);
  const u = bs.updateNow;
  if (!u || u.version !== bs.release) return false;
  if (!offerFor(mac, device, d)) return false;
  return !(u.tried || []).includes(store.normalizeMac(mac));
}

/**
 * "Update now", for one board: every device offered its release installs
 * it at its next wake. `everyone` skips the pilot stage: the release goes
 * to every device of the board.
 */
function updateNow({ board = LEGACY_BOARD, everyone = false } = {}) {
  const d = load();
  if (!d.settings.enabled) throw Object.assign(new Error('Updates are off.'), { status: 400 });
  const bs = boardSettings(d, board);
  if (!bs.release) throw Object.assign(new Error('Choose a release first.'), { status: 400 });
  const updateNowState = { version: bs.release, at: new Date().toISOString(), tried: [] };
  setBoard(d, board, { updateNow: updateNowState, ...(everyone ? { stage: 'everyone' } : {}) });
  save(d);
  return updateNowState;
}

function cancelUpdateNow(board = LEGACY_BOARD) {
  const d = load();
  setBoard(d, board, { updateNow: null });
  save(d);
}

// The `firmware` block of a remote's config (lib/clients.js composes it in).
function configFor(mac, device) {
  const d = load();
  const s = d.settings;
  if (!s.enabled) return { enabled: false };
  return {
    enabled: true,
    offer: offerFor(mac, device, d),
    now: nowFor(mac, device, d),
    button: s.button,
    schedule: s.schedule.enabled ? { fromHour: s.schedule.fromHour, toHour: s.schedule.toHour } : null,
    minBattery: s.minBattery
  };
}

/** A device's account of an attempt: {version, ok, error, from}. `device`: as it is now (else as stored). */
function report(mac, body, device) {
  const d = load();
  const b = body || {};
  d.reports[store.normalizeMac(mac)] = {
    version: String(b.version || '').slice(0, 64),
    from: String(b.from || '').slice(0, 64),
    ok: Boolean(b.ok),
    error: String(b.error || '').slice(0, 160),
    at: new Date().toISOString()
  };
  // Tried since "Update now" for its board: it isn't asked again at every wake.
  const m = store.normalizeMac(mac);
  const board = boardOf(device || store.getDevices()[m]);
  const u = board && boardSettings(d, board).updateNow;
  if (u && u.version === d.reports[m].version && !(u.tried || []).includes(m)) setBoard(d, board, { updateNow: { ...u, tried: [...(u.tried || []), m] } });
  save(d);
}

// The devices that take part: approved, with a board (every remote; any
// other device that says its board).
function updatable(devices) {
  return Object.entries(devices || {}).filter(([, x]) => x && x.status === 'approved' && boardOf(x));
}

/** Per device: its board, what it runs, what it's offered, its last attempt. */
function status(devices) {
  const d = load();
  return updatable(devices).map(([mac, x]) => {
    const board = boardOf(x);
    const release = boardSettings(d, board).release;
    const offer = offerFor(mac, x, d);
    const running = (x.health && x.health.firmware) || '';
    const last = d.reports[mac] || null;
    let state = 'current';
    if (!running) state = 'unknown';
    else if (offer) state = last && !last.ok && last.version === offer.version ? 'failed' : 'pending';
    else if (release && running !== release) state = 'waiting'; // not in this stage yet
    else if (!release) state = 'none'; // nothing released for its board
    return { mac, name: x.name || mac, type: x.type || 'remote', board, running, offer: offer ? offer.version : '', pilot: d.settings.pilot.includes(mac), state, now: nowFor(mac, x, d), last };
  });
}

/** Every board this server knows: from builds, releases and devices, x4pro first. */
function boards(devices, d = load()) {
  const set = new Set([...d.builds.map((b) => b.board), ...Object.keys(d.settings.boards || {}), ...updatable(devices).map(([, x]) => boardOf(x))]);
  return [...set].sort((a, b) => (a === LEGACY_BOARD ? -1 : b === LEGACY_BOARD ? 1 : a.localeCompare(b)));
}

/**
 * For the Home page's "Update now", per board with a release: the release,
 * how many devices it's still to reach, what skipping the pilot would reach,
 * and, once pressed, how many are yet to install it.
 */
function summary(devices) {
  const d = load();
  if (!d.settings.enabled) return { enabled: false, boards: [] };
  const list = status(devices);
  const all = updatable(devices);
  return {
    enabled: true,
    boards: boards(devices, d)
      .map((board) => {
        const bs = boardSettings(d, board);
        if (!bs.release) return null;
        const mine = list.filter((r) => r.board === board);
        const now = bs.updateNow && bs.updateNow.version === bs.release ? bs.updateNow : null;
        return {
          board,
          release: bs.release,
          stage: bs.stage,
          pending: mine.filter((r) => r.offer).length,
          pendingEveryone: all.filter(([mac, x]) => boardOf(x) === board && offerFor(mac, x, d, 'everyone')).length,
          now: now ? { at: now.at, waiting: mine.filter((r) => r.now).length } : null
        };
      })
      .filter(Boolean)
  };
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

// A release's app images: switchboard-<board>-app-<version>.bin (one per
// board a repository builds), or switchboard-app-<version>.bin from before
// boards. Each needs its .sha256 beside it.
const APP_ASSET = /^switchboard-(?:([a-z0-9][a-z0-9-]{0,23})-)?app-(.+)\.bin$/;
function appAssets(release) {
  return (release.assets || [])
    .map((a) => ({ a, m: APP_ASSET.exec(a.name) }))
    .filter((x) => x.m)
    .map((x) => ({ asset: x.a, board: x.m[1] || '', sum: (release.assets || []).find((s) => s.name === `${x.a.name}.sha256`) }));
}

/** A listed repository's releases that carry an app image: [{repo, tag, name, date, prerelease, boards}]. */
async function githubReleases({ repo: which, fetchImpl } = {}) {
  const repo = listedRepo(which);
  const list = await gh(`https://api.github.com/repos/${repo}/releases?per_page=15`, fetchImpl);
  return (Array.isArray(list) ? list : [])
    .filter((r) => !r.draft && appAssets(r).length)
    .map((r) => ({ repo, tag: r.tag_name, name: r.name || r.tag_name, date: r.published_at, prerelease: Boolean(r.prerelease), boards: appAssets(r).map((x) => x.board || LEGACY_BOARD) }));
}

/**
 * Downloads each of a release's app images (one per board) and its .sha256,
 * checks one against the other and the image itself (the tag, and the board
 * the file name says), and adds them as builds. Returns the builds added.
 */
async function importRelease(tag, { repo: which, fetchImpl } = {}) {
  const repo = listedRepo(which);
  const r = await gh(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, fetchImpl);
  const apps = appAssets(r).filter((x) => x.sum);
  if (!apps.length) throw Object.assign(new Error(`Release ${tag} has no app image with a checksum (switchboard-<board>-app-*.bin + .sha256).`), { status: 400 });
  const checked = [];
  for (const { asset, board, sum } of apps) {
    const [buf, sumText] = await Promise.all([gh(asset.browser_download_url, fetchImpl, true), gh(sum.browser_download_url, fetchImpl, true)]);
    const want = sumText.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (want !== got) throw Object.assign(new Error(`${asset.name} doesn't match its published checksum; nothing added.`), { status: 502 });
    const info = inspect(buf);
    if (info.version !== tag) throw Object.assign(new Error(`Release ${tag} contains firmware ${info.version}; nothing added.`), { status: 400 });
    if (board && info.board !== board) throw Object.assign(new Error(`${asset.name} is firmware for ${info.board}; nothing added.`), { status: 400 });
    checked.push(buf);
  }
  // All or nothing: every image checked before any is added.
  return checked.map((buf) => addBuild(buf, `github:${repo}@${tag}`));
}

/**
 * The newest release (a full release over a pre-release) of each listed
 * repository, or just `repo`, added as builds where they aren't yet:
 * [{repo, version, boards, added}]. A repository GitHub can't answer for
 * is reported, not fatal: [{repo, error}].
 */
async function importLatest(opts = {}) {
  const d = load();
  const repos = opts.repo ? [listedRepo(opts.repo, d)] : d.settings.repos;
  if (!repos.length) throw Object.assign(new Error('Add a GitHub repository first.'), { status: 400 });
  const out = [];
  for (const repo of repos) {
    try {
      const list = await githubReleases({ ...opts, repo });
      const pick = list.find((r) => !r.prerelease) || list[0];
      if (!pick) {
        out.push({ repo, error: 'no releases with an app image yet' });
        continue;
      }
      const have = pick.boards.every((b) => build(b, pick.tag));
      if (have) out.push({ repo, version: pick.tag, boards: pick.boards, added: false });
      else {
        const added = await importRelease(pick.tag, { ...opts, repo });
        out.push({ repo, version: pick.tag, boards: added.map((b) => b.board), added: true });
      }
    } catch (e) {
      if (opts.repo) throw e;
      out.push({ repo, error: e.message });
    }
  }
  return out;
}

function overview(devices = {}) {
  const d = load();
  return { settings: d.settings, builds: d.builds, boards: boards(devices, d), legacyBoard: LEGACY_BOARD };
}

module.exports = {
  MAX_IMAGE,
  LEGACY_BOARD,
  boardOf,
  inspect,
  addBuild,
  removeBuild,
  build,
  readImage,
  updateSettings,
  offerFor,
  nowFor,
  updateNow,
  cancelUpdateNow,
  summary,
  configFor,
  report,
  status,
  overview,
  githubReleases,
  importRelease,
  importLatest
};
