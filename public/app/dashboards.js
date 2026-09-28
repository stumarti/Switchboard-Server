// A viewport dashboard: a whole wall-display UI, defined here before (or
// without) any hardware, then assigned to any number of displays on their
// Viewports page. The builder itself is viewport.js.

import { html, useState, useEffect, api, go, Icon, Button, Badge, Empty, useFlash, timeAgo } from './lib.js';
import { DashboardBuilder } from './viewport.js';
import { useDragOrder } from './clients.js';

export function DashboardPage({ slug, rooms, reloadDashboards, reloadClients }) {
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

  if (error) return html`<div class="page"><${Empty} icon="alert-circle-outline" title="Couldn't load this dashboard">${error.message}<//></div>`;
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
    go('dashboards', copy.slug);
  };
  const remove = async () => {
    const using = dash.devices.length ? ` ${dash.devices.length} display(s) using it will show “not set up”.` : '';
    if (!confirm(`Delete the dashboard “${dash.name}”?${using}`)) return;
    await api(`/api/dashboards/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    await Promise.all([reloadDashboards(), reloadClients()]);
    go('rooms');
  };

  return html`<div class="page">
    <div class="page-head">
      <${Button} kind="ghost" icon="arrow-left" title="All rooms and dashboards" onClick=${() => go('rooms')} />
      <div class="ph-icon"><${Icon} name="view-dashboard-outline" size=${26} /></div>
      <div class="ph-text">
        <input type="text" value=${dash.name} onInput=${(e) => update({ ...dash, name: e.target.value })} style="font-size:20px;font-weight:600;border-color:transparent;padding:4px 6px;background:transparent" />
        <div class="chips" style="padding-left:6px">
          <${Badge} icon="clock-outline">Updated ${timeAgo(dash.updatedAt)}<//>
          ${dash.devices.length
            ? dash.devices.map((d) => html`<a class="badge badge-accent" href=${`#/viewports/${encodeURIComponent(d.mac)}`}><${Icon} name="tablet-dashboard" size=${13} />${d.name}</a>`)
            : html`<${Badge} icon="link-variant-off">No display assigned yet<//>`}
        </div>
      </div>
      <div class="page-actions">
        <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
        <${Button} kind="ghost" icon="content-copy" title="Duplicate" onClick=${duplicate} />
        <${Button} kind="ghost" icon="trash-can-outline" title="Delete dashboard" onClick=${remove} />
        <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty || saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}<//>
      </div>
    </div>
    <${DashboardBuilder} layout=${dash.layout} onChange=${(layout) => update({ ...dash, layout })} rooms=${rooms} useDragOrder=${useDragOrder} />
  </div>`;
}
