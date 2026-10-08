// A true-size (800×480) preview of a viewport screen in the panel's six
// colours, drawn from the same evaluated state the device receives
// (/api/viewports/:mac/preview). The sections the kitchen dashboard has are
// drawn as the panel draws them (viewport-preview-dash.js); the rest are
// close to the device's drawing, not pixel-exact: they're for checking what
// shows, where, and in which colour.

import { html, useState, useEffect, useRef, Icon } from './lib.js';
import { DASH_SECTIONS, DashFooter } from './viewport-preview-dash.js';

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
const val = (m) => (m ? m.text || `${m.value}${m.unit ? ` ${m.unit}` : ''}` : '--');

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
  if (d.style === 'list') {
    const row = (icon, label, m, col, extra) => html`<div class="vp-erow">
      <${Icon} name=${icon} size=${24} />
      <div style="flex:1"><div class="vp-tiny">${label}</div><div class="vp-big" style=${col ? { color: c(col) } : null}>${val(m)}</div>${extra && html`<div class="vp-small">${extra}</div>`}</div>
    </div>`;
    return html`<div>
      ${row('weather-sunny-alert', 'Predicted', d.solarExpected, null)}
      ${row('solar-power-variant', 'Generated', d.solarToday, 4, d.solarPct != null ? `${d.solarPct}% of predicted` : '')}
      ${row('home-lightning-bolt-outline', 'House Used', d.loadToday, null)}
      ${row('transmission-tower-import', 'From Grid', d.gridImport, 2)}
      ${row('transmission-tower-export', 'To Grid', d.gridExport, 4)}
    </div>`;
  }
  const cell = (icon, m, label, col) => html`<div><${Icon} name=${icon} size=${20} /><div class="vp-med" style=${col ? { color: c(col) } : null}>${val(m)}</div><div class="vp-tiny">${label}</div></div>`;
  return html`<div class="vp-grid2">
    ${cell('solar-power-variant', d.solarToday, d.solarExpected ? `of ${val(d.solarExpected)}` : 'solar', 3)}
    ${cell('home-lightning-bolt-outline', d.loadToday, 'load')}
    ${cell('transmission-tower-export', d.gridExport, 'export', 4)}
    ${cell('transmission-tower-import', d.gridImport, 'import')}
  </div>`;
}

// Hour labels + a "now" marker, shared by both panels.
function Axis({ d, W, y, bw }) {
  const n = d.labels.length;
  return html`${d.labels.map((l, i) => i % Math.ceil(n / 8) === 0 && html`<text x=${i * bw + 1} y=${y} font-size="13" fill="#555">${l}</text>`)}`;
}

const kwh = (v) => (v == null ? '' : ` ${v} kWh`);
const Key = ({ color, dashed, children }) =>
  html`<span class="vp-small"><span class=${`vp-key ${dashed ? 'vp-key-dash' : ''}`} style=${dashed ? { borderColor: c(color) } : { background: c(color) }}></span>${children}</span>`;

// Yellow bars get a black edge, as the panel draws them.
const edge = (n) => (n === 3 ? { stroke: '#111', 'stroke-width': 1 } : {});

