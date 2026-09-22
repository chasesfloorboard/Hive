# 1.0.2 — Light theme cover-art saturation and track-time contrast

- Fixed Light theme's cover-art-derived accent colors (glass panels, ambient blobs, "Colored Now Playing background") reading as dull/pastel instead of vibrant. `extractPaletteFromImage()` in `app/renderer/colorExtract.js` only boosted saturation by ~5% for Light theme while pushing lightness up toward 0.8 — visually "brighter" in isolation, but that combination desaturates toward gray once blended into a bright panel. Saturation boost now roughly matches Dark theme's own tuning and the lightness ceiling is pulled back down, so hues stay rich; the existing hard luminance cap that protects full-opacity consumers is unchanged.
- Fixed the Tracks table's per-row duration text never getting its Light-theme dark-text override. The CSS targeted a class name (`.s-dur`) that a previous build silently renamed to `.s-length` in `songRowHtml()`; the override became dead code with no test catching it because three separate `buildNNN-*.test.js` files were themselves pinned to the same stale selector via regex. Fixed the selector (and the base column layout rule) in `app/renderer/styles.css`, and updated `test/build242-context-menu-readability.test.js`, `test/build243-context-glass-topbar.test.js`, and `test/track-list-sorting-and-alignment.test.js` in place to match current markup instead of re-adding the dead name.

Full `npm test`: **701/702 passing** (`test/build140-packaging.test.js`'s executable-bit check is a pre-existing, unrelated filesystem-permission artifact of this checkout, not a regression).

# 1.0.1 — README, per-theme backdrop, Playlists tab cutoff, stale album art, and Discord/MPRIS lag

- Fixed the GitHub README losing its logo and centered header layout during a screenshot refresh; restored while keeping the new screenshots.
- Fixed every non-Light theme (Ember, Forest, Ocean, Violet, and custom folder themes) rendering the same hardcoded near-black backdrop behind every panel as the Dark theme, instead of each theme's own background color. `#ambient-bg` in `app/renderer/styles.css` now derives from `var(--bg)`.
- Fixed the Playlists tab silently clipping the bottom of a long playlist list with no scrollbar hint. Its container reused `.empty-state`'s large top margin (meant for short "no content" text) and the virtualized list's viewport sized itself off a `calc(100vh - ...)` guess instead of its real available space; either could exceed `#main`'s `overflow:hidden` clip. Now sized with flex layout against the real available height.
- Fixed edited album covers appearing "stuck" between the old and new artwork (or blank) until an unrelated full library rescan happened to reconcile it. The reconciliation function that was supposed to refresh a track's cover after a background artwork write existed but was never actually wired to the write-completion event; fixed and generalized so every edited track (not just the currently-playing one) gets its cover patched in place once the write finishes.
- Fixed Spotify and podcast track changes taking up to 5 seconds to reach MPRIS (and therefore Discord Rich Presence) because those paths relied solely on the debounced periodic sync instead of publishing immediately like local GStreamer playback already does.
- Fixed `npm run check`: `package-lock.json`'s version had drifted from `package.json`, `logs/README.txt` (asserted by the checker but never actually committed) was missing, and one checker assertion still matched only a since-refactored variable/call shape from an earlier build.

Full `npm test`: **702/702 passing**.

# Build 275 — Android device duplication, SD card write failures, and a main-process freeze hazard

- Fixed a phone showing up as two separate "Android devices" in Settings → Devices. `parseGioVolumes()` in `app/main/device-manager.js` never reset its `volume` tracking variable after leaving a `gio mount -li` `Volume()` block, so unrelated top-level `Mount(N)` entries that follow it — GVfs's own internal shadow/daemon duplicate of the same phone, and any other unrelated local mount (in this case a folder literally named "Music") — inherited the phone's stale MTP volume/type. That produced a bogus extra "mtp" storage on the real phone and a second phantom "phone" whose only storage was actually the user's local Music folder. Fixed by only attributing indented `Mount(N)` lines to their owning `Volume()`; a top-level line now closes out and clears the current volume instead of leaking into it. Reproduced and verified fixed against this session's actual live `gio mount -li` output.
- Fixed every transfer to the phone failing with "permission denied" on the very first `mkdir`. Real Android MTP responders reject directory creation at the bare device root — only inside an actual storage volume (e.g. "Internal storage" or "SD_Card"). `inspectStorageRoots()` discovered those real storage folders correctly but kept an earlier placeholder storage entry (empty path, meaning "write at the device root") alongside them; if that placeholder was selected — as it was by default before real folders were known — every transfer's directory creation failed immediately. Fixed by dropping the placeholder once real storage folders are found. Reproduced directly (`mkdir` at the live phone's MTP root: `Permission denied`; the same `mkdir` one level down inside `SD_Card` or `Internal storage`: succeeds) and confirmed fixed by actually sending a track to the device's SD card and finding it landed at `SD_Card/Music/<Artist>/<Album>/<Track>` as expected.
- Fixed the "prefer the SD card as the default transfer destination" feature never recognizing a real phone's SD card when its folder isn't literally named "SD card" with a space. The detection regex in `devices:list` (`app/main/main.js`) required whitespace between "sd" and "card"; this user's own phone names the folder `SD_Card` (underscore), which never matched, so the destination silently defaulted to internal storage instead of the SD card as the Devices panel itself documents. Fixed to accept any (or no) separator between "sd" and "card" (`SD card`, `SD_Card`, `SD-Card`, `sdcard`).
- Fixed a latent main-process freeze hazard in the same code path: `parseGioVolumes()` used to `fs.readdirSync()` the live `/run/user/<uid>/gvfs` mount directory to recover a missing `mount_path`. That is real, synchronous filesystem I/O against a live MTP/FUSE session on Electron's single main process; when that session is slow or wedged (a locked phone, one mid-transfer, one that just disconnected), the call can block for many seconds — freezing the entire app, not just the device list. Reproduced directly this session (this exact call taking ~19 seconds after heavy MTP activity). Fixed by moving that lookup into a new async `attachGvfsMountPaths()` using `fs.promises`, called from the already-async `refreshDevices()`; `parseGioVolumes()` itself is now a pure, fast, synchronous string parser that never touches the filesystem, matching how it's already used everywhere (including every existing test).
- Added stable regression coverage in `test/device-sync.test.js` for all four fixes (device de-duplication against a reproduction of the real `gio mount -li` output, `inspectStorageRoots` dropping the placeholder, the SD-card regex behavior, and asserting `parseGioVolumes` never touches the filesystem synchronously). No new `buildNNN-*.test.js` file was created.

Full `npm test`: **564/564 passing**. All four fixes were also verified live against this session's actual connected Samsung phone: Settings → Devices now shows one device with both real storages, defaults to `SD_Card/Music`, and a real track transfer was sent and confirmed present on the phone's SD card afterward.

# Build 274 — rating display and context-menu responsiveness repair

- Fixed star ratings appearing to vanish on non-MP3/WAV files (M4A/MP4 confirmed; same class of bug for any format read through the generic `music-metadata` path). `write_rating()` in the bundled Mutagen backend always wrote correctly, but `readNativeEmbeddedRating()` in `app/main/main.js` compared the bare field name `FMPS_RATING` against the tag id `music-metadata` actually returns for MP4 freeform atoms, `----:com.apple.iTunes:FMPS_Rating`, which never matched. The write silently succeeded while the UI always showed 0 stars back. Root-caused and reproduced end-to-end using a real M4A from the user's library (`Brain Stew.m4a`, a Green Day *Insomniac* track — its embedded `©nam`/`TSOT` title is actually "Armatage Shanks", a mismatched-tag data issue in that specific file, not a Hive bug; noted for the user). Fixed by matching on the segment after the last `:` so both bare (FLAC/Vorbis) and namespaced (MP4 freeform) ids resolve. FLAC/Vorbis and MP3 (POPM) ratings were already correct and are unaffected.
- Fixed the right-click context menu on albums and tracks feeling unresponsive. Both `showAlbumContextMenu()` and `showTrackContextMenu()` in `app/renderer/renderer.js` unconditionally `await`ed `refreshAndroidDevices()` before the menu could render whenever no Android device was already known — the common case for users without a connected phone. That IPC round-trip shells out to `gio mount -li` in `app/main/device-manager.js` with up to a 5-second timeout, so every such right-click paid that cost before the menu appeared at all. Changed both call sites to fire-and-forget the device refresh (matching the existing non-blocking pattern already used by the Settings > Devices tab refresh); the menu now renders immediately and the "Send to" submenu simply becomes available on the next menu open once discovery completes.
- Audited the tagging/rating/Love write pipeline end to end (`resources/python/tag_helper.py`, `app/main/main.js` metadata IPC handlers, `queueMetadataSave`/tag-editor save path in `app/renderer/renderer.js`): Love (LOVE RATING=L) uses dedicated per-format readers including a raw MP4-atom parser and was already correct; the tag-editor save path already diffs per-track against original values in bulk/album mode so untouched fields and per-track divergent values are preserved (Rule 5 of the metadata canon); `write_mp3`/`write_flac`/`write_mp4` in the bundled backend only touch keys present in the request. No other correctness issues found in this pass.
- Added stable regression coverage in place: `test/build258-metadata-backend-canon.test.js` gained a source-shape assertion plus a live write-then-read round-trip test (synthesizes a throwaway M4A via `ffmpeg` when available, skips cleanly otherwise) proving a Hive-written M4A rating is readable again; `test/build240-context-menu-cohesion.test.js` gained a regression test asserting neither context-menu function awaits device discovery. No new `buildNNN-*.test.js` file was created.
- Verified live: compiled and ran the actual native GStreamer helper and full Electron app on the target GNOME/XWayland desktop for the first time this session (previous AI sessions worked from static source analysis only). Confirmed real audio playback, confirmed the context-menu fix visually (menu paints on the same frame as the right-click, screenshot captured with no artificial delay), and confirmed the rating fix via a real write/read round trip against both a copy of the user's actual M4A file and a synthesized fixture.

Full `npm test`: **557/557 passing**.

# Build 273 — album metadata, ordering, artwork, and auto-tag workflow repair

- Fixed album track ordering after title edits by using a robust numeric track/disc parser before title/path tie-breakers. Values such as `10/14` now sort as track 10 rather than falling through to alphabetical order.
- Fixed the album tag-editor scope bug: track models do not carry a renderer `albumKey` property, so album-mode editing was silently reduced to the first track. Album scope now derives from the canonical `albumKey(track)` identity, so album tag and artwork changes actually target every track in the album.
- Added album-surface cover actions: right-clicking an expanded album cover now offers **Change album cover…** and **Search Internet for album cover…**, both opening the multi-track artwork editor.
- Reworked album Auto-tag so it searches automatically on open, safely maps individual local tracks using existing tags, filenames, track/disc numbers, artist evidence, and duration, and requires every album track to map before applying. It writes only fields that differ, while applying one selected MusicBrainz front cover to every mapped track through the canonical durable metadata queue.
- Added release artwork URL data to the MusicBrainz release-details response so Auto-tag can reuse the existing approved artwork downloader.
- Updated stable artwork/metadata tests in place; no new `buildNNN-*.test.js` file was created.

Validation: targeted album/artwork/metadata tests **23/23 passing**. Full `npm test`: **552/554 passing**; the two remaining failures are the known source-archive `music-metadata` environment failure in `artwork-payload.test.js` and no project runtime dependency install in this source archive.

Runtime validation remains required on the user's actual Electron/Linux library.

# Build 271 — metadata recovery retry repair

- Fixed startup recovery for interrupted metadata jobs that retained an exhausted attempt count. A recovered job now begins a fresh three-attempt recovery session instead of skipping the retry loop and displaying the misleading generic failure message.
- Added idempotent satisfaction checks for combined metadata jobs: if the requested tags/artwork are already present after a crash, Hive deletes the recovery journal entry without rewriting the media file.
- Preserved the canonical bundled Mutagen writer and staged backup/commit path; this is a recovery-state fix, not a second metadata writer.
- Improved failed-job reporting to retain the durable last error when the in-memory retry loop has no new error.

# Build 270 — metadata editor verification repair

- Fixed the remaining metadata-editor failure seen in Build 269 on M4A files. The metadata writer itself was succeeding, but `performWriteMetadata()` then dynamically imported the optional Node `music-metadata` package for read-back verification; when that package is absent from a portable/source runtime, the successful native write was discarded and the job retried three times.
- Moved ordinary tag read-back verification into the canonical bundled Mutagen helper via a new `read_metadata_fields` JSON-lines operation. Metadata writes no longer depend on a second Node-side metadata parser after the native write.
- Added stable regression coverage for the native verification path and exercised an M4A write/read-back through the bundled helper.
- The user's runtime log also shows the exact three-retry pattern: one persistent `tag_helper.py` process plus three successive staged `cp` operations for `Brain Stew.m4a`. The 15.3-second renderer scroll stall is recorded separately as a runtime-performance issue; this metadata fix does not claim to resolve it.

# Build 269 — portable metadata backend repair

- Fixed the canonical Mutagen metadata backend packaging: `resources/python/tag_helper.py` expects the bundled Mutagen package at `resources/mutagen/`, but the Build 268 source archive omitted it. On systems without a globally installed Mutagen, the helper exited before accepting requests, so the metadata queue retried the operation three times and surfaced only the generic “Metadata operation failed after 3 attempts” message.
- Added the Mutagen 1.47.0 package under `resources/mutagen/` so metadata editing is self-contained and portable as required by the metadata backend canon.
- Added stable regression coverage that imports Mutagen with Python site-packages disabled and verifies that the bundled copy is the one resolved.
- Restored executable permissions on shipped shell entrypoints in the release archive.

## Build 272 — M4A Unicode metadata-key repair (2026-09-18)

- User supplied the concrete remaining failure from Build 271: `Brain Stew.m4a` reported `Could not write metadata: 'latin-1' codec can't encode characters in position 22-24`.
- Root cause isolated to the bundled Mutagen MP4 writer: Unicode MP4 freeform (`----`) field names were passed through `_key2name()`, which encoded the entire key as latin-1. The failure occurs at position 22, exactly where the freeform name begins after `----:com.apple.iTunes:`.
- Updated the bundled MP4 backend to encode freeform `mean`/`name` components as UTF-8 while retaining latin-1 handling for four-byte MP4 atom identifiers. Reading uses UTF-8 with a latin-1 fallback for malformed/legacy freeform components.
- Added stable regression coverage in `test/build258-metadata-backend-canon.test.js` for emoji, accented, and CJK freeform field names.
- Targeted metadata suite: 7/7 passing. A real temporary AAC/M4A fixture also passed: an existing Unicode freeform field named `🔊` survived a title edit through the bundled helper and the edited title read back correctly. Full `npm test`: 548/549; the sole failure is the known source-archive `artwork-payload.test.js` environment failure because `node_modules/music-metadata/lib/index.js` is absent.

## Build 268 — Android device destinations + album Send to menu

- Right-clicking an album now exposes **Send to** with the currently discovered Android devices, so the entire album can be transferred without first selecting individual tracks.
- Android/MTP discovery now groups multiple GIO storage mounts belonging to the same phone into one device entry. A phone with Internal storage + SD card therefore appears as one phone with multiple selectable storages instead of multiple Android devices.
- Devices settings now shows each phone's available storage roots and a configurable destination folder. If an SD card is detected, Hive defaults the destination to that storage's `Music` folder; otherwise it uses `Music` on the phone's main storage. The destination is persisted per device.
- Transfer paths are normalized and traversal (`..`) is rejected before copying.
- Stable `test/device-sync.test.js` was updated in place with multi-storage grouping and destination-path safety coverage.
- Runtime Android/MTP validation is still required on the target Linux system.

## Build 267 — stable playback baseline + audio outputs + navigation overhaul

- Reverts the Build 265 sink-owned `GstStreamVolume` experiment after the user reported that Build 266 produced no audible playback. Build 267 restores the Build 263 ordinary volume architecture: the dedicated `hive-user-volume` element remains immediately before the real sink, with event-driven native command delivery and latest-value coalescing.
- Adds Linux audio-output enumeration through the standard `pactl` PulseAudio/PipeWire compatibility interface. Playback Settings now has an Output device dropdown, refresh control, and explicit Apply action; the selected sink is passed to the native helper through `HIVE_AUDIO_OUTPUT_DEVICE` and uses GStreamer `pulsesink`. Changes are saved and applied on the next Hive restart.
- Keeps the system-default output as the safe fallback when no selection is saved or the selected output cannot be created.
- Reworks Settings → Navigation into separate Sidebar and Top bar sections, adds clearer ordering/pinning controls, a reset action, and hides raw `<span class=...>` presentation markup from navigation names in the editor.
- Keeps the Build 266 Android/MTP music-transfer capability.
- Added stable audio-output regression coverage and updated existing navigation tests in place.
- Runtime audio and physical Android/device validation are still required on the target Linux system.

## Build 263 — native latest-value volume coalescing

- Keeps the dedicated `hive-user-volume` element and immediate renderer-to-native input path, but treats ordinary `VOLUME` messages as latest-value state inside the native command callback. A burst of queued slider positions now produces one GStreamer volume-property update using only the newest target.
- Removes the redundant renderer `pointerup` volume resend; pointer release now only flushes persistence.
- No ramp, timer, sink walking, or new volume curve is introduced. This is a focused diagnostic to determine whether repeated gain-property writes are the source of the multiple pops heard during a single drag.
- Updated the stable `test/volume.test.js` in place with coverage for latest-value coalescing and the duplicate pointer-release write.
- Runtime audio validation is required on the target Linux/PipeWire system.

## Build 262 — volume diagnostic regression coverage

- Expanded the canonical `test/volume.test.js` in place with regression coverage for native volume tracing, muted target updates, event-driven command-burst draining, and sink-volume initialization ordering.
- Removed a duplicate transport-volume test from the consolidated volume suite.
- No playback/audio behavior was changed in this build; the remaining subtle audible volume pop still requires real-hardware investigation.

# Build 261 — event-driven native volume dispatch + GPU acceleration default

