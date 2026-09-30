// Layouts: every UI, defined on the server before (or without) any hardware.
//   Remote layouts    one per room: its Home Assistant entities, one card
//                     per function, and the remote UI — which carousel
//                     pages, in what order, the Quick Access buttons, how
//                     often it refreshes. Every remote assigned the room
//                     shows it (unless customised).
//   Viewport layouts  (dashboards.js; "dashboards" in the API and store),
//                     each assigned to any number of displays.

import {
  html, useState, useEffect, api, go, Icon, Card, Field, TextInput, SecretInput, Select, Toggle, Button, Badge,
  Empty, useFlash, setIn, getIn, moveItem, timeAgo
} from './lib.js';
import { EntityPicker, IconPicker, useHaStatus, useEntity } from './pickers.js';
import { CarouselBuilder, HubBuilder, ClockAlign, DeveloperMenu } from './clients.js';
import { RemotePreviews } from './remote-preview.js';

// --- A reorderable list of items (lights, scenes, blinds, sensors, games) ---

export function ItemList({ items, onChange, newItem, addLabel = 'Add', render, empty, max }) {
  const list = items || [];
  const update = (i, next) => onChange(list.map((it, j) => (j === i ? next : it)));
  return html`<div class="items">
    ${!list.length && empty && html`<p class="hint">${empty}</p>`}
    ${list.map(
      (it, i) => html`<div class="item" key=${it.id || i}>
        <div class="item-body">${render(it, (next) => update(i, next), i)}</div>
        <div class="item-tools">
          <${Button} kind="ghost" small icon="chevron-up" title="Move up" disabled=${i === 0} onClick=${() => onChange(moveItem(list, i, i - 1))} />
          <${Button} kind="ghost" small icon="chevron-down" title="Move down" disabled=${i === list.length - 1} onClick=${() => onChange(moveItem(list, i, i + 1))} />
          <${Button} kind="ghost" small icon="trash-can-outline" title="Remove" onClick=${() => onChange(list.filter((_, j) => j !== i))} />
        </div>
      </div>`
    )}
    <div>
      <${Button} small icon="plus" disabled=${max != null && list.length >= max} onClick=${() => onChange([...list, newItem()])}>${addLabel}<//>
      ${max != null && list.length >= max && html`<span class="hint"> (${max} at most)</span>`}
    </div>
  </div>`;
}

// Picking an entity fills in what we can learn from HA (name, icon, which
// light controls it supports) — only where the user hasn't set it already.
function withEntity(item, id, entity, { controls } = {}) {
  let next = { ...item, entity: id };
  if (entity) {
    if (!item.name) next.name = entity.name;
    if ('icon' in item && !item.icon && entity.icon) next.icon = entity.icon;
    if (controls && entity.capabilities && entity.domain === 'light') {
      const c = entity.capabilities;
      next.controls = { brightness: !!c.brightness, colorTemp: !!c.colorTemp, color: !!c.color, effects: !!c.effects };
    }
  }
  return next;
}

const LIGHT_CONTROLS = [
  { key: 'brightness', label: 'Brightness', icon: 'brightness-6' },
  { key: 'colorTemp', label: 'Colour temp', icon: 'thermometer-lines' },
  { key: 'color', label: 'Colour', icon: 'palette' },
  { key: 'effects', label: 'Effects', icon: 'auto-fix' }
];

