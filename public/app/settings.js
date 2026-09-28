// Settings: everything shared by every room and device — the Home Assistant
// connection, Wi-Fi, the clock, the theme (icon + font packs), sign out.

import {
  html, useState, useEffect, api, Icon, Card, Field, TextInput, SecretInput, Button, Badge, useFlash, useApi, setIn
} from './lib.js';
import { haStatus, useHaStatus, IconPickerModal, IconPreview } from './pickers.js';
import { ItemList } from './rooms.js';

const TABS = [
  { id: 'home-assistant', label: 'Home Assistant', icon: 'home-assistant' },
  { id: 'wifi', label: 'Wi-Fi', icon: 'wifi' },
  { id: 'clock', label: 'Clock', icon: 'clock-outline' },
  { id: 'theme', label: 'Theme', icon: 'palette-outline' },
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
  </div>`;
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

function ClockTab() {
  const g = useGlobals();
  if (!g.globals) return html`<p class="hint">Loading…</p>`;
  return html`<div class="grid">
    <${Card} icon="clock-outline" title="Time server" subtitle="Devices set their clock from this NTP server.">
      <${Field} label="NTP server"><${TextInput} value=${g.globals.ntpServer} placeholder="pool.ntp.org" onInput=${(v) => g.set(['ntpServer'], v)} /><//>
      <${SaveBar} g=${g} />
    <//>
  </div>`;
}

// --- Theme ------------------------------------------------------------------------

function IconSlots({ overrides, setOverrides }) {
  const [slots] = useApi('/api/assets/icon-slots');
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
              return html`<button type="button" class="icon-cell" title=${`${s.label} (${cur})`} onClick=${() => setPicking(s)}
                style=${overrides[s.key] ? 'border-color:var(--accent)' : ''}>
                <${IconPreview} name=${cur} size=${30} />
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
  return html`<${Card} icon="format-font" title="Font" subtitle="One typeface, rendered at every size the firmware uses."
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

function ThemeTab() {
  const [theme, , reloadTheme] = useApi('/api/theme');
  const [overrides, setOverrides] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  useEffect(() => {
    if (theme && overrides === null) setOverrides(theme.iconOverrides || {});
  }, [theme]);
  const compile = async () => {
    setBusy(true);
    try {
      const r = await api('/api/assets/icons/compile', { method: 'POST', body: { overrides } });
      flash(`Icon pack ${r.version} built — devices update on their next refresh`, 6000);
      reloadTheme();
    } catch (e) {
      flash(`Failed: ${e.message}`, 8000);
    } finally {
      setBusy(false);
    }
  };
  const count = overrides ? Object.keys(overrides).length : 0;
  return html`<div class="stack">
    <${Card} icon="shape-outline" title="Icons" subtitle="Replace any icon the firmware draws. Changes take effect once the pack is built."
      actions=${html`${theme && theme.iconsVersion ? html`<${Badge} icon="package-variant-closed">${theme.iconsVersion}<//>` : html`<${Badge}>Built-in<//>`}`}>
      <div class="row" style="align-items:center">
        <${Button} kind="primary" icon="hammer-wrench" disabled=${busy || !overrides} onClick=${compile}>${busy ? 'Building…' : 'Build icon pack'}<//>
        ${count > 0 && html`<${Button} icon="restore" onClick=${() => setOverrides({})}>Reset ${count} changed<//>`}
        <span class=${`flash ${msg.startsWith('Failed') ? 'flash-bad' : ''}`}>${msg}</span>
      </div>
      ${overrides && html`<${IconSlots} overrides=${overrides} setOverrides=${setOverrides} />`}
    <//>
    <div class="grid">
      <${Fonts} theme=${theme} reloadTheme=${reloadTheme} />
      <${CustomIcons} />
    </div>
  </div>`;
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
        <dt>mDNS name</dt><dd>${health.mdnsHostname}.local:${health.port}</dd>
        <dt>Service</dt><dd>${health.mdnsServiceType}</dd>
        <dt>Data folder</dt><dd>${health.dataDir}</dd>
      </dl>`}
    <//>
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
  else body = html`<${AccountTab} onSignOut=${onSignOut} />`;
  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon"><${Icon} name="cog-outline" size=${26} /></div>
      <div class="ph-text"><h1>Settings</h1><p class="hint">Shared by every room and device.</p></div>
    </div>
    <nav class="tabs">
      ${TABS.map(
        (t) => html`<a class=${`tab ${t.id === active.id ? 'active' : ''}`} href=${`#/settings/${t.id}`}><${Icon} name=${t.icon} size=${18} />${t.label}</a>`
      )}
    </nav>
    ${body}
  </div>`;
}