// Top: actual solar (bars) against the forecast (dashed). Bottom:
// consumption stacked by source — solar, battery, grid — with charging the
// battery and export to the grid below the line.
function EnergyGraph({ d }) {
  const W = 520;
  const n = d.labels.length;
  const bw = W / n;
  const col = d.colors;
  const nowX = d.nowIndex != null ? (d.nowIndex + 0.5) * bw : null;

  // Top panel.
  const TH = 152;
  const tMax = Math.max(0.5, d.solar.max || 0);
  const ty = (v) => TH - (v / tMax) * (TH - 6);
  let fpath = '';
  (d.solar.forecast || []).forEach((v, i, a) => {
    if (v == null) return;
    fpath += `${fpath && a[i - 1] != null ? 'L' : 'M'}${(i + 0.5) * bw},${ty(v)}`;
  });

  // Bottom panel: the axis sits where the export share of the range puts it.
  const u = d.usage;
  const upMax = Math.max(0.5, u.max || 0);
  const downMax = u.exportMax || 0;
  const BH = 186;
  const up = (BH - 4) * (upMax / (upMax + downMax));
  const axisY = 2 + up;
  const scale = up / upMax;
  const bars = [];
  for (let i = 0; i < n; i++) {
    let yTop = axisY;
    for (const [k, ck] of [['fromGrid', 'fromGrid'], ['fromBattery', 'fromBattery'], ['fromSolar', 'fromSolar']]) {
      const v = u[k][i];
      if (!v) continue;
      const h = v * scale;
      yTop -= h;
      bars.push(html`<rect x=${i * bw + 1.5} y=${yTop} width=${bw - 3} height=${h} fill=${c(col[ck])} ...${edge(col[ck])} />`);
    }
    // Below the line: into the battery next to it, then out to the grid.
    let yBelow = axisY;
    for (const [list, ck] of [[u.toBattery || [], 'toBattery'], [u.export, 'gridExport']]) {
      const v = list[i];
      if (!v) continue;
      bars.push(html`<rect x=${i * bw + 1.5} y=${yBelow} width=${bw - 3} height=${v * scale} fill=${c(col[ck] ?? col.fromBattery)} ...${edge(col[ck] ?? col.fromBattery)} />`);
      yBelow += v * scale;
    }
  }
  const t = d.totals;
  return html`<div>
    <div class="vp-row" style="gap:12px;flex-wrap:wrap">
      <b class="vp-small">Solar</b>
      <${Key} color=${col.solar}>Actual${kwh(t.solar)}<//>
      <${Key} color=${col.forecast} dashed>Predicted${kwh(t.forecast)}<//>
    </div>
    <svg viewBox=${`0 0 ${W} ${TH + 18}`} width="100%" style="display:block">
      ${(d.solar.actual || []).map((v, i) => v != null && html`<rect x=${i * bw + 1.5} y=${ty(v)} width=${bw - 3} height=${TH - ty(v)} fill=${c(col.solar)} ...${edge(col.solar)} />`)}
      ${fpath && html`<path d=${fpath} fill="none" stroke=${c(col.forecast)} stroke-width="3" stroke-dasharray="7 5" />`}
      <line x1="0" x2=${W} y1=${TH} y2=${TH} stroke="#111" stroke-width="3" />
      ${nowX != null && html`<line x1=${nowX} x2=${nowX} y1="0" y2=${TH} stroke="#111" stroke-dasharray="2 3" />`}
      <text x=${W - 2} y="12" font-size="12" fill="#555" text-anchor="end">${tMax.toFixed(1)} kW</text>
      <${Axis} d=${d} W=${W} y=${TH + 15} bw=${bw} />
    </svg>
    <div class="vp-row" style="gap:12px;flex-wrap:wrap;margin-top:4px">
      <b class="vp-small">Use</b>
      <${Key} color=${col.fromSolar}>Solar${kwh(t.fromSolar)}<//>
      <${Key} color=${col.fromBattery}>Battery${kwh(t.fromBattery)}${(col.toBattery ?? col.fromBattery) === col.fromBattery && t.toBattery != null ? ` / ${t.toBattery} in` : ''}<//>
      <${Key} color=${col.fromGrid}>Grid${kwh(t.fromGrid)}<//>
      ${t.toBattery != null && (col.toBattery ?? col.fromBattery) !== col.fromBattery && html`<${Key} color=${col.toBattery ?? col.fromBattery}>Charged${kwh(t.toBattery)}<//>`}
      <${Key} color=${col.gridExport}>Export${kwh(t.gridExport)}<//>
    </div>
    <svg viewBox=${`0 0 ${W} ${BH + 18}`} width="100%" style="display:block">
      ${bars}
      <line x1="0" x2=${W} y1=${axisY} y2=${axisY} stroke="#111" stroke-width="3" />
      <line x1="0" x2=${W} y1=${BH} y2=${BH} stroke="#111" stroke-width="3" />
      ${nowX != null && html`<line x1=${nowX} x2=${nowX} y1="0" y2=${BH} stroke="#111" stroke-dasharray="2 3" />`}
      <text x=${W - 2} y="12" font-size="12" fill="#555" text-anchor="end">${upMax.toFixed(1)} kW</text>
      <${Axis} d=${d} W=${W} y=${BH + 15} bw=${bw} />
    </svg>
  </div>`;
}

function Battery({ d }) {
  if (!d) return html`<${Missing} what="No battery sensors" />`;
  return html`<div>
    <div class="vp-row"><${Icon} name=${d.status === 'charging' ? 'battery-charging' : 'battery'} size=${28} /><div class="vp-big" style=${{ color: c(d.color) }}>${d.soc == null ? '--' : Math.round(d.soc)}%</div></div>
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
          ${m.art
            ? html`<img class="vp-art" src=${`/api/art?src=${encodeURIComponent(m.art)}&w=72&h=72&fmt=png`} width="72" height="72" alt="" />`
            : html`<span style=${{ color: c(5) }}><${Icon} name=${m.icon || 'music'} size=${24} /></span>`}
          <div><div class="vp-tiny">${m.room}${m.app ? ` · ${m.app}` : ''}</div><div class="vp-med">${m.title}</div><div class="vp-small">${m.artist}</div></div>
        </div>`
      )}</div>`
    : html`<${Missing} what="Nothing playing" />`;

// A stop board: the route in a badge of its colour (or its icon), where it's
// going, the stop under it; the next departures' minutes, clock times under.
const Transport = ({ d }) =>
  html`<div>${d.routes.map(
    (t) => html`<div class="vp-row vp-rowline" style="align-items:center;padding:4px 0">
      ${t.route
        ? html`<span style=${{ background: c(t.color), color: '#fff', fontWeight: 700, borderRadius: '4px', padding: '2px 8px', minWidth: '32px', textAlign: 'center' }}>${t.route}</span>`
        : html`<span style=${{ color: c(t.color), width: '48px', textAlign: 'center' }}><${Icon} name=${t.icon || 'bus'} size=${24} /></span>`}
      <div style="flex:1;min-width:0"><div class="vp-med" style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.destination || t.name}</div>${t.stop && html`<div class="vp-tiny">${t.stop}</div>`}</div>
      ${t.departures.length
        ? t.departures.slice(0, 2).map((x) => html`<div style="width:76px;text-align:right"><div class="vp-med" style=${{ color: c(x.color), fontWeight: 700 }}>${x.text}</div><div class="vp-tiny">${x.time}</div></div>`)
        : html`<div class="vp-small">No departures</div>`}
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

