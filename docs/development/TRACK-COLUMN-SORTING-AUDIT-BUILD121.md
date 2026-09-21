# Track Column Sorting Audit — Build 121

## Reported behavior

Header clicks did not behave like ordinary typed columns. The expected behavior is:

- Title → alphabetical A→Z, second click Z→A.
- Artist/Album/etc. → alphabetical.
- Plays → numeric low→high, second click high→low.
- Year/Track/Disc/Rating/Length/Bitrate/Sample Rate/Date Added → numeric.

## Root cause

The previous implementation mixed display formatting with sorting. It maintained a hard-coded numeric-key list and converted several fields through display-oriented getters. This made the sort behavior dependent on presentation formatting and also gave numeric columns a different first-click direction from text columns.

## Build 121 design

Each song-column definition now declares `type: 'string'` or `type: 'number'` and, where necessary, a `sortGet` function that returns the underlying value. Display getters remain responsible only for what the user sees.

The comparator then chooses the operation from the declared type:

- strings: `Intl.Collator` natural lexical comparison
- numbers: numeric comparison of the underlying value
- equal values: deterministic Title → Artist → Album tie-break

New columns begin ascending; repeated clicks toggle direction.

## Verification

- `test/ui-sort-controls.test.js`: 6/6 passed.
- Production `sortTracks` was exercised through a VM harness with Title and Plays fixtures: A→Z, low→high, and high→low all passed.
- Full suite was run separately; remaining failures are documented in the build report and are unrelated existing environment/architecture mismatches.
