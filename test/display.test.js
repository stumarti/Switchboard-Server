'use strict';

// node --test: a TV's display page — pairing with a name of its own, its
// token as a cookie for its photos, and photos in full colour.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-display-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const pairing = require('../lib/pairing');
const auth = require('../lib/auth');
const art = require('../lib/art');

test('display: a new screen pairs as a viewport with the name it gives, then its token works as a cookie', () => {
  const mac = '02:00:00:00:00:aa';
  assert.deepEqual(pairing.register(mac, '10.0.0.9', 'viewport', '  Living room TV  '), { status: 'pending' });
  const listed = pairing.list().find((d) => d.mac === mac);
  assert.equal(listed.name, 'Living room TV');
  assert.equal(listed.type, 'viewport');
  // No name: its id, as before.
  pairing.register('02:00:00:00:00:bb', '10.0.0.9', 'viewport');
  assert.equal(pairing.list().find((d) => d.mac === '02:00:00:00:00:bb').name, '02:00:00:00:00:bb');

  pairing.approve(mac, '');
  const { token } = pairing.register(mac, '10.0.0.9', 'viewport');
  assert.ok(token);
  // The header, or the cookie the page sets for its <img>s.
  assert.equal(auth.bearerFromRequest({ headers: { authorization: `Bearer ${token}` } }), token);
  assert.equal(auth.bearerFromRequest({ headers: { cookie: `other=1; sb_device=${encodeURIComponent(token)}` } }), token);
  assert.equal(auth.deviceForToken(auth.bearerFromRequest({ headers: { cookie: `sb_device=${token}` } })).mac, mac);
  assert.equal(auth.bearerFromRequest({ headers: {} }), null);
  // Set only for this server's own pages, never readable by script.
  let header = '';
  auth.setDeviceCookie({ setHeader: (k, v) => (header = v) }, token);
  assert.match(header, /^sb_device=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
});

test('display: a photo for a TV in full colour, as a JPEG, up to 1920 wide', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => png });
  try {
    const img = await art.prepare('http://photos.lan/orange.png', { width: 2400, height: 1080, format: 'jpeg' }, {});
    assert.equal(img.type, 'image/jpeg');
    assert.equal(img.width, 1920);
    const { data } = await sharp(img.body).raw().toBuffer({ resolveWithObject: true });
    // Its own colour, not dithered to the panel's six inks.
    assert.ok(Math.abs(data[0] - 200) < 8 && Math.abs(data[1] - 120) < 8 && Math.abs(data[2] - 40) < 8, `${data[0]},${data[1]},${data[2]}`);
  } finally {
    global.fetch = realFetch;
  }
});
