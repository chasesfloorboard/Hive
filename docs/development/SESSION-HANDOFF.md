# Session handoff

This file is a scratch handoff note between AI sessions/tools working on
Hive (this one and others, e.g. ChatGPT sessions the user runs in parallel).
Whoever is working on the project should read this file first, and update
it before finishing a session so the next session (Claude or otherwise)
can resume without re-deriving context. Keep entries dated and terse;
prune resolved/stale entries rather than letting this grow forever.

Also read CLAUDE.md at the repo root first — it has hard project rules
(don't create new buildNNN-*.test.js files; check CHANGELOG.md/docs/ai
before assuming code is broken; edit stable test files in place) and
current priorities.

## Active: volume slider audible "pop" (2026-09-18)

Still unconfirmed since Build 263. Not touched this session — see Build 275/274 below for what was verified instead.

## Build 275 — Android device sync: duplicate phone, SD card write failures, main-process freeze hazard (2026-09-18)

- User asked why Hive showed their one Samsung phone as two separate Android devices (one offering only "mtp", the other offering a "Music folder" and a "Samsung Android" option). Root-caused via the user's actual live `gio mount -li` output: `parseGioVolumes()` in `app/main/device-manager.js` never reset its `volume` variable on leaving a `Volume()` block, so unrelated top-level `Mount(N)` entries that follow (GVfs's own internal duplicate/shadow mount of the same phone, and — critically — a completely unrelated local mount for a folder literally named "Music") inherited the phone's stale MTP identity. Fixed by only attributing indented `Mount(N)` lines to their owning `Volume()`. Verified: reproduced the exact two-device split against the pre-fix logic using the real captured output, confirmed one clean device post-fix.
- After that fix, the user tried sending music to the SD card and got "0 tracks copied ... permission denied mkdir". Root cause: `inspectStorageRoots()` correctly discovers a phone's real storage folders (here "Internal storage" and "SD_Card") but kept an earlier placeholder storage (empty path = "write at the device's bare MTP root") alongside them, and that placeholder was the default-selected one. Android's MTP responder rejects `mkdir` at the device root — confirmed directly (`mkdir` at the phone's MTP root: `Permission denied`; the same one level down inside `SD_Card`: succeeds). Fixed by dropping the placeholder once real folders are found.
- Also found and fixed: the "default to the SD card" logic in `devices:list` (`app/main/main.js`) required whitespace between "sd" and "card", so this user's phone's real folder name `SD_Card` (underscore) never matched and the destination silently defaulted to internal storage instead. Fixed to accept any/no separator (`SD card`, `SD_Card`, `SD-Card`, `sdcard`).
- While testing, found a fourth, more serious latent bug in the same function: `parseGioVolumes()` used `fs.readdirSync()` on the live `/run/user/<uid>/gvfs` mount to recover a missing mount path — synchronous I/O against a real MTP/FUSE session, on Electron's single main process. Reproduced directly this session: after heavy MTP activity that call took ~19 seconds, which would freeze the *entire app* (not just the device list) for that long. Fixed by moving that lookup into an async `attachGvfsMountPaths()` (fs.promises), called from the already-async `refreshDevices()`. `parseGioVolumes()` is now a pure, fast, synchronous string parser with no filesystem access, which is how every existing test already used it.
- All four fixes verified together live against the user's actual connected Samsung phone: Settings → Devices now shows one device, "2 storages", defaults to `SD_Card` / `SD_Card/Music`; sent a real track via right-click → Send to, and confirmed it landed at `SD_Card/Music/Meat Puppets/Meat Puppets II/We're Here.mp3` on the phone.
- Added stable regression coverage in `test/device-sync.test.js` (device de-duplication against real captured `gio` output, placeholder-storage dropping, the SD-card regex, and a source-shape assertion that `parseGioVolumes` never touches the filesystem synchronously). No new `buildNNN-*.test.js` file created. Full `npm test`: **564/564 passing**.

**Nothing left open from this build** — all four issues were reproduced, fixed, and confirmed against the real device, not just source review.

## Build 274 — rating display + context-menu responsiveness (2026-09-18)

- First session to actually compile the native GStreamer helper and launch real Electron on the target GNOME/XWayland desktop (prior sessions were sandboxed and worked from static source analysis only, per their own repeated caveats). Confirmed real audio playback works.
- User asked for an audit of tagging/rating and for the album/track right-click menu to be fast. Found and fixed two real, reproducible bugs:
  1. **Ratings written to M4A (and any non-MP3/WAV/FLAC) files never displayed.** `write_rating()` in `resources/python/tag_helper.py` was correct; `readNativeEmbeddedRating()` in `app/main/main.js` compared the tag id against the bare string `FMPS_RATING`, but `music-metadata` returns MP4 freeform atoms namespaced as `----:com.apple.iTunes:FMPS_Rating`, so the comparison never matched and the UI always showed 0 stars. Fixed by matching on the segment after the last `:`. Verified with a real write→read round trip against a copy of the user's own `Brain Stew.m4a` and against a synthesized fixture. FLAC (bare Vorbis key) and MP3 (POPM) were already correct.
  2. **Right-click on an album or track felt slow.** `showAlbumContextMenu()`/`showTrackContextMenu()` in `app/renderer/renderer.js` `await`ed `refreshAndroidDevices()` before showing the menu whenever no Android device was already known (the common case with no phone connected) — that IPC round-trip shells out to `gio mount -li` with up to a 5s timeout in `app/main/device-manager.js`. Changed to fire-and-forget, matching the pattern already used elsewhere (Settings > Devices tab). Verified visually: screenshot captured with no artificial delay after the right-click shows the menu fully painted.
- Audited the rest of the write/edit pipeline (Love, the tag-editor save diffing, the bundled Mutagen writers) and found it structurally sound against the metadata canon — no other bugs found in this pass. Did not do a live in-app edit-and-verify of the tag editor UI itself (time-boxed); recommend that as a follow-up if issues are still reported there.
- Side note for the user, not a Hive bug: `/home/user/Music/Brain Stew.m4a`'s embedded title (`©nam`/`TSOT`) is actually **"Armatage Shanks"**, not "Brain Stew" — the file is mistagged/mislabeled at the source. Build 273's handoff notes described a "Brain Stew" track-ordering/scope bug; the underlying album-scope and track-ordering code fixes in Build 273 are real and still valid, but if you were expecting to see "Brain Stew" as a track name in the Insomniac album, you'll see "Armatage Shanks" instead until that file's tags are corrected (e.g. via Auto-tag album).
- Added stable regression coverage in place (no new `buildNNN-*.test.js`): `test/build258-metadata-backend-canon.test.js` and `test/build240-context-menu-cohesion.test.js`.
- Full `npm test`: **557/557 passing**.

**Still open / required user test:** launch Build 274 normally, right-click a few albums/tracks and confirm the menu now appears instantly; open the tag editor on an M4A file, set a star rating, save, and confirm the stars now persist and display after reopening Hive.

## Build 273 — album metadata/artwork/auto-tag repair (2026-09-18)

- User tested the M4A metadata path far enough to reach the Albums viewer and reported three related UI/data bugs: renaming a track to “Brain Stew” left it at the top of the album instead of track 10; album-cover editing from the album surface changed only Brain Stew; and album Auto-tag did not operate as a real whole-album identification/artwork workflow.
- Root cause of the album artwork/tag scope bug: renderer album models have a `key` property, but individual track models do not expose `track.albumKey`. `openTagEditor()`, the cover picker, and artwork removal were testing the nonexistent property, so album mode was false and only the first track was edited. Fixed all three scope checks to use the canonical `albumKey(track)` helper.
- Root cause of the track-order symptom was made robust at the renderer boundary: album ordering now parses numeric positions from numbers, strings such as `10/14`, and small reader objects before using title/path tie-breakers. This prevents a renamed track from alphabetically jumping ahead of tracks 1–9.
- Expanded album cover context menus now explicitly open the multi-track tag editor for Change album cover / Search Internet for album cover. The same editor path is used, preserving the canonical staged/verified metadata writer.
- Auto-tag now searches immediately when an album is right-clicked, auto-selects a high-confidence exact release while retaining manual review for ambiguous results, maps individual tracks using title/filename/track number/disc/artist/duration evidence, refuses partial albums, writes only differing metadata fields, and applies one MusicBrainz front cover to every mapped track through `queueMetadataSave`. Existing Love/rating/lyrics/other untouched metadata remains protected by the canonical metadata batch writer.
- Added `artworkUrl` to MusicBrainz release details for the existing approved cover downloader. Added stable regression coverage by editing `artwork-editor-regression.test.js`, `metadata-batch-coalescing.test.js`, and the existing `build256-metadata-safety.test.js` in place; no new build-specific test file was created.
- Targeted album/artwork/metadata tests: **23/23 passing**. Full `npm test`: **553/554**; remaining failures are the known `artwork-payload.test.js` source-archive failure because `node_modules/music-metadata/lib/index.js` is absent, plus the same source-archive dependency/environment limitation.

**Still open / required user test:** launch Build 273, open Insomniac, confirm Brain Stew is in track-10 order, right-click the expanded album cover and use Change album cover to verify all album tracks are targeted, then right-click the album -> Auto-tag album and verify the preview maps all 14 tracks and shows one shared cover before applying. Confirm the resulting tags/covers persist after restarting Hive. Do not call the album artwork or auto-tag runtime behavior confirmed from source tests alone.


## Build 272 — M4A Unicode metadata-key repair (2026-09-18)

- User tested Build 271 and supplied the concrete failed-file error for `Brain Stew.m4a`: `Could not write metadata: 'latin-1' codec can't encode characters in position 22-24: ordinal not in range(256)`.
- Root cause is now isolated: bundled Mutagen's MP4 freeform renderer encoded the entire `----:com.apple.iTunes:<name>` key with latin-1. Position 22 is the first character of the freeform name after that fixed prefix. A Unicode custom/freeform field name therefore aborts the whole M4A save even when the user only edits an ordinary field.
- Fixed `resources/mutagen/mp4/__init__.py`: MP4 freeform `mean`/`name` components are now UTF-8 encoded; parser decodes them as UTF-8 with latin-1 fallback for malformed/legacy bytes. Four-byte MP4 atom identifiers retain latin-1 handling.
- Added stable regression coverage in `test/build258-metadata-backend-canon.test.js` for emoji, accented, and CJK freeform field names. Updated metadata canon section 8 to document the rule.
- Targeted metadata tests: 7/7 passing. Real temporary AAC/M4A fixture test also passed: an existing Unicode freeform field named `🔊` survived a title edit through the bundled helper, and the edited title read back correctly. Full `npm test`: 548/549; the sole failure is the known source-archive `artwork-payload.test.js` environment failure because `node_modules/music-metadata/lib/index.js` is absent.