const Announcements = ({ d }) =>
  d.items.length
    ? html`<div class="vp-lines">${d.items.map(
        (it) => html`<div class="vp-announce">
          <div class="vp-med" style=${{ color: c(d.color) }}>${it.title}</div>
          ${it.summary && html`<div class="vp-small">${it.summary}</div>`}
          ${it.when && html`<div class="vp-tiny">${it.when}</div>`}
        </div>`
      )}</div>`
    : html`<${Missing} what=${d.empty} />`;

// A join QR code from the server's rows of modules, with a 4-module margin.
function Qr({ rows, scale = 5 }) {
  const n = rows.length;
  const side = (n + 8) * scale;
  const path = rows.map((r, y) => [...r].map((b, x) => (b === '1' ? `M${x + 4} ${y + 4}h1v1h-1z` : '')).join('')).join('');
  return html`<svg class="vp-qr" width=${side} height=${side} viewBox=${`0 0 ${n + 8} ${n + 8}`} shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff" /><path d=${path} fill="#111" /></svg>`;
}

const GuestWifi = ({ d }) =>
  !d.qr.length
    ? html`<${Missing} what=${d.empty} />`
    : html`<div class="vp-wifi">
        <${Qr} rows=${d.qr} />
        <div class="vp-wifi-text">
          ${d.caption && html`<div class="vp-med">${d.caption}</div>`}
          <div class="vp-tiny">Network</div><div class="vp-med">${d.ssid}</div>
          ${d.password && html`<div class="vp-tiny">Password</div><div class="vp-med">${d.password}</div>`}
        </div>
      </div>`;

const MESSAGE_FONT = { normal: { fontSize: '18px', fontWeight: 400 }, bold: { fontSize: '18px', fontWeight: 700 }, large: { fontSize: '24px', fontWeight: 700 } };
const Message = ({ d }) =>
  d.lines.length
    ? html`<div class="vp-row" style=${{ alignItems: 'flex-start', justifyContent: d.align === 'center' ? 'center' : 'flex-start', color: c(d.color) }}>
        ${d.icon && html`<${Icon} name=${d.icon} size=${d.size === 'large' ? 32 : 24} />`}
        <div style=${{ ...MESSAGE_FONT[d.size], textAlign: d.align, lineHeight: 1.25 }}>${d.lines.map((l) => html`<div>${l || ' '}</div>`)}</div>
      </div>`
    : null;

