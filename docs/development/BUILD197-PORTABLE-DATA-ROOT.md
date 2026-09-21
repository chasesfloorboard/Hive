# Build 197 — Portable Data Root Audit

## Root cause

Hive already attempted to use portable `userData`, but the Linux launcher deliberately runs every build through one stable Electron executable at `~/.local/share/hive/runtime/electron`. `main.js` derived its portable application root from `app.getPath('exe')`, so the root resolved relative to the stable runtime rather than the actual Hive build folder. This made persistent data appear outside the portable build and made Favorites/navigation persistence differ from expectations across copied builds.

## Fix

The launcher now exports `HIVE_PORTABLE_ROOT` containing the actual current build directory. `main.js` gives this explicit path precedence when calculating the portable root, and sets Electron `userData` to `<portable-build>/data`.

Build 197 was a transitional migration build. The next portable build intentionally removes that migration behavior: a freshly extracted build must behave like a clean first install and must not import machine-global Hive state.

## Persistence covered

Because Electron `userData` is the application data root, this moves Hive's app-owned persistent data together with the build, including configuration, renderer localStorage/session data, playlists, library caches/state, playback state, covers, plugins, and provider state stored there.

## Validation

- `test/build197-portable-data-root.test.js`
- Existing portable integrity regression suite
- Existing launcher stability suite
- Full JavaScript test suite
- `npm run check`
- ZIP integrity and BUILD marker verification

GUI runtime validation is not performed in the build environment.
