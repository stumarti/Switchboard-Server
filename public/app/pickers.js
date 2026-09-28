// The two pickers every editor uses:
//
//   EntityPicker  type-ahead over Home Assistant's own entity list (proxied by
//                 the server, which holds the token), filtered to the domains
//                 a field accepts. Shows whether the chosen id exists in HA
//                 and its live state. With HA unreachable or not configured it
//                 degrades to a plain text box.
//   IconPicker    any MDI icon (or an uploaded custom one) by search.

import { html, useState, useEffect, useRef, api, Icon, Button } from './lib.js';

// --- HA availability + batched id lookups ---------------------------------

// null = unknown yet, true/false once /api/ha/status answered. Pages reset it
// (haStatus.refresh()) after the HA connection is edited in Settings.
export const haStatus = {
  ok: null,
  error: '',
  listeners: new Set(),
  pending: null,
  load(force) {
    if (this.pending && !force) return this.pending;
    this.pending = api('/api/ha/status')
      .then((r) => {
        this.ok = Boolean(r.ok);
        this.error = r.ok ? '' : r.error || 'unreachable';
      })
      .catch((e) => {
        this.ok = false;
        this.error = e.message;
      })
      .then(() => {
        lookupCache.clear();
        this.listeners.forEach((fn) => fn());
      });
    return this.pending;
  },
  refresh() {
    return this.load(true);
  }
};

export function useHaStatus() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    haStatus.listeners.add(fn);
    haStatus.load();
    return () => haStatus.listeners.delete(fn);
  }, []);
  return haStatus;
}

// Every picker on a page asks about its own id; those asks are collected for
// a tick and sent as one POST /api/ha/lookup.
const lookupCache = new Map(); // id -> Promise<entity|null>
let lookupQueue = new Map(); // id -> resolve
let lookupTimer = null;

function flushLookups() {
  const batch = lookupQueue;
  lookupQueue = new Map();
  lookupTimer = null;
  api('/api/ha/lookup', { method: 'POST', body: { ids: [...batch.keys()] } })
    .then((res) => batch.forEach((resolve, id) => resolve(res[id] || null)))
    .catch(() => batch.forEach((resolve, id) => {
      lookupCache.delete(id);
      resolve(undefined); // unknown, not "missing"
    }));
}

export function lookupEntity(id) {
  if (!id) return Promise.resolve(null);
  if (lookupCache.has(id)) return lookupCache.get(id);
  const p = new Promise((resolve) => {
    lookupQueue.set(id, resolve);
    if (!lookupTimer) lookupTimer = setTimeout(flushLookups, 30);
  });
  lookupCache.set(id, p);
  return p;
}

export function useEntity(id) {
  const ha = useHaStatus();
  const [entity, setEntity] = useState(undefined);
  useEffect(() => {
    let live = true;
    setEntity(undefined);
    if (id && ha.ok) lookupEntity(id).then((e) => live && setEntity(e));
    return () => {
      live = false;
    };
  }, [id, ha.ok]);
  return entity; // undefined = unknown, null = not in HA, else the entity
}

const DOMAIN_ICONS = {
  light: 'lightbulb-outline',
  switch: 'toggle-switch-outline',
  cover: 'blinds',
  climate: 'thermostat',
  weather: 'weather-partly-cloudy',
  sensor: 'eye-outline',
  binary_sensor: 'checkbox-blank-circle-outline',
  media_player: 'cast',
  remote: 'remote',
  scene: 'palette-outline',
  script: 'script-text-outline',
  automation: 'robot-outline',
  fan: 'fan',
  vacuum: 'robot-vacuum',
  input_boolean: 'toggle-switch-outline',
  air_quality: 'air-filter',
  lock: 'lock-outline'
};
export const entityIcon = (e) => (e && e.icon) || DOMAIN_ICONS[e && e.domain] || 'shape-outline';

function formatState(e) {
  if (!e) return '';
  return e.unit ? `${e.state} ${e.unit}` : e.state;
}

/**
 * props: value, onChange(id, entity|null), domains: string[], deviceClass,
 * placeholder, compact (no status line)
 */
