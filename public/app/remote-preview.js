// A preview of a remote's screen, beside the page being edited in the room
// editor (a carousel page, or Quick Access). It's a mock of
// the remote's 480×800 black-and-white e-ink screen, drawn from the room as
// it stands in the editor (saved or not) and the state the remote would get
// for it (POST /api/devices/:slug/state/preview). Close to the firmware's own
// drawing (the screen_*.h headers), not pixel-exact: it's for checking what
// each page shows and what's missing before a remote picks the room up.

import { html, useState, useEffect, api, useApi, Icon } from './lib.js';

const W = 480;
const H = 800;

const PAGE_LABELS = {
  status: 'Status', lighting: 'Lighting', blinds: 'Blinds', music: 'Music', tv: 'TV',
  xbox: 'Xbox', wifi: 'Guest Wi-Fi', climate: 'Climate', receiver: 'Receiver', quick: 'Quick Access'
};
// Quick Access's built-in grid (a room with no hub buttons): the firmware's kJumpItems.
const JUMP_ITEMS = [
  ['status', 'Status', 'home-outline'], ['lighting', 'Lighting', 'lightbulb-group-outline'], ['blinds', 'Blinds', 'blinds'],
  ['music', 'Music', 'music-circle-outline'], ['tv', 'TV', 'television'], ['xbox', 'Xbox', 'microsoft-xbox'],
  ['wifi', 'Wifi', 'wifi-star'], ['climate', 'Climate', 'thermostat'], ['receiver', 'Receiver', 'satellite-variant'],
  ['settings', 'Settings', 'cog-outline']
];
const HUB_TARGET_ICONS = {
  status: 'home-outline', lighting: 'lightbulb-group-outline', blinds: 'blinds', media: 'music-circle-outline', music: 'music-circle-outline',
  tv: 'television', xbox: 'microsoft-xbox', guestwifi: 'wifi-star', wifi: 'wifi-star', climate: 'thermostat',
  receiver: 'satellite-variant', settings: 'cog-outline'
};
const WEATHER_ICONS = {
  'clear-night': 'weather-night', cloudy: 'weather-cloudy', fog: 'weather-fog', hail: 'weather-hail',
  lightning: 'weather-lightning', 'lightning-rainy': 'weather-lightning-rainy', partlycloudy: 'weather-partly-cloudy',
  pouring: 'weather-pouring', rainy: 'weather-rainy', snowy: 'weather-snowy', 'snowy-rainy': 'weather-snowy-rainy',
  sunny: 'weather-sunny', windy: 'weather-windy', 'windy-variant': 'weather-windy-variant'
};
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const deg = (v) => (v == null || Number.isNaN(Number(v)) ? '--' : `${Math.round(Number(v) * 10) / 10}°`);
const artUrl = (src, w, h, fit = 'cover') =>
  `/api/art?src=${encodeURIComponent(src)}&w=${w}&h=${h}&fmt=mask1png${fit === 'contain' ? '&fit=contain' : ''}`;

// --- small pieces the firmware reuses across pages ------------------------------------

function Empty({ title, sub }) {
  return html`<div class="rp-empty"><div class="rp-t24">${title}</div>${sub && html`<div class="rp-t16 rp-grey">${sub}</div>`}</div>`;
}
function Toggle({ on }) {
  return html`<span class=${`rp-toggle ${on ? 'on' : ''}`}><span></span></span>`;
}
// The 2×6 chip grid (Lighting's scenes/lights, Blinds' items).
function Chips({ items, selected = -1, bulbs, max = 12 }) {
  return html`<div class="rp-chips">
    ${items.slice(0, max).map(
      (it, i) => html`<div class=${`rp-chip ${i === selected ? 'sel' : ''}`}>
        ${(it.icon || bulbs) && html`<${Icon} name=${it.icon || (bulbs[i] ? 'lightbulb-on' : 'lightbulb-outline')} size=${24} />`}
        <span>${it.name}</span>
      </div>`
    )}
  </div>`;
}
// Three outlined buttons along the bottom (CLOSE/STOP/OPEN, PREV/PLAY/NEXT, ...).
function ActionBar({ buttons }) {
  return html`<div class="rp-bar">
    ${buttons.map(([icon, label]) => html`<div class="rp-bar-btn"><${Icon} name=${icon} size=${34} /><span class="rp-t16">${label}</span></div>`)}
  </div>`;
}
// Music/TV/Receiver's VOL- / step blocks / VOL+ row, with a mute toggle.
function VolumeRow({ pct, muted, label = 'MUTE' }) {
  const steps = 10;
  const filled = pct == null ? 0 : Math.round((pct / 100) * steps);
  return html`<div class="rp-vol">
    <div class="rp-vol-mute"><span class="rp-t16">${label}</span><${Toggle} on=${muted} /></div>
    <div class="rp-vol-row">
      <div class="rp-sq"><${Icon} name="volume-minus" size=${28} /></div>
      <div class="rp-steps">${Array.from({ length: steps }, (_, i) => html`<span class=${i < filled ? 'on' : ''}></span>`)}</div>
      <div class="rp-sq"><${Icon} name="volume-plus" size=${28} /></div>
    </div>
  </div>`;
}
function Dotted() {
  return html`<div class="rp-dotted"></div>`;
}

