# Build 198 — Clean Portable First-Run

## Intent

A freshly extracted Hive portable build is a clean-install simulation for development and user testing. It must not inherit or migrate an existing Hive profile from the host machine.

## Portable data contract

- `HIVE_PORTABLE_ROOT` identifies the actual extracted Hive folder.
- Electron `appData`, `userData`, and `sessionData` are explicitly rooted beneath `<portable-root>/data/`.
- Renderer localStorage/session state therefore belongs to the portable folder instead of the host's normal Electron profile.
- The stable Electron runtime used for Discord/Music Presence identity does not own Hive application data.
- Hive never silently falls back to the machine-global Hive profile when portable data initialization fails.

## Clean-install contract

- No migration is performed from `~/.config`, `~/.local/share`, the stable Electron runtime, or any other previous Hive profile.
- A fresh extraction contains no user-created `data/` or session state.
- After first launch, Hive writes its newly-created persistent state into the portable folder.
- Copying a configured portable folder carries that Hive state with it.
- Extracting the original ZIP again starts clean.

## Validation

- Dedicated clean-portable regression tests pass.
- Full JavaScript suite has one known pre-existing failure because the supplied development environment lacks `node_modules/music-metadata/lib/index.js` for the embedded-artwork scanner test.
- `npm run check` passes.
- Main/preload/renderer JavaScript syntax checks pass.
- Linux launcher shell syntax check passes.
- Final ZIP is checked to contain no pre-existing portable `data/` or runtime log contents.
- No GUI/runtime Electron validation was performed in this build environment.
