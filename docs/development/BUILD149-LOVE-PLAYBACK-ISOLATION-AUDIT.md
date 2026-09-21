# Build 149 — Love / Playback Isolation Audit

## Trigger

The reported failure sequence was: a local song played normally, clicking Love appeared to coincide with playback breaking, and subsequent Play/Next attempts did not restore audio. The preceding Build 148 transport fix did not eliminate the report.

## Root-cause finding

The Star Favorites collection is a real Smart/Auto Playlist and its Love rule is evaluated separately from the active `currentQueue`. Adding a track to that collection does not itself send GStreamer transport commands or rebuild the native pipeline. The higher-risk boundary is the Love metadata writer: Love writes replace the complete media file, so they must never race the inode currently owned by GStreamer.

Build 148 had a playback-protection wait, but it was bounded at 30 seconds. If playback ownership remained on a path for that entire period, the metadata request could fail rather than remain safely deferred. More importantly, the protection boundary was implemented as polling state rather than an explicit handoff signal, which made the safety contract weaker than necessary.

## Build 149 changes

- Added `app/main/playback-protection.js` as the small, testable ownership gate for active media paths.
- Replaced the 30-second polling timeout with an explicit release promise. A protected track is never made writable merely because a timer expired.
- Changing the protected path releases all waiters for the previous path before protecting the new path.
- Multiple metadata requests waiting on one path are all released together.
- Clearing playback protection explicitly releases pending metadata work after the transport has already been muted/stopped or moved away.
- Kept the Star Favorites Smart/Auto Playlist definition unchanged; the Love operation still updates its in-memory membership immediately and persists the embedded tag asynchronously.
- Added regression tests proving Love UI code contains no GStreamer STOP/LOAD transport command and that protected metadata waiters cannot be released by an unrelated path.

## Safety invariant

**Never replace a file while GStreamer owns that file for playback.** If the current track remains active, the Love write stays deferred. Once the transport explicitly releases the path, the queued metadata operation may proceed. There is no wall-clock bypass.

## Validation

- Playback-protection unit/regression tests: passed.
- Build 147 GStreamer safety regression suite: passed.
- Full JavaScript suite: 238/240 passed. Two pre-existing archive/fixture failures remain: the supplied archive lacks `node_modules/music-metadata/lib/index.js` for `artwork-payload.test.js`, and the MusicBee Wrapped archive fixture is absent.
- Native GStreamer runtime compilation was not available in this container because the GStreamer development headers/pkg-config data are not installed.
