'use strict';

/**
 * The admin Home page: how the whole Switchboard setup is doing, and what
 * needs someone's attention. Pure — server.js gathers the inputs.
 *
 *   build({devices, rooms, layouts, ha, haConfigured, server, now})
 *
 *   devices   paired devices, each {mac, name, type, status, assignedSlug,
 *             dashboard, lastSeenAt, health, refreshMin}
 *   rooms     {slug: name}      layouts  {slug: name}
 *   ha        lib/ha-monitor.js snapshot()
 *   updates   lib/firmware.js status(): each remote's update state
 *
 * Returns {counts, attention, devices, ha, server}. `attention` is sorted
 * worst first; each item {level: critical|warn|info, kind, title, detail,
 * link}.
 */

const BATTERY_CRITICAL = 10;
const BATTERY_LOW = 20;
const WEAK_RSSI = -80;
// A battery reading older than this says nothing about now.
const HEALTH_FRESH_MS = 24 * 60 * 60 * 1000;
// A remote sleeps between refreshes; not seen in a day means it's flat,
// off, out of range or can't reach the server.
const REMOTE_QUIET_MS = 24 * 60 * 60 * 1000;
const LEVELS = { critical: 0, warn: 1, info: 2 };
// Warn when the learned battery life says it runs out within this many days.
const DAYS_WARN = 3;
const daysText = (d) => (d < 1 ? 'less than a day' : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`);

const ago = (iso, now) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? now - t : Infinity;
};

function since(ms) {
  if (!Number.isFinite(ms)) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// When a device counts as offline: remotes after a day of silence; a
// viewport after three of its refresh intervals (at least an hour).
function quietLimit(d) {
  return d.type === 'viewport' ? Math.max(3 * (d.refreshMin || 30), 60) * 60000 : REMOTE_QUIET_MS;
}

function deviceView(d, { rooms, layouts, now, updates }) {
  const h = d.health || {};
  const fresh = ago(h.at, now) < HEALTH_FRESH_MS;
  const seenMs = ago(d.lastSeenAt, now);
  const assignedTo = d.type === 'viewport' ? layouts[d.dashboard] || '' : rooms[d.assignedSlug] || '';
  let battery = fresh && Number.isFinite(h.battery) ? h.battery : null;
  if (battery != null) battery = Math.max(0, Math.min(100, Math.round(battery)));
  return {
    mac: d.mac,
    name: d.name || d.mac,
    type: d.type,
    status: d.status,
    assignedTo,
    lastSeenAt: d.lastSeenAt || null,
    // Listed ahead of time (a room list with its display's MAC) and not
    // heard from yet.
    expected: Boolean(d.expected && !d.lastSeenAt),
    online: d.status === 'approved' && seenMs < quietLimit(d),
    battery,
    // Learned battery life (lib/battery-history.js): days left, how sure.
    batteryLife: d.batteryLife && battery != null ? d.batteryLife : null,
    batteryLevel: battery == null ? null : battery <= BATTERY_CRITICAL ? 'critical' : battery <= BATTERY_LOW ? 'low' : 'ok',
    rssi: fresh && Number.isFinite(h.rssi) ? h.rssi : null,
    firmware: h.firmware || '',
    // A remote's over-the-air update (lib/firmware.js status()), when updates
    // are on: {state: current|pending|failed|waiting|unknown, offer, error}.
    update: updateOf(updates, d.mac),
    link: `#/${d.type === 'viewport' ? 'viewports' : 'remotes'}/${encodeURIComponent(d.mac)}`
  };
}

function updateOf(updates, mac) {
  const u = (updates || []).find((x) => x.mac === mac);
  if (!u) return null;
  return { state: u.state, offer: u.offer || '', now: Boolean(u.now), error: (u.last && !u.last.ok && u.last.error) || '' };
}

