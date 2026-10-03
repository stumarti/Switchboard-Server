// The sections the kitchen dashboard draws, as the wall panel draws them:
// the same places, sizes and colours as the Switchboard-Viewport firmware
// (src/render/*.cpp, ported from the panel's own screens), so the builder's
// preview looks like the panel. Measurements are the firmware's, in panel
// pixels; text uses Atkinson Hyperlegible where the browser has it.

import { html, Icon } from './lib.js';
import { builtInArt } from './viewport-art.js';

export const KD = {
  0: '#ffffff',
  1: '#111111',
  2: '#c62828',
  3: '#e0b400',
  4: '#2e7d32',
  5: '#1565c0'
};
const k = (i) => KD[i] || KD[1];

const WEATHER_ICON = {
  sunny: 'weather-sunny',
  'clear-night': 'weather-night',
  partlycloudy: 'weather-partly-cloudy',
  'night-partlycloudy': 'weather-night-partly-cloudy',
  cloudy: 'weather-cloudy',
  rainy: 'weather-rainy',
  pouring: 'weather-pouring',
  lightning: 'weather-lightning',
  'lightning-rainy': 'weather-lightning-rainy',
  snowy: 'weather-snowy',
  'snowy-rainy': 'weather-snowy-rainy',
  hail: 'weather-hail',
  fog: 'weather-fog',
  windy: 'weather-windy',
  'windy-variant': 'weather-windy-variant',
  exceptional: 'alert-circle-outline'
};
const wxIcon = (c) => WEATHER_ICON[c] || 'weather-cloudy';
// The eight wind arrows, by where the wind comes from.
const WIND = ['arrow-up', 'arrow-top-right', 'arrow-right', 'arrow-bottom-right', 'arrow-down', 'arrow-bottom-left', 'arrow-left', 'arrow-top-left'];
const windIcon = (b) => (b == null ? 'arrow-up' : WIND[Math.round((((b % 360) + 360) % 360) / 45) % 8]);

// Text at a baseline, as the firmware places it (GFX fonts: y is the
// baseline). `size` is the face: 18 regular, 18/24/82 bold.
// (The panel's built-in 9pt "bold" is the regular face — it always was — so
// 18 px bold text draws regular here too, as on the device.)
function T({ x, y, size = 18, bold, color = 1, right, center, w, children, style }) {
  const s = {
    position: 'absolute',
    top: `${y}px`,
    font: `${bold && size > 18 ? 700 : 400} ${size}px/1 'Atkinson Hyperlegible', system-ui, sans-serif`,
    color: k(color),
    whiteSpace: 'nowrap',
    transform: 'translateY(-80%)',
    ...style
  };
  if (right != null) s.right = `${right}px`;
  else if (center) Object.assign(s, { left: `${x}px`, width: `${w}px`, textAlign: 'center' });
  else s.left = `${x}px`;
  return html`<div style=${s}>${children}</div>`;
}
const I = ({ x, y, name, size, color = 1 }) =>
  html`<span style=${{ position: 'absolute', left: `${x}px`, top: `${y}px`, color: k(color), lineHeight: 0 }}><${Icon} name=${name} size=${size} /></span>`;
// The panel's own colour art for a slot (the weather icons, solar), else
// the MDI icon in one colour.
const Art = ({ x, y, slot, name, size, color = 1 }) => {
  const src = builtInArt(slot);
  return src
    ? html`<img src=${src} width=${size} height=${size} style=${{ position: 'absolute', left: `${x}px`, top: `${y}px`, imageRendering: 'pixelated' }} alt="" />`
    : html`<${I} x=${x} y=${y} name=${name} size=${size} color=${color} />`;
};
// As the panel picks it: the condition's art, else the cloud.
const wxSlot = (c, small) => {
  const slot = `${small ? 'vwxm' : 'vwx'}_${String(c || 'cloudy').replace(/-/g, '_')}`;
  return builtInArt(slot) ? slot : `${small ? 'vwxm' : 'vwx'}_cloudy`;
};
const Box = ({ x, y, w, h, color = 1, border }) =>
  html`<div style=${{ position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, ...(border ? { border: `1px solid ${k(color)}` } : { background: k(color) }) }}></div>`;

// --- Status screen, left column (x 5..240) ------------------------------------------

