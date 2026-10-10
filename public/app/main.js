// App shell: sign-in gate, hash routing, the icon rail (Home / Layouts /
// Remotes / Viewports / Settings), the section's own column of links beside
// it (nav.js; for Remotes and Viewports, the list of devices) and the page,
// with its page bar on top. Each page lives in its own module.

import { html, render, useState, useEffect, useCallback, api, setUnauthorizedHandler, Icon, Button } from './lib.js';
import { RoomsPage } from './rooms.js';
import { DashboardPage, AllViewportsPage } from './dashboards.js';
import { ClientList, ClientPage } from './clients.js';
import { SettingsPage } from './settings.js';
import { HomePage } from './home.js';
import { SideNav, PageBar } from './nav.js';

// --- Routing ----------------------------------------------------------------
// #/home[/<view>], #/layouts[/<tool>], #/remote-layouts/<slug>[/<part>],
// #/viewport-layouts/<slug>[/<part>], #/remotes/<mac>, #/viewports/<mac>,
// #/settings/<page>

// Links from before the Layouts page (#/rooms/<slug>, #/dashboards/<slug>)
// still work.
const ALIASES = { rooms: 'remote-layouts', dashboards: 'viewport-layouts' };
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  let section = ALIASES[parts[0]] || parts[0] || 'home';
  if (section === 'remote-layouts' && !parts[1]) section = 'layouts';
  return { section, id: parts[1] || '', sub: parts[2] || '' };
}

function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// --- Shared data: rooms + clients -------------------------------------------
// Loaded once and refreshed on demand; clients are also polled so a device
// that has just asked to pair shows up without reloading the page.

