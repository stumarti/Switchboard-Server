// Shared building blocks for the admin UI: Preact + htm (no build step —
// index.html's import map resolves these to /vendor/*), the API helper, and
// the small presentational primitives every page uses.

import { h, render } from 'preact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);
export { h, render, useState, useEffect, useMemo, useRef, useCallback };

// --- API ----------------------------------------------------------------

// Any 401 (an expired session) sends the whole app back to the sign-in gate.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    onUnauthorized();
    throw new Error('not signed in');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (_) {
      /* not JSON */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Load something on mount / when `deps` change: [data, error, reload].
export function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    setError(null);
    api(path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [path, tick, ...deps]);
  return [data, error, () => setTick((t) => t + 1), setData];
}

// Navigate (hash routing, see main.js): go('remotes', mac).
export function go(section, id) {
  location.hash = `#/${section}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

// --- Icons ----------------------------------------------------------------
// Any Material Design Icon by name (e.g. "lightbulb-group"), drawn as a CSS
// mask over currentColor so it takes the surrounding text colour.
export function Icon({ name, size = 20, class: cls = '', title }) {
  if (!name) return null;
  return html`<span
    class=${`icon ${cls}`}
    title=${title}
    aria-hidden=${title ? undefined : 'true'}
    style=${{ '--i': `url(/mdi/${name}.svg)`, width: `${size}px`, height: `${size}px` }}
  ></span>`;
}

// --- Primitives -----------------------------------------------------------

export function Card({ icon, title, subtitle, actions, children, class: cls = '' }) {
  return html`<section class=${`card ${cls}`}>
    ${(title || actions) &&
    html`<header class="card-head">
      ${icon && html`<div class="card-icon"><${Icon} name=${icon} size=${22} /></div>`}
      <div class="card-titles">
        ${title && html`<h2>${title}</h2>`}
        ${subtitle && html`<p class="hint">${subtitle}</p>`}
      </div>
      ${actions && html`<div class="card-actions">${actions}</div>`}
    </header>`}
    <div class="card-body">${children}</div>
  </section>`;
}

export function Field({ label, hint, children, wide }) {
  return html`<label class=${`field ${wide ? 'field-wide' : ''}`}>
    <span class="field-label">${label}</span>
    ${children}
    ${hint && html`<span class="hint">${hint}</span>`}
  </label>`;
}

export function TextInput({ value, onInput, placeholder, type = 'text', disabled }) {
  return html`<input
    type=${type}
    value=${value || ''}
    placeholder=${placeholder}
    disabled=${disabled}
    onInput=${(e) => onInput(e.target.value)}
  />`;
}

export function SecretInput({ value, onInput, placeholder }) {
  const [shown, setShown] = useState(false);
  return html`<div class="input-with-button">
    <input
      type=${shown ? 'text' : 'password'}
      autocomplete="new-password"
      value=${value || ''}
      placeholder=${placeholder}
      onInput=${(e) => onInput(e.target.value)}
    />
    <button type="button" class="btn btn-ghost btn-icon" title=${shown ? 'Hide' : 'Show'} onClick=${() => setShown(!shown)}>
      <${Icon} name=${shown ? 'eye-off-outline' : 'eye-outline'} size=${18} />
    </button>
  </div>`;
}

export function Select({ value, onChange, options, disabled }) {
  return html`<select value=${value} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>
    ${options.map((o) =>
      typeof o === 'object'
        ? html`<option value=${o.value}>${o.label}</option>`
        : html`<option value=${o}>${o}</option>`
    )}
  </select>`;
}

export function Toggle({ checked, onChange, label, disabled }) {
  return html`<label class=${`toggle ${disabled ? 'toggle-disabled' : ''}`}>
    <input type="checkbox" checked=${Boolean(checked)} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />
    <span class="toggle-track"><span class="toggle-knob"></span></span>
    ${label && html`<span class="toggle-label">${label}</span>`}
  </label>`;
}

// An entity id as it's written in a layout ("sensor.kitchen_temp").
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
// Keys whose string values (or lists of strings) are entities.
const ENTITY_KEY = /entit|sensor|battery|weather|calendar|player|camera|climate|heater|alarm|thermostat|forecast|^zones?$|^items$|^hotWater$|^water/i;

// The string the caret is in, if it's where an entity goes: its text before
// the caret, where it starts, and the key it's under (or '' in a list).
function entityTokenAt(text, caret) {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const before = text.slice(lineStart, caret);
  const q = before.lastIndexOf('"');
  if (q < 0) return null;
  // Inside a string: an odd number of quotes before the caret on this line.
  if ((before.match(/"/g) || []).length % 2 === 0) return null;
  const token = before.slice(q + 1);
  if (!/^[a-z0-9_.]*$/.test(token) || token.length < 2) return null;
  const key = (/"([^"]+)"\s*:\s*\[?\s*$/.exec(before.slice(0, q)) || [])[1] || '';
  if (key ? !ENTITY_KEY.test(key) && !token.includes('.') : !token.includes('.')) return null;
  return { token, from: lineStart + q + 1, to: caret };
}

// Every string in it that looks like an entity id.
function entityIdsIn(v, out = new Set()) {
  if (typeof v === 'string') {
    if (ENTITY_ID.test(v)) out.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => entityIdsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => entityIdsIn(x, out));
  return out;
}

// A JSON editor for a piece of config: the text as it is, Apply (through
// `onApply`, which may throw: its message is shown), Revert, Copy. Tab
// indents. `value` changing (an apply, or the form) resets the text.
// Typing an entity (in a string under an entity key, or anything with a
// dot) suggests Home Assistant's entities: arrows to pick, Enter or Tab to
// put it in, Esc to close. Entities it names that Home Assistant hasn't got
// are listed under it.
export function JsonEditor({ value, onApply, hint, rows = 22 }) {
  const text = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(text);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [tok, setTok] = useState(null); // {token, from, to}
  const [hits, setHits] = useState([]);
  const [hl, setHl] = useState(0);
  const [missing, setMissing] = useState([]);
  const area = useRef(null);
  useEffect(() => {
    setDraft(text);
    setErr('');
  }, [text]);

  // Suggestions for the entity being typed.
  useEffect(() => {
    if (!tok) {
      setHits([]);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      api(`/api/ha/entities?${new URLSearchParams({ q: tok.token, limit: '8' })}`)
        .then((r) => {
          if (!live) return;
          setHits((r || []).filter((e) => e.entity_id !== tok.token));
          setHl(0);
        })
        .catch(() => live && setHits([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tok && tok.token, tok && tok.from]);

  // Entities it names that Home Assistant hasn't got (once it parses).
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      let ids;
      try {
        ids = [...entityIdsIn(JSON.parse(draft))];
      } catch {
        return;
      }
      if (!ids.length) return live && setMissing([]);
      api('/api/ha/lookup', { method: 'POST', body: { ids: ids.slice(0, 500) } })
        .then((r) => live && setMissing(ids.filter((id) => r && r[id] === null)))
        .catch(() => live && setMissing([]));
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft]);

  const track = (t) => setTok(entityTokenAt(t.value, t.selectionStart));
  const pick = (e) => {
    const t = area.current;
    if (!t || !tok) return;
    t.setRangeText(e.entity_id, tok.from, tok.to, 'end');
    setDraft(t.value);
    setTok(null);
    t.focus();
  };
  const apply = async () => {
    let v;
    try {
      v = JSON.parse(draft);
    } catch (e) {
      setErr(`Not valid JSON: ${e.message}`);
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      setErr('It must be a JSON object: { … }');
      return;
    }
    setBusy(true);
    try {
      await onApply(v);
      setErr('');
      setNote('Applied. Unknown keys are dropped and missing ones get their defaults; Save to keep it.');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e) => {
    if (hits.length && tok) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHl((h) => (h + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(hits[hl]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTok(null);
        return;
      }
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const t = e.target;
    t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
    setDraft(t.value);
  };
  const copy = () => navigator.clipboard && navigator.clipboard.writeText(draft).then(() => setNote('Copied.')).catch(() => {});
  return html`<div class="json-editor">
    <div class="json-wrap">
      <textarea ref=${area} class="json-text" spellcheck="false" autocapitalize="off" autocomplete="off" rows=${rows} value=${draft}
        onInput=${(e) => { setDraft(e.target.value); track(e.target); }}
        onClick=${(e) => track(e.target)} onKeyUp=${(e) => !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key) && track(e.target)}
        onKeyDown=${keys} onBlur=${() => setTimeout(() => setTok(null), 150)}></textarea>
      ${tok && hits.length > 0 &&
      html`<div class="json-suggest" role="listbox">
        <div class="hint">Entities matching “${tok.token}” · ↑↓ Enter</div>
        ${hits.map((e, i) => html`<button type="button" class=${i === hl ? 'on' : ''} onMouseDown=${(ev) => { ev.preventDefault(); pick(e); }}>
          <code>${e.entity_id}</code><span>${e.name}</span></button>`)}
      </div>`}
    </div>
    ${err && html`<p class="hint text-bad">${err}</p>`}
    ${!err && note && html`<p class="hint">${note}</p>`}
    ${missing.length > 0 && html`<p class="hint text-warn"><${Icon} name="alert-outline" size=${15} /> Not in Home Assistant: ${missing.map((id, i) => html`${i ? ', ' : ''}<code>${id}</code>`)}</p>`}
    ${hint && html`<p class="hint">${hint}</p>`}
    <div class="json-actions">
      <${Button} kind="primary" small icon="check" disabled=${draft === text || busy} onClick=${apply}>${busy ? 'Checking…' : 'Apply'}<//>
      <${Button} small icon="undo" disabled=${draft === text} onClick=${() => { setDraft(text); setErr(''); }}>Revert<//>
      <${Button} small icon="content-copy" onClick=${copy}>Copy<//>
    </div>
  </div>`;
}

export function Button({ icon, children, onClick, kind = 'secondary', small, disabled, title, type = 'button' }) {
  return html`<button
    type=${type}
    class=${`btn btn-${kind} ${small ? 'btn-small' : ''} ${!children ? 'btn-icon' : ''}`}
    onClick=${onClick}
    disabled=${disabled}
    title=${title}
  >
    ${icon && html`<${Icon} name=${icon} size=${small ? 16 : 18} />`}
    ${children && html`<span>${children}</span>`}
  </button>`;
}

export function Badge({ kind = 'neutral', icon, children }) {
  return html`<span class=${`badge badge-${kind}`}>${icon && html`<${Icon} name=${icon} size=${14} />`}${children}</span>`;
}

export function Empty({ icon, title, children }) {
  return html`<div class="empty">
    <${Icon} name=${icon} size=${48} />
    <h3>${title}</h3>
    ${children && html`<div class="hint">${children}</div>`}
  </div>`;
}

// A "Saved ✓" style status that fades out on its own.
export function useFlash() {
  const [msg, setMsg] = useState('');
  const timer = useRef(null);
  const flash = useCallback((m, ms = 2500) => {
    setMsg(m);
    clearTimeout(timer.current);
    if (ms) timer.current = setTimeout(() => setMsg(''), ms);
  }, []);
  return [msg, flash];
}

// Immutable helpers for editing nested objects/lists in state.
export function setIn(obj, path, value) {
  if (!path.length) return value;
  const [k, ...rest] = path;
  const base = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  base[k] = setIn(base[k], rest, value);
  return base;
}
export function getIn(obj, path, fallback) {
  let o = obj;
  for (const k of path) {
    if (o == null) return fallback;
    o = o[k];
  }
  return o === undefined ? fallback : o;
}
export function moveItem(list, from, to) {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

// Learned battery life (lib/battery-history.js) as short text and a tooltip:
// "~12 days" / "learning…", and how it was worked out.
export function batteryLifeText(life) {
  if (!life) return { short: '', tip: '' };
  if (life.daysLeft == null) {
    return { short: 'learning…', tip: 'Learning how fast this battery drains: an estimate appears after about half a day and a couple of percent of use.' };
  }
  const d = life.daysLeft;
  const short = d < 1 ? '< 1 day' : `~${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
  const how = life.basis === 'measured'
    ? `from its last ${life.sinceChargeDays} day${life.sinceChargeDays === 1 ? '' : 's'} since charging`
    : `from ${life.discharges} earlier charge${life.discharges === 1 ? '' : 's'} (not enough since the last charge yet)`;
  const full = life.fullChargeDays ? ` A full charge lasts about ${life.fullChargeDays} days.` : '';
  return { short, tip: `About ${short.replace('~', '')} left, falling ${life.ratePerDay}% a day, ${how}.${full}` };
}

// A board (the kind of device a firmware build is for) as people call it.
const BOARD_NAMES = { x4pro: 'X4 Pro', sticky: 'Sticky', e1002: 'reTerminal E1002', e1004: 'reTerminal E1004' };
export function boardLabel(board) {
  return BOARD_NAMES[board] || board || '';
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// A dialog over the page: Escape or a click outside closes it.
export function Modal({ title, icon, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`<div class="modal-back" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label=${title}>
      <div class="modal-head">
        ${icon && html`<${Icon} name=${icon} size=${20} />`}
        <h2>${title}</h2>
        <button type="button" class="btn btn-ghost btn-icon" title="Close" onClick=${onClose}><${Icon} name="close" size=${18} /></button>
      </div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-foot">${footer}</div>`}
    </div>
  </div>`;
}