- Keeps ordinary user volume as a direct `g_object_set()` on Hive's dedicated in-pipeline `hive-user-volume` element immediately before the real sink. There is no slider ramp, interpolation controller, or renderer debounce.
- Replaces the native helper's 5 ms command polling with an event-driven GLib main-context wakeup from the stdin reader. Bursts of slider input are coalesced into one pending dispatch while `command_tick()` drains the queued commands, removing the periodic command-delivery delay without changing the GStreamer volume architecture.
- Compared the supplied Strawberry 1.2.29 GStreamer engine: it also creates a software `volume` element when a sink lacks stream-volume support and performs ordinary volume changes with direct `g_object_set()`; its separate timeline volume element is used for fades. Hive retains its post-playbin-queue placement because direct playbin/sink volume was already user-tested and audible popping remained.
- Restores hardware-accelerated Electron rendering as the normal path. A prior automatic GPU-process-crash fallback could persist `disableGpuAcceleration=true` and make later launches appear to have GPU acceleration disabled by default; Build 261 no longer persists that automatic choice. Existing automatic-fallback markers are cleared on startup, while an explicit user disable remains honored.
- Adds stable regression coverage for event-driven native command delivery and the GPU acceleration default/migration.
- Runtime audio/UI validation is still required on the target Linux/PipeWire system.

## Build 260 — direct user-volume control + fast window close

- Removes the 10 ms user-volume ramp and the GStreamer interpolation-control
  source after Build 259 remained subtly audible on real hardware.
- Keeps the dedicated `hive-user-volume` element immediately before the real
  sink, after playbin's internal queue, and applies slider values directly to
  that in-pipeline element. Track switching is not routed through the slider
  setter, and ReplayGain remains separate upstream.
- Inspected Strawberry 1.2.29's GStreamer engine: its ordinary volume path
  directly sets the selected `GstStreamVolume`/software-volume element; its
  timeline fader is a separate feature. Hive's Build 260 follows the same
  direct-set principle while retaining Hive's queue-latency fix.
- Removes the synchronous recursive `User Data Backup` snapshot from Electron's
  `before-quit` path. Per-file JSON writes already mirror user-owned state to
  the backup; the stable profile remains the source of truth, avoiding a large
  filesystem copy while the X button is closing the window.
- Adds stable regression coverage for direct volume application and the
  non-blocking shutdown path.
- Runtime audio/UI validation is still required on the target Linux system.

## Build 259 — monotonic-cubic user-volume ramp

- Keeps the established in-pipeline GStreamer user-volume element directly upstream of the real audio sink, preserving the fix for the previous ~1 second audible control lag.
- Changes only the control-source interpolation from linear to `GST_INTERPOLATION_MODE_CUBIC_MONOTONIC`, giving the short 10 ms slider ramp a smooth slope at its endpoints rather than the slope discontinuity of a linear ramp.
- Keeps renderer input immediate, ReplayGain isolated, mute separate, and GStreamer authoritative.
- Adds the interpolation-mode regression guard to the canonical `test/volume.test.js` without creating another build-specific volume test.
- Removes the confirmed-dead main-process MP4 Love writer and its now-unused atom-builder imports; the live Love write path remains the canonical Mutagen backend.
- Runtime audible validation is still required on the target Linux/PipeWire system.

## Build 258 — metadata backend consolidation
- Canonicalized Hive metadata architecture around the bundled Mutagen backend for local tag, rating, Love, and artwork writes.
- Removed FFmpeg/metaflac/handwritten-container reconstruction from the rating and Love write paths.
- Added backend-level read/write verification and preserved-artwork checks for rating/Love operations.
- Added `docs/ai/HIVE-METADATA-BACKEND-CANON.md` and made it part of the end-game/finalization engineering contract.
- Preserved the existing Hive UI and IPC surface; this is an internal backend reconnection, not a UI rewrite.

# Build 257 — GStreamer soft-volume compile fix

- Fixed the Linux native GStreamer helper compilation failure introduced by Build 254: `GstPlayFlags` is a playbin plugin API and the soft-volume flag constant is not exported by the core `gst/gst.h` headers.
- Uses the documented soft-volume bit locally before clearing it, preserving Build 254's native sink-volume architecture without depending on an unavailable header symbol.
- Corrected the native volume diagnostic label to report `stream_volume=playbin`; no playback architecture or metadata behavior was otherwise changed.
- Added a regression test covering the plugin-flag header dependency.

# Build 256 — metadata write safety and album auto-tag matching

- Fixed the M4A/MP4 native rating/Love atom rebuild so the `meta` FullBox version/flags header is preserved; Build 255 could omit it and leave valid iTunes metadata exposed as numeric key atoms.
- Moved rating and Love writes through temporary copies and the existing final commit path so the original is not replaced until the new file verifies successfully.
- Added a recoverable `Tag Backups` copy before every metadata-file replacement and refuse the replacement if that backup cannot be created.
- Ordinary metadata/tag writes now fingerprint embedded artwork before and after the edit and reject the replacement if unrelated artwork changed.
- Changed album Auto-tag matching to protect already-complete tracks and use metadata/filename/track-number/duration matching with a conservative threshold; unmatched files are not guessed by array position.
- Added regression coverage for the MP4 FullBox bug, metadata backups, artwork preservation, staged rating/Love writes, and safe album matching.

# Build 255 — preserve M4A artwork during rating writes

- Changed M4A/MP4 rating writes to patch the existing iTunes metadata atom instead of round-tripping the entire container through ffmpeg.
- Preserve existing title, artist, album, album artist, artwork, and other metadata while replacing only `FMPS_Rating`.
- Keep immediate read-back verification so a rating is never reported as saved when the file does not contain the requested value.

# Build 254 — native GStreamer sink volume

- Changed ordinary local volume from a second software `volume` filter to GStreamer's playbin stream-volume control.
- Disabled `GST_PLAY_FLAG_SOFT_VOLUME` so the native audio sink handles volume when it exposes `GstStreamVolume`, matching Strawberry's proven Linux architecture.
- Kept ReplayGain isolated on the dedicated upstream GStreamer volume element and kept renderer volume input immediate.

# Build 253 — immediate GStreamer volume input

- Removed the renderer-side 20 ms volume dispatch timer.
- Local volume slider input now sends each requested 0–1 value immediately to Hive's dedicated GStreamer `volume` element, matching the responsive behavior of the verified Strawberry architecture.
- Kept ReplayGain on its separate GStreamer volume element and kept transport/mute separate.
- Added a regression test covering immediate slider dispatch and the absence of the timed volume debounce.

# Build 252 — dedicated GStreamer user-volume element

- Replaces the experimental native 30 ms user-volume slew with a Strawberry-style dedicated GStreamer `volume` element inside Hive's authoritative audio-filter path.
- Keeps ReplayGain as a separate upstream GStreamer volume element; the ordinary 0–1 user slider is no longer multiplied by `track_gain`.
- Retains the renderer's 20 ms target coalescing during slider drags and exact final-value flush on pointer release.
- Preserves the persistent playbin/playbin3 transport, native seeking, spectrum analyzer, and separate mute control.

# Build 250 — smooth coalesced user-volume control

- Replaces direct ordinary local-volume jumps with a single GStreamer-authoritative 30 ms user-volume slew whose destination moves as the user drags.
- Coalesces renderer slider events to one native target at most every 20 ms, while pointer release flushes the exact final value immediately.
- Keeps mute separate and leaves transport/queue ownership in the persistent GStreamer playbin path.
- Preserves the existing 0–100 linear Hive slider and canonical 0–1 engine volume.

# Build 249 — GStreamer native compile repair for direct-volume isolation

- Repairs the Build 248 native GStreamer helper declarations accidentally omitted during the diagnostic volume isolation edit: the spectrum element, `event_line` forward declaration, and direct output-mute helper are restored.
- Does not change Build 248 playback/volume behavior: user volume remains direct, transport remains direct in this diagnostic build, and mute remains separate.
- Validates the actual native GStreamer compile against the installed GStreamer development headers and libraries before packaging.

# Build 248 — direct user-volume isolation test

- Keeps the volume slider linear 0–100 mapped to canonical 0–1 engine volume.
- Sends each explicit user-volume change directly to the persistent GStreamer playbin; removes the renderer 5 ms coalescing timer and the native 10 ms user-volume ramp.
- Transport remains direct and independent: track changes, PLAY, PAUSE, and queue handoff do not use the user-volume path.
- Mute remains a separate direct control.
- Diagnostic purpose: Build 247 reproduced popping while changing volume with smoothing enabled; Build 248 tests whether direct GStreamer volume itself remains pop-free.

# Build 247 — isolated smooth user-volume test

- Restores the Hive 0–100 linear volume slider and canonical 0–1 engine volume.
- Local GStreamer now smooths **only explicit user-volume changes** with a 10 ms native gain ramp.
- Transport remains direct: track changes, PLAY, PAUSE, and queue handoff do not start, wait for, or depend on the user-volume ramp.
- Mute remains a separate direct mute control.
- This is a diagnostic build: if slider movement now reproduces the pop seen in older builds, the volume-change path is implicated; if it remains clean, the remaining pop is in track-transition/audio-pipeline behavior.

# Build 246 — volume isolation test + light-mode album back arrow

- Volume slider is visual-only: dragging/wheeling it changes only the displayed slider position and icon. It sends no local GStreamer, Spotify, podcast, WebAudio, MPRIS, or persistence volume update.
- Removed the 10 ms transport volume ramp implementation and all renderer/native ramp commands/waits from this diagnostic build. Track changes and pause/play now use direct GStreamer state transitions with no volume automation.
- Native `VOLUME` commands are ignored in this isolation build so the old slider path cannot affect local GStreamer volume. ReplayGain (`GAIN`) and mute remain separate paths.
- Light theme now renders the custom album back-chevron black for visibility.

# Build 243 — context menu / glass outline / topbar search polish

- Kept album Auto-tag album single-target behavior intact.
- Added consistent star and trash icons to track/album context actions and icon treatment to the lyrics context menu.
- Unified every nested context menu onto the same frosted-glass surface and left-aligned menu content, while keeping menu width bounded.
- Kept long album labels constrained by the existing 15-character context label helper.
- Restored a thin accent-tinted outline to the Main and Now Playing/playbar surfaces when Frosted Glass is disabled; disabling glass removes blur/translucency without removing the surface boundary.
- Repositioned the themed top-bar Library search field into the visible navigation row with reserved space so it remains visibly part of the top bar.
- Strengthened Light-theme playback duration contrast so selected/playing track times remain dark.

# Build 242 — light context-menu readability + compact sizing

- Made Light-mode durations/time readouts dark for the currently playing and selected tracks across queue, song-table, and inline album track rows.
- Changed right-click menus to a consistent left-aligned layout, including nested menus; the Add to submenu remains left-aligned as before.
- Capped context-menu width so long labels no longer force enormous menus.
- Context-menu album labels now truncate album names after 15 characters with an ellipsis while leaving the underlying album metadata unchanged.
- Preserved the frosted-glass context-menu surfaces and Build 241 transport/window behavior.

# Build 241 — canonical transport anti-pop / window chrome hit area

- Canonicalized the playback rule: the protected 10 ms ramp is transport-only, used once for a deliberate playing-track handoff and once at the beginning of a freshly loaded track. Normal playback, resume, scrubbing, and manual volume control do not start or restart it.
- Removed the renderer's 5 ms local-volume dispatch timer so ordinary slider movement reaches persistent GStreamer playbin immediately, without timer-based volume automation.
- Gave the themed Electron window chrome a dedicated 32 px hit-testable title row and a 50 px Hive navigation row, preventing the frameless window edge from clipping the upper half of the minimize/maximize/close hit targets.
- Preserved the Light-mode playback-time contrast from Build 239 and the frosted context-menu work from Build 240.

## Build 240 — context-menu glass + alignment

- Kept Auto-tag strictly single-target: the album context action can operate only on the one album that was explicitly right-clicked and never derives its target from a broader selection.
- Added the established Hive SVG icons to the track context menu to match the album context-menu interaction language.
- Centered context-menu action contents and nested menus consistently; the Add to submenu remains intentionally left-aligned so playlist names stay readable.
- Applied the same frosted-glass surface, border, blur, saturation, and shadow treatment to the root context menu and every nested submenu, including Rating.
- Preserved the Light playback-time contrast from Build 239.


## Build 239 — canonical transport anti-pop + Light playback time

- Made the protected 10 ms anti-pop behavior explicit: one ramp-down for an actively playing manual track replacement and one ramp-up at the beginning of a freshly loaded local track.
- Prevented a normal PAUSED → PLAYING resume of the already-loaded song from starting another transport ramp. Resume now returns directly to the user's selected volume.
- Kept ordinary volume slider input direct and user-authoritative; transport protection does not become a second volume-control automation path.
- Made the bottom playback time readout white in dark themes and dark neutral (`#252a31`) in Light, matching the current-track artist contrast.
- Added regression coverage and a durable Build 239 transport-behavior specification.


## Build 237 — Music Home search reset

- Re-clicking the already-active Music/Home destination now clears the global search field and returns to the normal Albums home view.
- Clears transient Music browser context and resets the Home viewport to the top without changing independent playlist/Music tabs.
- Added regression coverage for sidebar and top-bar second-click behavior.


## Build 234 — Themed Window Control Hit-Testing

- Fixed themed Electron minimize/maximize/close controls being blocked by the full-window titlebar interaction layer.
- Made the themed topbar itself the draggable surface while keeping application controls explicitly non-draggable and interactive.
- Kept the search field directly beneath the window controls and explicitly above the drag surface for reliable focus/click behavior.
- Preserved the combined Electron chrome + app topbar centerline and existing topbar geometry.


## Build 223 — Top Bar Centerline + Themed Window Bar Default
## Build 233 — Topbar/Search Interaction + User-Data Backup

- Restored the themed top-right controls to a dedicated, highest-priority interactive layer so minimize/maximize/close cannot be blocked by other UI.
- Anchored the library search field directly beneath and right-aligned with the themed window controls; search remains fully interactive and the surrounding topbar remains draggable.
- Kept Hive + pinned navigation centered in the combined themed Electron chrome + app topbar surface.
- Made the stable per-user Hive profile the durable primary store across downloaded development builds.
- Added a local `User Data Backup` under the enclosing Hive folder when one is present. The backup mirrors Hive-owned settings/playlists/UI/provider/customization state and is restored when its copy is newer; Chromium session/cache/log directories are excluded. User music files are never copied by this backup.
- Updated historical portable-persistence tests to describe the current stable-profile contract rather than the superseded build-local data contract.

- Centered the Hive brand, Music/Favorites tabs, and add-tab control on the shared top-bar app-row centerline.
- Removed the legacy vertical brand transform so alignment remains stable when the top bar is resized.
- Made the themed Electron window bar the default for new/unspecified window-bar preferences; an explicitly saved user preference is still respected.
- Preserved the existing frameless/custom window controls and drag-region behavior.

# Build 219 — albums viewer rounded corners
- Corrected the previous corner-targeting mistake: the four-corner radius belongs to the albums viewer `#main` frame, not the bottom playback bar.
- Restored the playback bar glass surface to its established upper-only radius.
- Added a regression test covering the albums viewer and preserving the playbar geometry.

# Build 218 — frosted surfaces + backend crash-course diagnostics

- Restored the left sidebar and right queue as true frosted/player-glass surfaces owned by their actual boxes; removed their competing pseudo-element glass overlays.
- Kept the Frosted Glass area controls and transparent mode intact, including the rounded playbar from Build 217.
- Added an in-app Backend crash-course checklist in Settings → Logs so the full playback/backend reproduction sequence is explicit.
- Diagnostic sessions now enable native GStreamer tracing for the session and record a renderer action timeline covering volume, scrubber, queue, and GStreamer transport commands.
- Kept ordinary user volume on the direct volume path; transport ramps remain isolated to transport transitions. No volume-pop fix is assumed without evidence.

# Build 217 — rounded bottom playbar

- Rounded all four corners of the bottom main playback bar using the established Hive `--radius` surface geometry.
- Applies consistently to both the normal playbar surface and the frosted/player-glass surface.
- Added regression coverage so the lower corners cannot silently return to square edges.

# Build 199 — Edit Track UI / Lyrics Workspace

- Redesigned the Edit Track Settings and Lyrics tabs with consistent Hive controls.
- Removed the obsolete per-track iTunes compilation switch and keep-in-sequence shuffle control. Compilation remains available through normal metadata editing; old keep-sequence metadata is no longer used to alter shuffle order.
- Made Start time, End time, and Lyrics offset use the same timing-input language. Lyrics offset is a single signed-seconds field: positive delays synchronized lyrics and a leading `-` advances them.
- Restored and clarified the per-track ReplayGain metadata fields. Global ReplayGain mode remains in Settings and controls whether embedded gain metadata is applied during playback.
- Lyrics tab now shows embedded lyrics or automatically searched online lyrics, including provider/status information and synchronized timing preview. Search follows the existing Highlighted Lyrics setting: LRCLIB-first for synchronized lyrics when enabled, Genius-only plain lyrics when disabled.
- Added targeted regression coverage for the new Edit Track UI and lyrics behavior.

# Build 194 — Favorites presentation persistence

- Persist/recover Favorites rich label styling across cold starts and development-build updates.
- Keep the canonical Favorites playlist as the durable presentation source while recovering legacy sidebar-only styling.

# Build 193 — smooth rapid volume control

- Reworked rapid local volume changes so GStreamer follows one continuously-smoothed target instead of restarting the protected 10 ms transport ramp for every slider update.
- Keeps the 10 ms transport ramp for playback transitions while separating it from user volume movement.
- Rapid back-and-forth volume dragging now coalesces into a single native gain trajectory, reducing zippering/popping caused by repeated short fades.
- Added regression coverage for the native user-volume smoothing path.

# Build 192 — unified playlist Music tabs + live playlist presentation

- Fixed sidebar playlist activation so Favorites and every user playlist always open their own independent Music tab instead of falling through to the Playlists manager.
- Playlist Music tabs retain independent Albums / Tracks / Artists view state and use the playlist's configured opening view.
- Live Playlist Info edits now propagate the configured display view to every already-open tab for that playlist, alongside the existing name/icon updates.
- Kept playlist automatic shuffle as the existing presentation-order behavior; it does not silently change the global player Shuffle switch.
- Centered the circular Add Tab control vertically and tightened it to 21×21px so it sits level with the surrounding tab controls.

# Build 191 — Favorites navigation regression + tab control polish

- Fixed double-clicking a custom sidebar playlist, including canonical Favorites, so it uses the existing playlist playback/queue path.
- Custom playlist sidebar activation now keeps the clicked destination selected immediately instead of relying on a later navigation rebuild.
- Playlist Info saves now rebuild pinned navigation projections immediately, preventing live edits from requiring a restart to synchronize Favorites/custom playlist tabs.
- Fixed the Add Tab control inheriting the base tab minimum width; it now has an explicit 22px minimum so its 22×22 circular geometry remains circular.

# Build 190