function ControlChips({ value, onChange }) {
  const v = value || {};
  return html`<div class="chips">
    ${LIGHT_CONTROLS.map(
      (c) => html`<button type="button" class=${`chip ${v[c.key] ? 'on' : ''}`} onClick=${() => onChange({ ...v, [c.key]: !v[c.key] })}>
        <${Icon} name=${c.icon} size=${14} />${c.label}
      </button>`
    )}
  </div>`;
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

// --- Cards --------------------------------------------------------------------

function StatusCard({ room, set }) {
  return html`<${Card} icon="weather-partly-cloudy" title="Status page" subtitle="The resting page: weather, forecast, indoor climate.">
    <${Field} label="Weather">
      <${EntityPicker} domains=${['weather']} value=${getIn(room, ['standby', 'weatherEntity'])} onChange=${(id) => set(['standby', 'weatherEntity'], id)} />
    <//>
    <${Field} label="Indoor climate" hint="Thermostat whose temperature and humidity the status page shows.">
      <${EntityPicker} domains=${['climate']} value=${getIn(room, ['standby', 'climateEntity'])} onChange=${(id) => set(['standby', 'climateEntity'], id)} />
    <//>
  <//>`;
}

function ClimateCard({ room, set }) {
  return html`<${Card} icon="thermostat" title="Climate" subtitle="The main sensor plus any extra readings shown beside it.">
    <${Field} label="Main temperature">
      <${EntityPicker} domains=${['sensor', 'climate']} value=${getIn(room, ['climate', 'entity'])} onChange=${(id) => set(['climate', 'entity'], id)} />
    <//>
    <${Field} label="Other sensors" hint="Up to six are shown on the device.">
      <${ItemList}
        items=${getIn(room, ['climate', 'additionalSensors'], [])}
        onChange=${(l) => set(['climate', 'additionalSensors'], l)}
        newItem=${() => ({ id: newId(), name: '', entity: '' })}
        addLabel="Add sensor"
        render=${(it, upd) => html`<div class="row">
          <${Field} label="Sensor"><${EntityPicker} domains=${['sensor']} value=${it.entity} onChange=${(id, e) => upd(withEntity(it, id, e))} /><//>
          <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
        </div>`}
      />
    <//>
  <//>`;
}

function GroupFields({ value, onChange, domains, controls, what }) {
  const g = value || {};
  return html`<div class="item">
    <div class="item-body">
      <${Toggle} checked=${g.enabled} onChange=${(v) => onChange({ ...g, enabled: v })} label=${`Whole-room ${what} control`} />
      ${g.enabled &&
      html`<div class="row">
          <${Field} label="Group entity"><${EntityPicker} domains=${domains} value=${g.entity} onChange=${(id, e) => onChange(withEntity(g, id, e, { controls }))} /><//>
          <${Field} label="Label"><${TextInput} value=${g.name} onInput=${(v) => onChange({ ...g, name: v })} /><//>
        </div>
        ${controls && html`<${ControlChips} value=${g.controls} onChange=${(c) => onChange({ ...g, controls: c })} />`}`}
    </div>
  </div>`;
}

function LightingCard({ room, set }) {
  return html`<${Card} icon="lightbulb-group-outline" title="Lighting" subtitle="Controls are filled in from what each light supports.">
    <${GroupFields} what="lighting" domains=${['light']} controls value=${getIn(room, ['lighting', 'group'])} onChange=${(g) => set(['lighting', 'group'], g)} />
    <${Field} label="Lights">
      <${ItemList}
        items=${getIn(room, ['lighting', 'lights'], [])}
        onChange=${(l) => set(['lighting', 'lights'], l)}
        newItem=${() => ({ id: newId(), name: '', entity: '', icon: '', controls: {} })}
        addLabel="Add light"
        render=${(it, upd) => html`<div class="row">
            <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
            <${Field} label="Light"><${EntityPicker} domains=${['light', 'switch']} value=${it.entity} onChange=${(id, e) => upd(withEntity(it, id, e, { controls: true }))} /><//>
            <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
          </div>
          <${ControlChips} value=${it.controls} onChange=${(c) => upd({ ...it, controls: c })} />`}
      />
    <//>
    <${Field} label="Scenes">
      <${ItemList}
        items=${getIn(room, ['lighting', 'scenes'], [])}
        onChange=${(l) => set(['lighting', 'scenes'], l)}
        newItem=${() => ({ id: newId(), name: '', entity: '', icon: '' })}
        addLabel="Add scene"
        render=${(it, upd) => html`<div class="row">
          <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Scene or script"><${EntityPicker} domains=${['scene', 'script']} value=${it.entity} onChange=${(id, e) => upd(withEntity(it, id, e))} /><//>
          <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
        </div>`}
      />
    <//>
  <//>`;
}

function BlindsCard({ room, set }) {
  return html`<${Card} icon="blinds" title="Blinds" subtitle="Open, close and stop for the room and each blind.">
    <${GroupFields} what="blinds" domains=${['cover']} value=${getIn(room, ['blinds', 'group'])} onChange=${(g) => set(['blinds', 'group'], g)} />
    <${Field} label="Individual blinds" hint="The device's two-row layout shows the first two.">
      <${ItemList}
        items=${getIn(room, ['blinds', 'items'], [])}
        onChange=${(l) => set(['blinds', 'items'], l)}
        newItem=${() => ({ id: newId(), name: '', entity: '', icon: '' })}
        addLabel="Add blind"
        render=${(it, upd) => html`<div class="row">
          <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Cover"><${EntityPicker} domains=${['cover']} value=${it.entity} onChange=${(id, e) => upd(withEntity(it, id, e))} /><//>
          <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
        </div>`}
      />
    <//>
  <//>`;
}

function MusicCard({ room, set }) {
  const m = room.media || {};
  return html`<${Card} icon="music-circle-outline" title="Music" subtitle="Now playing, transport and volume." class=${m.enabled ? '' : 'disabled'}
    actions=${html`<${Toggle} checked=${m.enabled} onChange=${(v) => set(['media', 'enabled'], v)} />`}>
    <div class="row">
      <${Field} label="Media player"><${EntityPicker} domains=${['media_player']} value=${m.entity} onChange=${(id, e) => set(['media'], withEntity(m, id, e))} /><//>
      <${Field} label="Label"><${TextInput} value=${m.name} onInput=${(v) => set(['media', 'name'], v)} /><//>
    </div>
  <//>`;
}

// A room saved before the app list had a fixed trio (name -> launch value).
const LEGACY_TV_APPS = [
  { key: 'youtube', name: 'YouTube', icon: 'youtube' },
  { key: 'netflix', name: 'Netflix', icon: 'netflix' },
  { key: 'tvMate', name: 'TV Mate', icon: 'television-guide' }
];
function tvAppList(tv) {
  if (Array.isArray(tv.appList)) return tv.appList;
  const apps = tv.apps || {};
  return LEGACY_TV_APPS.filter((a) => apps[a.key]).map((a) => ({ id: a.key, name: a.name, launch: apps[a.key], icon: a.icon }));
}
const newItemId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`);

function TvCard({ room, set }) {
  const tv = room.tv || {};
  return html`<${Card} icon="television" title="TV" subtitle="Android TV: D-pad, volume and app shortcuts.">
    <div class="row">
      <${Field} label="Media player"><${EntityPicker} domains=${['media_player']} value=${tv.mediaPlayerEntity} onChange=${(id) => set(['tv', 'mediaPlayerEntity'], id)} /><//>
      <${Field} label="Remote"><${EntityPicker} domains=${['remote']} value=${tv.remoteEntity} onChange=${(id) => set(['tv', 'remoteEntity'], id)} /><//>
    </div>
    <${Field} label="Apps" hint="Up to four, in one row on the remote. The launch value is the app's Android package name or intent. The icon is optional: without one, YouTube and Netflix get their own logo and anything else a generic app icon.">
      <${ItemList}
        items=${tvAppList(tv)}
        onChange=${(l) => set(['tv', 'appList'], l)}
        max=${4}
        addLabel="Add app"
        empty="No apps yet."
        newItem=${() => ({ id: newItemId(), name: '', launch: '', icon: '' })}
        render=${(it, upd) => html`<div class="row" style="align-items:flex-end">
          <${IconPicker} value=${it.icon} title="Icon (optional)" onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Name"><${TextInput} value=${it.name} placeholder="Plex" onInput=${(v) => upd({ ...it, name: v })} /><//>
          <${Field} label="Launch value"><${TextInput} value=${it.launch} placeholder="com.plexapp.android" onInput=${(v) => upd({ ...it, launch: v })} /><//>
        </div>`}
      />
    <//>
  <//>`;
}

