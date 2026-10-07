'use strict';

/**
 * Album art (and any other picture a device shows), prepared here so the
 * device never decodes a JPEG: it downloads a small bitmap in exactly the
 * format it draws, once per track, and blits it.
 *
 *   mask1    1 bit per pixel, rows padded to whole bytes, MSB first, 0 =
 *            ink — the remote's icon format (freeink Mask1), Floyd–Steinberg
 *            dithered from greyscale
 *   spectra  4 bits per pixel (two pixels a byte, high nibble first, rows
 *            padded to whole bytes), each a palette index — 0 white, 1
 *            black, 2 red, 3 yellow, 4 green, 5 blue — for the six-colour
 *            viewport panel, dithered against the panel's measured colours
 *   png      the spectra result as a PNG, for the admin UI's preview
 *
 * `src` is what Home Assistant gives as a media player's entity_picture — a
 * path on HA (/api/media_player_proxy/...), fetched with the HA token — or
 * an absolute http(s) URL (Xbox box art). Results are cached in memory by
 * (src, size, format), so every remote in a room showing the same track
 * costs one download and one conversion.
 */

const crypto = require('crypto');
const sharp = require('sharp');

// mask1png: the remote's 1-bit picture (mask1) as a PNG, for the admin UI's
// remote screen previews.
const FORMATS = ['mask1', 'spectra', 'png', 'mask1png'];
// The viewport's whole panel (a photo background): 800x480.
const MAX_SIDE = 800;
const FETCH_TIMEOUT_MS = 8000;
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
const CACHE_ENTRIES = 48;

// The Spectra 6 panel's colours as they actually look, measured — for
// choosing the nearest ink while dithering. The reTerminal E1002's 7.3"
// panel is far darker than pure RGB: its white is a light grey, its green
// very dark. Values from esp32-photoframe's measured default calibration
// (github.com/aitjcize/esp32-photoframe, main/color_palette.c), which runs on
// this device; epaper-dithering's SPECTRA_7_3_6COLOR measurements agree.
const SPECTRA = [
  [190, 200, 200], // 0 white
  [2, 2, 2], // 1 black
  [135, 19, 0], // 2 red
  [205, 202, 0], // 3 yellow
  [39, 102, 60], // 4 green
  [5, 64, 158] // 5 blue
];

// The same six inks as the admin UI draws them (the PNG preview), matching
// the viewport preview's colours rather than the panel's dimmer ones.
const DISPLAY = [
  [255, 255, 255],
  [20, 20, 20],
  [178, 34, 34],
  [230, 196, 0],
  [46, 125, 50],
  [30, 70, 160]
];

const cache = new Map(); // key -> {body, type, width, height}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // most recently used goes last
    cache.set(key, hit);
  }
  return hit;
}

function cachePut(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function haOrigin(globals) {
  const ha = (globals && globals.homeAssistant) || {};
  if (!ha.host) return null;
  return { url: `http://${String(ha.host).trim()}:${Number(ha.port) || 8123}`, token: String(ha.token || '').trim() };
}

// The source image's bytes. An HA path goes to HA with its token; an
// absolute URL is fetched as is (with the token only if it's HA's own).
async function fetchSource(src, globals, resolve) {
  const ha = haOrigin(globals);
  let url;
  let headers = {};
  const resolved = resolve ? resolve(src) : null;
  if (resolved) {
    ({ url, headers } = resolved);
  } else if (src.startsWith('/')) {
    if (!ha) throw Object.assign(new Error('Home Assistant not configured'), { status: 409 });
    url = ha.url + src;
    if (ha.token) headers = { Authorization: `Bearer ${ha.token}` };
  } else if (/^https?:\/\//i.test(src)) {
    url = src;
    if (ha && ha.token && url.startsWith(ha.url)) headers = { Authorization: `Bearer ${ha.token}` };
  } else {
    throw Object.assign(new Error('src must be a Home Assistant path or an http(s) URL'), { status: 400 });
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`source answered HTTP ${res.status}`), { status: 502 });
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_SOURCE_BYTES) throw Object.assign(new Error('source image too large'), { status: 502 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SOURCE_BYTES) throw Object.assign(new Error('source image too large'), { status: 502 });
  return buf;
}

// Floyd–Steinberg over greyscale -> 1 bpp, 0 = ink. `threshold`: no
// dithering, each pixel just ink or paper — crisp for a logo (a picon's flat
// colours would otherwise come out speckled), where dithering suits a photo.
function toMask1(grey, w, h, { threshold = false } = {}) {
  if (threshold) {
    const rowBytes = Math.ceil(w / 8);
    const out = Buffer.alloc(rowBytes * h, 0xff);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grey[y * w + x] < 160) out[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
    return out;
  }
  const px = Float32Array.from(grey);
  const rowBytes = Math.ceil(w / 8);
  const out = Buffer.alloc(rowBytes * h, 0xff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = px[i];
      const ink = old < 128;
      const err = old - (ink ? 0 : 255);
      if (ink) out[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
      if (x + 1 < w) px[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) px[i + w - 1] += (err * 3) / 16;
        px[i + w] += (err * 5) / 16;
        if (x + 1 < w) px[i + w + 1] += err / 16;
      }
    }
  }
  return out;
}

// Squeeze the picture into the range the panel can show: each channel from
// 0..255 onto measured black..white. Without it, everything brighter than
// the panel's grey white is error the dither can never pay back, and it
// smears across the image as noise. Pure white lands exactly on the white
// ink (no error), pure black on the black one.
function fitToPanel(rgb) {
  const lo = SPECTRA[1];
  const hi = SPECTRA[0];
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) {
    const k = i % 3;
    out[i] = lo[k] + (rgb[i] * (hi[k] - lo[k])) / 255;
  }
  return out;
}

