// Settings: everything shared by every room and device — the Home Assistant
// connection, Wi-Fi, the clock, the theme (icon + font packs), sign out.

import {
  html, useState, useEffect, api, Icon, Card, Field, TextInput, SecretInput, Select, Button, Badge, useFlash, useApi, setIn, Toggle, timeAgo
} from './lib.js';
import { haStatus, useHaStatus, IconPickerModal, IconPreview } from './pickers.js';
import { ItemList } from './rooms.js';
import { RemoteUpdatesTab } from './firmware.js';
import { builtInArt } from './viewport-art.js';

import { SETTINGS_PAGES } from './nav.js';

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

// Immich (lib/immich.js): photos for viewports. The key is sent here once
// and never comes back: the page only learns whether one is saved.
function ImmichTab() {
  const [conn, setConn] = useState(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  useEffect(() => {
    api('/api/immich').then((c) => { setConn(c); setUrl(c.url); }).catch((e) => flash(e.message, 0));
  }, []);
  if (!conn) return html`<p class="hint">Loading…</p>`;
  const dirty = url !== conn.url || key !== '';
  const test = async () => {
    setBusy(true);
    try {
      setCheck(await api('/api/immich/test'));
    } catch (e) {
      setCheck({ ok: false, error: e.message });
    }
    setBusy(false);
  };
  const save = async () => {
    try {
      setConn(await api('/api/immich', { method: 'POST', body: { url, apiKey: key } }));
      setKey('');
      flash('Saved');
      await test();
    } catch (e) {
      flash(`Save failed: ${e.message}`, 6000);
    }
  };
  const forget = async () => {
    if (!confirm('Remove the saved API key? Photo sections stop changing until you add one again.')) return;
    setConn(await api('/api/immich', { method: 'POST', body: { clearKey: true } }));
    setCheck(null);
  };
  return html`<div class="grid">
    <${Card} icon="image-multiple-outline" title="Connection" subtitle="Your Immich server, for photo sections and photo backgrounds on viewports."
      actions=${check && (check.ok ? html`<${Badge} kind="ok" icon="check-circle-outline">Connected<//>` : html`<${Badge} kind="bad" icon="alert-circle-outline">Not connected<//>`)}>
      <${Field} label="Address" hint="As this server reaches it, e.g. http://192.168.1.20:2283 or https://photos.example.com">
        <${TextInput} value=${url} placeholder="http://192.168.1.20:2283" onInput=${setUrl} />
      <//>
      <${Field} label="API key" hint=${conn.hasKey ? 'A key is saved. Type a new one to replace it.' : 'In Immich: your account → Account settings → API keys → New API key. Read access to albums, assets, people and memories is enough.'}>
        <${SecretInput} value=${key} placeholder=${conn.hasKey ? '•••••••• (saved)' : ''} onInput=${setKey} />
      <//>
      ${check && (check.ok
        ? html`<p class="hint">Signed in as <b>${check.user || 'your account'}</b>; ${check.albums} album${check.albums === 1 ? '' : 's'}.</p>`
        : html`<p class="hint" style="color:var(--bad)">${check.error}</p>`)}
      <div class="row" style="align-items:center">
        <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty} onClick=${save}>Save<//>
        <${Button} icon="lan-connect" disabled=${busy || dirty || !conn.configured} onClick=${test}>${busy ? 'Testing…' : 'Test'}<//>
        ${conn.hasKey && html`<${Button} icon="key-remove" onClick=${forget}>Remove key<//>`}
        <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
      </div>
    <//>
    <${Card} icon="information-outline" title="How photos reach a display">
      <p class="hint">This server asks Immich for each photo, crops it around what matters in it and turns it into the panel's six colours. A display only ever downloads that finished picture: it never sees Immich's address or your key.</p>
      <p class="hint">Add a <b>Photo</b> section to a viewport layout, or turn on <b>A photo behind this screen</b> in its screen settings.</p>
    <//>
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
          if (alive) setT({ offsetMs: server - got, timeZone: r.timeZone, source: r.timeZoneSource, ntpServer: r.ntpServer });
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
          ${t.timeZone !== browserTz && html`<p class="hint"><${Icon} name="earth" size=${14} /> The server's time zone (${t.timeZone}) differs from this browser's (${browserTz}). Every device shows the server's: choose the right one under <b>Time zone</b> if that's wrong.</p>`}`}
  <//>`;
}

