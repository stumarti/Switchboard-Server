// A true-size (800×480) preview of a viewport screen in the panel's six
// colours, drawn from the same evaluated state the device receives
// (/api/viewports/:mac/preview). Close to the device's own drawing, not
// pixel-exact: it's for checking what shows, where, and in which colour.

import { html, useState, useEffect, useRef, Icon } from './lib.js';

export const PALETTE = {
  0: { name: 'White', hex: '#ffffff' },
  1: { name: 'Black', hex: '#111111' },
  2: { name: 'Red', hex: '#c62828' },
  3: { name: 'Yellow', hex: '#e0b400' },
  4: { name: 'Green', hex: '#2e7d32' },
  5: { name: 'Blue', hex: '#1565c0' }
};
const c = (i) => (PALETTE[i] || PALETTE[1]).hex;
const GREY = '#8a8a8a';

const WEATHER_ICONS = {
  'clear-night': 'weather-night',
  cloudy: 'weather-cloudy',
  exceptional: 'alert-circle-outline',
  fog: 'weather-fog',
  hail: 'weather-hail',
  lightning: 'weather-lightning',
  'lightning-rainy': 'weather-lightning-rainy',
  partlycloudy: 'weather-partly-cloudy',
  pouring: 'weather-pouring',
  rainy: 'weather-rainy',
  snowy: 'weather-snowy',
  'snowy-rainy': 'weather-snowy-rainy',
  sunny: 'weather-sunny',
  windy: 'weather-windy',
  'windy-variant': 'weather-windy-variant'
};
const weatherIcon = (cond) => WEATHER_ICONS[cond] || 'weather-cloudy';
const deg = (v) => (v == null ? '--' : `${Math.round(v)}°`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const val = (m) => (m ? `${m.value}${m.unit ? ` ${m.unit}` : ''}` : '--');

const Label = ({ children }) => (children ? html`<div class="vp-label">${children}</div>` : null);
const Bar = ({ pct, color }) => html`<div class="vp-bar"><div style=${{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: c(color) }}></div></div>`;
const Missing = ({ what }) => html`<div class="vp-small vp-muted">${what}</div>`;

// --- Sections -------------------------------------------------------------------------

function Weather({ d }) {
  if (!d) return html`<${Missing} what="No weather entity" />`;
  return html`<div>
    <div class="vp-row">
      <div class="vp-huge">${deg(d.temperature)}</div>
      <${Icon} name=${weatherIcon(d.condition)} size=${56} />
    </div>
    <div class="vp-small">feels ${deg(d.feelsLike)} · ${d.humidity ?? '--'}% · ${d.windSpeed ?? '--'} ${d.windUnit}</div>
    ${d.forecast.length > 0 &&
    html`<div class="vp-forecast">
      ${d.forecast.map((f) => html`<div><div class="vp-tiny">${f.label}</div><${Icon} name=${weatherIcon(f.condition)} size=${22} /><div class="vp-small">${deg(f.high)}</div></div>`)}
    </div>`}
  </div>`;
}

function Energy({ d }) {
  const cell = (icon, m, label, col) => html`<div><${Icon} name=${icon} size=${20} /><div class="vp-med" style=${col ? { color: c(col) } : null}>${val(m)}</div><div class="vp-tiny">${label}</div></div>`;
  return html`<div class="vp-grid2">
    ${cell('solar-power-variant', d.solarToday, d.solarExpected ? `of ${val(d.solarExpected)}` : 'solar', 3)}
    ${cell('home-lightning-bolt-outline', d.loadToday, 'load')}
    ${cell('transmission-tower-export', d.gridExport, 'export', 4)}
    ${cell('transmission-tower-import', d.gridImport, 'import')}
  </div>`;
}

// Solar (yellow bars) and consumption (black line) against the forecast
// (blue dashed); grid import (red) and export (green) below the axis.
function EnergyGraph({ d }) {
  const W = 760;
  const H = 220;
  const top = 8;
  const axis = 150;
  const below = H - axis - 22;
  const n = d.labels.length;
  const bw = W / n;
  const max = Math.max(0.5, d.max || 0);
  const y = (v) => axis - (v / max) * (axis - top);
  const gy = (v) => (v / max) * below;
  const s = d.series;
  const col = d.colors;
  const line = (vals) => {
    if (!vals) return '';
    let path = '';
    vals.forEach((v, i) => {
      if (v == null) return;
      path += `${path && vals[i - 1] != null ? 'L' : 'M'}${(i + 0.5) * bw},${y(v)}`;
    });
    return path;
  };
  const legend = [
    ['solar', 'Solar'],
    ['forecast', 'Forecast'],
    ['load', 'Use'],
    ['gridImport', 'Import'],
    ['gridExport', 'Export']
  ].filter(([k]) => s[k]);
  return html`<div>
    <svg viewBox=${`0 0 ${W} ${H}`} width="100%" style="display:block">
      ${s.solar && s.solar.map((v, i) => v != null && html`<rect x=${i * bw + 2} y=${y(v)} width=${bw - 4} height=${axis - y(v)} fill=${c(col.solar)} />`)}
      ${s.gridImport && s.gridImport.map((v, i) => v != null && html`<rect x=${i * bw + 2} y=${axis} width=${(bw - 4) / 2} height=${gy(v)} fill=${c(col.gridImport)} />`)}
      ${s.gridExport && s.gridExport.map((v, i) => v != null && html`<rect x=${i * bw + 2 + (bw - 4) / 2} y=${axis} width=${(bw - 4) / 2} height=${gy(v)} fill=${c(col.gridExport)} />`)}
      ${s.forecast && html`<path d=${line(s.forecast)} fill="none" stroke=${c(col.forecast)} stroke-width="3" stroke-dasharray="7 5" />`}
      ${s.load && html`<path d=${line(s.load)} fill="none" stroke=${c(col.load)} stroke-width="3" />`}
      <line x1="0" x2=${W} y1=${axis} y2=${axis} stroke="#111" stroke-width="2" />
      ${d.nowIndex != null && html`<line x1=${(d.nowIndex + 0.5) * bw} x2=${(d.nowIndex + 0.5) * bw} y1=${top} y2=${H - 20} stroke="#111" stroke-width="1" stroke-dasharray="2 3" />`}
      ${d.labels.map((l, i) => i % Math.ceil(n / 12) === 0 && html`<text x=${i * bw + 2} y=${H - 4} font-size="13" fill="#555">${l}</text>`)}
      <text x=${W - 4} y=${top + 12} font-size="13" fill="#555" text-anchor="end">${max.toFixed(1)} kW</text>
    </svg>
    <div class="vp-row" style="gap:14px;flex-wrap:wrap">
      ${legend.map(([k, label]) => html`<span class="vp-small"><span class="vp-key" style=${{ background: c(col[k]) }}></span>${label} ${d.totals[k] == null ? '' : `${d.totals[k]} kWh`}</span>`)}
    </div>
  </div>`;
}

function Battery({ d }) {
  if (!d) return html`<${Missing} what="No battery sensors" />`;
  return html`<div>
    <div class="vp-row"><${Icon} name=${d.status === 'charging' ? 'battery-charging' : 'battery'} size=${28} /><div class="vp-big" style=${{ color: c(d.color) }}>${d.soc ?? '--'}%</div></div>
    <${Bar} pct=${d.soc} color=${d.color} />
    <div class="vp-small">${d.status || '—'}${d.eta ? ` · ${d.eta}` : ''}</div>
  </div>`;
}

const StatusIcons = ({ d }) =>
  html`<div class="vp-iconbar">
    ${d.icons.length ? d.icons.map((s) => html`<span title=${`${s.name}: ${s.state || 'unknown'}`} style=${{ color: c(s.color) }}><${Icon} name=${s.icon || 'help'} size=${34} /></span>`) : html`<${Missing} what="No icons showing" />`}
  </div>`;

const Alerts = ({ d }) =>
  html`<div class="vp-lines">
    ${d.lines.map((l) => html`<div class="vp-med" style=${{ color: c(l.color) }}>${l.text}</div>`)}
    ${d.overflow > 0 && html`<div class="vp-small">+ ${d.overflow} more...</div>`}
    ${d.allClear && html`<div class="vp-med" style=${{ color: c(4) }}><${Icon} name="check-circle-outline" size=${20} /> ${d.allClearText}</div>`}
  </div>`;

const Calendar = ({ d }) =>
  html`<div class="vp-lines">${d.lines.length ? d.lines.map((l) => html`<div class="vp-med" style=${{ color: c(5) }}>${l.text}</div>`) : html`<${Missing} what="Nothing coming up" />`}</div>`;

function HeatPump({ d }) {
  if (!d) return html`<${Missing} what="No heat pump" />`;
  return html`<div class="vp-hp">
    <div class="vp-row"><${Icon} name="heat-pump-outline" size=${26} /><div class="vp-big">${d.name}</div></div>
    <div class="vp-hp-grid">
      <div><div class="vp-tiny">Mode</div><div class="vp-med">${d.action || d.mode || '—'}</div></div>
      <div><div class="vp-tiny">Outside</div><div class="vp-med">${d.outside == null ? '--' : `${d.outside}°`}</div></div>
      <div><div class="vp-tiny">Setpoint</div><div class="vp-med">${deg(d.setpoint)}</div></div>
      <div><div class="vp-tiny">COP</div><div class="vp-med">${d.cop ?? '--'}</div></div>
    </div>
  </div>`;
}

function RoomClimate({ d }) {
  return html`<div>
    ${d.total > 0 && html`<div class="vp-med"><b style=${{ color: c(2) }}>${d.calling}</b> of ${d.total} rooms calling</div>`}
    ${d.rooms.map(
      (r) => html`<div class="vp-room">
        <span class="vp-med" style="width:140px">${r.name}</span>
        <span class="vp-med" style=${{ width: '130px', color: c(r.color) }}>${r.temperature == null ? '--' : `${r.temperature}°`}${r.target != null ? html` <span class="vp-small">→ ${r.target}°</span>` : ''}</span>
        <div class="vp-delta">
          <div class="vp-delta-mid"></div>
          ${r.delta != null &&
          html`<div style=${{ position: 'absolute', top: '3px', bottom: '3px', background: c(r.color), left: `${50 + Math.min(0, Math.max(-5, r.delta)) * 10}%`, width: `${Math.abs(Math.max(-5, Math.min(5, r.delta))) * 10}%` }}></div>`}
        </div>
      </div>`
    )}
  </div>`;
}

function RoomList({ d }) {
  const row = (r) => html`<div class="vp-row vp-rowline">
    <${Icon} name=${r.icon || 'home-outline'} size=${20} />
    <span class="vp-small" style="flex:1">${r.name}</span>
    <span class="vp-med">${deg(r.temperature)}</span>
    <span class="vp-tiny" style=${{ color: c(5), width: '34px', textAlign: 'right' }}>${r.humidity == null ? '' : `${Math.round(r.humidity)}%`}</span>
  </div>`;
  if (!d.byFloor) return html`<div>${d.rooms.map(row)}</div>`;
  return html`<div>
    ${['upstairs', 'downstairs'].map((f) => {
      const list = d.rooms.filter((r) => r.floor === f);
      return list.length > 0 && html`<div><${Label}>${f}<//>${list.map(row)}</div>`;
    })}
  </div>`;
}

const People = ({ d }) =>
  html`<div class="vp-row" style="gap:16px;flex-wrap:wrap">
    ${d.people.map((p) => html`<span class="vp-med" style=${{ color: p.home ? c(p.color) : GREY }}><${Icon} name=${p.home ? 'account' : 'account-outline'} size=${20} /> ${p.name}</span>`)}
  </div>`;

const Media = ({ d }) =>
  d.players.length
    ? html`<div>${d.players.map(
        (m) => html`<div class="vp-row" style="align-items:flex-start;margin-bottom:4px">
          <span style=${{ color: c(5) }}><${Icon} name=${m.icon || 'music'} size=${24} /></span>
          <div><div class="vp-tiny">${m.room}${m.app ? ` · ${m.app}` : ''}</div><div class="vp-med">${m.title}</div><div class="vp-small">${m.artist}</div></div>
        </div>`
      )}</div>`
    : html`<${Missing} what="Nothing playing" />`;

const Transport = ({ d }) =>
  html`<div>${d.routes.map(
    (t) => html`<div class="vp-row" style="align-items:flex-start;margin-bottom:6px">
      <span style=${{ color: c(t.color) }}><${Icon} name=${t.icon || 'bus'} size=${24} /></span>
      <div style="flex:1"><div class="vp-med">${t.name}</div><div class="vp-tiny">${t.stop}</div></div>
      ${t.departures.map((x) => html`<div style="width:64px;text-align:right"><div class="vp-small">${x.time}</div><div class="vp-med" style=${{ color: c(x.color) }}>${x.text}</div></div>`)}
    </div>`
  )}</div>`;

function Alarm({ d }) {
  if (!d) return html`<${Missing} what="No alarm panel" />`;
  return html`<div>
    <div class="vp-row" style=${{ color: c(d.color) }}><${Icon} name="shield-home" size=${40} /><div class="vp-big">${d.label}</div></div>
    <div class="vp-small">since ${d.since || '—'}</div>
    ${d.last.armed && html`<div class="vp-small">Last armed ${d.last.armed}</div>`}
    ${d.last.disarmed && html`<div class="vp-small">Last disarmed ${d.last.disarmed}</div>`}
    ${d.last.triggered && html`<div class="vp-small">Last triggered ${d.last.triggered}</div>`}
  </div>`;
}

const Openings = ({ d }) =>
  html`<div>
    <div class="vp-small">${plural(d.total, 'item')} — ${d.open ? html`<b style=${{ color: c(2) }}>${d.open} open</b>` : 'all closed'}</div>
    ${d.items.map((x) => html`<div class="vp-row vp-rowline"><span class="vp-small" style="flex:1">${x.name}</span><span class="vp-small" style=${{ color: c(x.color) }}>${x.state}</span><span class="vp-tiny" style="width:64px;text-align:right">${x.when}</span></div>`)}
  </div>`;

const Motion = ({ d }) =>
  html`<div>${d.sensors.map((m) => html`<div class="vp-row vp-rowline"><span class="vp-small" style=${{ flex: 1, color: c(m.color) }}>${m.name}</span><span class="vp-tiny">${m.when}</span></div>`)}</div>`;

const Cameras = ({ d }) =>
  html`<div>${d.cameras.map((m) => html`<div class="vp-row vp-rowline"><span class="vp-small" style="flex:1">${m.name}</span><span class="vp-tiny">${m.when || '—'}</span></div>`)}</div>`;

const SECTIONS = {
  weather: Weather,
  energy: Energy,
  energyGraph: EnergyGraph,
  battery: Battery,
  statusIcons: StatusIcons,
  alerts: Alerts,
  calendar: Calendar,
  heatPump: HeatPump,
  roomClimate: RoomClimate,
  roomList: RoomList,
  people: People,
  media: Media,
  transport: Transport,
  alarm: Alarm,
  openings: Openings,
  motion: Motion,
  cameras: Cameras
};

const COLS = { sidebar: '250px 1fr', columns: '1fr 1fr', single: '1fr' };

function SectionsScreen({ d, highlight }) {
  return html`<div class="vp-cols" style=${{ gridTemplateColumns: COLS[d.template] || '1fr' }}>
    ${d.columns.map(
      (col) => html`<div class="vp-col">
        ${col.map((s) => {
          const S = SECTIONS[s.type];
          return html`<div class=${`vp-section ${highlight === s.id ? 'vp-hl' : ''}`}>
            <${Label}>${s.title}<//>
            ${S ? html`<${S} d=${s.data} />` : null}
          </div>`;
        })}
      </div>`
    )}
  </div>`;
}

function MeetingRoom({ d }) {
  return html`<div class="vp-meeting">
    <div class="vp-meeting-band" style=${{ background: c(d.color) }}>
      <div class="vp-meeting-name">${d.name}</div>
      <div class="vp-meeting-status">${d.label}</div>
      <div class="vp-meeting-until">${d.until}</div>
    </div>
    <div class="vp-meeting-body">
      ${d.current
        ? html`<div><div class="vp-label">Now</div><div class="vp-big">${d.current.title}</div><div class="vp-med">${d.current.time} · ends in ${d.current.endsInMin} min</div></div>`
        : d.next && html`<div><div class="vp-label">Next</div><div class="vp-big">${d.next.title}</div><div class="vp-med">${d.next.day} ${d.next.time}</div></div>`}
      ${d.upcoming.length > 0 &&
      html`<div><div class="vp-label">Later today</div>${d.upcoming.map((u) => html`<div class="vp-row vp-rowline"><span class="vp-med" style="width:140px">${u.time}</span><span class="vp-med">${u.title}</span></div>`)}</div>`}
    </div>
  </div>`;
}

function Footer({ generatedAt }) {
  const t = generatedAt ? new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
  return html`<div class="vp-footer">updated ${t}</div>`;
}

// Scales the 800×480 panel to the width available.
export function ViewportPreview({ screen, state, error, loading, highlight }) {
  const wrap = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / 800)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const d = state && state.screens && state.screens[screen];
  return html`<div class="vp-wrap" ref=${wrap} style=${{ height: `${480 * scale}px` }}>
    <div class="vp-panel" style=${{ transform: `scale(${scale})` }}>
      ${d
        ? d.kind === 'meetingRoom'
          ? html`<${MeetingRoom} d=${d.data} />`
          : html`<${SectionsScreen} d=${d} highlight=${highlight} />`
        : html`<div class="vp-empty">${error ? error : loading ? 'Loading…' : 'No preview'}</div>`}
      ${d && d.kind !== 'meetingRoom' && html`<${Footer} generatedAt=${state.generatedAt} />`}
      ${loading && d && html`<div class="vp-loading"><${Icon} name="refresh" size=${16} /></div>`}
    </div>
  </div>`;
}
