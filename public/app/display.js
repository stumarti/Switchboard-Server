// A TV's display page (/display): one viewport layout on the whole screen,
// live, in full colour. The Switchboard TV app opens it; any browser can.
//
// The page is a viewport as the server knows it. On its first visit it
// makes up an id (a locally administered MAC, kept in this browser), asks
// to pair (POST /api/pairing/register, type viewport) and shows that id
// until it's approved on the server's Viewports page, where it gets its
// layout like any other. Its token stays in this browser too, and as a
// cookie for the photos (an <img> can't send it). Then it reads its layout
// (/api/viewports/me/bundle) and every screen's state at once
// (/api/viewports/me/state) and draws them as the admin preview does
// (viewport-preview.js), with:
//   the remote's arrows   previous / next screen, OK the first one;
//   the carousel          the layout's own: stay, advance, or back to the
//                         first screen, every N minutes;
//   burn-in               the whole picture shifts a few pixels now and then.
// ?app=<version> is the TV app (it says so as X-Board androidtv); ?id= an id
// of its own; ?name= what to call it at first.

import { html, render, useState, useEffect, useRef, useCallback } from './lib.js';
import { ViewportPreview } from './viewport-preview.js';
import { display } from './viewport-display.js';

display.tv = true;

const params = new URLSearchParams(location.search);
const APP = params.get('app') || '';
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const STATE_EVERY_MS = 60 * 1000;
const BUNDLE_EVERY_MS = 10 * 60 * 1000;
const PAIR_POLL_MS = 5000;
const SHIFT_EVERY_MS = 3 * 60 * 1000;

const saved = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch (_) {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (_) {
      /* a private window: pairs again next time */
    }
  }
};

// A locally administered MAC: never a real network card's.
function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  b[0] = (b[0] & 0xfc) | 0x02;
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
}
const ID = (() => {
  const given = (params.get('id') || '').toLowerCase();
  const id = MAC_RE.test(given) ? given : saved.get('sb_display_id') || newId();
  saved.set('sb_display_id', id);
  return id;
})();

function headers(token) {
  const h = { 'X-Board': APP ? 'androidtv' : 'browser' };
  if (APP) h['X-Firmware'] = APP;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}
async function getJson(path, token) {
  const r = await fetch(path, { headers: headers(token) });
  if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status });
  return r.json();
}

