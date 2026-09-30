# Switchboard Server

The home server companion for [Switchboard](https://github.com/stumarti/Switchboard), the X4 Pro smart-home remote. Run one instance for your whole household — it stores each room's setup (lighting, blinds, climate, media, TV) and every remote pulls its config from it, instead of you typing it in by hand on each device.

**[⚡ Flash an X4 Pro remote](https://stumarti.github.io/Switchboard/)**

## How this fits together

This is step one. Get this running and set up at least one room *before* you flash a remote — the device pulls its whole setup from here, so there's nothing useful for it to show until a room exists.

1. **Run this** (below) and create a room.
2. **Flash a remote** — see the [Switchboard README](https://github.com/stumarti/Switchboard) for that half.
3. On the remote: join Wi-Fi, then **Settings → Select room** to attach it to the room you just created here.

## Screenshots

<table>
<tr>
  <td><img src="screenshots/room.png" width="360" alt="Editing a room"><br><sub>Layouts — a room's remote layout, entities searched from Home Assistant</sub></td>
  <td><img src="screenshots/remote.png" width="360" alt="A remote's carousel"><br><sub>Remotes — drag-to-order carousel and Quick Access hub</sub></td>
</tr>
<tr>
  <td><img src="screenshots/viewport.png" width="360" alt="A viewport's tiles"><br><sub>Layouts — a viewport layout, with a live preview</sub></td>
  <td><img src="screenshots/settings.png" width="360" alt="Settings"><br><sub>Settings — Home Assistant, Wi-Fi, clock, theme</sub></td>
</tr>
</table>

- **Switchboard** (the logo at the top of the menu) — how the whole setup is doing, and what needs attention, worst first, each linking to where it's fixed:
  - remotes and viewports online, devices waiting for approval, low batteries, and Home Assistant's response time;
  - critical and low batteries (10% / 20%), devices not heard from (a remote in a day, a viewport in three refresh intervals), weak Wi-Fi, devices without a room or layout, and remotes on different firmware versions;
  - Home Assistant: not set up, unreachable, or requests failing in the last hour (with the recent errors), and any entity a room or viewport layout names that Home Assistant doesn't have (a typo, or one renamed in HA);
  - every device with its battery, Wi-Fi signal, firmware and when it was last seen.
- **Layouts** — every UI, defined on the server before any hardware exists:
  - **Remote layouts** (top): one per room. Each has the room's Home Assistant entities, one card per function, with entity fields that search Home Assistant as you type. It also sets what the room's remotes show: which carousel pages, in what order, the Quick Access buttons, and the refresh interval.
  - **Viewport layouts** (bottom): whole wall-display UIs, each assignable to any number of displays. Start one from the home panel, a meeting-room sign, or blank.
- **Remotes** — every handheld remote, in a list beside the menu. Pick one to choose its room; optionally customise its pages and Quick Access for just that remote. New devices waiting for approval appear at the top; approve one as a remote (choosing its room) or a viewport (choosing its layout) in one step. See "Pairing" below.
- **Enigma2 receiver** — a room's receiver page works from Home Assistant's Enigma2 integration alone (channel, the programme on now, and the channel's picon if the integration's "Use channel icon" is on). Give the room the box's address (its OpenWebif, e.g. `http://192.168.1.50`, or `http://root:password@vu.local`) and the server also reads the programme on next and each favourite channel's picon from the box; **Check** on the Receiver card shows what the box reports. The address stays on the server — remotes never see it, and picons reach them through `/api/art` as ready-to-draw bitmaps.
- **Viewports** — every wall display. Pick one to choose which viewport layout it shows. The display itself holds no UI: until it has a layout it shows "not set up".
- **Settings** — the server's time beside your browser's on every tab (the Clock tab says if they drift or the time zones differ: remotes set their clock from the server), the shared Home Assistant connection (with a connection test), the Wi-Fi remotes join plus guest networks shown as join-QR codes, the clock's NTP server, changing the admin password (Account; `ADMIN_PASSWORD`, if set, still replaces it on every restart), and the **Theme**: pick a font and re-skin any of the ~107 icons the firmware draws, compiled by this server and downloaded automatically by every paired remote. See "Theme" below.

> **⚠️ Upgrading from an older version?** This release adds auth: the admin UI now requires a password, and remotes must pair before they can fetch config. See "Auth" and "Pairing" below, and the **Migrating from an unauthenticated version** section — existing already-flashed remotes need reflashing plus a one-time pairing approval.

## Quick start (Docker Compose)

```yaml
services:
  switchboard-server:
    image: ghcr.io/stumarti/switchboard-server:latest
    container_name: switchboard-server
    network_mode: host   # required — mDNS needs it, see below
    environment:
      - PORT=45678
      - MDNS_HOSTNAME=switchboard.local
    volumes:
      - ./data:/data
    restart: unless-stopped
```

```sh
mkdir -p data
docker compose up -d
```

Open `http://<your-server-ip>:45678`, create a room, done. Every Switchboard remote on your network finds it automatically via `switchboard.local`.

This exact file is `docker-compose.yml` in this repo — grab it directly instead of retyping it.

### On Unraid

Add Container → Template → point it at this repo's `unraid-template.xml`. Set the **Data** path to wherever you want profiles saved (defaults to `/mnt/user/appdata/switchboard-server/data`) and apply.

> **Host networking required.** mDNS (how remotes find `switchboard.local` automatically) needs multicast, which doesn't cross Docker's default bridge network. Without `network_mode: host`, the admin UI still works fine at `http://<ip>:45678` — remotes just can't auto-discover it, and you'd need to set the host/port by hand in each remote's firmware config.

### Private image?

If this repo is private, GHCR images are private by default too — `docker login ghcr.io -u stumarti` with a GitHub token (`read:packages` scope) before pulling. Or make the package public from its GitHub page if you'd rather skip that.

## What it does

- **Remote layouts** — one per room (lighting, blinds, media, climate, TV, Xbox, an Enigma2 receiver): which Home Assistant entities it has, and what its remotes show, one card per function. Entity fields search Home Assistant's own entity list (through the server, which holds the token), show each entity's live state, flag ids HA doesn't know, and fill in names, icons and supported light controls for you. With HA unreachable they fall back to plain text boxes.
- **Dumb hardware, server control.** Every UI — a room's remote layout, a wall display's viewport layout — is defined here, on the Layouts page, before any device exists. A device is only ever *assigned* one: a remote to a room, a viewport to a layout.
- **Remotes** and **Viewports** — every paired device, listed beside the menu. A remote shows its room's carousel, Quick Access hub and refresh interval, or its own if customised. A viewport shows its assigned layout. New devices appear under Remotes to approve, as either kind.
- **Settings** for the Home Assistant connection (with a connection test), device and guest Wi-Fi, the clock's NTP server, and the theme (icon and font packs, custom icons).

The admin UI is plain ES modules — Preact + htm served from `node_modules`, Material Design Icons from `@mdi/svg` — so there is no build step.
- Advertises itself on the LAN (`switchboard.local`) so remotes find it with zero configuration.

Every Switchboard remote already talks to this: `Settings → Select room` calls `GET /api/devices`, and each data refresh makes two requests — `GET /api/devices/<slug>/bundle` (its room's config, the shared WiFi/HA connection and theme versions; a bodyless `304` when nothing changed) and `GET /api/devices/<slug>/state` (the room's live Home Assistant state, which the server fetches from HA in parallel). Older firmware uses `GET /api/devices/<slug>/config` and `GET /api/globals` and talks to HA directly; those still work. For `/state` the server must be able to reach Home Assistant at the host in Settings → Home Assistant — if it can't, the remote falls back to asking HA itself. Every one of these three now requires the remote to be paired (see "Pairing" below) — the admin UI's own browser session works too, so nothing changes for you in the UI itself.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/devices` | List rooms | session or device |
| GET | `/api/devices/<slug>/config` | One room's full config | session or device |
| GET | `/api/devices/<slug>/bundle` | Room config + globals + theme versions in one response (`304` when unchanged, via `If-None-Match`) | session or device |
| GET | `/api/devices/<slug>/state` | Live Home Assistant state for every entity the room's pages show, fetched in parallel by the server and trimmed to what the remote reads (`502` if HA is unreachable from the server) | session or device |
| GET | `/api/devices/<slug>/state?page=music&wait=25` | Just one live page's entities, held open (with `If-None-Match`) until they change or `wait` seconds pass (`304`); the response's `live` says which pages are live (playing, moving) or passive | session or device |
| GET | `/api/art?src=<entity_picture or URL>&size=280&fmt=mask1\|spectra\|png` | A picture resized and dithered into exactly what the device draws: `mask1` (the remote's 1-bit icon format), `spectra` (six-colour palette indices, 4 bits a pixel) or `png` (the admin preview); cached, `304` on repeat | session or device |
| POST | `/api/devices/<slug>/config` | Create/update a room | session |
| POST | `/api/devices` | Create a room from just a name | session |
| DELETE | `/api/devices/<slug>` | Remove a room | session |
| GET | `/api/globals` | Shared WiFi + Home Assistant connection | session or device |
| POST | `/api/globals` | Update Globals | session |
| GET | `/api/clients` | Every paired device (remotes and viewports) with its effective layout | session |
| GET | `/api/overview` | The Home page: device counts and health, what needs attention, how requests to Home Assistant are going | session |
| PUT | `/api/clients/<mac>` | Set a device's `name`, `type`, `room` or `layout` (`layout: null` goes back to the defaults) | session |
| GET | `/api/clients/schema` | The pages, tile types, sizes and refresh intervals the layout builders offer | session |
| GET | `/api/ha/status` | Whether the server can reach Home Assistant with the saved connection | session |
| GET | `/api/ha/entities` | Search HA's entities (`domains`, `q`, `deviceClass`, `limit`) for the admin UI's pickers | session |
| POST | `/api/ha/lookup` | Look up specific entity ids (`{ids: [...]}`): each entity, or `null` if HA doesn't have it | session |
| GET | `/api/viewports/<mac>/bundle` | A viewport's layout (carousel + screens) plus every icon it can show, Wi-Fi networks, NTP server and time zone (`me` = the calling device; `304` when unchanged) | session or device |
| GET | `/api/viewports/<mac>/state` | Every screen's finished values, each with its own `etag`, and `refreshInSec`; `?screen=<id>` returns one screen with `ETag` and `X-Refresh-In` headers, and a bodyless `304` when unchanged | session or device |
| POST | `/api/viewports/<mac>/preview` | The state an unsaved layout (`{layout}`) would produce — the admin UI's live preview | session |
| POST | `/api/viewports/import` | A kitchen panel's own `/api/config` JSON (`{config}`) as a layout, to review and save | session |
| GET | `/api/dashboards` | Every viewport layout ("dashboard" in the API), with its screens and the displays using it | session |
| POST | `/api/dashboards` | Create one: `{name, template: kitchen\|meetingRoom\|blank}`, `{name, copyFrom}` or `{name, layout}` | session |
| GET/PUT/DELETE | `/api/dashboards/<slug>` | Read, save (`{name, layout}`) or delete one (its displays go back to "not set up") | session |
| POST | `/api/dashboards/preview` | The state an unsaved layout would produce — the builder's live preview | session |
| GET | `/api/viewports/defaults` | The kitchen panel's default layout, or `?kind=meetingRoom` for a meeting-room sign | session |
| GET | `/api/health` | Liveness, version, mDNS info | none |
| GET | `/api/auth/status` | `{authenticated, setupRequired}` | none |
| POST | `/api/auth/setup` | Set the admin password (first run only) | none |
| POST | `/api/auth/login` / `/api/auth/logout` | Session cookie in/out | none |
| POST | `/api/pairing/register` | A device's first-ever contact | none (device self-registers) |
| GET | `/api/pairing/devices` | List every device that's contacted the server | session |
| POST | `/api/pairing/<mac>/approve` | Approve a pending device, optionally assign its room | session |
| POST | `/api/pairing/<mac>/assign` \| `/rename` \| `/revoke` | Change room / rename / revoke | session |
| DELETE | `/api/pairing/<mac>` | Remove a device record | session |
| GET | `/api/theme` | Current icon/font pack version stamps | session or device |
| GET | `/api/theme/icons.pack` \| `/fonts.pack` | The compiled binary a device downloads | session or device |
| GET | `/api/assets/icon-slots` | The ~107 named icon slots, for Settings → Theme | session |
| GET | `/api/assets/icons/search?q=` | Search MDI icons (with previews) | session |
| POST | `/api/assets/icons/compile` \| `/api/assets/fonts/compile` | Compile + publish a new theme | session |

## Auth

A single shared admin password protects this UI — set it from the one-time setup screen the first time you open the server, or via the `ADMIN_PASSWORD` env var (which seeds/overwrites the stored password on every container start, so you can rotate it through docker-compose the same way every other setting here works). Sessions are a plain cookie, in-memory server-side — restarting the container signs everyone out, which is fine for a household admin tool.

This stays plain HTTP by design (LAN-only, same trust model as everything else here) — don't port-forward it regardless.


## Viewports

A viewport is a colour wall-mounted e-ink display, for example the reTerminal E1002 kitchen panel or a sign beside a meeting room door. It pairs like a remote but registers as `"type": "viewport"`. The device only draws. Its whole UI is a **viewport layout** (a "dashboard" in the API and data folder). It's built on the Layouts page, before or after any display exists, and assigned to one or more displays on their Viewports page. A display without a layout shows "not set up". Viewports saved before layouts were separate move into a layout of their own automatically at startup.

- **Carousel.** The screens the device's left/right buttons step through, in order. Between presses it stays on the current screen and just refreshes it. Optionally, every N minutes (30 by default) it can move to the next screen or go back to the first.
- **Screens** come in two kinds:
  - **Sections.** A layout (sidebar + main, two columns, or a single column) whose columns hold any sections, in any order. The same type can appear any number of times, each with its own settings. The types:

    | Type | What it shows |
    |---|---|
    | Weather | now, "later" and the next days |
    | Energy totals | predicted and generated solar, house use, grid import and export, as tiles or a sidebar list |
    | Energy graph | two panels: actual solar against the prediction; below it, what the house used, stacked by source (solar, battery, grid), with export to the grid below the line |
    | Home battery | charge, status and time to full, with a colour per status |
    | Status icons | up to 12 icons, each following any entity or attribute; rules set the colour, a different icon, or hide it |
    | Alert lines | "Front door, Garage +1 open", or "All clear" |
    | Calendar | upcoming events from any calendars |
    | Heat pump | mode, outside temperature, setpoint, COP |
    | Room climate | each room against its target: red calling for heat, green at target, blue over |
    | Room temperatures | temperature and humidity, grouped by floor |
    | People | who is home, in green |
    | Now playing | what each player is playing |
    | Departures | next departures, red when imminent |
    | Alarm | its state, since when, and optionally when it was last armed, disarmed or triggered |
    | Doors & windows | open (red) or closed |
    | Motion | last motion per sensor, blue when recent |
    | Cameras | last motion per camera |
    | Announcements | the newest items of a company RSS or Atom feed (intranet news, SharePoint, a blog): headline, short summary, when posted. The server reads the feed, at most every 10 minutes, and keeps the last good copy if it's down |

  - **Meeting room.** A whole screen for one room's calendar. The bar shows *Available*, *Starting soon* or *In use* (plus *booked but empty* and *in use but not booked* if you add an occupancy sensor) with a status icon (free and in-use icons are yours to pick), and "Busy until 14:30" or "Free until 16:00". Below it, an optional timeline of the next 1, 2 or 3 hours shows bookings as blocks; it starts at the current quarter hour, so it only changes (and costs a panel refresh) when the quarter turns or a booking changes. Then the current meeting and the rest of today's. Titles can be hidden. The bottom-right corner can show the room's climate: temperature from a thermostat or sensor, humidity, and CO2 (yellow from 1000 ppm, red from 1500).
  - **Room finder.** The other rooms, each by its calendar (and occupancy sensor), free ones first and the longest free at the top, with "Free until 15:00" or "Busy until 14:30". Busy rooms can be listed after the free ones or left out; titles are never shown. **Add the other meeting-room signs** fills it from every other layout's meeting room. The meeting-room sign template has both screens: the display's button toggles to the room finder, and it returns to the room after 5 minutes.

**Conditional sections.** Any section can show only some of the time: *Now playing* only while one of its players is playing, or any section only while an entity matches (e.g. the alarm panel section only while armed). A hidden section is simply left out, so the rest of its column closes up; a calendar in the same column shrinks to fewer lines (*Lines while a conditional section shows*, default 2) to make room while it's there. While a conditional section shows, the display wakes every few minutes (3 by default) to keep it current, and goes back to its normal refresh once it's gone — a viewport is on battery, so a section appears at the next wake after its condition starts, not the instant it does. The server does all of this: the display only draws what it's sent.

The layout builder shows a live 800×480 preview of each screen, in the panel's six colours, from Home Assistant's current state and including unsaved changes. **Start from…** loads the kitchen panel's defaults or a meeting-room sign, or imports an existing panel's own settings.

**The server does all the evaluating.** `GET /api/viewports/me/state` returns every screen's finished values: colour indices (0 white, 1 black, 2 red, 3 yellow, 4 green, 5 blue), which icon to draw, alert sentences, times, countdowns and graph buckets. So the device needs no Home Assistant template sensors and no rules of its own. Per refresh, the server makes one `GET /api/states` for every entity. It adds only what the screens need beyond that — weather forecasts, calendar events, and one history request per energy graph — all in parallel.

**Energy graph data.** A series can be a power sensor (averaged per bar) or an energy meter (differenced per bar). Each bar of use is split by source: grid import first (it's metered), then metered battery discharge, then solar up to what it produced. Anything left is counted as battery, so a house with a battery but no battery sensor still adds up. The forecast is read from an entity attribute holding an hourly or half-hourly list, as Solcast (`detailedForecast`) and Open-Meteo Solar Forecast provide.

**Refreshes.** Each screen carries its own ETag, and `?screen=<id>` answers a bodyless `304` when that screen is unchanged, so the device can skip its 15–20 s panel refresh. `refreshInSec` (and the `X-Refresh-In` header) says when to wake next: the refresh interval, or sooner when a meeting starts or ends. The bundle lists every icon the screens can show, so the device can fetch them once from `/api/icons/mdi/<name>` and cache them.

**Live and passive content.** Most of what a device shows is passive: it only changes when someone presses a button, so it's drawn from cache and fetched on each wake. Some content is live: a player that's playing, blinds that are moving, departures counting down.
- **Remotes:** while a live page is on screen and the Wi-Fi is up, the remote holds one request open (`?page=…&wait=…`) that answers the moment something changes. The Wi-Fi idle timeout still switches the radio off, and changing page or the screen timing out stops it.
- **Viewports:** they run on battery and never stay awake for live content. Live sections update when the display wakes. A display with departures also wakes early, when the next one turns imminent.
- **Album and box art** are prepared here (`/api/art`), so neither kind of device decodes a JPEG.

**Health.** Any paired device — remote or viewport — can send `X-Battery`, `X-Temperature`, `X-RSSI` and `X-Firmware` headers on its requests; the Home page and the device's page show them, and warn on a low battery or weak signal. Remote firmware sends them on every request to the server.

The kitchen panel's firmware doesn't use these endpoints yet. Until it does, it keeps working as before.

## Pairing

A physical remote pairs with this server once: on first boot it registers itself by MAC address and shows up under **Remotes** as waiting for approval. Approve it there (optionally assigning its room in the same step — that's also the MAC → default room mapping) and the server hands it a long-lived token, which it stores and sends on every request from then on. A revoked or deleted device's old token stops working immediately.

If a paired device ever loses its stored token (e.g. a factory reset), it re-registers with the same MAC and gets a fresh token automatically — no need to re-approve it, since the trust decision was already made the first time.

## Theme

The **Theme** page compiles the firmware's on-screen look — one font (upload a TTF/OTF, or name a Google Font) and any of its ~107 named icons (search Material Design Icons and assign a replacement per slot) — into two binary files every paired remote downloads automatically and loads from its SD card at runtime. Publishing recompiles and takes effect on every device's next check-in; nothing needs reflashing. An unmodified icon slot keeps its original look.

## Cutting a release

```sh
git tag v1.0.0
git push origin v1.0.0
```

That's it — `.github/workflows/release.yml` builds the image and pushes `ghcr.io/stumarti/switchboard-server:latest` and `:1.0.0`, and creates a GitHub Release. `.github/workflows/ci.yml` runs a lighter build-check on every push so a broken build never gets that far.

## Config reference

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `45678` | HTTP port |
| `DATA_DIR` | `/data` | Where room profiles are stored |
| `MDNS_HOSTNAME` | `switchboard.local` | Hostname advertised on the LAN |
| `MDNS_SERVICE_TYPE` | `switchboard` | DNS-SD service type — carries the port automatically for anything that queries it properly |
| `MDNS_IP` / `MDNS_INTERFACE` | auto | Force the advertised IP/NIC if auto-detect picks wrong (common on multi-NIC boxes) |
| `DISABLE_MDNS` | off | Set `1` to turn off discovery entirely |
| `ADMIN_PASSWORD` | unset | Seeds/overwrites the admin UI's password on every start. Leave unset to set it once from the UI's own setup screen instead. |

## Security

Plain HTTP, LAN-only by design — same trust model as the on-device config form it replaces, now with a login gate on the admin UI and per-device pairing tokens instead of the previous no-auth-at-all posture (see "Auth" and "Pairing" above). This server still holds *every* room's Home Assistant token plus your WiFi password in one place, so: keep it off the internet, don't port-forward it, and treat it like any other credential store on your network.

## Migrating from an unauthenticated version

`/api/devices`, `/api/devices/<slug>/config`, and `/api/globals` now require either an admin session or a paired device token. If you're updating from a version of this server that predates auth:

1. Update this server first and set an admin password from its one-time setup screen (or `ADMIN_PASSWORD`).
2. Reflash every physical remote with a firmware version that supports pairing (see the [Switchboard README](https://github.com/stumarti/Switchboard)) — an older firmware has no token to send and will get `401`s fetching its config.
3. Each remote shows up under **Remotes** as waiting for approval on its first boot after reflashing; approve it (assigning its room) from there.

Existing room profiles, Globals, and any already-compiled theme carry over unchanged — this only affects how a client authenticates, not what's stored.

## Secrets & your first commit

`data/` holds real credentials once you start using this — Home Assistant tokens, WiFi passwords. `.gitignore` already excludes it (`data/*`, keeping only `.gitkeep`), so it's safe to `git add -A` without checking each time.

One gotcha in local dev: running `npm start` without setting `DATA_DIR` writes straight into this repo's own `data/` folder. Harmless now that it's gitignored, but set `DATA_DIR` to somewhere outside the repo anyway (e.g. `DATA_DIR=/tmp/sb-dev`) so test data doesn't pile up here.

## Local development

```sh
npm install
DATA_DIR=/tmp/sb-dev DISABLE_MDNS=1 npm start
```

Open `http://localhost:45678`.

## Profile shape

Each room profile, in full:

```json
{
  "slug": "living-room",
  "name": "Living Room",
  "description": "",
  "homeAssistant": { "useGlobal": true, "host": "", "port": 8123, "token": "" },
  "standby": { "weatherEntity": "weather.home", "climateEntity": "climate.living_room", "refreshIntervalMin": 30 },
  "lighting": {
    "group": { "enabled": true, "name": "All lights", "entity": "light.living_room_group", "controls": { "brightness": true, "colorTemp": true, "color": false, "effects": false } },
    "lights": [ { "id": "...", "name": "Lamp", "entity": "light.lamp", "controls": { "brightness": true, "colorTemp": true, "color": true, "effects": true } } ],
    "scenes": [ { "id": "...", "name": "Movie Night", "entity": "scene.movie_night" } ]
  },
  "blinds": {
    "group": { "enabled": true, "name": "All blinds", "entity": "cover.living_room_group" },
    "items": [ { "id": "...", "name": "Bay Window", "entity": "cover.bay_window" } ]
  },
  "screens": { "lighting": true, "climate": true, "blinds": true, "music": true, "tv": false, "xbox": false },
  "media": { "enabled": true, "name": "Living Room Speaker", "entity": "media_player.spotify" },
  "climate": { "entity": "sensor.living_room_temp", "additionalSensors": [] },
  "tv": { "mediaPlayerEntity": "media_player.tv", "remoteEntity": "remote.tv", "apps": { "youtube": "...", "netflix": "...", "tvMate": "..." } },
  "xbox": {
    "enabled": true,
    "name": "Xbox",
    "mediaPlayerEntity": "media_player.xbox_series_x",
    "remoteEntity": "remote.xbox_series_x",
    "listSource": "configured",
    "games": [ { "id": "...", "name": "Halo Infinite", "productId": "9PP5TF5D0S0X", "art": "https://.../halo.jpg" } ]
  }
}
```

A few things worth knowing:

- `homeAssistant.useGlobal: true` (the default for a new room) means this room uses the Globals connection instead of its own host/port/token.
- `screens` just turns carousel pages on/off per room — a bedroom with no Xbox unchecks it. The receiver page starts off.
- `lighting.lights`, `lighting.scenes`, `blinds.items`, `climate.additionalSensors`, `xbox.games` are all open-ended lists — add/remove as many as the room needs.
- `tv.apps` is fixed to three slots (YouTube / Netflix / tvMate); `xbox.games` isn't — a console's library keeps growing.
- `xbox.listSource` picks whether the device shows the `games` list below or the console's own library. For `"browse"`, the server reads the installed games and apps from Home Assistant's `browse_media` (a WebSocket-only call, so the remote can't) and sends them to the remote as `games`: up to 36, cached for 30 minutes, with box art only where its URL fits the remote (127 characters). Either way, the now-playing hero art isn't stored here — the device reads that live from the media player entity's own `entity_picture`/`media_image_url`. A game's `art` field is only for its library row.

The Globals record (`/data/_globals.json`) is the same shape minus the room-specific fields, plus `wifi` (this container's own provisioning network) and `wifiNetworks` (a household list shown as join-QR codes on the remote's WiFi screen).