// Where the time zone in use came from (lib/house-tz.js).
const TZ_SOURCE = {
  env: 'set by TZ in the server’s environment, which wins over this setting',
  setting: 'chosen here',
  homeAssistant: 'Home Assistant’s',
  default: 'nothing set it: the server’s own default'
};

function TimeZoneCard({ g }) {
  const t = useServerTime();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserTz];
  const value = g.globals.timeZone || '';
  const fromEnv = t && t.source === 'env';
  return html`<${Card} icon="earth" title="Time zone" subtitle="Every time a remote or viewport shows — clocks, calendars, meetings, quiet hours — is in this zone.">
    <${Field} label="Time zone" hint=${t && !t.error ? `In use: ${t.timeZone}, ${TZ_SOURCE[t.source] || ''}.` : ''}>
      <${Select} value=${value} disabled=${fromEnv} onChange=${(v) => g.set(['timeZone'], v)}
        options=${[{ value: '', label: 'Automatic: Home Assistant’s' }, ...zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))]} />
    <//>
    ${!value && !fromEnv && html`<p class="hint">Without Home Assistant (meeting-room signs on calendar links, say), choose it here. ${zones.includes(browserTz) ? html`<a href="#" onClick=${(e) => { e.preventDefault(); g.set(['timeZone'], browserTz); }}>Use this browser’s (${browserTz})</a>` : ''}</p>`}
    <${SaveBar} g=${g} />
  <//>`;
}

function ClockTab() {
  const g = useGlobals();
  if (!g.globals) return html`<p class="hint">Loading…</p>`;
  return html`<div class="grid">
    <${ServerTimeCard} />
    <${TimeZoneCard} g=${g} />
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

const SESSION_LABELS = { 1: '1 hour', 8: '8 hours', 24: '1 day', 168: '7 days', 720: '30 days' };

// Sign-in length, the failed sign-in limit, signing out other browsers, and
// whether new devices may ask to pair (lib/security.js). Saved as changed.
function SecuritySettings({ data, take }) {
  const [msg, flash] = useFlash();
  const st = data.settings;
  const put = async (path, body, done) => {
    try {
      take(await api(path, body ? { method: 'PUT', body } : { method: 'POST' }), true);
      flash(done || 'Saved');
    } catch (e) {
      flash(`Failed: ${e.message}`, 8000);
    }
  };
  const others = data.sessions - 1;
  return html`
    <${Card} icon="account-lock-outline" title="Sign-in" subtitle="This admin site's sign-ins.">
      <${Field} label="Stay signed in for" hint="How long a browser stays signed in without being used. A shorter time applies to browsers already signed in too.">
        <div style="max-width:200px"><${Select} value=${String(st.sessionHours)} onChange=${(v) => put('/api/security/settings', { sessionHours: Number(v) })}
          options=${data.sessionChoices.map((h) => ({ value: String(h), label: SESSION_LABELS[h] || `${h} hours` }))} /></div>
      <//>
      <${Toggle} checked=${st.loginLockout} onChange=${(v) => put('/api/security/settings', { loginLockout: v })} label="Pause sign-in after 5 wrong passwords" />
      <p class="hint">After 5 wrong passwords from one address within 15 minutes, that address can't try again for 15 minutes.</p>
      <div class="row" style="align-items:center">
        <span class="hint">${data.sessions} browser${data.sessions === 1 ? '' : 's'} signed in, this one included.</span>
        <${Button} small icon="logout-variant" disabled=${others < 1} onClick=${() => confirm(`Sign out the other ${others} browser${others === 1 ? '' : 's'}?`) && put('/api/security/sign-out-others', null, 'Signed out the others')}>Sign out everywhere else<//>
      </div>
      ${msg && html`<p class=${`hint ${msg.startsWith('Failed') ? 'text-bad' : ''}`}>${msg}</p>`}
    <//>`;
}

