// A viewport's dashboard builder.
//
//   Carousel     how it moves between screens: stay put (buttons only), auto-
//                advance, or return to the first screen, every N minutes
//   Screens      the pages, as cards: drag to reorder, switch off, duplicate,
//                add (a sections screen, a meeting room, or a room finder —
//                the other rooms that are free)
//   The screen   its template (sidebar | two | three columns | single) and, per
//                column, its sections — any type, any order, each fully
//                configured — with a live preview beside it
//
// Everything here edits the layout lib/dashboard.js normalizes; the device
// page (clients.js) saves it.

import {
  html, useState, useEffect, useRef, api, Icon, Card, Field, TextInput, Select, Toggle, Button, Badge, useFlash, moveItem
} from './lib.js';
import { EntityPicker, IconPicker, useEntity } from './pickers.js';
import { ItemList } from './rooms.js';
import { ViewportPreview, PALETTE } from './viewport-preview.js';

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`);
const clone = (x) => structuredClone(x);

const CONDITIONS = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'is above' },
  { value: 'lt', label: 'is below' },
  { value: 'in', label: 'is one of' },
  { value: 'startsWith', label: 'starts with' }
];

// States an entity's domain can take, to suggest in rule editors.
const DOMAIN_STATES = {
  binary_sensor: ['on', 'off'],
  switch: ['on', 'off'],
  light: ['on', 'off'],
  fan: ['on', 'off'],
  input_boolean: ['on', 'off'],
  lock: ['locked', 'unlocked', 'locking', 'unlocking', 'jammed', 'open'],
  cover: ['open', 'closed', 'opening', 'closing'],
  alarm_control_panel: ['disarmed', 'armed_home', 'armed_away', 'armed_night', 'armed_vacation', 'arming', 'pending', 'triggered'],
  vacuum: ['cleaning', 'docked', 'idle', 'paused', 'returning', 'error'],
  lawn_mower: ['mowing', 'docked', 'paused', 'error'],
  person: ['home', 'not_home'],
  device_tracker: ['home', 'not_home'],
  media_player: ['playing', 'paused', 'idle', 'off', 'on'],
  climate: ['heat', 'cool', 'heat_cool', 'auto', 'off'],
  sun: ['above_horizon', 'below_horizon'],
  update: ['on', 'off']
};

export const SECTION_META = {
  weather: { label: 'Weather', icon: 'weather-partly-cloudy', about: 'Now, later and the next days' },
  energy: { label: 'Energy totals', icon: 'solar-power-variant', about: "Today's solar, use, import, export" },
  energyGraph: { label: 'Energy graph', icon: 'chart-bar', about: 'Solar and use vs forecast, grid import/export' },
  battery: { label: 'Home battery', icon: 'home-battery-outline', about: 'Charge, status, time to full' },
  statusIcons: { label: 'Status icons', icon: 'dots-horizontal-circle-outline', about: 'A row of icons that follow any entity' },
  alerts: { label: 'Alert lines', icon: 'alert-outline', about: '“Front door, Garage open”, or all clear' },
  calendar: { label: 'Calendar', icon: 'calendar-month-outline', about: 'Upcoming events' },
  heatPump: { label: 'Heat pump', icon: 'heat-pump-outline', about: 'Mode, outside, setpoint, COP' },
  roomClimate: { label: 'Room climate', icon: 'home-thermometer-outline', about: 'Each room against its target' },
  roomList: { label: 'Room temperatures', icon: 'thermometer-lines', about: 'Temperature and humidity by floor' },
  people: { label: 'People', icon: 'account-group-outline', about: 'Who is home' },
  media: { label: 'Now playing', icon: 'music-circle-outline', about: 'What each player is playing' },
  transport: { label: 'Departures', icon: 'bus-clock', about: 'Next departures, red when imminent' },
  alarm: { label: 'Alarm', icon: 'shield-home-outline', about: 'State, since, last armed/triggered' },
  openings: { label: 'Doors & windows', icon: 'door', about: 'Open (red) or closed' },
  motion: { label: 'Motion', icon: 'motion-sensor', about: 'Last motion, blue when recent' },
  cameras: { label: 'Cameras', icon: 'cctv', about: 'Last motion per camera' },
  now: { label: 'Now', icon: 'lightning-bolt-outline', about: 'What’s happening: alarm, heating, doors, robots…' },
  heating: { label: 'Heating', icon: 'radiator', about: 'Zones against their setpoints, hot water' },
  announcements: { label: 'Announcements', icon: 'bullhorn-outline', about: 'The latest from a company RSS or Atom feed' }
};

const TEMPLATES = [
  { value: 'sidebar', label: 'Sidebar + main', icon: 'page-layout-sidebar-left', columns: ['Sidebar', 'Main'] },
  { value: 'columns', label: 'Two columns', icon: 'view-column-outline', columns: ['Left', 'Right'] },
  { value: 'single', label: 'Single column', icon: 'view-agenda-outline', columns: ['Screen'] },
  { value: 'triple', label: 'Three columns', icon: 'view-parallel-outline', columns: ['Left', 'Middle', 'Right'] }
];
const GRID_COLUMNS = { sidebar: '1fr 1.6fr', columns: '1fr 1fr', single: '1fr', triple: '1fr 1fr 1fr' };

// A new section of each type, with sensible starting settings.
function newSection(type) {
  const base = { id: newId(), type, title: '' };
  switch (type) {
    case 'weather':
      return { ...base, entity: '', later: true, days: 2, hourlyEntity: '', rain: false, rainHours: 12, rainThresholdMm: 0.1, solarForecast: '' };
    case 'energyGraph':
      return {
        ...base,
        range: 'today',
        bucketMin: 60,
        ...Object.fromEntries(SERIES.map(([k]) => [k, { entity: '', kind: 'power' }])),
        forecast: { entity: '', attribute: '', unit: 'auto' },
        colors: { solar: 3, forecast: 5, fromSolar: 3, fromBattery: 5, fromGrid: 2, gridExport: 4 }
      };
    case 'battery':
      return { ...base, soc: '', status: '', eta: '', power: '', idleWatts: 100, chargeEta: '', dischargeEta: '', colors: { charging: 4, full: 4, discharging: 3, critical: 2, idle: 1 } };
    case 'statusIcons':
      return { ...base, icons: [] };
    case 'alerts':
      return { ...base, slots: [], maxLines: 6, allClear: 'All clear' };
    case 'calendar':
      return { ...base, entities: [], colors: {}, days: 7, lines: 4, today: false, timedFirst: false, descriptions: false };
    case 'roomClimate':
      return { ...base, rooms: [] };
    case 'roomList':
      return { ...base, rooms: [], byFloor: true };
    case 'people':
      return { ...base, people: [] };
    case 'media':
      return { ...base, players: [] };
    case 'transport':
      return { ...base, routes: [] };
    case 'openings':
      return { ...base, title: 'Doors', items: [], openColor: 2, closedColor: 4 };
    case 'motion':
      return { ...base, sensors: [] };
    case 'cameras':
      return { ...base, cameras: [] };
    case 'announcements':
      return { ...base, title: 'Announcements', url: '', count: 3, summary: true, maxAgeDays: 0, showDate: true, color: 1 };
    case 'now':
      return { ...base, title: 'Now', items: [] };
    case 'heating':
      return { ...base, entity: '', zones: [], hotWater: '', callingDelta: 0.5 };
    default:
      return base;
  }
}

function newScreen(kind) {
  if (kind === 'meetingRoom') {
    return {
      id: newId(), title: 'Meeting room', enabled: true, kind,
      meeting: {
        calendar: '', name: '', occupancy: '', hideTitles: false, soonMin: 10, emptyMin: 10, upcoming: 4,
        freeIcon: 'door-open', occupiedIcon: 'account-group', labels: { ...DEFAULT_LABELS.meeting }, timelineHours: 2,
        climate: { show: false, temperature: '', humidity: '', co2: '' }
      }
    };
  }
  if (kind === 'roomFinder') {
    return {
      id: newId(), title: 'Other rooms', enabled: true, kind,
      finder: { rooms: [], showBusy: true, soonMin: 10, emptyMin: 10, freeIcon: 'door-open', occupiedIcon: 'account-group', labels: { ...DEFAULT_LABELS.finder } }
    };
  }
  return { id: newId(), title: 'New screen', enabled: true, kind: 'sections', template: 'sidebar', columns: [[], []] };
}

// Fresh ids all the way down (duplicating a screen or section).
function reId(x) {
  if (Array.isArray(x)) return x.map(reId);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) out[k] = k === 'id' ? newId() : reId(v);
    return out;
  }
  return x;
}

// --- Small editors ----------------------------------------------------------------------

export function ColorPicker({ value, onChange, colors = [1, 2, 3, 4, 5] }) {
  return html`<div class="swatches">
    ${colors.map((i) => html`<button type="button" class=${`swatch ${value === i ? 'on' : ''}`} title=${PALETTE[i].name} style=${{ background: PALETTE[i].hex }} onClick=${() => onChange(i)}></button>`)}
  </div>`;
}

const CondSelect = ({ value, onChange }) => html`<${Select} value=${value} onChange=${onChange} options=${CONDITIONS} />`;

const NumberInput = ({ value, onChange, step = 1, min, max }) =>
  html`<input type="number" step=${step} min=${min} max=${max} value=${value ?? ''} onInput=${(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />`;

// A text box that suggests values (an entity's possible states).
let listSeq = 0;
function SuggestInput({ value, onInput, suggestions, placeholder }) {
  const idRef = useRef(`sg-${++listSeq}`);
  return html`<span style="display:contents">
    <input type="text" list=${idRef.current} value=${value || ''} placeholder=${placeholder} onInput=${(e) => onInput(e.target.value)} />
    <datalist id=${idRef.current}>${(suggestions || []).map((s) => html`<option value=${s} />`)}</datalist>
  </span>`;
}

// The values an entity (or one of its attributes) is likely to take.
function useStateSuggestions(entityId, attribute) {
  const e = useEntity(entityId);
  if (!e) return [];
  if (attribute) return [];
  const out = new Set([...(e.options || []), ...(DOMAIN_STATES[e.domain] || [])]);
  if (e.state) out.add(e.state);
  return [...out];
}

// "When the state is X: colour, icon, or hide" — first match wins.
function RuleList({ rules, onChange, entity, attribute, withIcon }) {
  const list = rules || [];
  const suggestions = useStateSuggestions(entity, attribute);
  const upd = (i, r) => onChange(list.map((x, j) => (j === i ? r : x)));
  return html`<div class="rules">
    ${list.map(
      (r, i) => html`<div class="rule">
        <span class="hint">when</span>
        <div style="width:110px"><${CondSelect} value=${r.cond} onChange=${(v) => upd(i, { ...r, cond: v })} /></div>
        <div style="flex:1;min-width:100px"><${SuggestInput} value=${r.value} placeholder="value" suggestions=${suggestions} onInput=${(v) => upd(i, { ...r, value: v })} /></div>
        ${withIcon && html`<${Toggle} checked=${r.hide} onChange=${(v) => upd(i, { ...r, hide: v })} label="Hide" />`}
        ${!r.hide && html`<${ColorPicker} value=${r.color} onChange=${(v) => upd(i, { ...r, color: v })} />`}
        ${withIcon && !r.hide && html`<${IconPicker} value=${r.icon} title="Icon for this state (optional)" onChange=${(v) => upd(i, { ...r, icon: v })} />`}
        <${Button} kind="ghost" small icon="tune-variant" title="On another entity, or with a second condition" onClick=${() => upd(i, { ...r, _more: !r._more })} />
        <${Button} kind="ghost" small icon="close" title="Remove rule" onClick=${() => onChange(list.filter((_, j) => j !== i))} />
      </div>
      ${(r._more || r.entity || r.also) &&
      html`<div class="rule rule-more">
        <span class="hint">reading</span>
        <div style="flex:1;min-width:160px"><${EntityPicker} value=${r.entity || ''} onChange=${(id) => upd(i, { ...r, entity: id })} /></div>
        <span class="hint">and also</span>
        <div style="flex:1;min-width:160px"><${EntityPicker} value=${(r.also && r.also.entity) || ''} onChange=${(id) => upd(i, { ...r, also: { cond: 'eq', value: '', attribute: '', ...(r.also || {}), entity: id } })} /></div>
        <div style="width:110px"><${TextInput} value=${(r.also && r.also.attribute) || ''} placeholder="attribute" onInput=${(v) => upd(i, { ...r, also: { cond: 'eq', value: '', entity: '', ...(r.also || {}), attribute: v } })} /></div>
        <div style="width:110px"><${CondSelect} value=${(r.also && r.also.cond) || 'eq'} onChange=${(v) => upd(i, { ...r, also: { value: '', entity: '', attribute: '', ...(r.also || {}), cond: v } })} /></div>
        <div style="width:90px"><${TextInput} value=${(r.also && r.also.value) || ''} placeholder="value" onInput=${(v) => upd(i, { ...r, also: { cond: 'eq', entity: '', attribute: '', ...(r.also || {}), value: v } })} /></div>
        ${r.also && html`<${Button} kind="ghost" small icon="close" title="No second condition" onClick=${() => upd(i, { ...r, also: null })} />`}
      </div>`}`
    )}
    <div><${Button} small icon="plus" disabled=${list.length >= 8} onClick=${() => onChange([...list, { cond: 'eq', value: suggestions[0] || 'on', color: 2, icon: '', hide: false }])}>Rule<//></div>
  </div>`;
}

// A list of {name, entity} rows.
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

// --- Section editors (one per type) -------------------------------------------------------------

const sensorField = (s, set, key, label, domains = ['sensor']) =>
  html`<${Field} label=${label}><${EntityPicker} domains=${domains} value=${s[key]} onChange=${(id) => set({ ...s, [key]: id })} /><//>`;

function WeatherEditor({ s, set }) {
  return html`<div class="row">${sensorField(s, set, 'entity', 'Weather entity', ['weather'])}${sensorField(s, set, 'hourlyEntity', 'Hourly forecast from (optional)', ['weather'])}</div>
    <div class="row" style="align-items:center">
      <${Toggle} checked=${s.later} onChange=${(v) => set({ ...s, later: v })} label="“Later” (about 3 hours out)" />
      <div style="width:130px"><${Field} label="Days ahead"><${NumberInput} min="0" max="5" value=${s.days} onChange=${(v) => set({ ...s, days: v })} /><//></div>
    </div>
    <div class="row" style="align-items:flex-end">
      <${Toggle} checked=${s.rain} onChange=${(v) => set({ ...s, rain: v })} label="Rain outlook (“Rain at 14:00”)" />
      ${s.rain &&
      html`<div style="width:130px"><${Field} label="Hours ahead"><${NumberInput} min="1" max="24" value=${s.rainHours} onChange=${(v) => set({ ...s, rainHours: v })} /><//></div>
        <div style="width:170px"><${Field} label="Wet above (mm/h)"><${NumberInput} step="0.1" min="0" value=${s.rainThresholdMm} onChange=${(v) => set({ ...s, rainThresholdMm: v })} /><//></div>`}
    </div>
    ${sensorField(s, set, 'solarForecast', 'Solar forecast today (shown when dry, optional)')}`;
}

function EnergyEditor({ s, set }) {
  return html`<div class="chips">
      ${[['grid', 'Tiles (2 × 2)', 'view-grid-outline'], ['list', 'List (for a sidebar)', 'format-list-bulleted']].map(
        ([v, label, icon]) => html`<button type="button" class=${`chip ${s.style === v ? 'on' : ''}`} onClick=${() => set({ ...s, style: v })}><${Icon} name=${icon} size=${15} />${label}</button>`
      )}
    </div>
    <div class="row">${sensorField(s, set, 'solarToday', 'Solar today')}${sensorField(s, set, 'solarExpected', 'Solar forecast today')}</div>
    <div class="row">${sensorField(s, set, 'loadToday', 'Used today')}${sensorField(s, set, 'gridExport', 'Exported today')}</div>
    ${sensorField(s, set, 'gridImport', 'Imported today')}`;
}

const SERIES = [
  ['solar', 'Solar production', ''],
  ['load', 'House consumption', ''],
  ['gridImport', 'Grid import', ''],
  ['gridExport', 'Grid export', ''],
  ['batteryCharge', 'Battery charging', 'Optional.'],
  ['batteryDischarge', 'Battery discharging', 'Optional: without it, use that solar didn’t cover counts as from the battery.']
];

const GRAPH_COLORS = [
  ['solar', 'Actual solar (top bars)'],
  ['forecast', 'Predicted solar (top line)'],
  ['fromSolar', 'Use from solar'],
  ['fromBattery', 'Use from battery'],
  ['fromGrid', 'Use from grid'],
  ['gridExport', 'Export (below the line)']
];

function EnergyGraphEditor({ s, set }) {
  const fc = useEntity(s.forecast.entity);
  const attrs = (fc && fc.attributes) || [];
  return html`<div class="row">
      <${Field} label="Range"><${Select} value=${s.range} onChange=${(v) => set({ ...s, range: v })} options=${[{ value: 'today', label: 'Today (midnight to midnight)' }, { value: '24h', label: 'Last 24 hours' }]} /><//>
      <${Field} label="Bars every"><${Select} value=${String(s.bucketMin)} onChange=${(v) => set({ ...s, bucketMin: Number(v) })} options=${[{ value: '60', label: 'Hour' }, { value: '30', label: '30 minutes' }, { value: '15', label: '15 minutes' }]} /><//>
    </div>
    <p class="hint">Top panel: actual solar against the prediction. Bottom panel: what the house used, stacked by where it came from (grid, battery, solar), with export to the grid below the line.</p>
    ${SERIES.map(
      ([k, label, hint]) => html`<div class="row" style="align-items:flex-end">
        <${Field} label=${label} hint=${hint}><${EntityPicker} domains=${['sensor']} value=${s[k].entity} onChange=${(id, e) => set({ ...s, [k]: { ...s[k], entity: id, kind: e && e.unit && /Wh$/.test(e.unit) ? 'energy' : e && e.unit && /W$/.test(e.unit) ? 'power' : s[k].kind } })} /><//>
        <div style="width:190px"><${Field} label="It measures"><${Select} value=${s[k].kind} onChange=${(v) => set({ ...s, [k]: { ...s[k], kind: v } })} options=${[{ value: 'power', label: 'Power (W / kW)' }, { value: 'energy', label: 'Energy meter (kWh)' }]} /><//></div>
      </div>`
    )}
    <div class="row" style="align-items:flex-end">
      <${Field} label="Solar forecast" hint="An entity holding an hourly forecast in an attribute (Solcast, Open-Meteo Solar Forecast…).">
        <${EntityPicker} domains=${['sensor']} value=${s.forecast.entity} onChange=${(id) => set({ ...s, forecast: { ...s.forecast, entity: id } })} />
      <//>
      <div style="width:170px"><${Field} label="Attribute"><${SuggestInput} value=${s.forecast.attribute} placeholder="detailedForecast" suggestions=${attrs} onInput=${(v) => set({ ...s, forecast: { ...s.forecast, attribute: v } })} /><//></div>
      <div style="width:110px"><${Field} label="Unit"><${Select} value=${s.forecast.unit} onChange=${(v) => set({ ...s, forecast: { ...s.forecast, unit: v } })} options=${[{ value: 'auto', label: 'Auto' }, { value: 'kW', label: 'kW' }, { value: 'W', label: 'W' }]} /><//></div>
    </div>
    <${Field} label="Colours">
      ${GRAPH_COLORS.map(([k, label]) => html`<div class="row" style="align-items:center"><span style="width:200px">${label}</span><${ColorPicker} value=${s.colors[k]} onChange=${(v) => set({ ...s, colors: { ...s.colors, [k]: v } })} /></div>`)}
    <//>`;
}

function BatteryEditor({ s, set }) {
  return html`<div class="row">${sensorField(s, set, 'soc', 'Charge %')}${sensorField(s, set, 'status', 'Status')}</div>
    ${sensorField(s, set, 'eta', 'Time to full/empty')}
    <p class="hint">Or work the status out from a power sensor (negative while charging) — then the two times come from timestamp sensors.</p>
    <div class="row">
      ${sensorField(s, set, 'power', 'Battery power (W)')}
      <div style="width:150px"><${Field} label="Idle within ± W"><${NumberInput} min="0" value=${s.idleWatts} onChange=${(v) => set({ ...s, idleWatts: v })} /><//></div>
    </div>
    ${s.power && html`<div class="row">${sensorField(s, set, 'chargeEta', 'Full at')}${sensorField(s, set, 'dischargeEta', 'Empty at')}</div>`}
    <${Field} label="Colours" hint="Critical is at or below the critical threshold (Carousel & settings).">
      ${[['charging', 'Charging'], ['full', 'Full'], ['discharging', 'Discharging'], ['critical', 'Critical'], ['idle', 'Idle']].map(
        ([k, label]) => html`<div class="row" style="align-items:center"><span style="width:100px">${label}</span><${ColorPicker} value=${s.colors[k]} onChange=${(v) => set({ ...s, colors: { ...s.colors, [k]: v } })} /></div>`
      )}
    <//>`;
}

function StatusIconEditor({ it, upd }) {
  const e = useEntity(it.entity);
  return html`<div class="row">
      <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
      <${Field} label="Entity"><${EntityPicker} value=${it.entity} onChange=${(id, x) => upd({ ...it, entity: id, name: it.name || (x && x.name) || '', icon: it.icon || (x && x.icon) || '' })} /><//>
      <div style="width:150px"><${Field} label="Attribute (optional)"><${SuggestInput} value=${it.attribute} placeholder="state" suggestions=${(e && e.attributes) || []} onInput=${(v) => upd({ ...it, attribute: v })} /><//></div>
      <div style="width:150px"><${Field} label="Label"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//></div>
    </div>
    <${Field} label="Also follows (optional)" hint="A rule then matches when any of these does — “a door is open”.">
      <${ItemList}
        items=${(it.entities || []).map((x, i) => ({ id: String(i), entity: x }))}
        onChange=${(l) => upd({ ...it, entities: l.map((x) => x.entity) })}
        max=${12}
        addLabel="Add entity"
        newItem=${() => ({ id: newId(), entity: '' })}
        render=${(x, u) => html`<${EntityPicker} value=${x.entity} onChange=${(id) => u({ ...x, entity: id })} />`}
      />
    <//>
    <div class="row" style="align-items:center">
      <${Toggle} checked=${it.showByDefault} onChange=${(v) => upd({ ...it, showByDefault: v })} label="Show when no rule matches" />
      ${it.showByDefault && html`<span class="hint">in</span><${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} />`}
    </div>
    <${RuleList} rules=${it.rules} onChange=${(r) => upd({ ...it, rules: r })} entity=${it.entity} attribute=${it.attribute} withIcon />`;
}

function StatusIconsEditor({ s, set, presets }) {
  const add = (key) => {
    const p = (presets || {})[key] || { name: '', icon: '', rules: [] };
    const icon = { id: newId(), name: p.name, entity: '', entities: [], attribute: '', icon: p.icon, color: 1, showByDefault: p.showByDefault !== false, rules: clone(p.rules || []).map((r) => ({ icon: '', hide: false, ...r })) };
    set({ ...s, icons: [...s.icons, icon] });
  };
  return html`<${ItemList}
      items=${s.icons}
      onChange=${(l) => set({ ...s, icons: l })}
      max=${12}
      addLabel="Blank icon"
      newItem=${() => ({ id: newId(), name: '', entity: '', entities: [], attribute: '', icon: '', color: 1, showByDefault: true, rules: [] })}
      render=${(it, upd) => html`<${StatusIconEditor} it=${it} upd=${upd} />`}
    />
    ${presets &&
    html`<div class="row" style="align-items:center">
      <span class="hint">Or start from:</span>
      ${Object.entries(presets).map(([k, p]) => html`<button type="button" class="chip" disabled=${s.icons.length >= 12} onClick=${() => add(k)}><${Icon} name=${p.icon} size=${15} />${p.name}</button>`)}
    </div>`}`;
}

function AlertsEditor({ s, set }) {
  return html`<${ItemList}
      items=${s.slots}
      onChange=${(l) => set({ ...s, slots: l })}
      max=${12}
      addLabel="Add alert"
      newItem=${() => ({ id: newId(), enabled: true, suffix: 'open', cond: 'eq', value: 'on', color: 2, entities: [] })}
      render=${(it, upd) => html`<${AlertSlot} it=${it} upd=${upd} />`}
    />
    <div class="row">
      <div style="width:140px"><${Field} label="Lines at most"><${NumberInput} min="1" max="10" value=${s.maxLines} onChange=${(v) => set({ ...s, maxLines: v })} /><//></div>
      <${Field} label="When nothing matches"><${TextInput} value=${s.allClear} onInput=${(v) => set({ ...s, allClear: v })} /><//>
    </div>`;
}

function AlertSlot({ it, upd }) {
  const suggestions = useStateSuggestions(it.entities[0] && it.entities[0].entity);
  return html`<div class="row" style="align-items:center">
      <${Toggle} checked=${it.enabled} onChange=${(v) => upd({ ...it, enabled: v })} />
      <span class="hint">when</span>
      <div style="width:110px"><${CondSelect} value=${it.cond} onChange=${(v) => upd({ ...it, cond: v })} /></div>
      <div style="width:120px"><${SuggestInput} value=${it.value} placeholder="value" suggestions=${suggestions} onInput=${(v) => upd({ ...it, value: v })} /></div>
      <span class="hint">show “… </span>
      <div style="width:110px"><${TextInput} value=${it.suffix} placeholder="open" onInput=${(v) => upd({ ...it, suffix: v })} /></div>
      <span class="hint">” in</span>
      <${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} />
    </div>
    <${NamedList} items=${it.entities.map((e, i) => ({ id: String(i), ...e }))} max=${8} addLabel="Add entity"
      onChange=${(l) => upd({ ...it, entities: l.map(({ entity, name }) => ({ entity, name })) })} />`;
}

// A feed address, and a check that reads it now.
function AnnouncementsEditor({ s, set }) {
  const [check, setCheck] = useState(null);
  const run = async () => {
    setCheck({ busy: true });
    try {
      setCheck(await api('/api/feeds/check', { method: 'POST', body: { url: s.url } }));
    } catch (e) {
      setCheck({ error: e.message });
    }
  };
  return html`<${Field} label="Feed address" hint="An RSS or Atom feed: an intranet news page, a SharePoint or WordPress site, a blog…">
      <div class="row" style="align-items:center">
        <div style="flex:1"><${TextInput} value=${s.url} placeholder="https://intranet.example.com/news/feed" onInput=${(v) => { set({ ...s, url: v }); setCheck(null); }} /></div>
        <${Button} icon="rss" disabled=${!s.url || (check && check.busy)} onClick=${run}>${check && check.busy ? 'Checking…' : 'Check feed'}<//>
      </div>
    <//>
    ${check && check.error && html`<p class="hint text-bad"><${Icon} name="alert-circle-outline" size=${16} /> ${check.error}</p>`}
    ${check && check.count != null &&
    html`<p class="hint"><${Icon} name="check-circle-outline" size=${16} /> ${check.count} item${check.count === 1 ? '' : 's'}${check.latest.length ? ', newest:' : ''}</p>
      <ul class="hint">${check.latest.map((it) => html`<li>${it.title}${it.date ? ` (${new Date(it.date).toLocaleDateString()})` : ''}</li>`)}</ul>`}
    <div class="row">
      <${Field} label="Items shown"><${NumberInput} min="1" max="6" value=${s.count} onChange=${(v) => set({ ...s, count: v })} /><//>
      <${Field} label="Hide items older than" hint="Days; 0 = never"><${NumberInput} min="0" max="365" value=${s.maxAgeDays} onChange=${(v) => set({ ...s, maxAgeDays: v })} /><//>
    </div>
    <div class="row" style="align-items:center">
      <${Toggle} checked=${s.summary} onChange=${(v) => set({ ...s, summary: v })} label="Summary under each headline" />
      <${Toggle} checked=${s.showDate} onChange=${(v) => set({ ...s, showDate: v })} label="When it was posted" />
      <span class="hint">Headlines in</span><${ColorPicker} value=${s.color} onChange=${(v) => set({ ...s, color: v })} />
    </div>
    <p class="hint">The server reads the feed (every 10 minutes at most) and the panel shows the newest items at its next wake.</p>`;
}

function CalendarEditor({ s, set }) {
  const colors = s.colors || {};
  return html`<${ItemList}
      items=${s.entities.map((x, i) => ({ id: String(i), entity: x, color: colors[x] || 1 }))}
      onChange=${(l) => set({ ...s, entities: l.map((x) => x.entity), colors: Object.fromEntries(l.filter((x) => x.entity).map((x) => [x.entity, x.color || 1])) })}
      max=${8}
      addLabel="Add calendar"
      newItem=${() => ({ id: newId(), entity: '', color: 1 })}
      render=${(it, upd) => html`<div class="row" style="align-items:center">
        <div style="flex:1"><${EntityPicker} domains=${['calendar']} value=${it.entity} onChange=${(id) => upd({ ...it, entity: id })} /></div>
        <${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} />
      </div>`}
    />
    <div class="row" style="align-items:center">
      <${Toggle} checked=${s.today} onChange=${(v) => set({ ...s, today: v })} label="Today only (including earlier today)" />
      <${Toggle} checked=${s.timedFirst} onChange=${(v) => set({ ...s, timedFirst: v })} label="Timed events before all-day" />
      <${Toggle} checked=${s.descriptions} onChange=${(v) => set({ ...s, descriptions: v })} label="Description under each" />
    </div>
    <div class="row">
      ${!s.today && html`<${Field} label="Days ahead"><${NumberInput} min="1" max="31" value=${s.days} onChange=${(v) => set({ ...s, days: v })} /><//>`}
      <${Field} label="Lines at most"><${NumberInput} min="1" max="20" value=${s.lines} onChange=${(v) => set({ ...s, lines: v })} /><//>
      <${Field} label="Lines while a conditional section shows" hint="Makes room for e.g. Now playing in the same column. 0 = keep them all.">
        <${NumberInput} min="0" max="8" value=${s.shrinkTo ?? 2} onChange=${(v) => set({ ...s, shrinkTo: v })} />
      <//>
    </div>`;
}

function HeatPumpEditor({ s, set }) {
  return html`${sensorField(s, set, 'entity', 'Heat pump', ['climate'])}
    <div class="row">${sensorField(s, set, 'outsideTemperature', 'Outside temperature', ['sensor', 'weather'])}${sensorField(s, set, 'cop', 'COP (optional)')}</div>`;
}

function RoomsEditor({ s, set, ctx, withTarget }) {
  const [busy, setBusy] = useState(false);
  // One row per Switchboard room: its thermostat and main temperature sensor.
  const fromRooms = async () => {
    setBusy(true);
    try {
      const have = new Set(s.rooms.map((r) => r.name.toLowerCase()));
      const added = [];
      for (const r of ctx.rooms || []) {
        if (have.has(r.name.toLowerCase())) continue;
        const p = await api(`/api/devices/${encodeURIComponent(r.slug)}/config`);
        const climate = (p.standby && p.standby.climateEntity) || '';
        const temperature = (p.climate && p.climate.entity) || '';
        if (!climate && !temperature) continue;
        added.push({ id: newId(), name: r.name, icon: 'sofa-outline', floor: 'downstairs', temperature, humidity: '', climate, target: null });
      }
      set({ ...s, rooms: [...s.rooms, ...added].slice(0, 12) });
    } finally {
      setBusy(false);
    }
  };
  // Other sections in this layout that list rooms, to copy from.
  const others = ctx.allSections.filter((x) => x.id !== s.id && (x.type === 'roomClimate' || x.type === 'roomList') && x.rooms.length);
  return html`<div class="row" style="align-items:center">
      <${Button} small icon="import" disabled=${busy || !(ctx.rooms && ctx.rooms.length)} onClick=${fromRooms}>From Switchboard rooms<//>
      ${others.length > 0 &&
      html`<${Select} value="" onChange=${(v) => {
        const src = others.find((o) => o.id === v);
        if (src) set({ ...s, rooms: reId(src.rooms) });
      }} options=${[{ value: '', label: 'Copy rooms from…' }, ...others.map((o) => ({ value: o.id, label: `${o.title || SECTION_META[o.type].label} (${o.rooms.length})` }))]} />`}
      ${s.type === 'roomList' && html`<${Toggle} checked=${s.byFloor} onChange=${(v) => set({ ...s, byFloor: v })} label="Group by floor" />`}
    </div>
    <${ItemList}
      items=${s.rooms}
      onChange=${(l) => set({ ...s, rooms: l })}
      max=${12}
      addLabel="Add room"
      newItem=${() => ({ id: newId(), name: '', icon: '', floor: 'downstairs', temperature: '', humidity: '', climate: '', target: withTarget ? 21 : null })}
      render=${(it, upd) => html`<div class="row">
          <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
          <${Field} label="Name"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
          <div style="width:140px"><${Field} label="Floor"><${Select} value=${it.floor} onChange=${(v) => upd({ ...it, floor: v })} options=${[{ value: 'upstairs', label: 'Upstairs' }, { value: 'downstairs', label: 'Downstairs' }]} /><//></div>
        </div>
        <div class="row">
          <${Field} label="Temperature"><${EntityPicker} domains=${['sensor']} value=${it.temperature} onChange=${(id, e) => upd({ ...it, temperature: id, name: it.name || (e && e.name) || '' })} /><//>
          <${Field} label="Humidity"><${EntityPicker} domains=${['sensor']} value=${it.humidity} onChange=${(id) => upd({ ...it, humidity: id })} /><//>
        </div>
        ${withTarget &&
        html`<div class="row">
          <${Field} label="Thermostat (optional)" hint="Gives the target and whether it's calling for heat."><${EntityPicker} domains=${['climate']} value=${it.climate} onChange=${(id) => upd({ ...it, climate: id })} /><//>
          <div style="width:150px"><${Field} label="Fixed target °" hint="Without a thermostat."><${NumberInput} step="0.5" value=${it.target} onChange=${(v) => upd({ ...it, target: v })} /><//></div>
        </div>`}`}
    />`;
}

function TransportEditor({ s, set }) {
  return html`<${ItemList}
    items=${s.routes}
    onChange=${(l) => set({ ...s, routes: l })}
    max=${4}
    addLabel="Add route"
    newItem=${() => ({ id: newId(), name: '', stop: '', icon: 'bus', color: 4, departure1: '', departure2: '' })}
    render=${(it, upd) => html`<div class="row">
        <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
        <${Field} label="Route"><${TextInput} value=${it.name} placeholder="42 · City Centre" onInput=${(v) => upd({ ...it, name: v })} /><//>
        <${Field} label="Stop"><${TextInput} value=${it.stop} placeholder="High Street" onInput=${(v) => upd({ ...it, stop: v })} /><//>
        <${Field} label="Colour"><${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} /><//>
      </div>
      <div class="row">
        <${Field} label="Next departure" hint="A time, timestamp or minutes."><${EntityPicker} domains=${['sensor']} value=${it.departure1} onChange=${(id) => upd({ ...it, departure1: id })} /><//>
        <${Field} label="The one after"><${EntityPicker} domains=${['sensor']} value=${it.departure2} onChange=${(id) => upd({ ...it, departure2: id })} /><//>
      </div>`}
  />`;
}

function AlarmEditor({ s, set }) {
  return html`${sensorField(s, set, 'entity', 'Alarm panel', ['alarm_control_panel'])}
    <${Toggle} checked=${s.summary} onChange=${(v) => set({ ...s, summary: v })} label="Summary under it (doors, windows, motion and cameras on this screen)" />
    <p class="hint">Optional: a timestamp sensor (or any entity that changes when it happens) for each of these.</p>
    <div class="row">${sensorField(s, set, 'lastArmed', 'Last armed', [])}${sensorField(s, set, 'lastDisarmed', 'Last disarmed', [])}</div>
    ${sensorField(s, set, 'lastTriggered', 'Last triggered', [])}`;
}

function OpeningsEditor({ s, set }) {
  return html`<${NamedList} items=${s.items} onChange=${(l) => set({ ...s, items: l })} domains=${['binary_sensor', 'cover', 'lock']} max=${10} addLabel="Add door or window" />
    <div class="row" style="align-items:center">
      <span style="width:70px">Open</span><${ColorPicker} value=${s.openColor} onChange=${(v) => set({ ...s, openColor: v })} />
      <span style="width:70px;margin-left:16px">Closed</span><${ColorPicker} value=${s.closedColor} onChange=${(v) => set({ ...s, closedColor: v })} />
    </div>`;
}

// "Now": one item per thing that can be happening, each a kind that words
// itself — the alarm always shows; the rest only while active.
const NOW_KINDS = [
  { value: 'alarm', label: 'Alarm', icon: 'shield-check' },
  { value: 'heating', label: 'Heating zones calling', icon: 'radiator' },
  { value: 'hotWater', label: 'Hot water heating', icon: 'water-boiler' },
  { value: 'openings', label: 'Doors or windows open', icon: 'door-open' },
  { value: 'plants', label: 'Plants need water', icon: 'watering-can' },
  { value: 'robot', label: 'Vacuum or mower working', icon: 'robot-vacuum' },
  { value: 'entity', label: 'Any entity', icon: 'alert' }
];
const NOW_HINT = 'Words can use {n} (how many), {names}, {state}, {battery}, {name}.';

function NowItemEditor({ it, upd }) {
  const kind = NOW_KINDS.find((k) => k.value === it.kind) || NOW_KINDS[6];
  const field = (key, label, domains) => html`<${Field} label=${label}><${EntityPicker} domains=${domains} value=${it[key]} onChange=${(id, e) => upd({ ...it, [key]: id, name: it.name || (key === 'entity' && e && e.name) || '' })} /><//>`;
  const words = (withMany) => html`<div class="row">
      <${Field} label=${withMany ? 'Title (one)' : 'Title'}><${TextInput} value=${it.title} onInput=${(v) => upd({ ...it, title: v })} /><//>
      ${withMany && html`<${Field} label="Title (several)"><${TextInput} value=${it.titleMany} placeholder="{n} open" onInput=${(v) => upd({ ...it, titleMany: v })} /><//>`}
      <${Field} label="Second line" hint=${NOW_HINT}><${TextInput} value=${it.detail} onInput=${(v) => upd({ ...it, detail: v })} /><//>
    </div>`;
  return html`<div class="row" style="align-items:flex-end">
      <${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />
      <div style="width:230px"><${Field} label="Kind"><${Select} value=${it.kind} onChange=${(v) => upd({ ...it, kind: v, icon: (NOW_KINDS.find((k) => k.value === v) || kind).icon })} options=${NOW_KINDS} /><//></div>
      ${it.kind !== 'alarm' && html`<${Field} label="Colour"><${ColorPicker} value=${it.color} onChange=${(v) => upd({ ...it, color: v })} /><//>`}
    </div>
    ${it.kind === 'alarm' &&
    html`<div class="row">${field('entity', 'Alarm state', [])}${field('eventEntity', 'Last event message (optional)', ['sensor'])}</div>
      <p class="hint">“Alarm disarmed” (green), “Alarm part set” or “Alarm armed” (red), with the last event under it.</p>`}
    ${it.kind === 'heating' &&
    html`<${NamedList} items=${it.items} onChange=${(l) => upd({ ...it, items: l })} domains=${['climate']} max=${10} addLabel="Add zone" />
      <div style="width:220px"><${Field} label="Calling when below setpoint by more than °"><${NumberInput} step="0.1" min="0" value=${it.callingDelta} onChange=${(v) => upd({ ...it, callingDelta: v })} /><//></div>
      ${words(false)}`}
    ${it.kind === 'hotWater' && html`${field('entity', 'Water heater', ['water_heater'])}${words(false)}`}
    ${it.kind === 'openings' &&
    html`<${NamedList} items=${it.items} onChange=${(l) => upd({ ...it, items: l })} domains=${['binary_sensor', 'cover', 'lock']} max=${10} addLabel="Add door or window" />
      <div style="width:240px"><${Field} label="Names"><${Select} value=${it.join} onChange=${(v) => upd({ ...it, join: v })} options=${[{ value: 'list', label: 'Kitchen, Side' }, { value: 'and', label: 'Front & back' }]} /><//></div>
      ${words(true)}`}
    ${it.kind === 'plants' &&
    html`<${NamedList} items=${it.items} onChange=${(l) => upd({ ...it, items: l })} domains=${['sensor', 'plant', 'binary_sensor']} max=${10} addLabel="Add plant" />
      <div style="width:220px"><${Field} label="Needs water when it contains"><${TextInput} value=${it.value} onInput=${(v) => upd({ ...it, value: v })} /><//></div>
      ${words(true)}`}
    ${it.kind === 'robot' &&
    html`<div class="row">${field('entity', 'Vacuum or mower', ['vacuum', 'lawn_mower'])}${field('battery', 'Battery %', ['sensor'])}</div>
      <div class="row">
        <div style="width:160px"><${Field} label="Working when"><${TextInput} value=${it.value} placeholder="cleaning" onInput=${(v) => upd({ ...it, value: v })} /><//></div>
        <${Field} label="Name"><${TextInput} value=${it.name} onInput=${(v) => upd({ ...it, name: v })} /><//>
      </div>
      ${words(false)}`}
    ${it.kind === 'entity' &&
    html`<div class="row" style="align-items:flex-end">
        ${field('entity', 'Entity', [])}
        <div style="width:120px"><${Field} label="Attribute"><${TextInput} value=${it.attribute} placeholder="state" onInput=${(v) => upd({ ...it, attribute: v })} /><//></div>
        <div style="width:110px"><${Field} label="Is"><${CondSelect} value=${it.cond} onChange=${(v) => upd({ ...it, cond: v })} /><//></div>
        <div style="width:110px"><${Field} label="Value"><${TextInput} value=${it.value} onInput=${(v) => upd({ ...it, value: v })} /><//></div>
      </div>
      ${words(false)}`}`;
}

function NowEditor({ s, set }) {
  return html`<${ItemList}
    items=${s.items}
    onChange=${(l) => set({ ...s, items: l })}
    max=${12}
    addLabel="Add item"
    newItem=${() => ({ id: newId(), kind: 'entity', name: '', icon: 'alert', color: 2, title: '{name}', titleMany: '', detail: '{state}', entity: '', eventEntity: '', battery: '', attribute: '', cond: 'eq', value: 'on', items: [], join: 'list', callingDelta: 0.5, maxChars: 50 })}
    render=${(it, upd) => html`<${NowItemEditor} it=${it} upd=${upd} />`}
  />`;
}

function HeatingEditor({ s, set }) {
  return html`<div class="row">${sensorField(s, set, 'entity', 'Whole house (optional)', ['climate'])}${sensorField(s, set, 'hotWater', 'Hot water (optional)', ['water_heater'])}</div>
    <${NamedList} items=${s.zones} onChange=${(l) => set({ ...s, zones: l })} domains=${['climate']} max=${16} addLabel="Add zone" />
    <div style="width:260px"><${Field} label="Calling when below setpoint by more than °" hint="In heat or auto."><${NumberInput} step="0.1" min="0" value=${s.callingDelta} onChange=${(v) => set({ ...s, callingDelta: v })} /><//></div>`;
}

const EDITORS = {
  now: NowEditor,
  heating: HeatingEditor,
  weather: WeatherEditor,
  energy: EnergyEditor,
  energyGraph: EnergyGraphEditor,
  battery: BatteryEditor,
  statusIcons: StatusIconsEditor,
  alerts: AlertsEditor,
  calendar: CalendarEditor,
  announcements: AnnouncementsEditor,
  heatPump: HeatPumpEditor,
  roomClimate: (p) => html`<${RoomsEditor} ...${p} withTarget />`,
  roomList: (p) => html`<${RoomsEditor} ...${p} />`,
  people: ({ s, set }) => html`<${NamedList} items=${s.people} onChange=${(l) => set({ ...s, people: l })} domains=${['person', 'device_tracker']} max=${8} addLabel="Add person" />`,
  media: ({ s, set }) =>
    html`<${NamedList} items=${s.players} onChange=${(l) => set({ ...s, players: l })} domains=${['media_player']} max=${3} addLabel="Add player"
      extra=${(it, upd) => html`<${IconPicker} value=${it.icon} onChange=${(icon) => upd({ ...it, icon })} />`} />`,
  transport: TransportEditor,
  alarm: AlarmEditor,
  openings: OpeningsEditor,
  motion: ({ s, set }) => html`<${NamedList} items=${s.sensors} onChange=${(l) => set({ ...s, sensors: l })} domains=${['binary_sensor']} max=${10} addLabel="Add sensor" />`,
  cameras: ({ s, set }) => html`<${NamedList} items=${s.cameras} onChange=${(l) => set({ ...s, cameras: l })} domains=${['binary_sensor', 'sensor', 'camera', 'event']} max=${10} addLabel="Add camera" />`
};

// Sections whose content changes on its own. A viewport runs on battery,
// so they only update when it wakes.
const WAKE_ONLY = {
  media: 'What’s playing changes on its own.',
  transport: 'Departures count down on their own.'
};

// When a section shows: always, while its players play (Now playing), or while
// an entity matches — and how often the display wakes while it's showing.
const LIVE_CHOICES = [0, 1, 2, 3, 5, 10, 15, 30].map((n) => ({ value: String(n), label: n ? `Every ${n} min while it shows` : 'Only when the display wakes anyway' }));

function ShowWhenEditor({ s, set }) {
  const w = s.showWhen || { mode: 'always', entity: '', cond: 'eq', value: '', liveMin: 0 };
  const put = (patch) => {
    const next = { ...w, ...patch };
    if (patch.mode && patch.mode !== 'always' && w.mode === 'always' && !w.liveMin) next.liveMin = 3;
    set({ ...s, showWhen: next });
  };
  const modes = [
    { value: 'always', label: 'Always' },
    ...(s.type === 'media' ? [{ value: 'playing', label: 'Only while something is playing' }] : []),
    { value: 'entity', label: 'Only when an entity…' }
  ];
  return html`<div class="show-when">
    <${Field} label="Show" hint=${w.mode === 'always' ? 'A conditional section appears only when its condition holds; the rest of its column makes room for it.' : ''}>
      <${Select} value=${w.mode} onChange=${(v) => put({ mode: v })} options=${modes} />
    <//>
    ${w.mode === 'entity' &&
    html`<div class="row" style="align-items:flex-end">
      <${Field} label="Entity"><${EntityPicker} value=${w.entity} onChange=${(id) => put({ entity: id })} /><//>
      <div style="width:130px"><${Field} label="Is"><${CondSelect} value=${w.cond} onChange=${(v) => put({ cond: v })} /><//></div>
      <div style="width:160px"><${Field} label="Value"><${TextInput} value=${w.value} placeholder="on" onInput=${(v) => put({ value: v })} /><//></div>
    </div>`}
    ${w.mode !== 'always' &&
    html`<${Field} label="While it shows" hint="The display wakes this often while the section is up, and goes back to its normal refresh when it's gone. It appears at the next wake after the condition starts.">
      <${Select} value=${String(w.liveMin ?? 3)} onChange=${(v) => put({ liveMin: Number(v) })} options=${LIVE_CHOICES} />
    <//>`}
  </div>`;
}

// --- A section, as a collapsible card ---------------------------------------------------------------

function SectionCard({ s, set, remove, duplicate, move, moveColumn, columnLabels, colIndex, open, onToggle, ctx }) {
  const meta = SECTION_META[s.type];
  const Editor = EDITORS[s.type];
  return html`<section class=${`card section-card ${open ? 'open' : ''}`}>
    <header class="card-head" onClick=${onToggle} style="cursor:pointer;padding-bottom:12px">
      <div class="card-icon"><${Icon} name=${meta.icon} size=${20} /></div>
      <div class="card-titles"><h2>${s.title || meta.label}${s.showWhen && s.showWhen.mode !== 'always' && html` <${Badge} kind="accent" icon="eye-outline">${s.showWhen.mode === 'playing' ? 'While playing' : 'Conditional'}<//>`}</h2><p class="hint">${s.title ? meta.label : meta.about}</p></div>
      <div class="card-actions" onClick=${(e) => e.stopPropagation()}>
        <${Button} kind="ghost" small icon="chevron-up" title="Move up" disabled=${!move.up} onClick=${move.up} />
        <${Button} kind="ghost" small icon="chevron-down" title="Move down" disabled=${!move.down} onClick=${move.down} />
        ${columnLabels.length > 1 &&
        html`<${Button} kind="ghost" small icon=${colIndex < columnLabels.length - 1 ? 'arrow-right' : 'arrow-left'} title=${`Move to ${columnLabels[(colIndex + 1) % columnLabels.length]}`} onClick=${moveColumn} />`}
        <${Button} kind="ghost" small icon="content-copy" title="Duplicate" onClick=${duplicate} />
        <${Button} kind="ghost" small icon="trash-can-outline" title="Remove" onClick=${remove} />
      </div>
      <${Icon} name=${open ? 'chevron-up' : 'chevron-down'} size=${20} />
    </header>
    ${open &&
    html`<div class="card-body">
      ${WAKE_ONLY[s.type] && !(s.showWhen && s.showWhen.mode !== 'always' && s.showWhen.liveMin) &&
      html`<p class="hint wake-note"><${Icon} name="battery-clock-outline" size=${16} /> ${WAKE_ONLY[s.type]} It updates when the display wakes (every ${ctx.refreshMin} min${s.type === 'transport' ? ', or sooner when a departure turns imminent' : ''}), never in between — battery comes first.</p>`}
      <${Field} label="Heading (optional)"><${TextInput} value=${s.title} placeholder=${meta.label} onInput=${(v) => set({ ...s, title: v })} /><//>
      <${Editor} s=${s} set=${set} ctx=${ctx} presets=${ctx.presets} />
      <${ShowWhenEditor} s=${s} set=${set} />
    </div>`}
  </section>`;
}

function AddSection({ onAdd }) {
  const [open, setOpen] = useState(false);
  return html`<div>
    <${Button} small icon=${open ? 'close' : 'plus'} onClick=${() => setOpen(!open)}>${open ? 'Close' : 'Add section'}<//>
    ${open &&
    html`<div class="section-palette">
      ${Object.entries(SECTION_META).map(
        ([type, m]) => html`<button type="button" class="palette-item" onClick=${() => {
          onAdd(type);
          setOpen(false);
        }}>
          <${Icon} name=${m.icon} size=${22} />
          <span><b>${m.label}</b><br /><span class="hint">${m.about}</span></span>
        </button>`
      )}
    </div>`}
  </div>`;
}

// --- Screens --------------------------------------------------------------------------------------------

function SectionsScreenEditor({ screen, setScreen, ctx, openId, setOpenId }) {
  const tpl = TEMPLATES.find((t) => t.value === screen.template) || TEMPLATES[0];
  const setColumns = (columns) => setScreen({ ...screen, columns });
  const setTemplate = (value) => {
    const n = TEMPLATES.find((t) => t.value === value).columns.length;
    const cols = screen.columns.slice(0, n);
    while (cols.length < n) cols.push([]);
    // Going down to one column keeps every section.
    if (n < screen.columns.length) cols[n - 1] = [...cols[n - 1], ...screen.columns.slice(n).flat()];
    setScreen({ ...screen, template: value, columns: cols });
  };
  return html`<div class="stack">
    <div class="row" style="align-items:center">
      <span class="hint">Arrangement</span>
      <div class="chips">
        ${TEMPLATES.map((t) => html`<button type="button" class=${`chip ${t.value === screen.template ? 'on' : ''}`} onClick=${() => setTemplate(t.value)}><${Icon} name=${t.icon} size=${16} />${t.label}</button>`)}
      </div>
    </div>
    <div class="section-columns" style=${{ gridTemplateColumns: GRID_COLUMNS[screen.template] || '1fr' }}>
      ${screen.columns.map((col, ci) => {
        const setCol = (next) => setColumns(screen.columns.map((c, j) => (j === ci ? next : c)));
        return html`<div class="stack">
          <div class="sublist-group" style="padding-left:0">${tpl.columns[ci]}</div>
          ${col.map((s, si) => html`<${SectionCard}
            key=${s.id}
            s=${s}
            ctx=${ctx}
            colIndex=${ci}
            columnLabels=${tpl.columns}
            open=${openId === s.id}
            onToggle=${() => setOpenId(openId === s.id ? null : s.id)}
            set=${(next) => setCol(col.map((x) => (x.id === s.id ? next : x)))}
            remove=${() => confirm(`Remove “${s.title || SECTION_META[s.type].label}”?`) && setCol(col.filter((x) => x.id !== s.id))}
            duplicate=${() => {
              const copy = reId(s);
              setCol([...col.slice(0, si + 1), copy, ...col.slice(si + 1)]);
              setOpenId(copy.id);
            }}
            move=${{ up: si > 0 ? () => setCol(moveItem(col, si, si - 1)) : null, down: si < col.length - 1 ? () => setCol(moveItem(col, si, si + 1)) : null }}
            moveColumn=${() => {
              const other = (ci + 1) % screen.columns.length;
              setColumns(screen.columns.map((c, j) => (j === ci ? c.filter((x) => x.id !== s.id) : j === other ? [...c, s] : c)));
            }}
          />`)}
          ${col.length === 0 && html`<p class="hint">Nothing here yet.</p>`}
          <${AddSection} onAdd=${(type) => {
            const s = newSection(type);
            setCol([...col, s]);
            setOpenId(s.id);
          }} />
        </div>`;
      })}
    </div>
  </div>`;
}

const SCREEN_KIND_META = {
  meetingRoom: { icon: 'calendar-account-outline', label: 'Meeting room' },
  roomFinder: { icon: 'door-sliding-open', label: 'Room finder' }
};

const TIMELINE_CHOICES = [
  { value: '0', label: 'Off' },
  { value: '1', label: 'Next hour' },
  { value: '2', label: 'Next 2 hours' },
  { value: '3', label: 'Next 3 hours' }
];

// Free / in use icons, and what each state says: the meeting room's status
// bar and the room finder's rows. A blank label goes back to the default.
const STATUS_LABELS = [
  { key: 'free', label: 'Free', icon: 'freeIcon' },
  { key: 'busy', label: 'In use (booked)', icon: 'occupiedIcon' },
  { key: 'occupied', label: 'In use, not booked', icon: 'occupiedIcon' },
  { key: 'soon', label: 'Starting soon' },
  { key: 'bookedEmpty', label: 'Booked, no one there' }
];
const DEFAULT_LABELS = {
  meeting: { free: 'Available', soon: 'Starting soon', busy: 'In use', bookedEmpty: 'Booked — no one here', occupied: 'In use — not booked' },
  finder: { free: 'Free', soon: 'Free', busy: 'In use', bookedEmpty: 'Booked — no one here', occupied: 'In use — not booked' }
};
function StatusIconsFields({ m, set, kind = 'meeting' }) {
  const labels = { ...DEFAULT_LABELS[kind], ...(m.labels || {}) };
  return html`<div class="row">
      <${Field} label="Free icon"><${IconPicker} value=${m.freeIcon} onChange=${(v) => set('freeIcon', v || 'door-open')} /><//>
      <${Field} label="In use icon"><${IconPicker} value=${m.occupiedIcon} onChange=${(v) => set('occupiedIcon', v || 'account-group')} /><//>
    </div>
    <div class="label-grid">
      ${STATUS_LABELS.map(
        (x) => html`<${Field} label=${x.label}>
          <${TextInput} value=${labels[x.key]} placeholder=${DEFAULT_LABELS[kind][x.key]} onInput=${(v) => set('labels', { ...labels, [x.key]: v })} />
        <//>`
      )}
    </div>`;
}

function MeetingEditor({ screen, setScreen }) {
  const m = screen.meeting;
  const set = (k, v) => setScreen({ ...screen, meeting: { ...m, [k]: v } });
  const cl = m.climate || { show: false, temperature: '', humidity: '', co2: '' };
  const setCl = (k, v) => set('climate', { ...cl, [k]: v });
  return html`<div class="grid">
    <${Card} icon="calendar-account-outline" title="Room" subtitle="A whole screen for one room's bookings — for a display by a conference room door.">
      <${Field} label="Room calendar" hint="Any Home Assistant calendar: Google, Outlook/Exchange, CalDAV…"><${EntityPicker} domains=${['calendar']} value=${m.calendar} onChange=${(id, e) => setScreen({ ...screen, meeting: { ...m, calendar: id, name: m.name || (e && e.name) || '' } })} /><//>
      <${Field} label="Room name"><${TextInput} value=${m.name} placeholder="Boardroom" onInput=${(v) => set('name', v)} /><//>
      <${Toggle} checked=${m.hideTitles} onChange=${(v) => set('hideTitles', v)} label="Hide meeting titles (show “Booked”)" />
    <//>
    <${Card} icon="account-eye-outline" title="Occupancy (optional)" subtitle="With a presence/motion sensor it can tell a booked-but-empty room, or one in use without a booking.">
      <${Field} label="Occupancy sensor"><${EntityPicker} domains=${['binary_sensor']} value=${m.occupancy} onChange=${(id) => set('occupancy', id)} /><//>
      <div class="row">
        <${Field} label="“Starting soon” (min before)"><${NumberInput} min="0" max="60" value=${m.soonMin} onChange=${(v) => set('soonMin', v)} /><//>
        <${Field} label="“No one here” after (min)"><${NumberInput} min="0" max="60" value=${m.emptyMin} onChange=${(v) => set('emptyMin', v)} /><//>
        <${Field} label="Later meetings shown"><${NumberInput} min="0" max="8" value=${m.upcoming} onChange=${(v) => set('upcoming', v)} /><//>
      </div>
    <//>
    <${Card} icon="view-agenda-outline" title="Status bar" subtitle="Its icons and words for each state, and a timeline of the next hours under the bar.">
      <${StatusIconsFields} m=${m} set=${set} />
      <${Field} label="Timeline under the bar" hint="Bookings as blocks. It moves on each quarter hour, when the display wakes.">
        <${Select} value=${String(m.timelineHours ?? 2)} onChange=${(v) => set('timelineHours', Number(v))} options=${TIMELINE_CHOICES} />
      <//>
    <//>
    <${Card} icon="thermometer" title="Room climate" subtitle="Temperature, humidity and CO2 in the bottom-right corner.">
      <${Toggle} checked=${cl.show} onChange=${(v) => setCl('show', v)} label="Show the room's climate" />
      ${cl.show &&
      html`<${Field} label="Temperature" hint="A thermostat or a temperature sensor."><${EntityPicker} domains=${['climate', 'sensor']} value=${cl.temperature} onChange=${(id) => setCl('temperature', id)} /><//>
        <div class="row">
          <${Field} label="Humidity (optional)" hint="A thermostat's own humidity is used if it has one."><${EntityPicker} domains=${['sensor']} value=${cl.humidity} onChange=${(id) => setCl('humidity', id)} /><//>
          <${Field} label="CO2 (optional)" hint="Yellow from 1000 ppm, red from 1500."><${EntityPicker} domains=${['sensor']} value=${cl.co2} onChange=${(id) => setCl('co2', id)} /><//>
        </div>`}
    <//>
  </div>`;
}

// The other rooms, and whether a busy one is listed at all.
function FinderEditor({ screen, setScreen, layout }) {
  const f = screen.finder;
  const set = (k, v) => setScreen({ ...screen, finder: { ...f, [k]: v } });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // Every meeting-room sign's room, except this layout's own and any listed.
  const importSigns = () => {
    setBusy(true);
    api('/api/dashboards')
      .then((list) => {
        const own = new Set(layout.screens.filter((x) => x.kind === 'meetingRoom').map((x) => x.meeting.calendar));
        const have = new Set(f.rooms.map((r) => r.calendar));
        const added = [];
        for (const d of list) {
          for (const r of d.meetingRooms || []) {
            if (own.has(r.calendar) || have.has(r.calendar)) continue;
            have.add(r.calendar);
            added.push({ id: newId(), calendar: r.calendar, name: r.name, occupancy: r.occupancy });
          }
        }
        set('rooms', [...f.rooms, ...added].slice(0, 12));
        setNote(added.length ? `Added ${added.length} room${added.length === 1 ? '' : 's'}.` : 'No other meeting-room signs to add.');
      })
      .catch((e) => setNote(e.message))
      .finally(() => setBusy(false));
  };
  return html`<div class="grid">
    <${Card} icon="door-sliding-open" title="Rooms" subtitle="Each by its calendar. Free rooms are listed first, the longest free at the top."
      actions=${html`<${Button} small icon="import" disabled=${busy} onClick=${importSigns}>Add the other meeting-room signs<//>`}>
      ${note && html`<p class="hint">${note}</p>`}
      <${ItemList}
        items=${f.rooms}
        onChange=${(l) => set('rooms', l)}
        max=${12}
        addLabel="Add room"
        empty="No rooms yet. Add them one by one, or from the other meeting-room signs."
        newItem=${() => ({ id: newId(), calendar: '', name: '', occupancy: '' })}
        render=${(it, upd) => html`<div class="row">
          <${Field} label="Calendar"><${EntityPicker} domains=${['calendar']} value=${it.calendar} onChange=${(id, e) => upd({ ...it, calendar: id, name: it.name || (e && e.name) || '' })} /><//>
          <${Field} label="Name"><${TextInput} value=${it.name} placeholder="Boardroom" onInput=${(v) => upd({ ...it, name: v })} /><//>
          <${Field} label="Occupancy (optional)"><${EntityPicker} domains=${['binary_sensor']} value=${it.occupancy} onChange=${(id) => upd({ ...it, occupancy: id })} /><//>
        </div>`}
      />
    <//>
    <${Card} icon="tune-variant" title="Options" subtitle="Meeting titles are never shown here.">
      <${Toggle} checked=${f.showBusy} onChange=${(v) => set('showBusy', v)} label="List busy rooms too (after the free ones)" />
      <${StatusIconsFields} m=${f} set=${set} kind="finder" />
      <div class="row">
        <${Field} label="“Starting soon” (min before)"><${NumberInput} min="0" max="60" value=${f.soonMin} onChange=${(v) => set('soonMin', v)} /><//>
        <${Field} label="“No one here” after (min)"><${NumberInput} min="0" max="60" value=${f.emptyMin} onChange=${(v) => set('emptyMin', v)} /><//>
      </div>
    <//>
  </div>`;
}

function ScreensCard({ screens, selected, onSelect, onChange, useDragOrder }) {
  const { props, cls } = useDragOrder(screens, onChange);
  const [adding, setAdding] = useState(false);
  let n = 0;
  const add = (kind) => {
    const s = newScreen(kind);
    onChange([...screens, s]);
    onSelect(s.id);
    setAdding(false);
  };
  return html`<${Card} icon="view-carousel-outline" title="Screens" subtitle="The pages the left/right buttons step through. Drag to reorder; click one to edit it."
    actions=${html`<${Button} small icon="plus" disabled=${screens.length >= 12} onClick=${() => setAdding(!adding)}>Add screen<//>`}>
    ${adding &&
    html`<div class="section-palette" style="grid-template-columns:1fr 1fr 1fr">
      <button type="button" class="palette-item" onClick=${() => add('sections')}><${Icon} name="view-dashboard-edit-outline" size=${26} /><span><b>Sections</b><br /><span class="hint">Pick an arrangement and fill it with any sections</span></span></button>
      <button type="button" class="palette-item" onClick=${() => add('meetingRoom')}><${Icon} name="calendar-account-outline" size=${26} /><span><b>Meeting room</b><br /><span class="hint">Free / in use, a timeline, current and next meetings</span></span></button>
      <button type="button" class="palette-item" onClick=${() => add('roomFinder')}><${Icon} name="door-sliding-open" size=${26} /><span><b>Room finder</b><br /><span class="hint">Which other rooms are free now</span></span></button>
    </div>`}
    <div class="carousel">
      ${screens.map((s, i) => {
        if (s.enabled) n += 1;
        const count = s.kind === 'sections' ? s.columns.flat().length : 0;
        return html`<div class=${`page-card ${s.enabled ? '' : 'off'} ${selected === s.id ? 'selected' : ''} ${cls(i)}`} key=${s.id} ...${props(i)} onClick=${() => onSelect(s.id)}>
          <div class="pc-top" onClick=${(e) => e.stopPropagation()}>
            <span class="pc-num">${s.enabled ? n : '–'}</span>
            <span class="spacer"></span>
            <${Toggle} checked=${s.enabled} onChange=${(v) => onChange(screens.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />
          </div>
          <div class="pc-screen"><${Icon} name=${SCREEN_KIND_META[s.kind] ? SCREEN_KIND_META[s.kind].icon : (TEMPLATES.find((t) => t.value === s.template) || TEMPLATES[0]).icon} size=${36} /></div>
          <div class="pc-title">${s.title || 'Untitled'}</div>
          <div class="pc-sub">${s.kind === 'roomFinder' ? `${s.finder.rooms.length} room${s.finder.rooms.length === 1 ? '' : 's'}` : SCREEN_KIND_META[s.kind] ? SCREEN_KIND_META[s.kind].label : `${count} section${count === 1 ? '' : 's'}`}</div>
          <div class="pc-move" onClick=${(e) => e.stopPropagation()}>
            <${Button} kind="ghost" small icon="chevron-left" title="Move left" disabled=${i === 0} onClick=${() => onChange(moveItem(screens, i, i - 1))} />
            <${Button} kind="ghost" small icon="content-copy" title="Duplicate" disabled=${screens.length >= 12} onClick=${() => {
              const copy = { ...reId(s), title: `${s.title} copy` };
              onChange([...screens.slice(0, i + 1), copy, ...screens.slice(i + 1)]);
              onSelect(copy.id);
            }} />
            <${Button} kind="ghost" small icon="trash-can-outline" title="Delete" disabled=${screens.length <= 1} onClick=${() => {
              if (!confirm(`Delete the screen “${s.title}”?`)) return;
              onChange(screens.filter((x) => x.id !== s.id));
              if (selected === s.id) onSelect(screens[i === 0 ? 1 : 0].id);
            }} />
            <${Button} kind="ghost" small icon="chevron-right" title="Move right" disabled=${i === screens.length - 1} onClick=${() => onChange(moveItem(screens, i, i + 1))} />
          </div>
        </div>`;
      })}
    </div>
  <//>`;
}

// --- Carousel, thresholds, import ---------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

const THRESHOLDS = [
  ['batteryCritical', 'Battery critical %', 'Battery turns its “critical” colour.'],
  ['batteryLow', 'Battery low %', ''],
  ['transportUrgentMin', 'Departure imminent (min)', 'Departures this close turn red.'],
  ['motionRecentMin', 'Motion recent (min)', 'Motion this recent shows blue.'],
  ['climateTolerance', 'Climate tolerance °', 'How far from target still counts as “at target”.']
];

function CarouselCard({ layout, onChange }) {
  const c = layout.carousel;
  const set = (k, v) => onChange({ ...layout, carousel: { ...c, [k]: v } });
  const q = layout.quietHours || { enabled: false, start: 23, end: 6, intervalMin: 60 };
  const setQ = (k, v) => onChange({ ...layout, quietHours: { ...q, [k]: v } });
  return html`<${Card} icon="rotate-right" title="Carousel" subtitle="What the display does between button presses, and how often it refreshes.">
    <div class="row" style="align-items:flex-end">
      <${Field} label="Between presses">
        <${Select} value=${c.mode} onChange=${(v) => set('mode', v)} options=${[
          { value: 'stay', label: 'Stay on the current screen (refresh it)' },
          { value: 'advance', label: 'Move to the next screen' },
          { value: 'returnFirst', label: 'Go back to the first screen' }
        ]} />
      <//>
      ${c.mode !== 'stay' && html`<div style="width:150px"><${Field} label="Every (minutes)"><${NumberInput} min="5" max="240" value=${c.everyMin} onChange=${(v) => set('everyMin', v)} /><//></div>`}
      <div style="width:200px"><${Field} label="Refresh data every">
        <${Select} value=${String(layout.refreshIntervalMin)} onChange=${(v) => onChange({ ...layout, refreshIntervalMin: Number(v) })}
          options=${[5, 10, 15, 30, 60].map((n) => ({ value: String(n), label: n === 60 ? 'Hour' : `${n} minutes` }))} />
      <//></div>
    </div>
    <p class="hint">${c.mode === 'stay'
      ? 'The screen only changes when someone presses a button.'
      : 'Each change is a full panel refresh (15–20 s), which costs battery.'}</p>
    <div class="row" style="align-items:flex-end">
      <${Toggle} checked=${q.enabled} onChange=${(v) => setQ('enabled', v)} label="Quiet hours" />
      ${q.enabled &&
      html`<div style="width:110px"><${Field} label="From"><${Select} value=${String(q.start)} onChange=${(v) => setQ('start', Number(v))} options=${HOURS} /><//></div>
        <div style="width:110px"><${Field} label="Until"><${Select} value=${String(q.end)} onChange=${(v) => setQ('end', Number(v))} options=${HOURS} /><//></div>
        <div style="width:200px"><${Field} label="Refresh every"><${Select} value=${String(q.intervalMin)} onChange=${(v) => setQ('intervalMin', Number(v))}
          options=${[30, 60, 120, 240].map((n) => ({ value: String(n), label: n < 60 ? `${n} minutes` : n === 60 ? 'Hour' : `${n / 60} hours` }))} /><//></div>`}
    </div>
    ${q.enabled && html`<p class="hint">Overnight the display wakes less often, and shows a small bed-and-clock icon by the time.</p>`}
  <//>`;
}

function SettingsCard({ layout, onChange }) {
  const [ip, setIp] = useState('');
  const [json, setJson] = useState('');
  const [msg, flash] = useFlash();
  const setT = (k, v) => onChange({ ...layout, thresholds: { ...layout.thresholds, [k]: v } });
  const importConfig = async (config) => {
    const r = await api('/api/viewports/import', { method: 'POST', body: { config } });
    onChange(r.layout);
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
  const load = async (kind) => {
    if (!confirm('Replace this whole layout?')) return;
    onChange((await api(`/api/viewports/defaults${kind ? `?kind=${kind}` : ''}`)).layout);
    flash('Loaded — Save to keep it.', 6000);
  };
  return html`<div class="grid">
    <${Card} icon="tune-variant" title="Thresholds" subtitle="Shared by every screen's sections.">
      ${THRESHOLDS.map(([k, label, hint]) => html`<${Field} label=${label} hint=${hint}><${NumberInput} step="0.5" value=${layout.thresholds[k]} onChange=${(v) => setT(k, v)} /><//>`)}
    <//>
    <${Card} icon="import" title="Start from…" subtitle="Replace the whole layout, then adjust it.">
      <div class="row">
        <${Button} icon="home-outline" onClick=${() => load('')}>Kitchen dashboard<//>
        <${Button} icon="calendar-account-outline" onClick=${() => load('meetingRoom')}>Meeting room sign<//>
      </div>
      <${Field} label="Import an existing kitchen panel" hint="Put the panel in config mode (long-press the middle button), then enter its IP.">
        <div class="input-with-button">
          <input type="text" value=${ip} placeholder="192.168.1.50" onInput=${(e) => setIp(e.target.value)} />
          <${Button} icon="download-network-outline" disabled=${!ip.trim()} onClick=${fromDevice}>Read<//>
        </div>
      <//>
      <${Field} label="…or paste its /api/config JSON">
        <textarea value=${json} onInput=${(e) => setJson(e.target.value)} placeholder='{"sensors": {...}, "colors": {...}}'></textarea>
      <//>
      <div><${Button} icon="import" disabled=${!json.trim()} onClick=${fromPaste}>Import<//></div>
      <span class=${`flash ${/failed|Couldn't/.test(msg) ? 'flash-bad' : ''}`}>${msg}</span>
    <//>
  </div>`;
}

// --- The builder ---------------------------------------------------------------------------------------------

// The live preview: the server evaluates the (unsaved) layout against Home
// Assistant, debounced while editing.
function usePreview(layout) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const key = JSON.stringify(layout);
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api('/api/dashboards/preview', { method: 'POST', body: { layout } })
        .then((s) => {
          if (n !== seq.current) return;
          setState(s);
          setError('');
        })
        .catch((e) => n === seq.current && setError(e.message))
        .finally(() => n === seq.current && setLoading(false));
    }, 600);
    return () => clearTimeout(t);
  }, [key]);
  return { state, error, loading };
}

export function DashboardBuilder({ layout, onChange, rooms, useDragOrder }) {
  const [selected, setSelected] = useState(layout.screens[0] && layout.screens[0].id);
  const [openId, setOpenId] = useState(null);
  const [presets, setPresets] = useState(null);
  const preview = usePreview(layout);
  useEffect(() => {
    api('/api/clients/schema').then((s) => setPresets(s.dashboard && s.dashboard.iconPresets)).catch(() => {});
  }, []);
  const screen = layout.screens.find((s) => s.id === selected) || layout.screens[0];
  const setScreens = (screens) => onChange({ ...layout, screens });
  const setScreen = (next) => setScreens(layout.screens.map((s) => (s.id === next.id ? next : s)));
  const allSections = layout.screens.flatMap((s) => (s.kind === 'sections' ? s.columns.flat() : []));
  const ctx = { rooms, allSections, presets, refreshMin: layout.refreshIntervalMin };
  const errors = preview.state && preview.state.errors ? Object.entries(preview.state.errors) : [];
  return html`<div class="stack">
    <${CarouselCard} layout=${layout} onChange=${onChange} />
    <${ScreensCard} screens=${layout.screens} selected=${screen && screen.id} onSelect=${(id) => {
      setSelected(id);
      setOpenId(null);
    }} onChange=${setScreens} useDragOrder=${useDragOrder} />
    ${screen &&
    html`<${Card} icon=${SCREEN_KIND_META[screen.kind] ? SCREEN_KIND_META[screen.kind].icon : 'view-dashboard-edit-outline'}
        title=${html`<input type="text" class="inline-title" value=${screen.title} onInput=${(e) => setScreen({ ...screen, title: e.target.value })} />`}
        subtitle="Live preview from Home Assistant, including unsaved changes."
        actions=${html`${preview.loading && html`<${Badge} icon="refresh">Updating<//>`}${errors.length > 0 && html`<${Badge} kind="warn" icon="alert-outline">${errors.length} couldn't load<//>`}`}>
        <${ViewportPreview} screen=${screen.id} state=${preview.state} error=${preview.error} loading=${preview.loading} highlight=${openId} />
        ${errors.length > 0 && html`<p class="hint">${errors.map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>`}
        ${!screen.enabled && html`<p class="hint"><${Icon} name="eye-off-outline" size=${14} /> This screen is switched off, so the display skips it.</p>`}
      <//>
      ${screen.kind === 'meetingRoom'
        ? html`<${MeetingEditor} screen=${screen} setScreen=${setScreen} />`
        : screen.kind === 'roomFinder'
        ? html`<${FinderEditor} screen=${screen} setScreen=${setScreen} layout=${layout} />`
        : html`<${SectionsScreenEditor} screen=${screen} setScreen=${setScreen} ctx=${ctx} openId=${openId} setOpenId=${setOpenId} />`}`}
    <${SettingsCard} layout=${layout} onChange=${onChange} />
  </div>`;
}
