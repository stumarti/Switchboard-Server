// A true-size (800×480) preview of a viewport screen in the panel's six
// colours, drawn from the same evaluated state the device receives
// (/api/viewports/:mac/preview). Close to the device's own layout, not
// pixel-exact: it's for checking what shows and in which colour.

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

const Label = ({ children }) => html`<div class="vp-label">${children}</div>`;
const Bar = ({ pct, color }) => html`<div class="vp-bar"><div style=${{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, background: c(color) }}></div></div>`;

function Footer({ generatedAt }) {
  const t = generatedAt ? new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
  return html`<div class="vp-footer">updated ${t}</div>`;
}

// --- Screens ------------------------------------------------------------------------

function Main({ d }) {
  const w = d.weather;
  const e = d.energy;
  const b = d.battery;
  return html`<div class="vp-split">
    <div class="vp-left">
      ${w
        ? html`<div class="vp-zone">
            <div class="vp-row">
              <div class="vp-huge">${deg(w.temperature)}</div>
              <${Icon} name=${weatherIcon(w.condition)} size=${56} />
            </div>
            <div class="vp-small">feels ${deg(w.feelsLike)} · ${w.humidity ?? '--'}% · ${w.windSpeed ?? '--'} ${w.windUnit}</div>
            <div class="vp-forecast">
              ${w.forecast.map(
                (f) => html`<div><div class="vp-tiny">${f.label}</div><${Icon} name=${weatherIcon(f.condition)} size=${22} /><div class="vp-small">${deg(f.high)}</div></div>`
              )}
            </div>
          </div>`
        : html`<div class="vp-zone vp-muted">No weather entity</div>`}
      <div class="vp-zone vp-grid2">
        <div><${Icon} name="solar-power-variant" size=${20} /><div class="vp-med" style=${{ color: c(3) }}>${val(e.solarToday)}</div><div class="vp-tiny">of ${val(e.solarExpected)}</div></div>
        <div><${Icon} name="home-lightning-bolt-outline" size=${20} /><div class="vp-med">${val(e.loadToday)}</div><div class="vp-tiny">load</div></div>
        <div><${Icon} name="transmission-tower-export" size=${20} /><div class="vp-med" style=${{ color: c(4) }}>${val(e.gridExport)}</div><div class="vp-tiny">export</div></div>
        <div><${Icon} name="transmission-tower-import" size=${20} /><div class="vp-med">${val(e.gridImport)}</div><div class="vp-tiny">import</div></div>
      </div>
      ${b &&
      html`<div class="vp-zone">
        <div class="vp-row"><${Icon} name=${b.status === 'charging' ? 'battery-charging' : 'battery'} size=${28} /><div class="vp-big" style=${{ color: c(b.color) }}>${b.soc ?? '--'}%</div></div>
        <${Bar} pct=${b.soc} color=${b.color} />
        <div class="vp-small">${b.status || '—'}${b.eta ? ` · ${b.eta}` : ''}</div>
      </div>`}
    </div>
    <div class="vp-right">
      <div class="vp-iconbar">
        ${d.statusIcons.map((s) => html`<span title=${`${s.name}: ${s.state || 'unknown'}`} style=${{ color: c(s.color) }}><${Icon} name=${s.icon || 'help'} size=${34} /></span>`)}
      </div>
      <div class="vp-alerts">
        ${d.alerts.lines.map((l) => html`<div class="vp-med" style=${{ color: c(l.color) }}>${l.text}</div>`)}
        ${d.alerts.overflow > 0 && html`<div class="vp-small">+ ${d.alerts.overflow} more...</div>`}
        ${d.alerts.allClear && html`<div class="vp-med" style=${{ color: c(4) }}><${Icon} name="check-circle-outline" size=${20} /> All clear</div>`}
      </div>
      <div class="vp-cal">
        ${d.calendar.map((l) => html`<div class="vp-med" style=${{ color: c(5) }}>${l.text}</div>`)}
      </div>
    </div>
  </div>`;
}

