// Home: how the whole setup is doing (GET /api/overview).
//
//   KPIs              remotes and viewports online, devices waiting for
//                     approval, low batteries, firmware still to install
//   Needs attention   everything worth acting on, worst first, each with the
//                     button that fixes it
//   Firmware rollout  each board's release, its stage and how far it's got
//   Devices           every device: status, battery and days left, Wi-Fi,
//                     firmware; filtered by kind, by trouble or by name
//   Home Assistant    how the server's requests to HA are going
//
// The side column's links (#/home/<view>) scroll to a part. Polled every
// 10 s while the tab is visible.

import { html, useState, useEffect, useRef, api, go, Icon, Card, Badge, Button, Empty, timeAgo, batteryLifeText, boardLabel } from './lib.js';

const LEVEL = {
  critical: { icon: 'alert-octagon', cls: 'bad', label: 'Critical' },
  warn: { icon: 'alert', cls: 'warn', label: 'Warning' },
  info: { icon: 'information-outline', cls: 'accent', label: 'Tip' }
};

const KIND_ICON = {
  pending: 'account-clock-outline',
  battery: 'battery-alert-variant-outline',
  offline: 'lan-disconnect',
  wifi: 'wifi-strength-1-alert',
  unassigned: 'link-variant-off',
  ha: 'home-assistant',
  entities: 'help-rhombus-outline',
  firmware: 'chip',
  timezone: 'earth',
  expected: 'timer-sand'
};

function useOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(() => () => {});
  useEffect(() => {
    let alive = true;
    const load = () =>
      api('/api/overview')
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError('');
        })
        .catch((e) => alive && setError(e.message));
    load();
    setReload(() => load);
    const t = setInterval(() => !document.hidden && load(), 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { data, error, reload };
}

// "Update now": devices due their board's release install it at their next
// wake, whatever the update schedule (lib/firmware.js updateNow). While it's
// with the pilots, "Update all" skips them: the release goes to everyone of
// that board too. One row per board with devices still to get its release;
// the board is named only when there's more than one.
function UpdateNow({ u, reload }) {
  const rows = ((u && u.enabled && u.boards) || []).filter((b) => b.pending || b.pendingEveryone || (b.now && b.now.waiting));
  if (!rows.length) return null;
  return html`<div class="update-now-list">
    ${rows.map((b) => html`<${UpdateNowRow} key=${b.board} b=${b} named=${u.boards.length > 1} reload=${reload} />`)}
  </div>`;
}

