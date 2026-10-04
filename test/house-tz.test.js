'use strict';

// node --test: the server takes Home Assistant's time zone unless TZ is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

test("without TZ, the server adopts Home Assistant's time zone (and Intl follows)", async (t) => {
  if (process.env.TZ) return t.skip('TZ is set for this run');
  const ha = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/config' ? { time_zone: 'Pacific/Auckland' } : {}));
  });
  await new Promise((r) => ha.listen(0, '127.0.0.1', r));
  const { adoptHaTimeZone } = require('../lib/house-tz');
  const globals = { homeAssistant: { host: '127.0.0.1', port: ha.address().port, token: 'x' } };
  try {
    const tz = await adoptHaTimeZone(globals);
    assert.equal(tz, 'Pacific/Auckland');
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Pacific/Auckland');
  } finally {
    delete process.env.TZ;
    ha.close();
  }
});

test('the time zone set in Settings wins over Home Assistant’s, and clearing it goes back', async (t) => {
  if (process.env.TZ) return t.skip('TZ is set for this run');
  const ha = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/config' ? { time_zone: 'Pacific/Auckland' } : {}));
  });
  await new Promise((r) => ha.listen(0, '127.0.0.1', r));
  const houseTz = require('../lib/house-tz');
  const homeAssistant = { host: '127.0.0.1', port: ha.address().port, token: 'x' };
  try {
    assert.deepEqual(await houseTz.apply({ homeAssistant, timeZone: 'Europe/Dublin' }), { timeZone: 'Europe/Dublin', source: 'setting' });
    // Cleared: Home Assistant's again.
    assert.deepEqual(await houseTz.apply({ homeAssistant, timeZone: '' }), { timeZone: 'Pacific/Auckland', source: 'homeAssistant' });
    // Neither: the process's own zone, and the Home page says so.
    delete process.env.TZ;
    assert.equal((await houseTz.apply({ timeZone: 'Europe/Dublin' })).source, 'setting');
    const none = await houseTz.apply({});
    assert.equal(none.source, 'default');
    const overview = require('../lib/overview');
    const o = overview.build({ devices: [{ mac: 'a0:b1:c2:00:00:01', type: 'viewport', status: 'approved' }], haConfigured: false, haNeeded: false, timeZone: none });
    assert.ok(o.attention.some((a) => a.kind === 'timezone' && a.link === '#/settings/clock'));
  } finally {
    delete process.env.TZ;
    ha.close();
  }
});

test('a time zone the runtime doesn’t know is not saved', () => {
  const { normalizeGlobals } = require('../lib/validate');
  assert.equal(normalizeGlobals({ timeZone: 'Europe/Dublin' }, {}).timeZone, 'Europe/Dublin');
  assert.equal(normalizeGlobals({ timeZone: 'Mars/Olympus' }, {}).timeZone, '');
});
