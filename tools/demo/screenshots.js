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

  // Home, Layouts, a room's remote layout.
  await go('#/home', 2500);
  await shot('admin/home');
  await go('#/layouts');
  await shot('admin/layouts');
  await go('#/remote-layouts/living-room', 3500);
  await shot('admin/remote-layout-carousel', card('Carousel'));
  // A page's card shows once it's picked in the carousel.
  const pick = async (label) => {
    await page.locator('.page-card', { has: page.locator('.pc-title', { hasText: new RegExp(`^${label}$`) }) }).locator('.pc-screen').click();
    await page.waitForTimeout(800);
    await fit();
  };
  await pick('Lighting');
  await shot('admin/remote-layout-lighting', card('Lighting'));
  await pick('Quick Access');
  await shot('admin/remote-layout-quick-access', card('Quick Access'));
  await shot('admin/remote-layout-previews', card('Screen previews'));

  // Remotes: the list with the updates summary, one remote, one to approve.
  await go('#/remotes', 2000);
  await shot('admin/remotes');
  await go(`#/remotes/${encodeURIComponent(REMOTE)}`, 2500);
  await shot('admin/remote');
  await go(`#/remotes/${encodeURIComponent(PENDING)}`, 2000);
  await shot('admin/approve');

  // Viewports: a display, and its layout in the builder.
  await go(`#/viewports/${encodeURIComponent(VIEWPORT)}`, 2500);
  await shot('admin/viewport');
  await go('#/viewport-layouts/kitchen-panel', 4000);
  await shot('admin/viewport-layout', null, { x: 0, y: 0, width: 1360, height: 900 });

  // Settings, tab by tab.
  for (const tab of ['home-assistant', 'wifi', 'clock', 'theme', 'updates', 'account']) {
    await go(`#/settings/${tab}`, 2000);
    await shot(`admin/settings-${tab}`);
  }

  // Every viewport screen, at the panel's own 800x480: a window wide
  // enough that the builder's preview isn't scaled down.
  for (const [slug, prefix] of [['kitchen-panel', 'kitchen'], ['boardroom', 'boardroom'], ['reception', 'reception']]) {
    await go(`#/viewport-layouts/${slug}`, 4000, 2600);
    const cards = page.locator('.page-card');
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const title = (await cards.nth(i).locator('.pc-title').first().textContent().catch(() => '')) || `screen-${i + 1}`;
      await cards.nth(i).locator('.pc-screen').click();
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
