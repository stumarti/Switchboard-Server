# Switchboard Server

**[⚡ Flash an X4 Pro remote](https://stumarti.github.io/Switchboard/)** — the browser-based flasher for the companion [Switchboard](https://github.com/stumarti/Switchboard) firmware. This repo is the *other* half of that project — the server side — and the running admin UI links back to it too (bottom of the sidebar).

Home server companion for [Switchboard](https://github.com/stumarti/Switchboard), the Xteink X4 Pro smart-home remote firmware (originally scoped as [x4pro-ha-remote-spec.md](../x4pro-ha-remote-spec.md) section 8b, hence some internal names below still saying "homeremote"). One instance runs per household, not per remote: it stores every room's configuration profile centrally and serves a browser-friendly admin UI, so a multi-remote home authors each room's name, description, Home Assistant connection, and Standby screen settings in one place instead of
re-entering it by hand on every physical unit. A separate **Globals**
record (WiFi credentials, a default Home Assistant connection, the NTP
server the on-device clock syncs against, and a household-wide list of
WiFi networks for a shared on-device WiFi screen) is shared by every
room, since a household normally has one WiFi network, one Home
Assistant instance, and one clock source — a room only needs its own
Home Assistant connection if it deliberately switches that on. See
"Globals" below.

It's purely additive: a remote with no home server on its network falls
back to the fully-manual on-device form, unchanged. **This is live and consumed**: every Switchboard firmware build calls `GET /api/devices` (Settings → Select room), `GET /api/devices/<slug>/config`, and `GET /api/globals` — see "What it does" below for the exact API surface.

> **Scope note:** per room, this container deliberately manages only a
> room's name, an optional free-text description, its Home Assistant
> connection (host, port, long-lived access token, or "use the global
> connection"), the Standby screen's own settings (weather entity,
> indoor climate entity, refresh interval), Lighting (a whole-room group
> control plus unbounded lists of individual lights and scene shortcuts),
> and Blinds (a whole-room group control plus an unbounded list of
> individual blinds), Media (an enable flag, a name, and the one
> media_player entity behind the room's on-device Music screen — usually
> Spotify; named `media` rather than `music` since it covers any media
> player), Climate (a main temperature sensor plus an unbounded list of
> additional ones to display), and TV (an Android TV's `media_player` and
> `remote` entities, plus three fixed app-launch shortcuts — YouTube,
> Netflix, TV mate), plus a simple on/off flag per room for which carousel
> screens it has (`screens` — Lighting, Climate, Blinds, Music, TV, Xbox)
> — not media sources beyond that one entity, a thermostat/setpoint
> control for Climate, or device behavior settings. Those still live
> entirely in the on-device form; `screens` only records whether a room
> has each one, not how it's configured (and keeps calling that screen
> "Music", independently of the `media` object's own name — see "Profile
> shape" below). WiFi and a
> default Home Assistant
> connection moved out of the per-room scope entirely and into the
> shared Globals record described below, rather than being repeated per
> room. This is a scope reduction from an earlier version of this
> container (and from the fuller `settings.json` shape in spec section
> 10), made deliberately to keep this admin UI small and focused, with
> Standby, Globals, Lighting, Blinds, `screens`, Media, Climate, TV, and
> Globals' WiFi networks list added back in afterward as their own narrow
> sections. See "Profile shape" and "Globals" below.

## What it does

- Stores one JSON profile per room under `/data/<slug>.json` (flat files —
  no database needed at this scale).
- Serves an admin web UI at `http://<host>:45678/` for creating, editing,
  and deleting room profiles (name, description, Home Assistant
  connection, Standby screen settings, Climate sensors, Lighting, Blinds,
  Media, TV, and which carousel screens are active), plus JSON
  download/upload for backup or cloning. A separate **Globals** page
  (WiFi, a default Home Assistant connection, the clock's NTP server, and
  a household-wide WiFi networks list), reachable from its own button
  above the room list, holds the settings every room shares.
- Advertises itself on the LAN via mDNS — both a plain hostname
  (`switchboard.local`) and a proper DNS-SD service record that carries
  the port, so a client doesn't need to know it in advance. See "mDNS: is
  the port really needed?" below — this is the part that makes automatic
  discovery from a freshly-joined remote actually work.
- Exposes the API surface the on-device firmware's "Load from home
  server" action talks to:

  | Method | Path | Purpose |
  |---|---|---|
  | GET | `/api/devices` | List saved profiles (slug, name, last-updated) |
  | GET | `/api/devices/<slug>/config` | One profile, full shape, unmasked |
  | POST | `/api/devices/<slug>/config` | Create/update a profile |
  | POST | `/api/devices` | `{ "name": "Bedroom" }` → creates a profile with an auto-generated unique slug |
  | DELETE | `/api/devices/<slug>` | Remove a profile |
  | GET | `/api/globals` | The shared Globals record (WiFi + default Home Assistant connection) |
  | POST | `/api/globals` | Create/update the Globals record |
  | GET | `/api/health` | Liveness + the mDNS hostname/port/service in use |

  Everything after the first two rows is a convenience beyond the spec's
  exact three-endpoint list, used by the admin UI itself.
- Uses the MDI ("Material Design Icons", Apache-2.0) `remote` glyph as its
  logo and browser favicon — a plain visual identity for the admin UI and
  container icon, unrelated to the API/data model above.

  **Consumed by real firmware.** The Switchboard firmware's `Settings →
  Select room` fetches `GET /api/devices` for the room list and
  `GET /api/devices/<slug>/config` for that room's settings; every carousel
  page (weather, indoor temp, lighting, blinds, media, climate, TV, which
  screens are even enabled) is driven by what's saved here. `GET
  /api/globals` supplies the shared Home Assistant connection and the
  Wifi carousel page's join-QR list. See `include/device_config_client.h`,
  `globals_client.h`, and `room_list_client.h` in the firmware repo for the
  exact client side of this.

## Why Host networking is required

mDNS relies on multicast, which does not cross Docker's default bridge
network. This container needs `network_mode: host` so `switchboard.local`
actually resolves on your LAN — that's already set in `docker-compose.yml`
and the Unraid template. Without it, the admin UI still works over its
direct IP:port, but on-device discovery won't.

The mDNS responder in this container is self-contained (the
`multicast-dns` npm package) — it does **not** depend on `avahi` or any
system mDNS service being installed on the host, so it behaves the same
on a bare Linux box, a NAS, or Unraid.

## mDNS: is the port really needed?

Short answer: not for a properly DNS-SD-aware client — but a browser URL
still needs it, and that's an inherent limit of typing a hostname into an
address bar, not something this container can paper over. Two different
things happen when this container advertises itself:

- **A plain hostname record** (`switchboard.local` → an IP address). This
  is all a browser understands when you type a hostname into it — mDNS
  hostname resolution has never carried a port, on any platform, for the
  same reason plain DNS doesn't either. So yes, if you open
  `http://switchboard.local/` in a browser without a port, it'll fail (or
  hit whatever else is listening on port 80) unless this container
  happens to be on port 80. That's just how browsers and hostnames work.
- **A DNS-SD service record** (`_switchboard._tcp.local`, with a proper
  PTR → SRV → TXT chain) — this is the actual Bonjour/Zeroconf mechanism
  for advertising "a service lives here, on this port," and it's what
  makes port discovery automatic for anything that speaks it. A single
  query for the service returns the host **and** port together. This is
  already implemented and running in this container (`lib/mdns.js`) —
  you can verify it from another machine on the network with:

  ```sh
  # macOS/Linux with avahi/mDNSResponder tools:
  dns-sd -B _switchboard._tcp        # browse: shows the instance
  dns-sd -L "Switchboard" _switchboard._tcp local   # resolve: shows host:port
  # or, on Linux with avahi-utils:
  avahi-browse -r _switchboard._tcp
  ```

  Crucially, this is also exactly the mechanism the ESP32 firmware side
  is expected to use once the "Load from home server" step is built: the
  Arduino core's `ESPmDNS` library has `MDNS.queryService("switchboard",
  "tcp")`, which returns discovered host **and** port in one call — no
  port hardcoded anywhere on the device. So the "automagic, no port
  needed" experience you want for the remotes is already there on the
  container side; it just isn't consumed by firmware yet (see the note
  above). The port only becomes visible again the moment a *human* types
  a URL into a browser, which is a different, unavoidably port-carrying
  code path.

  If you'd rather not think about any of this and just want
  `http://switchboard.local/` (no port) to work in a browser too, the
  only way to get that is to run the container on port 80 itself (`PORT=80`)
  — but see the port-choice note below on why 45678 is the default instead.

