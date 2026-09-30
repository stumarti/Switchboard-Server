// Remotes and Viewports: the list column of paired devices, approving new
// ones, and each device's own layout —
//   remote    carousel page cards (drag to reorder, switch on/off) and its
//             Quick Access hub buttons
//   viewport  a tile board (drag to reorder, pick a size and entity per tile)

import {
  html, useState, useEffect, useRef, api, go, Icon, Card, Field, TextInput, Select, Toggle, Button, Badge, Empty,
  useFlash, moveItem, timeAgo, batteryLifeText
} from './lib.js';
import { EntityPicker, IconPicker } from './pickers.js';
import { ItemList } from './rooms.js';
import { UpdatesCard, DeviceUpdateBadge } from './firmware.js';

const TYPE_META = {
  remote: { section: 'remotes', icon: 'remote', title: 'Remotes', one: 'remote' },
  viewport: { section: 'viewports', icon: 'tablet-dashboard', title: 'Viewports', one: 'viewport' }
};

const REFRESH_LABELS = { 5: 'Every 5 minutes', 10: 'Every 10 minutes', 15: 'Every 15 minutes', 30: 'Every 30 minutes', 60: 'Every hour' };
const REFRESH_CHOICES = [5, 10, 15, 30, 60];

function onlineKind(c) {
  if (c.status === 'pending') return 'warn';
  if (c.status !== 'approved') return 'bad';
  const age = (Date.now() - Date.parse(c.lastSeenAt || 0)) / 60000;
  return age < 90 ? 'ok' : '';
}

function dashboardName(dashboards, slug) {
  const d = (dashboards || []).find((x) => x.slug === slug);
  return d ? d.name : '';
}

function roomName(rooms, slug) {
  const r = (rooms || []).find((x) => x.slug === slug);
  return r ? r.name : slug ? slug : '';
}

// --- List column --------------------------------------------------------------------