// An Enigma2 satellite/cable box (Home Assistant's enigma2 media_player):
// channel up/down, favourite channels as buttons, volume, mute and power.
// What the box reports, for the Receiver card's Check button.
function BoxCheck({ receiver }) {
  const [state, setState] = useState(null); // {busy} | {result} | {error}
  const check = () => {
    setState({ busy: true });
    api('/api/receiver/check', { method: 'POST', body: { receiver } })
      .then((result) => setState({ result }))
      .catch((e) => setState({ error: e.message }));
  };
  const r = state && state.result;
  return html`<div class="box-check">
    <${Button} small icon="lan-check" disabled=${!receiver.boxUrl || (state && state.busy)} onClick=${check}>${state && state.busy ? 'Checking…' : 'Check'}<//>
    ${state && state.error && html`<span class="text-bad">${state.error}</span>`}
    ${r &&
    html`<span class="hint">
      <b>${r.channel || 'Nothing on'}</b>${r.now ? ` · Now ${r.now.time} ${r.now.title}` : ''}${r.next ? ` · Next ${r.next.time} ${r.next.title}` : ''}
      ${r.channels != null ? ` · ${r.channels} channels listed` : ''}
      ${r.favourites.length ? ` · favourites found: ${r.favourites.filter((f) => f.found).length} of ${r.favourites.length}` : ''}
    </span>`}
  </div>`;
}

