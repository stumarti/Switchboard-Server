// The shell's navigation, beside the icon rail:
//
//   SideNav   the section's own links, stacked down a column: Home's views
//             and shortcuts, every layout (or, inside one, its parts), the
//             settings pages in groups. Remotes and Viewports use their
//             device list (clients.js ClientList) instead.
//   PageBar   on the page itself, above its title: where you are, search
//             ("/"), Home Assistant, the server's time, what needs
//             attention and the account.
//   Search    a jump-to box over every page, layout and device.

import { html, useState, useEffect, useRef, useMemo, Icon, api } from './lib.js';

// --- Side column ------------------------------------------------------------------

export function SideLink({ href, icon, label, count, countKind, active, sub }) {
  return html`<a class=${`side-link ${active ? 'active' : ''} ${sub ? 'side-link-2' : ''}`} href=${href}>
    ${icon && html`<${Icon} name=${icon} size=${17} />`}
    <span class="side-text">${label}${sub && html`<span class="side-sub">${sub}</span>`}</span>
    ${count != null && count !== 0 && html`<span class=${`side-count ${countKind ? `side-count-${countKind}` : ''}`}>${count}</span>`}
  </a>`;
}

export function SideGroup({ label, children }) {
  return html`<div class="side-group">${label && html`<h6>${label}</h6>`}${children}</div>`;
}

export function SideColumn({ title, back, children, server }) {
  return html`<aside class="side">
    <div class="side-head">
      ${back
        ? html`<a class="side-back" href=${back.href} title=${back.label}><${Icon} name="arrow-left" size=${18} /></a><b class="side-title">${title}</b>`
        : html`<b class="side-title">${title}</b>`}
    </div>
    <div class="side-body">${children}</div>
    <${SideFoot} server=${server} />
  </aside>`;
}

function SideFoot({ server }) {
  if (!server) return null;
  return html`<div class="side-foot">
    <div title="Devices find the server at this address"><span class="led"></span><code>${String(server.mdnsHostname || '').replace(/\.local$/, '')}.local:${server.port}</code></div>
    <div>Switchboard Server ${server.version}</div>
  </div>`;
}

// Settings pages, in groups (settings.js renders them).
export const SETTINGS_GROUPS = [
  {
    label: 'Connections',
    items: [
      { id: 'home-assistant', label: 'Home Assistant', icon: 'home-assistant' },
      { id: 'wifi', label: 'Wi-Fi networks', icon: 'wifi' },
      { id: 'immich', label: 'Immich photos', icon: 'image-multiple-outline' },
      { id: 'clock', label: 'Clock and time zone', icon: 'clock-outline' }
    ]
  },
  {
    label: 'Devices',
    items: [
      { id: 'updates', label: 'Firmware updates', icon: 'update' },
      { id: 'pairing', label: 'Pairing', icon: 'link-variant' },
      { id: 'theme', label: 'Theme', icon: 'palette-outline' }
    ]
  },
  {
    label: 'Server',
    items: [
      { id: 'security', label: 'Security', icon: 'shield-lock-outline' },
      { id: 'account', label: 'Account', icon: 'account-circle-outline' },
      { id: 'about', label: 'About', icon: 'information-outline' }
    ]
  }
];
export const SETTINGS_PAGES = SETTINGS_GROUPS.flatMap((g) => g.items);

const roomIcon = 'sofa-outline';
const layoutIcon = (d) => (d.screens && d.screens.some((s) => s.kind === 'meetingRoom') ? 'calendar-account-outline' : 'view-dashboard-outline');

