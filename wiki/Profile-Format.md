# Profile format

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
- `xbox.listSource` picks whether the device shows its `games` list or the console's own library. For `"browse"`, the server reads the installed games and apps from Home Assistant's `browse_media` (a WebSocket-only call, so the remote can't) and sends them to the remote as `games`: up to 36, cached for 30 minutes, with box art only where its URL fits the remote (127 characters). Either way, the now-playing hero art isn't stored here — the device reads that live from the media player entity's own `entity_picture`/`media_image_url`. A game's `art` field is only for its library row.

The Globals record (`/data/_globals.json`) is the same shape minus the room-specific fields, plus `wifi` (this container's own provisioning network) and `wifiNetworks` (a household list shown as join-QR codes on the remote's WiFi screen).
