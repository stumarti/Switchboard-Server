'use strict';

/**
 * Advertises this container on the LAN via mDNS, per spec section 8b:
 * "The container advertises itself via mDNS as homeremote.local on the
 * LAN." (the actual hostname is configurable - see MDNS_HOSTNAME).
 *
 * Two separate things are advertised, on purpose:
 *
 * 1. A plain hostname A record (e.g. `switchboard.local` -> 192.168.1.50).
 *    This is what lets a person type the hostname into a browser. It does
 *    NOT carry a port - mDNS hostname resolution alone never does; a
 *    browser still needs `:45678` typed after it, same as any other
 *    non-80 HTTP server.
 *
 * 2. A proper DNS-SD service record (PTR + SRV + TXT under
 *    `_switchboard._tcp.local` by default). This is the part that makes
 *    the *port* discoverable too, not just the host - any DNS-SD-aware
 *    client (including the ESP32 Arduino core's own `ESPmDNS`
 *    `MDNS.queryService(...)`, which the on-device firmware is expected
 *    to use once it's built) can browse for this service and get back
 *    host *and* port in one query, with nothing hardcoded on the device
 *    side. This is what makes automatic discovery from a freshly
 *    WiFi-joined remote actually work, as opposed to just being able to
 *    resolve a name.
 *
 * Both are implemented directly with the `multicast-dns` package (pure
 * JS, no dependency on avahi/Bonjour being installed on the host), so
 * this behaves the same on a bare Linux box, a NAS, or Unraid.
 *
 * IMPORTANT: this only works when the container runs with
 * `network_mode: host` - multicast does not cross Docker's default
 * bridge network. See README.md / the spec's Docker networking caveat.
 */

const os = require('os');
const mdnsFactory = require('multicast-dns');

function normalizeHostname(name) {
  const trimmed = String(name || 'switchboard').trim().replace(/\.$/, '');
  return trimmed.endsWith('.local') ? trimmed : `${trimmed}.local`;
}

function normalizeServiceType(type) {
  // e.g. "switchboard" -> "_switchboard._tcp.local", or pass a full
  // "_foo._tcp.local"/"_foo._udp.local" straight through.
  let t = String(type || 'switchboard').trim().replace(/\.$/, '');
  if (!t.startsWith('_')) t = `_${t}`;
  if (!/\._(tcp|udp)\.local$/i.test(t)) t = `${t}._tcp.local`;
  return t;
}

function pickLocalIPv4(preferredInterface) {
  const nets = os.networkInterfaces();

  if (preferredInterface && nets[preferredInterface]) {
    const match = nets[preferredInterface].find(
      (n) => n.family === 'IPv4' && !n.internal
    );
    if (match) return match.address;
  }

  // Prefer common "physical LAN" interface name prefixes over things like
  // docker0/veth/br- virtual interfaces, but fall back to the first
  // non-internal IPv4 address found if nothing matches.
  const preferredPrefixes = ['eth', 'en', 'wlan', 'wl', 'br0'];
  const candidates = [];
  for (const [ifName, addrs] of Object.entries(nets)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ ifName, address: addr.address });
      }
    }
  }

  for (const prefix of preferredPrefixes) {
    const hit = candidates.find((c) => c.ifName.startsWith(prefix));
    if (hit) return hit.address;
  }

  return candidates.length ? candidates[0].address : null;
}

/**
 * @param {object} opts
 * @param {string} opts.hostname - e.g. "switchboard.local" (env MDNS_HOSTNAME)
 * @param {number} opts.port - the port the HTTP server actually listens on;
 *   advertised in the DNS-SD SRV record so clients don't need to hardcode it
 * @param {string} [opts.serviceType] - e.g. "switchboard" or
 *   "_switchboard._tcp.local" (env MDNS_SERVICE_TYPE)
 * @param {string} [opts.instanceName] - human-readable service instance
 *   name (env MDNS_INSTANCE_NAME), defaults to the hostname's own label
 * @param {string} [opts.ip] - force the advertised IP (env MDNS_IP), instead
 *   of auto-detecting it from the host's network interfaces
 * @param {string} [opts.iface] - prefer this OS interface name when
 *   auto-detecting (env MDNS_INTERFACE)
 */
