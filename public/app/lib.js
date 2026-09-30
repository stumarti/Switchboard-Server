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

export function Select({ value, onChange, options }) {
  return html`<select value=${value} onChange=${(e) => onChange(e.target.value)}>
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

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