function build({ devices = [], rooms = {}, layouts = {}, ha = {}, haConfigured = true, haNeeded = true, server = {}, updates = [], updateSummary = null, now = Date.now() }) {
  const views = devices.map((d) => deviceView(d, { rooms, layouts, now, updates }));
  const attention = [];
  const add = (level, kind, title, detail, link) => attention.push({ level, kind, title, detail, link });

  // --- Home Assistant ---
  if (!haConfigured && !haNeeded) {
    // Meeting-room signs on calendar links, say: nothing needs it yet.
    add('info', 'ha', 'Home Assistant isn’t set up', 'Nothing needs it yet: your layouts only use calendar links. Add it for rooms, sensors and anything else from your home or building.', '#/settings/home-assistant');
  } else if (!haConfigured) {
    add('critical', 'ha', 'Home Assistant isn’t set up', 'Add its address and a long-lived token, or no device can show anything.', '#/settings/home-assistant');
  } else if (ha.reachable === false) {
    add('critical', 'ha', 'Can’t reach Home Assistant', `${ha.lastError || 'No answer'} — since ${since(ago(ha.lastOkAt, now))} without a good answer.`, '#/settings/home-assistant');
  } else if (ha.lastHour && ha.lastHour.errors > 0) {
    const total = ha.lastHour.errors + ha.lastHour.ok;
    add('warn', 'ha', `${ha.lastHour.errors} Home Assistant request${ha.lastHour.errors === 1 ? '' : 's'} failed in the last hour`, `Out of ${total}. Latest: ${ha.lastError}`, '');
  }
  for (const issue of ha.entityIssues || []) {
    const ids = Object.keys(issue.entities);
    const where = issue.scope.kind === 'layout' ? layouts[issue.scope.slug] || issue.scope.slug : rooms[issue.scope.slug] || issue.scope.slug;
    const link = issue.scope.kind === 'layout' ? `#/viewport-layouts/${issue.scope.slug}` : `#/remote-layouts/${issue.scope.slug}`;
    const list = ids.slice(0, 3).map((id) => `${id} (${issue.entities[id]})`).join(', ');
    add('warn', 'entities', `${where}: ${ids.length} entit${ids.length === 1 ? 'y' : 'ies'} Home Assistant couldn’t give`, `${list}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}. Pick them again in the layout.`, link);
  }

  // --- Devices ---
  for (const v of views) {
    const kind = v.type === 'viewport' ? 'Viewport' : 'Remote';
    if (v.expected) {
      add('info', 'expected', `${v.name} hasn’t connected yet`, `Listed with its display’s address (${v.mac}). Power it on and put it on the Wi-Fi${v.status === 'approved' ? ': it’s approved, so it starts at once.' : ', then approve it.'}`, v.link);
      continue;
    }
    if (v.status === 'pending') {
      add('warn', 'pending', `${v.name} is waiting for approval`, `A new device asked to pair ${since(ago(v.lastSeenAt, now))}. Approve it as a remote or a viewport, or revoke it.`, v.link);
      continue;
    }
    if (v.status !== 'approved') continue;
    const life = v.batteryLife;
    const left = life && life.daysLeft != null ? ` About ${daysText(life.daysLeft)} left.` : '';
    if (v.batteryLevel === 'critical') add('critical', 'battery', `${v.name}: battery ${v.battery}%`, `${kind} will stop soon. Charge it.${left}`, v.link);
    else if (v.batteryLevel === 'low') add('warn', 'battery', `${v.name}: battery ${v.battery}%`, `${kind} battery is low.${left}`, v.link);
    // Not low yet, but draining fast enough to run out within DAYS_WARN days.
    else if (life && life.daysLeft != null && life.daysLeft <= DAYS_WARN) {
      add('warn', 'battery', `${v.name}: about ${daysText(life.daysLeft)} of battery left`, `${v.battery}% and falling about ${life.ratePerDay}% a day. Charge it soon.`, v.link);
    }
    if (!v.online) add('warn', 'offline', `${v.name} hasn’t been heard from`, `Last seen ${since(ago(v.lastSeenAt, now))}. Flat battery, out of Wi-Fi range, or can’t reach this server.`, v.link);
    if (v.rssi != null && v.rssi < WEAK_RSSI) add('info', 'wifi', `${v.name}: weak Wi-Fi (${v.rssi} dBm)`, 'Weak signal costs battery on every wake. Move it or the access point closer.', v.link);
    if (!v.assignedTo) {
      add('info', 'unassigned', `${v.name} has no ${v.type === 'viewport' ? 'layout' : 'room'}`, v.type === 'viewport' ? 'It shows “not set up” until you assign a viewport layout.' : 'Pick its room, or pick one on the remote in Settings → Select room.', v.link);
    }
  }
  const firmwares = new Map();
  for (const v of views) if (v.status === 'approved' && v.type === 'remote' && v.firmware) firmwares.set(v.firmware, (firmwares.get(v.firmware) || 0) + 1);
  if (firmwares.size > 1) {
    add('info', 'firmware', `Remotes run ${firmwares.size} firmware versions`, [...firmwares].map(([f, n]) => `${f} (${n})`).join(', '), '#/remotes');
  }
  // Remote updates (lib/firmware.js) that didn't take.
  const failed = updates.filter((u) => u.state === 'failed');
  if (failed.length) {
    add('warn', 'firmware', `${failed.length} remote${failed.length === 1 ? '' : 's'} couldn't update`,
      failed.map((u) => `${u.name}: ${(u.last && u.last.error) || 'failed'}`).join(' · '), '#/settings/updates');
  }
  attention.sort((a, b) => LEVELS[a.level] - LEVELS[b.level]);

  const approved = views.filter((v) => v.status === 'approved');
  const byType = (t) => approved.filter((v) => v.type === t);
  const counts = {
    remotes: byType('remote').length,
    remotesOnline: byType('remote').filter((v) => v.online).length,
    viewports: byType('viewport').length,
    viewportsOnline: byType('viewport').filter((v) => v.online).length,
    pending: views.filter((v) => v.status === 'pending' && !v.expected).length,
    lowBattery: approved.filter((v) => v.batteryLevel && v.batteryLevel !== 'ok').length,
    rooms: Object.keys(rooms).length,
    layouts: Object.keys(layouts).length,
    critical: attention.filter((a) => a.level === 'critical').length,
    warn: attention.filter((a) => a.level === 'warn').length
  };
  return { counts, attention, devices: views, ha: { configured: haConfigured, ...ha }, server, updates: updateSummary };
}

module.exports = { build, deviceView, since, BATTERY_CRITICAL, BATTERY_LOW };
