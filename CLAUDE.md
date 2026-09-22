# Hive - project briefing for Claude Code

Hive is a vibe-coded Electron/GStreamer music player at pre-release build 258.
This file exists so a fresh Claude Code session doesn't have to rediscover
what a previous chat-based session (claude.ai) already found. Read this
before making changes, especially to playback/volume code.

## Version note - read this first

This checkout was built from a "build258" zip. If a separately-maintained
local build (e.g. anything the user calls "Hive-rcc.1.148392.0" or similar)
is newer, it may contain changes not reflected here. If the user mentions
another local copy, ask before assuming this checkout is the source of
truth - diff or merge rather than overwrite.

## Your environment: GNOME on Wayland, AMD CPU/GPU

This is confirmed, not just likely, to be the environment Hive was
originally vibe-coded on. `app/main/main.js` (~line 630-643) already
unconditionally forces `ozone-platform=x11` /
`disable-features=UseOzonePlatform` for the whole app on
`process.platform === 'linux'`, with a comment stating outright: "On a
GNOME Wayland desktop this intentionally runs through XWayland... 0.9
used the legacy X11 path and its window-manager decorations matched the
user's desktop theme." So the main window already runs through XWayland,
not native Wayland - don't suggest adding that flag, it's redundant.
The same block also unconditionally disables GPU vsync
(`disable-gpu-vsync`), with a comment citing "repeated
GLSurfacePresentationHelper GetVSyncParametersIfAvailable() failures on
the target Linux desktop" - another Chromium/compositor workaround
already baked in for this exact setup.

Given all that, if the user hits blank windows, misplaced titlebar
controls, a broken drag region, or GPU-adjacent rendering glitches, it is
NOT a config-flag problem - those are already forced. Look instead at:
the window-control hit-testing code from builds 233/234 (search
`main.js`/`renderer.js`/`styles.css` for `window-titlebar-row` and
`app-region`), the rejected-WCO history in the changelog (don't
reintroduce Window Controls Overlay), and whether XWayland itself
(not Hive) is the actual source, which changing Hive's code can't fix.
The Spotify *helper* client is a separate case and has its own X11
forcing further down `main.js`/`install.sh` for the same underlying
reason - don't conflate the two when debugging.

## What Hive is

- Electron desktop app, Linux-first, local GStreamer playback (native C
  helper in `app/native/gstreamer-player.c`), plus Spotify/Spicetify and
  podcast providers.
- `app/main/main.js` (~7,200 lines) and `app/renderer/renderer.js`
  (~16,000 lines) are monolithic files doing almost everything for their
  process. This is the single biggest structural problem in the codebase.
- `docs/ai/HIVE-METADATA-BACKEND-CANON.md` is the project's own canonical
  architecture doc for the metadata subsystem, written as of build 258.
  Treat it as authoritative for that subsystem the same way this file is
  meant to be authoritative for the whole project going forward.
- `CHANGELOG.md` has ~258 build entries. Read it with suspicion: many
  builds are diagnostic dead ends, not intentional final states.

## The core problem: a whack-a-mole development pattern

The changelog shows volume/mute/transport-ramp code rewritten from scratch
at least 8 times across builds 168-257 (search the changelog for "volume"
to see it). Root cause found this session: **every fix-build wrote a new
`buildNNN-*.test.js` file locked to that exact build's literal source
text/regexes, and nothing ever retired the old ones.** A future AI session
(or human) would see a wall of "failing" tests, not realize most were
mutually contradictory relics of superseded diagnostic builds, and rewrite
working code to chase them - creating a new regression and a new stale
test file. Repeat.

**Do not repeat this pattern.** Concretely:
- Prefer a small number of stable test files per subsystem
  (e.g. `test/volume.test.js`, `test/transport.test.js`) that get *edited
  in place* when behavior legitimately changes, not appended to forever.
- Tests should assert *behavior*, not exact source text/whitespace/variable
  names, wherever possible. Regex-matching literal code shape is what let
  this thrash happen for 90+ builds.
- If a test is failing, check the changelog and canon docs FIRST to see if
  the code was legitimately changed on purpose before assuming the code is
  wrong and "fixing" it back.

## What was done in the prior (claude.ai) session

