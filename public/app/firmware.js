// Settings -> Firmware updates: over-the-air firmware (lib/firmware.js). Off
// until switched on. Every build is for one board (a kind of device), and
// each board has its own release: it goes to that board's pilots first, and
// to everyone only when promoted here.
//
//   Releases  each board's release and how far it has got
//   Devices   every device's firmware, and which are pilots
//   Rules     when devices update, and the safety checks
//   Builds    the firmware this server holds; upload one
//   Sources   (a popup) the GitHub repositories releases come from

import { html, useState, useEffect, api, Icon, Card, Field, Select, Toggle, Button, Badge, Modal, useFlash, useApi, timeAgo, boardLabel } from './lib.js';

const STATE = {
  current: { kind: 'ok', icon: 'check-circle-outline', label: 'Up to date' },
  pending: { kind: 'accent', icon: 'progress-download', label: 'Will update' },
  failed: { kind: 'bad', icon: 'alert-circle-outline', label: 'Update failed' },
  waiting: { kind: '', icon: 'timer-sand', label: 'Not in this stage' },
  none: { kind: '', icon: 'minus-circle-outline', label: 'No release for its board' },
  unknown: { kind: 'warn', icon: 'help-circle-outline', label: 'Version unknown' }
};
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

// The GitHub repositories releases come from, and adding one release.
function Sources({ data, reload, flash, onClose, getLatest, busy: latestBusy }) {
  const [busy, setBusy] = useState('');
  const [releases, setReleases] = useState(null);
  const [tag, setTag] = useState('');
  const s = data.settings;
  const repos = s.repos || [];
  const [repo, setRepo] = useState(repos[0] || '');
  const [newRepo, setNewRepo] = useState('');
  const [note, setNote] = useState('');
  const pickRepo = (r) => {
    setRepo(r);
    setReleases(null);
    setTag('');
  };
  const saveRepos = async (list, done) => {
    try {
      await api('/api/firmware/settings', { method: 'PUT', body: { repos: list } });
      if (done) done();
      reload();
    } catch (e) {
      setNote(e.message);
    }
  };
  const addRepo = () =>
    saveRepos([...repos, newRepo], () => {
      setNewRepo('');
      setNote(`Added ${newRepo.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '')}`);
    });
  const removeRepo = (r) => {
    if (!confirm(`Remove ${r} from the list? Builds already added from it stay.`)) return;
    saveRepos(repos.filter((x) => x !== r), () => r === repo && pickRepo(repos.find((x) => x !== r) || ''));
  };
  const makeFirst = (r) => saveRepos([r, ...repos.filter((x) => x !== r)]);
  const listReleases = async (r = repo) => {
    setBusy('list');
    try {
      const res = await api(`/api/firmware/releases?repo=${encodeURIComponent(r)}`);
      setReleases(res.releases);
      setTag((res.releases[0] && res.releases[0].tag) || '');
    } catch (e) {
      setNote(`GitHub: ${e.message}`);
    } finally {
      setBusy('');
    }
  };
  const importTag = async () => {
    setBusy('import');
    try {
      const r = await api('/api/firmware/import', { method: 'POST', body: { repo, tag } });
      flash(`Added ${tag} from ${repo} for ${r.builds.map((b) => boardLabel(b.board)).join(', ')}`);
      reload();
      onClose();
    } catch (e) {
      setNote(`Couldn't add it: ${e.message}`);
    } finally {
      setBusy('');
    }
  };
  return html`<${Modal} title="Firmware sources" icon="source-repository" onClose=${onClose} wide
    footer=${html`<span class="hint" style="margin-right:auto">GitHub is only contacted when you press a button here.</span>
      <${Button} icon="github" disabled=${Boolean(latestBusy) || !repos.length} onClick=${getLatest}>${latestBusy ? 'Checking…' : 'Get latest releases'}<//>
      <${Button} kind="primary" onClick=${onClose}>Done<//>`}>
    <p class="hint">Repositories whose releases this server can add: the Switchboard firmware, your own fork, or another kind of device's. A release carries <code>${'switchboard-<board>-app-<version>.bin'}</code> and its <code>.sha256</code> for each board (the firmware's release workflow publishes them). <b>Get latest releases</b> checks them all, top first.</p>
    <div class="list-box">
      ${repos.map(
        (r, i) => html`<div class="list-row">
          <${Icon} name="github" size=${18} />
          <a href=${`https://github.com/${r}/releases`} target="_blank" rel="noopener"><code>${r}</code></a>
          ${i === 0 && repos.length > 1 && html`<${Badge}>Checked first<//>`}
          <span class="pagebar-sp"></span>
          <${Button} kind="ghost" small icon="tag-search-outline" title="Pick a release from it" onClick=${() => { pickRepo(r); listReleases(r); }}>Pick a release…<//>
          ${i > 0 && html`<${Button} kind="ghost" small icon="arrow-up" title="Check it first" onClick=${() => makeFirst(r)} />`}
          <${Button} kind="ghost" small icon="close" title="Remove" onClick=${() => removeRepo(r)} />
        </div>`
      )}
      ${!repos.length && html`<p class="hint" style="padding:10px 12px">None: builds can only be uploaded.</p>`}
      <form class="list-row list-row-add" onSubmit=${(e) => { e.preventDefault(); if (newRepo.trim()) addRepo(); }}>
        <input type="text" value=${newRepo} placeholder="owner/name or https://github.com/owner/name" onInput=${(e) => setNewRepo(e.target.value)} />
        <${Button} type="submit" icon="plus" disabled=${!newRepo.trim()}>Add repository<//>
      </form>
    </div>
    ${busy === 'list' && html`<p class="hint">Asking GitHub for ${repo}'s releases…</p>`}
    ${releases &&
    html`<${Field} label=${`A release from ${repo}`} hint="Each of its app images is checked against its published checksum, and the board and version inside it.">
      <div class="row" style="align-items:center">
        <div style="flex:1"><${Select} value=${tag} onChange=${setTag}
          options=${releases.length ? releases.map((r) => ({ value: r.tag, label: `${r.tag}${r.prerelease ? ' (pre-release)' : ''} · ${r.boards.map(boardLabel).join(', ')} · ${new Date(r.date).toLocaleDateString()}` })) : [{ value: '', label: 'No releases with an app image yet' }]} /></div>
        <${Button} kind="primary" icon="download" disabled=${!tag || Boolean(busy)} onClick=${importTag}>${busy === 'import' ? 'Adding…' : 'Add this release'}<//>
      </div>
    <//>`}
    ${note && html`<p class=${`hint ${/GitHub|Couldn|fail|invalid|not/i.test(note) ? 'text-bad' : ''}`}>${note}</p>`}
  <//>`;
}

function BuildsCard({ data, reload, flash }) {
  const [busy, setBusy] = useState(false);
  const s = data.settings;
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await fetch('/api/firmware/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      flash(`Added ${j.build.version} for ${boardLabel(j.build.board)}`);
      reload();
    } catch (e) {
      flash(`Upload failed: ${e.message}`, 8000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (b) => {
    if (!confirm(`Delete the ${boardLabel(b.board)} build ${b.version}?`)) return;
    try {
      await api(`/api/firmware/builds/${encodeURIComponent(b.version)}?board=${encodeURIComponent(b.board)}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      flash(e.message, 6000);
    }
  };
  const releaseOf = (board) => ((s.boards || {})[board] || {}).release;
  return html`<${Card} title="Builds" subtitle="Firmware this server can send. Only Switchboard app images for ESP32 chips are accepted; the board and version come from the image itself." class="card-flush"
    actions=${html`<label class="btn btn-small" title="switchboard-<board>-app-<version>.bin (not the full flasher image)"><${Icon} name="upload" size=${16} /><span>${busy ? 'Uploading…' : 'Upload .bin'}</span>
      <input type="file" accept=".bin" style="display:none" disabled=${busy} onChange=${(e) => upload(e.target.files[0])} />
    </label>`}>
    ${data.builds.length
      ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Board</th><th>Version</th><th>Size</th><th>Added</th><th>From</th><th>SHA-256</th><th></th></tr></thead>
          <tbody>${data.builds.map(
            (b) => html`<tr>
              <td>${boardLabel(b.board)}${b.chip ? html` <span class="hint">${b.chip}</span>` : ''}</td>
              <td><code>${b.version}</code> ${releaseOf(b.board) === b.version && html`<${Badge} kind="accent" icon="star-outline">Release<//>`}</td>
              <td>${(b.size / 1048576).toFixed(2)} MB</td>
              <td class="hint">${timeAgo(b.addedAt)}</td>
              <td class="hint">${b.source}</td>
              <td><code title=${b.sha256}>${b.sha256.slice(0, 12)}…</code></td>
              <td>${releaseOf(b.board) !== b.version && html`<${Button} kind="ghost" small icon="trash-can-outline" title="Delete" onClick=${() => remove(b)} />`}</td>
            </tr>`
          )}</tbody>
        </table></div>`
      : html`<p class="hint" style="padding:14px 16px">No builds yet. Get the latest releases, pick one in <b>Sources</b>, or upload a file.</p>`}
  <//>`;
}

// One board's release: which build, how far it has gone, and the next step.
function BoardRelease({ board, data, put }) {
  const bs = (data.settings.boards || {})[board] || { release: '', stage: 'pilot' };
  const builds = data.builds.filter((b) => b.board === board);
  const devices = data.remotes.filter((r) => r.board === board);
  const pilots = devices.filter((r) => r.pilot).length;
  const done = devices.filter((r) => r.state === 'current').length;
  const pilotOnly = bs.stage !== 'everyone';
  const newest = builds[0] && builds[0].version;
  return html`<tr>
    <td><b>${boardLabel(board)}</b>${boardLabel(board) !== board ? html` <span class="hint">${board}</span>` : ''}</td>
    <td style="min-width:150px"><${Select} value=${bs.release || ''} onChange=${(v) => put({ board, release: v })}
      options=${[{ value: '', label: builds.length ? 'None' : 'No builds yet' }, ...builds.map((b) => ({ value: b.version, label: b.version }))]} /></td>
    <td>${!bs.release ? html`<span class="hint">—</span>` : pilotOnly ? html`<${Badge} kind="accent" icon="account-hard-hat-outline">Pilots (${pilots})<//>` : html`<${Badge} kind="ok" icon="account-group-outline">Everyone<//>`}</td>
    <td style="min-width:150px">${bs.release
      ? html`<div class="progress-cell"><span class="meter"><i style=${{ width: `${devices.length ? Math.max(3, (done / devices.length) * 100) : 0}%`, background: done === devices.length ? 'var(--ok)' : 'var(--accent)' }}></i></span><span class="hint">${done} of ${devices.length}</span></div>`
      : html`<span class="hint">${devices.length} device${devices.length === 1 ? '' : 's'}</span>`}</td>
    <td class="td-actions">${!bs.release
      ? newest && html`<${Button} small onClick=${() => put({ board, release: newest })}>Send ${newest} to pilots<//>`
      : pilotOnly
        ? html`<${Button} small kind="primary" icon="account-group-outline" onClick=${() => confirm(`Send ${bs.release} to every ${boardLabel(board)}?`) && put({ board, stage: 'everyone' })}>Release to everyone<//>`
        : html`${newest && newest !== bs.release && html`<${Button} small onClick=${() => put({ board, release: newest })}>Send ${newest} to pilots<//>`}
            <${Button} small kind="ghost" icon="undo" onClick=${() => put({ board, stage: 'pilot' })}>Back to pilots<//>`}</td>
  </tr>`;
}

export function RemoteUpdatesTab({ head }) {
  const [data, , reload] = useApi('/api/firmware');
  const [msg, flash] = useFlash();
  const [sources, setSources] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!data) return html`${head()}<p class="hint">Loading…</p>`;
  const s = data.settings;
  const put = async (body) => {
    try {
      await api('/api/firmware/settings', { method: 'PUT', body });
      reload();
    } catch (e) {
      flash(e.message, 6000);
    }
  };
  const getLatest = async () => {
    setBusy(true);
    try {
      const r = await api('/api/firmware/latest', { method: 'POST' });
      flash(r.results
        .map((x) => (x.error ? `${x.repo}: ${x.error}` : x.added ? `Added ${x.version} (${x.boards.map(boardLabel).join(', ')})` : `${x.repo}: ${x.version} is the newest; already here`))
        .join(' · '), 10000);
      reload();
    } catch (e) {
      flash(e.message, 8000);
    } finally {
      setBusy(false);
    }
  };
  const pilots = new Set(s.pilot);
  const togglePilot = (mac, on) => put({ pilot: on ? [...pilots, mac] : [...pilots].filter((m) => m !== mac) });
  const counts = data.remotes.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
  const boards = data.boards.length ? data.boards : [data.legacyBoard];
  const manyBoards = boards.length > 1;
  const repos = s.repos || [];

  return html`
    ${head(html`
      <${Toggle} checked=${s.enabled} onChange=${(v) => put({ enabled: v })} label=${s.enabled ? 'Updates on' : 'Updates off'} />
      <span class="vsep"></span>
      <${Button} icon="source-repository" onClick=${() => setSources(true)}>Sources${repos.length ? ` (${repos.length})` : ''}<//>
      <${Button} kind="primary" icon="github" disabled=${busy || !repos.length} onClick=${getLatest}>${busy ? 'Checking…' : 'Get latest releases'}<//>`)}
    <div class="stack">
    ${msg && html`<div class=${`banner-inline ${/fail|error|GitHub|No such|limiting|took/i.test(msg) ? 'banner-bad' : 'banner-ok'}`}><${Icon} name="information-outline" size=${16} /><span>${msg}</span></div>`}
    ${!s.enabled && html`<div class="banner-inline"><${Icon} name="power-plug-off-outline" size=${16} /><span>Updates are off: devices only change firmware by USB or the web flasher. Switch them on above to send releases over Wi-Fi.</span></div>`}

    <${Card} title="Releases" subtitle="Each board (a kind of device) runs its own release. A new one goes to that board's pilots first; once they've updated and still work, release it to everyone. Choosing an older build rolls its devices back to it." class="card-flush">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Board</th><th>Release</th><th>Stage</th><th>Updated</th><th></th></tr></thead>
        <tbody>${boards.map((b) => html`<${BoardRelease} key=${b} board=${b} data=${data} put=${put} />`)}</tbody>
      </table></div>
    <//>

    <div class="settings-cols">
    <${Card} title="Devices" subtitle="Tick the pilots: they get each release for their board first." class="card-flush"
      actions=${html`${counts.failed > 0 && html`<${Badge} kind="bad">${counts.failed} failed<//>`}${counts.pending > 0 && html`<${Badge} kind="accent">${counts.pending} to update<//>`}`}>
      ${data.remotes.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Pilot</th><th>Device</th>${manyBoards && html`<th>Board</th>`}<th>Runs</th><th>Status</th><th>Last attempt</th></tr></thead>
            <tbody>${data.remotes.map((r) => {
              const st = STATE[r.state] || STATE.unknown;
              return html`<tr>
                <td><input type="checkbox" checked=${r.pilot} onChange=${(e) => togglePilot(r.mac, e.target.checked)} /></td>
                <td><a href=${`#/${r.type === 'viewport' ? 'viewports' : 'remotes'}/${encodeURIComponent(r.mac)}`}>${r.name}</a></td>
                ${manyBoards && html`<td>${boardLabel(r.board)}</td>`}
                <td>${r.running ? html`<code>${r.running}</code>` : html`<span class="hint">—</span>`}</td>
                <td><${Badge} kind=${st.kind} icon=${st.icon}>${st.label}${r.offer ? ` → ${r.offer}` : ''}<//></td>
                <td>${r.last
                  ? html`<span class=${r.last.ok || r.state === 'current' ? '' : 'text-bad'}>${r.last.ok ? 'Installed' : 'Failed'} ${r.last.version}${r.last.error ? `: ${r.last.error}` : ''}</span> <span class="hint">${timeAgo(r.last.at)}</span>`
                  : html`<span class="hint">—</span>`}</td>
              </tr>`;
            })}</tbody>
          </table></div>`
        : html`<p class="hint" style="padding:14px 16px">No approved devices with a board yet.</p>`}
      <div class="table-foot">A device's board is what its firmware says (older remotes are X4 Pros). Remotes on firmware from before updates existed have to be flashed by USB once.</div>
    <//>

    <${Card} title="Rules" subtitle="When devices install a release.">
      <${Field} label="When">
        <${Toggle} checked=${s.schedule.enabled} onChange=${(v) => put({ schedule: { ...s.schedule, enabled: v } })} label="On a schedule" />
        <div class="row" style="align-items:center;margin-top:6px">
          <div style="width:100px"><${Select} disabled=${!s.schedule.enabled} value=${String(s.schedule.fromHour)} onChange=${(v) => put({ schedule: { ...s.schedule, fromHour: Number(v) } })} options=${HOURS} /></div>
          <span class="hint">to</span>
          <div style="width:100px"><${Select} disabled=${!s.schedule.enabled} value=${String(s.schedule.toHour)} onChange=${(v) => put({ schedule: { ...s.schedule, toHour: Number(v) } })} options=${HOURS} /></div>
        </div>
        <span class="hint">Server time, on a device's timer wake.</span>
      <//>
      <${Field} label="From the remote">
        <${Toggle} checked=${s.button} onChange=${(v) => put({ button: v })} label="Settings → Firmware update on a remote installs it" />
      <//>
      <${Field} label="Minimum battery" hint="A device below this waits until it's charged.">
        <div style="width:100px"><${Select} value=${String(s.minBattery)} onChange=${(v) => put({ minBattery: Number(v) })}
          options=${[20, 30, 40, 50, 60].map((n) => ({ value: String(n), label: `${n}%` }))} /></div>
      <//>
      <${Field} label="Safety">
        <p class="hint">Each device checks the download's SHA-256 and that it's for its board. If new firmware can't reach this server on its first run, the device goes back to the version it had.</p>
      <//>
    <//>
    </div>

    <${BuildsCard} data=${data} reload=${reload} flash=${flash} />
    ${sources && html`<${Sources} data=${data} reload=${reload} flash=${flash} onClose=${() => setSources(false)} getLatest=${getLatest} busy=${busy} />`}
    </div>`;
}

// The Remotes page's summary of over-the-air updates, with the next step as
// a button: get the newest release, send it to the pilots, then to everyone.
// The whole picture is Settings -> Updates ("Details").
export function UpdatesCard() {
  const [fw, setFw] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();
  const load = () => api('/api/firmware').then(setFw).catch(() => setFw(null));
  useEffect(() => {
    load();
  }, []);
  if (!fw) return null;
  const s = fw.settings;
  const run = async (key, fn, done) => {
    setBusy(key);
    try {
      const r = await fn();
      if (done) flash(done(r), 8000);
      await load();
    } catch (e) {
      flash(e.message, 8000);
    } finally {
      setBusy('');
    }
  };
  const put = (body) => api('/api/firmware/settings', { method: 'PUT', body });
  const getLatest = () =>
    run('latest', () => api('/api/firmware/latest', { method: 'POST' }), (r) =>
      r.results
        .map((x) => (x.error ? `${x.repo}: ${x.error}` : x.added ? `Added ${x.version} (${x.boards.map(boardLabel).join(', ')})` : `${x.repo}: ${x.version} is the newest; already here`))
        .join(' · '));
  const boards = fw.boards.length ? fw.boards : [fw.legacyBoard];
  const many = boards.length > 1;

  let status;
  let actions;
  if (!s.enabled) {
    status = html`<span class="hint">Off. Devices only change firmware by USB or the web flasher.</span>`;
    actions = html`<a class="btn" href="#/settings/updates"><${Icon} name="cog-outline" size=${18} /><span>Set up</span></a>`;
  } else {
    const perBoard = boards.map((board) => {
      const bs = (s.boards || {})[board] || {};
      const mine = fw.remotes.filter((r) => r.board === board);
      const count = (st) => mine.filter((r) => r.state === st).length;
      const newest = (fw.builds.find((b) => b.board === board) || {}).version;
      return { board, bs, pending: count('pending'), failed: count('failed'), current: count('current'), newest, pilots: mine.filter((r) => r.pilot).length };
    });
    status = html`<div class="kv kv-home">
      ${perBoard.map((p) => html`
        <span>${many ? boardLabel(p.board) : 'Release'}</span>
        <b>${p.bs.release ? html`<code>${p.bs.release}</code> · ${p.bs.stage === 'everyone' ? 'everyone' : `pilots (${p.pilots})`} · ${p.current} up to date${p.pending ? ` · ${p.pending} to update` : ''}${p.failed ? html` · <span class="text-bad">${p.failed} failed</span>` : ''}` : 'none chosen'}</b>`)}
      <span>How</span><b>${[s.button ? 'from the remote' : '', s.schedule.enabled ? `nightly ${String(s.schedule.fromHour).padStart(2, '0')}:00–${String(s.schedule.toHour).padStart(2, '0')}:00` : ''].filter(Boolean).join(' · ') || 'nothing set'}</b>
    </div>`;
    actions = html`
      <${Button} icon="github" disabled=${Boolean(busy)} onClick=${getLatest}>${busy === 'latest' ? 'Checking…' : 'Get latest release'}<//>
      ${perBoard.map((p) => html`
        ${p.newest && p.newest !== p.bs.release &&
        html`<${Button} kind="primary" icon="account-hard-hat-outline" disabled=${Boolean(busy) || !p.pilots}
            title=${p.pilots ? '' : 'Tick pilots on the Updates page first'}
            onClick=${() => run(`release-${p.board}`, () => put({ board: p.board, release: p.newest }), () => `${p.newest} goes to the ${many ? `${boardLabel(p.board)} ` : ''}pilots`)}>Send ${many ? `${boardLabel(p.board)} ` : ''}${p.newest} to pilots<//>`}
        ${p.bs.release && p.bs.stage !== 'everyone' &&
        html`<${Button} icon="account-group-outline" disabled=${Boolean(busy)}
            onClick=${() => confirm(`Send ${p.bs.release} to every ${boardLabel(p.board)}?`) && run(`everyone-${p.board}`, () => put({ board: p.board, stage: 'everyone' }), () => `${p.bs.release} goes to every ${boardLabel(p.board)}`)}>Release ${many ? `${boardLabel(p.board)} ` : ''}to everyone<//>`}`)}
      <a class="btn btn-ghost" href="#/settings/updates"><${Icon} name="chevron-right" size=${18} /><span>Details</span></a>`;
  }
  return html`<${Card} icon="update" title="Updates"
    actions=${s.enabled ? html`<${Badge} kind="ok" icon="check">On<//>` : html`<${Badge}>Off<//>`}>
    ${status}
    ${msg && html`<p class=${`hint ${/fail|error|GitHub|no releases|isn't/i.test(msg) ? 'text-bad' : ''}`}>${msg}</p>`}
    <div class="row" style="margin-top:12px;flex-wrap:wrap">${actions}</div>
  <//>`;
}

// A device's page (a remote, or a display whose firmware says its board):
// its firmware, with its update state as the icon (and in the tooltip) when
// updates are on, and its board when it isn't the X4 Pro.
export function DeviceUpdateBadge({ mac, firmware, board }) {
  const [fw] = useApi('/api/firmware');
  const r = fw && fw.settings.enabled ? fw.remotes.find((x) => x.mac === mac) : null;
  const st = r && STATE[r.state];
  if (!firmware && !r) return null;
  const b = (r && r.board) || board;
  const tip = [b ? `Board: ${boardLabel(b)}` : '', !st ? '' : r.state === 'failed' ? `Couldn't update to ${r.offer}${r.last && r.last.error ? `: ${r.last.error}` : ''}` : r.offer ? `Will update to ${r.offer}` : st.label]
    .filter(Boolean)
    .join(' · ');
  return html`<a href="#/settings/updates" title=${tip} style="text-decoration:none">
    <${Badge} kind=${st ? st.kind : ''} icon=${st ? st.icon : 'chip'}>${b && b !== (fw && fw.legacyBoard) ? `${boardLabel(b)} ` : ''}fw ${firmware || '?'}${r && r.offer ? ` → ${r.offer}` : ''}<//>
  </a>`;
}
