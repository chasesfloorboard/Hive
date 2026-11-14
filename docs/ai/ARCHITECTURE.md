# Hive desktop architecture — the target module structure (the "file cabinet")

## Conventions for EVERY future change (read this first — this is how the ship stays clean)

These are binding for all desktop work, by anyone, from now on. Following them is what makes bug-fixing
exponentially easier: a bug lives in one small, named, tested file instead of somewhere in a 20k-line closure.

1. **New code goes in a focused module, never into `main.js` / `renderer.js`.** If you add a feature, create
   (or extend) a small single-concern module. If you fix a bug inside a monolith, prefer to *extract* the
   cluster you're touching into a module as part of the fix — leave the file smaller than you found it, never
   larger. The monoliths only ever shrink.
2. **One concern per file. Aim for < ~500 lines; anything over ~900 lints a warning** (`max-lines`) — treat
   that as "split me."
3. **Main process = a `createX(deps)` factory.** Dependencies injected (fs, path, getters, other modules), no
   hidden global reads, so it's unit-testable with fakes. Pattern: `json-store.js`, `database-worker-client.js`,
   `metadata-writer.js`.
4. **Renderer = a dual-mode module.** A standalone file that does `window.HiveX = …` for the app AND
   `if (typeof module !== 'undefined') module.exports = …` for node tests; `index.html` loads it via
   `<script>` BEFORE `renderer.js`; `renderer.js` calls `window.HiveX.fn(...)`. Pattern: `theme-schedule.js`,
   `equaliser.js`. Pure logic (no DOM/shared state) is extracted this way and node-tested; DOM/view code is
   verified in the running app.
5. **Every module ships with its own `test/<name>.test.js`** that asserts BEHAVIOUR, not source text. Never add
   a `buildNNN-*.test.js` file — edit the stable per-subsystem test. (Source-regex tests are the documented
   thrash anti-pattern; see CLAUDE.md "whack-a-mole".)
6. **The gate for every change:** full `node --test test/*.test.js` green (only the exfat `install.sh` mode
   artifact may fail here), `npm run lint` with 0 errors, and for DOM changes the app still launches and works.
7. **No silent `catch {}`** — rethrow, log, or leave a one-word reason. The linter warns on empty catches.

The mobile app (separate repo) is already modular (Gradle modules by concern); its equivalent conventions live
in that repo's `CLAUDE.md`. Both apps follow the same spirit: small, named, tested, one concern per file.

---

> The plan for breaking `app/main/main.js` (~9k) and `app/renderer/renderer.js` (~16k) into focused modules.
> Derived from a 10-region dependency map (2026-11-13). Execute leaf-first; each module is a `createX(deps)`
> factory (the pattern of the already-extracted `library-cache-store.js` / `metadata-writer.js` /
> `update-checker.js` / `atomic-file.js`). Every extraction: move the code, inject its deps, wire it back,
> `node --test test/*.test.js` green, app still launches — then the next drawer. Never a big-bang rewrite.
>
> Risk legend: **low** = pure/leaf, node-testable in isolation · **medium** = shared primitive, wide but
> shallow seam · **high** = owns mutable state many callers touch / DOM-coupled, do under supervision.

## Status
- [x] `atomic-file.js` — durable atomic replace (extracted 2026-11-13).
- [x] `user-data-backup.js` — the in-project profile backup mirror (2026-11-13).
- [x] `playback-state-store.js` — playback-recovery snapshot, durable sync write (2026-11-13).
- [x] `json-store.js` — the safe JSON layer (read/write/lock/stamp/temp-reap) (2026-11-13).
- [x] `config-store.js` — serialized config.json read-modify-write (2026-11-13). **Persistence region done.**
- [x] **renderer.js pure-logic set (2026-11-14), dual-mode `window.HiveX` modules, each node-tested, app
  smoke-verified:** `track-key.js`, `replaygain.js`, `search-text.js`, `cover-art.js`, `album-model.js`,
  `smart-rules.js`. Remaining renderer work is the DOM/view half (song table, album grid, sidebar, theme,
  tag editor) — supervised, verify in the running app.
