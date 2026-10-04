// Setting up an office's meeting-room signs at once (lib/meeting-rooms.js):
//   MeetingRoomsBulk   paste the rooms (a spreadsheet's columns: name,
//                      calendar, and optionally an occupancy sensor and the
//                      display's MAC) -> a sign layout per room, each listing
//                      the others, and the displays set up
//   WaitingDisplays    approve every display waiting to pair in one go, each
//                      with its name and layout

import { html, useState, useEffect, api, go, Icon, Card, Field, Select, Toggle, Button, Badge, useFlash, Empty } from './lib.js';

const EXAMPLE = `Boardroom, https://outlook.office365.com/owa/calendar/…/calendar.ics, a0:b1:c2:00:01:01
Focus room, webcal://p01-caldav.icloud.com/published/2/…
Huddle, calendar.huddle, binary_sensor.huddle_occupied`;

// A calendar link's host (never its secret path), for the table.
function linkHost(v) {
  try {
    return new URL(v.replace(/^webcals?:/i, 'https:')).host || 'link';
  } catch {
    return 'link';
  }
}

const DISPLAY_TEXT = {
  new: 'new: set up when it connects',
  expected: 'listed, not connected yet',
  pending: 'waiting for approval',
  approved: 'paired',
  revoked: 'revoked'
};

