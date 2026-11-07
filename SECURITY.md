# Security policy

## Reporting

Report suspected vulnerabilities privately to the maintainer (a GitHub security advisory on this
repository) rather than in a public issue. Include the Hive or Hive Mobile version, your system,
steps to reproduce, and whether a media file, artwork, a theme or the phone link is involved.

## How Hive is protected

**The desktop app**
- The window runs with context isolation, a sandboxed renderer and a narrow preload API; unexpected
  navigation and new windows are refused, and links open in your browser only if they are http(s).
- Hive reads and writes music files only inside the library folders you chose (`mbfile:` and every
  tag, artwork and Love writer check this). Covers come from Hive's own covers folder.
- Plugins run in sandboxed frames with no network access and no access to Hive's internals beyond
  the plugin API.
- Themes from the theme gallery are colours and sizes only: every value is checked against a short
  list of variables and plain value shapes, so a theme can't load anything or change how Hive works.
  Names shared to the gallery are checked against a basic list of slurs and swear words.
- Crash reports stay on your computer; Hive offers to show one after it closes unexpectedly.
- Updates are checked and installed only when you say so.

**The phone link (Hive Link)**
- A phone pairs with a 6-digit code shown on the computer, or by asking, which the computer
  approves (Refuse is the default; repeated asking is rate-limited). A paired phone can't change or
  delete anything on the computer until you also *trust* it.
- Web pages can't reach Hive Link: requests a browser makes, and requests for public domain names
  (DNS rebinding), are refused.
- Before sending its key, the phone has the computer prove it holds the pairing (an HMAC of a
  random challenge). The computer then proves its own TLS certificate the same way; the phone pins
  that certificate and from then on talks to the computer only over TLS, and never falls back to an
  unencrypted connection with that computer.
- Song streams and covers use a separate read-only key that opens nothing else. Streams and covers
  travel unencrypted, so someone on the same network could see which songs play (and fetch them with
  that key), but never control Hive or change anything.
- The phone never writes outside its music folder, keeps songs deleted by sync for 30 days, and
  never deletes music because the computer couldn't read a folder.
- Phone backups never contain the pairing, passwords or sign-ins (Soulseek, Spotify, Apple Music,
  scrobbling).

Known limits: the very first pairing travels before any certificate is known, so pair on a network
you trust. Away from home, reach your computer through a VPN such as Tailscale rather than opening
Hive Link to the internet.

## Dependencies

`dbus-next` (MPRIS on Linux) has an unresolved advisory chain in legacy transitive packages with no
npm-provided fix. MPRIS is optional and isolated from playback. Electron is kept on a current release
(45.2.3).