**Still open / required user test:** Build 272 must be tested against the actual `/home/user/Music/Brain Stew.m4a`, changing a normal metadata field and saving. Confirm the startup recovery warning is gone and the edit persists after reopening Hive.


## Build 271 — metadata recovery retry repair (2026-09-18)

- User tested Build 270 and still saw the startup recovery warning: “Beehive resumed 1 interrupted metadata operation, but 1 file failed after 3 attempts.” Their next UI report reduced the failure detail to the same generic message.
- Root cause found in the recovery state machine: startup recovered `queued`/`running`/`retry` jobs with their persisted `attempts` count. If a crash left a `retry` job at attempts=3, `runMetadataBatch()` entered with `attempts < 3` false, performed zero writes, and emitted the fallback `Metadata operation failed after 3 attempts.` because `lastError` was empty. This made an interrupted/stale job look like a fresh metadata failure.
- Fixed startup recovery to begin each recovered job at attempts=0 with a cleared transient error. Added a combined `kind:'metadata'` satisfaction check that reads requested tags through bundled Mutagen and checks compilation/artwork too, so a write that completed before a crash is recognized and its journal row is removed without another physical rewrite.
- Failed reporting now falls back to the durable `job.lastError` if the in-memory loop has no new error.
- Stable metadata canon test updated in place; no new build-specific test file created.
- This build still needs real Electron/runtime testing by the user, especially the previously failing `Brain Stew.m4a`. The startup warning in Build 270 is now understood as a recovery-state bug, but the underlying original metadata write must still be verified in the UI.


