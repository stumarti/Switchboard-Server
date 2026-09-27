'use strict';

/**
 * Font pack compiler: from one uploaded/fetched TTF/OTF, rasterizes all 5
 * faces the firmware uses (see font-slots.js) into the exact format
 * freeink::ui::BitmapFont/FontGlyph already use (freeink-sdk's
 * FreeInkUIFont.h), and packages them via pack-format.js.
 *
 * This replaces Pillow (tools/gen_font.py's rasterizer) with `opentype.js`
 * (outlines/metrics, pure JS) + `sharp` (SVG->raster, reading the alpha
 * channel as anti-aliased ink coverage - a solid black fill on transparent
 * background makes alpha *be* coverage directly, no white-background/
 * luminance trick needed).
 *
 * IMPORTANT packing detail, easy to get wrong: unlike Icon bitmaps (which
 * pad every row to a byte boundary - see icons.js/pack-format.js), a font
 * glyph's bitmap is a CONTINUOUS bitstream with no per-row padding - matches
 * gen_font.py's own packer exactly (1bpp: 8 pixels/byte MSB-first straight
 * across row boundaries; 4bpp/--alpha: 2 pixels/byte high-nibble-first,
 * same continuous packing). Row-padding this would silently misalign every
 * glyph after the first on any row whose width isn't a multiple of 8 (1bpp)
 * or 2 (4bpp).
 */

const opentype = require('opentype.js');
const sharp = require('sharp');

const fontSlots = require('./font-slots');
const { writeFontsPack } = require('./pack-format');

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Rasterize one glyph's outline to a raw alpha-coverage buffer sized to its
// own bounding box (plus a 1px margin, matching gen_font.py's `r+2, b+2`
// canvas oversizing so anti-aliased edges never clip).
async function rasterizeGlyphAlpha(glyph, sizePx, bbox) {
  const w = Math.ceil(bbox.x2 - bbox.x1) + 2;
  const h = Math.ceil(bbox.y2 - bbox.y1) + 2;
  const d = glyph.getPath(-bbox.x1 + 1, -bbox.y1 + 1, sizePx).toPathData(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${d}" fill="black"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg), { density: 96 * 4 })
    .resize(w, h) // no-op resize, just pins exact pixel dimensions
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  return { alpha: data, width: info.width, height: info.height };
}

// Continuous (non-row-padded) bit packer shared by both bit depths - append
// values one at a time, an accumulator flushes to `out` once it holds a full
// byte. `bitsPerValue` is 1 (1bpp mask) or 4 (coverage nibble).
function makeBitAppender(out, bitsPerValue) {
  let acc = 0;
  let bits = 0;
  const perByte = 8 / bitsPerValue;
  return {
    push(value) {
      acc = (acc << bitsPerValue) | value;
      bits += 1;
      if (bits === perByte) {
        out.push(acc);
        acc = 0;
        bits = 0;
      }
    },
    finish() {
      if (bits > 0) out.push(acc << (bitsPerValue * (perByte - bits)));
    }
  };
}

async function rasterizeFace(font, unitsPerEm, face) {
  const scale = face.size / unitsPerEm;
  const ascentPx = Math.round(font.ascender * scale);
  const descentPx = Math.round(-font.descender * scale);
  const yAdvance = ascentPx + descentPx;

  const bitmapBytes = [];
  const glyphs = [];
  let maxW = 0;
  let maxH = 0;
  const appender = makeBitAppender(bitmapBytes, face.alpha ? 4 : 1);

  for (let cp = face.first; cp <= face.last; cp++) {
    const glyph = font.charToGlyph(String.fromCodePoint(cp));
    const xAdvance = Math.round(glyph.advanceWidth * scale);
    const path = glyph.getPath(0, 0, face.size);
    const bbox = path.getBoundingBox();
    const w = bbox.x2 - bbox.x1;
    const h = bbox.y2 - bbox.y1;

    if (!(w > 0 && h > 0)) {
      glyphs.push({ bitmapOffset: bitmapBytes.length, width: 0, height: 0, xAdvance, xOffset: 0, yOffset: 0 });
      continue;
    }

    const { alpha, width, height } = await rasterizeGlyphAlpha(glyph, face.size, bbox);
    const bitmapOffset = bitmapBytes.length;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = alpha[(y * width + x) * 4 + 3];
        if (face.alpha) {
          appender.push(Math.round((a * 15) / 255));
        } else {
          appender.push(a >= 128 ? 1 : 0);
        }
      }
    }

    glyphs.push({
      bitmapOffset,
      width,
      height,
      xAdvance,
      xOffset: Math.round(bbox.x1),
      yOffset: Math.round(bbox.y1)
    });
    maxW = Math.max(maxW, width);
    maxH = Math.max(maxH, height);
  }
  appender.finish();

  return {
    slot: face.slot,
    first: face.first,
    last: face.last,
    yAdvance,
    ascent: ascentPx,
    maxW,
    maxH,
    bpp: face.alpha ? 4 : 1,
    glyphs,
    bitmap: Buffer.from(bitmapBytes)
  };
}

async function compileFontsPack(ttfBuffer) {
  const font = opentype.parse(toArrayBuffer(ttfBuffer));
  const faces = [];
  for (const face of fontSlots.listFaces()) {
    faces.push(await rasterizeFace(font, font.unitsPerEm, face));
  }
  return writeFontsPack(faces);
}

module.exports = { compileFontsPack };
