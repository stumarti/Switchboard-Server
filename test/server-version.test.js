'use strict';

// node --test: is a newer Switchboard Server out (lib/server-version.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { compare, check, createChecker } = require('../lib/server-version');
const overview = require('../lib/overview');

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const release = (tag) => reply(200, { tag_name: tag, name: `Switchboard Server ${tag}`, html_url: `https://github.com/stumarti/Switchboard-Server/releases/tag/${tag}`, published_at: '2026-10-01T10:00:00Z' });

test('versions compare as numbers, a pre-release before its release', () => {
  assert.equal(compare('1.0.0', '1.0.1'), -1);
  assert.equal(compare('1.10.0', '1.9.3'), 1);
  assert.equal(compare('v1.2', '1.2.0'), 0);
  assert.equal(compare('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compare('1.2.0', '1.2.0-rc.1'), 1);
  assert.equal(compare('dev', '1.0.0'), null);
});

test('a newer release is found, with its link', async () => {
  const r = await check({ current: '1.0.0', fetchImpl: release('v1.1.0') });
  assert.equal(r.latest, '1.1.0');
  assert.equal(r.newer, true);
  assert.equal(r.url, 'https://github.com/stumarti/Switchboard-Server/releases/tag/v1.1.0');
  assert.equal(r.error, '');
});

test('up to date, ahead, or a dev build: not newer', async () => {
  assert.equal((await check({ current: '1.1.0', fetchImpl: release('v1.1.0') })).newer, false);
  assert.equal((await check({ current: '1.2.0', fetchImpl: release('v1.1.0') })).newer, false);
  const dev = await check({ current: 'dev', fetchImpl: release('v1.1.0') });
  assert.equal(dev.newer, false);
  assert.equal(dev.known, false);
});

test('GitHub failing is an error, not an answer', async () => {
  const limited = await check({ current: '1.0.0', fetchImpl: reply(403, {}) });
  assert.equal(limited.newer, false);
  assert.match(limited.error, /limiting/);
  const none = await check({ current: '1.0.0', fetchImpl: reply(404, {}) });
  assert.equal(none.latest, null);
  assert.match(none.error, /No releases/);
  const down = await check({ current: '1.0.0', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } });
  assert.match(down.error, /ENOTFOUND/);
});

test('the checker keeps the last good answer through a failed check, and can be off', async () => {
  let fetchImpl = release('v1.1.0');
  const c = createChecker({ current: '1.0.0', fetchImpl: (...a) => fetchImpl(...a) });
  assert.equal(c.status().checkedAt, null);
  assert.equal((await c.checkNow()).newer, true);
  fetchImpl = reply(500, {});
  const s = await c.checkNow();
  assert.equal(s.latest, '1.1.0');
  assert.equal(s.newer, true);
  assert.match(s.error, /HTTP 500/);

  let asked = false;
  const off = createChecker({ current: '1.0.0', enabled: false, fetchImpl: async () => { asked = true; return release('v9.0.0')(); } });
  assert.equal((await off.checkNow()).enabled, false);
  assert.equal(asked, false);
});

test('the Home page says when a newer server is out', () => {
  const o = overview.build({ server: { version: '1.0.0', update: { newer: true, latest: '1.1.0' } }, haConfigured: true, haNeeded: false });
  const a = o.attention.find((x) => x.kind === 'server');
  assert.equal(a.title, 'Switchboard Server 1.1.0 is out');
  assert.equal(a.link, '#/settings/about');
  const same = overview.build({ server: { version: '1.1.0', update: { newer: false, latest: '1.1.0' } }, haConfigured: true, haNeeded: false });
  assert.equal(same.attention.some((x) => x.kind === 'server'), false);
});
