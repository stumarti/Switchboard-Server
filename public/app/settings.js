// Settings: everything shared by every room and device — the Home Assistant
// connection, Wi-Fi, the clock, the theme (icon + font packs), sign out.

import {
  html, useState, useEffect, api, Icon, Card, Field, TextInput, SecretInput, Button, Badge, useFlash, useApi, setIn, Toggle, timeAgo
} from './lib.js';
import { haStatus, useHaStatus, IconPickerModal, IconPreview } from './pickers.js';
import { ItemList } from './rooms.js';
import { RemoteUpdatesTab } from './firmware.js';
import { builtInArt } from './viewport-art.js';

const TABS = [
  { id: 'home-assistant', label: 'Home Assistant', icon: 'home-assistant' },
  { id: 'wifi', label: 'Wi-Fi', icon: 'wifi' },
  { id: 'clock', label: 'Clock', icon: 'clock-outline' },
  { id: 'theme', label: 'Theme', icon: 'palette-outline' },
  { id: 'updates', label: 'Remote updates', icon: 'update' },
  { id: 'account', label: 'Account', icon: 'account-circle-outline' }
];

// Globals (/api/globals) are edited as one object and always saved whole:
// the server treats a missing list as empty.
function useGlobals() {
  const [globals, setGlobals] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useFlash();
  useEffect(() => {
    api('/api/globals').then(setGlobals).catch((e) => flash(e.message, 0));
  }, []);
  const set = (path, v) => {
    setGlobals((g) => setIn(g, path, v));
    setDirty(true);
  };
  const save = async () => {
    try {
      setGlobals(await api('/api/globals', { method: 'POST', body: globals }));
      setDirty(false);
      flash('Saved');
      return true;
    } catch (e) {
      flash(`Save failed: ${e.message}`, 6000);
      return false;
    }
  };
  return { globals, set, save, dirty, msg };
}