function UpdateNowRow({ b, named, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const act = async (method, body) => {
    setBusy(true);
    setMsg('');
    try {
      await api(method === 'DELETE' ? `/api/firmware/update-now?board=${encodeURIComponent(b.board)}` : '/api/firmware/update-now', { method, body: method === 'DELETE' ? undefined : { board: b.board, ...body } });
      reload();
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  };
  const n = (k) => `${k} ${named ? boardLabel(b.board) : 'remote'}${k === 1 ? '' : 's'}`;
  const tag = named ? html`<span class="hint update-now-board">${boardLabel(b.board)}</span>` : null;
  if (b.now && b.now.waiting > 0) {
    return html`<div class="row update-now">
      ${tag}
      <span title=${`Each installs ${b.release} the next time it wakes, whatever the update schedule.`}><${Badge} kind="accent" icon="timer-sand">${n(b.now.waiting)} updating at next wake<//></span>
      <${Button} small kind="ghost" disabled=${busy} onClick=${() => act('DELETE')}>Cancel<//>
    </div>`;
  }
  // With the pilots, and there are devices beyond them: skip the pilot.
  const skip = b.stage === 'pilot' && b.pendingEveryone > b.pending;
  const skipPilot = () =>
    confirm(`Release ${b.release} to every ${named ? boardLabel(b.board) : 'remote'}, without waiting for the pilots, and install it on all ${n(b.pendingEveryone)} at their next wake?`) &&
    act('POST', { everyone: true });
  return html`<div class="row update-now">
    ${msg && html`<span class="flash flash-bad">${msg}</span>`}
    ${tag}
    ${b.pending > 0 &&
    html`<${Button} small icon="update" disabled=${busy}
      title=${`Each device due ${b.release}${b.stage === 'pilot' ? ' (the pilots, until it’s released to everyone)' : ''} installs it the next time it wakes, whatever the update schedule.`}
      onClick=${() => act('POST')}>Update ${b.stage === 'pilot' ? `${b.pending === 1 ? 'the pilot' : `${b.pending} pilots`}` : n(b.pending)} to ${b.release} now<//>`}
    ${skip &&
    html`<${Button} small icon="fast-forward-outline" kind=${b.pending > 0 ? 'ghost' : 'secondary'} disabled=${busy}
      title=${`Skip the pilot: release ${b.release} to everyone, and every device not on it installs it the next time it wakes.`}
      onClick=${skipPilot}>Update all ${b.pendingEveryone} now${b.pending > 0 ? ' (skip pilot)' : ''}<//>`}
  </div>`;
}

function Kpi({ icon, label, value, of, sub, kind, href, bar }) {
  const body = html`<div class=${`card kpi ${kind ? `kpi-${kind}` : ''}`}>
    <div class="kpi-label"><${Icon} name=${icon} size=${15} />${label}</div>
    <div class="kpi-value">${value}${of != null && html`<small> ${of}</small>`}</div>
    ${bar != null ? html`<div class="meter"><i style=${{ width: `${Math.max(2, Math.min(100, bar))}%` }}></i></div>` : html`<div class="kpi-sub">${sub || ' '}</div>`}
  </div>`;
  return href ? html`<a class="kpi-link" href=${href}>${body}</a>` : body;
}

function BatteryBar({ pct, level, life }) {
  if (pct == null) return html`<span class="hint">—</span>`;
  const est = batteryLifeText(life);
  const cls = level === 'critical' ? 'bad' : level === 'low' ? 'warn' : 'ok';
  return html`<span class=${`battery battery-${cls}`} title=${`${pct}%`}>
    <span class="meter"><i style=${{ width: `${pct}%` }}></i></span>
    <span class="battery-pct">${pct}%</span>
    ${est.short && html`<span class=${`battery-days ${cls !== 'ok' ? 'battery-days-low' : ''}`} title=${est.tip}>${est.short}</span>`}
  </span>`;
}

function Signal({ rssi }) {
  if (rssi == null) return html`<span class="hint">—</span>`;
  const bars = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return html`<span class=${`signal ${bars <= 1 ? 'signal-weak' : ''}`} title=${`${rssi} dBm`}>
    <span class="bars">${[1, 2, 3, 4].map((n) => html`<b class=${n <= bars ? 'on' : ''} style=${{ height: `${n * 3}px` }}></b>`)}</span>${rssi} dBm
  </span>`;
}

// The button that fixes each kind of problem (it goes where the link does).
const ACTION = { expected: 'View', pending: 'Approve', battery: 'View', offline: 'View', wifi: 'View', unassigned: 'Assign', ha: 'Fix', entities: 'Fix', firmware: 'Review', timezone: 'Set' };

function Attention({ items }) {
  if (!items.length) {
    return html`<div class="all-good"><${Icon} name="check-circle-outline" size=${28} /><div><b>All good</b><div class="hint">Nothing needs attention.</div></div></div>`;
  }
  return html`<div class="attention">
    ${items.map((a) => {
      const lv = LEVEL[a.level];
      return html`<div class="att-item">
        <span class=${`att-icon att-${lv.cls}`}><${Icon} name=${KIND_ICON[a.kind] || lv.icon} size=${17} /></span>
        <span class="att-text"><b>${a.title}</b><span class="hint">${a.detail}</span></span>
        ${a.link && html`<a class=${`btn btn-small ${a.kind === 'pending' ? 'btn-primary' : ''}`} href=${a.link}>${ACTION[a.kind] || 'Open'}</a>`}
      </div>`;
    })}
  </div>`;
}

// Each board's release: its stage and how many of its devices run it.
const STAGE = { pilot: ['Pilots', 'accent'], everyone: ['Everyone', 'ok'] };
function Rollout({ u, devices, reload }) {
  if (!u || !u.enabled) {
    return html`<p class="hint">Firmware updates are off. <a href="#/settings/updates">Turn them on</a> to roll releases out to remotes and viewports over Wi-Fi.</p>`;
  }
  if (!u.boards.length) return html`<p class="hint">No release chosen yet. <a href="#/settings/updates">Pick one</a> for each kind of device.</p>`;
  return html`<div class="rollout">
    ${u.boards.map((b) => {
      const mine = devices.filter((d) => d.update && d.update.board === b.board);
      const done = mine.filter((d) => d.update.state === 'current').length;
      const [stage, kind] = STAGE[b.stage] || [b.stage, ''];
      const pct = mine.length ? (done / mine.length) * 100 : 0;
      return html`<div class="rollout-row">
        <div class="rollout-top">
          <b>${boardLabel(b.board)}</b><code>${b.release}</code><${Badge} kind=${kind}>${stage}<//>
          <span class="pagebar-sp"></span><span class="hint">${done} of ${mine.length} updated</span>
        </div>
        <div class="meter"><i style=${{ width: `${Math.max(3, pct)}%`, background: pct >= 100 ? 'var(--ok)' : 'var(--accent)' }}></i></div>
      </div>`;
    })}
    <${UpdateNow} u=${u} reload=${reload} />
  </div>`;
}

// A remote's over-the-air update, as one icon beside its version (hover
// for words); nothing while updates are off. Details: Remotes page.
const UPDATE_ICON = {
  current: { icon: 'check-circle-outline', cls: 'ok', text: () => 'Up to date' },
  pending: { icon: 'arrow-down-circle-outline', cls: 'accent', text: (u) => (u.now ? `Updating to ${u.offer} at its next wake` : `Will update to ${u.offer}`) },
  failed: { icon: 'alert-circle-outline', cls: 'bad', text: (u) => `Couldn't update to ${u.offer}${u.error ? `: ${u.error}` : ''}` },
  waiting: { icon: 'timer-sand', cls: 'muted', text: () => 'Not in this release stage yet' }
};
function UpdateIcon({ u }) {
  const look = u && UPDATE_ICON[u.state];
  if (!look) return null;
  return html`<span class=${`fw-state fw-${look.cls}`}><${Icon} name=${look.icon} size=${18} title=${look.text(u)} /></span>`;
}

const trouble = (d) => d.status === 'pending' || (d.status === 'approved' && !d.online) || (d.batteryLevel && d.batteryLevel !== 'ok') || (d.update && d.update.state === 'failed');
const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'remote', label: 'Remotes', test: (d) => d.type !== 'viewport' },
  { id: 'viewport', label: 'Viewports', test: (d) => d.type === 'viewport' },
  { id: 'battery', label: 'Low battery', test: (d) => d.batteryLevel && d.batteryLevel !== 'ok' },
  { id: 'attention', label: 'Attention', test: trouble }
];