const Bins = ({ d }) =>
  html`<div>
    ${d.note && html`<div class="vp-med" style=${{ color: c(2) }}>${d.note}</div>`}
    ${d.lines.length
      ? d.lines.map((b) => html`<div class="vp-row vp-rowline">
          <span style=${{ color: c(b.color) }}><${Icon} name=${b.icon} size=${24} /></span>
          <span class="vp-med" style="flex:1">${b.name}</span>
          <span class="vp-med" style=${{ color: b.soon ? c(2) : undefined }}>${b.when}</span>
        </div>`)
      : html`<${Missing} what=${d.empty} />`}
  </div>`;

const AirQuality = ({ d }) =>
  d.items.length
    ? html`<div>${d.items.map((it) => html`<div class="vp-row vp-rowline">
        <span class="vp-dot" style=${{ background: c(it.color) }}></span>
        <span class="vp-small" style="flex:1">${it.name}</span>
        <span class="vp-med" style=${{ color: c(it.color) }}>${it.value}</span>
        ${it.level && html`<span class="vp-tiny" style="width:40px;text-align:right">${it.level}</span>`}
      </div>`)}</div>`
    : html`<${Missing} what=${d.empty} />`;

// A photo from Immich, as the panel shows it (the server's six-colour
// picture), with its caption underneath. `w`: the column's width.
const artUrl = (src, w, h) => `/api/art?src=${encodeURIComponent(src)}&w=${w}&h=${h}&fmt=png`;
const PHOTO_CAPTION_H = 22;
// Height 0 fills the rest of the column, down to the footer: about 416 px
// under a heading at the top (the panel works it out exactly).
function Photo({ d, w }) {
  const h = d.height || 416;
  const ph = d.caption ? h - PHOTO_CAPTION_H : h;
  return html`<div>
    ${d.src
      ? html`<img class="vp-photo" src=${artUrl(d.src, w, ph)} width=${w} height=${ph} alt="" />`
      : html`<div class="vp-photo vp-photo-empty" style=${{ width: `${w}px`, height: `${ph}px` }}><${Icon} name="image-off-outline" size=${32} /><span>${d.empty}</span></div>`}
    ${d.caption && html`<div class="vp-tiny vp-photo-cap">${d.caption}</div>`}
  </div>`;
}

const SECTIONS = {
  photo: Photo,
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
  cameras: Cameras,
  announcements: Announcements,
  guestWifi: GuestWifi,
  message: Message,
  bins: Bins,
  airQuality: AirQuality
};

// The panel's columns: a 250 px sidebar and the main column (a dotted
// divider between), three columns of 244 / 286 / 270, two halves, or one.
const COLS = { sidebar: '250px 550px', columns: '400px 400px', single: '800px', triple: '244px 286px 270px' };
// A wider screen (an E1004 at full size) lays the columns out in proportion,
// as the firmware does; the sidebar stays 250 px.
const colsFor = (tpl, W) =>
  W === 800 ? COLS[tpl] || '800px'
    : tpl === 'sidebar' ? `250px ${W - 250}px`
    : tpl === 'columns' ? `${W / 2}px ${W / 2}px`
    : tpl === 'triple' ? `${Math.round((W * 244) / 800)}px ${Math.round((W * 286) / 800)}px ${W - Math.round((W * 244) / 800) - Math.round((W * 286) / 800)}px`
    : `${W}px`;
const colWFor = (tpl, W) =>
  tpl === 'sidebar' ? [250, W - 260] : tpl === 'columns' ? [W / 2, W / 2 - 10] : tpl === 'triple' ? [Math.round((W * 240) / 800), Math.round((W * 278) / 800), W - Math.round((W * 534) / 800)] : [W - 20];

// The width a section is drawn at in each column, as the firmware's boxes.
const COL_W = { sidebar: [250, 540], columns: [400, 390], single: [780], triple: [240, 278, 266] };

