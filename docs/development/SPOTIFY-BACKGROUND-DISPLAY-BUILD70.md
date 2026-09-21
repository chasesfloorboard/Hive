# Spotify Background Display — Build 70

Build 69 exposed a transport-startup race: Hive's loopback HTTP server is always
listening, but `spotifyStatus().connected` only becomes true after the real
Spicetify extension inside Spotify posts state. Build 70 keeps those states
separate and shares one background-start promise across concurrent playback
requests.

The background helper now launches the already-Spicetify-applied Spotify
executable directly under an isolated Xvfb DISPLAY instead of invoking
`spicetify auto` for every playback request. `spicetify auto` is intended to
perform backup/apply/restart and launch Spotify; using that restart path from a
background provider can defeat DISPLAY isolation. The installer remains
responsible for applying the Hive bridge.

`LIBGL_ALWAYS_SOFTWARE=1` is set for the Xvfb client so the isolated display
does not depend on the user's Wayland GPU session.
