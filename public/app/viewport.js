// A viewport's dashboard builder: which screens it pages through (and in
// what order), then one tab per screen with a card per section, and a live
// preview of that screen drawn from what Home Assistant says right now.
// Everything here edits the layout object lib/dashboard.js normalizes; the
// device page (clients.js) saves it.

import {
  html, useState, useEffect, useRef, api, Icon, Card, Field, TextInput, Select, Toggle, Button, Badge, useFlash, moveItem
} from './lib.js';
import { EntityPicker, IconPicker } from './pickers.js';
import { ItemList } from './rooms.js';
import { ViewportPreview, PALETTE } from './viewport-preview.js';

const SCREEN_META = {
  main: { label: 'Main', icon: 'view-dashboard-outline', about: 'Weather, energy, battery, status icons, alerts, calendar' },
  climate: { label: 'Climate', icon: 'thermostat', about: 'Heat pump and every room against its target' },
  presence: { label: 'Presence', icon: 'account-group-outline', about: 'Room temperatures, people, now playing, departures' },
  security: { label: 'Security', icon: 'shield-home-outline', about: 'Alarm, doors, windows, motion, cameras' }
};

const CONDITIONS = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'is above' },
  { value: 'lt', label: 'is below' }
];

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

// --- Small editors --------------------------------------------------------------------

// The panel's colours as swatches (white left out: nothing is drawn in white
// on white).
export function ColorPicker({ value, onChange, colors = [1, 2, 3, 4, 5] }) {
  return html`<div class="swatches">
    ${colors.map(
      (i) => html`<button
        type="button"
        class=${`swatch ${value === i ? 'on' : ''}`}
        title=${PALETTE[i].name}
        style=${{ background: PALETTE[i].hex }}
        onClick=${() => onChange(i)}
      ></button>`
    )}
  </div>`;
}

function CondSelect({ value, onChange }) {
  return html`<${Select} value=${value} onChange=${onChange} options=${CONDITIONS} />`;
}

// "When the state is X, colour Y" — first match wins, else the default.
function RuleList({ rules, onChange, defaultColor, onDefault }) {
  const list = rules || [];
  const upd = (i, r) => onChange(list.map((x, j) => (j === i ? r : x)));
  return html`<div class="rules">
    ${list.map(
      (r, i) => html`<div class="rule">
        <span class="hint">when state</span>
        <div style="width:110px"><${CondSelect} value=${r.cond} onChange=${(v) => upd(i, { ...r, cond: v })} /></div>
        <div style="flex:1;min-width:90px"><${TextInput} value=${r.value} placeholder="value" onInput=${(v) => upd(i, { ...r, value: v })} /></div>
        <${ColorPicker} value=${r.color} onChange=${(v) => upd(i, { ...r, color: v })} />
        <${Button} kind="ghost" small icon="close" title="Remove rule" onClick=${() => onChange(list.filter((_, j) => j !== i))} />
      </div>`
    )}
    <div class="rule">
      <${Button} small icon="plus" disabled=${list.length >= 8} onClick=${() => onChange([...list, { cond: 'eq', value: 'on', color: 2 }])}>Rule<//>
      <span class="hint" style="margin-left:auto">otherwise</span>
      <${ColorPicker} value=${defaultColor} onChange=${onDefault} />
    </div>
  </div>`;
}

const NumberInput = ({ value, onChange, step = 1 }) =>
  html`<input type="number" step=${step} value=${value ?? ''} onInput=${(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />`;

// A list of {name, entity} rows (doors, people, motion sensors...).
function NamedList({ items, onChange, domains, max, addLabel, extra }) {
  return html`<${ItemList}
    items=${items}
    onChange=${onChange}
    max=${max}
    addLabel=${addLabel}
    newItem=${() => ({ id: newId(), name: '', entity: '' })}
    render=${(it, upd) => html`<div class="row">
      ${extra && extra(it, upd)}
      <${Field} label="Entity"><${EntityPicker} domains=${domains} value=${it.entity} onChange=${(id, e) => upd({ ...it, entity: id, name: it.name || (e && e.name) || '' })} /><//>
      <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
    </div>`}
  />`;
}

// --- Main screen -------------------------------------------------------------------------

