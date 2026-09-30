'use strict';

// node --test: over-the-air updates (lib/firmware.js) — which images are
// accepted, for which board; who is offered what (each board its own
// release; pilots first, then everyone); GitHub imports checked against
// their checksum; "Update now"; and devices' reports.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fw-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const firmware = require('../lib/firmware');

// A minimal image that passes inspect(): ESP32 app magic, a chip id, the
// app-descriptor magic and the Switchboard marker ("<board>:<version>", or
// just the version, as builds from before boards had).
function image(version, { board = 'x4pro', size = 200 * 1024, chip = 9, marker = true, legacy = false } = {}) {
  const b = Buffer.alloc(size, 0xff);
  b[0] = 0xe9;
  b.writeUInt16LE(chip, 12);
  b.writeUInt32LE(0xabcd5432, 32);
  // (Newer firmware also holds the bare prefix, ahead of its marker.)
  if (marker) {
    b.write('SWITCHBOARD_FW:\0', 2048, 'latin1');
    b.write(`SWITCHBOARD_FW:${legacy ? '' : `${board}:`}${version}\0`, 4096, 'latin1');
  }
  return b;
}

const PILOT = 'aa:00:00:00:00:01';
const OTHER = 'aa:00:00:00:00:02';
const STICKY = 'aa:00:00:00:00:03';
const remote = (fw, board) => ({ type: 'remote', status: 'approved', name: 'R', health: { firmware: fw, ...(board ? { board } : {}) } });

test('firmware: Switchboard ESP32 app images, with their board and version from the marker', () => {
  assert.deepEqual([firmware.inspect(image('v0.2.0')).board, firmware.inspect(image('v0.2.0')).version], ['x4pro', 'v0.2.0']);
  assert.equal(firmware.inspect(image('v1.0.0', { board: 'sticky', chip: 5 })).board, 'sticky');
  assert.equal(firmware.inspect(image('v1.0.0', { board: 'sticky', chip: 5 })).chip, 'ESP32-C3');
  assert.equal(firmware.inspect(image('v0.1.9', { legacy: true })).board, 'x4pro'); // from before boards
  assert.throws(() => firmware.inspect(Buffer.alloc(100)), /too small/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { chip: 99 })), /chip this server doesn't know/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { marker: false })), /isn't Switchboard/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { board: 'Bad Board' })), /board/);
  assert.throws(() => firmware.inspect(image('v0.2.0-dirty')), /uncommitted/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { size: firmware.MAX_IMAGE + 1 })), /update slot/);
  const merged = image('v0.2.0');
  merged[0] = 0x00;
  assert.throws(() => firmware.inspect(merged), /full flasher image/);
});