export function SideNav({ route, data, overview }) {
  const { section, id, sub } = route;
  const server = overview && overview.server;
  const counts = (overview && overview.counts) || {};
  const rooms = data.rooms || [];
  const dashboards = data.dashboards || [];
  const clients = data.clients || [];
  const pending = clients.filter((c) => c.status === 'pending' && c.lastSeenAt).length;
  const waitingDisplays = clients.filter((c) => c.status === 'pending' && c.lastSeenAt).length;

  if (section === 'home') {
    const attention = (overview && overview.attention) || [];
    const low = counts.lowBattery || 0;
    return html`<${SideColumn} title="Home" server=${server}>
      <${SideGroup} label="Overview">
        <${SideLink} href="#/home" icon="view-dashboard-outline" label="Dashboard" active=${!id} />
        <${SideLink} href="#/home/attention" icon="bell-outline" label="Needs attention" count=${attention.length} countKind=${counts.critical ? 'bad' : 'warn'} active=${id === 'attention'} />
        <${SideLink} href="#/home/devices" icon="devices" label="Devices" count=${(overview && overview.devices.filter((d) => d.status !== 'revoked').length) || null} active=${id === 'devices'} />
        <${SideLink} href="#/home/batteries" icon="battery-50" label="Batteries" count=${low || null} countKind="warn" active=${id === 'batteries'} />
      <//>
      <${SideGroup} label="Connections">
        <${SideLink} href="#/home/home-assistant" icon="home-assistant" label="Home Assistant" active=${id === 'home-assistant'} />
        <${SideLink} href="#/settings/updates" icon="update" label="Firmware rollout" />
      <//>
      <${SideGroup} label="Shortcuts">
        <${SideLink} href="#/remotes" icon="account-clock-outline" label="Approve devices" count=${pending || null} countKind="warn" />
        <${SideLink} href="#/layouts/meeting-rooms" icon="calendar-multiple" label="Add meeting rooms" />
      <//>
    <//>`;
  }

  if (section === 'layouts') {
    return html`<${SideColumn} title="Layouts" server=${server}>
      <${SideGroup} label="Overview">
        <${SideLink} href="#/layouts" icon="view-grid-outline" label="All layouts" active=${!id} />
      <//>
      <${SideGroup} label="Remote layouts">
        ${rooms.map((r) => html`<${SideLink} key=${r.slug} href=${`#/remote-layouts/${encodeURIComponent(r.slug)}`} icon=${roomIcon} label=${r.name}
          count=${clients.filter((c) => c.assignedSlug === r.slug && c.type !== 'viewport').length || null} />`)}
        <${SideLink} href="#/layouts/new-remote" icon="plus" label="New remote layout" active=${id === 'new-remote'} />
      <//>
      <${SideGroup} label="Viewport layouts">
        ${dashboards.map((d) => html`<${SideLink} key=${d.slug} href=${`#/viewport-layouts/${encodeURIComponent(d.slug)}`} icon=${layoutIcon(d)} label=${d.name}
          count=${d.devices.length || null} />`)}
        <${SideLink} href="#/layouts/new-viewport" icon="plus" label="New viewport layout" active=${id === 'new-viewport'} />
      <//>
      <${SideGroup} label="Office">
        <${SideLink} href="#/layouts/meeting-rooms" icon="calendar-multiple" label="Add meeting rooms" active=${id === 'meeting-rooms'} />
        <${SideLink} href="#/layouts/waiting" icon="account-clock-outline" label="Displays waiting" count=${waitingDisplays || null} countKind="warn" active=${id === 'waiting'} />
      <//>
    <//>`;
  }

  if (section === 'remote-layouts') {
    const room = rooms.find((r) => r.slug === id);
    const base = `#/remote-layouts/${encodeURIComponent(id)}`;
    const remotes = clients.filter((c) => c.assignedSlug === id && c.type !== 'viewport');
    return html`<${SideColumn} title=${room ? room.name : id} back=${{ href: '#/layouts', label: 'All layouts' }} server=${server}>
      <${SideGroup} label="Remote layout">
        <${SideLink} href=${base} icon="view-carousel-outline" label="Pages" active=${!sub} />
        <${SideLink} href=${`${base}/quick`} icon="view-grid-plus-outline" label="Quick Access" active=${sub === 'quick'} />
        <${SideLink} href=${`${base}/settings`} icon="tune-variant" label="On the remote" active=${sub === 'settings'} />
      <//>
      <${SideGroup} label="Remotes in this room">
        ${remotes.length
          ? remotes.map((c) => html`<${SideLink} key=${c.mac} href=${`#/remotes/${encodeURIComponent(c.mac)}`} icon="remote" label=${c.name} />`)
          : html`<p class="side-note">None yet. Pick this room on a remote's page.</p>`}
      <//>
      <${SideGroup} label="Other layouts">
        ${rooms.filter((r) => r.slug !== id).map((r) => html`<${SideLink} key=${r.slug} href=${`#/remote-layouts/${encodeURIComponent(r.slug)}`} icon=${roomIcon} label=${r.name} />`)}
      <//>
    <//>`;
  }

  if (section === 'viewport-layouts') {
    const d = dashboards.find((x) => x.slug === id);
    const base = `#/viewport-layouts/${encodeURIComponent(id)}`;
    return html`<${SideColumn} title=${d ? d.name : id} back=${{ href: '#/layouts', label: 'All layouts' }} server=${server}>
      <${SideGroup} label="Viewport layout">
        <${SideLink} href=${base} icon="view-carousel-outline" label="Screens" active=${!sub} />
        <${SideLink} href=${`${base}/settings`} icon="tune-variant" label="Thresholds" active=${sub === 'settings'} />
        <${SideLink} href=${`${base}/start`} icon="file-replace-outline" label="Start from or import" active=${sub === 'start'} />
      <//>
      <${SideGroup} label="Displays">
        ${d && d.devices.length
          ? d.devices.map((c) => html`<${SideLink} key=${c.mac} href=${`#/viewports/${encodeURIComponent(c.mac)}`} icon="tablet-dashboard" label=${c.name} />`)
          : html`<p class="side-note">None yet. Pick this layout on a viewport's page.</p>`}
      <//>
      <${SideGroup} label="Other layouts">
        ${dashboards.filter((x) => x.slug !== id).map((x) => html`<${SideLink} key=${x.slug} href=${`#/viewport-layouts/${encodeURIComponent(x.slug)}`} icon=${layoutIcon(x)} label=${x.name} />`)}
      <//>
    <//>`;
  }

  if (section === 'settings') {
    const active = SETTINGS_PAGES.some((p) => p.id === id) ? id : SETTINGS_PAGES[0].id;
    return html`<${SideColumn} title="Settings" server=${server}>
      ${SETTINGS_GROUPS.map(
        (g) => html`<${SideGroup} label=${g.label}>
          ${g.items.map((p) => html`<${SideLink} key=${p.id} href=${`#/settings/${p.id}`} icon=${p.icon} label=${p.label} active=${p.id === active} />`)}
        <//>`
      )}
    <//>`;
  }
  return null;
}

// --- Page bar ---------------------------------------------------------------------

const SECTION_NAMES = {
  home: 'Home',
  layouts: 'Layouts',
  'remote-layouts': 'Layouts',
  'viewport-layouts': 'Layouts',
  remotes: 'Remotes',
  viewports: 'Viewports',
  settings: 'Settings'
};

const HOME_VIEWS = { attention: 'Needs attention', devices: 'Devices', batteries: 'Batteries', 'home-assistant': 'Home Assistant' };
const LAYOUT_TOOLS = { 'meeting-rooms': 'Add many meeting rooms', waiting: 'Displays waiting', 'new-remote': 'New remote layout', 'new-viewport': 'New viewport layout' };
const REMOTE_SUBS = { quick: 'Quick Access', settings: 'On the remote' };
const VIEWPORT_SUBS = { settings: 'Thresholds', start: 'Start from or import' };

function crumbs({ section, id, sub }, data) {
  const first = { label: SECTION_NAMES[section] || section, href: `#/${section.endsWith('layouts') ? 'layouts' : section}` };
  const out = [first];
  const find = (list, key, v) => (list || []).find((x) => x[key] === v);
  if (section === 'home' && HOME_VIEWS[id]) out.push({ label: HOME_VIEWS[id] });
  if (section === 'layouts' && LAYOUT_TOOLS[id]) out.push({ label: LAYOUT_TOOLS[id] });
  if (section === 'remote-layouts') {
    const r = find(data.rooms, 'slug', id);
    out.push({ label: r ? r.name : id, href: sub ? `#/remote-layouts/${encodeURIComponent(id)}` : undefined });
    if (REMOTE_SUBS[sub]) out.push({ label: REMOTE_SUBS[sub] });
  }
  if (section === 'viewport-layouts') {
    const d = find(data.dashboards, 'slug', id);
    out.push({ label: d ? d.name : id, href: sub ? `#/viewport-layouts/${encodeURIComponent(id)}` : undefined });
    if (VIEWPORT_SUBS[sub]) out.push({ label: VIEWPORT_SUBS[sub] });
  }
  if ((section === 'remotes' || section === 'viewports') && id) {
    const c = find(data.clients, 'mac', id);
    out.push({ label: c ? c.name : id });
  }
  if (section === 'settings') {
    const p = SETTINGS_PAGES.find((x) => x.id === id) || SETTINGS_PAGES[0];
    out.push({ label: p.label });
  }
  return out;
}

// The server's clock, polled each minute and ticked locally.
function useServerClock() {
  const [t, setT] = useState(null);
  const [, tick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const sent = Date.now();
      api('/api/time')
        .then((r) => alive && setT({ offsetMs: Date.parse(r.now) + (Date.now() - sent) / 2 - Date.now(), timeZone: r.timeZone }))
        .catch(() => {});
    };
    load();
    const poll = setInterval(load, 60000);
    const min = setInterval(() => tick((n) => n + 1), 15000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(min);
    };
  }, []);
  return t;
}

function HaChip({ ha }) {
  if (!ha) return null;
  const h = ha.lastHour || {};
  const [kind, text] = !ha.configured
    ? ['bad', 'Not set up']
    : ha.reachable === false
      ? ['bad', 'Unreachable']
      : h.avgMs != null
        ? [h.errors ? 'warn' : 'ok', `${h.avgMs} ms`]
        : ['', 'Connected'];
  return html`<a class="bar-chip" href="#/home/home-assistant" title="How the server's requests to Home Assistant are going">
    <span class=${`led led-${kind || 'muted'}`}></span>Home Assistant <b>${text}</b>
  </a>`;
}

function TimeChip() {
  const t = useServerClock();
  if (!t) return null;
  const now = new Date(Date.now() + t.offsetMs);
  const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: t.timeZone }).format(now);
  return html`<a class="bar-chip" href="#/settings/clock" title="The server's time: every device shows times in this zone">
    <${Icon} name="clock-outline" size=${15} /><b>${hm}</b> ${t.timeZone.replace(/_/g, ' ')}
  </a>`;
}