function ReceiverCard({ room, set }) {
  const r = room.receiver || { name: 'Receiver', mediaPlayerEntity: '', boxUrl: '', channels: [] };
  const entity = useEntity(r.mediaPlayerEntity);
  const sources = (entity && entity.capabilities && entity.capabilities.sources) || [];
  const listId = `rx-sources-${room.slug || 'room'}`;
  const hasBox = Boolean(r.boxUrl);
  return html`<${Card} icon="satellite-variant" title="Receiver" subtitle="An Enigma2 box (Vu+, Dreambox, …) through Home Assistant's Enigma2 integration.">
    <div class="row">
      <${Field} label="Media player"><${EntityPicker} domains=${['media_player']} value=${r.mediaPlayerEntity} onChange=${(id, e) => set(['receiver'], { ...r, mediaPlayerEntity: id, name: r.name && r.name !== 'Receiver' ? r.name : (e && e.name) || r.name })} /><//>
      <${Field} label="Name on the page"><${TextInput} value=${r.name} placeholder="Receiver" onInput=${(v) => set(['receiver', 'name'], v)} /><//>
    </div>
    <${Field} label="Box address (optional)" hint="The box's own web interface (OpenWebif). With it, the page also shows the programme on next, and favourites can show the channel's picon. It stays on this server: remotes never see it.">
      <div class="row" style="align-items:center">
        <div style="flex:1"><${TextInput} value=${r.boxUrl || ''} placeholder="http://192.168.1.50  (or http://root:password@vu.local)" onInput=${(v) => set(['receiver', 'boxUrl'], v)} /></div>
      </div>
      <${BoxCheck} receiver=${r} />
    <//>
    <p class="hint">The channel on now shows its picon too: from the box with an address, else from Home Assistant when its Enigma2 integration has "Use channel icon" on.</p>
    <${Field} label="Favourite channels" hint=${`Up to six buttons. The channel is its name as the box lists it${sources.length ? ` — pick from the ${sources.length} it reports` : ''}. The icon is optional${hasBox ? ', or use the channel’s own picon' : ''}.`}>
      <datalist id=${listId}>${sources.map((src) => html`<option value=${src} />`)}</datalist>
      <${ItemList}
        items=${r.channels || []}
        onChange=${(l) => set(['receiver', 'channels'], l)}
        max=${6}
        addLabel="Add channel"
        empty="No favourites yet. Channel up/down, volume and power work without any."
        newItem=${() => ({ id: newItemId(), name: '', source: '', icon: '', usePicon: hasBox })}
        render=${(it, upd) => html`<div class="row" style="align-items:flex-end">
          <${IconPicker} value=${it.icon} title="Icon (optional)" onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Channel">
            <input type="text" list=${listId} value=${it.source} placeholder="BBC One HD"
              onInput=${(e) => upd({ ...it, source: e.target.value, name: !it.name || it.name === it.source ? e.target.value : it.name })} />
          <//>
          <${Field} label="Label"><${TextInput} value=${it.name} placeholder="BBC One" onInput=${(v) => upd({ ...it, name: v })} /><//>
        </div>
        ${hasBox && html`<${Toggle} checked=${Boolean(it.usePicon)} onChange=${(v) => upd({ ...it, usePicon: v })} label="Use the channel’s picon from the box (instead of the icon)" />`}`}
      />
    <//>
  <//>`;
}