## Build 270 — metadata editor verification repair (2026-09-18)

- User tested Build 269 against `Brain Stew.m4a` and still received the generic metadata failure. Their runtime log shows one long-lived `tag_helper.py` process followed by three separate staged `cp` operations at ~56.6s, ~57.1s, and ~58.1s, proving the job entered the write/retry loop three times after playback protection released.
- Root cause of the remaining Build 269 failure: `performWriteMetadata()` successfully invoked the bundled Mutagen writer, then attempted `await ensureMM()` / `music-metadata.parseFile(...)` for read-back verification. A portable/source runtime can lack that Node package, so verification threw after the native write and caused the same three retries. This is exactly the failure shape in the user's log.
- Fixed by adding canonical `read_metadata_fields` to `resources/python/tag_helper.py` and changing ordinary tag verification in `performWriteMetadata()` to read the requested fields back through the same bundled Mutagen backend. This removes the post-write dependency on Node `music-metadata` while retaining explicit read-back verification. Compilation verification still uses the existing native helper operation.
- Added stable coverage in `test/build258-metadata-backend-canon.test.js` and updated `test/metadata-batch-efficiency.test.js` in place. Targeted metadata tests pass; a synthetic M4A write/read-back through the helper also passed.
- Full `npm test`: **545/547**; the only remaining failures are the existing `artwork-payload.test.js` environment failure because `node_modules/music-metadata/lib/index.js` is absent in this source archive, plus no new metadata failure.
- The user's log also contains a separate renderer performance anomaly: `RENDERER SCROLL PERF SAMPLE` reports a 15,317.8 ms frame and a 336 ms long task while browsing Albums. This is not yet causally tied to the metadata failure and remains open for runtime investigation.