- Prioritized synchronized lyrics for online lookup and preserved LRCLIB timestamped results for the highlighted lyric renderer.
- Added structured lyric-provider selection with plain-lyrics fallback.
- Updated the default new-user sidebar layout to match the requested compact navigation, including two solid blank dividers and Favorites beneath Playlists.
- Allowed blank divider labels while keeping blank normal navigation names invalid.
- Renamed the navigation editor concept from “Visual Divider” to “Divider”.

# Build 189

- Unified Favorites with the canonical playlist Music-tab viewer.
- Favorites now uses the same playlist browser/actions/state model as user playlists and autoplaylists.
- Removed stale Favorites-only viewer branches and protected Favorite timestamp sorting to the canonical Favorites playlist.
- Refreshed open playlist-tab presentation after Playlist Info saves without disturbing independent browser state.

## Build 188 — playback regression audit / transport stability

- Coalesced rapid local volume-slider events so the native 10 ms volume ramp is not restarted for every pointer event.
- Debounced volume-session persistence during slider drags and flushes the final value on interaction end.
- Restored normal scheduling priority for the GStreamer helper; audio transport is no longer deliberately niced below normal desktop work.
- Raised the short native transport-ramp callback priority without changing the protected 10 ms ramp duration.
- Preserved the single persistent GStreamer pipeline, native queue handoff, scrubber, and anti-pop transition architecture.
- Added Build 188 playback regression coverage.

## Build 187

- Restored the user-facing Colored Now Playing background toggle while keeping the duplicate Frosted Now Playing control removed.
- Restored the integrated rounded frosted playbar surface/border treatment.
- Reworked Plugins settings into a single import/share row and per-plugin Settings actions.
- Replaced the old Spectrum example visualizer with the shareable Monstercat Visualizer first-party plugin.
- Seeded the first-party Monstercat plugin into the user plugin folder so it can be copied/shared like a community plugin.
- Made Years visibility explicitly reversible and restricted it to the main Albums browser.

## Build 184 — Favorites Playlist Info Live Projection Fix

- Fixed Playlist Info saves so canonical Favorites presentation changes repaint the left sidebar immediately.
- Synchronized the saved Favorites label/icon into the sidebar and tab projections without requiring a restart.
- Preserved the canonical `hive-star-favorites` playlist identity and persistence behavior.

# Build 183 — Frosted surfaces and tab presentation correction

- Restored `Now Playing / player` to Appearance → Frosted Glass → Frosted surfaces as the single area-specific control for the playbar.
- Kept the redundant dedicated `Frosted Now Playing bar` setting removed; its underlying functionality remains through the existing `data-glass-area="playbar"` preference.
- Restored the original Build 173 glass-area behavior so the playbar respects both the master Frosted Glass switch and the Now Playing / player surface preference.
- Preserved the established accent-tinted frosted surface treatment and border used by Hive's glass panels rather than introducing a separate playbar card treatment.
- Reduced the Add Tab control to a compact 22px circular button instead of the oversized 34px circle.
- Added regression coverage for the restored Now Playing surface control and compact Add Tab presentation.

# Build 182 — Now Playing frosted glass presentation correction

- Removed the dedicated Appearance → Frosted Glass → Now Playing / player checkbox as requested; the playbar is no longer independently configurable.
- Preserved the Now Playing playbar's frosted/glass surface and accent-colored border, matching the established glass treatment used by the surrounding panels.
- The playbar now follows the existing master Frosted Glass preference only, while any stale per-playbar preference from older builds is ignored.
- Added regression coverage for the removed Settings control, retained blur, and retained accent border.

# Build 181 — Favorites presentation persistence and sidebar pin migration

- Fixed canonical Favorites migration so a saved rich label and custom icon are preserved instead of being reset to the default `Favorites` / `★` presentation.
- Fixed migration of the legacy Favorites pinned state so the canonical Favorites playlist remains represented in the top navigation when it was previously pinned.
- Playlist Manager now renders the persisted playlist icon for Favorites instead of forcing the default star.
- Added regression coverage for Favorites presentation persistence, pinned-state migration, and Playlist Manager icon rendering.


## Build 176 — portable library + Audio Integrity recovery

- Hive-owned user data now lives under the portable Hive `data/` directory when writable.
- Music folders inside the portable root are persisted as portable relative references and resolved automatically on another machine with the same sibling-folder layout.
- Existing user data is migrated into the portable data directory without deleting the legacy copy.
- Audio Integrity can generate a complete TXT report under `data/reports/audio-integrity/`, including exact file paths and decoder errors.
- Corrupt audio rows now expose a safe per-file repair attempt: FFmpeg recovery output must pass a full integrity scan before the original is replaced, and the original is backed up first.
- Repair temporary files are excluded from library filesystem watcher rescans.

# Build 175 — Frosted Now Playing setting consolidation

- Removed the redundant Appearance → Frosted Glass → Frosted Now Playing bar toggle.
- The dedicated Now Playing / player `data-glass-area="playbar"` control is now the single UI source of truth for the playbar frosted surface.
- Removed the legacy `beehive:playbar-frosted` renderer preference and associated CSS path.
- Preserved the existing default frosted playbar appearance and independent surface persistence.
- Added regression coverage for the removed setting and the retained player-glass control.

# Changelog

### Build 174 — Add Tab pressed-state polish
- Made the Add Tab button colorful in its normal and hover states.
- Added a black pressed state while the Add Tab button is actively clicked/held.
- Preserved the existing Add Tab behavior and tab architecture.

## Build 172 — Navigation, Favorites + Lyrics polish

- Restricted the Years control to the main Albums browser and kept it present while toggling the existing album/year grouping.
- Favorites sidebar activation now reuses the existing playlist Music tab instead of creating another tab on every click; the canonical tab remains named Favorites.
- User-added sidebar playlists now expose a lock/pin control in Settings → Navigation, and pinned custom playlists persist into the top navigation across restarts.
- Playlist-backed top-bar destinations use the existing independent Music-tab architecture rather than introducing a second navigation model.
- Removed the extra outer Lyrics glass surface so the Lyrics bubble is the single visible frosted surface around the lyrics.
- Reduced the timed active-lyric size change to a subtle 13px highlight while retaining the existing accent/current-line treatment.
- Updated stale Favorites/sidebar regression assertions to match the canonical playlist architecture.
- Added Build 172 regression coverage for Years visibility, reusable Favorites tabs, custom playlist pinning, and Lyrics styling.

## Build 170 — Frosted section toolbar removal

- Removed the `Album / toolbar bars` Frosted Glass surface option because the section toolbar is intentionally no longer a frosted surface.
- Removed the toolbar glass surface application and styling so section titles and view controls sit directly on the main content background without a translucent bar behind them.
- Preserved the existing independent Frosted Glass controls for the top bar, Left sidebar, Lyrics, main content, Queue, and Now Playing/player.
- Added regression coverage for the removed toolbar surface and setting.

## Build 169 — Frosted glass settings fix

- Removed the redundant Appearance → Hive themes → Glass surfaces checkbox; the dedicated Frosted Glass controls are now the single source of truth for surface glass.
- Fixed the Left sidebar Frosted Glass toggle so it disables the sidebar pseudo-element that was still painting and blurring the glass surface.
- Fixed the Lyrics Frosted Glass toggle so it also clears the Lyrics inner translucent surface and border.
- Added regression coverage for all three UI/settings behaviors.

## Build 168 — UI / volume polish
- Moved the Years control immediately before Albums in the Music browser toolbar.
- Years is visible only for the Albums view and hides for Tracks/Artists.
- Removed the Music tab surface-entry transform animation that could leave horizontal text streaking during view/tab transitions.
- Smoothed live GStreamer volume changes with the existing native 10 ms ramp path while playback is active, avoiding abrupt sink-volume jumps.

# Build 167 — Audio Integrity Scan Recovery UI

- Interrupted Audio Integrity scans now use a single primary scan action: Resume interrupted scan.
- “Start another scan instead” remains available as a lightweight secondary action rather than a second scan button.
- While an Audio Integrity scan is running, only Cancel scan is presented as the action control.
- Completing or cancelling a scan refreshes the recovery controls immediately.
- Checkpoint writes are serialized so concurrent scan workers cannot roll durable progress backward.
- Completed paths and accumulated corruption/unavailable/Love-conflict results remain durable across an app interruption.
- All shipped shell entrypoints are executable, including `install.sh`.

# Build 166 — Favorites Love-tag completeness fix
- Fixed the canonical Favorites evaluator so an unlimited Favorites collection never falls into the generic artist/album `selectBy` reduction path.
- Existing Favorites playlists that retained a legacy artist/album selection mode now still return every matching Loved track; the canonical Favorites identity and user-editable rules remain intact.
- Fixed exact recognition of the historical `MUSICBEE LOVE RATING` TXXX field alias without treating unrelated field names as Love metadata.
- Added Build 166 regression coverage for unlimited Favorites evaluation and the Love-field alias.
- Preserved the existing native-tag-authoritative Love/Favorites architecture.

# Build 165 — Favorites autoplaylist canonicalization + scan checkpoint durability

- Canonicalized Favorites as the single built-in, user-editable autoplaylist.
- Migrated duplicate/legacy Favorites sidebar entries to one persisted playlist reference.
- Favorites now opens in a new independent Music tab from Playlist Manager and sidebar.
- Audio Integrity checkpoints now serialize completed paths as arrays so interrupted scans can resume from the completed count instead of restarting at zero.

## Build 160 — Player Glass Settings, Themed Window Frame & Resumable Integrity Scan

- Moved all player Glass controls into Settings; removed Glass toggle/settings controls from the bottom player.
- Added individually addressable frosted surfaces for the top bar/window title bar, sidebar, Lyrics, main content, album/toolbar bars, Queue, and Now Playing/player.
- Replaced the native Electron frame with a Hive-themed frameless title bar and native minimize/maximize/close behavior.
- Made Audio Integrity scans durably checkpoint after each completed file and recoverable after an interrupted/closed session.
- Added Resume interrupted scan and Start a new scan controls without silently discarding checkpoints.
- Hardened library-folder right-click behavior so secondary-button activation cannot open the folder/info view; the context menu remains the route to Rescan library.
- Preserved queue clipping at the queue bubble boundary.

# Build 159

- Built-in Favorites is the single persisted smart playlist exposed as `★ Favorites`; its internal system identity is hidden from the UI and the name cannot drift to `Star Favorites`.
- Added player-wide frosted-glass master toggle with adjacent settings gear and persistent per-surface controls for Top bar, Sidebar, Queue, and Now Playing/player.
- Queue panel is now a hard rounded clipping boundary so queue content cannot bleed through the Now Playing/player surface.
- Restored the Library-folder right-click context menu with Rescan library, playback, queue, and Info actions.
- Automatic artwork lookup now ignores placeholder album metadata such as `Unknown Album` and leaves those tracks blank unless artwork is explicitly provided.

# Build 154

- Removed the 5,000-track cap from the built-in Star Favorites smart playlist so Favorites represents the complete `Love is Loved` collection.
- Extended Settings → Library → Audio integrity to audit duplicate/conflicting Love metadata across the full local library.
- Love conflicts resolve conservatively: any Loved `L` value wins over `U`/`0`/other unloved variants, then the file can be normalized to one canonical `LOVE RATING` tag.
- Love repair creates a complete pre-edit file backup plus a manifest in the user-visible `Tag Backups` folder before modifying the source file.
- Added explicit repair confirmation, progress/results, and an Open Tag Backups action.
- Added regression coverage for the Favorites cap, Love conflict precedence, backup-before-edit behavior, and repair UI.

# Build 153

- Added Settings → Library → Audio integrity with a full-library decoder corruption scan.
- Full scans decode each local audio stream asynchronously with bounded concurrency so Electron stays responsive.
- Added progress, current-file status, corruption/unavailable results, and cancellation.
- Full-scan results are cached by path/size/mtime during the session and never modify source files.
- Added regression coverage for the full-library scan and Settings UI.

# Build 152

- Added asynchronous local-audio integrity preflight before playback.
- Corrupt decoder input is rejected before GStreamer LOAD, with a themed error dialog showing the file location and decoder error.
- Corrupt-track recovery advances only after the user acknowledges the error.
- Validation is bounded and cached by path/size/mtime to avoid renderer/event-loop hitching and to revalidate replaced files.
- Preserved fail-silent GStreamer runtime handling for corruption discovered after the preflight window.

# Build 149 — Love / Playback Isolation

- Hardened the metadata/playback boundary: Love/Unlove writes now wait for an explicit GStreamer playback-path release and can no longer time out into replacing the active media inode.
- Playback-path handoff releases all queued metadata waiters for the previous track before protecting the new track.
- Multiple Love metadata requests for the same protected track are all released together when playback ownership moves away.
- Preserved the Star Favorites Smart/Auto Playlist architecture and optimistic Favorites UI; playlist membership changes do not issue native transport commands.
- Added regression coverage for protected-path waiting, path handoff, multiple waiters, and Love UI transport isolation.

# Build 144 — 1.0 metadata editing and playback safety

- Prevent metadata replacement from racing the active GStreamer playback file. Love, rating, tag, and artwork writes now wait for the active playback path to be released, with a bounded safety timeout.
- Added renderer-to-main playback-path protection so the metadata worker cannot replace the inode currently owned by the audio transport.
- Added universal `Empty` ghost text for genuinely blank editable text fields while preserving existing format/example placeholders.
- Start/stop trim fields now advertise `00:00.000` millisecond precision.
- Tags (2) standard native metadata values are editable and removable independently of Tags 1.

## Build 143 — 1.0 pre-release metadata object cleanup

- Fixed object-shaped Comments/Lyrics metadata being coerced into `[object Object]`.
- Normalized metadata at scanner, library-load, incremental-update, table, smart-playlist, and tag-editor boundaries.
- Treats the literal `[object Object]` sentinel as invalid display text.
- Added regression coverage for object-shaped metadata and the coercion sentinel.

## Build 142 — 1.0 pre-release audit pass

- Restored the `Years: ON/OFF` Music toolbar toggle and existing release-year dividers; `Sort: Release Date` remains removed.
- Star Favorites now renders with the actual `★` icon while remaining a real Smart/Auto Playlist.
- Added playlist duplication with deterministic `Copy`, `Copy 2`, `Copy 3` naming.
- Added persistent playlist destinations to the left navigation and Settings → Navigation.

## 1.0.0-rc.1 — Build 141 — Star Favorites Auto Playlist + Queue Visibility Fix

- Added Star Favorites as a persisted Smart/Auto Playlist using the existing rule engine, with the default `Love is Loved` rule.
- Favorites sidebar now resolves the same dynamic playlist record, so editing its rules changes the collection it represents.
- Existing Smart/Auto Playlists can be edited without changing their playlist identity, and playlist rows visibly identify dynamic lists as `AUTO PLAYLIST`.
- Fixed large queued collections rendering without visible queue rows by using explicit absolute `top` positioning for pooled queue rows.
- Preserved Build 139 playback-performance/spectrum work and Build 140 executable installer packaging.

## 1.0.0-rc.1 — Build 140 — Executable Installer Packaging Fix

- Fixed release packaging so `install.sh` is stored with executable permissions and can be launched directly with `./install.sh`.
- Restored executable permissions on the shipped shell entrypoints (`run.sh`, installer/setup helpers, and native launcher/provider scripts).
- Added packaging regression coverage for shell entrypoint executable bits.
- Build 139 playback-performance and spectrum changes are unchanged.

## 1.0.0-rc.1 — Build 139 — Playback Performance + Native Spectrum Stability

- Removed synchronous per-console session-log writes from the normal Electron playback path; runtime logging now queues asynchronous file writes.
- Fixed native GStreamer spectrum extraction to consume the documented `GST_TYPE_LIST` magnitude payload.
- Changed the left-sidebar Now Playing spectrum renderer to redraw only on fresh spectrum data or resize instead of a perpetual animation loop.
- Changed first-party Spectrum and Signal Rings plugins to event-driven rendering for the same reason.
- Preserved GStreamer playback ownership, queue/transport behavior, and existing Spotify architecture.

# Build 138 — Large Queue DOM Stability Fix

- Removed the intermediate `<div>` virtual-window wrapper from the right-side queue.
- Pooled queue `<li>` rows now remain direct children of the scrolling `<ul>`, matching valid list structure and keeping the spacer responsible for the full queue scroll geometry.
- Preserved bounded row pooling, absolute queue-index positioning, delegated interactions, artwork behavior, and the compact Build 137 transport persistence path.
- Added regression coverage preventing the malformed virtual-window wrapper from returning.


## Build 137 — Queue Regression Revert + Transport Persistence Optimization

- Restored the Build 135 known-good virtual queue DOM structure after Build 136 made the queue disappear.
- Kept Build 136's compact transport persistence path so routine position saves do not serialize the full queue.
- Added regression coverage requiring the cached virtual window and pooled rows to remain attached to that window.

# Build 131 — Unified Sidebar Context Menus + Queue Action

- Unified right-click behavior across track-bearing left-sidebar destinations including Music, Favorites, Recently Added, Top 25 Most Played, History, Yearly Wrap, Music Explorer, Playlists, and Now Playing.
- Replaced the Favorites/Recently Added/Top 25 special `Add playlist to queue` action with the same `Play` + `Queue` + `Info` + `Export as M3U` menu used by Music.
- Added a dedicated `Queue` action directly underneath `Play`; Queue appends the entire sidebar collection without replacing the current queue.
- Kept Podcasts on its existing informational context menu because podcast sidebar entries are show records rather than playable local music tracks.
- Added regression coverage for the shared menu contract and removal of the old dynamic-playlist-specific menu.

## Build 130 — Top-tab context, sizing, and monochrome Hive branding

- Prevented hidden expanded Music-tab album titles from leaking into the top tab while viewing History, Favorites, Recently Added, Top Played, folders, or other sidebar collections.
- Kept long top-tab labels readable by allowing the tab strip to scroll instead of flex-shrinking every tab until its label becomes only `…`.
- Kept the Hive brand mark monochrome across artwork/theme changes; the logo no longer receives colorful artwork accent raster-tinting.
- Added regression coverage for all three UI behaviors.

# Build 128 — Synchronized artwork rotation + expanded-cover context menu

- Unified the currently playing track artwork rotation into one shared timer/index across the main player cover, Now Playing cover, active queue thumbnail, currently playing album cover, and matching expanded album cover.
- Removed the independent queue-thumbnail rotation timer so queue artwork cannot drift from the main player artwork.
- Expanded album covers now use the same cover context menu as the main player cover, including cover selection, clipboard copy, and save actions.
- Retargeted dynamically created queue/expanded artwork surfaces without restarting the shared rotation clock.
- Preserved the lightweight incremental artwork reconciliation path and avoided full-library rescans.
- Added regression coverage for synchronized artwork targets and expanded-cover context-menu behavior.