function XboxCard({ room, set }) {
  const x = room.xbox || {};
  return html`<${Card} icon="microsoft-xbox" title="Xbox" subtitle="Now playing, power and a games library." class=${x.enabled ? '' : 'disabled'}
    actions=${html`<${Toggle} checked=${x.enabled} onChange=${(v) => set(['xbox', 'enabled'], v)} />`}>
    <div class="row">
      <${Field} label="Media player"><${EntityPicker} domains=${['media_player']} value=${x.mediaPlayerEntity} onChange=${(id) => set(['xbox', 'mediaPlayerEntity'], id)} /><//>
      <${Field} label="Remote"><${EntityPicker} domains=${['remote']} value=${x.remoteEntity} onChange=${(id) => set(['xbox', 'remoteEntity'], id)} /><//>
    </div>
    <div class="row">
      <${Field} label="Label"><${TextInput} value=${x.name} onInput=${(v) => set(['xbox', 'name'], v)} /><//>
      <${Field} label="Games list">
        <${Select} value=${x.listSource || 'configured'} onChange=${(v) => set(['xbox', 'listSource'], v)}
          options=${[{ value: 'configured', label: 'The list below' }, { value: 'browse', label: 'Browse the console live' }]} />
      <//>
    </div>
    ${x.listSource === 'browse' &&
    html`<p class="hint">The server reads the console's installed games and apps from Home Assistant's media browser (up to 36, re-read every 30 minutes) and sends them to the remote as its library. The remote shows them from its next refresh.</p>`}
    ${x.listSource !== 'browse' &&
    html`<${Field} label="Games">
      <${ItemList}
        items=${x.games || []}
        onChange=${(l) => set(['xbox', 'games'], l)}
        newItem=${() => ({ id: newId(), name: '', productId: '', art: '' })}
        addLabel="Add game"
        render=${(it, upd) => html`<div class="row">
            <${Field} label="Name"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
            <${Field} label="Product ID"><${TextInput} value=${it.productId} onInput=${(v) => upd({ ...it, productId: v })} /><//>
          </div>
          <${Field} label="Box art URL (optional)"><${TextInput} value=${it.art} onInput=${(v) => upd({ ...it, art: v })} /><//>`}
      />
    <//>`}
  <//>`;
}

function ConnectionCard({ room, set }) {
  const h = room.homeAssistant || {};
  return html`<${Card} icon="home-assistant" title="Home Assistant connection" subtitle="Rooms normally share the one in Settings.">
    <${Toggle} checked=${h.useGlobal} onChange=${(v) => set(['homeAssistant', 'useGlobal'], v)} label="Use the shared connection" />
    ${!h.useGlobal &&
    html`<div class="row">
        <${Field} label="Host"><${TextInput} value=${h.host} onInput=${(v) => set(['homeAssistant', 'host'], v)} /><//>
        <${Field} label="Port"><${TextInput} type="number" value=${h.port} onInput=${(v) => set(['homeAssistant', 'port'], Number(v) || 8123)} /><//>
      </div>
      <${Field} label="Long-lived access token"><${SecretInput} value=${h.token} onInput=${(v) => set(['homeAssistant', 'token'], v)} /><//>`}
  <//>`;
}

// --- Room editor ------------------------------------------------------------------

// One page's settings at a time, picked from the carousel above.
function pageEditor(page, cardProps, room, set) {
  switch (page) {
    case 'status': return html`<${StatusCard} ...${cardProps} />`;
    case 'lighting': return html`<${LightingCard} ...${cardProps} />`;
    case 'climate': return html`<${ClimateCard} ...${cardProps} />`;
    case 'blinds': return html`<${BlindsCard} ...${cardProps} />`;
    case 'music': return html`<${MusicCard} ...${cardProps} />`;
    case 'tv': return html`<${TvCard} ...${cardProps} />`;
    case 'xbox': return html`<${XboxCard} ...${cardProps} />`;
    case 'receiver': return html`<${ReceiverCard} ...${cardProps} />`;
    case 'wifi':
      return html`<${Card} icon="wifi-star" title="Guest Wi-Fi" subtitle="Join-QR codes for your guest networks.">
        <p class="hint">This page shows the guest networks set in <a href="#/settings/wifi">Settings → Wi-Fi</a>, the same in every room. Nothing to set here.</p>
      <//>`;
    case 'quick':
      return html`<${HubBuilder} hub=${room.hub} onChange=${(h) => set(['hub'], h)} />`;
    case 'room':
      return html`<div class="grid">
        <${Card} icon="update" title="Refresh" subtitle="How often this room's remotes wake to fetch new state. Less often = longer battery.">
          <${Select} value=${String(getIn(room, ['standby', 'refreshIntervalMin'], 30))} onChange=${(v) => set(['standby', 'refreshIntervalMin'], Number(v))}
            options=${[{ value: '15', label: 'Every 15 minutes' }, { value: '30', label: 'Every 30 minutes' }, { value: '60', label: 'Every hour' }]} />
          <${ClockAlign} checked=${getIn(room, ['standby', 'refreshAligned'], false)} minutes=${getIn(room, ['standby', 'refreshIntervalMin'], 30)}
            onChange=${(v) => set(['standby', 'refreshAligned'], v)} />
        <//>
        <${Card} icon="cog-outline" title="Settings on the remote" subtitle="What this room's remotes offer in their own Settings.">
          <${DeveloperMenu} checked=${room.developerMenu !== false} onChange=${(v) => set(['developerMenu'], v)} />
        <//>
        <${ConnectionCard} ...${cardProps} />
      </div>`;
    default:
      return null;
  }
}

