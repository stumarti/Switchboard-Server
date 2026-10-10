// A viewport layout ("dashboard" in the API and store): a whole wall-display
// UI, defined here before (or without) any hardware, then assigned to any
// number of displays on their Viewports page. The builder is viewport.js.

import { html, useState, useEffect, api, go, Button, Empty, useFlash, timeAgo } from './lib.js';
import { DashboardBuilder, ScreensList } from './viewport.js';
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

// Every viewport layout in one builder: each layout's carousel listed down
// the side, one after another, and whichever screen is picked edited beside
// them with its preview. Save writes every layout that changed.
export function AllViewportsPage({ dashboards, rooms, reloadDashboards }) {
  const [dashes, setDashes] = useState(null); // [{slug, name, layout, devices, ...}]
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(() => new Set());
  const [sel, setSel] = useState(null); // {slug, screen}
  const [saving, setSaving] = useState(false);
  const [msg, flash] = useFlash();
  const slugs = (dashboards || []).map((d) => d.slug).join('|');

  const load = () =>
    Promise.all((dashboards || []).map((d) => api(`/api/dashboards/${encodeURIComponent(d.slug)}`)))
      .then((list) => {
        setDashes(list);
        setDirty(new Set());
        setSel((cur) => {
          if (cur && list.some((d) => d.slug === cur.slug)) return cur;
          const first = list.find((d) => d.layout.screens.length);
          return first ? { slug: first.slug, screen: first.layout.screens[0].id } : null;
        });
      })
      .catch(setError);
  useEffect(() => {
    if (dashboards) load();
  }, [slugs]);

  useEffect(() => {
    if (!dirty.size) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty.size]);

  if (error) return html`<div class="page"><${Empty} icon="alert-circle-outline" title="Couldn't load the layouts">${error.message}<//></div>`;
  if (!dashes) return html`<div class="page"><p class="hint">Loading…</p></div>`;
  if (!dashes.length) {
    return html`<div class="page"><${Empty} icon="tablet-dashboard" title="No viewport layouts yet">
      <a href="#/layouts/new-viewport">Make one</a>, then every viewport's screens are here together.
    <//></div>`;
  }

  const setLayout = (slug, layout) => {
    setDashes(dashes.map((d) => (d.slug === slug ? { ...d, layout } : d)));
    setDirty(new Set([...dirty, slug]));
  };
  const save = async () => {
    setSaving(true);
    const failed = [];
    for (const d of dashes.filter((x) => dirty.has(x.slug))) {
      try {
        await api(`/api/dashboards/${encodeURIComponent(d.slug)}`, { method: 'PUT', body: { name: d.name, layout: d.layout } });
      } catch (e) {
        failed.push(`${d.name}: ${e.message}`);
      }
    }
    setSaving(false);
    if (failed.length) {
      flash(`Save failed: ${failed.join('; ')}`, 8000);
      return;
    }
    const n = dirty.size;
    setDirty(new Set());
    flash(`Saved ${n} layout${n === 1 ? '' : 's'} — displays pick them up on their next refresh`);
    reloadDashboards();
  };
  const discard = () => {
    if (!confirm('Discard your changes to every layout?')) return;
    load();
  };

  const current = dashes.find((d) => sel && d.slug === sel.slug) || dashes[0];
  const displays = (d) => (d.devices.length ? d.devices.map((c) => c.name).join(', ') : 'No display yet');
  const lists = dashes.map(
    (d) => html`<${ScreensList} key=${d.slug}
      title=${html`${d.name}${dirty.has(d.slug) ? html` <span class="hint">· unsaved</span>` : ''}`}
      subtitle=${displays(d)}
      actions=${html`<a class="hint" href=${`#/viewport-layouts/${encodeURIComponent(d.slug)}`} title="Open this layout on its own">Open</a>`}
      screens=${d.layout.screens}
      selected=${sel && sel.slug === d.slug ? sel.screen : null}
      onSelect=${(screen) => setSel({ slug: d.slug, screen })}
      onChange=${(screens) => setLayout(d.slug, { ...d.layout, screens })}
      useDragOrder=${useDragOrder} />`
  );
  const total = dashes.reduce((n, d) => n + d.devices.length, 0);
  return html`<div class="page page-wide">
    <div class="page-head">
      <div class="ph-text">
        <h1>All viewports</h1>
        <p class="hint">${dashes.length} layout${dashes.length === 1 ? '' : 's'} · ${total} display${total === 1 ? '' : 's'} · every carousel in one builder. Pick any screen to edit it; How it hangs and Timing below the lists are for that screen's layout.</p>
      </div>
      <div class="page-actions">
        <span class=${`flash ${msg.startsWith('Save failed') ? 'flash-bad' : ''}`}>${msg}</span>
        ${dirty.size > 0 && html`<${Button} onClick=${discard}>Discard<//>`}
        <${Button} kind="primary" icon="content-save-outline" disabled=${!dirty.size || saving} onClick=${save}>${saving ? 'Saving…' : dirty.size > 1 ? `Save ${dirty.size} layouts` : 'Save'}<//>
      </div>
    </div>
    <${DashboardBuilder} key=${current.slug} layout=${current.layout} onChange=${(layout) => setLayout(current.slug, layout)} rooms=${rooms} useDragOrder=${useDragOrder}
      selectedId=${sel && sel.slug === current.slug ? sel.screen : current.layout.screens[0] && current.layout.screens[0].id}
      onSelect=${(screen) => setSel({ slug: current.slug, screen })}
      screensList=${lists} />
  </div>`;
}
