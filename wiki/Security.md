# Security

Plain HTTP, LAN-only by design — same trust model as the on-device config form it replaces, now with a login gate on the admin UI and per-device pairing tokens instead of the previous no-auth-at-all posture (see [Pairing & auth](Pairing-and-Auth.md)). This server still holds *every* room's Home Assistant token plus your WiFi password in one place, so: keep it off the internet, don't port-forward it, and treat it like any other credential store on your network.

With **Remote updates** on, this server can also install firmware on every remote. Keep the admin password strong. Treat the server as able to change what every remote runs, and anyone on your LAN as able to see its plain-HTTP traffic. Firmware is checked against a SHA-256 the same server provides, so this guards against corruption, not against a compromised server or network.

## Locking down releases

- Pin the image to a version (`ghcr.io/stumarti/switchboard-server:1.0.0`) instead of `:latest` if you'd rather choose when the server updates.
- Protect `main` (pull requests, passing CI) and restrict who can push `v*` tags, since a tag publishes an image.
- Keep two-factor authentication on the GitHub account.