1. **Real bug found and fixed:** `resources/python/tag_helper.py` computed
   its own directory (`resources/python/`) and inserted *that* onto
   `sys.path` to find the bundled `mutagen` package - but mutagen actually
   lives in `resources/mutagen/`, a sibling directory. Every metadata
   write (rating, Love, tags, artwork) through the "canonical Mutagen
   backend" was silently failing to import mutagen. Fixed by inserting
   `HERE.parent` instead of `HERE`. Three test files
   (`test/native-metadata-batch-write.test.js`,
   `test/native-tag-editor-write.test.js`,
   `test/artwork-type-swap.test.js`) had independently copy-pasted the
   same wrong relative path and were fixed too. Verify this is still
   correct before doing anything else - it's foundational.

2. **Full test suite cleaned up: 549/549 passing.** Started at 529/572.
   Of the ~43 original failures, one class was the mutagen bug above; all
   but one of the rest were confirmed stale tests from superseded
   diagnostic builds (the volume/transport-ramp saga), not real bugs.
   Deleted entirely (every test in them was about now-removed code):
   `build193-volume-smoothing.test.js`,
   `build238-volume-user-authority.test.js`,
   `build250-smooth-user-volume.test.js`,
   `build255-mp4-rating-artwork.test.js` (tested `writeMp4RatingTag` in
   `main.js`, which build 258's metadata consolidation made dead code -
   see "known cleanup debt" below). ~19 other files were edited in place
   (stale/contradictory tests removed or rewritten to match current
   behavior, valid tests kept). Two sub-bugs found in the tests
   themselves while doing this: several files asserted
   `fs.readFileSync('BUILD').trim() === '247'` (or similar) - a one-off
   sanity check for a single build mistaken for a permanent regression
   test - removed. One file (build 246) asserted the literal *opposite*
   of current intended behavior (volume slider being visual-only, from a
   diagnostic build later intentionally reverted) - deleted rather than
   "fixed", since making it pass would re-encode the regression.

3. **Caveat:** the prior session ran entirely in a sandboxed container. It
   never compiled `app/native/gstreamer-player.c` or launched the actual
   Electron app with real audio hardware - everything was verified via
   static source analysis and the Node test suite only. You can actually
   build and run it. Do that early; it may surface real bugs the prior
   session structurally could not see.

## What's next, roughly in priority order

1. **Compile and run the real thing first.** This is the highest-value
   thing you can do that the prior session couldn't.
2. **Remove confirmed dead code.** `writeMp4RatingTag`,
   `makeMp4FreeformRatingAtom`, and their supporting MP4-atom helpers in
   `app/main/main.js` (~line 6600-6660) are no longer called anywhere -
   the actual rating-write path (`embedRatingInFile`) now goes through
   the Mutagen backend unconditionally for every format. Verify no other
   caller exists, then delete.
3. **Split `main.js` and `renderer.js` into modules.** This is the actual
   structural root cause behind most of the "UI bugs and inconsistencies"
   the user originally reported - unrelated concerns (UI, playback state,
   IPC) share scope in two giant files, so an unrelated change can
   silently break something else. Suggested seams for main.js: IPC
   handlers / library-scan+cache / worker lifecycle / GStreamer bridge /
   window+tray. For renderer.js: sidebar / now-playing+queue / settings /
   theme / tag-editor.
4. Only after that: go bug-hunting on the user's actual reported UI bugs.
   Before this session, it wasn't possible to tell which reported bugs
   were real product bugs vs. artifacts of the test debt above - the
   signal was too noisy to trust.

## 1.0 scope decisions (explicit, not accidental)

- **Localization/i18n is intentionally out of scope for 1.0.** The renderer
  (`app/renderer/renderer.js`/`index.html`) has all UI text as literal
  English strings throughout, with no translation layer. This matches how
  most comparable Linux-first players ship (English-first, locales added
  post-1.0) and retrofitting i18n into a ~16,000-line renderer with no stated
  goal of reaching non-English-speaking users at launch would be a large,
  low-value effort right now. Revisit if that goal is ever stated explicitly
  - at that point this decision should be replaced, not silently overridden.
