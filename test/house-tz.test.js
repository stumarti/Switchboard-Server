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