export function MeetingRoomsBulk({ reloadDashboards, reloadClients, page }) {
  const [open, setOpen] = useState(Boolean(page));
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [finder, setFinder] = useState(true);
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [msg, flash] = useFlash();

  // Read the list as it's typed (or pasted).
  useEffect(() => {
    if (!text.trim()) return setRows([]);
    const t = setTimeout(() => {
      api('/api/meeting-rooms/parse', { method: 'POST', body: { text } })
        .then((r) => setRows(r.rooms))
        .catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const good = rows.filter((r) => !r.problems.length);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api('/api/meeting-rooms', { method: 'POST', body: { text, finder, approve } });
      setDone(r);
      setText('');
      await Promise.all([reloadDashboards(), reloadClients && reloadClients()]);
    } catch (e) {
      flash(e.message, 6000);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return html`<button type="button" class="card card-button" onClick=${() => setOpen(true)}>
      <div class="card-head">
        <div class="card-icon"><${Icon} name="table-large-plus" size=${22} /></div>
        <div class="card-titles"><h2>Add many meeting rooms</h2><p class="hint">Paste a list of rooms: a sign for each, set up at once</p></div>
      </div>
    </button>`;
  }
  return html`<div style="grid-column:1/-1">
    <${Card} icon="table-large-plus" title="Add many meeting rooms"
      subtitle="One room per line: its name, its calendar (a calendar link or a Home Assistant calendar) and, if you like, an occupancy sensor and the display's MAC address. Paste columns straight from a spreadsheet."
      actions=${page ? null : html`<${Button} small kind="ghost" icon="close" title="Close" onClick=${() => { setOpen(false); setDone(null); }} />`}>
      <textarea class="bulk-text" rows="7" spellcheck="false" placeholder=${EXAMPLE} value=${text} onInput=${(e) => { setText(e.target.value); setDone(null); }} style="width:100%"></textarea>
      ${rows.length > 0 &&
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Room</th><th>Calendar</th><th>Occupancy</th><th>Display</th><th></th></tr></thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td><b>${r.name || '—'}</b></td>
              <td>${r.calendar ? (/^(webcal|https?):/i.test(r.calendar) ? html`<${Badge} icon="link-variant">${linkHost(r.calendar)}<//>` : html`<code>${r.calendar}</code>`) : '—'}</td>
              <td>${r.occupancy ? html`<code>${r.occupancy}</code>` : ''}</td>
              <td>${r.mac ? html`<code>${r.mac}</code> <span class="hint">${DISPLAY_TEXT[r.display] || r.display}</span>` : ''}</td>
              <td style="white-space:normal">${r.problems.length
                ? html`<span style="color:var(--bad)">Line ${r.line}: ${r.problems.join('; ')}</span>`
                : html`<span class="hint">${r.exists ? 'updates its layout' : 'new layout'}</span>`}</td>
            </tr>`
          )}
        </tbody>
      </table></div>`}
      <${Toggle} checked=${finder} onChange=${setFinder} label="Each sign's second screen lists the other rooms, free ones first (up to 12, the nearest in the list first)" />
      <${Toggle} checked=${approve} onChange=${setApprove} label="Approve the listed displays now, so each starts the moment it connects" />
      ${approve && html`<p class="hint">Only the MAC addresses you list are approved. Anyone who copies one onto another device on this network could read that room's sign, so list them from the displays themselves (each shows its address while it waits).</p>`}
      <p class="hint">Each sign wakes on the half hour, a couple of minutes before each meeting starts and ends, and only every 4 hours from 7 pm to 7 am and at weekends. Change any of it in the layout afterwards.</p>
      <div class="row">
        <${Button} kind="primary" icon="plus" disabled=${!good.length || busy} onClick=${create}>${busy ? 'Setting up…' : `Set up ${good.length} room${good.length === 1 ? '' : 's'}`}<//>
        <span class="flash flash-bad">${msg}</span>
      </div>
      ${done &&
      html`<div class="hint">
        <p style="color:var(--ok)">Done: ${done.results.length} sign${done.results.length === 1 ? '' : 's'}.${done.skipped.length ? ` ${done.skipped.length} line${done.skipped.length === 1 ? '' : 's'} skipped.` : ''}</p>
        <ul>${done.results.map((r) => html`<li><a href=${`#/viewport-layouts/${encodeURIComponent(r.slug)}`}>${r.name}</a> — layout ${r.layout}${r.display ? `, display ${r.display}` : ''}</li>`)}</ul>
      </div>`}
    <//>
  </div>`;
}

export function WaitingDisplays({ clients, dashboards, reloadClients, page }) {
  const waiting = (clients || []).filter((c) => c.status === 'pending' && c.lastSeenAt);
  const [rows, setRows] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, flash] = useFlash();
  if (page && !waiting.length) {
    return html`<${Empty} icon="check-all" title="No displays waiting">Turn displays on: each asks to pair and is listed here, to name, give a layout and approve together.<//>`;
  }
  if (waiting.length < (page ? 1 : 2)) return null;
  const row = (c) => rows[c.mac] || { on: true, name: c.name === c.mac ? '' : c.name, dashboard: c.dashboard || '' };
  const set = (c, k, v) => setRows({ ...rows, [c.mac]: { ...row(c), [k]: v } });
  const chosen = waiting.filter((c) => row(c).on);
  const approve = async () => {
    setBusy(true);
    try {
      const r = await api('/api/pairing/approve-many', {
        method: 'POST',
        body: { devices: chosen.map((c) => ({ mac: c.mac, name: row(c).name || c.mac, dashboard: row(c).dashboard })) }
      });
      const failed = r.results.filter((x) => !x.ok);
      flash(failed.length ? `${failed.length} couldn't be approved` : `Approved ${r.results.length}. Each starts at its next check (or a button press).`, 8000);
      await reloadClients();
    } catch (e) {
      flash(e.message, 6000);
    } finally {
      setBusy(false);
    }
  };
  const layouts = [{ value: '', label: 'No layout yet' }, ...(dashboards || []).map((d) => ({ value: d.slug, label: d.name }))];
  return html`<div style="grid-column:1/-1">
    <${Card} icon="check-all" title=${`${waiting.length} display${waiting.length === 1 ? '' : 's'} waiting to pair`} subtitle="Approve them together. Each shows its address on its screen while it waits, so you can tell which is which.">
      <div class="table-wrap"><table class="table">
        <thead><tr><th></th><th>Address</th><th>Name</th><th>Layout</th></tr></thead>
        <tbody>
          ${waiting.map(
            (c) => html`<tr>
              <td><input type="checkbox" checked=${row(c).on} onChange=${(e) => set(c, 'on', e.target.checked)} /></td>
              <td><code>${c.mac.toUpperCase()}</code><div class="hint">${c.lastIp || ''}</div></td>
              <td><input type="text" value=${row(c).name} placeholder="e.g. Boardroom sign" onInput=${(e) => set(c, 'name', e.target.value)} /></td>
              <td><${Select} value=${row(c).dashboard} onChange=${(v) => set(c, 'dashboard', v)} options=${layouts} /></td>
            </tr>`
          )}
        </tbody>
      </table></div>
      <div class="row">
        <${Button} kind="primary" icon="check-all" disabled=${!chosen.length || busy} onClick=${approve}>Approve ${chosen.length} as viewport${chosen.length === 1 ? '' : 's'}<//>
        <span class="flash">${msg}</span>
      </div>
    <//>
  </div>`;
}
