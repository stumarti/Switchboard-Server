'use strict';

// Today's high and low under the weather's temperature (`highLow`).

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

function weatherData(section, forecast = daily, hourly = []) {
  const layout = normalizeLayout({ screens: [{ id: 's', columns: [[{ id: 'w', type: 'weather', entity: 'weather.home', ...section }]] }] });
  const out = buildScreens(layout, {
    states: { 'weather.home': { state: 'rainy', attributes: { temperature: 8.4 }, last_changed: NOW.toISOString() } },
    forecasts: { daily: { 'weather.home': forecast }, hourly: { 'weather.home': hourly } },
    now: NOW,
    timeZone: TZ
  });
  return out.s.columns.flat().find((s) => s.id === 'w').data;
}

test('weather: highLow is off by default, and kept when on', () => {
  assert.equal(normalizeSection({ type: 'weather', entity: 'weather.home' }).highLow, false);
  assert.equal(normalizeSection({ type: 'weather', entity: 'weather.home', highLow: true }).highLow, true);
});

test('weather: no high and low unless asked for', () => {
  assert.equal(weatherData({}).highLow, null);
});

test('weather: today’s high and low from the daily forecast', () => {
  const d = weatherData({ highLow: true });
  assert.deepEqual(d.highLow, { high: 11.6, low: 4.2 });
  // Tomorrow is still the first of the next days, with its low.
  assert.equal(d.forecast[0].high, 9);
  assert.equal(d.forecast[0].low, 3);
});

test('weather: a daily forecast starting tomorrow falls back to the rest of today, hourly', () => {
  const hourly = [
    { datetime: '2026-11-07T13:00:00Z', temperature: 9.5 },
    { datetime: '2026-11-07T18:00:00Z', temperature: 6 },
    { datetime: '2026-11-08T03:00:00Z', temperature: 1 }
  ];
  assert.deepEqual(weatherData({ highLow: true }, daily.slice(1), hourly).highLow, { high: 9.5, low: 6 });
});

test('weather: nothing for today at all gives empty values, so the line stays', () => {
  assert.deepEqual(weatherData({ highLow: true }, daily.slice(1)).highLow, { high: null, low: null });
});