// Allowed networks (lib/netguard.js): the server answers only these.
function SecurityTab() {
  const [data, setData] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  // `keepEdits`: another card saved; leave unsaved network edits alone.
  const take = (d, keepEdits) => {
    setData(d);
    if (keepEdits) return;
    setEnabled(d.enabled);
    setText((d.allowed || []).join('\n'));
    setDirty(false);
  };
  useEffect(() => {
    api('/api/security').then(take).catch((e) => flash(e.message, 0));
  }, []);
  if (!data) return html`<p class="hint">${msg || 'Loading…'}</p>`;
  const lines = text.split(/[\s,]+/).filter(Boolean);
  const edit = (fn) => {
    fn();
    setDirty(true);
  };
  const addPrivate = () => edit(() => setText([...lines, ...data.private.filter((p) => !lines.includes(p))].join('\n')));
  const addMine = () => edit(() => setText([...lines, data.you].join('\n')));
  const save = async () => {
    setBusy(true);
    try {
      take(await api('/api/security', { method: 'PUT', body: { enabled, allowed: lines } }));
      flash('Saved');
    } catch (e) {
      flash(`Save failed: ${e.message}`, 10000);
    }
    setBusy(false);
  };
  return html`<div class="grid">
    <${Card} icon="shield-lock-outline" title="Allowed networks"
      subtitle="Answer only requests from these addresses: the admin pages, the devices' API and pairing alike. This server itself is always allowed."
      actions=${data.enabled ? html`<${Badge} kind="ok" icon="shield-check-outline">On<//>` : html`<${Badge}>Off<//>`}>
      ${data.fromEnv
        ? html`<p class="hint">Set on the server by <code>ALLOWED_NETWORKS</code>${data.enabled ? '' : ' (any)'}, which replaces this list while it's there: change or remove it to edit here.</p>
            ${data.enabled && html`<pre class="mono">${data.allowed.join('\n')}</pre>`}`
        : html`
          <${Toggle} checked=${enabled} onChange=${(v) => edit(() => setEnabled(v))} label="Only answer these networks" />
          <${Field} label="Networks" hint="One per line: a range such as 192.168.1.0/24, or one address. Include every network a remote, display or browser reaches this server from.">
            <textarea rows="7" class="mono" value=${text} placeholder="192.168.1.0/24" onInput=${(e) => edit(() => setText(e.target.value))}></textarea>
          <//>
          <div class="row" style="flex-wrap:wrap">
            <${Button} small icon="lan" onClick=${addPrivate}>Add private networks<//>
            <${Button} small kind="ghost" icon="account-network-outline" disabled=${lines.includes(data.you) || lines.includes(`${data.you}/32`)} onClick=${addMine}>Add my address<//>
          </div>
          <p class="hint">Private networks: ${data.private.join(', ')}.</p>
          <div class="row" style="align-items:center">
            <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty || busy} onClick=${save}>Save<//>
            <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
          </div>`}
      <p class="hint">You're reaching the server from <code>${data.you || 'an unknown address'}</code>${data.trustProxy ? html` (forwarded by <code>${data.trustProxy}</code>)` : ''}. A list without it can't be saved, so you can't shut yourself out from here. If you ever are, set <code>ALLOWED_NETWORKS=any</code> on the container and restart it.</p>
    <//>
    <${SecuritySettings} data=${data} take=${take} />
  </div>`;
}

// Pairing: whether new devices may ask to pair, and how they find the server.
function PairingTab() {
  const [data, setData] = useState(null);
  const [health] = useApi('/api/health');
  const [msg, flash] = useFlash();
  useEffect(() => {
    api('/api/security').then(setData).catch((e) => flash(e.message, 0));
  }, []);
  if (!data) return html`<p class="hint">${msg || 'Loading…'}</p>`;
  const st = data.settings;
  const set = async (v) => {
    try {
      setData(await api('/api/security/settings', { method: 'PUT', body: { acceptNewDevices: v } }));
      flash('Saved');
    } catch (e) {
      flash(`Failed: ${e.message}`, 8000);
    }
  };
  return html`<div class="settings-cols">
    <${Card} title="New devices" subtitle="Who may ask to pair." actions=${html`<${Toggle} checked=${st.acceptNewDevices} onChange=${set} />`}>
      <p class="hint">${st.acceptNewDevices
        ? 'On: a device the server has never seen can ask to pair, and waits under Remotes for you to approve it as a remote or a viewport.'
        : 'Off: a device the server has never seen is turned away, so nothing new appears under Remotes. Devices it already knows still work, and can get a new token after a reset. Displays listed with their address in a room list still connect. Switch this on while you add a device.'}</p>
      <div class="row"><a class="btn btn-small" href="#/remotes"><${Icon} name="account-clock-outline" size=${16} /><span>Devices waiting</span></a>
        <a class="btn btn-small" href="#/layouts/waiting"><${Icon} name="check-all" size=${16} /><span>Approve displays together</span></a></div>
      ${msg && html`<p class=${`hint ${msg.startsWith('Failed') ? 'text-bad' : ''}`}>${msg}</p>`}
    <//>
    <${Card} title="How devices find this server">
      <p class="hint">Devices look for the server on the local network by itself (mDNS), so there's no address to type. Where multicast doesn't reach, such as another VLAN, type this address on the device's setup page instead.</p>
      ${health && html`<dl class="kv">
        <dt>Address</dt><dd><code>${String(health.mdnsHostname).replace(/\.local$/, '')}.local:${health.port}</code></dd>
        <dt>Service</dt><dd><code>${health.mdnsServiceType}</code></dd>
      </dl>`}
    <//>
  </div>`;
}

// Is there a newer Switchboard Server (lib/server-version.js): what the
// last check found, and a button to ask GitHub again.
function VersionStatus({ version }) {
  const [v, , , setV] = useApi('/api/server/version');
  const [busy, setBusy] = useState(false);
  const checkNow = async () => {
    setBusy(true);
    try {
      setV(await api('/api/server/version/check', { method: 'POST' }));
    } catch (e) {
      setV({ ...(v || {}), error: e.message });
    } finally {
      setBusy(false);
    }
  };
  if (!v) return html`<p class="hint">Loading…</p>`;
  if (!v.enabled) return html`<p class="hint">Checking for new versions is off (DISABLE_UPDATE_CHECK). <a href=${v.url} target="_blank" rel="noopener">Releases on GitHub</a></p>`;
  let status;
  if (v.newer) {
    status = html`<p><${Badge} kind="accent" icon="arrow-up-circle-outline">${v.latest} is out<//> You have ${version}. <a href=${v.url} target="_blank" rel="noopener">What’s new</a>, then update it the way you installed it: <code>docker compose pull && docker compose up -d</code>, or <code>git pull && npm install</code> and restart.</p>`;
  } else if (v.latest && v.known === false) {
    status = html`<p class="hint">The latest release is ${v.latest}. This is a development build (${version}), so it can’t tell whether it’s older.</p>`;
  } else if (v.latest) {
    status = html`<p class="hint"><${Icon} name="check-circle-outline" size=${16} /> Up to date: ${v.latest} is the latest release.</p>`;
  } else if (!v.checkedAt) {
    status = html`<p class="hint">Not checked yet: it asks GitHub a minute after starting, then twice a day.</p>`;
  }
  return html`<div class="version-status">
    ${status}
    ${v.error && html`<p class="hint text-bad"><${Icon} name="alert-circle-outline" size=${16} /> ${v.error}</p>`}
    <div class="row-inline">
      <${Button} small icon="refresh" disabled=${busy} onClick=${checkNow}>${busy ? 'Checking…' : 'Check now'}<//>
      ${v.checkedAt && html`<span class="hint">Checked ${timeAgo(v.checkedAt)}</span>`}
    </div>
  </div>`;
}

