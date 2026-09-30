# API

Every Switchboard remote already talks to this: `Settings → Select room` calls `GET /api/devices`, and each data refresh makes two requests — `GET /api/devices/<slug>/bundle` (its room's config, the shared WiFi/HA connection and theme versions; a bodyless `304` when nothing changed) and `GET /api/devices/<slug>/state` (the room's live Home Assistant state, which the server fetches from HA in parallel). Older firmware uses `GET /api/devices/<slug>/config` and `GET /api/globals` and talks to HA directly; those still work. For `/state` the server must be able to reach Home Assistant at the host in Settings → Home Assistant — if it can't, the remote falls back to asking HA itself. Every one of these three now requires the remote to be paired (see [Pairing & auth](Pairing-and-Auth.md)) — the admin UI's own browser session works too, so nothing changes for you in the UI itself.

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
| POST | `/api/devices/<slug>/state/preview` | The state an unsaved room layout would produce — the remote preview under the layout editor | session |
| POST | `/api/feeds/check` | Read an RSS or Atom feed (`{url}`) and show what an Announcements section would | session |
| GET | `/api/firmware/offer` | The update on offer for the calling remote, if any | session or device |
| GET | `/api/firmware/image/<version>` | A build's image, for the remote to install | session or device |
| POST | `/api/firmware/report` | A remote's result for an update attempt | session or device |
| GET | `/api/firmware` | Remote updates: settings, builds and every remote's update state | session |
| PUT | `/api/firmware/settings` | Save the update settings (on/off, release, stage, pilots, schedule, button, minimum battery, repositories) | session |
| POST | `/api/firmware/upload` | Add a build from an uploaded `.bin` | session |
| DELETE | `/api/firmware/builds/<version>` | Remove a build (not the current release) | session |
| GET | `/api/firmware/releases?repo=` | A listed repository's GitHub releases | session |
| POST | `/api/firmware/import` \| `/api/firmware/latest` | Add a release (`{repo, tag}`), or the newest one (`{repo}`), from GitHub | session |

`session` is the admin UI's login cookie; `device` is a paired device's token (see [Pairing & auth](Pairing-and-Auth.md)).

## Health headers

Any paired device — remote or viewport — can send `X-Battery`, `X-Temperature`, `X-RSSI` and `X-Firmware` headers on its requests. The Home page and the device's page show them, warn on a low battery or weak signal, and learn [battery life](Battery-Life.md) from `X-Battery`.
