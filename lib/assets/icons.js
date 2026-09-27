'use strict';

/**
 * Icon pack compiler: rasterizes MDI SVGs (@mdi/svg) into the exact 1bpp
 * MSB-first format freeink::Icon already uses (see freeink-sdk's
 * libs/assets/Icons/include/Icon.h), packages them via pack-format.js, and
 * exposes search+preview for the admin UI's icon picker.
 *
 * This replaces resvg_py+Pillow (tools/gen_weather_icons.py's rasterizer)
 * with `sharp` - the packing/thresholding/optical-center-of-mass logic below
 * is a direct port of that script's pack(), just reading sharp's alpha
 * channel (a solid black fill on a transparent background, so alpha IS
 * anti-aliased ink coverage directly - no white-background/luminance trick
 * needed the way PIL's approach required).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const iconSlots = require('./icon-slots');
const { writeIconsPack } = require('./pack-format');

const MDI_SVG_DIR = path.join(require.resolve('@mdi/svg/package.json'), '..', 'svg');

const THRESHOLD = 128;

let mdiNamesCache = null;
function listMdiNames() {
  if (!mdiNamesCache) {
    mdiNamesCache = fs
      .readdirSync(MDI_SVG_DIR)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.slice(0, -4));
  }
  return mdiNamesCache;
}

function searchMdiIcons(query, limit = 40) {
  const q = String(query || '').trim().toLowerCase();
  const names = listMdiNames();
  if (!q) return names.slice(0, limit);
  return names.filter((n) => n.includes(q)).slice(0, limit);
}

function mdiSvgPath(name) {
  return path.join(MDI_SVG_DIR, `${name}.svg`);
}

// Rasterize one MDI icon to a raw RGBA buffer at `size`x`size`, black fill on
// a transparent background - sharp's `density` boost keeps small sizes from
// looking chunky (librsvg rasterizes at the SVG's native size otherwise).
async function rasterizeMdi(mdiName, size) {
  const svgPath = mdiSvgPath(mdiName);
  if (!fs.existsSync(svgPath)) throw new Error(`unknown mdi icon: ${mdiName}`);
  const svg = fs.readFileSync(svgPath, 'utf8');
  const { data, info } = await sharp(Buffer.from(svg), { density: 96 * 4 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Pack a rasterized RGBA buffer into freeink::Icon's 1bpp MSB-first format
// (bit 1 = transparent, bit 0 = ink), with the optical-center-of-mass row -
// a direct port of tools/gen_weather_icons.py's pack().
function packIcon(rgba, w, h) {
  const rowBytes = Math.ceil(w / 8);
  const out = Buffer.alloc(rowBytes * h, 0xff);
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < h; y++) {
    for (let xb = 0; xb < w; xb += 8) {
      let byte = 0;
      for (let b = 0; b < 8; b++) {
        const x = xb + b;
        let white = 1;
        if (x < w) {
          const alpha = rgba[(y * w + x) * 4 + 3];
          if (alpha >= THRESHOLD) {
            white = 0;
            sumY += y;
            count += 1;
          }
        }
        byte |= white << (7 - b);
      }
      out[y * rowBytes + xb / 8] = byte;
    }
  }

  const opticalCenterY = count ? Math.round(sumY / count) : Math.floor(h / 2);
  return { bits: out, opticalCenterY };
}

// Transparent background (not flattened onto white) so the admin UI can
// invert it with a CSS filter for a clean white-on-transparent glyph that
// blends into the dark theme, rather than a solid colored square.
async function renderPreviewPng(mdiName, size = 48) {
  const svgPath = mdiSvgPath(mdiName);
  if (!fs.existsSync(svgPath)) throw new Error(`unknown mdi icon: ${mdiName}`);
  const svg = fs.readFileSync(svgPath, 'utf8');
  const png = await sharp(Buffer.from(svg), { density: 96 * 4 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

// overrides: { [slotKey]: mdiName } - a slot with no override uses its
// manifest-recorded default MDI source, so an unmodified slot round-trips
// to the same look. Sizes are NOT admin-configurable: every slot always
// compiles at the exact pixel size the firmware renders it at (recorded in
// the manifest), matching how the firmware actually calls ui.icon()/
// iconScaled() at each call site today.
async function compileIconsPack(overrides = {}) {
  const slots = iconSlots.listSlots();
  const icons = [];
  for (const slot of slots) {
    const mdiName = overrides[slot.key] || slot.defaultMdi;
    const { data, width, height } = await rasterizeMdi(mdiName, slot.size);
    const { bits, opticalCenterY } = packIcon(data, width, height);
    icons.push({ name: slot.key, w: width, h: height, opticalCenterY, bits });
  }
  return writeIconsPack(icons);
}

module.exports = { searchMdiIcons, renderPreviewPng, compileIconsPack };