function Climate({ d }) {
  const hp = d.heatPump;
  return html`<div class="vp-pad">
    ${hp &&
    html`<div class="vp-hp">
      <div class="vp-row"><${Icon} name="heat-pump-outline" size=${30} /><div class="vp-big">Heat Pump</div></div>
      <div class="vp-hp-grid">
        <div><div class="vp-tiny">Mode</div><div class="vp-med">${hp.action || hp.mode || '—'}</div></div>
        <div><div class="vp-tiny">Outside</div><div class="vp-med">${hp.outside == null ? '--' : `${hp.outside}°`}</div></div>
        <div><div class="vp-tiny">Setpoint</div><div class="vp-med">${deg(hp.setpoint)}</div></div>
        <div><div class="vp-tiny">COP</div><div class="vp-med">${hp.cop ?? '--'}</div></div>
      </div>
      <div class="vp-med"><b style=${{ color: c(2) }}>${d.calling}</b> of ${d.total} rooms calling</div>
    </div>`}
    <${Label}>Room climate<//>
    ${d.rooms.map(
      (r) => html`<div class="vp-room">
        <span class="vp-med" style="width:150px">${r.name}</span>
        <span class="vp-med" style=${{ width: '140px', color: c(r.color) }}>${r.temperature == null ? '--' : `${r.temperature}°`}${r.target != null ? html` <span class="vp-small">→ ${r.target}°</span>` : ''}</span>
        <div class="vp-delta">
          <div class="vp-delta-mid"></div>
          ${r.delta != null &&
          html`<div style=${{
            position: 'absolute',
            top: '3px',
            bottom: '3px',
            background: c(r.color),
            left: `${50 + Math.min(0, Math.max(-5, r.delta)) * 10}%`,
            width: `${Math.abs(Math.max(-5, Math.min(5, r.delta))) * 10}%`
          }}></div>`}
        </div>
      </div>`
    )}
  </div>`;
}

function RoomList({ rooms }) {
  const floors = ['upstairs', 'downstairs'];
  return floors.map((f) => {
    const list = rooms.filter((r) => r.floor === f);
    if (!list.length) return null;
    return html`<div>
      <${Label}>${f}<//>
      ${list.map(
        (r) => html`<div class="vp-row vp-roomrow">
          <${Icon} name=${r.icon || 'home-outline'} size=${20} />
          <span class="vp-small" style="flex:1">${r.name}</span>
          <span class="vp-med">${deg(r.temperature)}</span>
          <span class="vp-tiny" style=${{ color: c(5), width: '34px', textAlign: 'right' }}>${r.humidity == null ? '' : `${Math.round(r.humidity)}%`}</span>
        </div>`
      )}
    </div>`;
  });
}

function Presence({ d }) {
  return html`<div class="vp-split">
    <div class="vp-left"><${RoomList} rooms=${d.rooms} /></div>
    <div class="vp-right vp-pad">
      ${d.people.length > 0 &&
      html`<${Label}>Presence<//>
        <div class="vp-row" style="gap:16px;flex-wrap:wrap">
          ${d.people.map((p) => html`<span class="vp-med" style=${{ color: p.home ? c(4) : GREY }}><${Icon} name=${p.home ? 'account' : 'account-outline'} size=${20} /> ${p.name}</span>`)}
        </div>`}
      <${Label}>Now playing<//>
      ${d.media.length
        ? d.media.map(
            (m) => html`<div class="vp-row" style="align-items:flex-start">
              <span style=${{ color: c(5) }}><${Icon} name=${m.icon || 'music'} size=${24} /></span>
              <div><div class="vp-tiny">${m.room}${m.app ? ` · ${m.app}` : ''}</div><div class="vp-med">${m.title}</div><div class="vp-small">${m.artist}</div></div>
            </div>`
          )
        : html`<div class="vp-small vp-muted">Nothing playing</div>`}
      ${d.transport.length > 0 &&
      html`<${Label}>Next departures<//>
        ${d.transport.map(
          (t) => html`<div class="vp-row" style="align-items:flex-start;margin-bottom:6px">
            <span style=${{ color: c(t.color) }}><${Icon} name=${t.icon || 'bus'} size=${24} /></span>
            <div style="flex:1"><div class="vp-med">${t.name}</div><div class="vp-tiny">${t.stop}</div></div>
            ${t.departures.map(
              (x) => html`<div style="width:70px;text-align:right"><div class="vp-small">${x.time}</div><div class="vp-med" style=${{ color: c(x.color) }}>${x.text}</div></div>`
            )}
          </div>`
        )}`}
    </div>
  </div>`;
}