function StatusIconsCard({ layout, set }) {
  return html`<${Card} icon="dots-horizontal-circle-outline" title="Status icons" subtitle="The row of icons across the top. Each one's colour follows its entity's state.">
    <${ItemList}
      items=${layout.statusIcons}
      onChange=${(l) => set('statusIcons', l)}
      max=${9}
      addLabel="Add icon"
      newItem=${() => ({ id: newId(), name: '', icon: '', entity: '', rules: [{ cond: 'eq', value: 'on', color: 2 }], defaultColor: 1 })}
      render=${(it, upd) => html`<div class="row">
          <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Entity"><${EntityPicker} value=${it.entity} onChange=${(id, e) => upd({ ...it, entity: id, name: it.name || (e && e.name) || '', icon: it.icon || (e && e.icon) || '' })} /><//>
          <${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
        </div>
        <${RuleList} rules=${it.rules} onChange=${(r) => upd({ ...it, rules: r })} defaultColor=${it.defaultColor} onDefault=${(v) => upd({ ...it, defaultColor: v })} />`}
    />
  <//>`;
}

function AlertsCard({ layout, set }) {
  return html`<${Card} icon="alert-outline" title="Alert lines" subtitle="Each slot lists the entities that match, as one line: “Front door, Garage +1 open”. Nothing matching shows “All clear”.">
    <${ItemList}
      items=${layout.alerts}
      onChange=${(l) => set('alerts', l)}
      max=${9}
      addLabel="Add alert"
      newItem=${() => ({ id: newId(), enabled: true, suffix: 'open', cond: 'eq', value: 'on', color: 2, entities: [] })}
      render=${(it, upd) => html`<div class="row" style="align-items:center">
          <${Toggle} checked=${it.enabled} onChange=${(v) => upd({ ...it, enabled: v })} />
          <span class="hint">when</span>
          <div style="width:110px"><${CondSelect} value=${it.cond} onChange=${(v) => upd({ ...it, cond: v })} /></div>
          <div style="width:110px"><${TextInput} value=${it.value} placeholder="value" onInput=${(v) => upd({ ...it, value: v })} /></div>
          <span class="hint">show</span>
          <div style="width:120px"><${TextInput} value=${it.suffix} placeholder="open" onInput=${(v) => upd({ ...it, suffix: v })} /></div>
          <span class="hint">in</span>
          <${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} />
        </div>
        <${NamedList} items=${it.entities.map((e, i) => ({ id: String(i), ...e }))} max=${8} addLabel="Add entity"
          onChange=${(l) => upd({ ...it, entities: l.map(({ entity, name }) => ({ entity, name })) })} />`}
    />
  <//>`;
}

function MainTab({ layout, set, setIn }) {
  const e = layout.energy;
  const b = layout.battery;
  const sensor = (key, label) => html`<${Field} label=${label}><${EntityPicker} domains=${['sensor']} value=${e[key]} onChange=${(id) => setIn(['energy', key], id)} /><//>`;
  return html`<div class="grid">
    <${Card} icon="weather-partly-cloudy" title="Weather" subtitle="Now, “later” and the next two days — no template sensors needed.">
      <${EntityPicker} domains=${['weather']} value=${layout.weather.entity} onChange=${(id) => setIn(['weather', 'entity'], id)} />
    <//>
    <${Card} icon="solar-power-variant" title="Energy" subtitle="Today's totals.">
      <div class="row">${sensor('solarToday', 'Solar today')}${sensor('solarExpected', 'Solar forecast')}</div>
      <div class="row">${sensor('loadToday', 'House load')}${sensor('gridExport', 'Grid export')}</div>
      ${sensor('gridImport', 'Grid import')}
    <//>
    <${Card} icon="home-battery-outline" title="Home battery">
      <div class="row">
        <${Field} label="Charge %"><${EntityPicker} domains=${['sensor']} value=${b.soc} onChange=${(id) => setIn(['battery', 'soc'], id)} /><//>
        <${Field} label="Status"><${EntityPicker} domains=${['sensor']} value=${b.status} onChange=${(id) => setIn(['battery', 'status'], id)} /><//>
      </div>
      <${Field} label="Time to full/empty"><${EntityPicker} domains=${['sensor']} value=${b.eta} onChange=${(id) => setIn(['battery', 'eta'], id)} /><//>
      <${Field} label="Colours" hint="Critical is at or below the critical threshold (Settings tab).">
        ${[['charging', 'Charging'], ['full', 'Full'], ['discharging', 'Discharging'], ['critical', 'Critical'], ['idle', 'Idle']].map(
          ([k, label]) => html`<div class="row" style="align-items:center"><span style="width:100px">${label}</span><${ColorPicker} value=${b.colors[k]} onChange=${(v) => setIn(['battery', 'colors', k], v)} /></div>`
        )}
      <//>
    <//>
    <${Card} icon="calendar-month-outline" title="Calendar" subtitle="The next events across these calendars.">
      <${ItemList}
        items=${layout.calendar.entities.map((x, i) => ({ id: String(i), entity: x }))}
        onChange=${(l) => setIn(['calendar', 'entities'], l.map((x) => x.entity))}
        max=${8}
        addLabel="Add calendar"
        newItem=${() => ({ id: newId(), entity: '' })}
        render=${(it, upd) => html`<${EntityPicker} domains=${['calendar']} value=${it.entity} onChange=${(id) => upd({ ...it, entity: id })} />`}
      />
      <div class="row">
        <${Field} label="Days ahead"><${NumberInput} value=${layout.calendar.days} onChange=${(v) => setIn(['calendar', 'days'], v)} /><//>
        <${Field} label="Lines shown"><${NumberInput} value=${layout.calendar.lines} onChange=${(v) => setIn(['calendar', 'lines'], v)} /><//>
      </div>
    <//>
  </div>
  <div class="stack" style="margin-top:16px">
    <${StatusIconsCard} layout=${layout} set=${set} />
    <${AlertsCard} layout=${layout} set=${set} />
  </div>`;
}

// --- Climate / presence / security ------------------------------------------------------------

function RoomsCard({ layout, set, rooms }) {
  const [busy, setBusy] = useState(false);
  // One row per Switchboard room: its thermostat and main temperature sensor.
  const fromRooms = async () => {
    setBusy(true);
    try {
      const have = new Set(layout.rooms.map((r) => r.name.toLowerCase()));
      const added = [];
      for (const r of rooms || []) {
        if (have.has(r.name.toLowerCase())) continue;
        const p = await api(`/api/devices/${encodeURIComponent(r.slug)}/config`);
        const climate = (p.standby && p.standby.climateEntity) || '';
        const temperature = (p.climate && p.climate.entity) || '';
        if (!climate && !temperature) continue;
        added.push({ id: newId(), name: r.name, icon: 'sofa-outline', floor: 'downstairs', temperature, humidity: '', climate, target: null });
      }
      set('rooms', [...layout.rooms, ...added].slice(0, 12));
    } finally {
      setBusy(false);
    }
  };
  return html`<${Card} icon="home-thermometer-outline" title="Rooms" subtitle="Shown on Climate (against their target) and Presence (temperature and humidity)."
    actions=${html`<${Button} small icon="import" disabled=${busy || !(rooms && rooms.length)} onClick=${fromRooms}>From Switchboard rooms<//>`}>
    <${ItemList}
      items=${layout.rooms}
      onChange=${(l) => set('rooms', l)}
      max=${12}
      addLabel="Add room"
      newItem=${() => ({ id: newId(), name: '', icon: '', floor: 'downstairs', temperature: '', humidity: '', climate: '', target: 21 })}
      render=${(it, upd) => html`<div class="row">
          <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Name"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
          <div style="width:140px"><${Field} label="Floor"><${Select} value=${it.floor} onChange=${(v) => upd({ ...it, floor: v })} options=${[{ value: 'upstairs', label: 'Upstairs' }, { value: 'downstairs', label: 'Downstairs' }]} /><//></div>
        </div>
        <div class="row">
          <${Field} label="Temperature"><${EntityPicker} domains=${['sensor']} value=${it.temperature} onChange=${(id, e) => upd({ ...it, temperature: id, name: it.name || (e && e.name) || '' })} /><//>
          <${Field} label="Humidity"><${EntityPicker} domains=${['sensor']} value=${it.humidity} onChange=${(id) => upd({ ...it, humidity: id })} /><//>
        </div>
        <div class="row">
          <${Field} label="Thermostat (optional)" hint="Gives the target and whether it's calling for heat."><${EntityPicker} domains=${['climate']} value=${it.climate} onChange=${(id) => upd({ ...it, climate: id })} /><//>
          <div style="width:150px"><${Field} label="Fixed target °" hint="Without a thermostat."><${NumberInput} step="0.5" value=${it.target} onChange=${(v) => upd({ ...it, target: v })} /><//></div>
        </div>`}
    />
  <//>`;
}

function ClimateTab({ layout, set, setIn, rooms }) {
  const hp = layout.heatPump;
  return html`<div class="grid">
    <${Card} icon="heat-pump-outline" title="Heat pump">
      <${Field} label="Heat pump"><${EntityPicker} domains=${['climate']} value=${hp.entity} onChange=${(id) => setIn(['heatPump', 'entity'], id)} /><//>
      <${Field} label="Outside temperature"><${EntityPicker} domains=${['sensor', 'weather']} value=${hp.outsideTemperature} onChange=${(id) => setIn(['heatPump', 'outsideTemperature'], id)} /><//>
      <${Field} label="COP (optional)"><${EntityPicker} domains=${['sensor']} value=${hp.cop} onChange=${(id) => setIn(['heatPump', 'cop'], id)} /><//>
    <//>
  </div>
  <div class="stack" style="margin-top:16px"><${RoomsCard} layout=${layout} set=${set} rooms=${rooms} /></div>`;
}

function PresenceTab({ layout, set }) {
  return html`<div class="grid">
    <${Card} icon="account-group-outline" title="People" subtitle="Green when home.">
      <${NamedList} items=${layout.people} onChange=${(l) => set('people', l)} domains=${['person', 'device_tracker']} max=${8} addLabel="Add person" />
    <//>
    <${Card} icon="music-circle-outline" title="Now playing" subtitle="Shown while playing or paused. The label is the room.">
      <${NamedList} items=${layout.media} onChange=${(l) => set('media', l)} domains=${['media_player']} max=${3} addLabel="Add player"
        extra=${(it, upd) => html`<${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />`} />
    <//>
  </div>
  <div class="stack" style="margin-top:16px">
    <${Card} icon="bus-clock" title="Next departures" subtitle="Each departure sensor can hold a time, a timestamp or minutes. Red once it's within the “imminent” threshold.">
      <${ItemList}
        items=${layout.transport}
        onChange=${(l) => set('transport', l)}
        max=${3}
        addLabel="Add route"
        newItem=${() => ({ id: newId(), name: '', stop: '', icon: 'bus', color: 4, departure1: '', departure2: '' })}
        render=${(it, upd) => html`<div class="row">
            <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
            <${Field} label="Route"><${TextInput} value=${it.name} placeholder="42 · City Centre" onInput=${(v) => upd({ ...it, name: v })} /><//>
            <${Field} label="Stop"><${TextInput} value=${it.stop} placeholder="High Street" onInput=${(v) => upd({ ...it, stop: v })} /><//>
            <${Field} label="Colour"><${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} /><//>
          </div>
          <div class="row">
            <${Field} label="Next departure"><${EntityPicker} domains=${['sensor']} value=${it.departure1} onChange=${(id) => upd({ ...it, departure1: id })} /><//>
            <${Field} label="The one after"><${EntityPicker} domains=${['sensor']} value=${it.departure2} onChange=${(id) => upd({ ...it, departure2: id })} /><//>
          </div>`}
      />
    <//>
  </div>`;
}

function SecurityTab({ layout, setIn }) {
  const s = layout.security;
  const OPENABLE = ['binary_sensor', 'cover', 'lock'];
  return html`<div class="grid">
    <${Card} icon="shield-home-outline" title="Alarm">
      <${Field} label="Alarm panel"><${EntityPicker} domains=${['alarm_control_panel']} value=${s.alarm} onChange=${(id) => setIn(['security', 'alarm'], id)} /><//>
      <${Field} label="Last armed (optional)" hint="A timestamp sensor, or any entity that changes when it happens."><${EntityPicker} value=${s.lastArmed} onChange=${(id) => setIn(['security', 'lastArmed'], id)} /><//>
      <${Field} label="Last disarmed (optional)"><${EntityPicker} value=${s.lastDisarmed} onChange=${(id) => setIn(['security', 'lastDisarmed'], id)} /><//>
      <${Field} label="Last triggered (optional)"><${EntityPicker} value=${s.lastTriggered} onChange=${(id) => setIn(['security', 'lastTriggered'], id)} /><//>
    <//>
    <${Card} icon="door" title="Doors" subtitle="Red when open.">
      <${NamedList} items=${s.doors} onChange=${(l) => setIn(['security', 'doors'], l)} domains=${OPENABLE} max=${8} addLabel="Add door" />
    <//>
    <${Card} icon="window-closed-variant" title="Windows" subtitle="Red when open.">
      <${NamedList} items=${s.windows} onChange=${(l) => setIn(['security', 'windows'], l)} domains=${OPENABLE} max=${8} addLabel="Add window" />
    <//>
    <${Card} icon="motion-sensor" title="Motion" subtitle="Blue when there's been motion within the “recent” threshold.">
      <${NamedList} items=${s.motion} onChange=${(l) => setIn(['security', 'motion'], l)} domains=${['binary_sensor']} max=${8} addLabel="Add sensor" />
    <//>
    <${Card} icon="cctv" title="Cameras" subtitle="Last motion: a camera's motion sensor or a timestamp sensor.">
      <${NamedList} items=${s.cameras} onChange=${(l) => setIn(['security', 'cameras'], l)} domains=${['binary_sensor', 'sensor', 'camera', 'event']} max=${6} addLabel="Add camera" />
    <//>
  </div>`;
}

// --- Settings + import ---------------------------------------------------------------------------

const THRESHOLDS = [
  ['batteryCritical', 'Battery critical %', 'Battery turns the “critical” colour.'],
  ['batteryLow', 'Battery low %', ''],
  ['solarPeak', 'Solar peak', 'Your best expected solar day, for scaling.'],
  ['transportUrgentMin', 'Departure imminent (min)', 'Departures this close turn red.'],
  ['motionRecentMin', 'Motion recent (min)', 'Motion this recent shows blue.'],
  ['climateTolerance', 'Climate tolerance °', 'How far from target still counts as “at target”.']
];

function SettingsTab({ layout, setIn, replace }) {
  const [ip, setIp] = useState('');
  const [json, setJson] = useState('');
  const [msg, flash] = useFlash();
  const importConfig = async (config) => {
    const r = await api('/api/viewports/import', { method: 'POST', body: { config } });
    replace(r.layout);
    flash('Imported — check each screen, then Save.', 8000);
  };
  const fromDevice = async () => {
    try {
      const res = await fetch(`http://${ip.trim()}/api/config`);
      if (!res.ok) throw new Error(`the panel answered ${res.status}`);
      await importConfig(await res.json());
    } catch (e) {
      flash(`Couldn't read the panel: ${e.message}. Paste its config below instead.`, 10000);
    }
  };
  const fromPaste = async () => {
    try {
      await importConfig(JSON.parse(json));
    } catch (e) {
      flash(`Import failed: ${e.message}`, 8000);
    }
  };
  const defaults = async () => {
    if (!confirm('Replace this layout with the defaults?')) return;
    replace((await api('/api/viewports/defaults')).layout);
    flash('Defaults loaded — Save to keep them.', 6000);
  };
  return html`<div class="grid">
    <${Card} icon="tune-variant" title="Thresholds">
      ${THRESHOLDS.map(
        ([k, label, hint]) => html`<${Field} label=${label} hint=${hint}><${NumberInput} step="0.5" value=${layout.thresholds[k]} onChange=${(v) => setIn(['thresholds', k], v)} /><//>`
      )}
    <//>
    <${Card} icon="import" title="Import from the kitchen panel" subtitle="Bring over the settings from the panel's own web page (config mode): entities, icons, colours, thresholds and alert slots.">
      <${Field} label="Panel IP address" hint="Put the panel in config mode (long-press the middle button) first.">
        <div class="input-with-button">
          <input type="text" value=${ip} placeholder="192.168.1.50" onInput=${(e) => setIp(e.target.value)} />
          <${Button} icon="download-network-outline" disabled=${!ip.trim()} onClick=${fromDevice}>Read<//>
        </div>
      <//>
      <${Field} label="…or paste its /api/config JSON">
        <textarea value=${json} onInput=${(e) => setJson(e.target.value)} placeholder='{"sensors": {...}, "colors": {...}}'></textarea>
      <//>
      <div class="row" style="align-items:center">
        <${Button} icon="import" disabled=${!json.trim()} onClick=${fromPaste}>Import<//>
        <${Button} kind="ghost" icon="restore" onClick=${defaults}>Load defaults<//>
      </div>
      <span class=${`flash ${/failed|Couldn't/.test(msg) ? 'flash-bad' : ''}`}>${msg}</span>
    <//>
  </div>`;
}

// --- Screens carousel ------------------------------------------------------------------------------

function ScreensCard({ screens, onChange, useDragOrder }) {
  const { props, cls } = useDragOrder(screens, onChange);
  let n = 0;
  return html`<${Card} icon="view-carousel-outline" title="Screens" subtitle="The pages the left/right buttons step through. Drag to reorder; switch off any you don't use.">
    <div class="carousel">
      ${screens.map((s, i) => {
        const m = SCREEN_META[s.screen];
        if (s.enabled) n += 1;
        return html`<div class=${`page-card ${s.enabled ? '' : 'off'} ${cls(i)}`} key=${s.screen} ...${props(i)}>
          <div class="pc-top">
            <span class="pc-num">${s.enabled ? n : '–'}</span>
            <span class="spacer"></span>
            ${s.screen === 'main'
              ? html`<span title="The main screen is always shown"><${Icon} name="lock-outline" size=${18} /></span>`
              : html`<${Toggle} checked=${s.enabled} onChange=${(v) => onChange(screens.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />`}
          </div>
          <div class="pc-screen"><${Icon} name=${m.icon} size=${40} /></div>
          <div class="pc-title">${m.label}</div>
          <div class="pc-sub">${m.about}</div>
          <div class="pc-move">
            <${Button} kind="ghost" small icon="chevron-left" title="Move left" disabled=${i === 0} onClick=${() => onChange(moveItem(screens, i, i - 1))} />
            <${Button} kind="ghost" small icon="chevron-right" title="Move right" disabled=${i === screens.length - 1} onClick=${() => onChange(moveItem(screens, i, i + 1))} />
          </div>
        </div>`;
      })}
    </div>
  <//>`;
}

// --- The builder ------------------------------------------------------------------------------------

// The live preview: the server evaluates the (unsaved) layout against Home
// Assistant, debounced while editing.
function usePreview(mac, layout) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api(`/api/viewports/${encodeURIComponent(mac)}/preview`, { method: 'POST', body: { layout } })
        .then((s) => {
          if (n !== seq.current) return;
          setState(s);
          setError('');
        })
        .catch((e) => n === seq.current && setError(e.message))
        .finally(() => n === seq.current && setLoading(false));
    }, 600);
    return () => clearTimeout(t);
  }, [mac, JSON.stringify(layout)]);
  return { state, error, loading };
}

