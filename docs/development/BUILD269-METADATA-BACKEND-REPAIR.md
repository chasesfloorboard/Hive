# Build 269 — Portable Metadata Backend Repair

## Problem

The Build 268 source archive contained `resources/python/tag_helper.py`, whose canonical backend imports Mutagen from the sibling `resources/mutagen/` directory. The archive did not actually contain that directory.

On a machine without a system-level Mutagen installation, starting the helper failed during Python import before the JSON-lines request loop began. Electron then observed the helper process exiting, retried the metadata job three times, and reported only the generic `Metadata operation failed after 3 attempts` message.

## Fix

- Vendor Mutagen 1.47.0 under `resources/mutagen/`.
- Keep `tag_helper.py`'s existing `HERE.parent` import path; this remains the canonical backend arrangement.
- Add regression coverage using `python3 -S`, which disables normal site-package discovery, proving that Hive's bundled Mutagen is sufficient.
- Preserve the existing staged backup, verification, and atomic replacement architecture.

## Validation

- Portable isolated Mutagen import: passed.
- Portable isolated metadata write (`Brain Stew` test title/artist on a temporary MP3): passed.
- Metadata backend canon suite: 4/4 passed.
- Full `npm test`: 544/546 passed. The remaining two failures are source-archive environment issues unrelated to this fix: the checkout lacks installed `node_modules/music-metadata/lib/index.js`, and the extracted source tree originally lost shell executable bits. The latter was restored in the release tree.

## Runtime status

This environment cannot launch the user's real Electron/audio setup. The user should test an actual metadata edit in Hive after installing Build 269, especially the previously failing file.