**Still open / required user test:** install/run Build 270 and edit the same `Brain Stew.m4a`. Change one ordinary field (for example Title), save, then close/reopen the editor and verify the changed tag persisted and the file still plays. Also note whether the large renderer scroll stall recurs.

## Build 269 — metadata editor repair (2026-09-18)

- User reported the tag editor failing with `Metadata operation failed after 3 attempts` on a file they called “brain stew”.
- Root cause found in the Build 268 source archive: `resources/python/tag_helper.py` correctly inserts `HERE.parent` to load the canonical bundled Mutagen backend, but `resources/mutagen/` was completely absent from the archive. On a machine without system Mutagen, the helper dies during import before the JSON-lines loop starts; Electron therefore retries three times and exposes only the generic failure.
- Vendored Mutagen 1.47.0 into `resources/mutagen/` and added stable regression coverage in `test/build258-metadata-backend-canon.test.js` using Python `-S` so the test cannot accidentally pass via a system Mutagen install.
- Direct isolated metadata write test using the bundled backend passed on a temporary MP3. Targeted metadata canon suite: 4/4 passing.
- Restored executable permissions on release shell entrypoints and advanced `BUILD` to 269. Full `npm test`: 544/546; remaining failures are the known source-package environment issues (`music-metadata` missing from `node_modules`, plus source extraction permission loss before restoration).