export function PageBar({ route, data, overview }) {
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === '/' && !typing) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const trail = crumbs(route, data);
  const attention = (overview && overview.attention) || [];
  const critical = overview && overview.counts && overview.counts.critical;
  return html`<div class="pagebar">
    <nav class="crumbs" aria-label="Where you are">
      ${trail.map((c, i) => html`${i > 0 && html`<${Icon} name="chevron-right" size=${14} class="crumb-sep" />`}${c.href && i < trail.length - 1 ? html`<a href=${c.href}>${c.label}</a>` : html`<b>${c.label}</b>`}`)}
    </nav>
    <span class="pagebar-sp"></span>
    <button type="button" class="bar-search" onClick=${() => setSearching(true)} title="Search: jump to any page, layout or device">
      <${Icon} name="magnify" size=${16} /><span>Search</span><kbd>/</kbd>
    </button>
    <span class="vsep"></span>
    <${HaChip} ha=${overview && overview.ha} />
    <${TimeChip} />
    <span class="vsep"></span>
    <a class="bar-icon" href="#/home/attention" title=${attention.length ? `${attention.length} thing${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} attention` : 'Nothing needs attention'}>
      <${Icon} name="bell-outline" size=${19} />
      ${attention.length > 0 && html`<span class=${`bar-dot ${critical ? '' : 'bar-dot-warn'}`}></span>`}
    </a>
    <a class="bar-avatar" href="#/settings/account" title="Account">A</a>
    ${searching && html`<${Search} data=${data} onClose=${() => setSearching(false)} />`}
  </div>`;
}