# Build 127 — Queue double-click scrubber fresh-start fix

- Fixed queue-row double-click playback carrying the previous track's live GStreamer scrubber position into the newly selected track.
- Queue track double-click now invalidates the old native track index and resets the live scrubber mirror/UI to 0:00 before changing the active queue index.
- Hardened native POSITION event handling so late position reports from an unassigned/stale transport cannot repaint the old position during an explicit track transition.
- Preserved the native 10 ms transition ramp by keeping the active GStreamer transport available for the handoff.
- Added regression coverage for the exact queue double-click transition.

# Build 126 — Startup settings defaults + durable Shuffle/Repeat

- Legacy album art scaling now defaults to unchecked for first-time users; existing stored preferences remain migrated/preserved.
- Shuffle and Repeat restore independently of queue presence, so their states survive reboot even with an empty queue.
- Added regression coverage for both persistence/default behaviors.

# Build 125 — Sidebar double-click transport reset

- Fixed the deeper sidebar playback-position leak exposed by double-clicking Favorites and other left-sidebar collections.
- Sidebar playback now invalidates the previous transport request and clears the live GStreamer/scrubber state immediately, before asynchronous collection lookup completes.
- Prevented stale GStreamer POSITION events from remaining authoritative while the new sidebar queue is being resolved.
- Native GStreamer LOAD now explicitly seeks every fresh URI to the requested offset, including 0:00, so a persistent playbin cannot retain a prior track position during URI replacement.
- Preserved startup position restoration and ordinary manual track/album playback behavior.
- Added regression coverage for the asynchronous sidebar-to-fresh-track transition and explicit native zero-seek contract.

# Build 124 — Sidebar collection double-click fresh-start fix

- Fixed a playback-position leak when double-clicking a sidebar collection such as Favorites while another track is already playing.
- Explicit queue playback now resets the native GStreamer position mirror before the queue/session snapshot is persisted, preventing the previous track's position from being recorded against the newly selected track during the pre-LOAD race.
- Preserved the existing fresh-play contract: explicit queue, album, and track selections start at 0:00 while startup restoration remains the only path that intentionally restores a saved position.
- Added regression coverage for the stale GStreamer position persistence path.

# Build 122 — Track-column sorting across cloned tabs

- Fixed a tab-specific sorting regression where cloned Music/playlist table shells inherited the `sortHandlerBound` data attribute even though DOM event listeners are not cloned.
- Replaced the cloneable `data-sort-handler-bound` guard with a real DOM-node expando, so every independent table receives its own delegated header-sort listener.
- Preserved the natural typed sorting behavior from Build 121: text A→Z, numeric fields low→high on first click, and reversal on the next click.
- Preserved independent Music tabs, Favorites/playlist table rendering, column reordering, resizing, and virtualization.
- Added regression coverage proving the sort binding marker cannot be copied by `cloneNode()`.

# Build 121 — Natural track-column sorting

- Reworked Music track-column sorting around explicit semantic types instead of formatted display strings.
- Text columns such as Title, Artist, Album, Genre, Composer, Publisher, Comment, Filename, and Folder sort alphabetically using Hive's natural metadata collator.
- Numeric columns such as Plays, Rating, Length, Year, Track #, Disc #, Bitrate, Sample Rate, and Date Added sort using their underlying numeric values rather than strings such as `320 kbps`, `4/12`, or localized dates.
- Track and disc sorting now uses the underlying number while retaining the existing human-readable `n/total` display.
- Every newly selected column starts in intuitive ascending order (A→Z / low→high); clicking the same header again reverses it.
- Added a direct regression test against the production `sortTracks` implementation covering alphabetical Title sorting and numeric Plays sorting in both directions.

# Build 120 — Track sorting interaction regression fix
- Moved track-column sorting delegation from the transient header element to the persistent song table, so sorting continues to work after every header re-render.
- Added a one-time per-table binding guard to prevent duplicate sort handlers across repeated Music/Favorites/playlist renders.
- Prevented native column-drag gestures from starting when the pointer originates on a sortable header button.
- Preserved existing sort direction rules, column reordering, resizing, virtualization, and playback behavior.
- Added `docs/development/TRACK-SORTING-REGRESSION-BUILD120.md` and regression coverage for the multi-click sorting path.

# Build 119 — Compact artwork embedding status
- Replaced the full-width/sidebar artwork embedding progress surface with a compact top-bar indicator immediately left of the library search.
- Artwork changes remain optimistic and visible immediately; the indicator reports only the background container write.
- Added a small animated spinner and concise `Embedding…` status, with a short completion/failure state before it disappears.
- Tagged combined metadata jobs as artwork operations when they contain artwork so tag-only edits do not show an artwork status.
- Preserved the Build 116/118 no-full-library-reconciliation behavior so embedding feedback cannot reintroduce the post-write freeze.
- Added regression coverage for placement, spinner, artwork operation classification, and failure-path classification.

# Build 118 — Instant artwork UI with restored background progress
- Restored artwork/tag-operation progress to the established sidebar progress bar above Lyrics, so cover embedding is visibly in progress again instead of silently running in the background.
- Kept artwork selection optimistic: the live cover changes immediately while the physical audio-file write continues asynchronously.
- Kept the Build 116 freeze fix intact: the progress indicator is display-only and never triggers a full library scan, database rebuild, or whole-view reconciliation.
- Prevented metadata progress from overwriting an active library scan.
- Added a short completion state so fast one-file artwork saves still provide visible confirmation.
- Added a Build 118 artwork-progress UX audit and regression coverage.

# Build 117 — Real spectrum plugin platform and first-party extension pack
- Audited the existing Spectrum path and fixed the actual contract mismatch: native GStreamer already normalizes spectrum dB magnitudes to 0..1, so the plugin no longer normalizes the signal a second time.
- Kept GStreamer as the sole playback/analysis engine; plugins receive a compact canonical 64-band spectrum frame rather than PCM or a competing audio path.
- Added a small `Hive.audio` plugin API with `getSpectrum()` and `onSpectrum()` so future visual plugins do not need to depend on internal renderer variables.
- Added persistent plugin enable/disable state in user data. Optional first-party plugins are not loaded or executed when disabled.
- Added first-party **Signal Rings**, a circular bass/body/air frequency instrument driven by the real spectrum stream.
- Added first-party **Session Pulse**, a practical live listening panel showing current track, playback state, elapsed time, and real frequency energy. Both are disabled by default so Now Playing stays intentional.
- Upgraded the Plugins settings surface to show descriptions and enable/disable controls for every installed plugin.
- Added `docs/development/PLUGIN_PLATFORM_AUDIT_BUILD117.md` documenting music-player plugin research, the canonical spectrum contract, current trusted-code limitation, and the future capability-broker/sandbox direction.
- Added regression tests proving the native/plugin spectrum boundary, plugin catalog, plugin lifecycle/capability surface, persisted enable state, and first-party visualizer behavior.

# Build 116 — Artwork playback responsiveness and post-write freeze fix
- Removed the end-of-artwork full-library reconciliation that reread changed audio files, rebuilt the 30k-track library indexes, and repainted the whole view immediately after the final metadata write.
- Successful metadata writes now rely on the already-applied optimistic library/queue state; the next normal scan remains authoritative for disk changes without forcing a second scan at the end of the edit.
- Metadata progress no longer hijacks the library-scan progress bar in the lower-left sidebar. Album/tag writes use the compact status line above Lyrics instead.
- Limited multi-cover rotation to the actual Now Playing/playbar surfaces. Album cards and expanded album thumbnails remain static, avoiding multiple simultaneous large-image retargets during rotation.
- Removed redundant post-write artwork editor reloads from background replacement/deletion/addition operations.
- Added regression coverage for the no-full-reconciliation path, player-only cover rotation targets, and compact metadata progress UI.

# Build 115 — Album metadata batch performance
- Coalesced multi-track tag-editor changes and artwork changes into one durable metadata job per audio file, preventing the same album track from being rewritten twice during a single Save.
- Added a native combined metadata writer that opens and saves MP3, FLAC, and M4A/MP4 containers once while applying both ordinary tags and the requested artwork operation.
- Kept the generic Mutagen tag path for other supported audio formats so the optimization does not narrow format support.
- Album tag verification now skips embedded cover decoding, avoiding unnecessary image parsing when validating text metadata.
- Removed the artificial 75 ms delay between metadata files; progress events still update as each file completes.
- The metadata batch now holds the filesystem-watcher bulk-write guard for the entire operation, preventing a long album edit from triggering an unnecessary mid-batch library scan.
- Made combined artwork additions idempotent by avoiding duplicate image hashes during recovery retries.
- Fixed optimistic front-cover removal so removing only the front cover no longer clears secondary/back artwork from the live UI.
- Added regression coverage for one-save combined writes, per-file job coalescing, watcher suppression, and cover-free tag verification.

# Build 114 — Professional artwork editing and multi-cover safety
- Restored a complete interaction surface on blank artwork slots: Choose Picture, Paste Picture, Internet Search, right-click actions, and drag-and-drop all work on the empty slot itself.
- Added Front Cover and Back Cover quick actions so common album-art changes no longer require navigating the generic artwork card workflow.
- Fixed the artwork metadata editor referencing an out-of-scope slot variable during type/comment changes, which could throw a renderer exception while finishing an artwork edit.
- New blank artwork slots intelligently default to Front Cover when no front exists and Back Cover when a front is already present.
- Preserved front-cover selection when optimistic artwork state is rebuilt after changing a back/secondary picture.
- Kept artwork additions append-only in the native tag helper so adding a back cover cannot clear an existing front cover.
- Added regression coverage for blank-slot paste/context actions, front/back defaults, safe slot identity, append-only artwork writes, drag/drop, and quick actions.

# Build 113 — Now Playing visualizer workspace
- Reworked the left-side Now Playing destination into a dedicated visualizer workspace; it no longer renders the Music album grid, track table, or right-side queue panel.
- Added a large live spectrum stage with the current artist above it and current album artwork beside it.
- Kept the Spectrum Visualizer backed by Hive's real native GStreamer spectrum events; the plugin owns visualization while the Now Playing shell owns track identity and artwork.
- Updated live track changes so artist, title, album, and artwork remain synchronized while the visualizer stays mounted.
- Added regression coverage preventing Now Playing from falling back to a library/queue renderer.

# Build 112 — Real full-page Spectrum Visualizer
- Fixed the bundled Spectrum Visualizer rendering no visible bars because native GStreamer spectrum messages are dB values; the plugin now normalizes the -80 dB to 0 dB range before rendering.
- Reworked the visualizer into a full-page, music-reactive presentation with radial spectrum, glowing bars, responsive energy/pulse effects, particles, rings, and live track/status information.
- Kept the visualizer driven exclusively by Hive's existing native GStreamer spectrum stream; no second playback engine or synthetic music signal was introduced.
- Made the Now Playing visualizer surface full-bleed so the visualization owns the page instead of appearing as a small plugin card.
- Added regression coverage for native dB normalization and full-page reactive rendering.

# Build 111 — Restore Music track-header sorting
- Fixed Music track-list column sorting so clicks on Title, Artist, Album, Plays, Rating, Length, and other headers reliably reach the sorter.
- Replaced per-button sort listeners inside draggable column headers with delegated header sorting, preventing column-reordering drag behavior from swallowing sort clicks in Chromium/Electron.
- Preserved the existing numeric descending-first behavior and deterministic tie-breaking from Build 108.
- Added a regression test covering delegated sortable-header interaction.

# Build 110 — Settings, native visualizer, and podcast UI overhaul
- Restored a dedicated **Plugins** section inside Settings with explicit plugin import, folder access, reload, built-in visualizer recovery, and plugin-owned settings.
- Fixed plugin settings rendering so plugin fields actually mount into their settings cards.
- Promoted the bundled Spectrum Visualizer to a first-party built-in plugin. It uses Hive's existing native GStreamer spectrum stream and the established Plugin API rather than a decorative/fake animation or second playback engine.
- Moved the real spectrum visualizer into the left-side **Now Playing** destination and kept it driven by the actual active audio signal.
- Reworked Settings tabs with accessible tab/tabpanel semantics, keyboard navigation, clearer per-tab descriptions, stronger active/focus states, and a more consistent settings-card hierarchy.
- Kept Podcasts out of the default pinned top-bar tabs; users can still pin it through Navigation settings.
- Reworked podcast episode presentation to use a denser Albums-like hierarchy and improved the expanded episode rows.
- When a podcast episode has no lyrics, the left Lyrics panel now becomes a useful episode information panel using the feed description and publication metadata.
- Added a UI standards audit documenting the Hive-specific rules and WAI-ARIA guidance applied to this pass.

# Build 109 — Post-Spotify 1.0 stabilization pause

- Marked Spotify development as paused for the Hive 1.0 stable line. The existing Spotify/Spicetify implementation remains intact for later resumption rather than being deleted.
- Disabled automatic Spotify bridge startup and Spotify launch/login/command IPC while the pause flag is enabled, keeping the core local player independent of Spotify.
- Commented out Spotify/Spicetify installation and Spotify background-display dependency setup in `install.sh`; the original installer functions remain preserved and can be re-enabled when Spotify development is explicitly resumed.
- Kept the Spotify playlist import control visible as the existing red, disabled deferred button.
- Removed the Advanced CSS settings panel while retaining the supported built-in/community theme controls.
- Added `docs/development/POST-SPOTIFY-1.0-PAUSE.md` documenting the pause boundary and the exact resume procedure.

# Build 107 — Fix GStreamer spectrum property ABI crash

- Fixed the native GStreamer helper crashing with `SIGSEGV` during startup because the `spectrum` element's `threshold` property is a `gint`, but Build 106 passed `-80.0` through `g_object_set()` varargs as a `double`.
- The invalid varargs type was being interpreted as a huge integer (matching the observed `value "26005937" ... invalid or out of range for property 'threshold'` diagnostics) and caused the helper to crash repeatedly.
- Changed the threshold argument to the required integer `-80`, preserving the existing 64-band spectrum analysis and native GStreamer playback architecture.
- Added regression coverage for the GObject property type at the C call site.

# Build 106 — Restore native GStreamer compilation and Music toolbar cleanup

- Fixed the native GStreamer helper failing to compile because `event_line()` was used by the spectrum helper before its static declaration. This caused Hive to fall back to the renderer audio path on Linux, making track loads visibly laggy.
- Preserved the bounded 250 ms GStreamer preroll wait from Build 105 so slow decoders cannot hold manual track jumps for multiple seconds.
- Removed the obsolete Years/Release-date toolbar control beside Albums/Tracks/Artists while retaining the established album year grouping behavior.
- Added a regression test requiring the native helper's `event_line()` declaration to precede its first use.

# Build 105 — Local playback startup responsiveness and Music toolbar cleanup

- Restored the bounded 250 ms GStreamer preroll wait so slow decoders cannot hold a manual track jump for multiple seconds before PLAY is issued.
- Kept the persistent GStreamer/playbin transport architecture intact; when preroll takes longer than the bound, GStreamer continues its state transition asynchronously.
- Removed the obsolete Artists/artist-search “Sort: Release date” toolbar control and its dead toggle plumbing; the Albums/Tracks/Artists view switcher is now focused on view selection.
- Fixed the Yearly Wrap listening-event recorder referencing an undefined `force` variable, which was generating a renderer error after qualified track changes.
- Added regression coverage for bounded GStreamer preroll, the removed toolbar control, and Yearly Wrap listening-event recording.

# Build 104 — Large-library playback jump responsiveness

- Fixed rapid track selection in large Music-tab collections rewriting the entire queue session synchronously on every click.
- Same-collection playback jumps now update only the compact transport snapshot while preserving the existing queue and GStreamer transport.
- Added regression coverage for large-collection queue identity checks and transport-only playback jumps.

# Build 103 — Spotify background orphan recovery
- Spotify background ownership recovery now uses the durable launch PID and isolated `DISPLAY` when Spotify has stripped Hive-specific environment markers.
- Orphaned Hive Spotify instances whose Xvfb display was torn down are terminated from the durable ownership record instead of being misclassified as a visible desktop Spotify.
- PID-handoff recovery also accepts Spotify processes inherited on Hive's private Xvfb display, while unrelated desktop Spotify processes remain protected.
- Added regression coverage for orphan recovery after helper shutdown/PID handoff.

# Build 102 — Spotify background ownership handoff recovery

- Reworked Spotify ownership recovery around a durable owner record and inherited per-instance marker instead of trusting a single launch PID or transient lifecycle status.
- Detects Hive-owned Spotify child processes after Spotify hands the original launch PID off, while continuing to reject unrelated desktop Spotify instances.
- Cleans up all matching owned Spotify processes when their isolated Xvfb display has disappeared.
- Added regression coverage for PID handoff, durable ownership state, and multi-process provider ownership.

# Build 101 — Spotify background ownership recovery

- Fixed Spotify startup rejecting a Hive-owned background Spotify instance as if it were a user-visible desktop process.
- Hive now validates the persisted Spotify PID against its isolated `DISPLAY` and process identity before deciding an existing Spotify process is external.
- A surviving Hive-owned Spotify instance is reused across Hive/helper restarts instead of launching a second client or reporting a false visible-instance failure.
- Reused provider cleanup no longer terminates the Spotify process it did not launch; its isolated Xvfb display remains managed until the provider exits.
- Preserved Build 100 Spotify transport synchronization and queue-artwork fixes and Build 99 copyable provider diagnostics.
- Added regression coverage for provider ownership detection and reuse cleanup.

# Build 100 — Spotify transport sync and queue artwork

- Spotify bridge now samples live Player progress, duration, and play state instead of relying on a stale PlayerState snapshot.
- Spotify play/pause/progress events now push state immediately to Hive.
- Spotify provider timestamps are anchored to the live sample so Hive interpolation stays aligned with Spotify.
- Spotify playlist hydration preserves existing cover/artwork/cache fields when a fresh provider response omits artwork.
- Added regression coverage for transport synchronization and queue artwork preservation.

# Build 98 — Spotify playback diagnostics

- Replaced the generic Spotify connection failure notice with phase-aware provider diagnostics.
- Reports whether the failure occurred during Xvfb startup, Spotify launch, Spotify exit, or the Spicetify bridge connection.
- Includes the last background-provider detail and points directly to `~/.cache/hive/spotify/spotify-background.log` for deeper diagnosis.
- Exposes loopback bridge age and server state through `spotifyStatus()` so stale or never-connected providers are distinguishable.
- Keeps Spotify playback commands, playlist import, artwork, and provider architecture unchanged.
- Added regression coverage for diagnostic error reporting and bridge-age status.

