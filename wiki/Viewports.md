# Viewports

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

**Health.** Any paired device — remote or viewport — can send `X-Battery`, `X-Temperature`, `X-RSSI` and `X-Firmware` headers on its requests; the Home page and the device's page show them, warn on a low battery or weak signal, and learn how many days the battery has left ([Battery life](Battery-Life.md)). Remote firmware sends them on every request to the server.

The kitchen panel's firmware doesn't use these endpoints yet. Until it does, it keeps working as before.
