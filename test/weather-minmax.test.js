'use strict';

// Today's high and low under the weather's temperature (`minMax`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLayout, normalizeSection } = require('../lib/dashboard');
const { buildScreens } = require('../lib/dashboard-state');

const TZ = 'Europe/Dublin';
const NOW = new Date('2026-11-07T12:30:00Z');
const daily = [
  { datetime: '2026-11-07T12:00:00Z', condition: 'rainy', temperature: 11.6, templow: 4.2 },
  { datetime: '2026-11-08T12:00:00Z', condition: 'cloudy', temperature: 9, templow: 3 }
];

function weatherData(section, forecast = daily) {
  const layout = normalizeLayout({ screens: [{ id: 's', columns: [[{ id: 'w', type: 'weather', entity: 'weather.home', ...section }]] }] });
  const out = buildScreens(layout, {
    states: { 'weather.home': { state: 'rainy', attributes: { temperature: 8.4 }, last_changed: NOW.toISOString() } },
    forecasts: { daily: { 'weather.home': forecast }, hourly: {} },
    now: NOW,
    timeZone: TZ
  });
  return out.s.columns.flat().find((s) => s.id === 'w').data;
}

test('weather: minMax is off by default, and kept when on', () => {
  assert.equal(normalizeSection({ type: 'weather', entity: 'weather.home' }).minMax, false);
  assert.equal(normalizeSection({ type: 'weather', entity: 'weather.home', minMax: true }).minMax, true);
});

test('weather: no high and low unless asked for', () => {
  assert.equal(weatherData({}).today, null);
});

test('weather: today’s high and low from the daily forecast', () => {
  const d = weatherData({ minMax: true });
  assert.deepEqual(d.today, { high: 11.6, low: 4.2 });
  // Tomorrow is still the first of the next days.
  assert.equal(d.forecast[0].high, 9);
});

test('weather: no entry for today gives empty values, so the line stays', () => {
  assert.deepEqual(weatherData({ minMax: true }, daily.slice(1)).today, { high: null, low: null });
});
