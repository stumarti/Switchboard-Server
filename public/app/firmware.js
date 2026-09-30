// Settings -> Remote updates: over-the-air firmware for remotes
// (lib/firmware.js). Off until switched on. A release goes to the pilot
// remotes first, and to everyone only when promoted here.

import { html, useState, useEffect, api, Icon, Card, Field, Select, Toggle, Button, Badge, useFlash, useApi, timeAgo } from './lib.js';

const STATE = {
  current: { kind: 'ok', icon: 'check-circle-outline', label: 'Up to date' },
  pending: { kind: 'accent', icon: 'progress-download', label: 'Will update' },
  failed: { kind: 'bad', icon: 'alert-circle-outline', label: 'Update failed' },
  waiting: { kind: '', icon: 'timer-sand', label: 'Not in this stage' },
  unknown: { kind: 'warn', icon: 'help-circle-outline', label: 'Version unknown' }
};
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

function Builds({ data, reload, flash }) {
  const [busy, setBusy] = useState('');
  const [releases, setReleases] = useState(null);
  const [tag, setTag] = useState('');
  const s = data.settings;
  const repos = s.repos || [];
  const [repo, setRepo] = useState(repos[0] || '');
  const [newRepo, setNewRepo] = useState('');
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
      flash(e.message, 8000);
    }
  };
  const addRepo = () =>
    saveRepos([...repos, newRepo], () => {
      setNewRepo('');
      flash(`Added ${newRepo.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '')}`);
    });
  const removeRepo = (r) => {
    if (!confirm(`Remove ${r} from the list? Builds already added from it stay.`)) return;
    saveRepos(repos.filter((x) => x !== r), () => r === repo && pickRepo(repos.find((x) => x !== r) || ''));
  };
  const makeFirst = (r) => saveRepos([r, ...repos.filter((x) => x !== r)]);

  const upload = async (file) => {
    if (!file) return;
    setBusy('upload');
    try {
      const res = await fetch('/api/firmware/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      flash(`Added ${j.build.version}`);
      reload();
    } catch (e) {
      flash(`Upload failed: ${e.message}`, 8000);
    } finally {
      setBusy('');
    }
  };
  const listReleases = async () => {
    setBusy('list');
    try {
      const r = await api(`/api/firmware/releases?repo=${encodeURIComponent(repo)}`);
      setReleases(r.releases);
      setTag((r.releases[0] && r.releases[0].tag) || '');
    } catch (e) {
      flash(`GitHub: ${e.message}`, 8000);
    } finally {
      setBusy('');
    }
  };
  const importTag = async () => {
    setBusy('import');
    try {
      const r = await api('/api/firmware/import', { method: 'POST', body: { repo, tag } });
      flash(`Added ${r.build.version} from ${repo}`);
      reload();
    } catch (e) {
      flash(`Import failed: ${e.message}`, 8000);
    } finally {
      setBusy('');
    }
  };
  const remove = async (v) => {
    if (!confirm(`Delete build ${v}?`)) return;
    try {
      await api(`/api/firmware/builds/${encodeURIComponent(v)}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      flash(e.message, 6000);
    }
  };

  return html`<${Card} icon="package-variant-closed" title="Builds" subtitle="Firmware this server can send. Only Switchboard remote images for the ESP32-S3 are accepted; the version comes from the image itself.">
    <${Field} label="GitHub repositories" hint="Firmware repositories whose releases can be added below: the Switchboard firmware, or your own fork. A release needs its switchboard-app-<version>.bin and .sha256 (the firmware's release workflow publishes both). The first is the one “Get latest release” uses. GitHub is only contacted when you press a button here.">
      <div class="repo-list">
        ${repos.map(
          (r, i) => html`<div class="repo-row">
            <${Icon} name="github" size=${18} />
            <a href=${`https://github.com/${r}/releases`} target="_blank" rel="noopener"><code>${r}</code></a>
            ${i === 0 ? html`<${Badge} kind="accent">Get latest<//>` : html`<${Button} kind="ghost" small icon="arrow-up" title="Use for Get latest release" onClick=${() => makeFirst(r)} />`}
            <span class="spacer"></span>
            <${Button} kind="ghost" small icon="close" title="Remove" onClick=${() => removeRepo(r)} />
          </div>`
        )}
        ${!repos.length && html`<p class="hint">None: builds can only be uploaded.</p>`}
        <form class="row" style="align-items:center" onSubmit=${(e) => { e.preventDefault(); if (newRepo.trim()) addRepo(); }}>
          <div style="flex:1"><input type="text" value=${newRepo} placeholder="owner/name or https://github.com/owner/name" onInput=${(e) => setNewRepo(e.target.value)} /></div>
          <${Button} type="submit" icon="plus" disabled=${!newRepo.trim()}>Add repository<//>
        </form>
      </div>
    <//>
    <div class="row" style="align-items:flex-end">
      <${Field} label="Add a release" hint="The release's app image is checked against its published checksum and the version inside it.">
        ${repos.length > 1 &&
        html`<div style="margin-bottom:8px"><${Select} value=${repo} onChange=${pickRepo} options=${repos.map((r) => ({ value: r, label: r }))} /></div>`}
        ${!repos.length
          ? html`<span class="hint">Add a repository first.</span>`
          : releases
          ? html`<div class="row" style="align-items:center">
              <div style="flex:1"><${Select} value=${tag} onChange=${setTag}
                options=${releases.length ? releases.map((r) => ({ value: r.tag, label: `${r.tag}${r.prerelease ? ' (pre-release)' : ''} · ${new Date(r.date).toLocaleDateString()}` })) : [{ value: '', label: 'No releases with an app image yet' }]} /></div>
              <${Button} icon="download" disabled=${!tag || busy} onClick=${importTag}>${busy === 'import' ? 'Adding…' : 'Add'}<//>
            </div>`
          : html`<${Button} icon="github" disabled=${Boolean(busy)} onClick=${listReleases}>${busy === 'list' ? 'Looking…' : 'Show releases'}<//>`}
      <//>
      <${Field} label="Or upload a file" hint="switchboard-app-<version>.bin (not the full flasher image)">
        <label class="btn"><${Icon} name="upload" size=${18} /><span>${busy === 'upload' ? 'Uploading…' : 'Upload .bin'}</span>
          <input type="file" accept=".bin" style="display:none" disabled=${Boolean(busy)} onChange=${(e) => upload(e.target.files[0])} />
        </label>
      <//>
    </div>
    ${data.builds.length
      ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Version</th><th>Size</th><th>Added</th><th>From</th><th>SHA-256</th><th></th></tr></thead>
          <tbody>${data.builds.map(
            (b) => html`<tr>
              <td><code>${b.version}</code> ${s.release === b.version && html`<${Badge} kind="accent" icon="star-outline">Release<//>`}</td>
              <td>${(b.size / 1048576).toFixed(2)} MB</td>
              <td>${timeAgo(b.addedAt)}</td>
              <td class="hint">${b.source}</td>
              <td><code title=${b.sha256}>${b.sha256.slice(0, 12)}…</code></td>
              <td>${s.release !== b.version && html`<${Button} kind="ghost" small icon="trash-can-outline" title="Delete" onClick=${() => remove(b.version)} />`}</td>
            </tr>`
          )}</tbody>
        </table></div>`
      : html`<p class="hint">No builds yet.</p>`}
  <//>`;
}

export function RemoteUpdatesTab() {
  const [data, , reload] = useApi('/api/firmware');
  const [msg, flash] = useFlash();
  if (!data) return html`<p class="hint">Loading…</p>`;
  const s = data.settings;
  const put = async (body) => {
    try {
      await api('/api/firmware/settings', { method: 'PUT', body });
      reload();
    } catch (e) {
      flash(e.message, 6000);
    }
  };
  const pilots = new Set(s.pilot);
  const togglePilot = (mac, on) => put({ pilot: on ? [...pilots, mac] : [...pilots].filter((m) => m !== mac) });
  const counts = data.remotes.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
  const pilotOnly = s.stage !== 'everyone';

  return html`<div class="stack">
    ${msg && html`<div class=${`flash ${/fail|error|GitHub|No such/i.test(msg) ? 'flash-bad' : ''}`}>${msg}</div>`}
    <${Card} icon="update" title="Remote updates" subtitle="Send new firmware to remotes over Wi-Fi. Off until you switch it on."
      actions=${html`<${Toggle} checked=${s.enabled} onChange=${(v) => put({ enabled: v })} />`}>
      <div class="row">
        <${Field} label="Release" hint="The version remotes should run. Choosing an older build rolls remotes back to it.">
          <${Select} value=${s.release} onChange=${(v) => put({ release: v })}
            options=${[{ value: '', label: 'None' }, ...data.builds.map((b) => ({ value: b.version, label: b.version }))]} />
        <//>
        <${Field} label="Rollout">
          <div class="row" style="align-items:center">
            ${pilotOnly
              ? html`<${Badge} kind="warn" icon="account-hard-hat-outline">Pilot remotes only<//>
                  <${Button} icon="account-group-outline" disabled=${!s.release || !s.pilot.length} onClick=${() => confirm(`Send ${s.release} to every remote?`) && put({ stage: 'everyone' })}>Release to everyone<//>`
              : html`<${Badge} kind="accent" icon="account-group-outline">Everyone<//>
                  <${Button} kind="ghost" icon="undo" onClick=${() => put({ stage: 'pilot' })}>Back to pilot only<//>`}
          </div>
        <//>
      </div>
      <p class="hint">A new release goes to the pilot remotes first. Once they've updated and still work, release it to everyone. Each remote checks the download's SHA-256 and needs at least ${s.minBattery}% battery. If new firmware can't reach this server on its first run, the remote goes back to the version it had.</p>
      <div class="row">
        <${Toggle} checked=${s.button} onChange=${(v) => put({ button: v })} label="Remotes can update from Settings → Firmware update" />
      </div>
      <div class="row" style="align-items:center">
        <${Toggle} checked=${s.schedule.enabled} onChange=${(v) => put({ schedule: { ...s.schedule, enabled: v } })} label="Update on a schedule, between" />
        <div style="width:110px"><${Select} value=${String(s.schedule.fromHour)} onChange=${(v) => put({ schedule: { ...s.schedule, fromHour: Number(v) } })} options=${HOURS} /></div>
        <span class="hint">and</span>
        <div style="width:110px"><${Select} value=${String(s.schedule.toHour)} onChange=${(v) => put({ schedule: { ...s.schedule, toHour: Number(v) } })} options=${HOURS} /></div>
        <span class="hint">(server time, on a remote's timer wake)</span>
      </div>
      <div class="row" style="align-items:center">
        <span class="hint">Minimum battery</span>
        <div style="width:110px"><${Select} value=${String(s.minBattery)} onChange=${(v) => put({ minBattery: Number(v) })}
          options=${[20, 30, 40, 50, 60].map((n) => ({ value: String(n), label: `${n}%` }))} /></div>
      </div>
    <//>

    <${Card} icon="remote" title="Remotes" subtitle="Tick the pilot remotes: they get each release first."
      actions=${html`${counts.failed > 0 && html`<${Badge} kind="bad">${counts.failed} failed<//>`}${counts.pending > 0 && html`<${Badge} kind="accent">${counts.pending} to update<//>`}`}>
      ${data.remotes.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Pilot</th><th>Remote</th><th>Runs</th><th>Status</th><th>Last attempt</th></tr></thead>
            <tbody>${data.remotes.map((r) => {
              const st = STATE[r.state];
              return html`<tr>
                <td><input type="checkbox" checked=${r.pilot} onChange=${(e) => togglePilot(r.mac, e.target.checked)} /></td>
                <td><a href=${`#/remotes/${encodeURIComponent(r.mac)}`}>${r.name}</a></td>
                <td>${r.running ? html`<code>${r.running}</code>` : html`<span class="hint">—</span>`}</td>
                <td><${Badge} kind=${st.kind} icon=${st.icon}>${st.label}${r.offer ? ` → ${r.offer}` : ''}<//></td>
                <td>${r.last
                  ? html`<span class=${r.last.ok || r.state === 'current' ? '' : 'text-bad'}>${r.last.ok ? 'Installed' : 'Failed'} ${r.last.version}${r.last.error ? `: ${r.last.error}` : ''}</span> <span class="hint">${timeAgo(r.last.at)}</span>`
                  : html`<span class="hint">—</span>`}</td>
              </tr>`;
            })}</tbody>
          </table></div>`
        : html`<p class="hint">No approved remotes yet.</p>`}
      <p class="hint">Remotes on firmware from before updates existed have to be flashed by USB (or the web flasher) once.</p>
    <//>

    <${Builds} data=${data} reload=${reload} flash=${flash} />
  </div>`;
}

// The Remotes page's summary of over-the-air updates, with the next step as
// a button: get the newest release, send it to the pilots, then to everyone.
// The whole picture is Settings -> Remote updates ("Details").
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
  const count = (st) => fw.remotes.filter((r) => r.state === st).length;
  const newest = fw.builds[0] && fw.builds[0].version;
  const run = async (key, fn, done) => {
    setBusy(key);
    try {
      const r = await fn();
      if (done) flash(done(r));
      await load();
    } catch (e) {
      flash(e.message, 8000);
    } finally {
      setBusy('');
    }
  };
  const put = (body) => api('/api/firmware/settings', { method: 'PUT', body });
  const getLatest = () =>
    run('latest', () => api('/api/firmware/latest', { method: 'POST' }), (r) => (r.added ? `Added ${r.version}` : `${r.version} is the newest; already here`));

  let status;
  let actions;
  if (!s.enabled) {
    status = html`<span class="hint">Off. Remotes only change firmware by USB or the web flasher.</span>`;
    actions = html`<a class="btn" href="#/settings/updates"><${Icon} name="cog-outline" size=${18} /><span>Set up</span></a>`;
  } else {
    const pending = count('pending');
    const failed = count('failed');
    const current = count('current');
    status = html`<div class="kv kv-home">
      <span>Release</span><b>${s.release ? html`<code>${s.release}</code> · ${s.stage === 'everyone' ? 'everyone' : `pilot remotes (${s.pilot.length})`}` : 'none chosen'}</b>
      <span>Remotes</span><b>${current} up to date${pending ? ` · ${pending} to update` : ''}${failed ? html` · <span class="text-bad">${failed} failed</span>` : ''}</b>
      <span>How</span><b>${[s.button ? 'from the remote' : '', s.schedule.enabled ? `nightly ${String(s.schedule.fromHour).padStart(2, '0')}:00–${String(s.schedule.toHour).padStart(2, '0')}:00` : ''].filter(Boolean).join(' · ') || 'nothing set'}</b>
    </div>`;
    actions = html`
      <${Button} icon="github" disabled=${Boolean(busy)} onClick=${getLatest}>${busy === 'latest' ? 'Checking…' : 'Get latest release'}<//>
      ${newest && newest !== s.release &&
      html`<${Button} kind="primary" icon="account-hard-hat-outline" disabled=${Boolean(busy) || !s.pilot.length}
          title=${s.pilot.length ? '' : 'Tick pilot remotes on the Remote updates page first'}
          onClick=${() => run('release', () => put({ release: newest }), () => `${newest} goes to the pilot remotes`)}>Send ${newest} to pilots<//>`}
      ${s.release && s.stage !== 'everyone' &&
      html`<${Button} icon="account-group-outline" disabled=${Boolean(busy)}
          onClick=${() => confirm(`Send ${s.release} to every remote?`) && run('everyone', () => put({ stage: 'everyone' }), () => `${s.release} goes to every remote`)}>Release to everyone<//>`}
      <a class="btn btn-ghost" href="#/settings/updates"><${Icon} name="chevron-right" size=${18} /><span>Details</span></a>`;
  }
  return html`<${Card} icon="update" title="Remote updates"
    actions=${s.enabled ? html`<${Badge} kind="ok" icon="check">On<//>` : html`<${Badge}>Off<//>`}>
    ${status}
    ${msg && html`<p class=${`hint ${/fail|error|GitHub|no releases|isn't/i.test(msg) ? 'text-bad' : ''}`}>${msg}</p>`}
    <div class="row" style="margin-top:12px;flex-wrap:wrap">${actions}</div>
  <//>`;
}

// A remote's page: its firmware, with its update state as the icon (and in
// the tooltip) when updates are on.
export function DeviceUpdateBadge({ mac, firmware }) {
  const [fw] = useApi('/api/firmware');
  const r = fw && fw.settings.enabled ? fw.remotes.find((x) => x.mac === mac) : null;
  const st = r && STATE[r.state];
  if (!firmware && !r) return null;
  const tip = !st ? '' : r.state === 'failed' ? `Couldn't update to ${r.offer}${r.last && r.last.error ? `: ${r.last.error}` : ''}` : r.offer ? `Will update to ${r.offer}` : st.label;
  return html`<a href="#/settings/updates" title=${tip} style="text-decoration:none">
    <${Badge} kind=${st ? st.kind : ''} icon=${st ? st.icon : 'chip'}>fw ${firmware || '?'}${r && r.offer ? ` → ${r.offer}` : ''}<//>
  </a>`;
}