// Pairing: until approved, the id to look for on the server.
async function pair() {
  const r = await fetch('/api/pairing/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: ID, type: 'viewport', name: params.get('name') || (APP ? 'TV' : 'Browser display') })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { status: 'error', error: j.error || `${r.status}` };
  if (j.status === 'approved' && j.token) {
    saved.set('sb_display_token', j.token);
    // The same token as a cookie, for the photos.
    await fetch('/api/display/session', { method: 'POST', headers: headers(j.token) }).catch(() => {});
  }
  return j;
}

function Message({ title, children }) {
  return html`<div class="display-msg"><h1>${title}</h1>${children}</div>`;
}

function Screens({ token, onLost }) {
  const [bundle, setBundle] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [at, setAt] = useState(0);
  const [shift, setShift] = useState([0, 0]);
  const lastKey = useRef(Date.now());

  const load = useCallback(async (what) => {
    try {
      if (what === 'bundle') setBundle(await getJson('/api/viewports/me/bundle', token));
      else {
        const s = await getJson('/api/viewports/me/state', token);
        setState({ ...s, screens: Object.fromEntries(Object.entries(s.screens || {}).map(([k, v]) => [k, v.data])) });
      }
      setError('');
    } catch (e) {
      if (e.status === 401 || e.status === 403) onLost();
      else setError(e.status === 409 ? 'Home Assistant isn’t connected to the server.' : 'Can’t reach Switchboard Server.');
    }
  }, [token]);

  useEffect(() => {
    load('bundle');
    load('state');
    const b = setInterval(() => load('bundle'), BUNDLE_EVERY_MS);
    const s = setInterval(() => load('state'), STATE_EVERY_MS);
    const m = setInterval(() => setShift([Math.round(Math.random() * 8 - 4), Math.round(Math.random() * 8 - 4)]), SHIFT_EVERY_MS);
    return () => [b, s, m].forEach((t) => clearInterval(t));
  }, [load]);

  const layout = bundle && bundle.layout;
  const screens = layout ? layout.screens.filter((s) => s.enabled !== false) : [];
  const n = screens.length;
  const go = (i) => {
    lastKey.current = Date.now();
    setAt(((i % n) + n) % n);
  };

  // The remote: arrows page, OK goes home.
  useEffect(() => {
    const onKey = (e) => {
      if (!n) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(at - 1);
      else if (e.key === 'Enter') go(0);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at, n]);

  // The layout's carousel: on, or back to the first screen, every N minutes.
  useEffect(() => {
    if (!layout || n < 2) return undefined;
    const { mode, everyMin } = layout.carousel || {};
    if (mode !== 'advance' && mode !== 'returnFirst') return undefined;
    const t = setInterval(() => {
      if (Date.now() - lastKey.current < everyMin * 60000) return;
      lastKey.current = Date.now();
      setAt((i) => (mode === 'advance' ? (i + 1) % n : 0));
    }, 15000);
    return () => clearInterval(t);
  }, [layout, n]);

  if (bundle && !bundle.assigned) {
    return html`<${Message} title="Approved">
      <p>Now choose what this screen shows: on Switchboard Server, open <b>Viewports → ${bundle.name}</b> and pick a layout.</p>
    <//>`;
  }
  if (!layout || !state) {
    return html`<${Message} title=${error ? 'Not connected' : 'Loading…'}>${error && html`<p>${error}</p><p class="hint">Trying again every minute.</p>`}<//>`;
  }
  const portrait = layout.rotation === 90 || layout.rotation === 270;
  const current = screens[Math.min(at, n - 1)];
  // Photos at the TV's own pixels: the layout's 480 px tall, times the screen.
  display.scale = Math.min(4, ((portrait ? window.innerWidth : window.innerHeight) / 480) * (window.devicePixelRatio || 1));
  return html`<div style=${{ position: 'absolute', inset: '0', transform: `translate(${shift[0]}px, ${shift[1]}px)` }}>
    <${ViewportPreview} screen=${current && current.id} state=${state} carousel=${screens.map((s) => ({ id: s.id, icon: s.icon }))}
      portrait=${portrait} device="tv" fill=${true} error=${error} />
  </div>`;
}

function App() {
  const [token, setToken] = useState(saved.get('sb_display_token'));
  const [pairing, setPairing] = useState(null);

  // Not paired (or no longer): ask, and keep asking until approved.
  useEffect(() => {
    if (token) return undefined;
    let live = true;
    let timer = null;
    const ask = async () => {
      const j = await pair().catch(() => ({ status: 'error', error: 'Can’t reach Switchboard Server' }));
      if (!live) return;
      setPairing(j);
      if (j.status === 'approved' && j.token) setToken(j.token);
      else timer = setTimeout(ask, PAIR_POLL_MS);
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [token]);

  if (token) {
    return html`<${Screens} token=${token} onLost=${() => {
      saved.set('sb_display_token', null);
      setToken(null);
    }} />`;
  }
  if (pairing && pairing.status === 'revoked') {
    return html`<${Message} title="Turned off"><p>This screen was revoked on Switchboard Server. Approve it again from its Viewports page to show it here.</p><code>${ID}</code><//>`;
  }
  if (pairing && pairing.status === 'error') {
    return html`<${Message} title="Can’t pair"><p>${pairing.error === 'not accepting new devices' ? 'The server isn’t accepting new devices. Turn on Settings → Pairing → New devices.' : pairing.error}</p><p class="hint">Trying again…</p><//>`;
  }
  return html`<${Message} title="SWITCHBOARD">
    <p>Approve this screen on Switchboard Server (<b>Home</b> or <b>Viewports</b>) and pick its layout. It’s listed as</p>
    <code>${ID}</code>
    <p class="hint">It appears here once it’s approved.</p>
  <//>`;
}

render(html`<${App} />`, document.getElementById('root'));