- **Plugins are a trusted-local extension model, not sandboxed**, disclosed
  to the user at install time (see `app/main/main.js`'s `plugins:installFolder`
  handler) rather than enforced technically. Real isolation (a sandboxed
  webview/iframe with its own CSP, separate from the main window's) is a
  known, tracked follow-up - see the CSP comment in `app/renderer/index.html`
  - needed before opening plugin installation to a public marketplace, not
  required for a small curated set of first-party plugins.
- **Electron is pinned to an outdated, `npm audit`-flagged version** (see
  `package.json`). Upgrading is a dedicated, separately-scoped task (full
  re-test required across main-process APIs, `BrowserWindow` options, and IPC
  behavior) - do not bump it as a side effect of an unrelated change.
- **GitHub Releases/`electron-updater`** are wired up (`app/main/update-checker.js`)
  but `package.json`'s `build.publish.owner` is still the literal placeholder
  `REPLACE_WITH_GITHUB_OWNER` - the update check silently no-ops (logs an
  ordinary "not found"-style error, never crashes) until a real repo exists.
  Replace that placeholder when the GitHub repo is created at 1.0.

## Status as of 2026-09-20 - read this to pick up where the last session left off

No git repo exists yet in this checkout (user plans to create one at 1.0 -
package.json's `build.publish.owner` is deliberately still the placeholder
`REPLACE_WITH_GITHUB_OWNER` until then, per the scope decision above). Full
test suite: 605/605 passing (`node --test test/*.test.js`).

Since the "What's next" list above was written, a long session worked
through a 1.0 pre-release punch list the user asked for (plugin support,
professional-open-source-player gaps, bulk album actions, etc). Completed
in that pass, still true today unless a later session's notes here say
otherwise:
- Fixed the mutagen-import bug (see "What was done" above) - still the
  foundational fix, unchanged.
- Fixed a duplicate-USLT bug in `resources/python/tag_helper.py`'s
  `set_uslt`/`set_comm` (malformed ID3 language codes like `'   '`/`'XXX'`
  weren't matching the "default language" check, so writes added a second
  USLT frame instead of replacing the old one). Migrated the user's library
  off embedded synced lyrics to plain (backups under
  `~/Downloads/Hive-lyrics-migration-backup-20260920/`) and deduplicated 6
  affected files as a result of finding this bug.
- Extracted `app/main/metadata-writer.js` (`createMetadataWriter(deps)`) and
  `app/main/update-checker.js` (`createUpdateChecker({autoUpdater})`) out of
  `main.js`, both dependency-injected so they're unit-testable with fakes
  instead of only via source-text regexes - this is the pattern to reuse
  when doing the main.js/renderer.js module split (items 3/#10/#11 below).
- Added: crash reporting (electron `crashReporter`, local-only), GitHub
  Releases auto-update via `electron-updater` (check-then-ask, never silent
  install), a plugin-install trust-disclosure dialog, CI
  (`.github/workflows/test.yml`, inert until a real GitHub repo exists).
- Removed both broken bundled visualizer plugins (Monstercat + the example
  spectrum plugin) and their dead tests entirely - to be rewritten from
  scratch later, not patched.
- Fixed a real bug: playing a track no longer triggers a full library
  rescan (the P_count/play-count write wasn't calling
  `markLibraryInternalWrite`, so Hive's own write looked like an external
  file change to the watcher).
- Rewrote `showAlbumContextMenu` in `app/renderer/renderer.js` for bulk
  multi-select: selecting several albums (Ctrl/Cmd+A or click-drag) and
  right-clicking now applies playlist-add/queue/rating/tag actions to all
  selected albums, not just the one under the cursor.
- Relaxed CSP to add `script-src 'unsafe-eval'` app-wide, needed for
  `plugins:run`'s `new Function(source)` - a deliberate, accepted tradeoff
  (see the CSP comment in `index.html` and the plugin-isolation scope note
  above) pending real plugin sandboxing, not an oversight.

### Open tracked items (in rough priority order)

- **#9 - Build real plugin isolation** (sandboxed iframe/webview with its
  own CSP), the follow-up the CSP relaxation above is waiting on. Not
  started.
- **#10 / #11 - Split `main.js` and `renderer.js` into modules.** Same as
  item 3 in "What's next" above; still not started. Use the
  `metadata-writer.js`/`update-checker.js` dependency-injection extraction
  pattern as the template.
- **#12 - Consolidate the `buildNNN-*.test.js` proliferation - PARTIALLY
  DONE, not exhaustive.** Of ~82 buildNNN files that originally existed, two
  clusters are now fully consolidated:
  - Love/Favorites (15 files) -> `test/love-metadata.test.js` (Love tag
    semantics, playback-safe writes, native-tag fallback reads, durable DB
    projection) and `test/playlist-sidebar-navigation.test.js` (Favorites as
    a sidebar/tab entity, playlist pinning, Playlist Info propagation). Five
    unrelated stray tests that were embedded in those 15 files got relocated
    to their real homes (`test/build150-gstreamer-recovery.test.js`,
    `test/build201-first-library-integrity-audit.test.js`,
    `test/build192-playlist-music-tabs.test.js` x2,
    `test/build195-lyrics-settings.test.js`,
    `test/build196-add-tab-circle.test.js`).
  - Volume (8 files: build151/214/215/239/241/246/253/257) -> merged into
    the already-good `test/volume.test.js` (MUTE_DEFERRED gate, linear
    slider-to-engine mapping, no-dispatch-timer coverage). build214/215 and
    build253/257 turned out to be fully redundant with existing
    `test/volume.test.js` coverage once compared line-by-line and were
    deleted outright rather than merged. Four unrelated stray tests
    misfiled under volume/transport build names were relocated:
    build239 (playback-time text color) and build246 (Light-theme back
    arrow) -> `test/build236-light-theme-readability.test.js`; build241's
    window-titlebar-row CSS -> `test/build162-window-chrome.test.js`;
    build151's generic GStreamer-diagnostics-event test ->
    `test/build216-in-app-diagnostics.test.js`.
  **Do not mark #12 fully complete until the remaining ~59 buildNNN files
  get the same treatment** - gstreamer/lyrics/tabs clusters likely still
  have strays beyond the ones already found. When resuming this, read a
  cluster fully before touching it (as both passes so far did) - don't
  delete a buildNNN file without confirming every test in it either has a
  home elsewhere or is genuinely obsolete (verify against current source,
  don't assume the old assertion is still true).
- **#16 - Accessibility audit - fixes #1-#4 DONE, #5/#6 still open.**
  Findings, fix status, and the reasoning behind each fix:
  1. **FIXED.** The global tooltip system (`renderer.js`'s
     `prepareTooltipNode`) strips every `title` attribute into a non-ARIA
     `data-tooltip` and deletes `title`, which silently removed the only
     accessible name from icon-only buttons that relied on `title` alone.
     Rather than hand-adding `aria-label` to just the originally-enumerated
     buttons, `prepareTooltipNode` itself now mirrors `title` into
     `aria-label` (when one isn't already set) before removing `title` -
     this covers every current AND future title-only icon control, not a
     fixed list.
  2. **FIXED.** All 14 `.modal-close` buttons in `index.html` now have
     `aria-label="Close"` (5 already did; 11 were missing it).
  3. **FIXED.** `openModal()`/`closeModal()` (`renderer.js`, next to
     `modalTabTrap`) now: set `role="dialog" aria-modal="true"` (and
     `tabindex="-1"` as a fallback) on the modal's inner `.modal` panel;
     move focus to the panel's first focusable element on open; trap Tab
     inside the panel while open (`modalTabTrap`); and restore focus to
     whatever was focused before the modal opened, on close.
  4. **FIXED.** `.pb-meta` (wraps `#pb-title`/`#pb-artist`) is
     `aria-live="polite"`; `#notice-body` (`showAppNotice`'s modal content)
     is `aria-live="assertive"`. `#about-update-status`'s existing
     `aria-live="polite"` was the reference pattern for both.
  5. **NOT STARTED.** `.album-card`, `.song-row`, `.queue-row`, and
     interactive `.rating-star` are plain unlabeled `<div>`/`<span>`
     elements with only mouse click handlers - no `role`, `tabindex`,
     keydown-for-Enter/Space, or (for stars) per-star `aria-label`. The
     custom context menu's individual items are already real `<button>`s
     with good semantics (use as reference), but the menu container itself
     lacks `role="menu"` and arrow-key navigation.
  6. **NOT STARTED, blocked on #5.** `:focus-visible` styling
     (`styles.css` ~3162-3165) only covers real
     `<button>`/`<input>`/`<select>`/`<textarea>` plus a few specific
     component classes - once #5's elements get `tabindex`, they'll need
     matching `:focus-visible` rules added too.
  Real functional/DOM-text tests for #1-#4 live in the new stable
  `test/accessibility.test.js` (not a buildNNN file) - edit it in place
  when #5/#6 get fixed, don't create a second file.
- **#20 - Upgrade Electron** off the vulnerable pinned 33.2.0 (current
  `npm audit` wants 44.4.3, an 11-major jump). Separately, lower priority:
  `dbus-next@0.10.2` pulls an old `node-gyp`/`request`/`tar` chain
  (install-time only). Not started - deliberately scoped as its own
  dedicated session per the "1.0 scope decisions" section above, not a
  side effect of other work.

### Already completed this punch-list pass (don't redo)

Crash reporting, auto-update wiring, CI workflow, i18n scope decision,
plugin-trust disclosure, bulk album multi-select context menu, and the
mutagen/USLT-duplicate/library-rescan bug fixes above are all done. If a
future session's notes contradict this list, trust the more recent note.

## Volume architecture as of 2026-09-21 - the whack-a-mole saga continues, read before touching this again

This is the single most-rewritten subsystem in the project (see "The core
problem" above - 8+ rewrites across builds 168-257 before this session even
started). This session added at least 5 more real iterations, all validated
against real hardware/ears, not sandboxed guesses - **including one that
looked correct, shipped, and was then proven wrong by live testing and
reverted the same day.** Read the whole list before touching this again.

**Resolved and confirmed by the user's own listening test, 2026-09-21:**
the ramp-finish double-apply bug and the ramp-start cross-thread race
(both documented in full below) were the real causes of the reported
popping. The user confirmed after relaunching that this is good enough -
**do not reopen this investigation or re-attempt any of the reverted
approaches below on the assumption popping is still unresolved.** If a
NEW, different popping symptom is reported later, treat it as a
genuinely new investigation (confirm the exact trigger/character first,
the way this session did) rather than assuming it's the same bug
recurring.

**Current mechanism (sole mechanism again, after the revert below):
sample-accurate in-pipeline ramp.** `hive-user-volume` (a real GStreamer
`volume` element, positioned in its own bin immediately upstream of the
sink - NOT upstream of playbin's own ~1s internal queue, which is a real,
separately confirmed lag bug if this placement ever regresses) is driven by
a `GstPadProbe` on its own sink pad (`volume_ramp_probe_cb`). While a ramp
is active, the element's own "volume" property is forced to `1.0`
(pass-through) and the probe instead scales each buffer's raw PCM samples
directly and per-sample (`apply_sample_ramp`, via `gstreamer-audio-1.0`'s
`GstAudioInfo` - a real added build dependency, see `gstreamer-bridge.js`'s
pkg-config list). This replaced an earlier version that only set the
property once per buffer (a "staircase" with as few as one step per ramp if
the decoder handed off a large frame - a single FLAC block can be ~90ms -
indistinguishable from an instant jump). Bounded to the exact sample
formats GStreamer's own `volume` element supports (S16/S32/F32/F64
interleaved); anything else falls back safely to the old per-buffer
property step rather than risking scaling the wrong bytes.
`begin_user_volume_ramp()` always unconditionally resets its ramp anchor on
every single retarget (see item 2 below for why that's deliberate, not an
oversight).

**Tried and reverted, in chronological order this session - do not
reintroduce any of these without validating on real hardware first:**

1. **Rate-limiting how often the ramp re-anchors its start time during
   rapid retargeting** (skipping the anchor reset for retargets closer
   together than ~12ms, to reduce slope-jitter during a fast slider drag).
   Confirmed live that this made popping *worse*: during a sustained fast
   drag, the anchor never got refreshed at all (commands arrived faster
   than the rate limit, continuously), so it just aged while the target
   kept moving, and once enough time passed since that stale anchor every
   buffer started snapping instantly to whatever the target happened to be
   - a real, repeated instant jump.
2. **Routing volume through the real sink's own native "volume"/"mute"
   properties directly** (pulsesink exposes these as plain GObject
   properties - confirmed via `gst-inspect-1.0 pulsesink`, not assumed; no
   `GstStreamVolume` interface casting or `#include
   <gst/audio/streamvolume.h>` needed). The theory, directly adopted from
   how real GStreamer media players like Rhythmbox handle this: skip
   in-process ramping entirely and let PulseAudio/PipeWire's own
   audio-server mixing stage smooth the change, the same mechanism the OS's
   own system volume slider relies on for fast dragging. This shipped, was
   verified live (real playback, confirmed via `pactl`/PipeWire that the
   sink-input was genuinely active and receiving volume changes, not
   silently falling back to `autoaudiosink`), and the user confirmed they
   were running it - and it still popped. Worse: because
   `begin_user_volume_ramp()` skipped ramping entirely for this path
   (assuming the server would smooth it), a single big jump (e.g. 100% down
   to 14%, not even a fast drag) became a real, completely unramped instant
   change. **The core assumption - that PipeWire's pulse-compatibility
   layer auto-smooths a direct stream-volume property write - is now
   confirmed FALSE for at least this user's PipeWire setup.** Do not
   re-attempt this without first confirming, on real hardware, that the
   target system's audio server actually does this.
3. **GstStreamVolume element-discovery via playbin's
   `"deep-element-added"` signals** (builds 222/227, from before this
   session) - still correctly rejected, but for a narrower reason than an
   old comment here implied. That mechanism was fragile because it
   *discovered* the sink dynamically by walking playbin's internal graph.
   Item 2 above is a different, more direct mechanism (this app creates
   `sink` itself in `main()` and already holds a reference to it - no
   walking/discovery involved) and was rejected for a completely different,
   concrete reason (see above), not the old fragility concern.

**Update, same day: the real bug behind (a) was found and fixed - a
GstPadProbe timing bug, not a gain-curve-shape problem.** A `GstPadProbe` on
a SINK pad runs BEFORE the element's own `chain()` function processes that
same buffer. `volume_ramp_probe_cb()` used to restore `hive-user-volume`'s
"volume" property to the ramp's target in the SAME probe call where that
buffer's samples had just been manually scaled to that same target via
`apply_sample_ramp()` - so the element's own chain function then applied
gain a SECOND time to already-correctly-scaled samples, squaring the
effective gain. For low targets this is severe (target 0.14 → effective
~0.0196, an audible near-silence blip right as the ramp finishes) - and it
happens on every single ramp completion, so a fast drag (which completes
many short ramps in quick succession) hits it repeatedly. This exactly
matches the user's reported symptoms: worse on big jumps toward low
targets, and worse/more frequent during fast dragging. **Fix:**
`volume_ramp_pending_restore` defers the property restore to the START of
the *next* probe invocation - guaranteed to be a different, not-yet-processed
buffer - instead of the same buffer whose samples were just scaled. Also
cleared in `cancel_user_volume_ramp()` and `begin_user_volume_ramp()` so a
restore left pending from a ramp that just finished can't fire later and
clobber a new ramp's forced-1.0 pass-through state. Verified via live
compile/link + real playback (LOAD/PLAY/VOLUME over the native helper's
protocol, trace log confirms correct `finishing` timing for each
transition, no crashes), and since confirmed by the user's own listening
test (see the note at the top of this section) - popping from this cause
is resolved. Covered by
`test/volume.test.js`'s `'a finishing ramp defers its property restore...'`
and `'cancelling or retargeting a ramp clears any pending deferred
restore...'` tests. Explicitly ruled out as causes during this
investigation (measured live, not assumed): `gst_buffer_make_writable()`
copy overhead (always already-writable, 0-2us) and buffer granularity
(measured ~26ms/buffer on the user's real system, not the ~90ms worst case
originally feared).

**Separate, unrelated bug also found and fixed the same day: the real
output sink defaulted to whatever volume PipeWire's session manager
assigned a brand-new stream (the user observed 50%, not 100%), because
`main()` never wrote an explicit "volume"/"mute" property on `sink` at
startup.** This is not the popping bug and not a revival of item 2 above
(that was about routing the user's *continuous* slider changes through the
sink's property; this is a one-time unity pin at startup so the OS
mixer/sound-settings entry for this app always reads 100% while
`hive-user-volume` remains the sole real gain control). Fixed: `main()` now
explicitly creates `pulsesink` (falling back to `autoaudiosink` only if
that fails) and sets `volume=1.0, mute=FALSE` on it once, tracked via a
plain `sink_is_pulse` boolean - deliberately NOT via
`g_object_class_find_property()` introspection, since that exact call
shape is what `test/volume.test.js` guards against reappearing (it was the
signature of the reverted item-2 routing experiment). Covered by
`test/volume.test.js`'s `'the real output sink is pinned to unity
volume/unmuted once at startup...'` test.

The item-2 (native-sink-property routing) and item-1 (rate-limited
retargeting) reverts above are still correctly rejected and unchanged by
either fix in this update - both are about *continuous* volume control
during playback, not the one-time ramp-completion and startup-pin bugs
fixed here.

**Update, same day, after user re-test: startup-pin fix (#2 above) confirmed
working; ramp fix (#1 above) confirmed "the best it's been" but still very
slightly popping.** Found and fixed a second, smaller bug in the same
family as the finish-side double-apply bug - this one at ramp START rather
than finish, and a genuine cross-thread race rather than a same-thread
ordering mistake:

`begin_user_volume_ramp()` runs on the MAIN thread (`command_tick` is
invoked via `g_main_context_invoke(NULL, ...)` on the default
`GMainContext`, which is the thread running `g_main_loop_run(loop)` in
`main()`). `volume_ramp_probe_cb()` runs on GStreamer's own STREAMING
thread. `begin_user_volume_ramp()` used to force the "volume" property to
`1.0` directly, from the main thread, with no ordering guarantee relative
to the streaming thread. A buffer's probe call could read
`volume_ramp_active` as still stale-`FALSE` (so the buffer passed through
untouched, no direct sample scaling applied) while that SAME buffer's
`chain()` call, racing concurrently on the other thread, could read the
property AFTER it had already been forced to `1.0` - a real, brief jump to
unscaled full volume for one buffer (~26ms), heard as a small pop right as
a ramp starts. Small and easy to miss underneath the much larger
finish-side bug, which is presumably why it only became noticeable once
that one was fixed.

**Fix, same pattern as the finish-side bug:** a new
`volume_ramp_pending_start` flag, set by `begin_user_volume_ramp()` instead
of writing the property directly. The actual `g_object_set(..., "volume",
1.0, ...)` now happens from INSIDE `volume_ramp_probe_cb()`, on the
streaming thread, gated to only fire once `volume_ramp_active` has already
been observed `TRUE` for that buffer (i.e. after the existing `if
(!volume_ramp_active) return GST_PAD_PROBE_OK;` check, not before it) -
this guarantees the property write and that buffer's decision to apply
direct sample scaling always land on the same buffer, on the same thread,
eliminating the race rather than narrowing its window. Also cleared in
`cancel_user_volume_ramp()` and in the `ensure_ramp_audio_info()`-failure
fallback branch (which never enters pass-through mode, so a stale pending
flag there must not fire later out of context). Verified via live
compile/link + real playback (LOAD/PLAY, six rapid VOLUME retargets
including 1.0→0.14 and back, no crashes, only the pre-existing unrelated
`g_object_unref` warning), and since confirmed by the user's own listening
test (see the note at the top of this section) - popping from this cause
is resolved too. Covered by `test/volume.test.js`'s updated `'an active ramp
forces the element to a 1.0 pass-through...'` test and the new
`'cancelling a ramp also clears any pending start-force...'` test.

If the user reports *any* further popping after this, the finish-bug and
start-bug fixes above cover the two places this file's own code controls
the property/sample-scaling relationship - the next thing to suspect is
something outside this file's control entirely (e.g. PipeWire's own
resampler/graph quantum boundaries), not a third variant of the same
same-buffer-ordering bug.

## Ground rules

- Read `docs/ai/HIVE-ENDGAME-DEVELOPMENT-PROMPT.md` and
  `docs/ai/HIVE-METADATA-BACKEND-CANON.md` before touching playback or
  metadata code, and keep them updated if the canonical approach changes.
- Don't create a new `buildNNN-*.test.js` file per session. Edit the
  relevant stable test file instead.
- When a test fails, check `CHANGELOG.md` and `docs/ai/` for whether the
  code was *intentionally* changed before assuming it's broken.