function startMdnsResponder(opts = {}) {
  const hostname = normalizeHostname(opts.hostname);
  const port = Number(opts.port) || 45678;
  const serviceType = normalizeServiceType(opts.serviceType);
  const instanceLabel = opts.instanceName || hostname.replace(/\.local$/, '');
  const instanceFqdn = `${instanceLabel}.${serviceType}`;

  let ip = opts.ip || pickLocalIPv4(opts.iface);

  if (!ip) {
    console.warn(
      '[mdns] could not auto-detect a LAN IPv4 address to advertise; ' +
        'set MDNS_IP explicitly. mDNS responder NOT started.'
    );
    return { hostname, ip: null, port, serviceType, stop() {} };
  }

  const mdns = mdnsFactory();

  const aRecord = () => ({
    name: hostname,
    type: 'A',
    ttl: 120,
    data: ip
  });

  const srvRecord = () => ({
    name: instanceFqdn,
    type: 'SRV',
    ttl: 120,
    data: { priority: 0, weight: 0, port, target: hostname }
  });

  const txtRecord = () => ({
    name: instanceFqdn,
    type: 'TXT',
    ttl: 120,
    data: [`path=/api/devices`]
  });

  const ptrRecord = () => ({
    name: serviceType,
    type: 'PTR',
    ttl: 4500,
    data: instanceFqdn
  });

  // Full announcement: PTR (the "what services of this type exist"
  // pointer) as the primary answer, with SRV/TXT/A bundled as additionals
  // so a single query resolves host, port, and metadata in one round trip
  // - this is the standard DNS-SD pattern.
  const fullAnnouncement = () => ({
    answers: [ptrRecord()],
    additionals: [srvRecord(), txtRecord(), aRecord()]
  });

  const hostnameOnlyAnnouncement = () => ({
    answers: [aRecord()]
  });

  mdns.on('query', (query) => {
    const wantsHostname = query.questions.some(
      (q) =>
        q.name.toLowerCase() === hostname.toLowerCase() &&
        (q.type === 'A' || q.type === 'ANY')
    );
    const wantsService = query.questions.some(
      (q) =>
        q.name.toLowerCase() === serviceType.toLowerCase() &&
        (q.type === 'PTR' || q.type === 'ANY')
    );
    const wantsInstance = query.questions.some(
      (q) =>
        q.name.toLowerCase() === instanceFqdn.toLowerCase() &&
        (q.type === 'SRV' || q.type === 'TXT' || q.type === 'ANY')
    );

    if (wantsService || wantsInstance) {
      mdns.respond(fullAnnouncement());
    } else if (wantsHostname) {
      mdns.respond(hostnameOnlyAnnouncement());
    }
  });

  mdns.on('error', (err) => {
    console.error('[mdns] error:', err.message);
  });

  // Unsolicited announcement on startup so clients that already have a
  // (possibly stale) cache entry pick up the new mapping faster.
  mdns.respond(fullAnnouncement());

  console.log(
    `[mdns] advertising ${hostname} -> ${ip} (service ${serviceType} ` +
      `-> ${instanceFqdn} @ port ${port})`
  );

  // Re-detect + re-announce periodically in case the host's IP changes
  // (DHCP renewal) without the container restarting.
  const interval = setInterval(() => {
    const fresh = opts.ip || pickLocalIPv4(opts.iface);
    if (fresh && fresh !== ip) {
      console.log(`[mdns] IP changed ${ip} -> ${fresh}, re-announcing`);
      ip = fresh;
    }
    mdns.respond(fullAnnouncement());
  }, 5 * 60 * 1000);
  interval.unref();

  return {
    hostname,
    port,
    serviceType,
    instanceFqdn,
    get ip() {
      return ip;
    },
    stop() {
      clearInterval(interval);
      mdns.destroy();
    }
  };
}

module.exports = {
  startMdnsResponder,
  pickLocalIPv4,
  normalizeHostname,
  normalizeServiceType
};