test('firmware: off by default; each board its own release, pilots first, everyone once promoted', () => {
  assert.deepEqual(firmware.configFor(PILOT, remote('v0.1.0')), { enabled: false });
  const b = firmware.addBuild(image('v0.2.0'), 'upload');
  assert.equal(b.sha256.length, 64);
  firmware.addBuild(image('v0.2.0', { board: 'sticky' }), 'upload'); // same version, another board: both kept
  assert.equal(firmware.overview().builds.length, 2);
  firmware.updateSettings({ enabled: true, board: 'x4pro', release: 'v0.2.0', pilot: [PILOT] });

  assert.equal(firmware.offerFor(PILOT, remote('v0.1.0')).version, 'v0.2.0');
  assert.equal(firmware.offerFor(PILOT, remote('v0.1.0')).board, 'x4pro');
  assert.equal(firmware.offerFor(OTHER, remote('v0.1.0')), null); // not a pilot
  assert.equal(firmware.offerFor(PILOT, remote('v0.2.0')), null); // already on it
  assert.equal(firmware.offerFor(PILOT, remote(undefined)), null); // too old to update itself
  // A viewport, or any device, only with a board of its own.
  assert.equal(firmware.offerFor(PILOT, { ...remote('v0.1.0'), type: 'viewport' }), null);
  assert.equal(firmware.offerFor(PILOT, remote('v0.1.0', 'sticky')), null); // sticky has no release yet

  firmware.updateSettings({ board: 'x4pro', stage: 'everyone' });
  assert.equal(firmware.offerFor(OTHER, remote('v0.1.0')).version, 'v0.2.0');
  // The sticky's own release: only sticky devices get it, pilots first.
  firmware.updateSettings({ board: 'sticky', release: 'v0.2.0', pilot: [PILOT, STICKY] });
  assert.equal(firmware.offerFor(STICKY, remote('v0.1.0', 'sticky')).board, 'sticky');
  assert.equal(firmware.offerFor(STICKY, { ...remote('v0.1.0', 'sticky'), type: 'viewport' }).board, 'sticky');
  assert.equal(firmware.overview().settings.boards.x4pro.stage, 'everyone'); // the x4pro's stage untouched

  // A new release starts again with the pilots; an older one rolls back.
  firmware.addBuild(image('v0.1.0'), 'upload');
  firmware.updateSettings({ board: 'x4pro', release: 'v0.1.0' });
  assert.equal(firmware.overview().settings.boards.x4pro.stage, 'pilot');
  assert.equal(firmware.offerFor(PILOT, remote('v0.2.0')).version, 'v0.1.0');

  const cfg = firmware.configFor(PILOT, remote('v0.2.0'));
  assert.deepEqual([cfg.enabled, cfg.button, cfg.schedule, cfg.minBattery], [true, true, null, 30]);
  firmware.updateSettings({ schedule: { enabled: true, fromHour: 1, toHour: 4 } });
  assert.deepEqual(firmware.configFor(PILOT, remote('v0.2.0')).schedule, { fromHour: 1, toHour: 4 });

  assert.throws(() => firmware.removeBuild('x4pro', 'v0.1.0'), /current release/);
  assert.throws(() => firmware.updateSettings({ board: 'x4pro', release: 'v9.9.9' }), /No such build/);
  assert.throws(() => firmware.updateSettings({ board: 'sticky', release: 'v0.1.0' }), /No such build/); // an x4pro build
  assert.ok(firmware.readImage('sticky', 'v0.2.0').file.endsWith('sticky-v0.2.0.bin'));
  assert.deepEqual(firmware.overview().boards, ['x4pro', 'sticky']);
});

test('firmware: settings and builds from before boards are the x4pro', () => {
  const dir = path.join(process.env.DATA_DIR, 'firmware');
  const index = path.join(dir, 'firmware.json');
  const saved = fs.readFileSync(index, 'utf8');
  fs.writeFileSync(path.join(dir, 'v0.0.9.bin'), image('v0.0.9', { legacy: true }));
  fs.writeFileSync(index, JSON.stringify({
    settings: { enabled: true, release: 'v0.0.9', stage: 'everyone', pilot: [], updateNow: null },
    builds: [{ version: 'v0.0.9', sha256: 'x'.repeat(64), size: 1 }],
    reports: {}
  }));
  const o = firmware.overview();
  assert.deepEqual(o.settings.boards.x4pro, { release: 'v0.0.9', stage: 'everyone', updateNow: null });
  assert.equal(o.settings.release, undefined);
  assert.equal(o.builds[0].board, 'x4pro');
  assert.ok(firmware.readImage('x4pro', 'v0.0.9').file.endsWith(`${path.sep}v0.0.9.bin`)); // still in its old file
  assert.equal(firmware.offerFor(OTHER, remote('v0.0.8')).version, 'v0.0.9'); // a remote with no X-Board
  fs.writeFileSync(index, saved);
});

test('firmware: reports show which devices failed', () => {
  firmware.updateSettings({ board: 'x4pro', release: 'v0.2.0', stage: 'everyone' });
  firmware.report(PILOT, { version: 'v0.2.0', from: 'v0.1.0', ok: false, error: 'checksum mismatch' });
  const st = firmware.status({ [PILOT]: remote('v0.1.0'), [OTHER]: remote('v0.2.0'), [STICKY]: remote('v0.2.0', 'sticky') });
  assert.deepEqual(st.map((r) => [r.mac, r.board, r.state]), [[PILOT, 'x4pro', 'failed'], [OTHER, 'x4pro', 'current'], [STICKY, 'sticky', 'current']]);
  assert.equal(st[0].last.error, 'checksum mismatch');
});