# Build 96 — Spotify background provider diagnostics and X11 launch hardening

- Force the isolated Spotify process through the known-good X11/Ozone path on Wayland by clearing Wayland session variables and passing `--ozone-platform=x11 --disable-features=UseOzonePlatform`.
- Record the Spotify background provider lifecycle in `~/.cache/hive/spotify-background-status.json`, including Xvfb allocation, Spotify launch/running state, executable, display, and exit/failure phase.
- Expose the helper phase through Hive's existing `spotifyStatus()` IPC so a provider startup failure reports where the background launch stopped instead of only showing the generic connection message.
- Extend startup diagnostics to record the first command-poll and state POST received by the loopback bridge, including the browser origin but never the bridge token.
- Keep the existing Spotify/Spicetify transport, command queue, playlist context, artwork, and local playback architecture unchanged.
- Extend the Spotify background regression suite for X11 hardening and lifecycle diagnostics.

# Build 95 — Spotify background display allocation recovery

- Replaced the fixed `:90`–`:119` Xvfb display scan with Xvfb's `-displayfd` allocator, so Hive gets a genuinely unused display without depending on stale X lock files.
- Wait for Xvfb to report its display number before launching Spotify, instead of treating a still-starting Xvfb process as ready.
- Keep the existing isolated-display Spotify transport and visible-client protection unchanged.
- Added regression coverage for fresh X display allocation and stale-lock recovery.

# Build 90 — exact artwork-accent Hive logo tint

- Fixed the top-left Hive brand mark drifting away from the dynamic player/UI accent on colorful artwork.
- Colorful logo rendering now uses the exact current `--accent` RGB as its tint while preserving the glass logo's luminance, highlights, and transparency.
- Kept the existing neutral grayscale treatment for overwhelmingly dark/light artwork.
- Removed reliance on a fixed source-hue offset for the colorful logo path, so album-to-album accent changes remain visually synchronized.
- Added regression coverage for exact accent-derived logo tinting.

# Build 81 — Glass Hive logo branding

- Replaced the legacy bee emoji in the top-left Hive button with the new high-resolution frosted-glass Hive hexagon.
- Added the transparent `resources/hive-logo-glass.png` brand asset so the glass hexagon is transparent outside its silhouette.
- Reused the same shared brand asset for the About dialog, Yearly Wrap branding, and Linux tray icon path.
- Kept the logo behind the existing preload bridge rather than exposing filesystem paths to the renderer.

## Build 79 — Settings, community themes, plugin API v2, and UI pass

- Debloated Settings by moving advanced custom CSS out of Appearance and into Community alongside shareable `.hive-theme` packs.
- Refined Navigation settings presentation and reduced visual density without removing existing navigation customization.
- Fixed the Light theme's browser color scheme and common dark-only controls/popups/surfaces.
- Formalized Hive Plugin API v2 with manifest versioning, permissions, persistent plugin settings, lifecycle hooks, playback/spectrum events, and Now Playing panel registration.
- Added an installable Spectrum Visualizer reference plugin with real GStreamer spectrum data and plugin settings.
- Documented the plugin standard for third-party developers.

## Build 78 — MPRIS session-bus recovery

- Hardened the existing MPRIS service against transient D-Bus session-bus disconnects: Hive now automatically re-registers `org.mpris.MediaPlayer2.Beehive` without restarting Music Presence or the player.
- MPRIS reconnects preserve the authoritative renderer playback state and republish metadata immediately after registration.
- MPRIS no longer queues behind a stale owner of the well-known service name; failed ownership is surfaced and retried cleanly.
- Added regression coverage for name ownership, disconnect recovery, and state preservation.


## Build 77 — MPRIS playback-state synchronization

- Fixed the shared playback-to-MPRIS synchronization boundary so GStreamer, Web Audio fallback, Spotify, and podcast playback all publish through the same renderer playback events.
- Added a bounded 500 ms MPRIS heartbeat while a track is playing so the exported position remains current even when a backend does not emit frequent `timeupdate` events.
- Preserved the existing MPRIS implementation and artwork behavior; this is a synchronization fix, not a replacement MPRIS path.
- Added regression tests covering playback-event synchronization and the heartbeat.
## Build 76 — Spotify seamless provider context

- Preserve Spotify playlist context through the Hive/Spicetify bridge so imported online playlists behave as continuous Spotify playback contexts.
- Feed Spotify context state back into Hive and synchronize shuffle/repeat when a Spotify track starts.
- Keep Build 75 MPRIS/Music Presence behavior unchanged.

## 1.0.0-pre-release-build75 — MPRIS local artwork compatibility quick fix

- Restored the known-good MPRIS behavior for local artwork: `mpris:artUrl` stays a `file://` URI.
- Kept the optional Hive artwork proxy available, but stopped substituting its localhost URL into MPRIS metadata. Music Presence remains the sole Discord Rich Presence publisher.
- Added a regression guard covering the local-artwork URI contract.


## Build 64 — Spotify XWayland window bootstrap

- Force the Linux Spotify client onto the X11/XWayland path with `--ozone-platform=x11` and `--disable-features=UseOzonePlatform`, matching the current Spotify Linux workaround for GNOME Wayland.
- Stop relying on Linux Spotify's unsupported `--minimized` flag as the primary window-control mechanism.
- Detect an already-running Spotify singleton before launching so Hive does not intentionally create another client instance.
- Replace the three fixed hide attempts with a bounded 8-second X11 window-control poll using optional `xdotool`/`wmctrl`.
- Clear `WAYLAND_DISPLAY` for the spawned Spotify process so the X11 launch cannot select the native Wayland backend.
- Add startup diagnostics for Spotify launch arguments, existing-process detection, and window-hide availability.
- No direct Spotify URI playback or dependency on a window-control utility was introduced; Spicetify remains the transport authority.
## Build 57 — custom CSS editor + album grid spacing restoration

- Added a persistent Custom theme CSS text box in Settings → Appearance so users can paste complete CSS directly into Hive. Remote HTTP(S) `@import` URLs are supported, including Catppuccin-style theme links.
- Added **Apply CSS** to save and immediately apply pasted CSS; the existing file loader and Remove CSS controls remain available.
- Preserved the raw pasted stylesheet for theme export so extracted remote `@import` URLs are not lost when exporting a Hive theme.
- Restored the established album-grid breathing room: the legacy fixed 178px layout now explicitly uses the original `26px 18px` gaps, and the responsive alternative no longer collapses album cards together.
- Kept the Legacy album art scaling semantics unchanged: checked = established fixed-size Hive layout; unchecked = responsive/grid sizing.

## Build 56 — navigation rich labels + playlist controls

- Fixed Info-based sidebar label styles being stored under `nav:*` keys that the sidebar renderer did not read. Preset styles now apply to the actual destination name.
- Kept rich HTML markup presentation-only: `<span class="hive-rainbow">Music</span>` renders visually as `Music`, with the styling applied rather than exposing the markup.
- Name-style changes now refresh both the left navigation label and its pinned top-bar tab immediately, while Save persists the change.
- Increased Rainbow label brightness/saturation and added a restrained glow so it reads clearly in both sidebar and top tabs.
- Hardened Playlist Explorer's Import / New playlist / Smart playlist controls with stable event delegation and explicit button types, preventing dynamic rerenders from stranding their handlers.
- Added error reporting around local playlist creation so an IPC/storage failure produces a Hive notice instead of a silent dead button.

## Build 53 — Tracks virtualization scroll stability

- Fixed a Chromium rendering edge case where the virtualized Tracks window could stop painting rows near the bottom of a search result.
- Removed `content-visibility:auto` from virtualized song rows; JS virtualization already limits the DOM to the visible/overscanned window, so the browser-level visibility heuristic was redundant and could conflict with the translated window.
- Removed paint containment from the virtual window while preserving row-level containment, keeping the virtual scroll geometry owned by the spacer + renderer window.

# Build 51 — Playlist Info naming themes and choice-control theming

- Playlist right-click **Info** is now the single rename/edit surface; the standalone Rename action was removed.
- Playlist Info now includes premade rich HTML naming themes: Plain, Glow, Pulse, Rainbow, and Bold, plus Custom HTML and live preview.
- Rich playlist labels persist independently from the plain playlist name and use Hive's existing sanitizer.
- Sidebar collection Info can rename eligible non-folder destinations using the same rich-label system.
- Native dropdown/select controls now use consistent Hive glass/accent styling, including themed option/optgroup colors and focus states.

## Build 50 — Spotify path persistence / non-interactive bridge setup

- Removed SpotX-Bash as a required Hive Spotify dependency. SpotX is an optional external Spotify patcher and no longer blocks or prompts during Hive installation/launch.
- When Hive finds a valid Spotify installation, it now persists the validated path to `~/.config/Hive/config.json` under `spotify.installPath`.
- Hive reuses the persisted path first and validates it before use; if Spotify moves, normal discovery can recover automatically.
- The discovered path is also written to Spicetify's `spotify_path` setting so Spicetify does not repeatedly rediscover the client.
- Removed the obsolete launcher-time SpotX repair loop so Spotify setup cannot produce a repeated confirmation prompt on launch.
- Kept Spotify/Spicetify failures non-fatal to the local Hive player.

## Build 49 — Playlist rich labels / context-menu cleanup
# Build 48 — navigation-driven top bar + UI consistency audit

- Removed the separate Pinned top bar configuration section from Navigation settings. Navigation layout is now the single source of truth.
- Every sidebar destination can be pinned/unpinned directly from its Navigation row with one pin control. Pinned destinations appear in the top bar in the same order as the sidebar.
- Migrated the legacy Music/Playlists/Podcasts top-tab identities to navigation-backed tabs, preserving saved tab state where possible.
- Top-bar navigation tabs no longer have an independent reorder model; their order follows Navigation layout. Independent + tabs remain supported after the pinned destinations.
- Clicking a pinned History/Favorites/Recently Added/etc. tab now opens that actual navigation destination instead of silently routing through the Music tab.
- Music remains the primary navigation destination and its top-tab label/icon follows the sidebar configuration, with album expansion allowed to provide contextual labeling.
- Completed a binary-control UI audit: all checkbox inputs share the same left/right switch treatment, including settings, playlist controls, smart-playlist controls, tag-editor controls, and dynamically-created Navigation visibility controls.
- Kept radio inputs as radios; only checkbox controls were normalized to the switch language.
- Removed stale top-tab ordering code and legacy hidden top-tab configuration paths.

# Build 46 — sidebar-mirrored Music tab + Spotify self-heal

- Made the primary Music top tab mirror the left-sidebar Music destination instead of displaying the hard-coded `MUSIC` label.
- The Music top tab now follows the sidebar's current Music label and icon, including user customization.
- Preserved contextual tab labels: an expanded album can temporarily replace the base Music label while open.
- Added a bounded SpotX-Bash retry: when SpotX rejects Hive's detected Spotify path via `-P`, Hive retries once using SpotX's own auto-detection.
- SpotX failures no longer make the core Hive launcher fatal; a repair marker is recorded and the launcher retries Spotify setup on a later launch.
- Kept the Spotify integration external to the core local playback path.

## Build 43 — Yearly Wrap artwork + social sharing

- Added representative album artwork to the Yearly Wrap intro, top track, top artist, and top-album views.
- Added 1080×1080 share-card rendering for the current Wrap slide.
- Added Share, Copy image, and Save image controls. Share uses the native file-share mechanism when supported; Linux-safe clipboard/save fallbacks remain available when it is not.
- Added a persistent `Hive icon` toggle so the user can remove the Hive mark from both the Wrap presentation and generated share cards.
- Share generation stays local; Hive does not upload Wrapped data or images to a Hive service.
- Added `docs/development/YEARLY-WRAP-SHARING-AUDIT-BUILD43.md`.

## Build 42 — visual playlist shuffle + transport shuffle fix

- `Shuffle automatically when opened` now randomizes the collection/list display order only; it never toggles or mutates the bottom-player Shuffle state.
- Playing an automatically shuffled collection with player Shuffle off follows the visible randomized order. Turning player Shuffle on then shuffles that already-randomized queue again.
- Visual shuffle order is cached per playlist/sidebar context so filtering does not reshuffle the visible list on every search keystroke. Re-entering a collection starts a fresh visual permutation.
- Fixed Playlist Info `Saved` status positioning so the status sits immediately to the left of `Save changes` instead of being clipped against the modal edge.
- Hardened the player Shuffle button against stale MPRIS clients writing an old inverse state immediately after a local click, preventing the first-click-appears-ignored behavior.

## Build 41 — Yearly Wrap window and exact listening-time tracking

- Reworked Yearly Wrap from an inline summary into a dedicated Hive BrowserWindow slideshow.
- Added Spotify-inspired full-screen presentation: intro, listening time, top track, top artists, top albums, monthly listening, and finale.
- Added real per-play listening events with actual active listening seconds and a 5-second minimum recording threshold, following the uploaded MusicBeeWrapped tracking model.
- Pauses are excluded from listening time; repeated plays are retained as separate listening events.
- Added `listening-events.json` as a separate durable source so the existing latest-per-track History view is not changed.
- Added an explicitly marked legacy-history estimate for users who have not yet accumulated exact Wrap events.
- Yearly Wrap reads real track duration/artwork from the library cache when legacy history is used instead of displaying a false `0 min`.
- Added native IPC for opening the Wrap window and retrieving yearly statistics.
- Kept the existing MusicBeeWrapped source as the design/behavior reference rather than copying its Windows/.NET host architecture.

# Build 40 — SpotX requirement + Favorites context/view synchronization

- Made SpotX-Bash a required part of the Hive Spotify integration when a Spotify desktop client is detected.
- Installer downloads the current SpotX-Bash script only from the official SpotX-Bash repository, saves it to a private temporary file, prints its SHA-256, and requires explicit user confirmation before execution. It never pipes remote content directly into a shell.
- SpotX runs before Hive's Spicetify bridge is applied, after the existing consented per-user Spotify ACL step.
- Successful Hive-managed SpotX setup is recorded under the user's Hive config state so repeat launches do not re-run the patcher unnecessarily.
- Normalized the detected Spotify installation path so output/arguments no longer show `/opt/spotify//Apps`.
- Fixed Music-browser context synchronization: Favorites/History/Recently Added/Top Played/Now Playing now highlight the corresponding left-sidebar destination when their music tab state is restored.
- Fixed Tracks/Albums/Artists toolbar state for special collections so the selected button always matches the rendered view. This prevents Favorites from showing Tracks content while the Albums button remains highlighted.
- Added development audit: `docs/development/SPOTX-FAVORITES-AUDIT-BUILD40.md`.

# Build 39 — Consent-based Spotify permissions

- Installer now offers an explicit `[y/N]` consent prompt before changing Spotify filesystem permissions.
- Uses per-user ACLs via `sudo setfacl` when available instead of world-writable `chmod a+wr`.
- Verifies write access after the permission change before allowing Spicetify apply to continue.
- Declining the change leaves Hive installation/launch unaffected.
- Hive itself is never launched as root.

## Build 38 — Security audit and hardening

- Removed installer-side remote shell execution for Spicetify and SpotX.
- Spotify permissions now prefer per-user ACLs rather than world-writable directories.
- Added authenticated per-user token to the loopback Spotify bridge.
- Protected Hive JSON configuration/state files with mode 0600 after atomic writes.
- Added `docs/development/SECURITY-AUDIT-BUILD38.md`.

# Build 37 — Tray, Podcast Quick Access, Yearly Wrap & UI Pass

- Added Linux system tray integration using Electron Tray / StatusNotifierItem where supported.
- Tray controls: current track, Play/Pause, Previous, Next, Show Hive, Quit Hive.
- Added persistent podcast show favorites and a Podcasts Quick Access home section.
- Added Yearly Wrap as a sidebar destination with current-year listening statistics and calm retrospective UI.
- Added sanitized rich labels for sidebar and top tabs, including `hive-pulse`, `hive-rainbow`, and `hive-glow`.
- Added Spotify playback diagnostics to the session log, including URI/artwork/duration and bridge command results.
- Performed a second Settings visual pass so Settings tabs and controls follow the main Hive viewer theme.
- Validation: syntax/checks PASS; npm tests 19/20 due the existing missing `node_modules/music-metadata/lib/index.js` environment failure.

# Build 36 — Navigation / playlist customization and session persistence

- Extended Playlist Info with per-list automatic Shuffle-on-entry and static text-symbol icon selection.
- Added the same list-info controls to left-sidebar collections and configured library folders.
- Added icon spacing and a monochrome text folder glyph for Computer libraries.
- Replaced Music Explorer with `+ Library` directly under the Computer folder list.
- Made the Now Playing sidebar destination a real queue-ordered browser view.
- Persisted navigation/tab placement and browser state into durable Hive config so reinstalls using the same user data retain the last layout/location.
- Kept Settings tabs as flat, always-visible wrapping buttons.

## Build 35 — Queue Reorder Playback Stability

- Queue reordering no longer stops/reloads the currently playing GStreamer track.
- The persistent GStreamer playbin keeps the active stream and clock untouched; queue edits only refresh the pending `NEXT` URI.
- Updated the GStreamer track index after queue movement without changing transport position.
- Web Audio queue moves preserve the currently audible source and reconcile only the future gapless successor when necessary.
- Added `docs/development/QUEUE-REORDER-PLAYBACK-AUDIT-BUILD35.md`.

# Build 34 — Tracks column UX + Settings tab cleanup

- Made Music → Tracks column boundary/resizer lines visible by default instead of only during hover/resize.
- Kept Fit columns to Music viewer as the default and hard layout invariant; fitted widths continue to account for padding and grid gaps.
- Hardened header-column drag/reorder so the whole column section can be dragged while the nested sort button remains a click-only control.
- Column order remains keyed by stable column identity, so row values, sorting, filtering metadata, widths, and saved preferences stay attached to the correct column after repositioning.
- Changed Settings tabs to a flat, always-visible button grid with no tab-strip scrolling; narrow windows wrap to a second row instead.
- Added `docs/development/TRACKS-COLUMN-UX-AUDIT-BUILD34.md`.

# Build 33 — Navigation settings cleanup

- Replaced the Navigation settings drag-and-resize editor with a conventional, readable list.
- Sidebar destinations can be repositioned with explicit Up/Down controls.
- Built-in sidebar destinations remain renameable and hideable; visual dividers remain supported.
- Removed editable sidebar row sizing from Navigation settings and restored a consistent standard sidebar item height.
- Top built-in tabs now use the same explicit Up/Down ordering controls.
- Removed the Beta Lab tab and its Settings panel from the user-facing Settings interface.
- Removed the old Beta Lab Settings host initialization and stale navigation-editor resize styling.
- Existing Beta Lab implementation code remains isolated in the source for engineering diagnostics, but is no longer exposed as a Settings tab.

