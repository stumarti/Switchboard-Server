# Switchboard Server

The home server companion for [Switchboard](https://github.com/stumarti/Switchboard), the X4 Pro smart-home remote. Run one instance for your whole household — it stores each room's setup (lighting, blinds, climate, media, TV) and every remote pulls its config from it, instead of you typing it in by hand on each device.

**[⚡ Flash an X4 Pro remote](https://stumarti.github.io/Switchboard/)**

## What it does

- **Every UI lives here.** Each room's remote layout (which pages, which Home Assistant entities) and each wall display's viewport layout are built in the admin UI. A device is only ever assigned one — dumb hardware, server control.
- **Devices pair once**, and you approve each from the admin UI.
- **It talks to Home Assistant** for the devices, and prepares everything they draw, down to dithered album art.
- **It keeps an eye on them:** battery (with the days left), Wi-Fi signal, firmware, and anything that needs attention, on the Home page.
- **Optional extras:** a theme for the remotes' icons and font, and over-the-air firmware updates.

Get this running and set up at least one room *before* you flash a remote: the device pulls its whole setup from here. The firmware is in [Switchboard](https://github.com/stumarti/Switchboard).

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

## Quick start

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

Then:

1. Open `http://<your-server-ip>:45678` and set an admin password.
2. **Settings → Home Assistant:** enter its address and a long-lived access token, save, then press **Test**.
3. **Settings → Wi-Fi:** the network remotes should join.
4. **Layouts:** create a room and fill in its Home Assistant entities.
5. [Flash a remote](https://stumarti.github.io/Switchboard/) and approve it on the **Remotes** page, choosing its room.

This exact file is `docker-compose.yml` in this repo — grab it directly instead of retyping it.

Every Switchboard remote on your network finds the server automatically via `switchboard.local`. **Host networking is required** for that: mDNS needs multicast, which doesn't cross Docker's default bridge network. On **Unraid**, use this repo's `unraid-template.xml`. See [Configuration](wiki/Configuration.md) for both, and for every environment variable.

> Keep this server on your LAN: it holds your Home Assistant token and Wi-Fi password, and can update every remote's firmware. See [Security](wiki/Security.md).

## Documentation

The in-depth guide lives in the [wiki](wiki/Home.md):

- [The admin UI](wiki/Admin-UI.md) — a tour of every page
- [Viewports](wiki/Viewports.md) — wall displays, section types, meeting rooms
- [Pairing & auth](wiki/Pairing-and-Auth.md), including migrating from an unauthenticated version
- [Theme](wiki/Theme.md) · [Remote updates](wiki/Remote-Updates.md) · [Battery life](wiki/Battery-Life.md)
- [Configuration](wiki/Configuration.md) · [Security](wiki/Security.md)
- [API](wiki/API.md) · [Profile format](wiki/Profile-Format.md) · [Development](wiki/Development.md)