export function ClientList({ type, selected, clients, rooms, dashboards }) {
  const meta = TYPE_META[type];
  const all = clients || [];
  // A device still waiting for approval is shown under Remotes whatever it
  // registered as, so it can't be missed; approving sets its type.
  const pending = type === 'remote' ? all.filter((c) => c.status === 'pending') : [];
  const mine = all.filter((c) => c.type === type && c.status !== 'pending');
  const groups = [
    { label: 'Waiting for approval', items: pending },
    { label: 'Paired', items: mine.filter((c) => c.status === 'approved') },
    { label: 'Revoked', items: mine.filter((c) => c.status !== 'approved') }
  ].filter((g) => g.items.length);

  return html`<aside class="sublist">
    <div class="sublist-head">
      <${Icon} name=${meta.icon} size=${22} />
      <h2>${meta.title}</h2>
    </div>
    <div class="sublist-body">
      ${clients === null && html`<p class="hint" style="padding:10px">Loading…</p>`}
      ${clients && !groups.length && html`<p class="hint" style="padding:10px">No ${meta.one}s yet. Power one on and it will appear here to approve.</p>`}
      ${groups.map(
        (g) => html`<div class="sublist-group">${g.label}</div>
          ${g.items.map(
            (c) => html`<a class=${`list-item ${selected === c.mac ? 'active' : ''}`} href=${`#/${meta.section}/${encodeURIComponent(c.mac)}`}>
              <div class="li-icon"><${Icon} name=${c.status === 'pending' ? 'help-circle-outline' : TYPE_META[c.type].icon} size=${20} /></div>
              <div class="li-text">
                <div class="li-title">${c.name}</div>
                <div class="li-sub">${c.status === 'pending' ? c.mac : c.type === 'viewport' ? dashboardName(dashboards, c.dashboard) || 'No layout' : roomName(rooms, c.assignedSlug) || 'No room'} · ${timeAgo(c.lastSeenAt)}</div>
              </div>
              <span class=${`dot dot-${onlineKind(c)}`}></span>
            </a>`
          )}`
      )}
    </div>
  </aside>`;
}

// --- Approval ------------------------------------------------------------------------

function ApproveCard({ client, rooms, dashboards, reloadClients }) {
  const [name, setName] = useState(client.name === client.mac ? '' : client.name);
  const [type, setType] = useState(client.type || 'remote');
  const [room, setRoom] = useState((rooms && rooms[0] && rooms[0].slug) || '');
  const [dash, setDash] = useState((dashboards && dashboards[0] && dashboards[0].slug) || '');
  const [msg, flash] = useFlash();
  const approve = async () => {
    try {
      await api(`/api/pairing/${encodeURIComponent(client.mac)}/approve`, { method: 'POST', body: { slug: type === 'remote' ? room : '' } });
      await api(`/api/clients/${encodeURIComponent(client.mac)}`, {
        method: 'PUT',
        body: { name: name || client.mac, type, ...(type === 'viewport' ? { dashboard: dash } : {}) }
      });
      await reloadClients();
      go(TYPE_META[type].section, client.mac);
    } catch (e) {
      flash(e.message, 6000);
    }
  };
  const reject = async () => {
    if (!confirm('Forget this device? If it is still on, it will ask to pair again.')) return;
    await api(`/api/pairing/${encodeURIComponent(client.mac)}`, { method: 'DELETE' });
    await reloadClients();
    go('remotes');
  };
  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon" style="background:var(--warn)"><${Icon} name="shield-key-outline" size=${26} /></div>
      <div class="ph-text">
        <h1>New device wants to pair</h1>
        <p class="hint"><code>${client.mac}</code> · ${client.lastIp || 'unknown IP'} · first seen ${timeAgo(client.firstSeenAt)}</p>
      </div>
    </div>
    <div class="grid">
      <${Card} icon="check-decagram-outline" title="Approve" subtitle="The device picks this up the next time it checks — press a key on its pairing screen.">
        <${Field} label="Name"><${TextInput} value=${name} placeholder="e.g. Living room remote" onInput=${setName} /><//>
        <${Field} label="Kind of device">
          <div class="chips">
            ${['remote', 'viewport'].map(
              (t) => html`<button type="button" class=${`chip ${type === t ? 'on' : ''}`} onClick=${() => setType(t)}>
                <${Icon} name=${TYPE_META[t].icon} size=${16} />${t === 'remote' ? 'Remote' : 'Viewport'}
              </button>`
            )}
          </div>
        <//>
        ${type === 'remote'
          ? html`<${Field} label="Room" hint="The remote shows this room's UI.">
              <${Select} value=${room} onChange=${setRoom} options=${[{ value: '', label: 'No room yet' }, ...(rooms || []).map((r) => ({ value: r.slug, label: r.name }))]} />
            <//>`
          : html`<${Field} label="Layout" hint="The display shows this viewport layout. Build layouts on the Layouts page, before or after pairing.">
              <${Select} value=${dash} onChange=${setDash} options=${[{ value: '', label: 'None yet' }, ...(dashboards || []).map((d) => ({ value: d.slug, label: d.name }))]} />
            <//>`}
        <div class="row">
          <${Button} kind="primary" icon="check" onClick=${approve}>Approve<//>
          <${Button} kind="danger" icon="close" onClick=${reject}>Reject<//>
          <span class="flash flash-bad">${msg}</span>
        </div>
      <//>
    </div>
  </div>`;
}

// --- Remote: carousel builder ---------------------------------------------------------

const PAGE_META = {
  status: { label: 'Status', icon: 'weather-partly-cloudy' },
  lighting: { label: 'Lighting', icon: 'lightbulb-group-outline' },
  blinds: { label: 'Blinds', icon: 'blinds' },
  music: { label: 'Music', icon: 'music-circle-outline' },
  tv: { label: 'TV', icon: 'television' },
  xbox: { label: 'Xbox', icon: 'microsoft-xbox' },
  wifi: { label: 'Guest Wi-Fi', icon: 'wifi-star' },
  climate: { label: 'Climate', icon: 'thermostat' },
  receiver: { label: 'Receiver', icon: 'satellite-variant' }
};

// What each page will show, from the room — or why it would be empty.
function pageSummary(page, room) {
  if (!room) return { text: '', ok: true };
  const n = (l) => (Array.isArray(l) ? l.length : 0);
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  switch (page) {
    case 'status': {
      const w = room.standby && room.standby.weatherEntity;
      return { text: w ? w.replace(/^weather\./, 'Weather: ') : 'No weather entity', ok: Boolean(w) };
    }
    case 'lighting': {
      const l = room.lighting || {};
      const parts = [];
      if (l.group && l.group.enabled) parts.push('group');
      if (n(l.lights)) parts.push(plural(n(l.lights), 'light'));
      if (n(l.scenes)) parts.push(plural(n(l.scenes), 'scene'));
      return { text: parts.join(' · ') || 'No lights in this room', ok: parts.length > 0 };
    }
    case 'blinds': {
      const b = room.blinds || {};
      const k = n(b.items) + (b.group && b.group.enabled ? 1 : 0);
      return { text: k ? plural(n(b.items), 'blind') + (b.group && b.group.enabled ? ' + group' : '') : 'No blinds in this room', ok: k > 0 };
    }
    case 'music': {
      const m = room.media || {};
      return { text: m.enabled && m.entity ? m.name || m.entity : 'No media player', ok: Boolean(m.enabled && m.entity) };
    }
    case 'tv': {
      const t = room.tv || {};
      return { text: t.mediaPlayerEntity ? t.mediaPlayerEntity : 'No TV', ok: Boolean(t.mediaPlayerEntity) };
    }
    case 'xbox': {
      const x = room.xbox || {};
      return { text: x.enabled && x.mediaPlayerEntity ? `${x.name || 'Xbox'} · ${plural(n(x.games), 'game')}` : 'No Xbox', ok: Boolean(x.enabled && x.mediaPlayerEntity) };
    }
    case 'climate': {
      const c = room.climate || {};
      const k = (c.entity ? 1 : 0) + n(c.additionalSensors);
      return { text: k ? plural(k, 'sensor') : 'No sensors', ok: k > 0 };
    }
    case 'wifi':
      return { text: 'Networks from Settings', ok: true };
    case 'receiver': {
      const r = room.receiver || {};
      const k = n(r.channels);
      return r.mediaPlayerEntity ? { text: k ? plural(k, 'favourite') : 'No favourites', ok: true } : { text: 'No receiver', ok: false };
    }
    default:
      return { text: '', ok: true };
  }
}

// Drag-and-drop ordering shared by the carousel and the tile board.
export function useDragOrder(list, onChange) {
  const [drag, setDrag] = useState(null); // index being dragged
  const [over, setOver] = useState(null); // {i, after}
  const props = (i) => ({
    draggable: true,
    onDragStart: (e) => {
      setDrag(i);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
    onDragOver: (e) => {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setOver({ i, after: e.clientX > r.left + r.width / 2 });
    },
    onDrop: (e) => {
      e.preventDefault();
      if (drag === null || !over) return;
      let to = over.i + (over.after ? 1 : 0);
      if (drag < to) to -= 1;
      if (to !== drag) onChange(moveItem(list, drag, to));
      setDrag(null);
      setOver(null);
    }
  });
  const cls = (i) =>
    [drag === i ? 'dragging' : '', over && over.i === i && drag !== i ? (over.after ? 'drop-after' : 'drop-before') : ''].join(' ');
  return { props, cls };
}

// The Refresh card's "on the clock" switch (room editor and a customised remote).
const MARKS = { 5: ':00, :05, :10 …', 10: ':00, :10, :20 …', 15: ':00, :15, :30 and :45', 30: ':00 and :30', 60: 'on the hour' };
export function ClockAlign({ checked, minutes, onChange }) {
  return html`<div style="margin-top:12px">
    <${Toggle} checked=${checked} onChange=${onChange} label="On the clock" />
    <p class="hint">${checked
      ? `Refreshes at ${MARKS[minutes] || 'the marks'} (server time), not ${minutes} minutes after the remote last slept. Each remote is 7 seconds later than the one before, so they don't all ask the server at once.`
      : `Each remote refreshes ${minutes} minutes after it last went to sleep.`}</p>
  </div>`;
}

// `selected`/`onSelect` (the room editor): the cards double as a picker for
// which page's settings show below, and `extras` adds cards after the pages
// for settings that aren't a page ({id, label, icon, sub}).
export function CarouselBuilder({ carousel, onChange, room, roomSlug, selected, onSelect, extras = [], subtitle }) {
  const { props, cls } = useDragOrder(carousel, onChange);
  const stop = (e) => e.stopPropagation();
  let num = 0;
  return html`<${Card} icon="view-carousel-outline" title="Carousel"
    subtitle=${subtitle || 'The pages this remote swipes through, left to right. Drag to reorder; switch pages off to skip them.'}>
    <div class=${`carousel ${onSelect ? 'carousel-strip' : ''}`}>
      ${carousel.map((c, i) => {
        const meta = PAGE_META[c.page] || { label: c.page, icon: 'card-outline' };
        const s = pageSummary(c.page, room);
        const locked = c.page === 'status';
        if (c.enabled) num += 1;
        return html`<div class=${`page-card ${c.enabled ? '' : 'off'} ${selected === c.page ? 'selected' : ''} ${onSelect ? 'selectable' : ''} ${cls(i)}`} key=${c.page} ...${props(i)}
          onClick=${onSelect ? () => onSelect(c.page) : undefined}>
          <div class="pc-top" onClick=${stop}>
            <span class="pc-num">${c.enabled ? num : '–'}</span>
            <span class="spacer"></span>
            ${locked
              ? html`<span title="The status page is always shown"><${Icon} name="lock-outline" size=${18} /></span>`
              : html`<${Toggle} checked=${c.enabled} onChange=${(v) => onChange(carousel.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />`}
          </div>
          <div class="pc-screen"><${Icon} name=${meta.icon} size=${40} /></div>
          <div class="pc-title">${meta.label}</div>
          <div class="pc-sub">
            ${!s.ok && c.enabled
              ? onSelect
                ? html`<span class="badge badge-warn"><${Icon} name="alert-outline" size=${13} />${s.text}</span>`
                : html`<a href=${`#/remote-layouts/${encodeURIComponent(roomSlug)}`} class="badge badge-warn"><${Icon} name="alert-outline" size=${13} />${s.text}</a>`
              : s.text}
          </div>
          <div class="pc-move" onClick=${stop}>
            <${Button} kind="ghost" small icon="chevron-left" title="Move left" disabled=${i === 0} onClick=${() => onChange(moveItem(carousel, i, i - 1))} />
            <${Button} kind="ghost" small icon="chevron-right" title="Move right" disabled=${i === carousel.length - 1} onClick=${() => onChange(moveItem(carousel, i, i + 1))} />
          </div>
        </div>`;
      })}
      ${extras.length > 0 && html`<div class="carousel-divider"></div>`}
      ${extras.map(
        (x) => html`<div class=${`page-card extra selectable ${selected === x.id ? 'selected' : ''}`} key=${x.id} onClick=${() => onSelect && onSelect(x.id)}>
          <div class="pc-top"><span class="pc-num"><${Icon} name="cog-outline" size=${14} /></span></div>
          <div class="pc-screen"><${Icon} name=${x.icon} size=${40} /></div>
          <div class="pc-title">${x.label}</div>
          <div class="pc-sub">${x.sub || ''}</div>
        </div>`
      )}
    </div>
  <//>`;
}

// --- Remote: Quick Access hub ------------------------------------------------------------

// Every page a hub button can open, in carousel order: the ids the remote
// firmware's hubTargetPage() knows (app/quick_access.h).
const HUB_TARGETS = [
  { value: 'status', label: 'Status', icon: 'home-outline' },
  { value: 'lighting', label: 'Lighting', icon: 'lightbulb-group-outline' },
  { value: 'blinds', label: 'Blinds', icon: 'blinds' },
  { value: 'media', label: 'Music', icon: 'music-circle-outline' },
  { value: 'tv', label: 'TV', icon: 'television' },
  { value: 'xbox', label: 'Xbox', icon: 'microsoft-xbox' },
  { value: 'guestwifi', label: 'Guest Wi-Fi', icon: 'wifi-star' },
  { value: 'climate', label: 'Climate', icon: 'thermostat' },
  { value: 'receiver', label: 'Receiver', icon: 'satellite-variant' },
  { value: 'settings', label: 'Settings', icon: 'cog-outline' }
];
// What a Toggle quick action can switch: the remote knows each domain's
// on/off services and states (ha_client.h's hubToggleService / hubStateActive).
const TOGGLE_DOMAINS = ['light', 'switch', 'fan', 'input_boolean', 'cover', 'valve', 'lock', 'media_player', 'automation', 'vacuum', 'humidifier', 'siren'];

export function HubBuilder({ hub, onChange }) {
  const h = hub || { quickActionsEnabled: true, items: [] };
  const setItems = (items) => onChange({ ...h, items });
  return html`<${Card} icon="view-grid-plus-outline" title="Quick Access" subtitle="The hub's buttons: the top opens a page, the strip below runs a quick action."
    actions=${html`<${Toggle} checked=${h.quickActionsEnabled} onChange=${(v) => onChange({ ...h, quickActionsEnabled: v })} label="Quick actions" />`}>
    <${ItemList}
      items=${h.items}
      onChange=${setItems}
      addLabel="Add button"
      empty="No buttons yet."
      newItem=${() => ({ id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2), name: '', icon: '', target: 'lighting', action: { type: 'none', entity: '', service: '', data: '' } })}
      render=${(it, upd) => {
        const a = it.action || { type: 'none' };
        const targets = HUB_TARGETS.some((t) => t.value === it.target) || !it.target
          ? HUB_TARGETS
          : [...HUB_TARGETS, { value: it.target, label: `${it.target} (no such page: opens Settings)` }];
        return html`<div class="row">
            <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
            <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
            <${Field} label="Opens"><${Select} value=${it.target} onChange=${(v) => upd({ ...it, target: v })} options=${targets} /><//>
            <${Field} label="Quick action">
              <${Select} value=${a.type} onChange=${(v) => upd({ ...it, action: { ...a, type: v } })}
                options=${[{ value: 'none', label: 'None' }, { value: 'toggle', label: 'Toggle an entity' }, { value: 'run', label: 'Call a service' }]} />
            <//>
          </div>
          ${a.type === 'toggle' &&
          html`<${Field} label="Entity to toggle">
            <${EntityPicker} domains=${TOGGLE_DOMAINS} value=${a.entity} onChange=${(id, e) => upd({ ...it, name: it.name || (e && e.name) || '', icon: it.icon || (e && e.icon) || '', action: { ...a, entity: id } })} />
          <//>`}
          ${a.type === 'run' &&
          html`<div class="row">
            <${Field} label="Service"><${TextInput} value=${a.service} placeholder="script.turn_on" onInput=${(v) => upd({ ...it, action: { ...a, service: v } })} /><//>
            <${Field} label="Entity (optional)"><${EntityPicker} compact value=${a.entity} onChange=${(id) => upd({ ...it, action: { ...a, entity: id } })} /><//>
          </div>
          <${Field} label="Service data (JSON, optional)">
            <textarea value=${a.data} placeholder='{"brightness_pct": 40}' onInput=${(e) => upd({ ...it, action: { ...a, data: e.target.value } })}></textarea>
          <//>`}`;
      }}
    />
  <//>`;
}

// --- Device page ------------------------------------------------------------------------------

function useRoom(slug) {
  const [room, setRoom] = useState(null);
  useEffect(() => {
    setRoom(null);
    if (!slug) return;
    api(`/api/devices/${encodeURIComponent(slug)}/config`).then(setRoom).catch(() => setRoom(null));
  }, [slug]);
  return room;
}

function ClientEditor({ client, rooms, dashboards, reloadClients, reloadDashboards }) {
  const meta = TYPE_META[client.type];
  const isRemote = client.type === 'remote';
  const [draft, setDraft] = useState(() => ({ name: client.name, room: client.assignedSlug || '', dashboard: client.dashboard || '', layout: client.layout }));
  // A remote shows its room's UI unless customised for this one remote.
  const [custom, setCustom] = useState(Boolean(client.layoutCustomized));
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useFlash();
  const room = useRoom(draft.room);
  const set = (k, v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };
  const setLayout = (k, v) => set('layout', { ...draft.layout, [k]: v });

  const save = async () => {
    try {
      const body = isRemote
        ? { name: draft.name, room: draft.room, layout: custom ? draft.layout : null }
        : { name: draft.name, dashboard: draft.dashboard };
      await api(`/api/clients/${encodeURIComponent(client.mac)}`, { method: 'PUT', body });
      setDirty(false);
      flash('Saved — the device picks it up on its next refresh');
      reloadClients();
    } catch (e) {
      flash(`Save failed: ${e.message}`, 6000);
    }
  };
  // A new dashboard for this display, assigned straight away.
  const newDashboard = async () => {
    const d = await api('/api/dashboards', { method: 'POST', body: { name: draft.name || 'Viewport', template: 'blank' } });
    await api(`/api/clients/${encodeURIComponent(client.mac)}`, { method: 'PUT', body: { dashboard: d.slug } });
    await Promise.all([reloadClients(), reloadDashboards()]);
    go('viewport-layouts', d.slug);
  };
  const act = async (what) => {
    const mac = encodeURIComponent(client.mac);
    if (what === 'revoke') {
      if (!confirm(`Revoke ${client.name}? It will have to be approved again.`)) return;
      await api(`/api/pairing/${mac}/revoke`, { method: 'POST' });
    } else if (what === 'delete') {
      if (!confirm(`Forget ${client.name} completely?`)) return;
      await api(`/api/pairing/${mac}`, { method: 'DELETE' });
      go(meta.section);
    } else if (what === 'convert') {
      const to = isRemote ? 'viewport' : 'remote';
      if (!confirm(`Make ${client.name} a ${to}? Its layout will be reset.`)) return;
      await api(`/api/clients/${mac}`, { method: 'PUT', body: { type: to } });
      await reloadClients();
      go(TYPE_META[to].section, client.mac);
    }
    reloadClients();
  };

  const approved = client.status === 'approved';
  const roomLabel = roomName(rooms, draft.room);
  return html`<div class="page">
    <div class="page-head">
      <div class="ph-icon"><${Icon} name=${meta.icon} size=${26} /></div>
      <div class="ph-text">
        <input type="text" value=${draft.name} onInput=${(e) => set('name', e.target.value)} style="font-size:20px;font-weight:600;border-color:transparent;padding:4px 6px;background:transparent" />
        <div class="chips" style="padding-left:6px">
          ${approved
            ? html`<${Badge} kind=${onlineKind(client) === 'ok' ? 'ok' : ''} icon="access-point">Seen ${timeAgo(client.lastSeenAt)}<//>`
            : html`<${Badge} kind="bad" icon="cancel">Revoked<//>`}
          <${Badge} icon="ip-network-outline">${client.lastIp || '—'}<//>
          ${client.health && client.health.battery != null &&
          html`<span title=${batteryLifeText(client.batteryLife).tip}><${Badge} kind=${client.health.battery <= 15 ? 'bad' : ''} icon="battery-outline">${client.health.battery}%${batteryLifeText(client.batteryLife).short ? ` · ${batteryLifeText(client.batteryLife).short}` : ''}<//></span>`}
          ${client.health && client.health.temperature != null && html`<${Badge} icon="thermometer">${client.health.temperature}°<//>`}
          ${client.health && client.health.rssi != null && html`<${Badge} icon="wifi">${client.health.rssi} dBm<//>`}
          ${isRemote
            ? html`<${DeviceUpdateBadge} mac=${client.mac} firmware=${client.health && client.health.firmware} />`
            : client.health && client.health.firmware && html`<${Badge} icon="chip">fw ${client.health.firmware}<//>`}
          <${Badge} icon="chip">${client.mac}<//>
        </div>
      </div>
      <div class="page-actions">
        <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
        <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty} onClick=${save}>Save<//>
      </div>
    </div>
    <div class="stack">
      ${isRemote
        ? html`<div class="grid">
              <${Card} icon="sofa-outline" title="Room" subtitle="The room whose layout this remote shows.">
                <${Select} value=${draft.room} onChange=${(v) => set('room', v)}
                  options=${[{ value: '', label: 'No room' }, ...(rooms || []).map((r) => ({ value: r.slug, label: r.name }))]} />
                ${draft.room && html`<a href=${`#/remote-layouts/${encodeURIComponent(draft.room)}`} class="hint"><${Icon} name="open-in-new" size=${14} /> Edit ${roomLabel}</a>`}
              <//>
              <${Card} icon=${custom ? 'pencil-outline' : 'content-copy'} title=${custom ? 'Customised for this remote' : `Uses ${roomLabel || 'its room'}'s layout`}
                subtitle=${custom ? "This remote has its own pages, Quick Access and refresh, below." : "Pages, their order, Quick Access and refresh come from the room's layout, so every remote in it matches."}>
                <div>
                  ${custom
                    ? html`<${Button} icon="restore" onClick=${() => {
                        setCustom(false);
                        setDirty(true);
                      }}>Use the room's layout instead<//>`
                    : html`<${Button} icon="pencil-outline" onClick=${() => {
                        setCustom(true);
                        setDirty(true);
                      }}>Customise for this remote<//>`}
                </div>
              <//>
            </div>
            ${custom &&
            html`<${Card} icon="update" title="Refresh" subtitle="How often it wakes to fetch new state. Less often = longer battery.">
                <${Select} value=${String(draft.layout.refreshIntervalMin)} onChange=${(v) => setLayout('refreshIntervalMin', Number(v))}
                  options=${REFRESH_CHOICES.map((n) => ({ value: String(n), label: REFRESH_LABELS[n] }))} />
                <${ClockAlign} checked=${Boolean(draft.layout.refreshAligned)} minutes=${draft.layout.refreshIntervalMin}
                  onChange=${(v) => setLayout('refreshAligned', v)} />
              <//>
              <${CarouselBuilder} carousel=${draft.layout.carousel} onChange=${(c) => setLayout('carousel', c)} room=${room} roomSlug=${draft.room} />
              <${HubBuilder} hub=${draft.layout.hub} onChange=${(h) => setLayout('hub', h)} />`}`
        : html`<div class="grid">
            <${Card} icon="view-dashboard-outline" title="Layout" subtitle="The UI this display shows. Viewport layouts live on the Layouts page and can be built before any display is paired.">
              <${Select} value=${draft.dashboard} onChange=${(v) => set('dashboard', v)}
                options=${[{ value: '', label: 'None — shows “not set up”' }, ...(dashboards || []).map((d) => ({ value: d.slug, label: d.name }))]} />
              <div class="row">
                ${draft.dashboard && html`<a href=${`#/viewport-layouts/${encodeURIComponent(draft.dashboard)}`} class="btn"><${Icon} name="pencil-outline" size=${18} /><span>Edit layout</span></a>`}
                <${Button} icon="plus" onClick=${newDashboard}>New layout for this display<//>
              </div>
            <//>
          </div>`}
      <${Card} icon="wrench-outline" title="Manage">
        <div class="row">
          <${Button} icon="swap-horizontal" onClick=${() => act('convert')}>Make it a ${isRemote ? 'viewport' : 'remote'}<//>
          ${approved && html`<${Button} kind="danger" icon="link-variant-off" onClick=${() => act('revoke')}>Revoke<//>`}
          <${Button} kind="danger" icon="trash-can-outline" onClick=${() => act('delete')}>Forget device<//>
        </div>
      <//>
    </div>
  </div>`;
}

export function ClientPage({ type, mac, clients, rooms, dashboards, reloadClients, reloadDashboards }) {
  const meta = TYPE_META[type];
  if (clients === null) return html`<div class="page"><p class="hint">Loading…</p></div>`;
  const client = mac && clients.find((c) => c.mac === mac);
  if (!client) {
    return html`<div class="page">
      ${type === 'remote' && !mac && html`<div style="max-width:720px;margin:0 auto 18px"><${UpdatesCard} /></div>`}
      <${Empty} icon=${meta.icon} title=${mac ? 'Device not found' : `Choose a ${meta.one}`}>
        ${type === 'remote'
          ? "Pick a remote on the left to choose its room. A remote shows its room's layout, built on the Layouts page. A new remote shows up here as soon as it asks to pair."
          : 'Viewports are colour wall-mounted e-ink displays. Pick one on the left to choose its layout; viewport layouts are built on the Layouts page, before or after a display is paired.'}
      <//>
    </div>`;
  }
  const props = { client, rooms, dashboards, reloadClients, reloadDashboards };
  if (client.status === 'pending') return html`<${ApproveCard} key=${client.mac} ...${props} />`;
  return html`<${ClientEditor} key=${client.mac} ...${props} />`;
}