**Still open / required user test:** install/run Build 269 and edit the previously failing “brain stew” file. Confirm the tag editor now saves the requested metadata and that the file still plays normally. This is not considered runtime-confirmed from source tests alone.

## Canonical Hive logo refresh (2026-09-18)

- Replaced `resources/hive-logo-glass.png` with the refreshed high-resolution Hive mark requested by the user.
- Converted the supplied/generated artwork to true grayscale while preserving its transparent RGBA background; the canonical asset is now 1254×1254.
- Existing renderer/About/Yearly Wrap/tray references already point to this shared filename, so no second logo-loading path was introduced.
- Added `docs/ai/HIVE-BRANDING-CANON.md` to explicitly define the shared resource as the canonical Hive logo.
- Updated stable `test/hive-logo-brand.test.js` in place for the new asset dimensions.
- This archive has no `.git` metadata, so the change can be delivered as the modified source archive rather than a repository commit.


## Build 268 — Android device destinations + album Send to menu (2026-09-18)

- Implemented the requested album workflow: right-click an album -> **Send to** -> discovered Android phone. The album's local tracks are transferred together. Track context menus now use the same shorter **Send to** label.
- Reworked `app/main/device-manager.js` so GIO MTP mounts are grouped by phone/URI host. Multiple storage mounts from one phone are represented as one device with `storages[]`; this avoids showing Internal storage + SD card as separate phones. The parser also discovers storage directories when GIO does not expose them directly.
- Added per-device destination persistence in config via `devices:setDestination`. The Devices settings card has a storage selector, editable destination path, and Save destination button. If an SD card is present, the effective default is `<SD card>/Music`; otherwise `Music`. Transfer destination is now the configured relative path plus `Artist/Album/Track`. Relative path traversal is rejected.
- Updated stable `test/device-sync.test.js` in place. Targeted device-sync suite: **7/7 passing**. Full `npm test`: **544/545**; the sole failure is the pre-existing source-package environment issue in `artwork-payload.test.js` because `node_modules/music-metadata/lib/index.js` is absent.
- Native GStreamer compilation/real Electron runtime remains unavailable in this sandbox; this Android change still requires physical phone testing.

**Next required user test:** connect the phone normally through GNOME/GVfs, open Hive Settings -> Devices and confirm the phone appears once (not once per storage), confirm both Internal storage and SD card are listed if the phone exposes both, select the SD card and save `SD card/Music`, then right-click an album -> Send to -> phone and confirm the files arrive on the phone's SD card under `Music/Artist/Album/`. If the phone does not expose an SD card through GVfs, report exactly what storages Hive lists.


## Build 267 — playback baseline + selectable audio output + navigation overhaul (2026-09-18)

- User tested Build 266 and reported **no audio played at all**. Build 267 therefore does not carry forward Build 265's sink-owned `GstStreamVolume` initialization experiment; native `gstreamer-player.c` is restored to the Build 263 ordinary-volume path (dedicated post-queue `hive-user-volume`, event-driven command dispatch, latest-value coalescing).
- Added `app/main/audio-output-manager.js` using `pactl -f json list sinks` with `pactl list short sinks` fallback. Playback Settings now exposes an Output device dropdown, refresh, and Apply. Selected sink ID is persisted as `audioOutputDevice`; the GStreamer bridge passes it as `HIVE_AUDIO_OUTPUT_DEVICE`, and the native helper creates `pulsesink` with that device. No selection uses `autoaudiosink`/system default. Applying requires a Hive restart so the helper can construct the sink before playback; no live pipeline replacement was attempted.
- Reworked Settings → Navigation into distinct Sidebar and Top bar editors with reset, clearer grouping, and plain-text labels so stored presentation HTML such as `<span class="hive-rainbow">Music</span>` no longer appears literally in the editor.
- Kept Build 266 Android/MTP device sync and transfer UI.
- Stable tests: audio-output + device-sync + volume/navigation targeted tests are all passing. Full `npm test`: **542/543**; the only failure remains the known source-package environment issue: missing `node_modules/music-metadata/lib/index.js` in `artwork-payload.test.js`. `npm run check` is unavailable because this source ZIP has no `package-lock.json`. Native GStreamer compilation remains unavailable because GStreamer development headers/pkg-config packages are absent in the sandbox.
- **Next required user test:** launch Build 267, confirm audio actually plays first, then open Settings → Playback → Output device, choose monitor/headphones, Apply, restart Hive, and confirm playback routes to the selected device. Also test Navigation and Android sync. The volume pop remains unresolved; do not call it fixed without audible user confirmation.


