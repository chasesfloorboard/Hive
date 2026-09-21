# Hive End-Game Development Prompt

This document is the persistent engineering context for AI-assisted development of Hive (BeehiveMusicBrainz). It is intentionally much larger than the short ChatGPT bootstrap prompt. When a new AI session receives a Hive source ZIP, it should locate and read this file before making substantive changes.

## Mission

Hive is approaching the end-game of development. Do not treat the project as a sequence of disposable prototypes. Build toward a coherent, maintainable, polished 1.0 pre-release architecture while continuing to fix real bugs and improve the product. “End-game” does not mean shipment-ready or feature-frozen; it means that new work should increasingly become permanent architecture rather than temporary scaffolding.

The priorities, in order, are:
1. Correctness and preservation of working behavior.
2. Architectural coherence and maintainability.
3. Regression prevention and safe migrations.
4. Runtime stability and diagnosability.
5. Performance and responsive UI.
6. Professional UX and visual consistency.
7. New features only when they fit the architecture.

## Development loop

For every substantial change:
- Inspect the existing implementation and identify the real source of truth before editing.
- Map dependencies and likely regression surfaces.
- Design the permanent location, data model, persistence behavior, failure behavior, and migration path.
- Implement the smallest coherent change; do not duplicate existing systems.
- Run syntax/static checks and relevant tests.
- Perform targeted runtime verification when the environment permits it.
- Audit adjacent behavior for regressions.
- Clearly distinguish static validation from runtime validation. Never claim a runtime result that was not actually observed.
- Package only after validation. If runtime testing exposes another release-blocking defect, fix it before presenting the build when practical.

Do not use `npm audit fix --force`. Do not introduce forced dependency churn merely to make tests pass.

## Metadata and artwork backend canon

The permanent metadata architecture is defined by `docs/ai/HIVE-METADATA-BACKEND-CANON.md`. Read it before changing tags, ratings, Love, artwork, auto-tagging, MusicBrainz matching, or metadata persistence.

The canonical direction is: GStreamer for playback; bundled Mutagen for local metadata writes; music-metadata for the established read-side normalization path; MusicBrainz for canonical community metadata; optional Chromaprint/AcoustID for audio identification; Picard/beets as matching/UX references; TagLib as a researched native alternative that must not become a competing live writer without a proven migration.

There must be one authoritative write path per metadata operation. Do not add renderer-side metadata writers, FFmpeg metadata rewrites, handwritten MP4 atom reconstruction, or another parallel tag library. All metadata writes must use staging, recovery backup, post-write verification, and protected-field checks.

## Protected architecture

Treat established working systems as protected baselines unless there is a demonstrated reason to change them.

### Local playback
- GStreamer is authoritative for local audio.
- Preserve the persistent playbin/playbin3 approach and seamless `about-to-finish` queue handoff.
- Preserve the known-good scrubber behavior: `isScrubbing` must clear after click/drag; window pointerup/pointercancel/blur fallbacks remain; renderer playback time may interpolate smoothly, but native GStreamer position remains authoritative; GStreamer owns seeking; preserve the 10 ms anti-pop ramp.
- Do not create competing playback engines for local files.
- Unexpected helper failure may use bounded recovery, but never an unbounded respawn loop.

### Media sources
Hive is a unified player UI over multiple media providers, not a single transport for everything:
- `local`: GStreamer/native files.
- `spotify`: Spotify desktop/Spicetify remains the streaming engine. Hive must not download Spotify audio.
- `podcast`: remote podcast streams use the existing podcast playback path and must not replace or alter local GStreamer.

Keep provider-specific logic isolated behind clear source/type boundaries. Mixed queues are valid.

### MPRIS and Rich Presence
MPRIS is already implemented and is a first-class integration. Do not replace it with another Linux media-control path.
Music Presence is the sole Discord Rich Presence publisher. Hive must not connect directly to Discord IPC or publish Discord activities. Hive should expose accurate metadata/artwork/playback state through MPRIS so Music Presence can consume it.

External integrations must never become fatal dependencies of the core local player.

### Library, metadata, favorites, artwork
- Incremental scans return bounded deltas when possible; do not resend the entire large library snapshot for an unchanged scan.
- Full authoritative scans remain available.
- Avoid redundant large cache rewrites when nothing changed.
- Native tags are the source of truth for Love/Favorites and ratings; do not make the renderer cache authoritative.
- Multi-file tag editing uses `Multiple Values` for differing fields and preserves untouched per-file values.
- Embedded artwork is preferred over temporary/remote artwork.
- Temporary artwork must not silently become permanent files.
- Artwork providers remain modular; network artwork lookup must not be coupled to playback or scanning.
- Never retain decoded DOM Image objects as a long-lived cover cache.

