'use strict';

/**
 * Fetches a TTF for a Google Fonts family name, as a convenience alongside
 * uploading your own font file (see server.js's POST /api/assets/fonts/
 * compile). No new dependency - Google Fonts' CSS endpoint is public and
 * plain `https.get` is enough.
 *
 * The trick: Google Fonts' CSS response links a `.woff2` file by default,
 * but serves a legacy `.ttf` instead when the request's User-Agent looks
 * like a browser too old to support woff2 - which is exactly the format
 * this compiler's rasterizer (opentype.js) wants, with no decompression
 * step needed.
 */

const https = require('https');

// Old enough that Google Fonts' CSS endpoint links a plain .ttf ("format
// ('truetype')") instead of .woff2/.woff/EOT - verified empirically against
// fonts.googleapis.com (newer UAs get woff2 or woff; ancient MSIE UAs get a
// wrapped EOT `l/font?kit=...` URL, neither of which opentype.js parses).
const LEGACY_USER_AGENT = 'Mozilla/5.0 (X11; U; Linux i686; en-US) AppleWebKit/534.7';

function get(url, extraHeaders, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: extraHeaders }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(get(res.headers.location, extraHeaders, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function fetchGoogleFontTtf(familyName) {
  const family = String(familyName || '').trim();
  if (!family) throw new Error('familyName is required');

  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`;
  const css = (await get(cssUrl, { 'User-Agent': LEGACY_USER_AGENT })).toString('utf8');

  const match = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(css);
  if (!match) {
    throw new Error(`no .ttf source found for Google Font "${family}" (check the family name)`);
  }

  return get(match[1], { 'User-Agent': LEGACY_USER_AGENT });
}

module.exports = { fetchGoogleFontTtf };
