'use strict';

// node --test: the viewport firmware's repository joins a list saved before
// it existed, once.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fw-repos-'));
const test = require('node:test');
const assert = require('node:assert/strict');

test('a repository list saved before viewports gets Switchboard-Viewport once, and it stays removed if removed', () => {
  const dir = path.join(process.env.DATA_DIR, 'firmware');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'firmware.json'), JSON.stringify({ settings: { repos: ['stumarti/Switchboard', 'me/fork'] }, builds: [] }));
  const firmware = require('../lib/firmware');
  assert.deepEqual(firmware.overview().settings.repos, ['stumarti/Switchboard', 'me/fork', 'stumarti/Switchboard-Viewport']);
  firmware.updateSettings({ repos: ['stumarti/Switchboard'] });
  assert.deepEqual(firmware.overview().settings.repos, ['stumarti/Switchboard']);
});