// The last page picked, per room, for this browser session.
function usePagePick(slug) {
  const key = `sb.roomPage.${slug}`;
  const read = () => {
    try {
      return sessionStorage.getItem(key) || 'status';
    } catch {
      return 'status';
    }
  };
  const [page, setPage] = useState(read);
  useEffect(() => setPage(read()), [slug]);
  const pick = (p) => {
    setPage(p);
    try {
      sessionStorage.setItem(key, p);
    } catch {
      /* private mode: just not remembered */
    }
  };
  return [page, pick];
}

function RoomEditor({ slug, clients, reloadRooms }) {
  const [page, selectPage] = usePagePick(slug);
  const [room, setRoom] = useState(null);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, flash] = useFlash();
  const ha = useHaStatus();

  useEffect(() => {
    setRoom(null);
    setDirty(false);
    api(`/api/devices/${encodeURIComponent(slug)}/config`).then(setRoom).catch(setError);
  }, [slug]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (error) return html`<div class="page"><${Empty} icon="alert-circle-outline" title="Couldn't load this room">${error.message}<//></div>`;
  if (!room) return html`<div class="page"><p class="hint">Loading…</p></div>`;

  const set = (path, value) => {
    setRoom((r) => setIn(r, path, value));
    setDirty(true);
  };

  // Always the whole profile: the server treats a missing list as "empty".
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api(`/api/devices/${encodeURIComponent(slug)}/config`, { method: 'POST', body: room });
      setRoom(saved);
      setDirty(false);
      flash('Saved');
      reloadRooms();
    } catch (e) {
      flash(`Save failed: ${e.message}`, 6000);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete the room “${room.name}”? Devices assigned to it will have no room.`)) return;
    await api(`/api/devices/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    reloadRooms();
    go('layouts');
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(room, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const users = (clients || []).filter((c) => c.assignedSlug === slug && c.type !== 'viewport');
  const cardProps = { room, set };
  const hubCount = ((room.hub && room.hub.items) || []).length;
  const extras = [
    { id: 'quick', label: 'Quick Access', icon: 'view-grid-plus-outline', sub: `${hubCount} button${hubCount === 1 ? '' : 's'}` },
    { id: 'room', label: 'Refresh & settings', icon: 'tune-variant', sub: `Every ${getIn(room, ['standby', 'refreshIntervalMin'], 30)} min${room.developerMenu === false ? ' · no Developer menu' : ''}` }
  ];

  return html`<div class="page">
    <div class="page-head">
      <${Button} kind="ghost" icon="arrow-left" title="All layouts" onClick=${() => go('layouts')} />
      <div class="ph-icon"><${Icon} name="sofa-outline" size=${26} /></div>
      <div class="ph-text">
        <input type="text" class="title-input" value=${room.name} onInput=${(e) => set(['name'], e.target.value)} style="font-size:20px;font-weight:600;border-color:transparent;padding:4px 6px;background:transparent" />
        <div class="chips" style="padding-left:6px">
          <code>${slug}</code>
          ${users.map(
            (c) => html`<a class="badge badge-accent" href=${`#/${c.type === 'viewport' ? 'viewports' : 'remotes'}/${encodeURIComponent(c.mac)}`}>
              <${Icon} name=${c.type === 'viewport' ? 'tablet-dashboard' : 'remote'} size=${13} />${c.name}
            </a>`
          )}
        </div>
      </div>
      <div class="page-actions">
        <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
        <${Button} kind="ghost" icon="download-outline" title="Download JSON" onClick=${download} />
        <${Button} kind="ghost" icon="trash-can-outline" title="Delete room" onClick=${remove} />
        <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty || saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}<//>
      </div>
    </div>
    ${ha.ok === false &&
    html`<div class="banner"><${Icon} name="home-alert-outline" size=${20} />
      <span>Home Assistant isn't reachable (${ha.error}), so entity search is off — type entity ids by hand, or <a href="#/settings/home-assistant">fix the connection</a>.</span>
    </div>`}
    <${CarouselBuilder}
      carousel=${carouselFromScreens(room.screens)}
      onChange=${(c) => set(['screens'], screensFromCarousel(c, room.screens))}
      room=${room}
      roomSlug=${slug}
      selected=${page}
      onSelect=${selectPage}
      extras=${extras}
      subtitle="What every remote in this room shows (a remote can be customised on its own page). Click a page to set it up; drag to reorder; switch pages off to skip them." />
    <div class="page-editor">
      ${pageEditor(page, cardProps, room, set)}
    </div>
    <div class="page-editor">
      <${RemotePreviews} slug=${slug} room=${room} carousel=${carouselFromScreens(room.screens)} selected=${page}
        onSelect=${(p) => {
          selectPage(p);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }} />
    </div>
  </div>`;
}

// The room's carousel (screens.* flags + screens.order) as the carousel
// builder's list, and back — the same rules the server uses for remotes.
const PAGE_FLAGS = { status: null, lighting: 'lighting', blinds: 'blinds', music: 'music', tv: 'tv', xbox: 'xbox', wifi: 'wifi', climate: 'climate', receiver: 'receiver' };
// Pages hidden until switched on (the server's rule too).
const OFF_BY_DEFAULT = ['receiver'];
function carouselFromScreens(screens) {
  const sc = screens || {};
  const ids = [...(sc.order || []), ...Object.keys(PAGE_FLAGS)].filter((id, i, all) => id in PAGE_FLAGS && all.indexOf(id) === i);
  return ids.map((id) => {
    const flag = PAGE_FLAGS[id] ? sc[PAGE_FLAGS[id]] : true;
    return { page: id, enabled: typeof flag === 'boolean' ? flag : !OFF_BY_DEFAULT.includes(id) };
  });
}
function screensFromCarousel(carousel, screens) {
  const out = { ...(screens || {}), order: carousel.map((c) => c.page) };
  for (const c of carousel) if (PAGE_FLAGS[c.page]) out[PAGE_FLAGS[c.page]] = c.enabled;
  return out;
}

// --- Overview ------------------------------------------------------------------------

function RoomsOverview({ rooms, clients, dashboards, reloadRooms, reloadDashboards }) {
  const [name, setName] = useState('');
  const [dashName, setDashName] = useState('');
  const [template, setTemplate] = useState('kitchen');
  const [msg, flash] = useFlash();

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const room = await api('/api/devices', { method: 'POST', body: { name: name.trim() } });
      setName('');
      await reloadRooms();
      go('remote-layouts', room.slug);
    } catch (err) {
      flash(err.message, 5000);
    }
  };

  const createDashboard = async (e) => {
    e.preventDefault();
    if (!dashName.trim()) return;
    try {
      const d = await api('/api/dashboards', { method: 'POST', body: { name: dashName.trim(), template } });
      setDashName('');
      await reloadDashboards();
      go('viewport-layouts', d.slug);
    } catch (err) {
      flash(err.message, 5000);
    }
  };

  const importJson = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const body = JSON.parse(await file.text());
      const slug = String(body.slug || file.name.replace(/\.json$/, ''))
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!slug) throw new Error('no slug in the file');
      await api(`/api/devices/${encodeURIComponent(slug)}/config`, { method: 'POST', body });
      await reloadRooms();
      go('remote-layouts', slug);
    } catch (err) {
      flash(`Import failed: ${err.message}`, 6000);
    }
  };

  const remotesIn = (slug) => (clients || []).filter((c) => c.assignedSlug === slug && c.type !== 'viewport');
  const deviceBadges = (list, icon, section) =>
    list.length
      ? list.map((c) => html`<a class="badge badge-accent" href=${`#/${section}/${encodeURIComponent(c.mac)}`} onClick=${(e) => e.stopPropagation()}><${Icon} name=${icon} size=${13} />${c.name}</a>`)
      : html`<${Badge} icon="link-variant-off">No devices yet<//>`;

  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon"><${Icon} name="view-dashboard-edit-outline" size=${26} /></div>
      <div class="ph-text">
        <h1>Layouts</h1>
        <p class="hint">Every UI lives here, ready before any hardware: remote layouts (one per room) above, viewport layouts below. Devices are just assigned to one.</p>
      </div>
      <div class="page-actions">
        <span class="flash flash-bad">${msg}</span>
      </div>
    </div>

    <div class="section-heading">
      <${Icon} name="remote" size=${22} /><h2>Remote layouts</h2>
      <span class="hint">One per room: its entities and what its remotes show. Remotes in the room use it.</span>
      <label class="btn btn-small" style="margin-left:auto" title="Import a room from a JSON file">
        <${Icon} name="upload-outline" size=${16} /><span>Import</span>
        <input type="file" accept="application/json,.json" hidden onChange=${importJson} />
      </label>
    </div>
    ${rooms === null && html`<p class="hint">Loading…</p>`}
    <div class="grid">
      ${(rooms || []).map(
        (r) => html`<a class="card" href=${`#/remote-layouts/${encodeURIComponent(r.slug)}`} style="text-decoration:none;color:inherit">
          <div class="card-head">
            <div class="card-icon"><${Icon} name="sofa-outline" size=${22} /></div>
            <div class="card-titles"><h2>${r.name}</h2><p class="hint">Updated ${timeAgo(r.updatedAt)}</p></div>
            <${Icon} name="chevron-right" size=${22} />
          </div>
          <div class="card-body"><div class="chips">${deviceBadges(remotesIn(r.slug), 'remote', 'remotes')}</div></div>
        </a>`
      )}
      <form class="card" onSubmit=${create}>
        <div class="card-head">
          <div class="card-icon"><${Icon} name="plus" size=${22} /></div>
          <div class="card-titles"><h2>New remote layout</h2><p class="hint">For a room</p></div>
        </div>
        <div class="card-body">
          <div class="input-with-button">
            <input type="text" placeholder="e.g. Living room" value=${name} onInput=${(e) => setName(e.target.value)} />
            <${Button} type="submit" kind="primary" icon="plus" disabled=${!name.trim()}>Create<//>
          </div>
        </div>
      </form>
    </div>

    <div class="section-heading">
      <${Icon} name="tablet-dashboard" size=${22} /><h2>Viewport layouts</h2>
      <span class="hint">Whole wall-display UIs. Assign one to any number of displays.</span>
    </div>
    ${dashboards === null && html`<p class="hint">Loading…</p>`}
    <div class="grid">
      ${(dashboards || []).map(
        (d) => html`<a class="card" href=${`#/viewport-layouts/${encodeURIComponent(d.slug)}`} style="text-decoration:none;color:inherit">
          <div class="card-head">
            <div class="card-icon"><${Icon} name=${d.screens.some((sc) => sc.kind === 'meetingRoom') ? 'calendar-account-outline' : 'view-dashboard-outline'} size=${22} /></div>
            <div class="card-titles"><h2>${d.name}</h2><p class="hint">${d.screens.filter((sc) => sc.enabled).map((sc) => sc.title || 'Untitled').join(' · ')}</p></div>
            <${Icon} name="chevron-right" size=${22} />
          </div>
          <div class="card-body"><div class="chips">${deviceBadges(d.devices, 'tablet-dashboard', 'viewports')}</div></div>
        </a>`
      )}
      <form class="card" onSubmit=${createDashboard}>
        <div class="card-head">
          <div class="card-icon"><${Icon} name="plus" size=${22} /></div>
          <div class="card-titles"><h2>New viewport layout</h2></div>
        </div>
        <div class="card-body">
          <div class="chips">
            ${[['kitchen', 'Home panel', 'home-outline'], ['meetingRoom', 'Meeting room', 'calendar-account-outline'], ['blank', 'Blank', 'file-outline']].map(
              ([v, label, icon]) => html`<button type="button" class=${`chip ${template === v ? 'on' : ''}`} onClick=${() => setTemplate(v)}><${Icon} name=${icon} size=${15} />${label}</button>`
            )}
          </div>
          <div class="input-with-button">
            <input type="text" placeholder="e.g. Kitchen wall" value=${dashName} onInput=${(e) => setDashName(e.target.value)} />
            <${Button} type="submit" kind="primary" icon="plus" disabled=${!dashName.trim()}>Create<//>
          </div>
        </div>
      </form>
    </div>
  </div>`;
}

export function RoomsPage({ slug, rooms, clients, dashboards, reloadRooms, reloadDashboards }) {
  return slug
    ? html`<${RoomEditor} key=${slug} slug=${slug} clients=${clients} reloadRooms=${reloadRooms} />`
    : html`<${RoomsOverview} rooms=${rooms} clients=${clients} dashboards=${dashboards} reloadRooms=${reloadRooms} reloadDashboards=${reloadDashboards} />`;
}
