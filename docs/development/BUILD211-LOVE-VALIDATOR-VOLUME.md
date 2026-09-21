# Build 211 — Love Validator + Volume Delivery

## Love/Favorites file normalization

Hive's native media tags remain authoritative for local Love/Favorites state. The
manual validator is intentionally read-only by default:

```bash
node scripts/hive-love-validator.js /path/to/Music
```

It recursively inspects supported audio files, reports every recognized Love
field/value it can read, identifies duplicate/conflicting/legacy Love metadata,
and writes a JSON audit report. Rating, POPM, and FMPS metadata are not used to
determine Love state.

For manual decisions:

```bash
node scripts/hive-love-validator.js /path/to/Music --interactive --apply
```

Each candidate requires an explicit decision:

- `l` — Loved: remove every recognized Love alias and write exactly
  `LOVE RATING=L`.
- `u` — Unloved: remove every recognized Love alias; absence is the canonical
  Unloved state.
- `s` — Skip.
- `q` — Stop without processing remaining candidates.

Every approved write is backed up before modification and then post-write
validated. Writes are delegated to Hive's existing metadata worker rather than
creating a second format-specific tag writer.

Build 211 also closes a worker-side alias gap: the metadata worker now removes
all historical Love aliases (`LOVE RATING`, `LOVE`, `LOVERATING`,
`MUSICBEE/LOVE RATING`, `MUSICBEE/LOVERATING`, and `MUSICBEE LOVE RATING`) when
normalizing MP3/WAV/M4A/FLAC Love state.

This gives us a direct way to compare the physical-file Loved count with Hive's
Favorites count. Star Favorites is still architecturally unlimited; the normal
5,000 smart-playlist cap must not apply to it.

## Volume

Build 207 already removed the old timer-based volume smoother. Build 211 keeps
that architecture but changes renderer-to-GStreamer delivery during dense range
input: the slider remains visually immediate, while native volume writes are
coalesced to a trailing 24 ms cadence. Pointer release and window blur flush the
latest value immediately.

This avoids flooding the native command path with every dense Chromium range
input event while preserving responsive final positioning.

## Validation

- Build 211 regression tests cover the manual Love workflow, alias coverage, and
  volume coalescing/final flush behavior.
- `node --check` is run on modified JavaScript files.
- `npm run check` and the full test suite are run before packaging.
- Electron GUI/GStreamer runtime validation is only reported if actually
  observed on the target desktop.
