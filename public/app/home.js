// Switchboard (the home page, the rail's logo): how the whole setup is doing
// (GET /api/overview).
//
//   Tiles           remotes and viewports online, devices waiting for
//                   approval, low batteries, Home Assistant
//   Needs attention everything worth acting on, worst first, each linking to
//                   where it's fixed
//   Devices         every paired device: battery, signal, firmware, last seen;
//                   "Update now" when remotes are due a new release
//   Home Assistant  how the server's requests to HA are going, recent errors
//
// Polled every 10 s while the tab is visible.

import { html, useState, useEffect, api, Icon, Card, Badge, Button, Empty, timeAgo, batteryLifeText } from './lib.js';

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
  firmware: 'chip'
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

// "Update now": remotes due the release install it at their next wake,
// whatever the update schedule (lib/firmware.js updateNow). While it's with
// the pilots, "Update all" skips them: the release goes to everyone too.
// Shown only while some remote is still to get the release.
function UpdateNow({ u, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!u || !u.enabled || !u.release || (!u.pending && !u.pendingEveryone && !u.now)) return null;
  const act = async (method, body) => {
    setBusy(true);
    setMsg('');
    try {
      await api('/api/firmware/update-now', { method, body });
      reload();
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  };
  const n = (k) => `${k} remote${k === 1 ? '' : 's'}`;
  if (u.now && u.now.waiting > 0) {
    return html`<div class="row update-now">
      <span title=${`Each installs ${u.release} the next time it wakes, whatever the update schedule.`}><${Badge} kind="accent" icon="timer-sand">${n(u.now.waiting)} updating at next wake<//></span>
      <${Button} small kind="ghost" disabled=${busy} onClick=${() => act('DELETE')}>Cancel<//>
    </div>`;
  }
  // With the pilots, and there are remotes beyond them: skip the pilot.
  const skip = u.stage === 'pilot' && u.pendingEveryone > u.pending;
  const skipPilot = () =>
    confirm(`Release ${u.release} to every remote, without waiting for the pilots, and install it on all ${n(u.pendingEveryone)} at their next wake?`) &&
    act('POST', { everyone: true });
  return html`<div class="row update-now">
    ${msg && html`<span class="flash flash-bad">${msg}</span>`}
    ${u.pending > 0 &&
    html`<${Button} small icon="update" disabled=${busy}
      title=${`Each remote due ${u.release}${u.stage === 'pilot' ? ' (the pilot remotes, until it’s released to everyone)' : ''} installs it the next time it wakes, whatever the update schedule.`}
      onClick=${() => act('POST')}>Update ${u.stage === 'pilot' ? `${u.pending === 1 ? 'the pilot' : `${u.pending} pilots`}` : n(u.pending)} to ${u.release} now<//>`}
    ${skip &&
    html`<${Button} small icon="fast-forward-outline" kind=${u.pending > 0 ? 'ghost' : 'secondary'} disabled=${busy}
      title=${`Skip the pilot: release ${u.release} to everyone, and every remote not on it installs it the next time it wakes.`}
      onClick=${skipPilot}>Update all ${u.pendingEveryone} now${u.pending > 0 ? ' (skip pilot)' : ''}<//>`}
  </div>`;
}

function Tile({ icon, label, value, sub, kind = '', href }) {
  const body = html`<div class=${`home-tile ${kind ? `ht-${kind}` : ''}`}>
    <div class="ht-icon"><${Icon} name=${icon} size=${22} /></div>
    <div class="ht-text">
      <div class="ht-value">${value}</div>
      <div class="ht-label">${label}</div>
      ${sub && html`<div class="hint">${sub}</div>`}
    </div>
  </div>`;
  return href ? html`<a class="ht-link" href=${href}>${body}</a>` : body;
}

function BatteryBar({ pct, level, life }) {
  if (pct == null) return html`<span class="hint">—</span>`;
  const est = batteryLifeText(life);
  const cls = level === 'critical' ? 'bad' : level === 'low' ? 'warn' : 'ok';
  const icon = pct >= 95 ? 'battery' : `battery-${Math.max(10, Math.round(pct / 10) * 10)}`;
  return html`<span class=${`battery battery-${cls}`} title=${`${pct}%`}>
    <${Icon} name=${pct <= 10 ? 'battery-alert-variant-outline' : icon} size=${18} />
    <span class="battery-bar"><span style=${{ width: `${pct}%` }}></span></span>
    <span>${pct}%</span>
    ${est.short && html`<span class="battery-days hint" title=${est.tip}>${est.short}</span>`}
  </span>`;
}

function Signal({ rssi }) {
  if (rssi == null) return html`<span class="hint">—</span>`;
  const bars = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return html`<span class=${`signal ${bars <= 1 ? 'signal-weak' : ''}`} title=${`${rssi} dBm`}>
    <${Icon} name=${`wifi-strength-${bars}`} size=${18} /> ${rssi} dBm
  </span>`;
}

function Attention({ items }) {
  if (!items.length) {
    return html`<div class="all-good"><${Icon} name="check-circle-outline" size=${28} /><div><b>All good</b><div class="hint">Nothing needs attention.</div></div></div>`;
  }
  return html`<div class="attention">
    ${items.map((a) => {
      const lv = LEVEL[a.level];
      const inner = html`<span class=${`att-icon att-${lv.cls}`}><${Icon} name=${KIND_ICON[a.kind] || lv.icon} size=${20} /></span>
        <span class="att-text"><b>${a.title}</b><span class="hint">${a.detail}</span></span>
        ${a.link && html`<${Icon} name="chevron-right" size=${20} class="att-go" />`}`;
      return a.link ? html`<a class="att-item" href=${a.link}>${inner}</a>` : html`<div class="att-item">${inner}</div>`;
    })}
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

function Devices({ devices }) {
  const shown = devices.filter((d) => d.status !== 'revoked');
  if (!shown.length) {
    return html`<${Empty} icon="devices" title="No devices yet">Turn a remote or a viewport on: it asks to pair, and shows up here to approve.<//>`;
  }
  const order = { pending: 0, approved: 1 };
  const sorted = [...shown].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>Device</th><th>Room / layout</th><th>Battery</th><th>Wi-Fi</th><th>Firmware</th><th>Last seen</th></tr></thead>
    <tbody>
      ${sorted.map(
        (d) => html`<tr>
          <td><a class="dev-name" href=${d.link}>
            <span class=${`dot ${d.status === 'pending' ? 'dot-warn' : d.online ? 'dot-ok' : ''}`}></span>
            <${Icon} name=${d.type === 'viewport' ? 'tablet-dashboard' : 'remote'} size=${18} />
            <span>${d.name}</span>
          </a></td>
          <td>${d.status === 'pending' ? html`<${Badge} kind="warn" icon="account-clock-outline">Waiting for approval<//>` : d.assignedTo || html`<span class="hint">None</span>`}</td>
          <td><${BatteryBar} pct=${d.battery} level=${d.batteryLevel} life=${d.batteryLife} /></td>
          <td><${Signal} rssi=${d.rssi} /></td>
          <td>${d.firmware ? html`<span class="fw-cell"><code>${d.firmware}</code><${UpdateIcon} u=${d.update} /></span>` : html`<span class="hint">—</span>`}</td>
          <td>${timeAgo(d.lastSeenAt)}</td>
        </tr>`
      )}
    </tbody>
  </table></div>
  <p class="hint">Battery, Wi-Fi and firmware come from the device itself on each check-in; older firmware doesn't send them.</p>`;
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

export function HomePage() {
  const { data, error, reload } = useOverview();
  if (!data) {
    return html`<div class="page"><p class="hint">${error || 'Loading…'}</p></div>`;
  }
  const c = data.counts;
  const ha = data.ha;
  const haKind = !ha.configured || ha.reachable === false ? 'bad' : ha.lastHour && ha.lastHour.errors ? 'warn' : ha.reachable ? 'ok' : '';
  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon"><${Icon} name="remote-tv" size=${26} /></div>
      <div class="ph-text">
        <h1>Switchboard</h1>
        <p class="hint">How every remote, viewport and the link to Home Assistant is doing.</p>
      </div>
      ${error && html`<div class="page-actions"><span class="flash flash-bad">${error}</span></div>`}
    </div>

    <div class="stack">
    <div class="home-tiles">
      <${Tile} icon="remote" label="Remotes online" value=${`${c.remotesOnline} / ${c.remotes}`} kind=${c.remotes && c.remotesOnline < c.remotes ? 'warn' : ''} href="#/remotes" />
      <${Tile} icon="tablet-dashboard" label="Viewports online" value=${`${c.viewportsOnline} / ${c.viewports}`} kind=${c.viewports && c.viewportsOnline < c.viewports ? 'warn' : ''} href="#/viewports" />
      <${Tile} icon="account-clock-outline" label="Waiting for approval" value=${c.pending} kind=${c.pending ? 'warn' : ''} href="#/remotes" />
      <${Tile} icon="battery-alert-variant-outline" label="Low batteries" value=${c.lowBattery} kind=${c.lowBattery ? 'bad' : ''} />
      <${Tile} icon="home-assistant" label="Home Assistant"
        value=${!ha.configured ? 'Not set up' : ha.reachable === false ? 'Down' : ha.lastHour && ha.lastHour.avgMs != null ? `${ha.lastHour.avgMs} ms` : 'OK'}
        sub=${ha.lastHour && ha.lastHour.errors ? `${ha.lastHour.errors} failed in the last hour` : ''} kind=${haKind} href="#/settings/home-assistant" />
    </div>

    <${Card} icon="bell-outline" title="Needs attention"
      actions=${html`${c.critical > 0 && html`<${Badge} kind="bad">${c.critical} critical<//>`}${c.warn > 0 && html`<${Badge} kind="warn">${c.warn} warning${c.warn === 1 ? '' : 's'}<//>`}`}>
      <${Attention} items=${data.attention} />
    <//>

    <${Card} icon="devices" title="Devices" subtitle=${`${c.rooms} room${c.rooms === 1 ? '' : 's'} · ${c.layouts} viewport layout${c.layouts === 1 ? '' : 's'}`}
      actions=${html`<${UpdateNow} u=${data.updates} reload=${reload} />`}>
      <${Devices} devices=${data.devices} />
    <//>

    <div class="grid">
      <${HomeAssistantCard} ha=${ha} server=${data.server} />
      <${ServerCard} server=${data.server} />
    </div>
    </div>
  </div>`;
}
