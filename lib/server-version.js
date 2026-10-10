'use strict';

/**
 * Is there a newer Switchboard Server? Asks GitHub for the repository's
 * latest release, soon after starting and then twice a day, and remembers
 * the answer: the Home page and Settings → About show it. Nothing is sent
 * but the request itself, and nothing is installed: updating is still a
 * `docker pull` (or a `git pull`) by hand.
 *
 * DISABLE_UPDATE_CHECK=1 turns it off. A "dev" build (no version set) still
 * asks, but is never told it's behind: it can't tell.
 */

const REPO = 'stumarti/Switchboard-Server';
const RELEASES = `https://github.com/${REPO}/releases`;
const EVERY_MS = 12 * 60 * 60 * 1000;
const FIRST_AFTER_MS = 60 * 1000;
const TIMEOUT_MS = 15000;

// "v1.2.3", "1.2", "1.2.3-beta.1" -> {nums: [1, 2, 3], pre: 'beta.1'};
// anything else (e.g. "dev") -> null.
function parse(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || '' };
}

/** Sign of a - b as versions (a pre-release before its release); null if either isn't one. */
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** One check: what GitHub says the latest release is, against `current`. */
async function check({ current, fetchImpl = fetch, now = Date.now() } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const base = { current, checkedAt: new Date(now).toISOString() };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Switchboard', Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) return { ...base, latest: null, newer: false, url: RELEASES, error: 'No releases yet' };
    if (res.status === 403 || res.status === 429) throw new Error(`GitHub refused (HTTP ${res.status}): it may be limiting requests from this server. It will try again later`);
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    const r = await res.json();
    const latest = String(r.tag_name || '').replace(/^v/i, '');
    if (!parse(latest)) throw new Error(`The latest release's tag (${r.tag_name || 'none'}) isn't a version`);
    const cmp = compare(current, latest);
    return {
      ...base,
      latest,
      newer: cmp != null && cmp < 0,
      // A "dev" build, or one that doesn't parse: we can't say.
      known: cmp != null,
      name: String(r.name || '') || `v${latest}`,
      url: String(r.html_url || '') || RELEASES,
      publishedAt: r.published_at || null,
      error: ''
    };
  } catch (e) {
    return { ...base, latest: null, newer: false, url: RELEASES, error: e.name === 'AbortError' ? 'GitHub took too long to answer' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The checker the server runs: start() schedules it, status() is the last
 * answer (or that it's off, or not asked yet), checkNow() asks again.
 * A failed check keeps the last good answer's release, with the error.
 */
function createChecker({ current, enabled = true, fetchImpl, log = () => {} } = {}) {
  let last = null;
  let running = null;
  let timer = null;

  async function checkNow() {
    if (!enabled) return status();
    if (!running) {
      running = check({ current, fetchImpl })
        .then((r) => {
          if (r.error && last && last.latest) {
            last = { ...last, error: r.error, checkedAt: r.checkedAt };
          } else {
            last = r;
          }
          if (r.error) log(`[version] check failed: ${r.error}`);
          else if (r.newer) log(`[version] Switchboard Server ${r.latest} is out (this is ${current})`);
          return last;
        })
        .finally(() => {
          running = null;
        });
    }
    await running;
    return status();
  }

  function status() {
    if (!enabled) return { current, enabled: false, latest: null, newer: false, url: RELEASES };
    return { enabled: true, ...(last || { current, latest: null, newer: false, url: RELEASES, checkedAt: null, error: '' }) };
  }

  function start() {
    if (!enabled || timer) return;
    const first = setTimeout(() => {
      checkNow();
      timer = setInterval(checkNow, EVERY_MS);
      timer.unref?.();
    }, FIRST_AFTER_MS);
    first.unref?.();
    timer = first;
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, checkNow, status };
}

module.exports = { parse, compare, check, createChecker, REPO, RELEASES };