// --- the pages ------------------------------------------------------------------------

function StatusPage({ room, s }) {
  const wx = s.entity(room.standby && room.standby.weatherEntity);
  const indoor = s.entity(room.standby && room.standby.climateEntity);
  if (!room.standby || !room.standby.weatherEntity) return html`<${Empty} title="Weather" sub="no weather entity set" />`;
  const a = (wx && wx.attributes) || {};
  const days = s.forecast(room.standby.weatherEntity).slice(0, 3);
  const indoorT = indoor && indoor.attributes && (indoor.attributes.current_temperature ?? Number(indoor.state));
  return html`<div class="rp-pad">
    <div class="rp-row rp-between">
      <div>
        <div class="rp-t16 rp-grey">OUTSIDE</div>
        <div class="rp-t72">${deg(a.temperature)}</div>
        <div class="rp-t20">${wx ? String(wx.state).replace(/-/g, ' ') : 'unavailable'}</div>
      </div>
      <${Icon} name=${WEATHER_ICONS[wx && wx.state] || 'weather-cloudy'} size=${120} />
    </div>
    <div class="rp-row rp-gap rp-t16 rp-grey" style="margin-top:12px">
      <span>${a.humidity ?? '--'}% humidity</span><span>${a.wind_speed ?? '--'} ${a.wind_speed_unit || ''}</span><span>UV ${a.uv_index ?? '--'}</span>
    </div>
    <${Dotted} />
    <div class="rp-row rp-between">
      <div><div class="rp-t16 rp-grey">INSIDE</div><div class="rp-t48">${deg(indoorT)}</div></div>
      <${Icon} name="home-thermometer-outline" size=${56} />
    </div>
    <${Dotted} />
    <div class="rp-forecast">
      ${days.length
        ? days.map(
            (d) => html`<div>
              <div class="rp-t16">${DAYS[new Date(d.datetime).getUTCDay()] || ''}</div>
              <${Icon} name=${WEATHER_ICONS[d.condition] || 'weather-cloudy'} size=${48} />
              <div class="rp-t20">${deg(d.temperature)}</div><div class="rp-t16 rp-grey">${deg(d.templow)}</div>
            </div>`
          )
        : html`<div class="rp-t16 rp-grey">No forecast</div>`}
    </div>
    <div class="rp-foot rp-t16 rp-grey">Updated ${s.time}</div>
  </div>`;
}