test('firmware: a GitHub release adds a build per board, each matching its checksum, tag and board', async () => {
  const x4 = image('v0.3.0');
  const st = image('v0.3.0', { board: 'sticky' });
  const sum = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const release = (assets) => ({ tag_name: 'v0.3.0', assets });
  const asset = (name, url) => ({ name, browser_download_url: url });
  const fake = (rel, files) => async (url) => ({
    ok: true,
    status: 200,
    json: async () => rel,
    arrayBuffer: async () => files[url]
  });
  const both = release([
    asset('switchboard-x4pro-app-v0.3.0.bin', 'x'), asset('switchboard-x4pro-app-v0.3.0.bin.sha256', 'xs'),
    asset('switchboard-sticky-app-v0.3.0.bin', 's'), asset('switchboard-sticky-app-v0.3.0.bin.sha256', 'ss')
  ]);
  const files = { x: x4, xs: Buffer.from(`${sum(x4)}  a\n`), s: st, ss: Buffer.from(`${sum(st)}  b\n`) };

  // One bad checksum: nothing at all is added.
  await assert.rejects(firmware.importRelease('v0.3.0', { fetchImpl: fake(both, { ...files, ss: Buffer.from('0'.repeat(64)) }) }), /checksum/);
  assert.equal(firmware.build('x4pro', 'v0.3.0'), null);
  // A file named for one board holding another's firmware.
  await assert.rejects(firmware.importRelease('v0.3.0', { fetchImpl: fake(both, { ...files, s: x4, ss: files.xs }) }), /is firmware for x4pro/);
  const other = image('v0.2.9');
  await assert.rejects(firmware.importRelease('v0.3.0', { fetchImpl: fake(both, { ...files, x: other, xs: Buffer.from(sum(other)) }) }), /contains firmware v0.2.9/);

  const added = await firmware.importRelease('v0.3.0', { fetchImpl: fake(both, files) });
  assert.deepEqual(added.map((b) => b.board).sort(), ['sticky', 'x4pro']);
  assert.equal(firmware.build('sticky', 'v0.3.0').source, 'github:stumarti/Switchboard@v0.3.0');

  // A release from before boards: switchboard-app-<version>.bin, the x4pro.
  const old = image('v0.3.1', { legacy: true });
  const oldRel = { tag_name: 'v0.3.1', assets: [asset('switchboard-app-v0.3.1.bin', 'o'), asset('switchboard-app-v0.3.1.bin.sha256', 'os')] };
  const [ob] = await firmware.importRelease('v0.3.1', { fetchImpl: fake(oldRel, { o: old, os: Buffer.from(sum(old)) }) });
  assert.equal(ob.board, 'x4pro');
});