// --- Search -----------------------------------------------------------------------

function searchItems(data) {
  const items = [
    { label: 'Home', hint: 'Dashboard', icon: 'home-outline', href: '#/home' },
    { label: 'Needs attention', hint: 'Home', icon: 'bell-outline', href: '#/home/attention' },
    { label: 'Layouts', hint: 'Every remote and viewport layout', icon: 'view-dashboard-edit-outline', href: '#/layouts' },
    { label: 'Add many meeting rooms', hint: 'Layouts', icon: 'calendar-multiple', href: '#/layouts/meeting-rooms' },
    { label: 'Remotes', hint: 'Devices', icon: 'remote', href: '#/remotes' },
    { label: 'Viewports', hint: 'Devices', icon: 'tablet-dashboard', href: '#/viewports' },
    ...SETTINGS_PAGES.map((p) => ({ label: p.label, hint: 'Settings', icon: p.icon, href: `#/settings/${p.id}` }))
  ];
  for (const r of data.rooms || []) items.push({ label: r.name, hint: 'Remote layout', icon: roomIcon, href: `#/remote-layouts/${encodeURIComponent(r.slug)}` });
  for (const d of data.dashboards || []) items.push({ label: d.name, hint: 'Viewport layout', icon: layoutIcon(d), href: `#/viewport-layouts/${encodeURIComponent(d.slug)}` });
  for (const c of data.clients || []) {
    const vp = c.type === 'viewport';
    items.push({ label: c.name, hint: `${vp ? 'Viewport' : 'Remote'} · ${c.mac}`, icon: vp ? 'tablet-dashboard' : 'remote', href: `#/${vp ? 'viewports' : 'remotes'}/${encodeURIComponent(c.mac)}`, extra: c.mac });
  }
  return items;
}