# Build 32 — Spotify installer auto-discovery + artwork identity hardening

- Replaced unsafe `spicetify path spotify` parsing with validated automatic Spotify installation discovery.
- Detects Spicetify `spotify_path`, native Arch locations, spotify-launcher, Flatpak, and targeted user application paths.
- Rejects ANSI/control/help text before a candidate can become a filesystem path or `chmod` target.
- Reports the actual Spotify path, Apps path, ownership, `xpui.spa` presence, and write access.
- Permission commands are generated only from a positively validated Spotify path.
- Preserved normal-user execution; no Spicetify `sudo` execution.
- Spotify player state artwork is now URI-gated so delayed state events cannot overwrite another track's cover.
- Spotify imports preserve album URI/album artist metadata; album grouping uses the canonical album URI when available.
- See `docs/development/BUGFIX-AUDIT-BUILD32.md`.

## Build 31 — Spotify artwork consistency audit

- Audited Spotify artwork through Albums, Tracks, queue, Now Playing/playbar, expanded album view, Artists, History, playlist import, and MPRIS.
- Unified album grouping and song-row thumbnails around `visualCoverForTrack()`, preventing `artworkUrl` from being lost when legacy `cover` is empty.
- Preserved queue and Now Playing external-artwork behavior.
- Persisted Spotify external artwork/source metadata in play history.
- Added `docs/development/SPOTIFY-ARTWORK-CONSISTENCY-AUDIT-BUILD31.md`.

# Build 30 — Spotify artwork fix

- Fixed Spotify artwork arriving as `spotify:image:<id>` internal provider URIs that Hive could not render through its local `mbcover://` resolver.
- Spicetify bridge now normalizes Spotify image metadata to `https://i.scdn.co/image/<id>` and exposes an explicit `artworkUrl`.
- Renderer accepts both modern Spotify CDN URLs and older persisted `spotify:image:` values.
- Spotify playback state, queue persistence, playlist imports, Now Playing, and queue artwork now preserve the external artwork source.
- Added `docs/development/SPOTIFY-ARTWORK-AUDIT-BUILD30.md`.

## Build 29 — Tracks column fit correction

- Fixed the final clamp that caused Fit columns to Music viewer to overflow again after calculating the correct width.
- Fit mode now treats calculated widths as authoritative.
- Added grid-child shrink/ellipsis guards so long metadata cannot establish intrinsic overflow.
- Added a focused column-fit audit under `docs/development/`.

# Build 28 — Tracks/UI optimization pass

- Delegated virtualized song-row interactions to the persistent song table to remove per-row listener churn.
- Added `content-visibility: auto` to song rows while preserving existing containment and virtualization.
- Reduced Love-state synchronization from repeated full album/artist traversals to canonical-map updates plus genuinely separate runtime objects.
- Kept album virtualization separate because album expansion/reflow has an explicit DOM-sibling dependency.

# Build 27 — Tracks/Favorites performance + column-fit correction

- Audited why the main Music Tracks view felt faster than Favorites: Music was virtualized while Favorites rendered every track row into the DOM.
- Favorites and other special track collections now share the virtualized Tracks renderer, keeping DOM work proportional to the visible viewport instead of collection size.
- Corrected Fit columns to Music viewer so grid tracks account for row/header padding and inter-column gaps; the fitted grid now terminates at the actual viewer edge instead of spilling into the right-side panel.
- Tightened song-table width invariants (`width:100%`, `min-width:0`, border-box).
- Rebound the column ResizeObserver when switching between independent Music tabs.
- Added `docs/development/TRACKS-FAVORITES-COLUMNS-AUDIT-BUILD27.md` with the audit findings and validation status.

# Build 26 — End-game development architecture

- Added `docs/ai/HIVE-ENDGAME-DEVELOPMENT-PROMPT.md` as the persistent, portable AI engineering charter for Hive 1.0 pre-release development.
- Preserved the previous AI development notes unchanged at `docs/ai/AI-DEVELOPMENT-LEGACY.md` for historical/regression reference.
- Reduced the root `AI-DEVELOPMENT.md` to a bootstrap pointer so a new AI session can locate the persistent prompt immediately.
- Standardized future development ZIP artifacts as `Hive-1.0.0-pre-release-buildNN-purpose.zip`.

# Build 25 — Resizable Sidebar Navigation

- Added persistent vertical resize handles to the Settings → Navigation → sidebar editor.
- Drag the handle beneath a sidebar destination up/down to change that destination's height.
- The corresponding left sidebar item immediately reflects the saved size.
- Sidebar sizes persist in the existing navigation preference object and remain backward-compatible with Build 24 preferences.
- Sizes are constrained to a practical 32–240px range.
- Resizing does not alter navigation order, visibility, labels, dividers, playback, or library data.

# Build 24 — Custom sidebar labels & visual dividers

- Added user-defined **visual dividers** to the left navigation. Dividers can be dragged into any position and optionally given a small section label.
- Added **Rename** controls for every built-in left navigation destination, with the chosen labels persisted locally.
- Added Rename/Remove actions for custom dividers and Rename actions in the sidebar context menu.
- Kept the underlying navigation IDs stable, so renaming does not break Music, Favorites, Playlists, Podcasts, History, or other destination behavior.
- Extended the navigation preference format with backward-compatible `labels` and `custom` entries; existing Build 23 navigation preferences continue to load.
- Visual dividers are non-interactive and do not affect playback, active destination state, or scan behavior.

## Build 22 — Internal layout + session diagnostics
## Build 23 — Spotify permission diagnostics + cleaner live console

- Spicetify setup now detects a root-owned/non-writable Spotify installation such as `/opt/spotify` before attempting to patch it.
- The installer no longer reports “open Spotify once” for a filesystem permission failure.
- The installer prints the exact one-time `chmod` commands recommended by Spicetify for the detected Spotify path, then leaves Hive running as the normal user.
- Spicetify is never invoked through `sudo`; current Spicetify explicitly warns against running as root because it can leave Spotify-owned files inaccessible to the normal user.
- Spicetify permission/apply failures are classified separately from missing-backup failures.
- Renderer INFO/DEBUG console messages remain fully captured in the per-session TXT log but are no longer echoed into the live terminal. Renderer warnings/errors remain visible.
- Repetitive cover-cache startup messages are retained in the session log but removed from terminal output.
- The installer filters known Fontconfig/VSync noise from the terminal while retaining the raw launch stream in `logs/scan-live.log`.


- Reorganized application source into `app/main`, `app/renderer`, `app/workers`, and `app/native`.
- Moved bundled Python helper code into `resources/python`.
- Centralized runtime path resolution so the project can be moved as a folder without hard-coded source locations.
- Added a portable `logs/` directory with one complete TXT session log per Hive launch.
- Session logs retain main-process, renderer-console, preload, startup-debug, and crash information together so a single boot/crash can be sent for diagnosis.
- Automatically retain the newest 20 session logs and remove older sessions.
- Reduced terminal diagnostic noise while preserving the full diagnostic stream in session files and Settings > Logs.
- Kept the existing scan log as an auxiliary live scan diagnostic.

# Build 21 — Settings / Spotify repair

- Fixed a renderer initialization crash in `renderNavigationEditors()`: each editor row now receives its actual host element, preventing `appendChild` on `undefined` and allowing Settings, appearance defaults, modal controls, and the rest of renderer initialization to run.
- Restored the frosted Now Playing bar as a true default at the DOM level, not only through post-startup JavaScript.
- Added an explicit **Save settings** action and fixed Settings footer layout so the save/close controls remain visible while the settings body scrolls. Existing per-control persistence remains intact.
- Isolated the Beta Lab settings surface from the top-level tab workspace sizing/overflow rules so it cannot paint across the Settings tab strip.
- Hardened Spotify playlist durations against both milliseconds and seconds payloads; millisecond values are normalized before entering Hive's queue/runtime calculations.
- Spotify playback no longer falsely reports a track as playing before the Spicetify bridge acknowledges the command path. If the bridge is unavailable, Hive leaves the player paused and reports the repair path.
- Installer now detects the specific Spicetify “haven't backed up” failure and performs the required `spicetify backup apply --no-restart` fallback instead of leaving the Hive extension unapplied.

## Build 20 — Bug-fix / integration audit

- Hardened Hive brand menu and Settings opening against late renderer initialization failures; menu/modal infrastructure is now bound immediately after DOM discovery.
- Hardened modal close controls with capture-phase delegation and complete `data-close` coverage.
- Kept nested Hive popup stacking above parent dialogs.
- Fixed Spotify desktop XPUI CORS compatibility for `xpui.app.spotify.com` while retaining `open.spotify.com` support and loopback-only access.
- Added throttled Spotify bridge diagnostics for unavailable loopback connections.
- Installer now auto-discovers common Linux Spotify `prefs` paths and configures Spicetify `prefs_path`.
- Audited Smart Playlist source/rule/result wiring against its evaluator.


## Build 19 — Smart playlist & modal UX fix

- Fixed the Hive brand menu closing immediately when its inner text/caret was clicked, restoring reliable access to Settings and About.
- Reworked modal close handling with delegated close buttons and Escape-to-close for the topmost Hive-rendered modal.
- Redesigned Create Smart Playlist into a clearer three-step flow: source, matching rules, and result selection, with advanced options tucked away.
- Removed the duplicate smart-playlist rules container that caused the previous editor to behave unpredictably.
- Replaced the source radio "knobs" with selectable modern cards and kept on/off settings as consistent left-to-right switches.
- Preserved the existing smart-playlist save model and all existing rule/result options.
## 1.0.0-rc.1 — Runtime hardening / Build 16
- Added a shared modal stacking manager so nested Hive popups always open above the popup that spawned them.
- Hardened crash logging against closed stderr pipes and recursive EPIPE failures.
- Added bounded GStreamer helper recovery for unexpected native-process exits, with renderer notification and no restart during normal shutdown.
- Added bounded renderer crash recovery/reload with diagnostic process metrics.
- Preserved the existing GStreamer transport, playback persistence, and optional-integration fail-soft architecture.

## 1.0.0-rc.1 — Build 15 runtime/UI hardening
- Made the left navigation user-configurable: drag destinations into any order and hide unused destinations from Settings → Navigation.
- Made built-in top tabs user-configurable: reorder them and show/hide Podcasts or Playlists from Settings → Navigation; Music remains the required primary tab.
- Made Settings a bounded, scrollable surface so long settings pages remain reachable at smaller window sizes. Added dedicated Appearance and Navigation settings organization.
- Defaulted the Tracks view to fit visible columns to the Music viewer width and removed forced max-content sizing when the fitted layout is active, keeping the right edge inside the viewer.
- Added animated insertion-gap indicators to navigation drag targets and a consistent surface-entry transition, with reduced-motion support.
- Removed the duplicate large “Playlists” heading above the playlist list in favor of a compact native-Hive header.
- Hardened artwork memory usage: the session cover cache no longer retains DOM Image objects, preventing decoded artwork surfaces from accumulating into hundreds of megabytes during browsing.

## Build 12 — Podcast integration verification

### 1.0.0-rc.1 — community integration pass (Build 13)
- Confirmed and preserved the existing Linux MPRIS implementation rather than adding a duplicate media-control path; MPRIS metadata now also represents Spotify and podcast queue items using stable virtual identities and remote artwork when available.
- Added optional ListenBrainz and Last.fm scrobbling with configurable percentage/time thresholds, Last.fm browser authorization, and opt-in podcast scrobbling.
- Added shareable `.hive-theme` JSON theme packs plus documented stable Hive CSS variables.
- Added a trusted-local renderer extension API with `manifest.json`, optional `plugin.js`, and optional `style.css`, plus Settings → Community installation/reload controls.
- Kept artwork/lyrics provider work isolated from playback and scanner transport.

- Fixed podcast episode expansion: the RSS episode container is now rendered directly instead of searching for a nested episode list that did not exist.
- Preserved the Podcasts tab DOM when switching between top-level tabs so search results and expanded episode lists remain usable instead of resetting like a separate application.
- Improved RSS feed artwork parsing for the common `<image><url>...</url></image>` feed format.


## 1.0.0-rc.1 — Podcast source pass

- Added a native Podcasts tab with public podcast search and collapsible RSS episode lists.
- Podcast episodes can be played or queued and can coexist in the same queue as local and Spotify tracks.
- Added remote podcast playback through the existing player surface without routing podcast audio through GStreamer.
- Persisted virtual Spotify/podcast queue entries across sessions.

## 2026-09-12 — Now Playing cover decode synchronization
- Prevented the previous track's large Now Playing/playbar artwork bitmap from remaining visible while the next cover decodes.
- New artwork is hidden/revealed through the existing Now Playing generation guard so stale image decodes cannot repaint a newer track.
- Preserved the existing artwork rotation, automatic-cover, playback, Love, and front/back role-swap behavior.
## 1.0.0-rc.1 — artwork front/back role swap fix


### Performance audit follow-up
- Normal unchanged startup reconciliation now returns a bounded delta to the renderer instead of re-sending the full ~30k-track library over IPC.
- A clean incremental scan skips rewriting the unchanged large library cache, avoiding redundant serialization/gzip work and the associated heap spike.

- Fixed Artwork-tab Cover (Front) / Cover (Back) type swaps so rapid changes are serialized and each edit follows the same embedded picture by content hash.
- Fixed player and album artwork selection so an explicit Cover (Front) always wins over stale cached artwork ordering.

## 1.0.0-rc.1 — immediate Now Playing synchronization

- Fixed an asynchronous Now Playing race where a slower previous-track Love/artwork update could repaint the player after the next song was already current.
- Track identity, metadata, cover, and backdrop now paint immediately on track change; awaited verification is generation-guarded.

## 1.0.0-rc.1 — lyrics / artwork interaction polish

- Restored a visible active-line highlight for synchronised lyrics.
- Hardened “Show highlighted lyric” so it recomputes the current timed line before scrolling, including immediately after loading or while paused.
- Made the Artwork tab artwork thumbnails reliably expose the same picture-specific right-click menu as the Tags artwork preview.
- Constrained the scan activity sheen to the filled progress region using an in-fill background animation.

## 1.0.0-rc.1 — track-list numbering / scan progress polish

- Kept the scan activity sheen clipped to the loaded progress fill instead of animating across the entire bar.
- Added a sortable `#` position column to Tracks lists; playlist Tracks default to newest-added as #1 while preserving playlist playback order.

## 1.0.0-rc.1 — Love multi-value fix

- Fixed embedded ID3/WAV Love detection when a single Love field contains multiple
  values such as `U` and `L`; any recognized Loved value now wins.
- Kept this fix limited to the scanner/Love readers and WAV regression coverage.
- Preserved the known-good Electron 33 Linux windowing, renderer, library search,
  artwork, queue, and Discord Rich Presence implementation from the pre-Love-fix
  baseline.

## 1.0.0-rc.1 — Electron 33 Linux foundation

- Pinned Electron to 33.2.0 to restore the known-good Linux desktop/windowing foundation.
- Restored the Linux X11/Ozone compatibility path used by the known-good 0.9 foundation.
- Fixed the Linux installer so Electron downloads resolve `@electron/get` from Electron's nested dependency when npm does not hoist it (the expected layout when lifecycle scripts are skipped).


- Fixed the Electron launch path after `--ignore-scripts` installs by recreating the missing `node_modules/.bin/electron` shim.
## 1.0.0-rc.1 — Linux native title-bar integration

## 1.0.0-rc.1 — Linux desktop compatibility rollback

- Pinned Electron back to **33.2.0**, the known-good Linux desktop foundation used before the Electron 44 windowing regression.
- Restored the 0.9-era Linux X11/Ozone switches for GNOME/XWayland native window-manager decoration.
- Kept the current 1.0 scanner, playback, metadata/artwork, Discord, and MPRIS implementation intact; this rollback is limited to Electron/platform compatibility.
- Rejected WCO/custom title-bar approaches for the main Hive window.

- Linux window chrome: preserved the proven 0.9 X11 window path (`ozone-platform=x11` with `UseOzonePlatform` disabled) under Electron 44, with the normal native frame and system theme; WCO remains disabled for the main window.

- Restored the proven 0.9 Linux X11/Ozone window-decoration path so the desktop/window manager can apply its native title-bar theme.
- Kept Hive's renderer navigation top bar as a separate 46px application bar below the native Linux title bar.
- Rejected the Electron 44 Window Controls Overlay approach after desktop verification showed it removed the native themed title bar on the target Linux environment.

## 0.9.0-beta.9 — scanner hardening / pathological-file recovery

- Hardened MP3/WAV MusicBee Love scanning for UTF-16/UTF-16BE and multiple embedded Love aliases.
- Fixed WAV scanning so multiple RIFF ID3 chunks are accumulated instead of returning after the first chunk.
- Failed metadata parses now preserve the previous cached record without falsely marking metadata/Love as successfully hydrated.
- Excluded legacy `.beehive-musicbee-*` transactional copies from library discovery and changed new MusicBee replacement temps to `.tmp` so they cannot be mistaken for audio.
- Retained the per-file worker timeout as a final containment guard against a pathological file stranding the full scan.

## 0.9.0-beta.8 — scan activity indicator / first-file hang guard

- Fixed a first-file scan failure in the main-process enrichment path where the metadata scan version referenced an undefined variable.
- Contained per-track enrichment errors so one malformed result cannot strand the scanner worker pool.
- Added a continuously animated scan activity sheen so background work remains visibly active even when the determinate file count is temporarily unchanged.
- Corrected renderer handling of discovery/stat progress flags so preparation work is shown with the appropriate phase instead of looking like an idle `0 / N` scan.

## 0.9.0-beta.7 — first-scan hang / progressive IPC fix

- Fixed a large-library first-scan stall caused by sending the full scanner record, including heavy native-tag/lyrics data, over Electron IPC for every track.
- Progressive scan events now carry only the fields needed to update the live library/Favorites view; the authoritative final scan result remains complete.
- Fixed progressive renderer updates to use the library path index instead of an O(n) search per scanned file.
- Added persistent regression guidance for compact scan IPC and 30k+ renderer performance.

# CHANGELOG

## 0.9.0-beta.6
- Added a one-time true cold-start library cache reset migration.
- Added a Settings option to request the same reset on the next launch.
- Fixed scan progress handling so discovery progress is rendered from the actual scan phase.
- Preserved music files, folders, playlists, playback state, and configuration during cache resets.

