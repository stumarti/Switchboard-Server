// Switchboard (the home page, the rail's logo): how the whole setup is doing
// (GET /api/overview).
//
//   Tiles           remotes and viewports online, devices waiting for
//                   approval, low batteries, Home Assistant
//   Needs attention everything worth acting on, worst first, each linking to
//                   where it's fixed
//   Devices         every paired device: battery, signal, firmware, last seen
//   Home Assistant  how the server's requests to HA are going, recent errors
//
// Polled every 10 s while the tab is visible.

import { html, useState, useEffect, api, Icon, Card, Badge, Button, Empty, timeAgo, useFlash } from './lib.js';

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
    const t = setInterval(() => !document.hidden && load(), 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { data, error };
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

function BatteryBar({ pct, level }) {
  if (pct == null) return html`<span class="hint">—</span>`;
  const cls = level === 'critical' ? 'bad' : level === 'low' ? 'warn' : 'ok';
  const icon = pct >= 95 ? 'battery' : `battery-${Math.max(10, Math.round(pct / 10) * 10)}`;
  return html`<span class=${`battery battery-${cls}`} title=${`${pct}%`}>
    <${Icon} name=${pct <= 10 ? 'battery-alert-variant-outline' : icon} size=${18} />
    <span class="battery-bar"><span style=${{ width: `${pct}%` }}></span></span>
    <span>${pct}%</span>
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
          <td><${BatteryBar} pct=${d.battery} level=${d.batteryLevel} /></td>
          <td><${Signal} rssi=${d.rssi} /></td>
          <td>${d.firmware ? html`<code>${d.firmware}</code>` : html`<span class="hint">—</span>`}</td>
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

// Remote updates (lib/firmware.js) at a glance, with the next step as a
// button: get the newest release, send it to the pilots, then to everyone.
function UpdatesCard() {
  const [fw, setFw] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();
  const load = () => api('/api/firmware').then(setFw).catch(() => setFw(null));
  useEffect(() => {
    load();
  }, []);
  if (!fw) return null;
  const s = fw.settings;
  const count = (st) => fw.remotes.filter((r) => r.state === st).length;
  const newest = fw.builds[0] && fw.builds[0].version;
  const run = async (key, fn, done) => {
    setBusy(key);
    try {
      const r = await fn();
      if (done) flash(done(r));
      await load();
    } catch (e) {
      flash(e.message, 8000);
    } finally {
      setBusy('');
    }
  };
  const put = (body) => api('/api/firmware/settings', { method: 'PUT', body });
  const getLatest = () =>
    run('latest', () => api('/api/firmware/latest', { method: 'POST' }), (r) => (r.added ? `Added ${r.version}` : `${r.version} is the newest; already here`));

  let status;
  let actions;
  if (!s.enabled) {
    status = html`<span class="hint">Off. Remotes only change firmware by USB or the web flasher.</span>`;
    actions = html`<a class="btn" href="#/settings/updates"><${Icon} name="cog-outline" size=${18} /><span>Set up</span></a>`;
  } else {
    const pending = count('pending');
    const failed = count('failed');
    const current = count('current');
    status = html`<div class="kv kv-home">
      <span>Release</span><b>${s.release ? html`<code>${s.release}</code> · ${s.stage === 'everyone' ? 'everyone' : `pilot remotes (${s.pilot.length})`}` : 'none chosen'}</b>
      <span>Remotes</span><b>${current} up to date${pending ? ` · ${pending} to update` : ''}${failed ? html` · <span class="text-bad">${failed} failed</span>` : ''}</b>
      <span>How</span><b>${[s.button ? 'from the remote' : '', s.schedule.enabled ? `nightly ${String(s.schedule.fromHour).padStart(2, '0')}:00–${String(s.schedule.toHour).padStart(2, '0')}:00` : ''].filter(Boolean).join(' · ') || 'nothing set'}</b>
    </div>`;
    actions = html`
      <${Button} icon="github" disabled=${Boolean(busy)} onClick=${getLatest}>${busy === 'latest' ? 'Checking…' : 'Get latest release'}<//>
      ${newest && newest !== s.release &&
      html`<${Button} kind="primary" icon="account-hard-hat-outline" disabled=${Boolean(busy) || !s.pilot.length}
          title=${s.pilot.length ? '' : 'Tick pilot remotes on the Remote updates page first'}
          onClick=${() => run('release', () => put({ release: newest }), () => `${newest} goes to the pilot remotes`)}>Send ${newest} to pilots<//>`}
      ${s.release && s.stage !== 'everyone' &&
      html`<${Button} icon="account-group-outline" disabled=${Boolean(busy)}
          onClick=${() => confirm(`Send ${s.release} to every remote?`) && run('everyone', () => put({ stage: 'everyone' }), () => `${s.release} goes to every remote`)}>Release to everyone<//>`}
      <a class="btn btn-ghost" href="#/settings/updates"><${Icon} name="chevron-right" size=${18} /><span>Details</span></a>`;
  }
  return html`<${Card} icon="update" title="Remote updates"
    actions=${s.enabled ? html`<${Badge} kind="ok" icon="check">On<//>` : html`<${Badge}>Off<//>`}>
    ${status}
    ${msg && html`<p class=${`hint ${/fail|error|GitHub|no releases|isn't/i.test(msg) ? 'text-bad' : ''}`}>${msg}</p>`}
    <div class="row" style="margin-top:12px;flex-wrap:wrap">${actions}</div>
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
  const { data, error } = useOverview();
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

    <${Card} icon="devices" title="Devices" subtitle=${`${c.rooms} room${c.rooms === 1 ? '' : 's'} · ${c.layouts} viewport layout${c.layouts === 1 ? '' : 's'}`}>
      <${Devices} devices=${data.devices} />
    <//>

    <div class="grid">
      <${HomeAssistantCard} ha=${ha} server=${data.server} />
      <${ServerCard} server=${data.server} />
      <${UpdatesCard} />
    </div>
    </div>
  </div>`;
}
