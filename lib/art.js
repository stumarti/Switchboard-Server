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
 *            viewport panel, dithered to that palette
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

const FORMATS = ['mask1', 'spectra', 'png'];
const MAX_SIDE = 480;
const FETCH_TIMEOUT_MS = 8000;
const MAX_SOURCE_BYTES = 6 * 1024 * 1024;
const CACHE_ENTRIES = 48;

// The panel's colours as they actually print, for choosing the nearest.
const SPECTRA = [
  [255, 255, 255], // 0 white
  [20, 20, 20], // 1 black
  [178, 34, 34], // 2 red
  [230, 196, 0], // 3 yellow
  [46, 125, 50], // 4 green
  [30, 70, 160] // 5 blue
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
async function fetchSource(src, globals) {
  const ha = haOrigin(globals);
  let url;
  let headers = {};
  if (src.startsWith('/')) {
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

// Floyd–Steinberg over greyscale -> 1 bpp, 0 = ink.
function toMask1(grey, w, h) {
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

// Floyd–Steinberg over RGB -> the six panel colours (palette indices).
function toSpectraIndices(rgb, w, h) {
  const px = Float32Array.from(rgb);
  const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < SPECTRA.length; c++) {
        const dr = px[i] - SPECTRA[c][0];
        const dg = px[i + 1] - SPECTRA[c][1];
        const db = px[i + 2] - SPECTRA[c][2];
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
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
    const c = SPECTRA[idx[i]];
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
async function prepare(src, { width, height, format }, globals) {
  const w = Math.min(Math.max(Math.round(Number(width) || 0), 8), MAX_SIDE);
  const h = Math.min(Math.max(Math.round(Number(height) || 0), 8), MAX_SIDE);
  if (!FORMATS.includes(format)) throw Object.assign(new Error(`format must be one of ${FORMATS.join(', ')}`), { status: 400 });
  const key = crypto.createHash('sha1').update(`${src}|${w}x${h}|${format}`).digest('hex');
  const hit = cacheGet(key);
  if (hit) return { ...hit, key };

  const source = await fetchSource(String(src), globals);
  const base = sharp(source).rotate().resize(w, h, { fit: 'cover' }).removeAlpha();
  let out;
  if (format === 'mask1') {
    const grey = await base.clone().greyscale().normalise().raw().toBuffer();
    out = { body: toMask1(grey, w, h), type: 'application/octet-stream', width: w, height: h };
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

module.exports = { FORMATS, SPECTRA, prepare, toMask1, toSpectraIndices, packNibbles };