## 0.9.0-beta.2

- Expanded the library scanner's recognized audio/container extensions to match the tag-census coverage.
- Added a native-tag inventory to scanned library records so arbitrary native fields, TXXX descriptions, and multi-valued tags are retained for future tag-editor work.
- Added a one-time metadata scan-version migration so existing cached tracks are reparsed and learn the expanded native-tag inventory.
- Streamed successful scan records into the renderer so Favorites can populate progressively as embedded Love tags are recognized.


## 0.9.0-beta.2 — Favorites Love scanner correction

- Fixed the full-library scanner path so MPEG-4/M4A MusicBee/iTunes freeform `LOVERATING=L` tags are read directly from the container instead of depending on the metadata library's native-tag representation.
- Fixed WAV MusicBee Love scanning to use the same accepted Love-field aliases as the authoritative reader.
- Hardened generic native-tag scanning to recognize Love fields exposed in an identifier suffix and array-valued metadata.
- This specifically prevents a valid embedded Love tag from being rescanned as `loved:false` and then cached as successfully hydrated.

## 0.9.0-beta.2 — Favorites Love compatibility fix

- Fixed Favorites hydration so MusicBee/iTunes Love field spellings including `LOVERATING` and `MUSICBEE/LOVE RATING` are recognized during cold-boot/library scanning.
- Preserved the existing Love value compatibility set (`L`, `Y`, `YES`, `TRUE`, `1`, `LOVE`, `LOVED`, `FAVORITE`, `FAVOURITE`).
- Beehive continues to write the canonical `LOVE RATING=L` representation.

# Changelog

## 1.0.0-rc.1 — Build 11
- Added Settings → General custom theme CSS loading/removal.
- User CSS is stored locally, capped at 1 MB, and applied without executing JavaScript.


## 0.9.0-beta.2 — Discord Presence / Settings Polish

- Kept Discord Rich Presence visible when the current track is paused instead of clearing the activity.
- Paused presence removes playback timestamps while retaining the track, artist/album state, and activity.
- Hardened Discord presence synchronization so failed pause/resume updates are retried rather than being marked as already synchronized.
- Added the usable Settings organization for General, Library, Statistics, and Discord controls.
- Added embedded P_count import and additive play-count embedding controls.

> This remains a beta designation, not a claim that Hive is already production-ready.

## 0.9.0-beta.1 — Professional Beta Track

- Rebranded the user-facing music player to **Hive**.
- Kept `BeehiveMusicBrainz` as the project/repository and legacy internal identity where compatibility depends on it.
- Adopted Semantic Versioning for the professional release track.
- Established `0.9.0-beta.1` as the current near-1.0 beta-hardening baseline.
- Documented the distinction between product branding, internal compatibility names, and release readiness.

> This is a beta designation, not a claim that Hive is already production-ready.

## 0.9.0-beta.2 — library-scan Love reconciliation

- Made embedded Love/Favorites part of the normal library reconciliation path.
- Library fingerprints now include filesystem ctime alongside mtime and size so
  typical external metadata rewrites are recognized as changed files.
- Added a Love scan compatibility version so caches created by older Love readers
  are repaired during the next normal scan instead of depending on a separate
  Favorites refresh.
- Unchanged records with stale Love compatibility are reconciled through the
  authoritative on-disk Love reader with bounded concurrency.
- Failed Love reads preserve the previous cache state and remain eligible for a
  later retry.
- The manual Favorites refresh remains available for explicit full verification,
  but it is no longer required for ordinary library metadata synchronization.

## 0.9.0-beta.2 — scan progress visibility

- Fixed the library scan UI appearing stuck at `0 / N` while the filesystem walk and initial stat phase were still running.
- The scan now reports live file-discovery progress during recursive enumeration and live stat progress before metadata parsing begins.
- Expanded the scanner-worker's format extension set to stay aligned with the main library walker and tag-census coverage.
## 1.0.0-rc.1 — release-candidate reliability foundation

- Added a lockfile, reproducible install path, Node regression tests, and static
  validation scripts.
- Unified WAV RIFF/ID3 Love and rating reads across scanner and main/metadata
  processes, including all valid ID3 chunks and UTF-16 compatibility.
- Updated Electron, music-metadata, and electron-builder to audit-remediated
  release lines; documented the remaining unresolved optional MPRIS dependency chain.
- Added reproducible Linux AppImage/DEB metadata, desktop integration naming, and
  package/lockfile version consistency checks.
- Added the missing release, architecture, testing, security, development, and
  contributor documentation.


## 1.0.0-rc.1 — responsive song-list column sizing

- Added **Fit columns to screen** to the song-table header context menu alongside Reset column widths.
- Fit mode scales the currently visible columns proportionally to the available table width and keeps them synchronized with window/table resizing.
- If the available width is smaller than the combined minimum column widths, Hive keeps columns at usable minimums and allows horizontal scrolling instead of crushing the fields.
- Manually resizing a column exits fit mode so explicit user sizing remains authoritative.
- Reordered the header context menu so **Reset column widths** sits directly above **Automatically fit columns to screen**.
- Throttled live column dragging and viewport-fit recalculation through `requestAnimationFrame`; visible Tracks rows remain virtualized during resizing instead of synchronously relaying layout work on every pointer event.
- Added CSS layout/paint containment around the virtual song-row window and individual rows to keep column resizing localized to the virtualized table.
- Legacy saved column layouts now migrate the `#` position column back to the left edge so automatic fitting keeps Plays and the other visible columns correctly proportioned.

## 1.0.0-rc.1 — MusicBee-style tag editor foundation

- Polished the Edit Track / Edit Album modal around real editor responsibilities instead of placeholder-style panels.
- Properties now distinguishes track information from album aggregates, including duration, size, formats, location, Love state, rating, and library playback statistics.
- Tags remains the first/default editing page and preserves safe `Multiple Values` multi-file semantics.
- Replaced the arbitrary Tags (2) custom-field wall with a native metadata inventory that reads format-specific fields from disk and preserves untouched metadata.
- Added ReplayGain track/album gain and peak fields plus R128 track gain using recognizable metadata names.
- Native MP3 text frame edits now write recognized frame IDs as real ID3 frames; TXXX descriptions remain distinct.
- Added per-track playback behavior for excluded tracks, shuffle sequence preservation, and optional per-track remembered playback position.
- Extended the single GStreamer playback pipeline to honor editor start/end trim points while retaining the existing transport ramp and avoiding gapless handoff for trimmed tracks.
- Added a regression test for native ID3 frame preservation.

## 1.0.0-rc.1 — bulk artwork memory-pressure hardening
- Reduced Electron main-process memory pressure during multi-file artwork edits by keeping background artwork IPC metadata-only.
- Added hash-only artwork verification and metadata-only artwork targeting so large embedded cover images are not repeatedly serialized as base64 across the main/tag-helper boundary.
- Hardened crash diagnostics against recursive `EPIPE` handling when the diagnostic stderr stream closes.

## 1.0.0-rc.1 — queue artwork rotation
- The currently playing 30x30 queue thumbnail now rotates through the track's embedded artwork on the same four-second cadence as the large Now Playing artwork.
- Queue thumbnail rotation is isolated from the large-cover rotator so the small queue image remains fast and does not wait on large artwork decoding.
- The current queue thumbnail is eager-loaded with async decoding; other virtualized queue thumbnails remain lazy-loaded.

## Build 55 — legacy album scaling semantic correction

- Restored the established fixed-size 178px album/artist artwork layout as Hive's natural default.
- `Legacy album art scaling` is now a real Settings toggle: checked uses the fixed legacy layout; unchecked opts into the newer responsive grid scaling.
- Added a one-time preference migration for the inverted Build 54 semantics so existing users keep their current visible layout while the setting meaning is corrected.
- Preserved both existing scaling implementations; this change only corrects which mode is the default and which side of the toggle they represent.

- Preserved the existing year-divider and year-section layout rather than applying scaling rules to the section containers themselves.


### 1.0.0-rc.1 — main UI scrollbar / bottom playbar edge
- Increased the native WebKit scrollbar width/height from 8px to 12px for better visibility.
- Made the bottom playbar flush with the window bottom and square on its bottom corners while retaining the rounded top corners.

### 1.0.0-rc.1 — rapid play multi-playback race fix
- Fixed a race where spamming album/track playback commands could leave an older
  asynchronous load falling through to Web Audio after a newer GStreamer request
  had already started, allowing more than one song to be audible at once.
- Added monotonic playback-load request cancellation across GStreamer and fallback
  playback paths so only the newest user playback command can start transport.
- Preserved the single GStreamer pipeline and 10 ms transport ramp.

### 1.0.0-rc.1 — remove bottom playbar glass lip
- Removed the frosted glass background, border, and rounded surface from the bottom playback bar while keeping the playback controls in place.
- This leaves the main viewer visually unobstructed at the bottom and makes the enlarged scrollbar easier to see.

### 1.0.0-rc.1 — shuffle first-click UI responsiveness
- Shuffle now paints its on/off state immediately before queue rebuilding and session persistence.
- Removes the misleading first-click delay on large queues without changing shuffle ordering or playback transport.

### 1.0.0-rc.1 — lyrics context actions / expansion reflow
- Added Lyrics-box right-click actions to clear searched lyrics, delete embedded lyrics, and rerun online lyric search.
- Added read-back verification for lyrics metadata writes.
- Made album inline expansions participate in normal grid flow and re-anchor after viewport reflow, keeping cards populated above the expansion and keeping the expansion below the expanded album when the right Now Playing panel is resized.


### 1.0.0-rc.1 — library cover cache / scrollbar stress optimization
- Replaced the old 150-entry artwork warm cache with a long-lived per-session cache
  for local library cover resources.
- Unique library covers are warmed after the album model is painted in tiny idle
  batches, while visible artwork still uses native lazy loading.
- Added `./run.sh --scroll-debug` diagnostics for manual rapid-scroll stress testing,
  including frame timing and cache state.

### 1.0.0-rc.1 — large-library scrollbar thumb visibility
- Added a 72px minimum vertical native scrollbar thumb so very large libraries retain a practical grab target instead of collapsing into an almost circular dot.
- Kept the existing 14px scrollbar width and inset/breathing-room treatment.

### 1.0.0-rc.1 — main viewer frame and scrollbar polish
- Removed the rounded bottom clipping from the main album viewer so the viewport
  no longer reads as a rounded-square cutout above the playback bar.
- Added visual breathing room around native scrollbars and kept the larger scrollbar
  treatment for visibility.
- Restored the frosted Now Playing bar as an explicit Settings option (enabled by
  default), independent of the Colored Now Playing background option.

### 1.0.0-rc.1 — Discord Rich Presence activity type setting
- Restored the stable default Discord activity type to `Playing` (type 0), keeping Hive in Discord's game/Playing activity area.
- Added a persistent Discord Settings activity-type selector for `Playing` or `Listening`.
- The activity type is now user-controlled and cannot silently flip during playback or other Discord setting changes.

### 1.0.0-rc.1 — Discord settings save/restart UX
- Added a clear restart prompt after Discord settings are saved.
- Made the Discord Save button more visually prominent.
- Kept the restart prompt immediately to the left of the Saved status bubble.

### 1.0.0-rc.1 — Discord stale application activity cleanup
- Clear the previous Discord application's Rich Presence before switching to a new application ID.
- Prevent old and new Hive activities from appearing simultaneously in Discord's activity/profile surfaces.
- Preserve the current Playing/Listening selector while making application-ID changes replace the old presence cleanly.

### 1.0.0-rc.1 — large-library cover cache / scroll regression
- Removed eager detached-image warmup for every library cover.
- Kept the session cache demand-driven so native lazy-loading controls when
  covers are fetched and decoded.
- Retain successfully loaded cover image elements for later grid rebuilds
  without forcing thousands of off-screen decodes at startup.


### 1.0.0-rc.1 — Music Presence owns Discord Rich Presence
- Removed Hive's direct Discord IPC/Rich Presence publisher so it no longer competes with Music Presence.
- Removed the Discord application ID and activity-type controls from Hive.
- Preserved MPRIS track/artwork publication for Music Presence and left the external loon setup untouched.

### 1.0.0-rc.1 — automatic next-track MPRIS synchronization
- Fixed gapless automatic track transitions not immediately publishing the new
  track metadata through MPRIS. Both Web Audio and GStreamer transition paths now
  synchronize the newly promoted queue entry immediately.

### 1.0.0-rc.1 — playback/cache performance audit fixes (2026-09-13)
- Stopped per-track play recording from rewriting the entire library cache and rebuilding the active library view after every song.
- Kept play statistics durable in the dedicated stats store while leaving library-cache synchronization to intentional cache/scan operations.
- Changed large library-cache gzip generation from synchronous `gzipSync()` to asynchronous gzip so cache writes do not monopolize the main process event loop.
- Preserved the GStreamer playback path, MPRIS automatic next-track synchronization, queue behavior, and inline album expansion behavior.

### 1.0.0-rc.1 — performance audit build 3 (2026-09-13)
- Coalesced active-tab state persistence during rapid Albums/Tracks/Artists scrolling onto animation frames.
- Kept the deliberate demand-driven, cache-once-per-session artwork behavior unchanged.
- No playback-pipeline, MPRIS, queue, or album-expansion changes.


### 1.0.0-rc.1 — Spotify streaming source first build
- Replaced the old local-library Spotify playlist matching behavior with Spotify-native virtual playlist tracks.
- Added a loopback Hive ↔ Spicetify bridge for Spotify playback commands and player state.
- Added the bundled Spicetify extension and installer setup for Spotify/Spicetify/SpotX-Bash.
- Reused Hive's existing player UI and queue while keeping local GStreamer playback untouched.

## 1.0.0-rc.1 — Build 7 UI / tech polish

- Simplified the left navigation by removing decorative emoji icons while retaining the Favorites star.
- Renamed Playlist Explorer to `☰ Playlists` and made the top Playlists tab reflect the active playlist name.
- Added drag-and-drop reordering for top-level tabs with persistent built-in-tab order.
- Moved Beta Lab into Settings instead of exposing it as a permanent top-level tab.
- Implemented local ReplayGain playback normalization from embedded track/album gain and peak metadata, with clipping protection settings.

## 1.0.0-rc.1 — Build 8 UI / diagnostics polish
- Unified tag-editor checkbox/radio styling and cleaned up the Lyrics editor layout.
- Replaced browser-native title hover popups with themed Hive tooltips.
- Replaced renderer alert/confirm/prompt dialogs with themed in-app dialogs.
- Added Settings → Logs for loading bounded diagnostic logs and copying them to the clipboard.

## 1.0.0-rc.1 — Build 9 feature verification / UI consistency
- Re-audited the last requested feature set and fixed the Settings → Beta Lab integration so the moved Beta Lab content actually renders.
- Unified Lyrics synchronization radio controls with the themed tag-editor toggles.
- Made ReplayGain setting changes immediately apply to the current local track.
- Kept GStreamer user-volume changes ReplayGain-aware while preserving the existing transport ramp.

## 1.0.0-rc.1 — Build 14 community boot hardening
- Fixed the Build 13 Spotify bridge startup crash caused by a missing Node `http` import.
- Guarded optional Spotify bridge startup so external Spotify integration failures cannot prevent Hive's core application from booting.
- Preserved local GStreamer playback and all existing startup behavior.

## 1.0.0-rc.1 — Build 44 podcast transport / discovery overhaul
- Fixed mixed local/podcast queue transitions so virtual podcast tracks cannot be pre-buffered or played by the local Web Audio/GStreamer transports at the same time as the podcast HTML media element.
- Hardened GStreamer `ABOUT_TO_FINISH` handling so cross-transport Spotify/podcast transitions fall through to normal queue advancement instead of waiting for a nonexistent native next stream.
- Added debounced podcast search, stale-response protection, result counts, explicit clear button, Escape-to-clear, and better empty/loading/error states.
- Rebuilt the Podcasts tab UI with a discovery hero, improved search shell, Quick Access favorites, responsive show cards, bounded episode panels, larger artwork, and themed states.

## Build 45 — navigation pins, visualizer, themes, editorial UI pass
- Replaced the separate Top tabs navigation-settings section with pin controls directly in Navigation layout.
- Pinned navigation destinations can mirror the sidebar into the top bar; Music remains the primary destination.
- Added five built-in visual themes: Midnight, Ember, Forest, Ocean, and Violet.
- Added Rounded / Edgy Now Playing visualizer styles.
- Added a full animated visualizer surface to Now Playing with smooth bars and theme-aware rendering.
- Unified binary checkboxes into the Hive left/right switch control language.
- Hardened podcast navigation after the top-bar/navigation unification.

## Build 58 — installer + album spacing sanity fix

- Restored executable permissions on `install.sh` in the release archive.
- Kept the established 178px legacy album-card geometry unchanged.
- Made album browse row/column spacing explicit instead of relying on the `gap` shorthand.
- Re-ran installer/shell syntax, JavaScript syntax, Hive static checks, and archive integrity checks before packaging.

# Build 59 — Spotify quiet bootstrap + independent pinned tab order

- Kept Spotify playback entirely behind the Spicetify bridge; Hive no longer relies on the Linux `--minimized` flag being honored and now makes a bounded best-effort X11/XWayland hide pass after launching Spotify.
- SpotX remains optional and is not invoked by Hive's Spotify playback path.
- Pinned top-bar navigation now has its own persistent `pinnedOrder`, independent from the sidebar navigation order.
- Dragging a pinned top tab left/right changes only the top-bar order; the corresponding sidebar destination stays in its existing position.
- Existing installations migrate their initial pinned order from the prior sidebar order.


# Build 62 — Spotify provider repair + imported playlist metadata

- Diagnosed the Spotify playback failure shown in Build 61: Hive was correctly refusing to bypass the Spicetify bridge, but the installed bridge was not actually connected/applied.
- Tightened the installer verification so a successful `spicetify apply` is not treated as sufficient unless `hive-spotify-bridge.js` exists and is enabled in Spicetify configuration.
- Improved the Spotify playback error message to tell the user to close Spotify, rerun the Hive installer, and reopen Spotify when the bridge is unavailable.
- Added a migration-safe Spotify playlist normalization boundary: persisted provider durations above one hour are treated as stale millisecond values and converted to Hive seconds exactly once.
- Normalized persisted Spotify artwork URIs before queue/library rendering.
- Added background refresh of existing imported Spotify playlists so older imports can regain album/track artwork, album metadata, and correct durations without requiring a new import.
- The repeated Dominic Fike cover visible in the supplied screenshot is not itself a duplicated-artwork bug: the three queued tracks are from the same Spotify album; the missing artwork in the imported album grid is the stale/missing playlist metadata path being repaired here.