function useAppData(signedIn) {
  const [rooms, setRooms] = useState(null);
  const [clients, setClients] = useState(null);
  const [dashboards, setDashboards] = useState(null);
  const [overview, setOverview] = useState(null);
  const reloadAlerts = useCallback(() => api('/api/overview').then(setOverview).catch(() => {}), []);
  const reloadRooms = useCallback(() => api('/api/devices').then(setRooms).catch(() => {}), []);
  const reloadClients = useCallback(() => api('/api/clients').then(setClients).catch(() => {}), []);
  const reloadDashboards = useCallback(() => api('/api/dashboards').then(setDashboards).catch(() => {}), []);
  useEffect(() => {
    if (!signedIn) return undefined;
    reloadRooms();
    reloadClients();
    reloadDashboards();
    reloadAlerts();
    const t = setInterval(() => {
      if (!document.hidden) reloadClients();
    }, 5000);
    const t2 = setInterval(() => {
      if (!document.hidden) reloadAlerts();
    }, 30000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [signedIn]);
  return { rooms, clients, dashboards, overview, reloadRooms, reloadClients, reloadDashboards, reloadOverview: reloadAlerts, setClients };
}

// --- Sign in ------------------------------------------------------------------

function AuthGate({ needsSetup, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (needsSetup && pw !== pw2) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api(needsSetup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { password: pw } });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="auth-gate">
    <form class="auth-card" onSubmit=${submit}>
      <div class="auth-brand"><${Icon} name="remote-tv" size=${32} /><h1>Switchboard</h1></div>
      <p class="hint">${needsSetup ? 'Choose an admin password to finish setting up this server.' : 'Sign in to manage rooms and devices.'}</p>
      <label class="field">
        <span class="field-label">Admin password</span>
        <input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)} autocomplete=${needsSetup ? 'new-password' : 'current-password'} autofocus required />
      </label>
      ${needsSetup &&
      html`<label class="field">
        <span class="field-label">Confirm password</span>
        <input type="password" value=${pw2} onInput=${(e) => setPw2(e.target.value)} autocomplete="new-password" required />
      </label>`}
      ${error && html`<p class="auth-error">${error}</p>`}
      <${Button} type="submit" kind="primary" icon=${needsSetup ? 'lock-plus-outline' : 'login'} disabled=${busy}>
        ${needsSetup ? 'Set password' : 'Sign in'}
      <//>
    </form>
  </div>`;
}

// --- Rail ---------------------------------------------------------------------

const SECTIONS = [
  { id: 'home', label: 'Home', icon: 'home-outline' },
  { id: 'layouts', label: 'Layouts', icon: 'view-dashboard-edit-outline' },
  { id: 'remotes', label: 'Remotes', icon: 'remote' },
  { id: 'viewports', label: 'Viewports', icon: 'tablet-dashboard' },
  { id: 'settings', label: 'Settings', icon: 'cog-outline' }
];

// The manual (GitHub Pages, beside the web flasher): the page for where you
// are, so help opens on the thing you're looking at.
const MANUAL = 'https://stumarti.github.io/Switchboard/manual/';
const MANUAL_PAGES = {
  home: 'server/home.html',
  'remote-layouts': 'server/remote-layouts.html',
  layouts: 'server/remote-layouts.html',
  'viewport-layouts': 'server/viewports.html',
  remotes: 'server/remotes.html',
  viewports: 'server/viewports.html',
  settings: 'server/settings.html'
};
const MANUAL_SETTINGS = { theme: 'server/theme.html', updates: 'server/remote-updates.html', security: 'server/security.html', pairing: 'server/pairing-and-auth.html' };
const MANUAL_LAYOUTS = { 'meeting-rooms': 'viewport/office.html', waiting: 'viewport/office.html' };
export function manualUrl({ section, id }) {
  const page = (section === 'settings' && MANUAL_SETTINGS[id]) || (section === 'layouts' && MANUAL_LAYOUTS[id]) || MANUAL_PAGES[section] || '';
  return MANUAL + page;
}

function Rail({ section, route, pendingCount, alertCount }) {
  return html`<nav class="rail">
    <a class="rail-logo" href="#/home" title="Switchboard"><${Icon} name="remote-tv" size=${20} /></a>
    ${SECTIONS.map(
      (s) => html`<a class=${`rail-item ${section === s.id ? 'active' : ''}`} href=${`#/${s.id}`} title=${s.label} aria-label=${s.label}>
        <${Icon} name=${s.icon} size=${21} />
        ${s.id === 'remotes' && pendingCount > 0 && html`<span class="rail-count" title="Waiting for approval">${pendingCount}</span>`}
        ${s.id === 'home' && alertCount > 0 && html`<span class="rail-count rail-count-bad" title="Critical problems">${alertCount}</span>`}
      </a>`
    )}
    <div class="rail-spacer"></div>
    <a class="rail-item" href=${manualUrl(route)} target="_blank" rel="noopener" title="The Switchboard manual, on this page" aria-label="Manual">
      <${Icon} name="book-open-page-variant-outline" size=${21} />
    </a>
  </nav>`;
}

// --- App ------------------------------------------------------------------------

function App() {
  const [auth, setAuth] = useState(null); // {authenticated, setupRequired}
  const checkAuth = useCallback(() => api('/api/auth/status').then(setAuth).catch(() => setAuth({ setupRequired: false, authenticated: false })), []);
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth((a) => ({ ...(a || {}), authenticated: false })));
    checkAuth();
  }, []);
  const signedIn = Boolean(auth && auth.authenticated);
  const data = useAppData(signedIn);
  const route = useRoute();

  if (!auth) return null;
  if (!signedIn) return html`<${AuthGate} needsSetup=${Boolean(auth.setupRequired)} onDone=${checkAuth} />`;

  const { section, id, sub } = route;
  const clientType = section === 'remotes' ? 'remote' : section === 'viewports' ? 'viewport' : null;
  // Devices still waiting to be approved are listed under Remotes: every
  // device registers as a remote until it says otherwise.
  const pendingCount = (data.clients || []).filter((c) => c.status === 'pending' && c.lastSeenAt).length;

  let main;
  if (section === 'home') {
    main = html`<${HomePage} view=${id} />`;
  } else if (section === 'layouts' || section === 'remote-layouts') {
    main = html`<${RoomsPage} slug=${section === 'remote-layouts' ? id : ''} tool=${section === 'layouts' ? id : ''} part=${sub} ...${data} />`;
  } else if (section === 'viewport-layouts' && !id) {
    main = html`<${AllViewportsPage} ...${data} />`;
  } else if (section === 'viewport-layouts') {
    main = html`<${DashboardPage} key=${id} slug=${id} part=${sub} ...${data} />`;
  } else if (clientType) {
    main = html`<${ClientPage} type=${clientType} mac=${id} ...${data} />`;
  } else {
    main = html`<${SettingsPage} tab=${id} onSignOut=${checkAuth} />`;
  }

  return html`<div class="shell">
    <${Rail} section=${section.endsWith('layouts') ? 'layouts' : section} route=${route} pendingCount=${pendingCount}
      alertCount=${data.overview ? data.overview.counts.critical : 0} />
    ${clientType
      ? html`<${ClientList} type=${clientType} selected=${id} clients=${data.clients} rooms=${data.rooms} dashboards=${data.dashboards} server=${data.overview && data.overview.server} />`
      : html`<${SideNav} route=${route} data=${data} overview=${data.overview} />`}
    <main class="main">
      <${PageBar} route=${route} data=${data} overview=${data.overview} />
      ${main}
    </main>
  </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
