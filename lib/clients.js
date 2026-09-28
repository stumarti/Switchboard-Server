'use strict';

/**
 * Clients: every paired device, of one of two types —
 *
 *   remote    the handheld X4 Pro. Its room provides the entities; its own
 *             layout decides how they're presented: which carousel pages,
 *             in what order, its Quick Access hub, and how often it
 *             refreshes.
 *   viewport  a colour wall-mounted e-ink display (the reTerminal E1002
 *             kitchen panel). Read-only: its layout is a dashboard of four
 *             fixed screens configured in lib/dashboard.js, and its values
 *             come from lib/dashboard-state.js.
 *
 * Layouts live on the device record (lib/store.js's _devices.json). A remote
 * that has never had one saved inherits its room's legacy `screens` + `hub`
 * (layoutFor()), so devices set up before this existed keep behaving the
 * same until someone edits them.
 *
 * composeDeviceConfig() folds a remote's layout back into the room config
 * shape the firmware already reads (`screens.*` flags, `hub`,
 * `standby.refreshIntervalMin`), plus `screens.order` for firmware that
 * supports reordering — so existing firmware needs no change.
 */

const { normalizeHub, str, num, bool, REMOTE_PAGE_IDS: PAGE_IDS } = require('./validate');
const dashboard = require('./dashboard');

const CLIENT_TYPES = ['remote', 'viewport'];

// Every carousel page a remote can show, in the firmware's default order.
// `status` is always present (the firmware's resting page) — it can be moved
// but not removed. `flag` is the room config's legacy screens.* key.
const REMOTE_PAGES = [
  { id: 'status', flag: null },
  { id: 'lighting', flag: 'lighting' },
  { id: 'blinds', flag: 'blinds' },
  { id: 'music', flag: 'music' },
  { id: 'tv', flag: 'tv' },
  { id: 'xbox', flag: 'xbox' },
  { id: 'wifi', flag: 'wifi' },
  { id: 'climate', flag: 'climate' }
];
const REMOTE_PAGE_IDS = REMOTE_PAGES.map((p) => p.id);
if (PAGE_IDS.join() !== REMOTE_PAGE_IDS.join()) throw new Error('validate.js REMOTE_PAGE_IDS out of step with REMOTE_PAGES');

const REFRESH_CHOICES = [5, 10, 15, 30, 60];

function normalizeType(v, fallback = 'remote') {
  return CLIENT_TYPES.includes(v) ? v : fallback;
}

function normalizeRefresh(v, fallback) {
  const n = num(v, fallback);
  return REFRESH_CHOICES.includes(n) ? n : fallback;
}

// The carousel: every known page exactly once, in the given order (unknown
// ids dropped, missing ones appended disabled), status always enabled.
function normalizeCarousel(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const id = item && str(item.page);
    if (!REMOTE_PAGE_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ page: id, enabled: id === 'status' ? true : bool(item.enabled, true) });
  }
  for (const id of REMOTE_PAGE_IDS) {
    if (!seen.has(id)) out.push({ page: id, enabled: id === 'status' });
  }
  return out;
}

function normalizeRemoteLayout(body, existing) {
  const b = body || {};
  const e = existing || {};
  return {
    carousel: normalizeCarousel(b.carousel !== undefined ? b.carousel : e.carousel),
    hub: normalizeHub(b.hub !== undefined ? b.hub : e.hub, e.hub),
    refreshIntervalMin: normalizeRefresh(b.refreshIntervalMin, normalizeRefresh(e.refreshIntervalMin, 30))
  };
}

// A viewport's layout is its dashboard (lib/dashboard.js).
function normalizeViewportLayout(body, existing) {
  return dashboard.normalizeLayout(body, existing);
}

// A remote's layout derived from its room's legacy screens/hub — what it
// shows until a layout of its own is saved.
function remoteLayoutFromRoom(profile) {
  const p = profile || {};
  const screens = p.screens || {};
  return normalizeRemoteLayout({
    // The room's own carousel order (screens.order) first, then any page it
    // leaves out, in the firmware's default order.
    carousel: [...(Array.isArray(screens.order) ? screens.order : []), ...REMOTE_PAGE_IDS]
      .filter((id, i, all) => REMOTE_PAGE_IDS.includes(id) && all.indexOf(id) === i)
      .map((id) => {
        const pg = REMOTE_PAGES.find((x) => x.id === id);
        return { page: id, enabled: pg.flag ? screens[pg.flag] !== false : true };
      }),
    hub: p.hub || {},
    refreshIntervalMin: (p.standby && p.standby.refreshIntervalMin) || 30
  });
}

/**
 * The device's effective layout.
 *   remote     its own, if it has been customised; else its room's (the
 *              room's pages, order, Quick Access hub and refresh interval)
 *   viewport   its assigned dashboard's (`dashboardLayout`, looked up by the
 *              caller); else one it still carries from before dashboards
 *              were separate; else a placeholder saying it isn't set up
 */
function layoutFor(device, profile, dashboardLayout) {
  const d = device || {};
  if (normalizeType(d.type) === 'viewport') {
    if (dashboardLayout) return normalizeViewportLayout(dashboardLayout);
    // (A layout from before viewports were dashboards — a tile list — counts
    // as none.)
    const own = d.layout && !Array.isArray(d.layout.tiles) ? d.layout : null;
    return own ? normalizeViewportLayout(own) : dashboard.unassignedLayout();
  }
  return d.layout ? normalizeRemoteLayout(d.layout) : remoteLayoutFromRoom(profile);
}

// The room config a device receives: for a remote, its layout folded into
// the shape the firmware reads; for a viewport, the room plus `viewport`.
function composeDeviceConfig(profile, device) {
  if (!profile) return profile;
  if (!device) return profile;
  const layout = layoutFor(device, profile);
  if (normalizeType(device.type) === 'viewport') {
    return { ...profile, viewport: layout };
  }
  const screens = {};
  for (const pg of REMOTE_PAGES) {
    if (!pg.flag) continue;
    const entry = layout.carousel.find((c) => c.page === pg.id);
    screens[pg.flag] = Boolean(entry && entry.enabled);
  }
  screens.order = layout.carousel.filter((c) => c.enabled).map((c) => c.page);
  return {
    ...profile,
    screens,
    hub: layout.hub,
    standby: { ...(profile.standby || {}), refreshIntervalMin: layout.refreshIntervalMin }
  };
}

module.exports = {
  CLIENT_TYPES,
  REMOTE_PAGES,
  REFRESH_CHOICES,
  normalizeType,
  normalizeRemoteLayout,
  normalizeViewportLayout,
  layoutFor,
  composeDeviceConfig
};
