'use strict';

/**
 * The 5 font faces the Switchboard firmware binds in Ui::begin() (ui.h),
 * mirrored by include/default_font_table.h in the firmware repo. Unlike
 * icons (one replacement per slot), a single uploaded/fetched TTF produces
 * all 5 faces at once - matches tools/gen_atkinson_fonts.sh exactly, which
 * rasterizes one source font (Atkinson Hyperlegible) into every face the
 * firmware uses.
 *
 * `alpha: true` + a restricted `first`/`last` range is the digits-only
 * anti-aliased face used for the Standby/Climate temperature readout -
 * everything else is the full ASCII 0x20-0x7E range, 1bpp.
 */

const FONT_FACES = [
  { slot: 'small', size: 14, first: 0x20, last: 0x7e, alpha: false, label: 'Small (status bar / chrome)' },
  { slot: 'default', size: 24, first: 0x20, last: 0x7e, alpha: false, label: 'Default (body text)' },
  { slot: 'temp', size: 68, first: 0x2d, last: 0x39, alpha: true, label: 'Temperature readout (digits only)' },
  { slot: 'font12', size: 12, first: 0x20, last: 0x7e, alpha: false, label: '12px' },
  { slot: 'font28', size: 28, first: 0x20, last: 0x7e, alpha: false, label: '28px' }
];

function listFaces() {
  return FONT_FACES;
}

module.exports = { listFaces };