function AboutTab() {
  const [health] = useApi('/api/health');
  const MANUAL = 'https://stumarti.github.io/Switchboard/manual/';
  return html`<div class="settings-cols">
    <${Card} title="This server">
      ${health
        ? html`<dl class="kv">
          <dt>Version</dt><dd>Switchboard Server ${health.version}</dd>
          <dt>mDNS name</dt><dd><code>${String(health.mdnsHostname).replace(/\.local$/, '')}.local:${health.port}</code></dd>
          <dt>Service</dt><dd><code>${health.mdnsServiceType}</code></dd>
          <dt>Data folder</dt><dd><code>${health.dataDir}</code></dd>
        </dl>`
        : html`<p class="hint">Loading…</p>`}
    <//>
    <${Card} title="Updates" subtitle="Whether a newer Switchboard Server is out. It only looks: updating is up to you.">
      <${VersionStatus} version=${health ? health.version : ''} />
    <//>
    <${Card} title="Help">
      <div class="link-list">
        <a href=${MANUAL} target="_blank" rel="noopener"><${Icon} name="book-open-page-variant-outline" size=${18} />The Switchboard manual</a>
        <a href=${`${MANUAL}server/configuration.html`} target="_blank" rel="noopener"><${Icon} name="file-cog-outline" size=${18} />Configuring the server</a>
        <a href="https://stumarti.github.io/Switchboard/" target="_blank" rel="noopener"><${Icon} name="usb-flash-drive-outline" size=${18} />The browser flasher</a>
        <a href="https://github.com/stumarti/Switchboard-Server" target="_blank" rel="noopener"><${Icon} name="github" size=${18} />Switchboard Server on GitHub</a>
      </div>
    <//>
  </div>`;
}

