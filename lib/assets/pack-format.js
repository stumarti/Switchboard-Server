'use strict';

/**
 * Binary writers for the two files a device downloads and loads at runtime
 * (see the Switchboard firmware's include/icon_pack.h / include/font_pack.h
 * readers - this is the JS side of that shared format).
 *
 * Every offset field is an ABSOLUTE byte offset from the start of the file -
 * deliberately, so the firmware's loader can read the whole file into one
 * buffer and dereference `buf + offset` directly, with no per-section base
 * tracking. The one exception is a font glyph's own `bitmapOffset`, which
 * stays relative to THAT FACE's own bitmap blob start - this matches
 * FontGlyph's existing field semantics exactly (freeink-sdk's gen_font.py
 * already computes it that way), so a face's glyph table + bitmap blob can be
 * copied verbatim into the in-RAM BitmapFont the same shape it's produced in.
 *
 * Icon pack ("SBI1"):
 *   header:    magic[4]="SBI1", iconCount:u16, reserved:u16
 *   directory: iconCount x { name[24], w:u16, h:u16, opticalCenterY:i16,
 *                            bitsOffset:u32, bitsLength:u32 }   (38 bytes)
 *   data:      concatenated icon bitmap bytes (1bpp, MSB-first, matches
 *              freeink::Icon's existing format exactly)
 *
 * Font pack ("SBF1"):
 *   header:    magic[4]="SBF1", faceCount:u8, reserved[3]
 *   directory: faceCount x { slot[16], first:u16, last:u16, yAdvance:u8,
 *                            ascent:u8, maxW:u8, maxH:u8, bpp:u8,
 *                            glyphsOffset:u32, glyphsCount:u16,
 *                            bitmapOffset:u32, bitmapLength:u32 } (39 bytes)
 *   data:      concatenated per-face glyph tables (each glyph: 7 bytes -
 *              bitmapOffset:u16, width:u8, height:u8, xAdvance:u8,
 *              xOffset:i8, yOffset:i8 - matches FontGlyph field-for-field)
 *              followed by concatenated per-face bitmap blobs
 */

const NAME_FIELD_LEN = 24;
const SLOT_FIELD_LEN = 16;
const ICON_DIR_ENTRY_LEN = NAME_FIELD_LEN + 2 + 2 + 2 + 4 + 4; // 38
const FONT_DIR_ENTRY_LEN = SLOT_FIELD_LEN + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 4 + 2 + 4 + 4; // 39
const GLYPH_ENTRY_LEN = 2 + 1 + 1 + 1 + 1 + 1; // 7

function writeFixedString(buf, offset, str, len) {
  buf.fill(0, offset, offset + len);
  buf.write(String(str).slice(0, len), offset, len, 'ascii');
}

function writeIconsPack(icons) {
  const headerLen = 8;
  const dirLen = icons.length * ICON_DIR_ENTRY_LEN;
  const dataStart = headerLen + dirLen;

  let dataLen = 0;
  const offsets = icons.map((icon) => {
    const off = dataStart + dataLen;
    dataLen += icon.bits.length;
    return off;
  });

  const out = Buffer.alloc(dataStart + dataLen);
  out.write('SBI1', 0, 4, 'ascii');
  out.writeUInt16LE(icons.length, 4);
  out.writeUInt16LE(0, 6);

  icons.forEach((icon, i) => {
    const entryOff = headerLen + i * ICON_DIR_ENTRY_LEN;
    writeFixedString(out, entryOff, icon.name, NAME_FIELD_LEN);
    let p = entryOff + NAME_FIELD_LEN;
    out.writeUInt16LE(icon.w, p); p += 2;
    out.writeUInt16LE(icon.h, p); p += 2;
    out.writeInt16LE(icon.opticalCenterY, p); p += 2;
    out.writeUInt32LE(offsets[i], p); p += 4;
    out.writeUInt32LE(icon.bits.length, p);
    icon.bits.copy(out, offsets[i]);
  });

  return out;
}

function writeFontsPack(faces) {
  const headerLen = 8;
  const dirLen = faces.length * FONT_DIR_ENTRY_LEN;

  // Two data regions after the directory: all glyph tables, then all bitmap
  // blobs - computed in two passes so both regions' absolute offsets are
  // known before anything is written.
  let glyphsRegionLen = 0;
  const glyphsOffsets = faces.map((face) => {
    const off = glyphsRegionLen;
    glyphsRegionLen += face.glyphs.length * GLYPH_ENTRY_LEN;
    return off;
  });
  const glyphsRegionStart = headerLen + dirLen;

  let bitmapRegionLen = 0;
  const bitmapOffsets = faces.map((face) => {
    const off = bitmapRegionLen;
    bitmapRegionLen += face.bitmap.length;
    return off;
  });
  const bitmapRegionStart = glyphsRegionStart + glyphsRegionLen;

  const out = Buffer.alloc(bitmapRegionStart + bitmapRegionLen);
  out.write('SBF1', 0, 4, 'ascii');
  out.writeUInt8(faces.length, 4);
  out.writeUInt8(0, 5); out.writeUInt8(0, 6); out.writeUInt8(0, 7);

  faces.forEach((face, i) => {
    const entryOff = headerLen + i * FONT_DIR_ENTRY_LEN;
    writeFixedString(out, entryOff, face.slot, SLOT_FIELD_LEN);
    let p = entryOff + SLOT_FIELD_LEN;
    out.writeUInt16LE(face.first, p); p += 2;
    out.writeUInt16LE(face.last, p); p += 2;
    out.writeUInt8(face.yAdvance, p); p += 1;
    out.writeUInt8(face.ascent, p); p += 1;
    out.writeUInt8(face.maxW, p); p += 1;
    out.writeUInt8(face.maxH, p); p += 1;
    out.writeUInt8(face.bpp, p); p += 1;
    const glyphsAbsOffset = glyphsRegionStart + glyphsOffsets[i];
    const bitmapAbsOffset = bitmapRegionStart + bitmapOffsets[i];
    out.writeUInt32LE(glyphsAbsOffset, p); p += 4;
    out.writeUInt16LE(face.glyphs.length, p); p += 2;
    out.writeUInt32LE(bitmapAbsOffset, p); p += 4;
    out.writeUInt32LE(face.bitmap.length, p);

    face.glyphs.forEach((g, gi) => {
      let gp = glyphsAbsOffset + gi * GLYPH_ENTRY_LEN;
      out.writeUInt16LE(g.bitmapOffset, gp); gp += 2;
      out.writeUInt8(g.width, gp); gp += 1;
      out.writeUInt8(g.height, gp); gp += 1;
      out.writeUInt8(g.xAdvance, gp); gp += 1;
      out.writeInt8(g.xOffset, gp); gp += 1;
      out.writeInt8(g.yOffset, gp);
    });

    face.bitmap.copy(out, bitmapAbsOffset);
  });

  return out;
}

module.exports = { writeIconsPack, writeFontsPack };
