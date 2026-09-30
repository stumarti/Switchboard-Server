'use strict';

// node --test: remote firmware updates (lib/firmware.js) — which images are
// accepted, who is offered what (pilot first, then everyone), GitHub
// imports checked against their checksum, and remotes' reports.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fw-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const firmware = require('../lib/firmware');

// A minimal image that passes inspect(): ESP32 app magic, the S3 chip id,
// the app-descriptor magic and the Switchboard version marker.
function image(version, { size = 200 * 1024, chip = 9, marker = true } = {}) {
  const b = Buffer.alloc(size, 0xff);
  b[0] = 0xe9;
  b.writeUInt16LE(chip, 12);
  b.writeUInt32LE(0xabcd5432, 32);
  if (marker) b.write(`SWITCHBOARD_FW:${version}\0`, 4096, 'latin1');
  return b;
}

const PILOT = 'aa:00:00:00:00:01';
const OTHER = 'aa:00:00:00:00:02';
const remote = (fw) => ({ type: 'remote', status: 'approved', name: 'R', health: { firmware: fw } });

test('firmware: only Switchboard ESP32-S3 app images are accepted, versioned by their marker', () => {
  assert.equal(firmware.inspect(image('v0.2.0')).version, 'v0.2.0');
  assert.throws(() => firmware.inspect(Buffer.alloc(100)), /too small/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { chip: 0 })), /different chip/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { marker: false })), /isn't Switchboard/);
  assert.throws(() => firmware.inspect(image('v0.2.0-dirty')), /uncommitted/);
  assert.throws(() => firmware.inspect(image('v0.2.0', { size: firmware.MAX_IMAGE + 1 })), /update slot/);
  const merged = image('v0.2.0');
  merged[0] = 0x00;
  assert.throws(() => firmware.inspect(merged), /full flasher image/);
});

test('firmware: off by default; then the pilot remotes first, everyone once promoted', () => {
  assert.deepEqual(firmware.configFor(PILOT, remote('v0.1.0')), { enabled: false });
  const b = firmware.addBuild(image('v0.2.0'), 'upload');
  assert.equal(b.sha256.length, 64);
  firmware.updateSettings({ enabled: true, release: 'v0.2.0', pilot: [PILOT] });

  assert.equal(firmware.offerFor(PILOT, remote('v0.1.0')).version, 'v0.2.0');
  assert.equal(firmware.offerFor(OTHER, remote('v0.1.0')), null); // not a pilot
  assert.equal(firmware.offerFor(PILOT, remote('v0.2.0')), null); // already on it
  assert.equal(firmware.offerFor(PILOT, remote(undefined)), null); // too old to update itself
  assert.equal(firmware.offerFor(PILOT, { ...remote('v0.1.0'), type: 'viewport' }), null);

  firmware.updateSettings({ stage: 'everyone' });
  assert.equal(firmware.offerFor(OTHER, remote('v0.1.0')).version, 'v0.2.0');

  // A new release starts again with the pilots; an older one rolls back.
  firmware.addBuild(image('v0.1.0'), 'upload');
  const s = firmware.updateSettings({ release: 'v0.1.0' });
  assert.equal(s.stage, 'pilot');
  assert.equal(firmware.offerFor(PILOT, remote('v0.2.0')).version, 'v0.1.0');

  const cfg = firmware.configFor(PILOT, remote('v0.2.0'));
  assert.deepEqual([cfg.enabled, cfg.button, cfg.schedule, cfg.minBattery], [true, true, null, 30]);
  firmware.updateSettings({ schedule: { enabled: true, fromHour: 1, toHour: 4 } });
  assert.deepEqual(firmware.configFor(PILOT, remote('v0.2.0')).schedule, { fromHour: 1, toHour: 4 });

  assert.throws(() => firmware.removeBuild('v0.1.0'), /current release/);
  assert.throws(() => firmware.updateSettings({ release: 'v9.9.9' }), /No such build/);
});

test('firmware: reports show which remotes failed', () => {
  firmware.updateSettings({ release: 'v0.2.0', stage: 'everyone' });
  firmware.report(PILOT, { version: 'v0.2.0', from: 'v0.1.0', ok: false, error: 'checksum mismatch' });
  const st = firmware.status({ [PILOT]: remote('v0.1.0'), [OTHER]: remote('v0.2.0') });
  assert.deepEqual(st.map((r) => [r.mac, r.state]), [[PILOT, 'failed'], [OTHER, 'current']]);
  assert.equal(st[0].last.error, 'checksum mismatch');
});

