// Settings -> Remote updates: over-the-air firmware for remotes
// (lib/firmware.js). Off until switched on. A release goes to the pilot
// remotes first, and to everyone only when promoted here.

import { html, useState, api, Icon, Card, Field, Select, Toggle, Button, Badge, useFlash, useApi, timeAgo } from './lib.js';

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
      const r = await api('/api/firmware/releases');
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
      const r = await api('/api/firmware/import', { method: 'POST', body: { tag } });
      flash(`Added ${r.build.version} from GitHub`);
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
    <div class="row" style="align-items:flex-end">
      <${Field} label="From the firmware's GitHub releases" hint=${`Repository ${s.repo}. The release's app image is checked against its published checksum.`}>
        ${releases
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