export function DashWeather({ d }) {
  if (!d) return html`<div class="kd-block" style="height:262px"><${T} x=${5} y=${40}>No weather entity<//></div>`;
  const t = Number(d.temperatureText);
  const tCol = t < 0 ? 5 : t > 20 ? 2 : 1;
  const cell = 80;
  const rain = d.rain && d.rain.state !== 'dry' ? d.rain : null;
  return html`<div class="kd-block" style="height:262px">
    <${T} x=${5} y=${70} size=${82} bold color=${tCol}>${d.temperatureText}<span class="kd-deg" style=${{ borderColor: k(tCol) }}></span><//>
    <${Art} x=${152} y=${2} slot=${wxSlot(d.icon)} name=${wxIcon(d.icon)} size=${88} />
    <${I} x=${10} y=${88} name="water-percent" size=${24} /><${T} x=${36} y=${106}>${d.humidityText}%<//>
    <${I} x=${10 + cell} y=${88} name="weather-windy" size=${24} /><${T} x=${36 + cell} y=${106}>${d.windText}<${Icon} name=${windIcon(d.bearing)} size=${18} /><//>
    <${I} x=${10 + cell * 2} y=${88} name="sun-wireless" size=${24} /><${T} x=${36 + cell * 2} y=${106}>${d.uvText}<//>
    ${rain
      ? html`<${I} x=${5} y=${116} name="water" size=${24} color=${5} /><${T} x=${33} y=${132} bold color=${5}>${rain.text}<//>`
      : d.solar && html`<${I} x=${5} y=${116} name="solar-panel" size=${24} /><${T} x=${33} y=${132} bold>${d.solar.text}<//>`}
    ${(d.forecast || []).slice(0, 3).map(
      (f, i) => html`<${T} x=${5 + i * cell} w=${cell} center y=${163} bold>${f.label}<//>
        <${Art} x=${5 + i * cell + 24} y=${166} slot=${wxSlot(f.condition, true)} name=${wxIcon(f.condition)} size=${32} />
        <${T} x=${5 + i * cell} w=${cell} center y=${210} bold>${f.high == null ? '--' : Math.round(f.high)}<//>`
    )}
  </div>`;
}

export function DashEnergy({ d }) {
  const cell = (icon, m, accent, x, y, slot) => {
    const v = m ? m.value : null;
    const on = v != null && v >= 1;
    const col = on ? accent : 1;
    // Solar is the panel's two-colour art: yellow and black once it's made
    // 1 kWh, all black before.
    const art = slot ? html`<${Art} x=${x + 36} y=${y} slot=${on ? slot : `${slot}_off`} name=${icon} size=${44} color=${col} />` : html`<${I} x=${x + 36} y=${y} name=${icon} size=${44} color=${col} />`;
    return html`${art}<${T} x=${x} w=${117} center y=${y + 57}>${m ? m.text : 'n/a'}<//>`;
  };
  return html`<div class="kd-block" style="height:170px">
    ${cell('solar-power-variant', d.solarToday, 3, 5, 6, 've_solar')}
    ${cell('home-lightning-bolt-outline', d.loadToday, 5, 122, 6)}
    ${cell('transmission-tower-import', d.gridImport, 2, 5, 77)}
    ${cell('transmission-tower-export', d.gridExport, 4, 122, 77)}
  </div>`;
}