- [x] `tooltip-system.js` (2026-11-15) — the global hover-tooltip system (themed replacement for native
  `title` popups + delegated `data-tooltip`, with a MutationObserver). First DOM/view-half extraction;
  pure helpers node-tested, install() + the title→aria-label a11y contract verified by a live CDP smoke run.
- [x] **renderer pure-logic set 2 (2026-11-15), each a dual-mode module loaded before renderer.js, node-tested
  for behaviour, and verified by a live CDP smoke run (module loads + works + the IIFE top-level destructure
  does not throw):** `queue-serialize.js` (queue/session snapshot (de)serialize + the queueSavedAt tie-break),
  `streaming-match.js` (`createStreamingMatch({isLocalPlaybackTrack,getLibraryTracks})`), `auto-tag-matching.js`
  (`createAutoTagMatching({normalizeForSearch})` — the MusicBrainz match/rank core).
- [x] **renderer DOM-feature modules (2026-11-15), each a createX({document,window,…}) factory with a pure,
  node-tested helper + the DOM paths verified live via CDP:** `tag-editor-fields.js`
  (`createTagEditorFields({nativeTagValue,normalizeMetadataText,normalizeLyricsText})` — removed a load/save
  cross-file dup), `marquee.js` (+ pure marqueeMetrics), `cover-rotator.js` (the shared 4s crossfade clock,
  injectable Image/timers), `sidebar-folder-tooltip.js` (+ pure clampFolderTooltip; fixed a latent NaN
  first-frame bug). These were the ranked seam-map leaves; the only ranked leaf left is `rich-text.js` (the XSS
  sanitiser — pure but DOMParser-dependent, so its node test needs a jsdom devDependency decision first).
- [x] `portable-folders.js` (MAIN, 2026-11-15) — portable library-folder (de)serialization,
  `createPortableFolders({fs,path,portableRoot})`, node-tested.
  NOTE: the renderer-section candidate names below (collection-hero, track-drag, etc.) predate the code and
  no longer match real clusters — the live seam map is the source of truth; trust a grep over the real source.
- [x] `library-folder-snapshot.js` — startup folder-mtime change detection (2026-11-14).
- [x] `library-scan-lock.js` — scan serialization lock + cancellation registry (2026-11-14).
- [x] `play-stats-store.js` — serialized play-stats.json mutations (2026-11-14).
- [x] `rating-reader.js` — embedded star-rating reader (POPM/FMPS), now unit-tested (2026-11-14).
- [x] `database-worker-client.js` — the DB subprocess + JSON-line transport + timeout (2026-11-14).
- [x] `library-boundary.js` — the write-path security guard (isTrackPathAllowedInLibrary) (2026-11-14).
- [x] `electron-flags.js` — fixed startup command-line switches (2026-11-14).
- [ ] everything below still to do. Next clean leaves: library-database (named DB commands),
      audio-transport-ipc, crash-reporter, updater-wiring, metadata-job-journal, hive-link/library-read,
      hive-link/media-providers. The `high` ones (scanner, watcher, host.js, DOM-coupled renderer, Hive Link
      auth) wait for a supervised app smoke run.
- main.js: ~9000 → 8380 lines across this work; every extraction is a createX(deps) factory with its own node
  unit test, wired via destructured names (call sites unchanged), full suite green.

## main.js → modules (safest first within each region)

