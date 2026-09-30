# Configuration

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `45678` | HTTP port |
| `DATA_DIR` | `/data` | Where everything is stored (see below) |
| `MDNS_HOSTNAME` | `switchboard.local` | Hostname advertised on the LAN |
| `MDNS_SERVICE_TYPE` | `switchboard` | DNS-SD service type — carries the port automatically for anything that queries it properly |
| `MDNS_IP` / `MDNS_INTERFACE` | auto | Force the advertised IP/NIC if auto-detect picks wrong (common on multi-NIC boxes) |
| `DISABLE_MDNS` | off | Set `1` to turn off discovery entirely |
| `ADMIN_PASSWORD` | unset | Seeds/overwrites the admin UI's password on every start. Leave unset to set it once from the UI's own setup screen instead. |

## On Unraid

Add Container → Template → point it at this repo's `unraid-template.xml`. Set the **Data** path to wherever you want profiles saved (defaults to `/mnt/user/appdata/switchboard-server/data`) and apply.

> **Host networking required.** mDNS (how remotes find `switchboard.local` automatically) needs multicast, which doesn't cross Docker's default bridge network. Without `network_mode: host`, the admin UI still works fine at `http://<ip>:45678` — remotes just can't auto-discover it, and you'd need to set the host/port by hand in each remote's firmware config.

## Private image?

If this repo is private, GHCR images are private by default too — `docker login ghcr.io -u stumarti` with a GitHub token (`read:packages` scope) before pulling. Or make the package public from its GitHub page if you'd rather skip that.

## Where data lives

Everything is stored under `DATA_DIR` (`/data` in the container): room profiles, `_globals.json`, viewport layouts, paired devices, the compiled theme, firmware builds (`firmware/`) and battery history (`battery-history.json`). Back up that one folder.
