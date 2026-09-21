# Hive Build 38 Security Audit

## Scope
Static audit of the Build 37 source, installer, Electron renderer boundary, IPC surface, local Spotify bridge, plugin system, filesystem writes, remote execution paths, and secret storage.

## Findings and remediation

- Removed installer `curl | sh` execution for Spicetify.
- Removed automatic SpotX download/patch execution. Existing SpotX installations are left untouched.
- Spotify write permissions now recommend per-user POSIX ACLs instead of world-writable `chmod a+wr`.
- The loopback Spotify bridge now requires a per-user 256-bit bearer token stored with mode 0600.
- The Spicetify extension receives the same token during installer configuration.
- JSON configuration/state files written by Hive are forced to mode 0600 after atomic replacement, protecting scrobbling credentials and session material from other local users.
- Existing Electron protections remain enabled: context isolation, renderer sandbox, Node integration disabled, restrictive CSP, navigation guard, and denied arbitrary window creation.
- Rich navigation labels remain sanitized to an allow-list of tags/classes/style properties; script/event URLs are rejected.

## Intentional privileged surfaces

- GStreamer/ffmpeg/metaflac are required native helpers for playback/tagging and are invoked with fixed executable names and argument arrays.
- The plugin API intentionally executes trusted, user-installed plugin JavaScript inside the local Hive renderer. It is not a sandbox and must continue to be treated as a trusted-local extension mechanism.
- MPRIS and the Spotify loopback bridge are local desktop integration surfaces, not LAN services.

## Residual risks

- Electron 33.2.0 is older than current Electron releases. A runtime upgrade should be planned after the playback architecture is stable. Electron recommends current releases for security fixes.
- A live `npm audit` could not be completed in the isolated build environment because registry DNS/network access was unavailable. No dependency fix was forced.
- Third-party Spicetify/Spotify code remains outside Hive's trust boundary; Hive no longer downloads and executes those installers itself.