function LightingPage({ room, s }) {
  const l = room.lighting || {};
  const g = l.group || {};
  if (!g.enabled) return html`<${Empty} title="Lighting" sub="not configured for this room" />`;
  const st = s.entity(g.entity);
  const on = st ? st.state === 'on' : false;
  const bri = st && st.attributes && st.attributes.brightness != null ? Math.round((st.attributes.brightness * 100) / 255) : on ? 100 : 0;
  const c = g.controls || {};
  const tabs = ['Scenes', 'Lights', ...(c.color || c.effects ? ['Colour'] : [])];
  const scenes = (l.scenes || []).filter((x) => x.entity);
  return html`<div class="rp-pad">
    <div class="rp-row rp-between">
      <div class="rp-row rp-gap"><${Icon} name=${on ? 'lightbulb-on' : 'lightbulb-outline'} size=${36} /><span class="rp-t24">${g.name || 'All Lights'}</span></div>
      <${Toggle} on=${on} />
    </div>
    ${c.brightness &&
    html`<div class="rp-row rp-gap" style="margin-top:16px">
      <div class="rp-sq rp-sq56"><${Icon} name="brightness-5" size=${28} /></div>
      <div class="rp-level"><span style=${{ width: `${on ? bri : 0}%` }}></span></div>
      <div class="rp-sq rp-sq56"><${Icon} name="brightness-7" size=${28} /></div>
    </div>`}
    <div class="rp-temps">
      ${c.colorTemp &&
      [['WARM', 'thermometer-low'], ['DAY', 'white-balance-sunny'], ['COOL', 'snowflake']].map(
        ([t, i]) => html`<div class="rp-temp"><${Icon} name=${i} size=${22} /><span class="rp-t20">${t}</span></div>`
      )}
    </div>
    <${Dotted} />
    <div class="rp-tabs">${tabs.map((t, i) => html`<span class=${i === 0 ? 'on' : ''}>${t}</span>`)}</div>
    ${scenes.length ? html`<${Chips} items=${scenes} />` : html`<div class="rp-t16 rp-grey rp-center">No scenes configured</div>`}
  </div>`;
}

function BlindsPage({ room, s }) {
  const b = room.blinds || {};
  const items = (b.items || []).filter((x) => x.entity);
  const g = b.group || {};
  if (!g.enabled && !items.length) return html`<${Empty} title="Blinds" sub="not configured for this room" />`;
  const main = s.entity(g.enabled ? g.entity : items[0] && items[0].entity);
  const pos = main && main.attributes && main.attributes.current_position;
  const state = main ? main.state : 'unavailable';
  return html`<div class="rp-pad">
    <div class="rp-t20 rp-grey">${g.enabled ? g.name || 'All blinds' : items[0].name}</div>
    <div class="rp-t72">${pos != null ? `${pos}%` : state}</div>
    <span class="rp-pill rp-t16">${pos != null ? state.toUpperCase() : 'NO POSITION'}</span>
    <${Dotted} />
    ${items.length > 0 && html`<${Chips} items=${items.map((it) => ({ ...it, icon: it.icon || 'blinds' }))} max=${6} />`}
    <div class="rp-bottom"><${ActionBar} buttons=${[['arrow-down', 'CLOSE'], ['stop', 'STOP'], ['arrow-up', 'OPEN']]} /></div>
  </div>`;
}

function MusicPage({ room, s }) {
  const m = room.media || {};
  if (!m.enabled || !m.entity) return html`<${Empty} title="Music" sub="not configured for this room" />`;
  const st = s.entity(m.entity);
  const a = (st && st.attributes) || {};
  const playing = st && st.state === 'playing';
  return html`<div class="rp-pad">
    <div class="rp-row rp-between"><span class="rp-t24">${m.name || 'Media player'}</span><span class="rp-t16 rp-grey">${st ? st.state : 'unavailable'}</span></div>
    <div class="rp-art" style="margin:18px auto">
      ${a.entity_picture ? html`<img src=${artUrl(a.entity_picture, 280, 280)} alt="" />` : html`<${Icon} name="music-note" size=${96} />`}
    </div>
    <div class="rp-t28 rp-center rp-clip">${a.media_title || 'Nothing playing'}</div>
    <div class="rp-t20 rp-grey rp-center rp-clip">${a.media_artist || ''}</div>
    <div class="rp-bottom">
      <${VolumeRow} pct=${a.volume_level != null ? a.volume_level * 100 : null} muted=${a.is_volume_muted} />
      <${ActionBar} buttons=${[['skip-previous', 'PREV'], [playing ? 'pause' : 'play', playing ? 'PAUSE' : 'PLAY'], ['skip-next', 'NEXT']]} />
    </div>
  </div>`;
}