const TABS = [
  { id: 'main', label: 'Main', icon: SCREEN_META.main.icon },
  { id: 'climate', label: 'Climate', icon: SCREEN_META.climate.icon },
  { id: 'presence', label: 'Presence', icon: SCREEN_META.presence.icon },
  { id: 'security', label: 'Security', icon: SCREEN_META.security.icon },
  { id: 'settings', label: 'Settings & import', icon: 'tune-variant' }
];

export function DashboardBuilder({ mac, layout, onChange, rooms, useDragOrder }) {
  const [tab, setTab] = useState('main');
  const preview = usePreview(mac, layout);
  const [lastScreen, setLastScreen] = useState('main');
  const screen = tab === 'settings' ? lastScreen : tab;
  const set = (k, v) => onChange({ ...layout, [k]: v });
  const setIn = (path, v) => {
    const next = structuredClone(layout);
    let o = next;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]] = v;
    onChange(next);
  };
  const props = { layout, set, setIn, rooms };
  const errors = preview.state && preview.state.errors ? Object.entries(preview.state.errors) : [];
  return html`<div class="stack">
    <${ScreensCard} screens=${layout.screens} onChange=${(s) => set('screens', s)} useDragOrder=${useDragOrder} />
    <${Card} icon="monitor-eye" title=${`Preview — ${SCREEN_META[screen].label}`} subtitle="Live from Home Assistant, with your unsaved changes."
      actions=${html`${preview.loading && html`<${Badge} icon="refresh">Updating<//>`}${errors.length > 0 && html`<${Badge} kind="warn" icon="alert-outline">${errors.length} couldn't load<//>`}`}>
      <${ViewportPreview} screen=${screen} state=${preview.state} error=${preview.error} loading=${preview.loading} />
      ${errors.length > 0 && html`<p class="hint">${errors.map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>`}
    <//>
    <nav class="tabs">
      ${TABS.map(
        (t) => html`<button type="button" class=${`tab ${t.id === tab ? 'active' : ''}`} onClick=${() => {
          setTab(t.id);
          if (t.id !== 'settings') setLastScreen(t.id);
        }}><${Icon} name=${t.icon} size=${18} />${t.label}</button>`
      )}
    </nav>
    ${tab === 'main' && html`<${MainTab} ...${props} />`}
    ${tab === 'climate' && html`<${ClimateTab} ...${props} />`}
    ${tab === 'presence' && html`<${PresenceTab} ...${props} />`}
    ${tab === 'security' && html`<${SecurityTab} ...${props} />`}
    ${tab === 'settings' && html`<${SettingsTab} ...${props} replace=${onChange} />`}
  </div>`;
}
