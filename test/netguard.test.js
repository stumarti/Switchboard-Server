'use strict';

// node --test: allowed networks (lib/netguard.js) — the list, who it lets in,
// and that a save can't shut out the address it's made from.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-net-'));
delete process.env.ALLOWED_NETWORKS;
delete process.env.TRUST_PROXY;
const test = require('node:test');
const assert = require('node:assert/strict');
const netguard = require('../lib/netguard');

// A request as the middleware sees it, and what it answered.
function run(address, headers = {}) {
  let status = 200;
  let passed = false;
  const req = { socket: { remoteAddress: address }, ip: headers['x-forwarded-for'] || address };
  const res = { status(s) { status = s; return this; }, type() { return this; }, send() { return this; } };
  netguard.middleware(req, res, () => { passed = true; });
  return passed ? 200 : status;
}

test('netguard: ranges and single addresses, tidied; bad entries refused', () => {
  assert.deepEqual(netguard.normalizeList('192.168.1.0/24\n10.0.0.5, 10.0.0.5/32 fd00::/8'), ['192.168.1.0/24', '10.0.0.5/32', 'fd00::/8']);
  assert.throws(() => netguard.normalizeList(['192.168.1.0/33']), /prefix/);
  assert.throws(() => netguard.normalizeList(['example.com']), /isn't an IP/);
  assert.throws(() => netguard.normalizeList(['10.0.0.0/8/1']), /isn't an IP/);
  assert.ok(netguard.allows(['192.168.1.0/24'], '192.168.1.77'));
  assert.ok(netguard.allows(['192.168.1.0/24'], '::ffff:192.168.1.77')); // IPv4 on a dual-stack socket
  assert.ok(!netguard.allows(['192.168.1.0/24'], '192.168.2.1'));
  assert.ok(netguard.allows(['192.168.1.0/24'], '127.0.0.1')); // this server itself, always
  assert.ok(netguard.allows([], '::1'));
  assert.ok(netguard.allows(netguard.PRIVATE, '100.101.5.9')); // Tailscale's range is private
  assert.ok(!netguard.allows(netguard.PRIVATE, '8.8.8.8'));
});

test('netguard: off by default; on, only the list (and this server) gets an answer', () => {
  assert.equal(run('8.8.8.8'), 200); // off: everyone, as before
  netguard.save({ enabled: true, allowed: ['192.168.1.0/24'] }, '192.168.1.10');
  assert.equal(run('192.168.1.20'), 200);
  assert.equal(run('::ffff:192.168.1.20'), 200);
  assert.equal(run('8.8.8.8'), 403);
  assert.equal(run('127.0.0.1'), 200);
  // X-Forwarded-For is anyone's to send: not believed without TRUST_PROXY.
  assert.equal(run('8.8.8.8', { 'x-forwarded-for': '192.168.1.20' }), 403);
});

test('netguard: a save that would shut you out is refused; an empty list too', () => {
  assert.throws(() => netguard.save({ enabled: true, allowed: ['10.0.0.0/8'] }, '192.168.1.10'), /shut you out/);
  assert.throws(() => netguard.save({ enabled: true, allowed: [] }, '192.168.1.10'), /at least one/);
  assert.deepEqual(netguard.current().allowed, ['192.168.1.0/24']); // unchanged
  netguard.save({ enabled: false, allowed: ['10.0.0.0/8'] }, '192.168.1.10'); // off: anything goes
  assert.equal(run('8.8.8.8'), 200);
});

test('netguard: ALLOWED_NETWORKS replaces the saved list ("any" turns it off), and TRUST_PROXY believes the proxy', () => {
  netguard.save({ enabled: true, allowed: ['192.168.1.0/24'] }, '192.168.1.10');
  process.env.ALLOWED_NETWORKS = '10.0.0.0/8';
  assert.equal(run('192.168.1.20'), 403);
  assert.equal(run('10.1.2.3'), 200);
  assert.throws(() => netguard.save({ enabled: false, allowed: [] }, '10.1.2.3'), /ALLOWED_NETWORKS/);
  process.env.ALLOWED_NETWORKS = 'any';
  assert.equal(run('8.8.8.8'), 200);
  delete process.env.ALLOWED_NETWORKS;

  process.env.TRUST_PROXY = '172.17.0.1';
  // (Express sets req.ip from X-Forwarded-For when the proxy is trusted.)
  assert.equal(run('172.17.0.1', { 'x-forwarded-for': '192.168.1.20' }), 200);
  assert.equal(run('172.17.0.1', { 'x-forwarded-for': '8.8.8.8' }), 403);
  delete process.env.TRUST_PROXY;
});