### Build 263 — native latest-value volume coalescing (2026-09-18)

- User tested Build 262 and reported the audible problem is **multiple pops during one top-to-bottom slider drag**, not merely one subtle pop at the end.
- This points directly at repeated `volume` property writes as a useful diagnostic target: the renderer emits many slider `input` events, and the native helper previously applied every queued `VOLUME` command.
- Changed `command_tick()` so `VOLUME` is latest-value state within one main-context wake: it records the newest requested target while draining the queue, then calls `set_user_volume()` once after the queue is drained. Transport commands remain ordered and are not coalesced.
- Removed the redundant renderer `pointerup` call that sent the final volume a second time; pointer release now only persists playback state.
- No ramp/controller/timer/sink-walking change was introduced. The dedicated `hive-user-volume` element remains immediately before `autoaudiosink`, after playbin's internal queue.
- Stable `test/volume.test.js` updated in place; targeted volume suite is **14/14 passing**.
- Full-suite/static validation and packaging still need to be run before handing this build to the user. Native GStreamer compilation remains unavailable in this environment because GStreamer development headers/pkg-config packages are absent.

**Still open:** the pop is user-confirmed and has not yet been retested with Build 263. The important result is whether a full drag becomes quieter/cleaner when the native helper only applies the newest queued target once per callback. If it is unchanged, repeated IPC/property writes are less likely to be the root cause and the next experiment should move down into the actual audio-sink/gain implementation rather than another arbitrary ramp.

### Earlier confirmed findings

- Build 260 removed the 10 ms user-volume ramp after Build 259's cubic ramp still left a subtle pop. The dedicated `hive-user-volume` element stayed in the `audio-sink` bin immediately before the real sink to preserve the previously observed ~1 second queue-latency fix.
- Build 261 changed native command delivery from a 5 ms poll to event-driven `g_main_context_invoke()` wakeups and fixed persistent automatic GPU fallback. User confirmed GPU-accelerated UI is now fine, but the audio pop remained.
- The supplied Strawberry 1.2.29 source was inspected: ordinary volume uses direct `g_object_set(..., "volume", ...)` on the selected sink `GstStreamVolume` or a software `volume` fallback; its dedicated fader is a separate fade path. This supports keeping Hive's ordinary slider path simple while diagnosing the remaining artifact.
- Known failed volume approaches that should not be repeated blindly: periodic 5–30 ms polling/slew, direct playbin/sink volume without the dedicated post-queue element, and manual `GST_IS_STREAM_VOLUME`/deep-element sink walking.

### Build 262 — diagnostic regression coverage (2026-09-18)

- Added stable volume tests for native `VOLUME_STATE` tracing, muted-target semantics, event-driven command-burst draining, and sink-volume initialization ordering.
- No runtime playback/audio behavior changed.
- User subsequently tested it and reported **multiple audible pops per slider drag**, which motivated Build 263.

## How to leave this file

Before ending a session: update the relevant section above with what you
tried, the result (user-confirmed if possible), and what's still open.
Keep `npm test` green and don't leave the build broken. Commit your
changes with clear messages (not just "wip") so the next session can
`git log`/`git diff` to see exactly what changed, in addition to reading
this file.