function SectionsScreen({ d, highlight, portrait, W = portrait ? 480 : 800, H = portrait ? 800 : 480 }) {
  const all = d.columns.flat();
  const bg = d.background;
  // Portrait: the columns as bands one under the other.
  const style = portrait ? { gridTemplateColumns: `${W}px`, gridAutoRows: 'min-content', alignContent: 'start', height: `${H}px` } : { gridTemplateColumns: colsFor(d.template, W), height: `${H}px` };
  if (bg && bg.src) style.backgroundImage = `url(${artUrl(bg.src, W, H)})`;
  return html`<div class=${`vp-cols kd-${d.template} ${bg ? 'vp-photo-bg' : ''} ${portrait ? 'vp-portrait' : ''}`} style=${style}>
    ${bg && !bg.src && html`<div class="vp-photo-bg-empty"><${Icon} name="image-off-outline" size=${32} /><span>${bg.empty}</span></div>`}
    ${bg && bg.caption && html`<div class="vp-bg-cap">${bg.caption}</div>`}
    ${d.columns.map(
      (col, ci) => html`<div class="vp-col kd-col">
        ${col.map((s) => {
          if (s.type === 'message' && !(s.data && s.data.lines.length)) return null;
          if (s.type === 'spacer') return html`<div class=${highlight === s.id ? 'vp-hl' : ''} style=${{ height: `${s.data?.height ?? 0}px` }}></div>`;
          const Dash = DASH_SECTIONS[s.type];
          const drawn = Dash && s.data != null ? Dash({ d: s.data, title: s.title, siblings: all }) : null;
          if (drawn) return html`<div class=${`kd-section ${highlight === s.id ? 'vp-hl' : ''}`}>${drawn}</div>`;
          const S = SECTIONS[s.type];
          return html`<div class=${`vp-section kd-other ${highlight === s.id ? 'vp-hl' : ''}`}>
            <${Label}>${s.title}<//>
            ${S ? html`<${S} d=${s.data} w=${portrait ? W - 20 : colWFor(d.template, W)[ci] || 400} />` : null}
          </div>`;
        })}
      </div>`
    )}
  </div>`;
}

// Bookings over the next 1-3 hours: red blocks on a bar, ticks below.
function MeetingTimeline({ t }) {
  return html`<div class="vp-timeline">
    <div class="vp-tl-bar">
      ${t.blocks.map(
        (b) => html`<div class="vp-tl-block" style=${{ left: `${b.from * 100}%`, width: `${(b.to - b.from) * 100}%`, background: c(b.color) }}>
          <span>${b.title}</span>
        </div>`
      )}
    </div>
    <div class="vp-tl-ticks">
      ${t.ticks.map((k) => html`<span class="vp-tl-tick" style=${{ left: `${k.at * 100}%` }}>${k.label}</span>`)}
    </div>
  </div>`;
}

function MeetingClimate({ cl }) {
  return html`<div class="vp-meeting-climate">
    ${cl.temperature != null && html`<span class="vp-row"><${Icon} name="thermometer" size=${22} /><span class="vp-big">${cl.temperature}${cl.unit}</span></span>`}
    ${cl.humidity != null && html`<span class="vp-row"><${Icon} name="water-percent" size=${20} /><span class="vp-med">${cl.humidity}%</span></span>`}
    ${cl.co2 != null && html`<span class="vp-row" style=${{ color: c(cl.co2Color) }}><${Icon} name="molecule-co2" size=${22} /><span class="vp-med">${cl.co2} ppm</span></span>`}
  </div>`;
}

function MeetingRoom({ d }) {
  return html`<div class="vp-meeting">
    <div class="vp-meeting-band" style=${{ background: c(d.color) }}>
      <${Icon} name=${d.icon} size=${84} />
      <div class="vp-meeting-text">
        <div class="vp-meeting-name">${d.name}</div>
        <div class="vp-meeting-status">${d.label}</div>
        <div class="vp-meeting-until">${d.until}</div>
      </div>
    </div>
    ${d.timeline && html`<${MeetingTimeline} t=${d.timeline} />`}
    <div class=${`vp-meeting-body${d.climate ? ' with-climate' : ''}`}>
      ${d.current
        ? html`<div><div class="vp-label">Now</div><div class="vp-big">${d.current.title}</div><div class="vp-med">${d.current.time} · ends in ${d.current.endsInMin} min</div></div>`
        : d.next && html`<div><div class="vp-label">Next</div><div class="vp-big">${d.next.title}</div><div class="vp-med">${d.next.day} ${d.next.time}</div></div>`}
      ${d.upcoming.length > 0 &&
      html`<div><div class="vp-label">Later today</div>${d.upcoming.map((u) => html`<div class="vp-row vp-rowline"><span class="vp-med" style="width:140px">${u.time}</span><span class="vp-med">${u.title}</span></div>`)}</div>`}
    </div>
    ${d.climate && html`<${MeetingClimate} cl=${d.climate} />`}
  </div>`;
}