function SaveBar({ g, after }) {
  return html`<div class="row" style="align-items:center">
    <${Button} kind="primary" icon="content-save-outline" disabled=${!g.dirty} onClick=${async () => (await g.save()) && after && after()}>Save<//>
    <span class=${`flash ${g.msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${g.msg}</span>
  </div>`;
}

function HomeAssistantTab() {
  const g = useGlobals();
  const ha = useHaStatus();
  const [testing, setTesting] = useState(false);
  if (!g.globals) return html`<p class="hint">Loading…</p>`;
  const h = g.globals.homeAssistant || {};
  const test = async () => {
    setTesting(true);
    await haStatus.refresh();
    setTesting(false);
  };
  return html`<div class="grid">
    <${Card} icon="home-assistant" title="Connection" subtitle="Used by the server for entity search and by every device to control things."
      actions=${ha.ok === null ? null : ha.ok ? html`<${Badge} kind="ok" icon="check-circle-outline">Connected<//>` : html`<${Badge} kind="bad" icon="alert-circle-outline">Not connected<//>`}>
      <div class="row">
        <${Field} label="Host" hint="IP or hostname the devices can reach, without http://"><${TextInput} value=${h.host} placeholder="192.168.1.10" onInput=${(v) => g.set(['homeAssistant', 'host'], v)} /><//>
        <div style="max-width:110px"><${Field} label="Port"><${TextInput} type="number" value=${h.port} onInput=${(v) => g.set(['homeAssistant', 'port'], Number(v) || 8123)} /><//></div>
      </div>
      <${Field} label="Long-lived access token" hint="Home Assistant → your profile → Security → Long-lived access tokens.">
        <${SecretInput} value=${h.token} onInput=${(v) => g.set(['homeAssistant', 'token'], v)} />
      <//>
      ${ha.ok === false && html`<p class="hint" style="color:var(--bad)">${ha.error}</p>`}
      <div class="row" style="align-items:center">
        <${SaveBar} g=${g} after=${test} />
        <${Button} icon="lan-connect" disabled=${testing || g.dirty} onClick=${test}>${testing ? 'Testing…' : 'Test'}<//>
      </div>
    <//>
    <${PublishCard} g=${g} />
  </div>`;
}

// Battery sensors published back to Home Assistant (lib/ha-publish.js).
function PublishCard({ g }) {
  const on = Boolean((g.globals.homeAssistant || {}).publishBattery);
  const [st, setSt] = useState(null);
  const load = () => api('/api/ha/publish').then(setSt).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const entities = (st && st.entities) || [];
  return html`<${Card} icon="battery-sync-outline" title="Battery in Home Assistant"
    subtitle="Each remote's and viewport's battery and the days it has left, and each viewport's temperature, humidity and battery voltage, as Home Assistant sensors."
    actions=${st && st.enabled && (st.error ? html`<${Badge} kind="bad" icon="alert-circle-outline">Not publishing<//>` : st.lastSyncAt ? html`<${Badge} kind="ok" icon="check-circle-outline">Publishing<//>` : null)}>
    <${Toggle} checked=${on} onChange=${(v) => g.set(['homeAssistant', 'publishBattery'], v)} label="Publish battery to Home Assistant" />
    <p class="hint">Two sensors a device, such as <code>sensor.switchboard_kitchen_remote_battery</code> and <code>…_battery_days_left</code>, with its room, firmware and drain rate as attributes. Nothing to install in Home Assistant. It keeps them up to date and puts them back after Home Assistant restarts; switching this off removes them.</p>
    ${st && st.enabled && st.error && html`<p class="hint" style="color:var(--bad)">${st.error}</p>`}
    ${st && st.enabled && !st.error && st.lastSyncAt && html`<p class="hint">${entities.length} sensor${entities.length === 1 ? '' : 's'}, last sent ${timeAgo(st.lastSyncAt)}.</p>`}
    ${entities.length > 0 && st.enabled && html`<details class="hint"><summary>Entities</summary><ul style="margin:6px 0 0;padding-left:18px">${entities.map((e) => html`<li><code>${e}</code></li>`)}</ul></details>`}
    <${SaveBar} g=${g} after=${() => setTimeout(load, 7000)} />
  <//>`;
}

function WifiTab() {
  const g = useGlobals();
  if (!g.globals) return html`<p class="hint">Loading…</p>`;
  const w = g.globals.wifi || {};
  return html`<div class="grid">
    <${Card} icon="wifi-cog" title="Device Wi-Fi" subtitle="The network remotes join. Also offered on a new remote's setup screen.">
      <${Field} label="Network name (SSID)"><${TextInput} value=${w.ssid} onInput=${(v) => g.set(['wifi', 'ssid'], v)} /><//>
      <${Field} label="Password"><${SecretInput} value=${w.password} onInput=${(v) => g.set(['wifi', 'password'], v)} /><//>
      <${SaveBar} g=${g} />
    <//>
    <${Card} icon="wifi-star" title="Guest Wi-Fi page" subtitle="Networks the Guest Wi-Fi page shows as QR codes.">
      <${ItemList}
        items=${g.globals.wifiNetworks || []}
        onChange=${(l) => g.set(['wifiNetworks'], l)}
        addLabel="Add network"
        empty="No networks yet."
        newItem=${() => ({ id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2), name: '', password: '' })}
        render=${(it, upd) => html`<div class="row">
          <${Field} label="Name (SSID)"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
          <${Field} label="Password"><${SecretInput} value=${it.password} onInput=${(v) => upd({ ...it, password: v })} /><//>
        </div>`}
      />
      <${SaveBar} g=${g} />
    <//>
  </div>`;
}

// The server's clock against this browser's: fetched once a minute, ticked
// locally in between (with the fetch's round trip halved out). Remotes set
// their clock from the server's HTTP Date header, and viewports get their
// times from it, so this is the clock that matters.
function useServerTime() {
  const [t, setT] = useState(null); // {offsetMs, timeZone, ntpServer, error}
  const [, tick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const sent = Date.now();
      api('/api/time')
        .then((r) => {
          const got = Date.now();
          const server = Date.parse(r.now) + (got - sent) / 2;
          if (alive) setT({ offsetMs: server - got, timeZone: r.timeZone, ntpServer: r.ntpServer });
        })
        .catch((e) => alive && setT({ error: e.message }));
    };
    load();
    const poll = setInterval(load, 60000);
    const sec = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(sec);
    };
  }, []);
  return t;
}