function AccountTab({ onSignOut }) {
  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    onSignOut();
  };
  return html`<div class="settings-cols">
    <${PasswordCard} />
    <${Card} title="This browser" subtitle="You're signed in as the admin.">
      <div><${Button} icon="logout" onClick=${signOut}>Sign out<//></div>
    <//>
  </div>`;
}

// Each page's heading.
const PAGE_HINTS = {
  'home-assistant': 'The Home Assistant every remote and viewport reads from.',
  wifi: 'Networks the devices may join, besides the one they were set up on.',
  immich: 'Photos from your Immich library for viewport layouts.',
  clock: 'The server’s time, the time zone every device shows times in, and where devices set their clocks from.',
  updates: 'Send new firmware to remotes and displays over Wi-Fi.',
  pairing: 'New devices asking to pair, and how they find this server.',
  theme: 'Icons and fonts, for the remotes and for the viewports.',
  security: 'Who can reach this server, and how long sign-ins last.',
  account: 'The admin password, and signing out.',
  about: 'This server, and where to get help.'
};

export function SettingsPage({ tab, onSignOut }) {
  const active = SETTINGS_PAGES.find((t) => t.id === tab) || SETTINGS_PAGES[0];
  const head = (actions) => html`<div class="page-head">
    <div class="ph-text"><h1>${active.label}</h1><p class="hint">${PAGE_HINTS[active.id]}</p></div>
    ${actions && html`<div class="page-actions">${actions}</div>`}
  </div>`;
  if (active.id === 'updates') return html`<div class="page settings-page"><${RemoteUpdatesTab} head=${head} /></div>`;
  let body;
  if (active.id === 'home-assistant') body = html`<${HomeAssistantTab} />`;
  else if (active.id === 'wifi') body = html`<${WifiTab} />`;
  else if (active.id === 'immich') body = html`<${ImmichTab} />`;
  else if (active.id === 'clock') body = html`<${ClockTab} />`;
  else if (active.id === 'theme') body = html`<${ThemeTab} />`;
  else if (active.id === 'pairing') body = html`<${PairingTab} />`;
  else if (active.id === 'security') body = html`<${SecurityTab} />`;
  else if (active.id === 'about') body = html`<${AboutTab} />`;
  else body = html`<${AccountTab} onSignOut=${onSignOut} />`;
  return html`<div class="page settings-page">${head()}${body}</div>`;
}