function TvPage({ room }) {
  const t = room.tv || {};
  if (!t.mediaPlayerEntity && !t.remoteEntity) return html`<${Empty} title="TV" sub="not configured for this room" />`;
  const apps = (t.appList || []).filter((a) => a.launch).slice(0, 4);
  return html`<div class="rp-pad">
    <div class="rp-apps">
      ${apps.length
        ? apps.map((a) => html`<div class="rp-app"><${Icon} name=${a.icon || 'application-outline'} size=${40} /><span class="rp-t16">${a.name}</span></div>`)
        : html`<div class="rp-t16 rp-grey">No apps</div>`}
    </div>
    <div class="rp-dpad">
      <div class="rp-dpad-ring"></div>
      <span class="u"><${Icon} name="chevron-up" size=${44} /></span><span class="d"><${Icon} name="chevron-down" size=${44} /></span>
      <span class="l"><${Icon} name="chevron-left" size=${44} /></span><span class="r"><${Icon} name="chevron-right" size=${44} /></span>
      <span class="ok rp-t24">OK</span>
    </div>
    <div class="rp-bottom">
      <${VolumeRow} pct=${50} muted=${false} />
      <${ActionBar} buttons=${[['arrow-left', 'BACK'], ['home-outline', 'HOME'], ['power', 'POWER']]} />
    </div>
  </div>`;
}

