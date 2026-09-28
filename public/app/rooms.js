// Rooms: what's in each room (which Home Assistant entities), one card per
// function. How a room is PRESENTED — which carousel pages, in what order,
// the Quick Access buttons — belongs to each remote/viewport instead.

import {
  html, useState, useEffect, api, go, Icon, Card, Field, TextInput, SecretInput, Select, Toggle, Button, Badge,
  Empty, useFlash, setIn, getIn, moveItem, timeAgo
} from './lib.js';
import { EntityPicker, IconPicker, useHaStatus } from './pickers.js';

// --- A reorderable list of items (lights, scenes, blinds, sensors, games) ---

export function ItemList({ items, onChange, newItem, addLabel = 'Add', render, empty }) {
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
    <div><${Button} small icon="plus" onClick=${() => onChange([...list, newItem()])}>${addLabel}<//></div>
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

const TV_APPS = [
  { key: 'youtube', label: 'YouTube', icon: 'youtube' },
  { key: 'netflix', label: 'Netflix', icon: 'netflix' },
  { key: 'tvMate', label: 'TV Mate', icon: 'television-guide' }
];

function TvCard({ room, set }) {
  const tv = room.tv || {};
  return html`<${Card} icon="television" title="TV" subtitle="Android TV: D-pad, volume and app shortcuts.">
    <div class="row">
      <${Field} label="Media player"><${EntityPicker} domains=${['media_player']} value=${tv.mediaPlayerEntity} onChange=${(id) => set(['tv', 'mediaPlayerEntity'], id)} /><//>
      <${Field} label="Remote"><${EntityPicker} domains=${['remote']} value=${tv.remoteEntity} onChange=${(id) => set(['tv', 'remoteEntity'], id)} /><//>
    </div>
    <${Field} label="App shortcuts" hint="The launch value sent through the remote (package name or intent).">
      ${TV_APPS.map(
        (a) => html`<div class="row" style="align-items:center">
          <${Icon} name=${a.icon} size=${20} />
          <span style="width:80px">${a.label}</span>
          <div style="flex:1"><${TextInput} value=${getIn(tv, ['apps', a.key])} onInput=${(v) => set(['tv', 'apps', a.key], v)} /></div>
        </div>`
      )}
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

function RoomEditor({ slug, clients, reloadRooms }) {
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
    go('rooms');
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(room, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const users = (clients || []).filter((c) => c.assignedSlug === slug);
  const cardProps = { room, set };

  return html`<div class="page">
    <div class="page-head">
      <${Button} kind="ghost" icon="arrow-left" title="All rooms" onClick=${() => go('rooms')} />
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
    <div class="grid">
      <${StatusCard} ...${cardProps} />
      <${LightingCard} ...${cardProps} />
      <${ClimateCard} ...${cardProps} />
      <${BlindsCard} ...${cardProps} />
      <${MusicCard} ...${cardProps} />
      <${TvCard} ...${cardProps} />
      <${XboxCard} ...${cardProps} />
      <${ConnectionCard} ...${cardProps} />
    </div>
  </div>`;
}

// --- Overview ------------------------------------------------------------------------

function RoomsOverview({ rooms, clients, reloadRooms }) {
  const [name, setName] = useState('');
  const [msg, flash] = useFlash();

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const room = await api('/api/devices', { method: 'POST', body: { name: name.trim() } });
      setName('');
      await reloadRooms();
      go('rooms', room.slug);
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
      go('rooms', slug);
    } catch (err) {
      flash(`Import failed: ${err.message}`, 6000);
    }
  };

  const byRoom = (slug) => (clients || []).filter((c) => c.assignedSlug === slug);

  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon"><${Icon} name="home-group" size=${26} /></div>
      <div class="ph-text">
        <h1>Rooms</h1>
        <p class="hint">Each room is a set of Home Assistant entities. Remotes and viewports each show one room.</p>
      </div>
      <div class="page-actions">
        <span class="flash flash-bad">${msg}</span>
        <label class="btn" title="Import a room from a JSON file">
          <${Icon} name="upload-outline" size=${18} /><span>Import</span>
          <input type="file" accept="application/json,.json" hidden onChange=${importJson} />
        </label>
      </div>
    </div>
    ${rooms === null && html`<p class="hint">Loading…</p>`}
    <div class="grid">
      ${(rooms || []).map((r) => {
        const users = byRoom(r.slug);
        return html`<a class="card" href=${`#/rooms/${encodeURIComponent(r.slug)}`} style="text-decoration:none;color:inherit">
          <div class="card-head">
            <div class="card-icon"><${Icon} name="sofa-outline" size=${22} /></div>
            <div class="card-titles"><h2>${r.name}</h2><p class="hint">Updated ${timeAgo(r.updatedAt)}</p></div>
            <${Icon} name="chevron-right" size=${22} />
          </div>
          <div class="card-body">
            <div class="chips">
              ${users.length
                ? users.map((c) => html`<${Badge} kind="accent" icon=${c.type === 'viewport' ? 'tablet-dashboard' : 'remote'}>${c.name}<//>`)
                : html`<${Badge} icon="link-variant-off">No devices<//>`}
            </div>
          </div>
        </a>`;
      })}
      <form class="card" onSubmit=${create}>
        <div class="card-head">
          <div class="card-icon"><${Icon} name="plus" size=${22} /></div>
          <div class="card-titles"><h2>New room</h2></div>
        </div>
        <div class="card-body">
          <div class="input-with-button">
            <input type="text" placeholder="e.g. Living room" value=${name} onInput=${(e) => setName(e.target.value)} />
            <${Button} type="submit" kind="primary" icon="plus" disabled=${!name.trim()}>Create<//>
          </div>
        </div>
      </form>
    </div>
    ${rooms && !rooms.length && html`<${Empty} icon="sofa-outline" title="No rooms yet">Create one to start adding lights, blinds and more.<//>`}
  </div>`;
}

export function RoomsPage({ slug, rooms, clients, reloadRooms }) {
  return slug
    ? html`<${RoomEditor} key=${slug} slug=${slug} clients=${clients} reloadRooms=${reloadRooms} />`
    : html`<${RoomsOverview} rooms=${rooms} clients=${clients} reloadRooms=${reloadRooms} />`;
}