test('firmware: your own GitHub repositories — listed, tidied, the only ones read; "latest" checks each', async () => {
  const s = firmware.updateSettings({ repos: ['https://github.com/me/Sticky-firmware.git', 'stumarti/Switchboard', 'ME/sticky-firmware'] });
  assert.deepEqual(s.repos, ['me/Sticky-firmware', 'stumarti/Switchboard']); // URL tidied, duplicate dropped
  assert.throws(() => firmware.updateSettings({ repos: ['not a repo'] }), /isn't a GitHub repository/);
  assert.throws(() => firmware.updateSettings({ repos: ['../../etc/passwd'] }), /isn't a GitHub repository/);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [{ tag_name: 'v0.3.0', published_at: '2026-09-01T00:00:00Z', assets: [{ name: 'switchboard-sticky-app-v0.3.0.bin' }] }] };
  };
  const list = await firmware.githubReleases({ repo: 'stumarti/Switchboard', fetchImpl });
  assert.deepEqual([list[0].repo, list[0].boards], ['stumarti/Switchboard', ['sticky']]);
  await firmware.githubReleases({ fetchImpl }); // no repo: the first in the list
  assert.match(calls[1], /repos\/me\/Sticky-firmware\/releases/);
  await assert.rejects(firmware.githubReleases({ repo: 'someone/else', fetchImpl }), /isn't in the repository list/);
  assert.equal(calls.length, 2); // never asked GitHub about an unlisted repository

  // "Get latest": every listed repository; already here, so nothing new.
  const latest = await firmware.importLatest({ fetchImpl });
  assert.deepEqual(latest.map((r) => [r.repo, r.version, r.added]), [['me/Sticky-firmware', 'v0.3.0', false], ['stumarti/Switchboard', 'v0.3.0', false]]);

  firmware.updateSettings({ repos: [] });
  await assert.rejects(firmware.importLatest({ fetchImpl }), /Add a GitHub repository first/);
  firmware.updateSettings({ repos: ['stumarti/Switchboard'] });
});

test('firmware: "update now", per board — every device due its release, at its next wake, until it has tried', () => {
  firmware.updateSettings({ enabled: true, board: 'x4pro', release: 'v0.2.0', stage: 'everyone', schedule: { enabled: false } });
  firmware.updateSettings({ board: 'sticky', release: 'v0.2.0', stage: 'everyone' });
  const devices = { [PILOT]: { ...remote('v0.1.0'), mac: PILOT }, [OTHER]: { ...remote('v0.2.0'), mac: OTHER }, [STICKY]: { ...remote('v0.1.0', 'sticky'), mac: STICKY } };
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, false); // not pressed yet
  const x4 = () => firmware.summary(devices).boards.find((b) => b.board === 'x4pro');
  assert.equal(x4().pending, 1);

  firmware.updateNow({ board: 'x4pro' });
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, true); // with no schedule at all
  assert.equal(firmware.configFor(OTHER, remote('v0.2.0')).now, false); // already on it
  assert.equal(firmware.configFor(STICKY, remote('v0.1.0', 'sticky')).now, false); // another board: not pressed
  assert.equal(x4().now.waiting, 1);

  // Once it has tried (here, failed), it isn't asked again every wake.
  firmware.report(PILOT, { version: 'v0.2.0', from: 'v0.1.0', ok: false, error: 'checksum mismatch' }, remote('v0.1.0'));
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, false);
  assert.equal(x4().now.waiting, 0);

  // Pressing again asks again; a new release, or Cancel, clears it.
  firmware.updateNow({ board: 'x4pro' });
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, true);
  firmware.cancelUpdateNow('x4pro');
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, false);
  firmware.updateNow({ board: 'x4pro' });
  firmware.updateSettings({ board: 'x4pro', release: 'v0.3.0' });
  assert.equal(firmware.overview().settings.boards.x4pro.updateNow, null);

  firmware.updateSettings({ enabled: false });
  assert.throws(() => firmware.updateNow({ board: 'x4pro' }), /off/);
});

test('firmware: "update now" can skip the pilot: the release goes to every device of the board', () => {
  firmware.updateSettings({ enabled: true, board: 'x4pro', release: 'v0.2.0' }); // with the pilots
  firmware.updateSettings({ pilot: [PILOT] });
  const devices = { [PILOT]: { ...remote('v0.1.0'), mac: PILOT }, [OTHER]: { ...remote('v0.1.0'), mac: OTHER }, [STICKY]: { ...remote('v0.1.0', 'sticky'), mac: STICKY } };
  const x4 = () => firmware.summary(devices).boards.find((b) => b.board === 'x4pro');
  assert.deepEqual([x4().pending, x4().pendingEveryone], [1, 2]); // the sticky isn't counted
  firmware.updateNow({ board: 'x4pro', everyone: true });
  assert.equal(firmware.overview().settings.boards.x4pro.stage, 'everyone');
  assert.equal(firmware.configFor(OTHER, remote('v0.1.0')).now, true);
  assert.equal(x4().now.waiting, 2);
});