## Releases & the published image

Tagging a version kicks off an automatic build:

```
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions (`.github/workflows/release.yml`) then builds the image and
pushes it to GitHub Container Registry as both `ghcr.io/stumarti/switchboard-server:latest`
and `:<version>`, and cuts a GitHub Release. A separate, lighter workflow
(`.github/workflows/ci.yml`) runs a build-check (JS syntax check + a
no-push `docker build`) on every push/PR, so a broken build gets caught
before it's tagged.

**Public vs. private package.** A GHCR package inherits its repo's
visibility, so on a private repo the image is private by default —
appropriate here, since this container ends up holding every room's Home
Assistant token. To pull a private image from Unraid (or anywhere), log
in first:

```sh
docker login ghcr.io -u stumarti
# password: a GitHub Personal Access Token with the read:packages scope
```

Or, on the package's GitHub page (`https://github.com/stumarti?tab=packages`
→ switchboard-server → Package settings), set visibility to Public if you'd
rather not deal with a login on every box that pulls it — your call, the
image itself doesn't contain any secrets either way (see "Secrets &
.gitignore" below).

## Running it on Unraid

You have two supported paths. Either works; pick whichever fits how you
already manage containers on this box.

### Option A — pull the published image (recommended)

1. **Docker → Add Container → Template →** browse to this repo's
   `unraid-template.xml` (or search Community Applications once it's
   listed there, if you choose to do that later). It's already pointed at
   `ghcr.io/stumarti/switchboard-server:latest`.