test('firmware: a GitHub release is added only if it matches its published checksum and tag', async () => {
  const img = image('v0.3.0');
  const sum = crypto.createHash('sha256').update(img).digest('hex');
  const assets = (s) => ({
    tag_name: 'v0.3.0',
    assets: [
      { name: 'switchboard-app-v0.3.0.bin', browser_download_url: 'https://dl/bin' },
      { name: 'switchboard-app-v0.3.0.bin.sha256', browser_download_url: 'https://dl/sum' }
    ],
    s
  });
  const fake = (checksum, body = img) => async (url) => ({
    ok: true,
    status: 200,
    json: async () => assets(),
    arrayBuffer: async () => (url.endsWith('/bin') ? body : Buffer.from(`${checksum}  switchboard-app-v0.3.0.bin\n`))
  });
  await assert.rejects(firmware.importRelease('v0.3.0', { fetchImpl: fake('0'.repeat(64)) }), /checksum/);
  const other = image('v0.2.9');
  await assert.rejects(
    firmware.importRelease('v0.3.0', { fetchImpl: fake(crypto.createHash('sha256').update(other).digest('hex'), other) }),
    /contains firmware v0.2.9/
  );
  const b = await firmware.importRelease('v0.3.0', { fetchImpl: fake(sum) });
  assert.equal(b.version, 'v0.3.0');
  assert.equal(firmware.build('v0.3.0').source, 'github:stumarti/Switchboard@v0.3.0');
});

test('firmware: your own GitHub repositories — listed, tidied, and the only ones read', async () => {
  const s = firmware.updateSettings({ repos: ['https://github.com/me/Switchboard-fork.git', 'stumarti/Switchboard', 'ME/switchboard-fork'] });
  assert.deepEqual(s.repos, ['me/Switchboard-fork', 'stumarti/Switchboard']); // URL tidied, duplicate dropped
  assert.throws(() => firmware.updateSettings({ repos: ['not a repo'] }), /isn't a GitHub repository/);
  assert.throws(() => firmware.updateSettings({ repos: ['../../etc/passwd'] }), /isn't a GitHub repository/);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => [{ tag_name: 'v9.0.0', published_at: '2026-09-01T00:00:00Z', assets: [{ name: 'switchboard-app-v9.0.0.bin' }] }] };
  };
  const list = await firmware.githubReleases({ repo: 'stumarti/Switchboard', fetchImpl });
  assert.equal(list[0].repo, 'stumarti/Switchboard');
  await firmware.githubReleases({ fetchImpl }); // no repo: the first in the list
  assert.match(calls[1], /repos\/me\/Switchboard-fork\/releases/);
  await assert.rejects(firmware.githubReleases({ repo: 'someone/else', fetchImpl }), /isn't in the repository list/);
  assert.equal(calls.length, 2); // never asked GitHub about an unlisted repository

  firmware.updateSettings({ repos: [] });
  await assert.rejects(firmware.importLatest({ fetchImpl }), /Add a GitHub repository first/);
  firmware.updateSettings({ repos: ['stumarti/Switchboard'] });
});

test('firmware: "update now" — every remote due the release, at its next wake, until it has tried', () => {
  firmware.updateSettings({ enabled: true, release: 'v0.2.0', stage: 'everyone', schedule: { enabled: false } });
  const devices = { [PILOT]: { ...remote('v0.1.0'), mac: PILOT }, [OTHER]: { ...remote('v0.2.0'), mac: OTHER } };
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, false); // not pressed yet
  assert.equal(firmware.summary(devices).pending, 1);

  firmware.updateNow();
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, true); // with no schedule at all
  assert.equal(firmware.configFor(OTHER, remote('v0.2.0')).now, false); // already on it
  assert.deepEqual(firmware.summary(devices).now.waiting, 1);

  // Once it has tried (here, failed), it isn't asked again every wake.
  firmware.report(PILOT, { version: 'v0.2.0', from: 'v0.1.0', ok: false, error: 'checksum mismatch' });
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, false);
  assert.equal(firmware.summary(devices).now.waiting, 0);

  // Pressing again asks again; a new release, or Cancel, clears it.
  firmware.updateNow();
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, true);
  firmware.cancelUpdateNow();
  assert.equal(firmware.configFor(PILOT, remote('v0.1.0')).now, false);
  firmware.updateNow();
  firmware.updateSettings({ release: 'v0.3.0' });
  assert.equal(firmware.overview().settings.updateNow, null);

  firmware.updateSettings({ enabled: false });
  assert.throws(() => firmware.updateNow(), /off/);
});

test('firmware: "update now" can skip the pilot: the release goes to every remote', () => {
  firmware.updateSettings({ enabled: true, release: 'v0.2.0' }); // with the pilots
  firmware.updateSettings({ stage: 'pilot', pilot: [PILOT] });
  const devices = { [PILOT]: { ...remote('v0.1.0'), mac: PILOT }, [OTHER]: { ...remote('v0.1.0'), mac: OTHER } };
  const s = firmware.summary(devices);
  assert.deepEqual([s.pending, s.pendingEveryone], [1, 2]);
  firmware.updateNow({ everyone: true });
  assert.equal(firmware.overview().settings.stage, 'everyone');
  assert.equal(firmware.configFor(OTHER, remote('v0.1.0')).now, true);
  assert.equal(firmware.summary(devices).now.waiting, 2);
});