const fmtClock = (ms, timeZone) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone }).format(new Date(ms));
const fmtDate = (ms, timeZone) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(new Date(ms));
// Within 5 s counts as in step (a page's own timers aren't more exact).
const driftOf = (t) => (t && !t.error ? Math.round(t.offsetMs / 1000) : null);

// A compact "Server time" chip for the Settings header, on every tab.
function ServerTimeChip() {
  const t = useServerTime();
  if (!t) return null;
  if (t.error) return html`<${Badge} kind="bad" icon="clock-alert-outline">Server time unavailable<//>`;
  const drift = driftOf(t);
  const ok = Math.abs(drift) <= 5;
  return html`<a href="#/settings/clock" class="time-chip" title=${ok ? 'The server’s clock matches this browser’s' : `The server’s clock is ${Math.abs(drift)} s ${drift > 0 ? 'ahead of' : 'behind'} this browser’s`}>
    <${Badge} kind=${ok ? 'ok' : 'warn'} icon=${ok ? 'clock-check-outline' : 'clock-alert-outline'}>Server time ${fmtClock(Date.now() + t.offsetMs, t.timeZone)}<//>
  </a>`;
}

function ServerTimeCard() {
  const t = useServerTime();
  const drift = driftOf(t);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return html`<${Card} icon="clock-check-outline" title="Server time" subtitle="Check the server's clock and time zone against yours: remotes set their clock from it, and every time a viewport shows is formatted with it.">
    ${!t
      ? html`<p class="hint">Asking the server…</p>`
      : t.error
        ? html`<p class="text-bad">${t.error}</p>`
        : html`<div class="time-compare">
            <div><div class="hint">This server</div><div class="time-big">${fmtClock(Date.now() + t.offsetMs, t.timeZone)}</div><div class="hint">${fmtDate(Date.now() + t.offsetMs, t.timeZone)} · ${t.timeZone}</div></div>
            <div><div class="hint">This browser</div><div class="time-big">${fmtClock(Date.now(), browserTz)}</div><div class="hint">${fmtDate(Date.now(), browserTz)} · ${browserTz}</div></div>
          </div>
          ${Math.abs(drift) <= 5
            ? html`<p><${Badge} kind="ok" icon="check-circle-outline">In step<//> <span class="hint">${drift === 0 ? 'Same second.' : `${Math.abs(drift)} s apart.`}</span></p>`
            : html`<p><${Badge} kind="warn" icon="clock-alert-outline">${Math.abs(drift)} s ${drift > 0 ? 'ahead' : 'behind'}<//> <span class="hint">The server's clock is off. Check its host's time sync (NTP): remotes would show the same error.</span></p>`}
          ${t.timeZone !== browserTz && html`<p class="hint"><${Icon} name="earth" size=${14} /> The server's time zone (${t.timeZone}) differs from this browser's (${browserTz}). Viewports show the server's; set TZ on the server (e.g. <code>TZ=Europe/London</code> in docker-compose) if that's wrong.</p>`}`}
  <//>`;
}

function ClockTab() {
  const g = useGlobals();
  if (!g.globals) return html`<p class="hint">Loading…</p>`;
  return html`<div class="grid">
    <${ServerTimeCard} />
    <${Card} icon="clock-outline" title="Time server" subtitle="Devices set their clock from this NTP server.">
      <${Field} label="NTP server"><${TextInput} value=${g.globals.ntpServer} placeholder="pool.ntp.org" onInput=${(v) => g.set(['ntpServer'], v)} /><//>
      <${SaveBar} g=${g} />
    <//>
  </div>`;
}

// --- Theme ------------------------------------------------------------------------

