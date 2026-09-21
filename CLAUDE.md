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
  DONE, not exhaustive.** Of ~82 buildNNN files that existed, only the
  Love/Favorites cluster (15 files) has been fully consolidated so far,
  into two new stable files: `test/love-metadata.test.js` (Love tag
  semantics, playback-safe writes, native-tag fallback reads, durable DB
  projection) and `test/playlist-sidebar-navigation.test.js` (Favorites as
  a sidebar/tab entity, playlist pinning, Playlist Info propagation). Five
  unrelated stray tests that were embedded in those 15 files got relocated
  to their real homes (`test/build150-gstreamer-recovery.test.js`,
  `test/build201-first-library-integrity-audit.test.js`,
  `test/build192-playlist-music-tabs.test.js` x2,
  `test/build195-lyrics-settings.test.js`,
  `test/build196-add-tab-circle.test.js`). **Do not mark #12 fully complete
  until the rest of the ~67 remaining buildNNN files get the same
  treatment** - known remaining hotspots: volume still has 8 separate
  buildNNN files coexisting alongside the already-good `test/volume.test.js`
  (build151/211/214/215-volume/241/246/253/257), and gstreamer/lyrics/tabs
  clusters likely have more than the ones already found as strays above.
  When resuming this, read a cluster fully before touching it (as this pass
  did) - don't delete a buildNNN file without confirming every test in it
  either has a home elsewhere or is genuinely obsolete.
- **#16 - Accessibility audit.** Audit is DONE (findings only, no code
  changed yet) - a subagent read `index.html`/`renderer.js`/`styles.css`
  directly. Concrete, verified findings, priority order for the actual fix
  pass:
  1. The global tooltip system (`renderer.js` ~line 15683-15713) strips
     every `title` attribute into a non-ARIA `data-tooltip` and deletes
     `title`, via both a one-time `querySelectorAll('[title]')` pass and a
     `MutationObserver`. This silently removes the only accessible name from
     icon-only buttons that rely on `title` alone - concretely the 7 playbar
     buttons (`#btn-prev/#btn-play/#btn-next/#btn-love/#btn-shuffle/#btn-repeat/#pb-vol-icon`),
     `#lightbox-close/prev/next`, `#brand-btn`, `#tab-add-btn`,
     `#playlist-import-spotify`. Fix: give these real `aria-label`s (not
     relying on `title`).
  2. 9 of 13 `.modal-close` buttons have no accessible name at all (no
     `aria-label`, and `title` would be stripped by #1 anyway): settings,
     tag editor, about, notice (`showAppNotice`'s modal - used constantly),
     disk-delete x2, playlist import/create, tag-failures. Fix: add
     `aria-label="Close"`.
  3. Only 3 of ~13 modal overlays have `role="dialog" aria-modal="true"`,
     and `openModal()`/`closeModal()` (`renderer.js` ~1661-1674) never move
     focus into the modal, trap Tab inside it, or restore focus on close.
  4. No `aria-live` region for track changes (`#pb-title`/`#pb-artist`) or
     for `showAppNotice()`'s modal - screen reader users get no
     announcement when a track changes or a notice pops up. (Other
     surfaces, e.g. `#about-update-status`, already do this correctly - use
     them as the reference pattern.)
  5. `.album-card`, `.song-row`, `.queue-row`, and interactive
     `.rating-star` are plain unlabeled `<div>`/`<span>` elements with only
     mouse click handlers - no `role`, `tabindex`, keydown-for-Enter/Space,
     or (for stars) per-star `aria-label`. The custom context menu's
     individual items are already real `<button>`s with good semantics
     (use as reference), but the menu container itself lacks `role="menu"`
     and arrow-key navigation.
  6. `:focus-visible` styling (`styles.css` ~3162-3165) only covers real
     `<button>`/`<input>`/`<select>`/`<textarea>` plus a few specific
     component classes - once #5's elements get `tabindex`, they'll need
     matching `:focus-visible` rules added too.
  Next session: implement fixes in the priority order above, with real
  functional/DOM-text tests added to a new stable `test/accessibility.test.js`
  (not a buildNNN file).
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

## Ground rules

- Read `docs/ai/HIVE-ENDGAME-DEVELOPMENT-PROMPT.md` and
  `docs/ai/HIVE-METADATA-BACKEND-CANON.md` before touching playback or
  metadata code, and keep them updated if the canonical approach changes.
- Don't create a new `buildNNN-*.test.js` file per session. Edit the
  relevant stable test file instead.
- When a test fails, check `CHANGELOG.md` and `docs/ai/` for whether the
  code was *intentionally* changed before assuming it's broken.
