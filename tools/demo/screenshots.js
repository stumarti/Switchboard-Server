'use strict';

/**
 * The manual's admin UI and viewport screenshots, taken from a running demo
 * (demo.js) with Playwright.
 *
 *   node tools/demo/screenshots.js <out-dir> [base-url]
 *
 * Playwright is found in this project's node_modules or the global one
 * (npm i -g playwright). Writes <out-dir>/admin/*.png and <out-dir>/viewport/*.png.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

function playwright() {
  try {
    return require('playwright');
  } catch {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}

const OUT = path.resolve(process.argv[2] || 'screenshots');
const BASE = process.argv[3] || `http://127.0.0.1:${process.env.DEMO_PORT || 45678}`;
const PASSWORD = process.env.DEMO_PASSWORD || 'demo';
const REMOTE = 'a0:b1:c2:00:00:01';
const VIEWPORT = 'a0:b1:c2:00:01:01';
const PENDING = 'a0:b1:c2:00:00:09';

async function main() {
  fs.mkdirSync(path.join(OUT, 'admin'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'viewport'), { recursive: true });
  const { chromium } = playwright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Fit the window to the page, so a page that scrolls inside the app's
  // frame is captured whole.
  const fit = async () => {
    const h = await page.evaluate(() => Math.max(...[...document.querySelectorAll('*')].map((e) => e.scrollHeight)));
    await page.setViewportSize({ width: page.viewportSize().width, height: Math.min(Math.max(h, 700), 4000) });
    await page.waitForTimeout(300);
  };
  const go = async (hash, wait = 1500, width = 1360) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/${hash}`);
    await page.waitForTimeout(wait);
    await fit();
  };
  const shot = async (name, locator, clip) => {
    const file = path.join(OUT, name + '.png');
    const png = locator ? await locator.first().screenshot() : await page.screenshot(clip ? { clip } : {});
    // A 256-colour palette: a third of the size, and nothing visible lost on UI.
    await sharp(png).png({ palette: true, quality: 90, compressionLevel: 9 }).toFile(file);
    console.log(`  ${name}`);
  };
  // A card by its own title (not one that merely mentions the words).
  const card = (title) => page.locator('section.card').filter({ has: page.locator(':scope > .card-head h2', { hasText: new RegExp(`^${title}$`) }) });

  await page.goto(BASE);
  await page.waitForTimeout(500);
  if (await page.$('input[type=password]')) {
    await page.fill('input[type=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForTimeout(800);
  }

  // A list row (a remote layout's page, a viewport layout's screen) by its name.
  const row = (scope, label) => page.locator(`${scope} .pl-row`, { has: page.locator('.pl-text b', { hasText: new RegExp(`^${label}$`) }) });
  // The window without the scrolled-off part: what you see on opening a page.
  const top = { x: 0, y: 0, width: 1360, height: 900 };

  // Home, Layouts, a room's remote layout.
  await go('#/home', 2500);
  await shot('admin/home');
  await go('#/layouts');
  await shot('admin/layouts');
  await go('#/remote-layouts/living-room', 3500);
  await shot('admin/remote-layout', null, top);
  await row('.room-pages', 'Lighting').click();
  await page.waitForTimeout(2000);
  await shot('admin/remote-layout-lighting', null, top);
  await go('#/remote-layouts/living-room/quick', 3000);
  await shot('admin/remote-layout-quick-access', null, top);
  await go('#/remote-layouts/living-room/settings', 2000);
  await shot('admin/remote-layout-settings');

  // Remotes: the list with the updates summary, one remote, one to approve.
  await go('#/remotes', 2000);
  await shot('admin/remotes');
  await go(`#/remotes/${encodeURIComponent(REMOTE)}`, 2500);
  await shot('admin/remote');
  await go(`#/remotes/${encodeURIComponent(PENDING)}`, 2000);
  await shot('admin/approve');

  // Viewports: a display, and its layout in the builder, with a section open.
  await go(`#/viewports/${encodeURIComponent(VIEWPORT)}`, 2500);
  await shot('admin/viewport');
  await go('#/viewport-layouts/kitchen-panel', 4000);
  await shot('admin/viewport-layout', null, top);
  await page.locator('.section-list .pl-row', { has: page.locator('.pl-text b', { hasText: /^Energy totals$/ }) }).click();
  await page.waitForTimeout(2000);
  await shot('admin/viewport-layout-section', null, top);
  await page.keyboard.press('Escape');
  await go('#/viewport-layouts/kitchen-panel/settings', 1500);
  await shot('admin/viewport-layout-thresholds', null, top);

  // An office: a room list pasted in (read, not yet set up), and a room
  // finder whose Quiet room is on a calendar link.
  await go('#/layouts/meeting-rooms', 1500);
  await page.fill('textarea.bulk-text', [
    'Room, Calendar, Occupancy, Display',
    'Atlas, https://outlook.office365.com/owa/calendar/0f3c…/calendar.ics, binary_sensor.huddle_occupied, a0:b1:c2:00:02:01',
    'Borealis, webcal://p01-caldav.icloud.com/published/2/MTk…, , a0:b1:c2:00:02:02',
    'Cosmos, calendar.focus',
    'Dorado, the big one by the lifts'
  ].join('\n'));
  await page.waitForTimeout(1500);
  await fit();
  await shot('admin/meeting-rooms-bulk', card('Add many meeting rooms'));
  await go('#/viewport-layouts/boardroom', 3000, 1800);
  await row('.vp-builder-side', 'Other rooms').click();
  await page.waitForTimeout(1500);
  await fit();
  await shot('admin/calendar-link', card('Rooms'));

  // Settings, page by page, and the firmware sources popup.
  for (const tab of ['home-assistant', 'wifi', 'clock', 'theme', 'updates', 'pairing', 'security', 'account', 'about']) {
    await go(`#/settings/${tab}`, 2000);
    await shot(`admin/settings-${tab}`);
  }
  await go('#/settings/updates', 2000);
  await page.click('button:has-text("Sources")');
  await page.waitForTimeout(600);
  await shot('admin/settings-updates-sources', page.locator('.modal'));
  await page.keyboard.press('Escape');

  // Search, from anywhere.
  await go('#/home', 2000);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.keyboard.press('/');
  await page.keyboard.type('liv');
  await page.waitForTimeout(400);
  await shot('admin/search', null, top);
  await page.keyboard.press('Escape');

  // Every viewport screen, at the panel's own 800x480: a window wide
  // enough that the builder's preview isn't scaled down.
  for (const [slug, prefix] of [['kitchen-panel', 'kitchen'], ['boardroom', 'boardroom'], ['reception', 'reception']]) {
    await go(`#/viewport-layouts/${slug}`, 4000, 2600);
    const rows = page.locator('.vp-builder-side .pl-row');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const title = (await rows.nth(i).locator('.pl-text b').first().textContent().catch(() => '')) || `screen-${i + 1}`;
      await rows.nth(i).click();
      await page.waitForTimeout(3500);
      await shot(`viewport/${prefix}-${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, page.locator('.vp-panel'));
    }
  }

  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