2. If the GHCR package is private, log in first (see "Releases & the
   published image" above) or add a registry under Unraid's Docker tab
   with the same credentials.
3. Set the **Data** path (defaults to
   `/mnt/user/appdata/switchboard-server/data`) — if you're migrating from
   an older locally-built `homeremote-server` container, point this at
   that *same* existing data folder instead of a fresh one, so your room
   profiles carry over.
4. Apply. Unraid pulls the image and starts the container — no build step
   on the box at all. Updating later is the normal Unraid "check for
   updates" flow, which just pulls the new tag.

Equivalently, with the Compose Manager plugin: copy `docker-compose.yml`
(already pointed at the same published image) onto the box and **Compose
Up** — no `build:` step runs since the compose file pulls by default.

### Option B — build from source (for local changes / development)

1. Copy this whole `Switchboard-Server/` folder onto the Unraid box, e.g.
   to `/mnt/user/appdata/switchboard-server-src/` (keep it separate from
   the **Data** path above — this is source, not data).
2. Open an Unraid terminal (or SSH in) and build the image:

   ```sh
   cd /mnt/user/appdata/switchboard-server-src
   docker build -t switchboard-server:local .
   ```

3. Run it:

   ```sh
   mkdir -p /mnt/user/appdata/switchboard-server/data
   docker run -d \
     --name switchboard-server \
     --network host \
     --restart unless-stopped \
     -e PORT=45678 \
     -e MDNS_HOSTNAME=switchboard.local \
     -v /mnt/user/appdata/switchboard-server/data:/data \
     switchboard-server:local
   ```

   Or uncomment `build: .` (and comment out `image:`) in
   `docker-compose.yml` and `docker compose up -d --build`.
4. Optional: import `unraid-template.xml` for a normal Docker-tab entry,
   editing its `Repository` field to `switchboard-server:local` first.

Rebuild with the same command any time you change the source. Option A is
simpler for day-to-day use; reach for Option B only when you're actually
changing `server.js`/`lib/`/`public/` yourself.

### Port choice

The container binds directly to port **45678** on the Unraid host itself
(because of host networking, not a mapped port). 45678 was chosen
deliberately in the high, uncommon range rather than a typical "app
default" like 8080/8090/3000 - those collide constantly in a home-lab
with several self-hosted services running, while a five-digit port
outside the well-known ranges is very unlikely to already be claimed by
something else on an Unraid box. It also avoids colliding with Unraid's
own web GUI (80/443). Change the `PORT` environment variable in the
compose file, `docker run` command, or template if 45678 happens to
already be taken on your box, and re-create the container.

If you'd rather have zero port at all in the browser URL
(`http://switchboard.local/` with nothing after it), that needs a
different, bigger change: either move Unraid's own GUI off port 80
(Settings -> Management Access) and set `PORT=80` here, or put a reverse
proxy (Nginx Proxy Manager, SWAG, Traefik) in front of everything on port
80/443, routing by hostname. Neither is done here since it wasn't asked
for, but both are real options if you change your mind later. Either way,
this doesn't affect the remotes themselves at all - they discover host
*and* port automatically via the DNS-SD service record regardless of
which port this runs on (see "mDNS: is the port really needed?" above).

### If `switchboard.local` doesn't resolve

- Confirm the container is actually running with host networking
  (`docker inspect homeremote-server | grep NetworkMode` should say
  `"host"`).
- Check the container logs for the line `[mdns] advertising
  switchboard.local -> <ip>` — if the IP is wrong (a multi-homed Unraid box
  has several NICs/bridges), set `MDNS_IP` or `MDNS_INTERFACE` explicitly
  (both are already stubbed out, commented, in `docker-compose.yml` and
  present in the Unraid template's Advanced view).
- Some client OSes/routers are stricter about multicast than others — as
  a fallback, the admin UI and API are equally reachable at
  `http://<unraid-ip>:45678/` directly.
- The X4 Pro firmware side (spec section 8b) tries `homeremote.local`
  specifically from the device — if your router isolates IoT/guest VLANs
  from mDNS, the remote and this container need to be on the same
  broadcast domain.

> **Naming note:** this container defaults to `switchboard.local`
> (overridable via `MDNS_HOSTNAME`), and the firmware's `config.h` defaults
> `SWITCHBOARD_SERVER_HOST` to `"switchboard"` — the two agree out of the
> box. `x4pro-ha-remote-spec.md` section 8b still describes the original
> `homeremote.local` name from before the "Switchboard" rebrand; it's
> unchanged text, not a live mismatch — if you ever do want the old name,
> set `MDNS_HOSTNAME=homeremote.local` here **and**
> `SWITCHBOARD_SERVER_HOST "homeremote"` in the firmware's `config.h`
> before flashing, so both sides still agree.

## Running it anywhere else (Raspberry Pi, generic Linux box, NAS)

Simplest: pull the published image directly, same as Unraid Option A:

```sh
mkdir -p ~/switchboard-server/data
docker run -d \
  --name switchboard-server \
  --network host \
  --restart unless-stopped \
  -e PORT=45678 \
  -e MDNS_HOSTNAME=switchboard.local \
  -v ~/switchboard-server/data:/data \
  ghcr.io/stumarti/switchboard-server:latest
```

Or `docker compose up -d` against this repo's `docker-compose.yml`. Either
way, `--network host` (or `network_mode: host` in compose) is required for
mDNS, as long as the host supports it — most non-Unraid NAS Docker UIs,
and Compose, support it directly. To build from source instead, the same
Option B steps above apply on any Linux box.

## Configuration reference

Environment variables (all optional except none are strictly required —
sensible defaults are baked in):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `45678` | Port the HTTP server listens on |
| `DATA_DIR` | `/data` | Where profile JSON files are stored |
| `MDNS_HOSTNAME` | `switchboard.local` | Hostname advertised via mDNS (plain A record) |
| `MDNS_SERVICE_TYPE` | `switchboard` (→ `_switchboard._tcp.local`) | DNS-SD service type advertised (PTR/SRV/TXT) — the part that carries the port |
| `MDNS_INSTANCE_NAME` | *(derived from hostname)* | Human-readable service instance name |
| `MDNS_IP` | *(auto-detected)* | Force the advertised IP |
| `MDNS_INTERFACE` | *(auto-detected)* | Prefer this host NIC name when auto-detecting the IP |
| `DISABLE_MDNS` | *(unset)* | Set to `1` to turn off the mDNS responder entirely |
| `APP_VERSION` | `dev` | Baked in at image build time from the git tag (see "Releases & the published image"); surfaced at `GET /api/health` and in the admin UI's sidebar footer. Not meant to be set by hand. |

## Globals

One record, shared by every room, stored separately from room profiles
at `/data/_globals.json` (a leading underscore keeps it out of the way of
room slugs, which are lowercase `a-z0-9-` only, and it's explicitly
excluded from the room list):

```json
{
  "updatedAt": "...",
  "wifi": {
    "ssid": "MyHomeWiFi",
    "password": "..."
  },
  "homeAssistant": {
    "host": "192.168.1.10",
    "port": 8123,
    "token": "..."
  },
  "ntpServer": "pool.ntp.org",
  "wifiNetworks": [
    { "id": "a1c4...", "name": "Main", "password": "..." },
    { "id": "7fe2...", "name": "Guest", "password": "..." }
  ]
}
```

Reachable from its own button above the room list in the admin UI
("Globals — WiFi & Home Assistant"). The WiFi network under `wifi` is the
one every X4 Pro remote should join (this container's own provisioning
network); the Home Assistant connection here is the one every room
profile uses **unless** that room switches its own connection on (see
`homeAssistant.useGlobal` below). There's no delete endpoint for
Globals — it's a single household-wide record, not a list of resources.

`ntpServer` is a plain hostname/IP (default `pool.ntp.org`), **not** a
Home Assistant entity. The live clock in every Active screen's status bar
(spec section 5's persistent chrome — Standby is the one exception, no
clock at all) comes from the device's own onboard clock kept accurate via
NTP over WiFi, not from anything pulled over the Home Assistant
WebSocket, so this belongs alongside WiFi/Home Assistant as one more
household-wide connection setting rather than under any one room.

`wifiNetworks` is a separate, unbounded list of `{name, password}` pairs
for a shared on-device WiFi screen — e.g. showing/sharing a household's
"Main" and "Guest" networks — distinct from the single `wifi` field
above, which is only this container's own network for its
provisioning flow, not something meant to be displayed on a screen.
`name` doubles as the network's actual SSID. Items work exactly like
every other list in this file — a server-generated `id` per item,
preserved across edits, full-list-replace on every save.

**Consumed by firmware**: the Wifi carousel page (`screen_wifi_networks.h`)
renders a join-QR code for each entry here, and the shared
`homeAssistant` connection is what every room falls back to unless it sets
its own (`homeAssistant.useGlobal: false`). The `wifi` field above (this
container's own provisioning network) is a separate concern and isn't
pulled by firmware — a remote joins WiFi itself during on-device
provisioning, before it can reach this server at all.

## Profile shape

Each profile is deliberately small:

```json
{
  "slug": "living-room",
  "name": "Living Room",
  "description": "Upstairs, near the hallway",
  "createdAt": "...",
  "updatedAt": "...",
  "homeAssistant": {
    "useGlobal": true,
    "host": "192.168.1.10",
    "port": 8123,
    "token": "..."
  },
  "standby": {
    "weatherEntity": "weather.home",
    "climateEntity": "climate.living_room",
    "refreshIntervalMin": 30
  },
  "lighting": {
    "group": {
      "enabled": true,
      "name": "All lights",
      "entity": "light.living_room_group",
      "controls": { "brightness": true, "colorTemp": true, "color": false, "effects": false }
    },
    "lights": [
      {
        "id": "3f2d...",
        "name": "Lamp",
        "entity": "light.living_room_lamp",
        "controls": { "brightness": true, "colorTemp": true, "color": true, "effects": true }
      },
      {
        "id": "9a11...",
        "name": "Floor plug",
        "entity": "switch.living_room_floor_lamp",
        "controls": { "brightness": false, "colorTemp": false, "color": false, "effects": false }
      }
    ],
    "scenes": [
      { "id": "c04e...", "name": "Movie Night", "entity": "scene.movie_night" }
    ]
  },
  "blinds": {
    "group": {
      "enabled": true,
      "name": "All blinds",
      "entity": "cover.living_room_group"
    },
    "items": [
      { "id": "7b91...", "name": "Bay Window", "entity": "cover.living_room_bay_window" },
      { "id": "2ad4...", "name": "Patio Door", "entity": "cover.living_room_patio_door" }
    ]
  },
  "screens": {
    "lighting": true,
    "climate": true,
    "blinds": true,
    "music": true,
    "tv": false,
    "xbox": false
  },
  "media": {
    "enabled": true,
    "name": "Living Room Speaker",
    "entity": "media_player.spotify"
  },
  "climate": {
    "entity": "sensor.living_room_temp",
    "additionalSensors": [
      { "id": "e21f...", "name": "Floor", "entity": "sensor.living_room_floor_temp" },
      { "id": "9c3a...", "name": "Near Window", "entity": "sensor.living_room_window_temp" }
    ]
  },
  "tv": {
    "mediaPlayerEntity": "media_player.living_room_tv",
    "remoteEntity": "remote.living_room_tv",
    "apps": {
      "youtube": "com.google.android.youtube.tv",
      "netflix": "com.netflix.ninja",
      "tvMate": "com.example.tvmate"
    }
  }
}
```

Device identity (name/slug/description), the Home Assistant connection,
and the Standby screen's own settings — the deep-sleep dashboard (spec
section 5) needs a weather entity and an indoor climate entity to render,
plus its own refresh interval (`refreshIntervalMin`, one of `15`/`30`/`60`
— an invalid value falls back to the existing/default 30).

`homeAssistant.useGlobal` decides which Home Assistant connection this
room actually uses: `true` (the default for a brand-new room, and what
the admin UI shows as a checked "Use global connection" box) means this
room's own `host`/`port`/`token` fields are ignored in favor of the
Globals record above; `false` means this room uses its own `host`/
`port`/`token` instead, exactly as before Globals existed. A profile
saved before this field existed is treated as `false` (its own connection
kept, not silently switched to an empty global one) the first time it's
re-saved — only freshly-created profiles default to `true`.

**`lighting`** is deliberately more flexible than a fixed set of fields,
since real rooms don't all have the same lights: a single optional
whole-room `group` control, plus two unbounded lists — `lights` and
`scenes` — each editable with "+ Add" / "Remove" in the admin UI, no cap.
Every light and the group always support on/off (not worth a field); the
`controls` object on the group and on each light is only the *extra*
stuff — `brightness`, `colorTemp` (tunable white), `color` (RGB), and
`effects` (a light's built-in presets) — so a plain on/off smart plug and
a full-color bulb can each expose only what they actually support. A
`scene` is just a name plus a Home Assistant scene entity to activate as
a one-tap shortcut — no controls of its own. Every `lights`/`scenes` item
has a server-generated `id` (a UUID), used only to keep an item's
identity stable across edits/re-saves — the admin UI keys each list row
off it, but nothing about ordering or count is enforced; the whole list
is replaced wholesale on every save, so removing an item in the UI is
exactly "leave it out of the saved list."

**`blinds`** follows the same whole-room-group-plus-unbounded-list shape
as `lighting`, but simpler: there's no `controls` object on the group or
on an individual blind, since every blind just gets Open/Close/Stop — no
position or tilt slider. Stop is expected to double as "go to favorite
position" on the underlying cover hardware/Home Assistant once the blind
isn't moving, which is a device-level behavior this container doesn't
need to know about. Items work exactly like `lighting.lights` — a
server-generated `id` per item, preserved across edits, full-list-replace
on every save.

**`screens`** is a flat set of six booleans — `lighting`, `climate`,
`blinds`, `music`, `tv`, `xbox` — one per on-device carousel screen, all
defaulting to `true`. It's deliberately just an on/off flag: unlike
`lighting`/`blinds`, there's no entity or other configuration attached to
`climate`/`music`/`tv`/`xbox` here at all — this container still doesn't
manage those (see the scope note above). Turning one off doesn't hide or
change anything else in this admin UI (the `lighting`/`blinds`/`media`
cards stay exactly as they are regardless) — it's purely a signal for the
device to skip that screen in its carousel for a room that doesn't have
it, e.g. a bedroom with no Xbox. A profile saved before this field
existed defaults every screen to `true` (nothing disappears) the first
time it's re-saved. Note `screens.music` keeps that name — it's the
on-device Music screen's own on/off flag — even though the config object
behind it is `media`, not `music` (see below); the two are independent
and don't have to share a name.

**`media`** is the section behind the room's on-device Music screen:
`enabled`, `name`, and one `entity` — the media_player, almost always a
Spotify Connect player (`media_player.spotify`). Named `media` rather
than `music` since it's meant to cover any media player, not just
Spotify. `enabled`/`name` match the same shape as `lighting.group`/
`blinds.group`; unlike `lighting`, there's no `controls` object here — a
media_player entity's own Home Assistant `supported_features` already
say what it can do (play/pause, next/previous, volume, and so on), so
there's nothing else for this container to record — same reasoning as
`blinds` not needing per-item controls either. If a room's Music screen
needs more than one entity later (e.g. a non-Spotify secondary source),
that's a bigger design question than this pass covers — ask for it
explicitly when it comes up.

**`climate`** has a main `entity` — the room's primary temperature
sensor for the Climate screen — plus an unbounded `additionalSensors`
list for any extra readings shown alongside it (one per floor, one near
a window, and so on). Like `media`, there's no `controls` object: a
sensor entity is read-only display data with nothing to toggle.
`additionalSensors` items work exactly like `lighting.lights`/
`blinds.items` — a server-generated `id` per item, preserved across
edits, full-list-replace on every save. This whole section is distinct
from `standby.climateEntity` above (the single indoor-temperature
reading shown on the deep-sleep Standby screen) and from the
`screens.climate` on/off flag (whether the Climate screen shows at all)
— `climate.entity`/`climate.additionalSensors` are what that screen
actually displays once it's on. A thermostat/setpoint control for
actually changing the temperature isn't part of this container yet.

**`tv`** is this room's Android TV device, split across the two entities
a real Android TV integration usually exposes: `mediaPlayerEntity`
(volume, play/pause, source) and `remoteEntity` (D-pad, Home/Back, and
launching apps by activity/intent). No `controls` object here either —
same reasoning as `blinds`/`media`, since those two entities' own Home
Assistant `supported_features` already describe what they can do. `apps`
is a **fixed** trio — `youtube`, `netflix`, `tvMate` — not an unbounded
list like `lighting.lights`/`lighting.scenes`; each is just a launch
value (an Android package name or intent string) sent through the remote
entity's own launch/activity command, with no name field since the three
app slots are fixed and already labeled.

This is narrower than the on-device `settings.json` schema in spec
section 10, which also covers additional media sources beyond one TV/one
media player, and device behavior — this container doesn't manage those
(see the scope note near the top of this file). See `lib/store.js`'s
`defaultProfile()`/`defaultGlobals()` and `lib/validate.js`'s
`normalizeProfile()`/`normalizeGlobals()` for the exact fields.

## Security note (carried over from the spec, section 8b)

This is plain HTTP, LAN-only, no authentication, by design for this first
pass — the same trust model as the on-device config server. The
difference is blast radius: this container holds *every* room's Home
Assistant long-lived access token in one place, not just one room's —
plus, now, the household WiFi password and a default Home Assistant
token in the shared Globals record. Keep
it on a trusted LAN, don't port-forward it to the internet, and treat an
admin password / PIN gate on this container's own UI as a near-term
follow-up rather than a someday-maybe, per the spec's own note.

## Secrets & .gitignore

**Everything under `data/` is real household data**, not sample content:
every room profile can carry a Home Assistant long-lived access token, and
`data/_globals.json` specifically carries the shared Home Assistant token
*and* your household WiFi password(s) in plain text. `lib/store.js`
defaults `DATA_DIR` to this repo's own `data/` folder whenever the
`DATA_DIR` environment variable isn't set — which is exactly what happens
if you run `npm start` locally without exporting it — so the plainest dev
workflow writes live secrets straight into your working tree unless
something stops them from being committed.

`.gitignore` (added alongside this README) is that something:

```
data/*
!data/.gitkeep
```

`.dockerignore` already excluded `data/*` from the built image for the
same reason — a shipped image should never bake in whatever happened to
be on disk at build time. The two files now agree.

**Before your first commit on this repo**, double-check `git status` shows
nothing under `data/` as untracked-and-about-to-be-added except
`.gitkeep`. As of this pass, `.git` here has no commits yet (freshly
`git init`'d, remote already pointed at GitHub, nothing pushed) — so
there's no history to scrub and no token to rotate. If that's no longer
true by the time you read this (you'd already pushed before now), treat
the Home Assistant token in `data/_globals.json` as compromised and
regenerate it from Home Assistant's own profile page (Settings → your
profile → Security → Long-Lived Access Tokens) regardless of whether the
GitHub repo is private — a private repo is still a repo other tools,
CI runners, or collaborators can read.

No other file in this repo carries a secret — `server.js`, `lib/*.js`,
`public/*`, `docker-compose.yml`, and `unraid-template.xml` were all
checked and every token/password field in them is an empty-string
default, never a real value.

## Development (without Docker)

```sh
npm install
DATA_DIR=/tmp/switchboard-server-dev DISABLE_MDNS=1 npm start   # mDNS needs real multicast, not always available in a dev sandbox
```

Setting `DATA_DIR` explicitly, even to a throwaway `/tmp` path, is worth
the extra keystrokes specifically because of the note above — it keeps
whatever test profiles/tokens you type in during development out of this
folder entirely, rather than relying on `.gitignore` alone. Then open
`http://localhost:45678/`.