function XboxPage({ room, s }) {
  const x = room.xbox || {};
  if (!x.enabled || !x.mediaPlayerEntity) return html`<${Empty} title="Xbox" sub="not configured for this room" />`;
  const st = s.entity(x.mediaPlayerEntity);
  const a = (st && st.attributes) || {};
  const on = st && !['off', 'standby', 'unavailable'].includes(st.state);
  const games = (x.games || []).slice(0, 6);
  return html`<div class="rp-pad">
    <div class="rp-row rp-gap">
      <div class="rp-art rp-art-sm">
        ${on && a.entity_picture ? html`<img src=${artUrl(a.entity_picture, 150, 150)} alt="" />` : html`<${Icon} name="microsoft-xbox" size=${72} />`}
      </div>
      <div style="flex:1;min-width:0">
        <div class="rp-t16 rp-grey">${x.name || 'Xbox'}</div>
        <div class="rp-t28 rp-clip">${on ? a.media_title || 'Home' : st ? (st.state === 'off' ? 'Off' : 'Standby') : 'unavailable'}</div>
      </div>
      <${Toggle} on=${on} />
    </div>
    <${Dotted} />
    ${x.listSource === 'browse' && !games.length
      ? html`<div class="rp-t16 rp-grey rp-center">The console's library, read from Home Assistant</div>`
      : games.length
        ? games.map((g) => html`<div class="rp-listrow"><${Icon} name="gamepad-variant-outline" size=${36} /><span class="rp-t20 rp-clip">${g.name}</span></div>`)
        : html`<div class="rp-t16 rp-grey rp-center">No games configured</div>`}
    ${(x.games || []).length > 6 && html`<div class="rp-t16 rp-center">${'<'}  Page 1 of ${Math.ceil(x.games.length / 6)}  ${'>'}</div>`}
  </div>`;
}

function WifiPage({ globals }) {
  const nets = ((globals && globals.wifiNetworks) || []).filter((n) => n.name);
  if (!nets.length) return html`<${Empty} title="Guest Wi-Fi" sub="no networks in Settings → Wi-Fi" />`;
  return html`<div class="rp-pad">
    <div class="rp-t20 rp-grey">Tap a network for its join code</div>
    ${nets.slice(0, 6).map(
      (n) => html`<div class="rp-listrow"><${Icon} name="wifi" size=${36} /><span class="rp-t24 rp-clip" style="flex:1">${n.name}</span><${Icon} name="qrcode" size=${32} /></div>`
    )}
  </div>`;
}

function ClimatePage({ room, s }) {
  const c = room.climate || {};
  if (!c.entity) return html`<${Empty} title="Climate" sub="not configured for this room" />`;
  const st = s.entity(c.entity);
  const a = (st && st.attributes) || {};
  const lo = a.min_temp ?? 7;
  const hi = a.max_temp ?? 30;
  const frac = (v) => Math.max(0, Math.min(1, (Number(v) - lo) / (hi - lo || 1)));
  // A 270° arc gauge, starting bottom-left, like HA's climate card.
  const R = 150;
  const pt = (f) => {
    const ang = ((135 + f * 270) * Math.PI) / 180;
    return [200 + R * Math.cos(ang), 190 + R * Math.sin(ang)];
  };
  const [sx, sy] = pt(0);
  const [ex, ey] = pt(1);
  const [tx, ty] = pt(frac(a.temperature));
  const [cx, cy] = pt(frac(a.current_temperature));
  const modes = (a.hvac_modes || []).slice(0, 4);
  const sensors = (c.additionalSensors || []).filter((x) => x.entity).slice(0, 3);
  return html`<div class="rp-pad">
    <svg viewBox="0 0 400 330" width="400" height="330" style="display:block;margin:0 auto">
      <path d=${`M ${sx} ${sy} A ${R} ${R} 0 1 1 ${ex} ${ey}`} fill="none" stroke="#bdbdbd" stroke-width="16" stroke-dasharray="2 5" />
      ${a.current_temperature != null && html`<circle cx=${cx} cy=${cy} r="11" fill="#fff" stroke="#111" stroke-width="4" />`}
      ${a.temperature != null && html`<circle cx=${tx} cy=${ty} r="13" fill="#111" />`}
      <text x="200" y="195" text-anchor="middle" font-size="76" font-weight="600" fill="#111">${deg(a.temperature)}</text>
      <text x="200" y="240" text-anchor="middle" font-size="22" fill="#555">now ${deg(a.current_temperature)} · ${st ? st.state : 'unavailable'}</text>
    </svg>
    <div class="rp-row rp-between" style="margin-top:-30px">
      <div class="rp-sq rp-sq56"><${Icon} name="minus" size=${32} /></div>
      <div class="rp-sq rp-sq56"><${Icon} name="plus" size=${32} /></div>
    </div>
    <div class="rp-modes">${modes.map((m) => html`<span class=${`rp-t16 ${st && st.state === m ? 'on' : ''}`}>${m.replace(/_/g, ' ')}</span>`)}</div>
    <${Dotted} />
    ${sensors.map((x) => {
      const v = s.entity(x.entity);
      return html`<div class="rp-row rp-between rp-t20"><span>${x.name || x.entity}</span><b>${v ? deg(v.state) : '--'}</b></div>`;
    })}
  </div>`;
}

function ReceiverPage({ room, s }) {
  const r = room.receiver || {};
  if (!r.mediaPlayerEntity) return html`<${Empty} title="Receiver" sub="not configured for this room" />`;
  const st = s.entity(r.mediaPlayerEntity);
  const a = (st && st.attributes) || {};
  const info = s.receiver || {};
  const off = st && ['off', 'standby'].includes(st.state);
  const favs = (r.channels || []).filter((c) => c.source).slice(0, 6);
  return html`<div class="rp-pad">
    <div class="rp-row rp-gap">
      <div class="rp-picon">${info.picon ? html`<img src=${artUrl(info.picon, 96, 58, 'contain')} alt="" />` : html`<${Icon} name="satellite-variant" size=${40} />`}</div>
      <div style="flex:1;min-width:0">
        <div class="rp-t28 rp-clip">${off ? 'Standby' : a.media_channel || a.source || (st ? 'No channel' : 'unavailable')}</div>
        <div class="rp-t16 rp-grey">${r.name || 'Receiver'}</div>
      </div>
    </div>
    ${!off &&
    html`<div class="rp-now">
      <div class="rp-t16"><b>NOW</b> ${info.now ? info.now.time : ''}</div><div class="rp-t20 rp-clip">${(info.now && info.now.title) || a.media_series_title || '—'}</div>
      ${info.next && html`<div class="rp-t16 rp-grey"><b>NEXT</b> ${info.next.time} · ${info.next.title}</div>`}
    </div>`}
    <div class="rp-favs">
      ${favs.map((c, i) => {
        const picon = info.favourites && info.favourites[i];
        return html`<div class=${`rp-fav ${a.source && c.source.toLowerCase() === String(a.source).toLowerCase() ? 'on' : ''}`}>
          ${picon ? html`<img src=${artUrl(picon, 60, 36, 'contain')} alt="" />` : html`<${Icon} name=${c.icon || 'television-classic'} size=${30} />`}
          <span class="rp-t16 rp-clip">${c.name}</span>
        </div>`;
      })}
    </div>
    <div class="rp-bottom">
      <${VolumeRow} pct=${a.volume_level != null ? a.volume_level * 100 : null} muted=${a.is_volume_muted} />
      <${ActionBar} buttons=${[['chevron-down', 'CH-'], ['power', 'POWER'], ['chevron-up', 'CH+']]} />
    </div>
  </div>`;
}

function QuickPage({ room, carousel }) {
  const hub = room.hub || {};
  const items = hub.items || [];
  const qa = hub.quickActionsEnabled !== false;
  if (!items.length) {
    const on = new Set(carousel.filter((c) => c.enabled).map((c) => c.page));
    const shown = JUMP_ITEMS.filter(([id]) => id === 'settings' || on.has(id));
    return html`<div class="rp-grid">
      ${shown.map(([, label, icon]) => html`<div class="rp-tile"><${Icon} name=${icon} size=${48} /><span class="rp-t24">${label}</span></div>`)}
    </div>`;
  }
  return html`<div class="rp-grid">
    ${items.slice(0, 10).map((it) => {
      const action = qa && it.action && it.action.type !== 'none';
      return html`<div class="rp-tile">
        <div class="rp-tile-top"><${Icon} name=${it.icon || HUB_TARGET_ICONS[it.target] || 'cog-outline'} size=${40} /><span class="rp-t20 rp-clip">${it.name}</span></div>
        ${action && html`<div class="rp-tile-strip rp-t16">${it.action.type === 'toggle' ? 'TOGGLE' : 'RUN'}</div>`}
      </div>`;
    })}
    ${items.length > 10 && html`<div class="rp-t16 rp-center" style="grid-column:1/-1">1/${Math.ceil(items.length / 10)} ></div>`}
  </div>`;
}

const PAGES = {
  status: StatusPage, lighting: LightingPage, blinds: BlindsPage, music: MusicPage, tv: TvPage,
  xbox: XboxPage, wifi: WifiPage, climate: ClimatePage, receiver: ReceiverPage, quick: QuickPage
};

// One remote screen: the status bar, the page, the carousel dots.
function Screen({ page, index, count, ...props }) {
  const Page = PAGES[page];
  return html`<div class="rp-screen" style=${{ width: `${W}px`, height: `${H}px` }}>
    <div class="rp-status">
      <span class="rp-t20">${props.s.time}</span>
      <span class="rp-t20"><b>${page === 'quick' ? ((props.room.hub && props.room.hub.items || []).length ? 'Quick Access' : 'Jump to') : props.room.name || ''}</b></span>
      <span class="rp-row"><${Icon} name="wifi" size=${22} /><${Icon} name="battery-80" size=${22} /></span>
    </div>
    <div class="rp-body"><${Page} ...${props} /></div>
    ${page !== 'quick' &&
    html`<div class="rp-dots">${Array.from({ length: count }, (_, i) => html`<span class=${i === index ? 'on' : ''}></span>`)}</div>`}
  </div>`;
}

// The draft room's state from HA, re-fetched a moment after the editing stops.
function usePreviewState(slug, room) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const key = JSON.stringify(room);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api(`/api/devices/${encodeURIComponent(slug)}/state/preview`, { method: 'POST', body: room })
        .then((data) => alive && setState({ data, error: '', loading: false }))
        .catch((e) => alive && setState({ data: null, error: e.message, loading: false }));
    }, 800);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [slug, key]);
  return state;
}

// One page, as a remote in this room would show it now: the remote layout
// editor's preview beside the page being edited. `page` is a carousel page
// or 'quick' (Quick Access); a page that's switched off still previews.
export function RemotePreview({ slug, room, carousel, page, scale = 0.56 }) {
  const { data, error, loading } = usePreviewState(slug, room);
  const [globals] = useApi('/api/globals');
  const now = new Date();
  const s = {
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    entity: (id) => (id && data && data.states && data.states[id]) || null,
    forecast: (id) => (id && data && data.forecast && data.forecast[id]) || [],
    receiver: data && data.receiver
  };
  const pages = carousel.filter((c) => c.enabled).map((c) => c.page);
  const index = page === 'quick' ? pages.length : Math.max(0, pages.indexOf(page));
  return html`<div class="rp-single">
    <div class="rp-scale" style=${{ width: `${W * scale}px`, height: `${H * scale}px` }}>
      <div style=${{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <${Screen} page=${page} index=${index} count=${pages.length} room=${room} s=${s} carousel=${carousel} globals=${globals} />
      </div>
    </div>
    <div class="rp-cap">${loading ? 'Updating…' : error ? (error.includes('not configured') ? 'Home Assistant isn’t set up: no live state' : 'No live state from Home Assistant') : 'Live from Home Assistant'}</div>
  </div>`;
}