function Search({ data, onClose }) {
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const input = useRef(null);
  const all = useMemo(() => searchItems(data), [data]);
  useEffect(() => input.current && input.current.focus(), []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = all.filter((it) => words.every((w) => `${it.label} ${it.hint} ${it.extra || ''}`.toLowerCase().includes(w))).slice(0, 12);
  const open = (it) => {
    if (!it) return;
    location.hash = it.href;
    onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHl((h) => Math.min(found.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHl((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') open(found[hl]);
  };
  return html`<div class="modal-back search-back" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal search" role="dialog" aria-label="Search">
      <div class="search-input">
        <${Icon} name="magnify" size=${20} />
        <input ref=${input} type="text" placeholder="Jump to a page, layout or device…" value=${q} onInput=${(e) => { setQ(e.target.value); setHl(0); }} onKeyDown=${onKey} />
        <kbd>Esc</kbd>
      </div>
      <div class="search-list">
        ${found.length
          ? found.map((it, i) => html`<a class=${`search-item ${i === hl ? 'hl' : ''}`} href=${it.href} onClick=${onClose} onMouseEnter=${() => setHl(i)}>
              <${Icon} name=${it.icon} size=${18} /><span>${it.label}</span><span class="hint">${it.hint}</span>
            </a>`)
          : html`<p class="hint" style="padding:14px">Nothing matches “${q}”.</p>`}
      </div>
    </div>
  </div>`;
}
