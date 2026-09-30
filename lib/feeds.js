'use strict';

/**
 * News feeds for the viewport's Announcements section: a company's RSS 2.0,
 * RSS 1.0 (RDF) or Atom feed, read on the server so the panel only ever
 * gets finished lines of text.
 *
 * No XML library: feeds are small, and only a handful of elements matter
 * (item/entry, title, description/summary/content, link, the date), read
 * with a tolerant tag scanner that copes with CDATA, namespaces and entities.
 *
 * Each URL is cached for CACHE_MS and read at most once at a time; a failure
 * keeps the last good copy and isn't retried for RETRY_MS, so a feed that's
 * down doesn't slow every refresh.
 */

const CACHE_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 20;

const cache = new Map(); // url -> { at, items, failedAt, error, pending }

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// Plain text from a feed field: CDATA unwrapped, HTML tags dropped (block
// tags become spaces), entities decoded (twice: feeds often escape their
// HTML, which then carries its own entities), whitespace collapsed.
function plainText(raw) {
  let s = String(raw || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

// The inner text of the first <tag> (any namespace prefix) in `xml`.
function field(xml, ...tags) {
  for (const tag of tags) {
    const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, 'i');
    const m = xml.match(re);
    if (m && m[1] != null && m[1].trim()) return m[1];
  }
  return '';
}

// Atom's <link rel="alternate" href="..."/>, else RSS's <link>text</link>.
function linkOf(xml) {
  const atom = xml.match(/<(?:[\w-]+:)?link\b[^>]*?href=["']([^"']+)["'][^>]*>/i);
  if (atom && !/rel=["'](?!alternate)/i.test(atom[0])) return decodeEntities(atom[1]);
  return plainText(field(xml, 'link'));
}

function dateOf(xml) {
  const raw = plainText(field(xml, 'pubDate', 'published', 'updated', 'date', 'issued'));
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * The items of a feed document, newest first: [{title, summary, link, date}].
 * An item with neither a title nor a summary is left out.
 */
function parseFeed(xml) {
  const text = String(xml || '');
  const blocks = text.match(/<(?:[\w-]+:)?(item|entry)\b[\s\S]*?<\/(?:[\w-]+:)?\1>/gi) || [];
  const items = blocks
    .map((b) => ({
      title: plainText(field(b, 'title')),
      summary: plainText(field(b, 'description', 'summary', 'encoded', 'content')),
      link: linkOf(b),
      date: dateOf(b)
    }))
    .filter((it) => it.title || it.summary);
  // Newest first when the feed gives dates; otherwise its own order.
  if (items.some((it) => it.date)) items.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  return items.slice(0, MAX_ITEMS);
}

async function download(url, fetchImpl = fetch) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('a feed address must start with http:// or https://');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(u.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'User-Agent': 'Switchboard' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('the feed is too large');
    return body;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'the feed took too long to answer' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// Read one feed now (at most one read per URL at a time).
function refresh(url, { fetchImpl } = {}) {
  const entry = cache.get(url) || { at: 0, items: [], failedAt: 0, error: '', pending: null };
  cache.set(url, entry);
  if (entry.pending) return entry.pending;
  entry.pending = download(url, fetchImpl)
    .then((xml) => {
      const items = parseFeed(xml);
      if (!items.length && !/<(?:[\w-]+:)?(rss|feed|RDF)\b/i.test(xml)) throw new Error("that address isn't an RSS or Atom feed");
      entry.items = items;
      entry.at = Date.now();
      entry.error = '';
      return entry;
    })
    .catch((e) => {
      entry.failedAt = Date.now();
      entry.error = e.message;
      return entry;
    })
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

/**
 * A feed's items, from the cache when fresh; read (and waited for) when the
 * cache is stale, unless it failed a moment ago. {items, error, at}.
 */
async function itemsFor(url, opts = {}) {
  const now = Date.now();
  const entry = cache.get(url);
  const stale = !entry || now - entry.at > CACHE_MS;
  const backingOff = entry && entry.failedAt && now - entry.failedAt < RETRY_MS && entry.failedAt > entry.at;
  const e = stale && !backingOff ? await refresh(url, opts) : entry;
  return { items: e.items, error: e.error, at: e.at ? new Date(e.at) : null };
}

function clearCache() {
  cache.clear();
}

module.exports = { parseFeed, plainText, itemsFor, refresh, clearCache };