export function EntityPicker({ value, onChange, domains = [], deviceClass = '', placeholder, compact }) {
  const ha = useHaStatus();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [hl, setHl] = useState(0);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);
  const current = useEntity(value);
  const domainKey = domains.join(',');

  useEffect(() => {
    if (!open || !ha.ok) return undefined;
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ domains: domainKey, q: query, deviceClass, limit: '60' });
      api(`/api/ha/entities?${qs}`)
        .then((r) => {
          if (!live) return;
          setResults(r);
          setHl(0);
        })
        .catch(() => live && setResults([]))
        .finally(() => live && setLoading(false));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, query, domainKey, deviceClass, ha.ok]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (e) => {
    onChange(e.entity_id, e);
    setOpen(false);
    setQuery('');
  };

  const onKey = (ev) => {
    if (!open) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setHl((h) => Math.min(h + 1, results.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setHl((h) => Math.max(h - 1, 0));
    } else if (ev.key === 'Enter' && results[hl]) {
      ev.preventDefault();
      choose(results[hl]);
    } else if (ev.key === 'Escape') {
      setOpen(false);
    }
  };

  // HA not reachable: a plain text box, so nothing is ever blocked on HA.
  if (ha.ok === false) {
    return html`<div class="entity-picker">
      <input
        type="text"
        value=${value || ''}
        placeholder=${placeholder || (domains[0] ? `${domains[0]}.…` : 'entity_id')}
        onInput=${(e) => onChange(e.target.value.trim(), null)}
      />
    </div>`;
  }

  const shown = open ? query : current ? current.name : value || '';
  return html`<div class="entity-picker" ref=${boxRef}>
    <div class="ep-input">
      <${Icon} name=${current ? entityIcon(current) : 'magnify'} size=${18} />
      <input
        type="text"
        value=${shown}
        placeholder=${placeholder || `Search ${domains.length ? domains.join(', ') : 'entities'}…`}
        onFocus=${() => {
          setOpen(true);
          setQuery('');
        }}
        onInput=${(e) => setQuery(e.target.value)}
        onKeyDown=${onKey}
      />
      ${value &&
      html`<${Button} kind="ghost" small icon="close" title="Clear" onClick=${() => onChange('', null)} />`}
    </div>
    ${open &&
    html`<div class="ep-menu">
      ${loading && !results.length && html`<div class="ep-status">Searching…</div>`}
      ${!loading && !results.length && html`<div class="ep-status">No matching entities</div>`}
      ${results.map(
        (e, i) => html`<div
          class=${`ep-option ${i === hl ? 'hl' : ''}`}
          onMouseDown=${(ev) => {
            ev.preventDefault();
            choose(e);
          }}
          onMouseEnter=${() => setHl(i)}
        >
          <${Icon} name=${entityIcon(e)} size=${20} />
          <div class="ep-text">
            <div class="ep-name">${e.name}</div>
            <div class="ep-id">${e.entity_id}</div>
          </div>
          <span class="ep-state">${formatState(e)}</span>
        </div>`
      )}
    </div>`}
    ${!compact &&
    value &&
    html`<div class="ep-status">
      <code>${value}</code>
      ${current === null && html`<span class="badge badge-bad"><${Icon} name="alert-circle-outline" size=${13} /> not in Home Assistant</span>`}
      ${current && html`<span class="badge badge-ok"><${Icon} name="check" size=${13} /> ${formatState(current)}</span>`}
    </div>`}
  </div>`;
}

// --- Icons ------------------------------------------------------------------

// A picked icon may be a custom upload, which has no /mdi/*.svg: show those
// through the server's PNG preview instead.
const previewCache = new Map(); // name -> Promise<dataUrl|''>
let previewQueue = new Map();
let previewTimer = null;

function flushPreviews() {
  const batch = previewQueue;
  previewQueue = new Map();
  previewTimer = null;
  api('/api/assets/icons/preview', { method: 'POST', body: { names: [...batch.keys()] } })
    .then((r) => {
      const byName = new Map(r.map((x) => [x.name, x.preview]));
      batch.forEach((resolve, name) => resolve(byName.get(name) || ''));
    })
    .catch(() => batch.forEach((resolve) => resolve('')));
}

function loadPreview(name) {
  if (!previewCache.has(name)) {
    previewCache.set(
      name,
      new Promise((resolve) => {
        previewQueue.set(name, resolve);
        if (!previewTimer) previewTimer = setTimeout(flushPreviews, 30);
      })
    );
  }
  return previewCache.get(name);
}

function useIconPreview(name) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    setSrc('');
    if (name) loadPreview(name).then((p) => live && setSrc(p));
    return () => {
      live = false;
    };
  }, [name]);
  return src;
}

export function IconPreview({ name, size = 22 }) {
  const src = useIconPreview(name);
  if (!name) return html`<${Icon} name="shape-plus-outline" size=${size} />`;
  return src
    ? html`<img src=${src} width=${size} height=${size} alt=${name} class="icon-img" />`
    : html`<span style=${{ width: `${size}px`, height: `${size}px`, display: 'inline-block' }}></span>`;
}

export function IconPickerModal({ title = 'Choose an icon', onPick, onClose, onClear }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return undefined;
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      api(`/api/assets/icons/search?q=${encodeURIComponent(term)}`)
        .then((r) => live && setResults(r))
        .catch(() => live && setResults([]))
        .finally(() => live && setBusy(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog">
      <div class="modal-head">
        <${Icon} name="emoticon-outline" size=${22} />
        <h2>${title}</h2>
        ${onClear && html`<${Button} small icon="close-circle-outline" onClick=${onClear}>No icon<//>`}
        <${Button} kind="ghost" icon="close" title="Close" onClick=${onClose} />
      </div>
      <div class="modal-body">
        <input type="text" placeholder="Search icons (e.g. lamp, sofa, tv)…" value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />
        ${busy && html`<p class="hint">Searching…</p>`}
        <div class="icon-grid">
          ${results.map(
            (r) => html`<button type="button" class="icon-cell" onClick=${() => onPick(r.name)} title=${r.name}>
              <img src=${r.preview} alt="" />
              <span>${r.name}</span>
              ${r.source === 'custom' && html`<span class="badge badge-accent">custom</span>`}
            </button>`
          )}
        </div>
        ${!busy && q.trim().length >= 2 && !results.length && html`<p class="hint">No icons match “${q}”.</p>`}
      </div>
    </div>
  </div>`;
}

// A square button showing the icon; click to change, with a clear option.
export function IconPicker({ value, onChange, title }) {
  const [open, setOpen] = useState(false);
  return html`<span class="icon-picker">
    <button type="button" class=${`icon-btn ${value ? 'set' : ''}`} title=${value || 'Choose icon'} onClick=${() => setOpen(true)}>
      <${IconPreview} name=${value} size=${22} />
    </button>
    ${open &&
    html`<${IconPickerModal}
      title=${title}
      onPick=${(n) => {
        onChange(n);
        setOpen(false);
      }}
      onClose=${() => setOpen(false)}
      onClear=${value
        ? () => {
            onChange('');
            setOpen(false);
          }
        : null}
    />`}
  </span>`;
}
