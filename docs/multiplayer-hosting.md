# Multiplayer transport hosting

The local multiplayer listener uses plaintext WebSocket on loopback by default. Non-loopback binds require a TLS certificate and private key; VoxShop then serves `wss://` and requires an advertised hostname for wildcard binds. The editor's authenticated project API remains loopback-only.

For a self-hosted transport, build the server and configure the listener before starting it:

```powershell
npm run build
$env:VOXSHOP_MULTIPLAYER_HOST = '0.0.0.0'
$env:VOXSHOP_MULTIPLAYER_PUBLIC_HOST = 'games.example.com'
$env:VOXSHOP_MULTIPLAYER_PORT = '4270'
$env:VOXSHOP_MULTIPLAYER_TLS_CERT_FILE = 'C:\certs\fullchain.pem'
$env:VOXSHOP_MULTIPLAYER_TLS_KEY_FILE = 'C:\certs\private-key.pem'
npm run start
```

Use a certificate trusted by the game clients. `PUBLIC_HOST` is a hostname or IP address without a scheme or port; the listener binds to `HOST`, while room responses advertise `PUBLIC_HOST`. Forward only the multiplayer port through the host firewall/router. Keep `access.json` and the editor's local API token private; do not expose the project API to the internet. Room credentials are secrets and should be shared only with invited players.

Standalone exports provide a multiplayer form for the WebSocket endpoint, room ID and room credential, plus Join and Leave controls. The browser client accepts plaintext `ws://` only for loopback and requires `wss://` for remote hosts. A project-bound room runs one authoritative simulation on the host; clients send gameplay intentions and apply ordered game snapshots from that shared simulation. The editor's Multiplayer Rooms dialog can bind a room to the selected project revision and scene, then open it with **Play this room**. MCP room creation accepts the same optional binding. An unbound room remains a transport room and does not produce playable game snapshots.

The broker verifies that a bound project is still at the requested revision, that the entry scene exists, and that the scene has a player component. It saves a private copy of the validated project under app data and starts the room's authoritative simulation from that copy. `projectBinding.sceneId` remains the entry scene; snapshots keep it as `entrySceneId` while `sceneId` reports the current scene. Authored transitions can move every room member through reachable scenes in that same project. Joining clients must have the same project ID and revision, and their first snapshot must match the bound entry scene.

The gateway sends WebSocket heartbeat pings every 15 seconds by default and terminates a socket that has not answered the previous ping. Reconnectable players keep a seat for 60 seconds after an unexpected disconnect. On a host restart, the latest published game snapshot and its project binding are restored, formerly connected players receive a fresh 60-second recovery window, and successful resume keeps each player ID and input sequence while rotating its resume credential. Room data and the latest game snapshot are coalesced to disk for up to 250 ms and flushed on graceful shutdown; live sockets and queued, uncommitted input are not persisted.

Enable **Resume after reload in this tab** when creating or joining a room to retain the rotating resume credential in tab-scoped session storage. The original room secret is not stored. A reload disconnects and resumes the same player within the host's recovery window; **Leave** clears the saved session and ends that membership. The saved session is limited to its project ID and revision, entry scene, endpoint and room. Invalid or expired tokens are cleared. With the option off, credentials stay in memory and a reload ends the session. Closing the tab clears browser session storage; it is not a cross-device sign-in or cloud account.