// The other rooms: free first, each with its status colour and icon.
function RoomFinder({ d, title }) {
  return html`<div class="vp-finder">
    <div class="vp-finder-head">
      <span class="vp-big">${title}</span>
      <span class="vp-med" style=${{ color: c(d.available ? 4 : 2) }}>${d.summary}</span>
    </div>
    ${d.rooms.length === 0 && html`<div class="vp-med" style=${{ color: GREY }}>${d.total ? 'No rooms free right now' : 'Add rooms to this screen'}</div>`}
    ${d.rooms.map(
      (r) => html`<div class="vp-finder-row">
        <span class="vp-finder-icon" style=${{ background: c(r.color) }}><${Icon} name=${r.icon} size=${30} /></span>
        <span class="vp-finder-name">${r.name}</span>
        <span class="vp-finder-status">
          <span class="vp-med" style=${{ color: c(r.color) }}>${r.label}</span>
          <span class="vp-small">${r.until}</span>
        </span>
      </div>`
    )}
  </div>`;
}

// Scales the 800×480 panel to the width available.
// A photo frame: the photo filling the screen, a few lines over it in white
// (outlined, as the panel draws them), in one corner; the caption last, small.
function PhotoFrame({ d, W, H }) {
  const big = d.size === 'large';
  const top = d.corner === 'topLeft' || d.corner === 'topRight';
  const right = d.corner === 'bottomRight' || d.corner === 'topRight';
  return html`<div class="vp-frame" style=${{ width: `${W}px`, height: `${H}px`, backgroundImage: d.src ? `url(${artUrl(d.src, W, H)})` : 'none' }}>
    ${!d.src && html`<div class="vp-photo-bg-empty"><${Icon} name="image-off-outline" size=${32} /><span>${d.empty}</span></div>`}
    <div class=${`vp-frame-text ${big ? 'big' : ''} ${d.outline === false ? 'plain' : ''}`} style=${{ [top ? 'top' : 'bottom']: '14px', [right ? 'right' : 'left']: '16px', textAlign: right ? 'right' : 'left', alignItems: right ? 'flex-end' : 'flex-start' }}>
      ${d.lines.map((l) => html`<div class=${l.big ? 'vp-frame-big' : 'vp-frame-line'}>${l.icon && html`<${Icon} name=${l.icon} size=${big ? 32 : 24} />`}<span>${l.text}</span></div>`)}
      ${d.caption && html`<div class="vp-frame-cap">${d.caption}</div>`}
    </div>
  </div>`;
}

// The screen's size: a viewport (E1002) 800x480; an E1004 800x600 when it
// shows the layout large, 1600x1200 when small. Portrait: turned.
export function screenSize(device, portrait) {
  const [w, h] = device === 'e1004-small' ? [1600, 1200] : device === 'e1004-large' ? [800, 600] : [800, 480];
  return portrait ? [h, w] : [w, h];
}

export function ViewportPreview({ screen, state, error, loading, highlight, carousel, portrait = false, device = 'e1002' }) {
  const wrap = useRef(null);
  const [scale, setScale] = useState(1);
  const [W, H] = screenSize(device, portrait);
  useEffect(() => {
    if (!wrap.current) return undefined;
    // A portrait panel is shown at most 600 px tall.
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / W, portrait ? 600 / H : 1)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [W, H, portrait]);
  const d = state && state.screens && state.screens[screen];
  return html`<div class="vp-wrap" ref=${wrap} style=${{ height: `${H * scale}px` }}>
    <div class=${`vp-panel ${portrait ? 'vp-panel-portrait' : ''}`} style=${{ transform: `scale(${scale})`, width: `${W}px`, height: `${H}px` }}>
      ${d
        ? d.kind === 'meetingRoom'
          ? html`<${MeetingRoom} d=${d.data} />`
          : d.kind === 'roomFinder'
          ? html`<${RoomFinder} d=${d.data} title=${d.title} />`
          : d.kind === 'photoFrame'
          ? html`<${PhotoFrame} d=${d.data} W=${W} H=${H} />`
          : html`<${SectionsScreen} key=${screen} d=${d} highlight=${highlight} portrait=${portrait} W=${W} H=${H} />`
        : html`<div class="vp-empty">${error ? error : loading ? 'Loading…' : 'No preview'}</div>`}
      ${d && d.kind === 'sections' && html`<${DashFooter} generatedAt=${state.generatedAt} quiet=${state.quiet} carousel=${carousel} current=${screen} />`}
      ${loading && d && html`<div class="vp-loading"><${Icon} name="refresh" size=${16} /></div>`}
    </div>
  </div>`;
}