function IconSlots({ kind, overrides, setOverrides }) {
  const [slots] = useApi(`/api/assets/icon-slots?kind=${kind}`);
  const [picking, setPicking] = useState(null);
  const [filter, setFilter] = useState('');
  if (!slots) return html`<p class="hint">Loading…</p>`;
  const needle = filter.trim().toLowerCase();
  const shown = slots.filter((s) => !needle || `${s.key} ${s.label} ${s.category}`.toLowerCase().includes(needle));
  const cats = [...new Set(shown.map((s) => s.category))];
  return html`<div class="stack">
    <input type="text" placeholder="Filter icons…" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
    ${cats.map(
      (cat) => html`<div>
        <div class="sublist-group" style="padding-left:0">${cat}</div>
        <div class="icon-grid">
          ${shown
            .filter((s) => s.category === cat)
            .map((s) => {
              const cur = overrides[s.key] || s.defaultMdi;
              // A viewport keeps its built-in colour art until you change it.
              const art = kind === 'viewport' && !overrides[s.key] ? builtInArt(s.key) : null;
              return html`<button type="button" class="icon-cell" title=${`${s.label} (${art ? 'built-in colour art' : cur})`} onClick=${() => setPicking(s)}
                style=${overrides[s.key] ? 'border-color:var(--accent)' : ''}>
                ${art ? html`<img src=${art} width=${30} height=${30} alt="" />` : html`<${IconPreview} name=${cur} size=${30} />`}
                <span>${s.label}</span>
              </button>`;
            })}
        </div>
      </div>`
    )}
    ${picking &&
    html`<${IconPickerModal}
      title=${`Icon for “${picking.label}”`}
      onPick=${(n) => {
        setOverrides({ ...overrides, [picking.key]: n });
        setPicking(null);
      }}
      onClose=${() => setPicking(null)}
    />`}
  </div>`;
}

function readFile(file, as) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(as === 'base64' ? String(r.result).split(',')[1] : r.result);
    r.onerror = reject;
    if (as === 'base64') r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

function CustomIcons() {
  const [list, , reload] = useApi('/api/assets/icons/custom');
  const [name, setName] = useState('');
  const [msg, flash] = useFlash();
  const upload = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const n = (name || file.name.replace(/\.svg$/i, '')).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    try {
      await api('/api/assets/icons/custom', { method: 'POST', body: { name: n, svg: await readFile(file, 'text') } });
      setName('');
      flash(`Added “${n}”`);
      reload();
    } catch (e) {
      flash(e.message, 6000);
    }
  };
  const remove = async (n) => {
    if (!confirm(`Delete the custom icon “${n}”?`)) return;
    await api(`/api/assets/icons/custom/${encodeURIComponent(n)}`, { method: 'DELETE' });
    reload();
  };
  return html`<${Card} icon="file-upload-outline" title="Custom icons" subtitle="Upload an SVG to use it anywhere an icon can be picked.">
    <div class="row">
      <${Field} label="Name (optional)"><${TextInput} value=${name} placeholder="from the file name" onInput=${setName} /><//>
      <label class="btn"><${Icon} name="upload" size=${18} /><span>Upload SVG</span><input type="file" accept=".svg,image/svg+xml" hidden onChange=${upload} /></label>
    </div>
    <span class="flash">${msg}</span>
    <div class="icon-grid">
      ${(list || []).map(
        (c) => html`<div class="icon-cell" title=${c.name}>
          <${IconPreview} name=${c.name} size=${30} />
          <span>${c.name}</span>
          <${Button} kind="ghost" small icon="trash-can-outline" title="Delete" onClick=${() => remove(c.name)} />
        </div>`
      )}
    </div>
  <//>`;
}