// sRGB -> CIELAB (D65). Nearest-ink matching is done here, not in RGB: in
// RGB a mid grey is closer to the panel's dark green than to its black or
// white ink, so greys came out as red/green/blue speckle.
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
function labF(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
function toLab(r, g, b) {
  const R = LINEAR[Math.min(255, Math.max(0, Math.round(r)))];
  const G = LINEAR[Math.min(255, Math.max(0, Math.round(g)))];
  const B = LINEAR[Math.min(255, Math.max(0, Math.round(b)))];
  const x = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const SPECTRA_LAB = SPECTRA.map((c) => toLab(c[0], c[1], c[2]));
// Hue/saturation counts a little more than lightness when picking an ink,
// so a grey never borrows a coloured one (tested: 0 coloured pixels in flat
// greys) while real greens, reds and blues still find theirs.
const CHROMA_WEIGHT = 1.5;

// Floyd–Steinberg -> the six panel colours (palette indices), in the panel's
// measured colours: the nearest ink by CIELAB distance, the error carried in
// RGB.
function toSpectraIndices(rgb, w, h) {
  const px = fitToPanel(rgb);
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const [L, a, b] = toLab(px[i], px[i + 1], px[i + 2]);
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < SPECTRA_LAB.length; c++) {
        const [pl, pa, pb] = SPECTRA_LAB[c];
        const d = (L - pl) ** 2 + CHROMA_WEIGHT * ((a - pa) ** 2 + (b - pb) ** 2);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      idx[y * w + x] = best;
      for (let k = 0; k < 3; k++) {
        const err = px[i + k] - SPECTRA[best][k];
        if (x + 1 < w) px[i + 3 + k] += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) px[i + (w - 1) * 3 + k] += (err * 3) / 16;
          px[i + w * 3 + k] += (err * 5) / 16;
          if (x + 1 < w) px[i + (w + 1) * 3 + k] += err / 16;
        }
      }
    }
  }
  return idx;
}

function packNibbles(idx, w, h) {
  const rowBytes = Math.ceil(w / 2);
  const out = Buffer.alloc(rowBytes * h, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = idx[y * w + x] & 0x0f;
      out[y * rowBytes + (x >> 1)] |= x & 1 ? v : v << 4;
    }
  }
  return out;
}

async function indicesToPng(idx, w, h) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const c = DISPLAY[idx[i]];
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/**
 * The prepared image: {body, type, width, height}. Throws an Error with a
 * `status` for the HTTP answer.
 */
// A mask1 bitmap (1 = paper, 0 = ink) as a black-and-white PNG.
function mask1ToPng(bits, w, h) {
  const rowBytes = Math.ceil(w / 8);
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

/**
 * `fit`: 'cover' (album art: fill the square, crop the rest) or 'contain'
 * (a logo such as a picon: the whole of it, on white). `position`: where a
 * cover crop keeps ('centre', or 'attention' for photos). `resolve(src)` may
 * turn a src into {url, headers} (a receiver's picon on the box, lib/enigma2).
 */
async function prepare(src, { width, height, format, fit = 'cover', position = 'centre' }, globals, resolve) {
  const w = Math.min(Math.max(Math.round(Number(width) || 0), 8), MAX_SIDE);
  const h = Math.min(Math.max(Math.round(Number(height) || 0), 8), MAX_SIDE);
  if (!FORMATS.includes(format)) throw Object.assign(new Error(`format must be one of ${FORMATS.join(', ')}`), { status: 400 });
  const fitMode = fit === 'contain' ? 'contain' : 'cover';
  // `attention`: a photo cropped around its most interesting part (faces,
  // detail, colour) rather than its middle.
  const pos = position === 'attention' ? sharp.strategy.attention : 'centre';
  const key = crypto.createHash('sha1').update(`${src}|${w}x${h}|${format}|${fitMode}|${position === 'attention' ? 'a' : 'c'}`).digest('hex');
  const hit = cacheGet(key);
  if (hit) return { ...hit, key };

  const source = await fetchSource(String(src), globals, resolve);
  // Transparent parts (a picon's background) become white, not black.
  const base = sharp(source).rotate().flatten({ background: '#ffffff' }).resize(w, h, { fit: fitMode, position: fitMode === 'cover' ? pos : 'centre', background: '#ffffff' }).removeAlpha();
  let out;
  if (format === 'mask1' || format === 'mask1png') {
    // A logo (fit contain) is thresholded, not normalised: stretching its
    // contrast would turn a pale background grey.
    const grey = fitMode === 'contain' ? await base.clone().greyscale().raw().toBuffer() : await base.clone().greyscale().normalise().raw().toBuffer();
    const bits = toMask1(grey, w, h, { threshold: fitMode === 'contain' });
    out =
      format === 'mask1png'
        ? { body: await mask1ToPng(bits, w, h), type: 'image/png', width: w, height: h }
        : { body: bits, type: 'application/octet-stream', width: w, height: h };
  } else {
    const rgb = await base.clone().toColourspace('srgb').raw().toBuffer();
    const idx = toSpectraIndices(rgb, w, h);
    out =
      format === 'png'
        ? { body: await indicesToPng(idx, w, h), type: 'image/png', width: w, height: h }
        : { body: packNibbles(idx, w, h), type: 'application/octet-stream', width: w, height: h };
  }
  cachePut(key, out);
  return { ...out, key };
}

module.exports = { FORMATS, SPECTRA, DISPLAY, prepare, fitToPanel, toMask1, mask1ToPng, toSpectraIndices, packNibbles };
