'use strict';

// node --test: the viewport's and the E1004 board's firmware repositories
// join a list saved before they existed, once each.

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fw-repos-'));
const test = require('node:test');
const assert = require('node:assert/strict');

const dir = path.join(process.env.DATA_DIR, 'firmware');
const INDEX = path.join(dir, 'firmware.json');
fs.mkdirSync(dir, { recursive: true });
const firmware = require('../lib/firmware');

test('a repository list saved before viewports gets Switchboard-Viewport and Switchboard-Board once, and they stay removed if removed', () => {
  fs.writeFileSync(INDEX, JSON.stringify({ settings: { repos: ['stumarti/Switchboard', 'me/fork'] }, builds: [] }));
  assert.deepEqual(firmware.overview().settings.repos, ['stumarti/Switchboard', 'me/fork', 'stumarti/Switchboard-Viewport', 'stumarti/Switchboard-Board']);
  firmware.updateSettings({ repos: ['stumarti/Switchboard'] });
  assert.deepEqual(firmware.overview().settings.repos, ['stumarti/Switchboard']);
});

test('a list that already had the viewport repository offered gets only the board one, once', () => {
  fs.writeFileSync(INDEX, JSON.stringify({ settings: { repos: ['stumarti/Switchboard'], viewportRepoAdded: true }, builds: [] }));
  assert.deepEqual(firmware.overview().settings.repos, ['stumarti/Switchboard', 'stumarti/Switchboard-Board']);
  firmware.updateSettings({ repos: ['stumarti/Switchboard'] });
  assert.deepEqual(firmware.overview().settings.repos, ['stumarti/Switchboard']);
});