function Fonts({ theme, reloadTheme }) {
  const [googleFont, setGoogleFont] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  const compile = async () => {
    setBusy(true);
    try {
      const body = file ? { ttfBase64: await readFile(file, 'base64') } : { googleFont: googleFont.trim() };
      const r = await api('/api/assets/fonts/compile', { method: 'POST', body });
      flash(`Font pack ${r.version} built — devices update on their next refresh`, 6000);
      reloadTheme();
    } catch (e) {
      flash(`Failed: ${e.message}`, 8000);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Card} icon="format-font" title="Font" subtitle="One typeface for remotes and viewports, rendered at every size each draws (viewports also use its bold weight)."
    actions=${theme && theme.fontsVersion ? html`<${Badge} icon="package-variant-closed">${theme.fontsVersion}<//>` : html`<${Badge}>Built-in<//>`}>
    <${Field} label="Google Font family"><${TextInput} value=${googleFont} placeholder="e.g. Inter" onInput=${(v) => {
      setGoogleFont(v);
      setFile(null);
    }} /><//>
    <${Field} label="…or upload a TTF"><input type="file" accept=".ttf,font/ttf" onChange=${(e) => setFile(e.target.files[0] || null)} /><//>
    <div class="row" style="align-items:center">
      <${Button} kind="primary" icon="hammer-wrench" disabled=${busy || (!file && !googleFont.trim())} onClick=${compile}>${busy ? 'Building…' : 'Build font pack'}<//>
      <span class=${`flash ${msg.startsWith('Failed') ? 'flash-bad' : ''}`}>${msg}</span>
    </div>
  <//>`;
}

// Remotes and viewports draw different icons, so each has its own set to
// re-skin (and its own pack); the font is shared.
const THEME_KINDS = [
  { id: 'remote', label: 'Remotes', icon: 'remote' },
  { id: 'viewport', label: 'Viewports', icon: 'monitor-dashboard' }
];

function IconsCard({ kind, setKind }) {
  const [theme, , reloadTheme] = useApi(`/api/theme?kind=${kind}`);
  const [overrides, setOverrides] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  useEffect(() => {
    if (theme && overrides === null) setOverrides(theme.iconOverrides || {});
  }, [theme]);
  const compile = async () => {
    setBusy(true);
    try {
      const r = await api('/api/assets/icons/compile', { method: 'POST', body: { overrides, kind } });
      flash(`Icon pack ${r.version} built — devices update on their next refresh`, 6000);
      reloadTheme();
    } catch (e) {
      flash(`Failed: ${e.message}`, 8000);
    } finally {
      setBusy(false);
    }
  };
  const count = overrides ? Object.keys(overrides).length : 0;
  const subtitle = kind === 'viewport'
    ? 'Replace any icon the viewport draws. The weather and solar icons are the panel’s own colour art until you change them (a replacement is one colour). Changes take effect once the pack is built.'
    : 'Replace any icon the firmware draws. Changes take effect once the pack is built.';
  return html`<${Card} icon="shape-outline" title="Icons" subtitle=${subtitle}
      actions=${html`${theme && theme.iconsVersion ? html`<${Badge} icon="package-variant-closed">${theme.iconsVersion}<//>` : html`<${Badge}>Built-in<//>`}`}>
      <div class="row" style="align-items:center">
        ${THEME_KINDS.map((k) => html`<${Button} kind=${k.id === kind ? 'primary' : 'ghost'} icon=${k.icon} onClick=${() => setKind(k.id)}>${k.label}<//>`)}
      </div>
      <div class="row" style="align-items:center">
        <${Button} kind="primary" icon="hammer-wrench" disabled=${busy || !overrides} onClick=${compile}>${busy ? 'Building…' : 'Build icon pack'}<//>
        ${count > 0 && html`<${Button} icon="restore" onClick=${() => setOverrides({})}>Reset ${count} changed<//>`}
        <span class=${`flash ${msg.startsWith('Failed') ? 'flash-bad' : ''}`}>${msg}</span>
      </div>
      ${overrides && html`<${IconSlots} kind=${kind} overrides=${overrides} setOverrides=${setOverrides} />`}
    <//>`;
}

function ThemeTab() {
  const [theme, , reloadTheme] = useApi('/api/theme');
  const [kind, setKind] = useState('remote');
  return html`<div class="stack">
    <${IconsCard} key=${kind} kind=${kind} setKind=${setKind} />
    <div class="grid">
      <${Fonts} theme=${theme} reloadTheme=${reloadTheme} />
      <${CustomIcons} />
    </div>
  </div>`;
}

function PasswordCard() {
  const [account, , reloadAccount] = useApi('/api/auth/account');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  const problem = next && next.length < 8 ? 'At least 8 characters.' : again && next !== again ? 'The two new passwords don’t match.' : '';
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/password', { method: 'POST', body: { current, password: next } });
      setCurrent('');
      setNext('');
      setAgain('');
      flash('Password changed. Other signed-in browsers were signed out.', 6000);
      if (reloadAccount) reloadAccount();
    } catch (err) {
      flash(`Failed: ${err.message}`, 6000);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Card} icon="lock-reset" title="Change password" subtitle=${account && account.passwordChangedAt ? `Last changed ${new Date(account.passwordChangedAt).toLocaleString()}.` : 'The admin password for this page.'}>
    ${account && account.passwordFromEnv &&
    html`<p class="banner-inline"><${Icon} name="alert-outline" size=${16} /> <span>ADMIN_PASSWORD is set on this server, so it replaces the password on every restart. Change it there (e.g. docker-compose) to make a new one stick.</span></p>`}
    <form class="stack" onSubmit=${save}>
      <label class="field"><span class="field-label">Current password</span><input type="password" autocomplete="current-password" value=${current} onInput=${(e) => setCurrent(e.target.value)} required /></label>
      <label class="field"><span class="field-label">New password</span><input type="password" autocomplete="new-password" value=${next} onInput=${(e) => setNext(e.target.value)} required /></label>
      <label class="field"><span class="field-label">New password again</span><input type="password" autocomplete="new-password" value=${again} onInput=${(e) => setAgain(e.target.value)} required /></label>
      ${problem && html`<p class="hint text-bad">${problem}</p>`}
      <div class="row" style="align-items:center">
        <${Button} type="submit" kind="primary" icon="lock-check-outline" disabled=${busy || !current || !next || next !== again || next.length < 8}>${busy ? 'Saving…' : 'Change password'}<//>
        <span class=${`flash ${msg.startsWith('Failed') ? 'flash-bad' : ''}`}>${msg}</span>
      </div>
    </form>
  <//>`;
}

