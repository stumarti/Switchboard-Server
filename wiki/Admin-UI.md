# The admin UI

Every UI is defined here, before any device exists: **dumb hardware, server control.** A device is only ever *assigned* one — a remote to a room, a viewport to a layout.

- **Switchboard** (the logo at the top of the menu) — how the whole setup is doing, and what needs attention, worst first, each linking to where it's fixed:
  - remotes and viewports online, devices waiting for approval, low batteries, and Home Assistant's response time;
  - critical and low batteries (10% / 20%), devices not heard from (a remote in a day, a viewport in three refresh intervals), weak Wi-Fi, devices without a room or layout, and remotes on different firmware versions;
  - Home Assistant: not set up, unreachable, or requests failing in the last hour (with the recent errors), and any entity a room or viewport layout names that Home Assistant doesn't have (a typo, or one renamed in HA);
  - every device with its battery, Wi-Fi signal, firmware and when it was last seen.
- **Layouts** — every UI, defined on the server before any hardware exists:
  - **Remote layouts** (top): one per room. Each has the room's Home Assistant entities, one card per function, with entity fields that search Home Assistant as you type. It also sets what the room's remotes show: which carousel pages, in what order, the Quick Access buttons, and the refresh interval (optionally **On the clock**: a 15, 30 or 60 minute refresh lands on the hour and its quarters or halves, with each remote a few seconds after the last). Below the editor, a preview shows the remote's screens as they'd look now.
  - **Viewport layouts** (bottom): whole wall-display UIs, each assignable to any number of displays. Start one from the home panel, a meeting-room sign, or blank.
- **Remotes** — every handheld remote, in a list beside the menu. Pick one to choose its room; optionally customise its pages and Quick Access for just that remote. New devices waiting for approval appear at the top; approve one as a remote (choosing its room) or a viewport (choosing its layout) in one step. The Remotes page also has the **Remote updates** summary (see [Remote updates](Remote-Updates.md)), and each remote shows its battery with the [days it has left](Battery-Life.md). See [Pairing & auth](Pairing-and-Auth.md).
- **Enigma2 receiver** — a room's receiver page works from Home Assistant's Enigma2 integration alone (channel, the programme on now, and the channel's picon if the integration's "Use channel icon" is on). Give the room the box's address (its OpenWebif, e.g. `http://192.168.1.50`, or `http://root:password@vu.local`) and the server also reads the programme on next and each favourite channel's picon from the box; **Check** on the Receiver card shows what the box reports. The address stays on the server — remotes never see it, and picons reach them through `/api/art` as ready-to-draw bitmaps.
- **Viewports** — every wall display. Pick one to choose which viewport layout it shows. The display itself holds no UI: until it has a layout it shows "not set up".
- **Settings** — **Remote updates** (see [Remote updates](Remote-Updates.md)), the server's time beside your browser's on every tab (the Clock tab says if they drift or the time zones differ: remotes set their clock from the server), the shared Home Assistant connection (with a connection test), the Wi-Fi remotes join plus guest networks shown as join-QR codes, the clock's NTP server, changing the admin password (Account; `ADMIN_PASSWORD`, if set, still replaces it on every restart), and the **Theme**: pick a font and re-skin any of the ~107 icons the firmware draws, compiled by this server and downloaded automatically by every paired remote. See [Theme](Theme.md).

## Entity fields

A remote layout covers one room — lighting, blinds, media, climate, TV, Xbox, an Enigma2 receiver: which Home Assistant entities it has, and what its remotes show, one card per function. Entity fields search Home Assistant's own entity list (through the server, which holds the token), show each entity's live state, flag ids HA doesn't know, and fill in names, icons and supported light controls for you. With HA unreachable they fall back to plain text boxes.

## No build step

The admin UI is plain ES modules — Preact + htm served from `node_modules`, Material Design Icons from `@mdi/svg` — so there is no build step.
