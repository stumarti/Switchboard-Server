'use strict';

// node --test: the viewport's Announcements section — RSS 2.0, Atom and
// RSS 1.0 feeds read on the server (lib/feeds.js), then the newest few
// items as finished lines (lib/dashboard-state.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const feeds = require('../lib/feeds');
const dashboard = require('../lib/dashboard');
const state = require('../lib/dashboard-state');

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Acme News</title>
  <item>
    <title>Office closed Friday</title>
    <link>https://intranet.acme.test/news/1</link>
    <pubDate>Mon, 28 Sep 2026 09:30:00 GMT</pubDate>
    <description><![CDATA[<p>The office is <b>closed</b> on Friday for the move.</p><p>Work from home &amp; enjoy!</p>]]></description>
  </item>
  <item>
    <title>Q3 results &amp; town hall</title>
    <pubDate>Tue, 29 Sep 2026 14:00:00 GMT</pubDate>
    <description>&lt;p&gt;Join us in the atrium at 4pm.&lt;/p&gt;</description>
  </item>
  <item><title>An old one</title><pubDate>Mon, 01 Jun 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Acme blog</title>
  <entry>
    <title type="html">New canteen menu</title>
    <link rel="alternate" href="https://acme.test/blog/menu"/>
    <updated>2026-09-29T08:00:00Z</updated>
    <summary>Soup of the day is back.</summary>
  </entry>
</feed>`;

const RDF = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item><title>Fire drill at 11</title><dc:date>2026-09-30T07:00:00Z</dc:date><description>Leave by the stairs.</description></item>
</rdf:RDF>`;

test('feeds: RSS 2.0, Atom and RSS 1.0 — newest first, as plain text', () => {
  const rss = feeds.parseFeed(RSS);
  assert.deepEqual(rss.map((i) => i.title), ['Q3 results & town hall', 'Office closed Friday', 'An old one']);
  assert.equal(rss[0].summary, 'Join us in the atrium at 4pm.'); // escaped HTML, unescaped then stripped
  assert.equal(rss[1].summary, 'The office is closed on Friday for the move. Work from home & enjoy!');
  assert.equal(rss[1].link, 'https://intranet.acme.test/news/1');
  assert.equal(rss[1].date.toISOString(), '2026-09-28T09:30:00.000Z');

  const atom = feeds.parseFeed(ATOM);
  assert.deepEqual(atom, [{ title: 'New canteen menu', summary: 'Soup of the day is back.', link: 'https://acme.test/blog/menu', date: new Date('2026-09-29T08:00:00Z') }]);

  const rdf = feeds.parseFeed(RDF);
  assert.equal(rdf[0].title, 'Fire drill at 11');
  assert.equal(rdf[0].date.toISOString(), '2026-09-30T07:00:00.000Z');
  assert.deepEqual(feeds.parseFeed('<html><body>Not a feed</body></html>'), []);
});

test('feeds: cached, and a failing feed keeps its last copy without being asked again at once', async () => {
  feeds.clearCache();
  let calls = 0;
  let down = false;
  const fetchImpl = async () => {
    calls += 1;
    if (down) throw new Error('fetch failed');
    return { ok: true, status: 200, text: async () => RSS };
  };
  const url = 'https://intranet.acme.test/news/rss';
  const a = await feeds.itemsFor(url, { fetchImpl });
  assert.equal(a.items.length, 3);
  assert.equal(a.error, '');
  await feeds.itemsFor(url, { fetchImpl });
  assert.equal(calls, 1); // from the cache

  // Stale and failing: the last good items stay, with the error.
  down = true;
  const r = await feeds.refresh(url, { fetchImpl });
  assert.equal(r.error, 'fetch failed');
  assert.equal(r.items.length, 3);

  // A page that isn't a feed says so.
  feeds.clearCache();
  const html = await feeds.refresh('https://acme.test/', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>hi</html>' }) });
  assert.match(html.error, /isn't an RSS or Atom feed/);
  const bad = await feeds.refresh('ftp://acme.test/feed');
  assert.match(bad.error, /http/);
});

test('announcements section: the newest few, shortened, dated, oldest ones hidden', () => {
  const url = 'https://intranet.acme.test/news/rss';
  const layout = dashboard.normalizeLayout({
    screens: [{
      id: 'home',
      title: 'Home',
      template: 'single',
      columns: [[{ id: 'a', type: 'announcements', title: 'Acme', url, count: 2, maxAgeDays: 30, color: 5 }]]
    }]
  });
  const s = layout.screens[0].columns[0][0];
  assert.deepEqual([s.count, s.summary, s.showDate, s.maxAgeDays, s.color], [2, true, true, 30, 5]);

  const items = feeds.parseFeed(RSS);
  items[0].summary = `${'A very long announcement '.repeat(20)}end.`;
  const now = new Date('2026-09-30T10:00:00Z');
  const out = state.buildScreens(layout, { now, timeZone: 'Europe/London', feeds: { [url]: { items, error: '' } } });
  const d = out.home.columns[0][0].data;
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].title, 'Q3 results & town hall');
  assert.ok(d.items[0].summary.length <= 221 && d.items[0].summary.endsWith('…'));
  assert.equal(d.items[0].when, 'yesterday');
  assert.equal(d.color, 5);
  assert.equal(d.empty, '');

  // Everything older than the limit: none shown, and it says why.
  const old = state.buildScreens(layout, { now: new Date('2027-01-01T00:00:00Z'), timeZone: 'Europe/London', feeds: { [url]: { items, error: '' } } });
  assert.equal(old.home.columns[0][0].data.empty, 'No announcements');
  // A feed that can't be read, never read before.
  const down = state.buildScreens(layout, { now, timeZone: 'Europe/London', feeds: { [url]: { items: [], error: 'HTTP 404' } } });
  assert.equal(down.home.columns[0][0].data.empty, "Couldn't read the feed");
});
