// A viewport layout ("dashboard" in the API and store): a whole wall-display
// UI, defined here before (or without) any hardware, then assigned to any
// number of displays on their Viewports page. The builder is viewport.js.

import { html, useState, useEffect, api, go, Button, Empty, useFlash, timeAgo } from './lib.js';
import { DashboardBuilder } from './viewport.js';
import { useDragOrder } from './clients.js';

export function DashboardPage({ slug, part, rooms, reloadDashboards, reloadClients }) {
  const [dash, setDash] = useState(null);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, flash] = useFlash();

  useEffect(() => {
    api(`/api/dashboards/${encodeURIComponent(slug)}`).then(setDash).catch(setError);
  }, [slug]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (error) return html`<div class="page"><${Empty} icon="alert-circle-outline" title="Couldn't load this layout">${error.message}<//></div>`;
  if (!dash) return html`<div class="page"><p class="hint">Loading…</p></div>`;

  const update = (next) => {
    setDash(next);
    setDirty(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api(`/api/dashboards/${encodeURIComponent(slug)}`, { method: 'PUT', body: { name: dash.name, layout: dash.layout } });
      setDash({ ...dash, ...saved });
      setDirty(false);
      flash(dash.devices.length ? 'Saved — displays pick it up on their next refresh' : 'Saved');
      reloadDashboards();
    } catch (e) {
      flash(`Save failed: ${e.message}`, 6000);
    } finally {
      setSaving(false);
    }
  };
  const duplicate = async () => {
    const copy = await api('/api/dashboards', { method: 'POST', body: { name: `${dash.name} copy`, layout: dash.layout } });
    await reloadDashboards();
    go('viewport-layouts', copy.slug);
  };
  const remove = async () => {
    const using = dash.devices.length ? ` ${dash.devices.length} display(s) using it will show “not set up”.` : '';
    if (!confirm(`Delete the layout “${dash.name}”?${using}`)) return;
    await api(`/api/dashboards/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    await Promise.all([reloadDashboards(), reloadClients()]);
    go('layouts');
  };

  const discard = () => {
    if (!confirm('Discard your changes?')) return;
    setDirty(false);
    api(`/api/dashboards/${encodeURIComponent(slug)}`).then(setDash).catch(setError);
  };

  return html`<div class="page page-wide">
    <div class="page-head">
      <div class="ph-text">
        <input type="text" class="title-input" aria-label="Layout name" value=${dash.name} onInput=${(e) => update({ ...dash, name: e.target.value })} />
        <p class="hint">Viewport layout · ${dash.devices.length ? `${dash.devices.length} display${dash.devices.length === 1 ? '' : 's'}` : 'no display yet'} · updated ${timeAgo(dash.updatedAt)}</p>
      </div>
      <div class="page-actions">
        <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
        <${Button} kind="ghost" icon="content-copy" title="Duplicate" onClick=${duplicate} />
        <${Button} kind="ghost" icon="trash-can-outline" title="Delete layout" onClick=${remove} />
        ${dirty && html`<${Button} onClick=${discard}>Discard<//>`}
        <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty || saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}<//>
      </div>
    </div>
    <${DashboardBuilder} layout=${dash.layout} part=${part} onChange=${(layout) => update({ ...dash, layout })} rooms=${rooms} useDragOrder=${useDragOrder} />
  </div>`;
}