export function DashBattery({ d }) {
  if (!d) return html`<div class="kd-block" style="height:48px"></div>`;
  const pct = Math.max(0, Math.min(100, d.soc || 0));
  // The status and time raised as the display has them, clear of the bar.
  return html`<div class="kd-block" style="height:48px">
    <${I} x=${5} y=${-4} name="battery-high" size=${24} />
    <${T} x=${32} y=${16} size=${24} bold>${d.socText || (d.soc == null ? '--' : `${d.soc} %`)}<//>
    <${T} right=${20} y=${1} bold color=${d.color}>${d.statusText}<//>
    ${d.eta && html`<${T} right=${20} y=${19}>${d.eta}<//>`}
    <${Box} x=${5} y=${23} w=${225} h=${22} border />
    <${Box} x=${230} y=${28} w=${6} h=${12} />
    ${pct > 0 && html`<${Box} x=${8} y=${26} w=${Math.round((219 * pct) / 100)} h=${16} color=${d.color} />`}
  </div>`;
}

// --- Status screen, right column (x 260..800) -----------------------------------------

export function DashStatusIcons({ d }) {
  return html`<div class="kd-block kd-statusbar" style="height:50px">
    ${d.icons.slice(0, 9).map((s, i) => html`<${I} x=${14 + i * 59} y=${9} name=${s.icon || 'help'} size=${32} color=${s.color} />`)}
  </div>`;
}

const NowItem = ({ icon, color, line1, line2 }) => html`<div class="kd-item">
  <${Box} x=${0} y=${0} w=${4} h=${40} color=${color} />
  <${I} x=${6} y=${8} name=${icon} size=${24} color=${color} />
  <${T} x=${36} y=${17} size=${24} bold color=${color}>${line1}<//>
  ${line2 && html`<${T} x=${36} y=${33}>${line2}<//>`}
</div>`;

export function DashNow({ d, title }) {
  return html`<div class="kd-list">
    <div class="kd-heading" style="height:24px"><${T} x=${8} y=${16}>${(title || 'Now').toUpperCase()}<//></div>
    ${d.items.map((it) => html`<${NowItem} ...${it} />`)}
  </div>`;
}

export function DashCalendar({ d, title }) {
  return html`<div class="kd-list kd-cal">
    <div class="kd-heading" style="height:21px"><${T} x=${8} y=${16}>${(title || 'Today').toUpperCase()}<//></div>
    ${d.lines.length === 0
      ? html`<div class="kd-item" style="height:20px"><${T} x=${10} y=${10}>No events today<//></div>`
      : d.lines.map(
          (l) => html`<div class="kd-item">
            <${Box} x=${0} y=${0} w=${4} h=${40} color=${l.color || 1} />
            <${T} x=${10} y=${17} size=${24} bold color=${l.color || 1}>${l.time ? `${l.time} ` : '· '}${l.title}<//>
            ${l.description && html`<${T} x=${l.time ? 82 : 26} y=${33}>${l.description}<//>`}
          </div>`
        )}
  </div>`;
}

// --- Heating screen (whole panel) ---------------------------------------------------------

export function DashHeating({ d }) {
  const span = d.scaleMax - d.scaleMin || 1;
  const X0 = 324;
  const W = 800 - X0 - 20 - 22 - 6;
  const xOf = (t) => X0 + Math.round(Math.max(0, Math.min(1, (t - d.scaleMin) / span)) * (W - 1));
  const w = d.water;
  const hot = w && w.on;
  return html`<div class="kd-screen">
    <${Box} x=${0} y=${0} w=${300} h=${360} color=${d.on ? 2 : 1} />
    <${I} x=${118} y=${24} name="fire" size=${64} color=${0} />
    <${T} x=${0} w=${300} center y=${116} size=${24} bold color=${0}>HEATING<//>
    <${T} x=${0} w=${300} center y=${200} size=${82} bold color=${0}>${d.on ? 'ON' : 'OFF'}<//>
    ${d.current != null && html`<${T} x=${0} w=${300} center y=${250} size=${24} bold color=${0}>${d.current.toFixed(1)}C now<//>`}
    ${d.target != null && html`<${T} x=${0} w=${300} center y=${282} size=${24} bold color=${0}>Set ${d.target.toFixed(1)}C<//>`}
    <${T} x=${0} w=${300} center y=${322} size=${24} bold color=${0}>${d.calling} of ${d.total} calling<//>
    <${Box} x=${0} y=${360} w=${300} h=${120} color=${hot ? 2 : 1} />
    <${I} x=${14} y=${388} name="water" size=${64} color=${0} />
    <${T} x=${90} y=${410} size=${24} bold color=${0}>HOT WATER<//>
    ${w && html`<${T} x=${90} y=${438} bold color=${0}>${w.current ?? '--'}C  ·  set ${w.target ?? '--'}C<//>`}
    <${T} x=${X0} y=${16} bold>${d.scaleMin}C<//>
    <${T} right=${800 - X0 - W} y=${16} bold>${d.scaleMax}C<//>
    ${d.zones.map((z, i) => {
      const y = 28 + i * 52;
      const by = y + 24;
      const hasBoth = z.current != null && z.target != null;
      const xc = z.current != null ? xOf(z.current) : null;
      const xs = z.target != null ? xOf(z.target) : null;
      // An icon (if the zone has one) beside the name, centred on its capitals.
      const nameX = z.icon ? X0 + 30 : X0;
      return html`${z.icon && html`<${I} x=${X0} y=${y - 5} name=${z.icon} size=${24} color=${z.active ? 2 : 1} />`}
        <${T} x=${nameX} y=${y + 14} size=${24} bold color=${z.active ? 2 : 1}>${z.name}<//>
        <${T} right=${800 - X0 - W} y=${y + 14}>${z.current != null ? `${z.current.toFixed(1)}C` : ''}${z.target != null ? `  set ${Math.round(z.target)}C` : ''}<//>
        <${Box} x=${X0} y=${by} w=${W} h=${12} border />
        ${hasBoth && Math.abs(xc - xs) > 1 && html`<${Box} x=${Math.min(xc, xs) + 1} y=${by + 1} w=${Math.abs(xc - xs) - 1} h=${10} color=${z.current < z.target ? 2 : 5} />`}
        ${xs != null ? html`<${Box} x=${xs} y=${by - 3} w=${2} h=${18} />` : xc != null && html`<${Box} x=${xc - 1} y=${by - 3} w=${3} h=${18} />`}
        <${I} x=${X0 + W + 4} y=${by - 4} name="fire" size=${20} color=${z.active ? 2 : 1} />`;
    })}
  </div>`;
}

// --- Security screen: alarm | doors, windows | motion, cameras --------------------------

const SUMMARY_ICON = { Doors: 'door', Windows: 'window-closed-variant', Motion: 'motion-sensor', Cameras: 'cctv' };

export function DashAlarm({ d, siblings }) {
  if (!d) return html`<div>No alarm panel</div>`;
  const disarmed = d.state === 'disarmed';
  const rows = [];
  if (d.summary) {
    for (const s of siblings || []) {
      if (s.type === 'openings') {
        const n = s.data.total;
        const open = s.data.open;
        const isWin = /window/i.test(s.title);
        const text = isWin
          ? `${open} window${open === 1 ? '' : 's'}${open === 0 ? ' — all closed' : ' open'}`
          : `${n} ${(s.title || 'doors').toLowerCase()} — ${open === 0 ? 'all closed' : `${open} open`}`;
        rows.push([isWin ? SUMMARY_ICON.Windows : SUMMARY_ICON.Doors, text, open > 0 ? 2 : 1]);
      } else if (s.type === 'motion') rows.push([SUMMARY_ICON.Motion, `${s.data.sensors.length} motion sensors`, 1]);
      else if (s.type === 'cameras') rows.push([SUMMARY_ICON.Cameras, `${s.data.cameras.length} cameras`, 1]);
    }
  }
  return html`<div class="kd-screen">
    <${Box} x=${0} y=${0} w=${240} h=${100} color=${disarmed ? 4 : 2} />
    <${I} x=${12} y=${18} name=${disarmed ? 'shield-check' : 'shield-alert'} size=${64} color=${0} />
    <${T} x=${86} y=${46} size=${24} bold color=${0}>${disarmed ? 'DISARMED' : 'ARMED'}<//>
    <${T} x=${86} y=${68} color=${0}>since ${d.sinceTime}<//>
    ${rows.map(([icon, text, col], i) => html`<${I} x=${12} y=${116 + i * 30} name=${icon} size=${20} color=${col} /><${T} x=${38} y=${131 + i * 30} color=${col}>${text}<//>`)}
  </div>`;
}

function SecRows({ title, rows, icon, width }) {
  return html`<div class="kd-sec">
    <div class="kd-sec-head">${(title || '').toUpperCase()}</div>
    ${rows.map(
      (r) => html`<div class="kd-sec-row">
        <${Box} x=${0} y=${2} w=${4} h=${24} color=${r.on ? 2 : 4} />
        <${I} x=${8} y=${4} name=${icon} size=${20} color=${r.on ? 2 : 4} />
        <${T} x=${32} y=${18} bold color=${r.on ? 2 : 4}>${r.name}<//>
        ${r.time && html`<${T} right=${4} y=${18}>${r.time}<//>`}
      </div>`
    )}
  </div>`;
}

export const DashOpenings = ({ d, title }) =>
  html`<${SecRows} title=${title || 'Doors'} icon=${/window/i.test(title) ? 'window-closed-variant' : 'door'} rows=${d.items.map((x) => ({ name: x.name, on: x.open, time: x.time }))} />`;
export const DashMotion = ({ d, title }) => html`<${SecRows} title=${title || 'Motion'} icon="motion-sensor" rows=${d.sensors.map((x) => ({ name: x.name, on: x.on, time: x.time }))} />`;
export const DashCameras = ({ d, title }) => html`<${SecRows} title=${title || 'Cameras'} icon="cctv" rows=${d.cameras.map((x) => ({ name: x.name, on: x.on, time: x.time }))} />`;

// The sections drawn in the panel's own style, and the screens laid out as
// it lays them out.
export const DASH_SECTIONS = {
  weather: DashWeather,
  energy: (p) => (p.d.style === 'list' ? null : html`<${DashEnergy} ...${p} />`),
  battery: DashBattery,
  statusIcons: DashStatusIcons,
  now: DashNow,
  calendar: DashCalendar,
  heating: DashHeating,
  alarm: DashAlarm,
  openings: DashOpenings,
  motion: DashMotion,
  cameras: DashCameras
};

// The footer, as the panel draws it: the carousel's screens (the one
// showing underlined), the refresh icon and time, the device's battery; the
// bed-and-clock while quiet hours are on.
export function DashFooter({ generatedAt, quiet, carousel, current }) {
  const t = generatedAt ? new Date(generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
  const marks = carousel && carousel.length > 1 ? carousel : [];
  return html`<div class="kd-footer">
    ${marks.map((m) => html`<span class=${`kd-mark ${m.id === current ? 'on' : ''}`}><${Icon} name=${m.icon || 'view-dashboard-outline'} size=${16} /></span>`)}
    ${quiet && html`<span style=${{ color: k(5) }}><${Icon} name="bed-clock" size=${16} /></span>`}
    <${Icon} name="refresh" size=${16} />
    <span>${t}</span>
    <span style=${{ color: k(4), marginLeft: '10px' }}><${Icon} name="battery" size=${24} /></span>
    <span style=${{ color: k(4) }}>100%</span>
  </div>`;
}