function statusOf(d) {
  if (d.status === 'pending') return ['warn', 'Waiting'];
  if (d.expected) return ['', 'Not connected yet'];
  if (d.status !== 'approved') return ['', 'Revoked'];
  return d.online ? ['ok', 'Online'] : ['bad', 'Offline'];
}

function Devices({ devices, filter, setFilter }) {
  const [q, setQ] = useState('');
  const shown = devices.filter((d) => d.status !== 'revoked');
  if (!shown.length) {
    return html`<${Empty} icon="devices" title="No devices yet">Turn a remote or a viewport on: it asks to pair, and shows up here to approve.<//>`;
  }
  const f = FILTERS.find((x) => x.id === filter) || FILTERS[0];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const order = { pending: 0, approved: 1 };
  const rows = shown
    .filter(f.test)
    .filter((d) => words.every((w) => `${d.name} ${d.mac} ${d.assignedTo} ${d.firmware}`.toLowerCase().includes(w)))
    .sort((a, b) => (filter === 'battery' ? (a.battery ?? 101) - (b.battery ?? 101) : 0) || (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return html`<div class="table-tools">
      <div class="seg">
        ${FILTERS.map((x) => html`<button type="button" class=${x.id === f.id ? 'on' : ''} onClick=${() => setFilter(x.id)}>${x.label}<em>${shown.filter(x.test).length}</em></button>`)}
      </div>
      <span class="pagebar-sp"></span>
      <label class="filter-box"><${Icon} name="magnify" size=${15} /><input type="text" placeholder="Filter devices" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    </div>
    <div class="table-wrap"><table class="table table-links">
    <thead><tr><th>Device</th><th>Status</th><th>Room / layout</th><th>Battery</th><th>Wi-Fi</th><th>Firmware</th><th>Last seen</th></tr></thead>
    <tbody>
      ${rows.map((d) => {
        const [kind, label] = statusOf(d);
        return html`<tr onClick=${() => (location.hash = d.link)}>
          <td><a class="dev-name" href=${d.link}>
            <span class="dev-tile"><${Icon} name=${d.status === 'pending' ? 'help-circle-outline' : d.type === 'viewport' ? 'tablet-dashboard' : 'remote'} size=${17} /></span>
            <span class="dev-text"><b>${d.name}</b>${d.name !== d.mac && html`<code class="dev-mac">${d.mac}</code>`}</span>
          </a></td>
          <td><span class="status"><span class=${`dot ${kind ? `dot-${kind}` : ''}`}></span>${label}</span></td>
          <td>${d.assignedTo || html`<span class="hint">None</span>`}</td>
          <td><${BatteryBar} pct=${d.battery} level=${d.batteryLevel} life=${d.batteryLife} /></td>
          <td><${Signal} rssi=${d.rssi} /></td>
          <td>${d.firmware ? html`<span class="fw-cell"><code>${d.firmware}</code><${UpdateIcon} u=${d.update} /></span>` : html`<span class="hint">—</span>`}</td>
          <td class="hint">${timeAgo(d.lastSeenAt)}</td>
        </tr>`;
      })}
    </tbody>
  </table></div>
  ${!rows.length && html`<p class="hint" style="padding:14px 16px">No device matches.</p>`}
  <div class="table-foot">Showing ${rows.length} of ${shown.length}<span class="pagebar-sp"></span>Battery, Wi-Fi and firmware come from each device on its check-ins; days left are learned from its own discharge.</div>`;
}

function HomeAssistantCard({ ha, server }) {
  const status = !ha.configured
    ? html`<${Badge} kind="bad" icon="close-circle-outline">Not set up<//>`
    : ha.reachable === false
      ? html`<${Badge} kind="bad" icon="lan-disconnect">Unreachable<//>`
      : ha.reachable
        ? html`<${Badge} kind="ok" icon="check-circle-outline">Connected<//>`
        : html`<${Badge} icon="timer-sand">No requests yet<//>`;
  const h = ha.lastHour || {};
  return html`<${Card} icon="home-assistant" title="Home Assistant" subtitle=${server.haHost || 'No address set'} actions=${status}>
    <div class="kv kv-home">
      <span>Last good answer</span><b>${ha.lastOkAt ? timeAgo(ha.lastOkAt) : '—'}</b>
      <span>Requests, last hour</span><b>${(h.ok || 0) + (h.errors || 0)}${h.errors ? html` <span class="text-bad">(${h.errors} failed)</span>` : ''}</b>
      <span>Average response</span><b>${h.avgMs != null ? `${h.avgMs} ms` : '—'}</b>
    </div>
    ${ha.recent && ha.recent.length > 0 &&
    html`<h3 class="sub-heading">Recent errors</h3>
      <div class="err-list">
        ${ha.recent.slice(0, 8).map((r) => html`<div class="err-row"><span class="hint">${timeAgo(r.at)}</span><code>${r.path}</code><span class="text-bad">${r.error}</span></div>`)}
      </div>`}
  <//>`;
}

function ServerCard({ server }) {
  return html`<${Card} icon="server" title="This server">
    <div class="kv kv-home">
      <span>Version</span><b>${server.version}</b>
      <span>Running since</span><b>${timeAgo(server.startedAt)}</b>
      <span>Devices find it at</span><b><code>${String(server.mdnsHostname).replace(/\.local$/, '')}.local:${server.port}</code></b>
    </div>
  <//>`;
}

// #/home/<view>: scroll to that part (and, for batteries, filter to them).
const VIEW_TARGET = { attention: 'home-attention', devices: 'home-devices', batteries: 'home-devices', 'home-assistant': 'home-ha' };

export function HomePage({ view }) {
  const { data, error, reload } = useOverview();
  const [filter, setFilter] = useState('all');
  const ready = Boolean(data);
  useEffect(() => {
    if (view === 'batteries') setFilter('battery');
    else if (view === 'devices') setFilter('all');
    const el = ready && document.getElementById(VIEW_TARGET[view] || '');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (ready && !view) document.querySelector('.main').scrollTo({ top: 0 });
  }, [view, ready]);
  if (!data) {
    return html`<div class="page"><p class="hint">${error || 'Loading…'}</p></div>`;
  }
  const c = data.counts;
  const pending = data.devices.filter((d) => d.status === 'pending' && !d.expected);
  const low = data.devices.filter((d) => d.status === 'approved' && d.batteryLevel && d.batteryLevel !== 'ok').sort((a, b) => a.battery - b.battery);
  const u = data.updates;
  const toUpdate = u && u.enabled ? data.devices.filter((d) => d.update && (d.update.state === 'pending' || d.update.state === 'failed')).length : null;
  const lowLife = low[0] && batteryLifeText(low[0].batteryLife).short;
  return html`<div class="page">
    <div class="page-head">
      <div class="ph-text">
        <h1>Dashboard</h1>
        <p class="hint">How every remote, viewport and the link to Home Assistant is doing.</p>
      </div>
      <div class="page-actions">
        ${error && html`<span class="flash flash-bad">${error}</span>`}
        ${pending.length > 0 && html`<a class="btn btn-primary" href=${pending.length === 1 ? pending[0].link : '#/remotes'}><${Icon} name="check-decagram-outline" size=${18} /><span>Approve ${pending.length} device${pending.length === 1 ? '' : 's'}</span></a>`}
      </div>
    </div>

    <div class="stack">
    <div class="kpis">
      <${Kpi} icon="remote" label="Remotes online" value=${c.remotesOnline} of=${`/ ${c.remotes}`} href="#/remotes"
        bar=${c.remotes ? (c.remotesOnline / c.remotes) * 100 : 0} kind=${c.remotes && c.remotesOnline < c.remotes ? 'warn' : ''} />
      <${Kpi} icon="tablet-dashboard" label="Viewports online" value=${c.viewportsOnline} of=${`/ ${c.viewports}`} href="#/viewports"
        bar=${c.viewports ? (c.viewportsOnline / c.viewports) * 100 : 0} kind=${c.viewports && c.viewportsOnline < c.viewports ? 'warn' : ''} />
      <${Kpi} icon="shield-key-outline" label="Waiting for approval" value=${c.pending} kind=${c.pending ? 'warn' : ''} href="#/remotes"
        sub=${pending[0] ? `${pending[0].name} · ${timeAgo(pending[0].lastSeenAt)}` : 'None waiting'} />
      <${Kpi} icon="battery-alert-variant-outline" label="Low batteries" value=${c.lowBattery} kind=${c.lowBattery ? 'warn' : ''} href="#/home/batteries"
        sub=${low[0] ? `${low[0].name}${lowLife ? ` · ${lowLife} left` : ''}` : 'All charged'} />
      <${Kpi} icon="update" label="Firmware" value=${toUpdate == null ? 'Off' : toUpdate} of=${toUpdate ? 'to update' : null} href="#/settings/updates"
        sub=${toUpdate == null ? 'Updates are off' : u.boards.length ? u.boards.map((b) => `${boardLabel(b.board)} ${b.release}`).join(' · ') : 'No release chosen'} />
    </div>

    <div class="home-row">
      <div id="home-attention">
      <${Card} title="Needs attention" class="card-flush"
        actions=${html`${c.critical > 0 && html`<${Badge} kind="bad">${c.critical} critical<//>`}${c.warn > 0 && html`<${Badge} kind="warn">${c.warn} warning${c.warn === 1 ? '' : 's'}<//>`}${data.attention.length - c.critical - c.warn > 0 && html`<${Badge}>${data.attention.length - c.critical - c.warn} tip${data.attention.length - c.critical - c.warn === 1 ? '' : 's'}<//>`}`}>
        <${Attention} items=${data.attention} />
      <//>
      </div>
      <${Card} title="Firmware rollout" actions=${html`<a class="hint" href="#/settings/updates">Settings → Firmware updates</a>`}>
        <${Rollout} u=${u} devices=${data.devices} reload=${reload} />
      <//>
    </div>

    <div id="home-devices">
    <${Card} title="Devices" subtitle=${`${data.devices.filter((d) => d.status !== 'revoked').length} devices · ${c.rooms} room${c.rooms === 1 ? '' : 's'} · ${c.layouts} viewport layout${c.layouts === 1 ? '' : 's'}`} class="card-flush">
      <${Devices} devices=${data.devices} filter=${filter} setFilter=${setFilter} />
    <//>
    </div>

    <div class="grid" id="home-ha">
      <${HomeAssistantCard} ha=${data.ha} server=${data.server} />
      <${ServerCard} server=${data.server} />
    </div>
    </div>
  </div>`;
}