function Security({ d }) {
  const a = d.alarm;
  const col = (title, list, render) =>
    list.length > 0 &&
    html`<div><${Label}>${title}<//>${list.map(render)}</div>`;
  const openRow = (x) => html`<div class="vp-row vp-roomrow"><span class="vp-small" style="flex:1">${x.name}</span><span class="vp-small" style=${{ color: c(x.color) }}>${x.state}</span><span class="vp-tiny" style="width:60px;text-align:right">${x.when}</span></div>`;
  return html`<div class="vp-pad">
    <div class="vp-row" style="gap:24px;align-items:flex-start">
      ${a &&
      html`<div style="min-width:220px">
        <div class="vp-row" style=${{ color: c(a.color) }}><${Icon} name="shield-home" size=${40} /><div class="vp-big">${a.label}</div></div>
        <div class="vp-small">since ${a.since || '—'}</div>
      </div>`}
      <div class="vp-small" style="flex:1">
        ${d.summary.doors > 0 && html`<div>${plural(d.summary.doors, 'door')} — ${d.summary.doorsOpen ? html`<b style=${{ color: c(2) }}>${d.summary.doorsOpen} open</b>` : 'all closed'}</div>`}
        ${d.summary.windows > 0 && html`<div>${plural(d.summary.windows, 'window')} — ${d.summary.windowsOpen ? html`<b style=${{ color: c(2) }}>${d.summary.windowsOpen} open</b>` : 'all closed'}</div>`}
        <div>${plural(d.summary.motion, 'motion sensor')} · ${plural(d.summary.cameras, 'camera')}</div>
      </div>
      <div class="vp-small">
        ${d.last.armed && html`<div>Last armed ${d.last.armed}</div>`}
        ${d.last.disarmed && html`<div>Last disarmed ${d.last.disarmed}</div>`}
        ${d.last.triggered && html`<div>Last triggered ${d.last.triggered}</div>`}
      </div>
    </div>
    <div class="vp-cols">
      ${col('Doors', d.doors, openRow)}
      ${col('Windows', d.windows, openRow)}
      ${col('Motion', d.motion, (m) => html`<div class="vp-row vp-roomrow"><span class="vp-small" style=${{ flex: 1, color: c(m.color) }}>${m.name}</span><span class="vp-tiny">${m.when}</span></div>`)}
      ${col('Cameras', d.cameras, (m) => html`<div class="vp-row vp-roomrow"><span class="vp-small" style="flex:1">${m.name}</span><span class="vp-tiny">${m.when || '—'}</span></div>`)}
    </div>
  </div>`;
}

const SCREENS = { main: Main, climate: Climate, presence: Presence, security: Security };

// Scales the 800×480 panel to the width available.
export function ViewportPreview({ screen, state, error, loading }) {
  const wrap = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / 800)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const Screen = SCREENS[screen];
  const data = state && state.screens && state.screens[screen];
  return html`<div class="vp-wrap" ref=${wrap} style=${{ height: `${480 * scale}px` }}>
    <div class="vp-panel" style=${{ transform: `scale(${scale})` }}>
      ${data && Screen ? html`<${Screen} d=${data} />` : html`<div class="vp-empty">${error ? error : loading ? 'Loading…' : 'No preview'}</div>`}
      ${data && html`<${Footer} generatedAt=${state.generatedAt} />`}
      ${loading && data && html`<div class="vp-loading"><${Icon} name="refresh" size=${16} /></div>`}
    </div>
  </div>`;
}