function AccountTab({ onSignOut }) {
  const [health] = useApi('/api/health');
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    onSignOut();
  };
  return html`<div class="grid">
    <${Card} icon="server-network" title="This server">
      ${health &&
      html`<dl class="kv">
        <dt>Version</dt><dd>${health.version}</dd>
        <dt>mDNS name</dt><dd>${String(health.mdnsHostname).replace(/\.local$/, '')}.local:${health.port}</dd>
        <dt>Service</dt><dd>${health.mdnsServiceType}</dd>
        <dt>Data folder</dt><dd>${health.dataDir}</dd>
      </dl>`}
    <//>
    <${PasswordCard} />
    <${Card} icon="account-circle-outline" title="Admin session">
      <div><${Button} icon="logout" onClick=${signOut}>Sign out<//></div>
    <//>
  </div>`;
}

export function SettingsPage({ tab, onSignOut }) {
  const active = TABS.find((t) => t.id === tab) || TABS[0];
  let body;
  if (active.id === 'home-assistant') body = html`<${HomeAssistantTab} />`;
  else if (active.id === 'wifi') body = html`<${WifiTab} />`;
  else if (active.id === 'clock') body = html`<${ClockTab} />`;
  else if (active.id === 'theme') body = html`<${ThemeTab} />`;
  else if (active.id === 'updates') body = html`<${RemoteUpdatesTab} />`;
  else body = html`<${AccountTab} onSignOut=${onSignOut} />`;
  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon"><${Icon} name="cog-outline" size=${26} /></div>
      <div class="ph-text"><h1>Settings</h1><p class="hint">Shared by every room and device.</p></div>
      <div class="page-actions"><${ServerTimeChip} /></div>
    </div>
    <nav class="tabs">
      ${TABS.map(
        (t) => html`<a class=${`tab ${t.id === active.id ? 'active' : ''}`} href=${`#/settings/${t.id}`}><${Icon} name=${t.icon} size=${18} />${t.label}</a>`
      )}
    </nav>
    ${body}
  </div>`;
}