## Build 64 — Spotify metadata, artwork cache, and transport coherence

- Spotify playlist refresh now hydrates provider metadata before playlist playback begins, so stale imported records do not keep `Spotify` as the album label.
- Spotify track metadata now carries album artist and release year where Spotify exposes them.
- Spotify artwork is pre-cached into Hive's derived artwork cache with bounded concurrency; the renderer uses the cached files for playlist/queue/album visuals without retaining decoded image objects.
- Cached Spotify artwork is reused across subsequent playlist opens and hydration refreshes.
- Spotify provider state now ignores stale songchange/progress events while Hive is waiting for its most recent requested URI, preventing rapid track changes from fighting the queue selection.
- Spotify URI extraction is hardened against current Spicetify values that may expose URI-like objects.
- Spotify playlist playback awaits provider hydration before constructing the queue.


## Build 65 — Spotify provider lifecycle isolation

- Hive no longer automatically launches Spotify when a Spotify track is selected.
- Hive no longer hides, minimizes, or closes an existing Spotify window as part of playback recovery.
- Spotify playback now requires the independently started Spicetify client/bridge; `spicetify auto` is the supported startup path.
- Explicit Spotify launch, where invoked deliberately, uses `spicetify auto` rather than spawning the raw Spotify executable.
- Spotify import failures no longer unexpectedly open a Spotify window or login browser.
- This preserves the external-provider boundary: Spotify owns its desktop lifecycle; Hive only sends provider commands after the bridge reports connected.


## Build 66 — provider transport architecture

- Added an explicit active playback-provider boundary so local GStreamer, Spotify/Spicetify, and podcasts cannot simultaneously own Hive's transport state.
- Spotify activation now stops any active GStreamer/Web Audio transport before Spotify becomes authoritative; local activation pauses Spotify before local playback resumes.
- Spotify `songchange`, `onplaypause`, and `onprogress` events now drive Hive's shared play/pause, seek position, duration, artwork/metadata, and MPRIS state.
- Spotify volume commands are isolated from GStreamer, and incoming Spotify volume state no longer fights the user's active slider gesture.
- Spotify seeking routes directly to `Spicetify.Player.seek()` through the bridge with a single milliseconds conversion at the provider boundary.
- Added Spotify mute routing through the bridge.
- Added `docs/development/PLAYBACK-PROVIDER-ARCHITECTURE-BUILD66.md`.

## Build 73 — MPRIS artwork proxy repair
- Restored the localhost artwork proxy as an active part of the MPRIS lifecycle.
- Local cached artwork is now exposed to MPRIS consumers such as Music Presence through a loopback HTTP URL instead of only a `file://` URL.
- Kept Spotify/remote artwork URLs unchanged.
- Added regression coverage for proxy serving and path containment.

## Build 83 — album year divider layout fix
- Fixed the Albums Years view so each release-year section owns a stable full-width block instead of relying on flex-line sizing.
- Reworked the year heading into a two-column grid so the divider rule fills the available viewport width consistently.
- Removed section-level `content-visibility` containment from year wrappers while keeping the existing card-level optimization.
- Kept album sorting, card sizing, artwork, playback, and tab behavior unchanged.

## Build 89 — isolated album playback / collection shuffle fix

- Fixed album playback from History and other collection-derived album views so the playback queue is rebuilt in canonical disk/track order instead of inheriting the collection's track presentation/history order.
- Added a single `playAlbum()` boundary for album context-menu, album-card double-click, and play-badge actions.
- Album playback now respects only the actual player Shuffle switch: when transport Shuffle is off, the album queue is sequential; when it is on, normal transport shuffling still applies.
- Made Album Search and Artist Search explicit independent browser contexts by clearing the originating sidebar/playlist visual-shuffle permutation instead of leaking collection presentation state into search results.
- Added regression coverage for album ordering, shuffle separation, playback call sites, and search-context isolation.

# Build 108 — Track sorting, Plays alignment, and skip anti-pop ramp

- Fixed Tracks-view sorting for numeric columns such as Plays and Length to use the underlying numeric values rather than formatted display text.
- Numeric sorting now starts highest-to-lowest and uses deterministic Title → Artist → Album tie-breakers so equal values remain stable.
- Aligned the Plays value to the left edge of its column to match the other track metadata; Length remains right-aligned.
- Fixed the small audible pop during manual local-track skips by using the existing protected 10 ms GStreamer volume ramp before replacing the active playbin URI, adding only a minimal transport delay.
- Added regression coverage for numeric track sorting, deterministic tie-breaking, Plays alignment, and the skip ramp ordering.


## Build 133 — Large Queue Optimization Pass

- Replaced index-keyed virtual queue rows with a bounded reusable row pool so 40k-track queues keep a small, stable DOM footprint.
- Kept pooled rows attached to the virtual window while scrolling and update only their assigned queue content.
- Cached virtual queue nodes and limited shared artwork retargeting to visible current-track rows.
- Preserved delegated queue interactions, artwork, playback, selection, and drag/drop behavior.
- Added regression coverage and a development audit at `docs/development/OPTIMIZATION-PASS-BUILD133.md`.

## Build 132 — Large-playlist queue scroll performance

- Reworked queue virtualization to reuse visible row DOM nodes while scrolling instead of rebuilding the entire visible window with `innerHTML` at every virtualization boundary.
- Moved queue row click, double-click, context-menu, and drag interactions to one delegated queue-list handler so scrolling no longer repeatedly allocates per-row event listeners.
- Kept queue artwork virtualization intact while preventing the shared current-track cover rotator from reapplying the large player images on every queue scroll update.
- Preserved queue ordering, selection, drag/drop, playback, and synchronized artwork behavior.
- Added regression coverage for delegated queue interactions and row-node reuse.

## Build 135 — Queue render, auto-tag, and lyrics regression repair
- Fixed the reusable queue row pool surviving `renderQueue()` DOM replacement; the new virtual window now receives a fresh bounded pool instead of rendering an empty queue.
- Fixed the auto-tag completion path calling `applyLibrary()` without a library payload, which replaced the entire in-memory library with an empty track list after tagging.
- Made the no-payload `applyLibrary()` form preserve the existing library as a defensive invariant.
- Normalized lyrics on cached library records and incremental scan/event boundaries so older structured lyric values cannot render as `[object Object]`.
- Added regression coverage for all three failure paths.

## Build 134 — Queue virtualization regression + lyrics normalization
- Fixed pooled queue rows being positioned relative to the visible pool slot instead of their absolute queue index, which made visible rows disappear after scrolling.
- Normalized lyric metadata object/array shapes in the scanner and renderer so lyric objects render as text instead of `[object Object]`.
- Kept synchronized LRC parsing and lyrics editor values on the same normalized text path.

## Build 136 — Queue persistence hitch and virtual DOM hardening

- Fixed the 500 ms playback persistence loop accidentally rebuilding the complete queue state on every tick. Large queues no longer incur full queue mapping/serialization during ordinary position saves.
- Added a compact transport-only persistence snapshot; full queue snapshots remain reserved for queue/session mutations and forced shutdown saves.
- Removed the virtual queue window `<div>` wrapper so pooled queue rows are direct `<li>` children of the queue list, eliminating the fragile nested list structure behind the blank-queue regression.
- Preserved bounded reusable queue virtualization, absolute queue-index positioning, delegated interactions, selection, drag/drop, artwork, and playback.
- Added regression coverage for lightweight periodic persistence and direct-child virtual queue rows.
- Added `docs/development/BUILD136-QUEUE-PERSISTENCE-AND-VIRTUAL-DOM-FIX.md`.

## Build 145 — audio safety fail-silent hardening
- Treat native GStreamer `ERROR` as a fail-silent audio-path fault.
- Immediately cancel transport ramps, mute the native sink, force the pipeline to READY, and emit `FATAL_ERROR` before renderer recovery logic can replay audio.
- Renderer now latches native audio faults, stops playback state, prevents automatic retry, and prevents fallback Web Audio from taking over the same local track after a native audio fault.
- Added deterministic audio-safety regression checks covering native mute/stop and renderer retry prevention.
- Preserved persistent GStreamer/playbin architecture, queue handoff, scrubber, and metadata writer isolation.

## Build 150 — GStreamer malformed AAC recovery

- Adds explicit user-directed GStreamer backend restart after a native decoder/sink fault.
- Keeps native failures fail-silent and disables automatic replay of the failed stream.
- Play can establish a fresh native backend before retrying the current track.
- Adds regression coverage for the malformed-AAC recovery boundary.

## Build 163 — themed window chrome polish
- Lifted the top tab strip into the themed window chrome while keeping tabs explicitly interactive/non-draggable.
- Kept empty top-bar space available for native Electron window dragging in frameless mode.
- Enlarged the themed close-button hit target while retaining the minimal visual treatment.
- Removed search-box clipping in themed mode and preserved a complete rounded focus treatment.

### Build 173 — Playlist Details inspector polish

- Added a bounded scrolling region to Playlist Details so long content remains accessible inside the modal.
- Refined Playlist Details into a cleaner inspector-style hierarchy with compact appearance controls and a live sidebar preview.
- Replaced the dense boxed icon gallery with a lightweight symbol picker.
- Moved custom label markup behind an Advanced disclosure for a cleaner default workflow.
- Removed the lightning-bolt sidebar icon choice and normalized legacy saved lightning values to no icon when editing.
- Preserved all Build 172 Years, Favorites, playlist pinning, and Lyrics behavior.

# Build 171 — Context playlists + rating flyout polish

- Replaced the old `Add to playlist…` prompt with an `Add to ›` context-menu submenu for selected tracks and albums.
- `Add to ›` now provides `+ New Playlist`, the built-in Favorites autoplaylist, and writable user-created local playlists.
- Adding tracks to an existing playlist preserves existing membership and de-duplicates paths.
- Favorites remains backed by Hive's authoritative Love mechanism rather than writing membership into the smart playlist.
- Spotify and other smart playlists remain read-only destinations in this menu.
- Reworked the Rating flyout to use symbols only: Love, 1–5 star choices, and Clear.
- Added an accessible `aria-label` to each rating action while moving the explanatory text into a Hive-styled help label above the flyout on hover.
- Increased spacing between Rating and its submenu arrow.
- Added Build 171 regression coverage for playlist destinations and the rating-menu interaction.

Build 179 fix: theme-window recreation now preserves the active renderer playback projection while the persistent GStreamer transport continues uninterrupted.


# Build 196 — add-tab circle regression guard

- Reasserted the top-bar `+` tab control as a fixed 22×22px circular button after generic `.tab` sizing.
- Removed the vertical margin that could leave the control visually misaligned with the tab strip.
- Added regression coverage for fixed dimensions, flex basis, box sizing, alignment, and circular shape.

# Build 197 — portable data root correction

- Fixed portable persistence so Hive follows the actual current build folder instead of the stable Electron runtime path.
- Added `HIVE_PORTABLE_ROOT` launch contract while preserving the stable Electron executable identity used for Discord/Music Presence integration.
- This build included transitional migration from older external Hive data locations; that migration is intentionally removed in Build 198 so clean portable builds simulate a first install.


# Build 198 — clean portable first-run

- Portable Hive now starts from an empty profile when a fresh build folder is extracted.
- Removed automatic migration/import from machine-global Hive user-data locations.
- Explicitly roots Electron `appData`, `userData`, and `sessionData` under the current portable build's `data/` directory.
- Preserves the stable Electron runtime path used for Discord/Music Presence without allowing it to own Hive user data.
- Added regression coverage for clean first-run behavior and portable Electron storage paths.

## 1.0.0-pre-release-build220 — direct GStreamer volume control

- Fixed the local volume slider's audio-path regression by preventing slider movement from implicitly toggling mute.
- Removed renderer-side animation-frame volume coalescing for local GStreamer playback; each slider change now reaches the persistent native engine directly, matching the core volume model used by Strawberry.
- Kept the protected 10 ms transport ramp exclusively for play/pause and deliberate track transitions.
- Native volume writes now avoid redundant GStreamer property updates when the effective gain is unchanged.
- Added Build 220 regression coverage for the direct, mute-independent volume path.

# Build 222 — architecture cohesion / Strawberry blueprint audit

- Performed an end-game architecture cleanup against Strawberry's mature subsystem boundaries while preserving Hive's established UI and provider model.
- Local audio now has an explicit single-transport rule: persistent native GStreamer is authoritative and the historical renderer Web Audio implementation is no longer permitted to become a local playback fallback after native selection/failure.
- GStreamer now discovers the actual sink-owned `GstStreamVolume` implementation when available, disables playbin soft-volume for that output path, reapplies the stored target on stream start, and safely falls back if the output stack temporarily removes its volume-capable sink element.
- Preserved the 10 ms native transport ramp as a transport-only anti-pop mechanism; ordinary user volume remains a direct target with no renderer smoothing loop.
- Reworked scrobbling around a durable per-service pending queue. Failed submissions survive application restarts and are retried; cache writes use a temporary file followed by atomic rename.
- MPRIS navigation capabilities now reflect the authoritative renderer queue/history state rather than reporting Next/Previous unconditionally.
- Removed duplicate metadata bulk-write bridge declarations from the preload surface.
- Added `docs/development-BUILD222-ARCHITECTURE-COHESION.md` and architecture regression coverage.
- Updated historical volume regression tests to assert the new sink-owned volume abstraction while preserving their original transport invariants.


## Build 224 — Locked Playlists Top-Bar Position
- Locked the canonical **Playlists** navigation tab to the top bar by default.
- The fixed top-bar order is **Music → Playlists → Favorites** when Favorites is pinned.
- Preserved the relative order of other user-pinned destinations after the fixed entries.
- Prevented the locked Playlists tab from being unpinned or reordered by top-bar drag.
- Existing explicit Favorites pin/unpin state remains respected.


## Build 225 — Settings and Interaction Cohesion

- Audited and compacted Settings presentation without removing supported controls.
- Renamed settings destinations for clearer user-facing hierarchy: Playback, History, Scrobbling, and Diagnostics.
- Moved Highlighted lyrics into Library → Lyrics.
- Removed the redundant manual Settings save action; individual preferences continue to save through their existing paths.
- Made the themed Electron window bar visually default-on while preserving the persisted preference path.
- Batched full-scan renderer track IPC to keep Hive interactive during large library scans.
- Added Queue to album context-menu Add to actions.
- Standardized context-menu icon slots and vertical alignment.


## Build 226 — Themed Window Bar First-Boot Default

- Fixed the themed Electron window bar default when an existing Hive config predates the setting.
- A missing `themeWindowBarEnabled` key now uses the product default (`true`) instead of being interpreted as an explicit `false`.
- An explicitly saved `false` remains respected.
- No BrowserWindow, playback, scanning, or renderer interaction architecture changes.


## Build 227 — Playback/Queue Regression Recovery

- Reverted the risky Build 222 sink-owned `GstStreamVolume` routing experiment to the established persistent playbin volume path used by the known-good Build 219/220 transport. This keeps ordinary volume and the 10 ms transport ramp on one proven native path.
- Preserved GStreamer as the sole local playback authority; no Web Audio fallback was restored.
- Queue virtualization now resolves each visible row through the authoritative library track index by path, so a completed full scan cannot leave queue thumbnails showing stale pre-scan artwork/metadata.
- Fixed the explicit GStreamer-fault recovery branch's stale undefined track reference.

## Build 228 — Hive-native Love scanner recovery
- Made Love interpretation a Hive-owned shared semantic module instead of coupling scanner decisions to a format-specific implementation.
- Scanner now uses Hive's native metadata inventory as a safe fallback when a container-specific Love reader cannot walk an unusual/damaged tag structure.
- Hardened ID3 Love parsing so a physically truncated/over-declared tag does not automatically discard bytes that are still present.
- Preserved embedded-file authority, canonical `LOVE RATING` output, and separation from POPM/star ratings.
## Build 235 — Edit Track / Lyrics / Volume / Persistence Polish

- Coalesced rapid local GStreamer volume slider commands without reintroducing a transport fade; ordinary volume remains a direct native target.
- Kept the themed search position anchored beneath the window controls at normal height, then moved it with the topbar after roughly 50px of user growth.
- Preserved stable Hive user-data persistence and made the in-project User Data Backup recovery-only when the stable profile already contains a file, preventing stale backup state from reverting Favorites/UI customization.
- Added explicit Edit Lyrics/Search online actions and a card-based editable lyrics surface.
- Made Plain lyrics and Synchronized lyrics modes functional; synced MP3 saves now also maintain a native ID3 SYLT frame, while switching to plain removes SYLT.
- Preserved signed BEEHIVE_LYRICS_OFFSET writes and playback consumption.
- Restored useful empty-field ghost placeholders and clarified ReplayGain fields so blank values are understood as "not populated" rather than values the user should guess.
- Reduced the large opaque Edit Track Save/Cancel footer into the existing modal surface.

## Build 238 — volume slider user authority

- Verified the local volume path against GStreamer's playbin/GstStreamVolume behavior: playbin exposes a linear 0.0–1.0 volume property and separate mute control.
- Fixed the remaining transport-ramp interference: an in-progress 10 ms PLAY/PAUSE transition ramp is now cancelled immediately when the user moves the volume slider, so the ramp cannot overwrite the user's requested level.
- Kept ordinary user volume as a direct GStreamer target; no second user-volume automation/smoothing loop was introduced.
- Added regression coverage for immediate user authority and transport-ramp separation.

## Build 236 — light theme readability / current-track contrast
- Brightened the built-in Light theme with a cleaner near-white surface palette, stronger neutral text contrast, and much subtler ambient tinting.
- Made Frosted Glass off use solid themed surfaces with no backdrop blur, so the master glass switch no longer leaves transparent/washed surfaces that reduce readability.
- Set the current-track artist name to white in dark themes and a dark neutral in Light in both compact Now Playing positions.
- Added regression coverage for the Light palette, solid no-glass surfaces, and current-track artist contrast.


## Build 245 — Top-Bar Resize Flow

- Made the themed navigation row fully fluid after the custom Electron title row.
- Library search and navigation tabs now share the same flex row/vertical center and follow the user's top-bar height adjustment together.
- Removed the remaining fixed 50px navigation-row constraint while preserving the title-row hit-area fix and search width behavior.

## Build 244 — Top-Bar Search Follows Navigation

- Kept Library Search in the same normal-flow navigation row as the brand and tabs.
- Removed the fixed vertical search offset and renderer positioning helper.
- Resizing the top bar now moves the search field with the tab centerline automatically.
- Preserved the existing search width, resize behavior, window chrome separation, and top-bar hit targets.
