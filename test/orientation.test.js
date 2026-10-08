'use strict';

// node --test: how a viewport hangs (a layout's rotation) reaches the display.

const test = require('node:test');
const assert = require('node:assert/strict');
const dashboard = require('../lib/dashboard');
const { deviceLayout } = require('../lib/dashboard-state');

test('a layout hangs landscape unless it says otherwise; only quarter turns', () => {
  assert.equal(dashboard.normalizeLayout({}).rotation, 0);
  for (const r of [0, 90, 180, 270]) assert.equal(dashboard.normalizeLayout({ rotation: r }).rotation, r);
  assert.equal(dashboard.normalizeLayout({ rotation: '90' }).rotation, 90);
  assert.equal(dashboard.normalizeLayout({ rotation: 45 }).rotation, 0);
  // A partial save keeps it.
  assert.equal(dashboard.normalizeLayout({ refreshIntervalMin: 15 }, { rotation: 270 }).rotation, 270);
});

test('the display gets its rotation with the layout', () => {
  assert.equal(deviceLayout(dashboard.normalizeLayout({ rotation: 90 })).rotation, 90);
});