### Persistence  (extract order: 1→4)
1. **user-data-backup.js** `low` — the in-project backup mirror (userBackupPathFor, restore on startup, snapshot on quit). True leaf.
2. **playback-state-store.js** `low` — the renderer's playback-recovery snapshot (durable sync write; saveTransportSync MUST stay sync).
3. **json-store.js** `medium` — the one safe JSON layer: readJsonSafe (damaged-file quarantine + backup recovery), writeJsonSafe, stampedJsonReader, removeStaleWriteTemps, withJsonFileLock. Requires `./atomic-file`.
4. **config-store.js** `medium` — serialized config.json read-modify-write (needs json-store's withJsonFileLock).

### Library scan  (1 library-folder-snapshot → 2 scan-lock → 3 progress-reporter → 4 worker-pool → 5 watcher → 6 scanner)
- **library-folder-snapshot.js** `low` · **library-scan-lock.js** `low` · **scan-progress-reporter.js** `low`
- **scanner-worker-pool.js** `medium` · **library-directory-watcher.js** `high` · **library-scanner.js** `high` (orchestrator, LAST)

### Database  (1 db-worker-client → 2 library-database vocab → 3 cache-reset → 4 read-service)
- **database-worker-client.js** `low` (the subprocess + JSON-line transport + the request timeout) · **library-database.js** `low` (named commands)
- **library-cache-reset.js** `medium` · **library-read-service.js** `medium` (the 3-tier cold read: gz → memory/json → SQLite)

### Native playback / stats  (1 play-stats-store → 2 rating-reader → 3 audio-transport-ipc → then the rest)
- **play-stats-store.js** `low` (withStatsMutation over play-stats.json) · **rating-reader.js** `low` · **audio-transport-ipc.js** `low`
- **track-ratings.js** `medium` · **play-counts-admin.js** `medium` · **mpris-projection.js** `medium` · **play-count-embed.js** `high` · **play-recorder.js** `high`

### Hive Link host wiring  (1 library-read → 2 media-providers → ... → host.js LAST)
- `hive-link/library-read.js` `low` · `hive-link/media-providers.js` `low`
- `hive-link/plays.js` `medium` · `hive-link/playlists.js` `medium` · `hive-link/song-sync.js` `medium` · `hive-link/presentation.js` `medium`
- `hive-link/metadata-writeback.js` `high` · `hive-link/host.js` `high` (composition root, LAST)

### Metadata/tag/artwork write handlers  (1 library-boundary → 2 metadata-job-journal → ...)
- **library-boundary.js** `low` (isTrackPathAllowedInLibrary — the security guard, zero state) · **metadata-job-journal.js** `low`
- **tag-helper-pool.js** `medium` · **library-write-guard.js** `medium` · **rating-store.js** `medium` · **play-count-writer.js** `medium`
- **love-writer.js** `high` · **metadata-save-queue.js** `high`

### Window + lifecycle  (1 electron-flags → 2 crash-reporter → 3 updater-wiring → ...)
- **electron-flags.js** `low` · **crash-reporter.js** `low` · **updater-wiring.js** `low`
- **media-protocols.js** `medium` · **run-marker.js** `medium` · **miniplayer-window.js** `medium` · **yearly-wrap-window.js** `medium`
- **main-window.js** `high` · **shutdown.js** `high` (ordered teardown, flushes the cache — LAST)

## renderer.js → modules
> Pure-logic modules (no DOM) are node-testable and safe to extract unsupervised. DOM/view modules
> (`high`) change what's on screen and must be verified in the running app — do under supervision.

### Playback  `app/renderer/playback/`
- **replaygain.js** `low` (pure gain calc) · **scrobble.js** `low` · **play-count.js** `low` · **scrubber-volume-ui.js** `low`
- **mpris.js** `medium` · **stream-provider.js** `medium` · **spotify-provider.js** `high` · **gstreamer-transport.js** `high`
- **queue-model.js** `high` · **transport-facade.js** `high` (the `audioEngine` object, LAST)

### Views  `app/renderer/views/`
- **cover-art.js** `low` · **album-model.js** `low` (pure grouping/sorting) · **search-filter.js** `low` (pure matching)
- **collection-hero.js** `low` · **track-drag.js** `low` · **selection.js** `medium` · **song-columns.js** `medium` · **library-folders.js** `medium`
- **song-table-view.js** `high` · **album-grid-view.js** `high` · **artist-view.js** `high` · **view-router.js** `high` (router, LAST, keep thin)

### UI shell
- **ui/tooltip-system.js** `low` · **library/smart-playlist-engine.js** `low` (pure evaluation)
- **ui/lyrics-view.js** `medium` · **ui/settings-shell.js** `medium`
- **theme/theme-system.js** `high` · **plugins/plugin-host.js** `high` · **navigation/sidebar-navigation.js** `high` · **tags/tag-editor.js** `high`

## Overnight-safe subset (no live-UI verification needed)
All main.js `low`/`medium` modules (node tests cover them) + the **pure** renderer modules
(`replaygain`, `album-model`, `search-filter`, `smart-playlist-engine`, `play-count`) extracted WITH their
own node unit tests. The `high` renderer view/theme/queue modules wait for a supervised app smoke run.