### Persistence
User configuration is durable product behavior. Navigation order, visibility, custom labels/dividers/sizes, settings, playback state, favorites, artwork state, and external-provider state need stable schemas and backward-compatible loading where practical. New persisted structures should have defaults and tolerate older versions.

## Spotify end-game direction

Spotify should be modeled as an external provider with normalized metadata rather than as generic tracks whose album is simply “Spotify”. The preferred normalized state includes source/type, URI/ID, title, artist, album, album artist, duration in seconds, position, artwork, liked state, playing/paused state, and provider-specific context where useful.

Use the Spicetify Player API as the bridge's source of truth. Remember that Spotify duration/progress APIs are commonly milliseconds and Hive's internal duration is seconds; normalize exactly once at the boundary. Spotify artwork should be primary when available, with Hive artwork providers as fallback rather than the first choice.

Spotify Likes must remain conceptually distinct from Hive local Favorites even if the UI eventually provides a unified collection view. Spotify commands must fail gracefully when Spotify/Spicetify is unavailable. Never run Spicetify as root; system Spotify installations may require one-time filesystem permission preparation.

## Podcasts end-game direction

Podcasts are a native Hive source. Persist favorite shows and/or saved episodes deliberately rather than treating search results as the collection. Preserve RSS metadata, artwork, publisher information, feed identity, episode identity, and playable stream URLs. Podcast state should be distinguishable from local music and Spotify tracks in MPRIS and the UI.

## UI / UX standards

Hive should look and behave like a professional desktop application, not a collection of browser demos.
- Reuse the established themed dialog/modal system.
- Nested dialogs must stack correctly above their parents.
- Avoid native-looking controls when an established Hive control language exists.
- Preserve smooth drag/drop and animation behavior.
- Settings is a permanent application surface and should be organized, scrollable, coherent, and immediately usable.
- Navigation customization is user-owned: sidebar destinations may be reordered/hidden/renamed; visual dividers and their sizes are persistent features; the top bar is a projection of pinned navigation destinations and follows navigation order. Independent + music tabs remain separate browser tabs.
- Do not add decorative complexity that harms density, readability, or performance.
- Frosted Now Playing behavior and other defaults should be explicit and persisted.

## Filesystem / portable architecture

The source tree is intentionally organized as a portable application. Keep implementation under `app/`, bundled runtime resources under `resources/`, diagnostics under `logs/`, documentation under `docs/`, tests under `test/`, scripts under `scripts/`, and developer utilities under `tools/`. Root-level files should primarily be project metadata, documentation, installers, launchers, and package manifests.

Runtime paths must resolve from the project root in development and from the packaged application resources when packaged. Do not scatter absolute development paths through the code.

Hive should be movable as a folder while keeping its bundled application/resources intact. Only genuine system dependencies (for example Arch-installed GStreamer/Electron/system integration requirements) should live outside the portable tree.

## Logging and diagnostics

Every Hive launch gets one TXT session log in `logs/` when the portable root is writable, with a user-data fallback when it is not. The session log is authoritative and should contain detailed startup, runtime, renderer warning/error, provider, crash, and shutdown diagnostics. Keep the newest 20 session logs. `scan-live.log` is auxiliary. Terminal output should remain useful rather than spammy: known repetitive health/cache noise may be filtered from the terminal but must remain available in the session TXT.

A bug that cannot be diagnosed from a single boot/crash session log is not considered adequately instrumented when adding new runtime-critical behavior.

## Release/build discipline

This project is a 1.0 pre-release, not a final shipment. Builds are development artifacts and may still expose known limitations. However, build artifacts must be consistently named.

Use this exact ZIP convention:
`Hive-1.0.0-pre-release-buildNN-purpose.zip`

Examples:
- `Hive-1.0.0-pre-release-build26-spotify-provider.zip`
- `Hive-1.0.0-pre-release-build27-stability-audit.zip`

`NN` is the sequential build number. `purpose` is short, lowercase, hyphen-separated, and descriptive. Do not invent unrelated naming schemes, alternate version labels, or random suffixes. Keep the package's internal semantic version independent unless an actual application version change is intended.

## When uncertain

Prefer the existing working architecture over a clever rewrite. Search the codebase before creating a new helper, service, cache, persistence store, or provider abstraction. If two systems already perform the same job, consolidate rather than add a third. If a feature request conflicts with a protected invariant, preserve the invariant and redesign the feature around it.

When handing a build to the developer, report:
- exact build name and download path;
- what changed;
- what was statically validated;
- what was runtime-tested;
- known failures/limitations;
- whether the next step is testing, another audit, or another build.
