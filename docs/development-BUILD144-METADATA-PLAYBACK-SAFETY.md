# Build 144 — Metadata Editing and Playback Safety

## Playback safety

Metadata writers replace complete media files. Build 144 tracks the path currently owned by the GStreamer transport and prevents Love, rating, tag, or artwork replacement jobs from touching that path until playback releases it. A bounded timeout fails the metadata operation instead of risking an unsafe audio transition.

## Editing

- Blank editable fields use `Empty` when no more specific placeholder is supplied.
- Start and stop trim fields use `00:00.000` to communicate millisecond precision.
- Tags (2) treats native metadata values as editable regardless of whether the same field is also represented on Tags 1. Existing native fields can be edited or removed without changing the Tags 1 presentation.

## Validation

Targeted metadata/playback regression tests: 6/6 passed.
Full test suite: 217/219 passed. The two failures are pre-existing environment/fixture failures: missing `music-metadata` module in the artwork scanner fixture and missing MusicBee Wrapped archive fixture.
`npm run check`: passed. JavaScript and shell syntax checks: passed.

Runtime audio validation was not performed in this environment; the loud left-channel Love regression still requires testing with the affected track on the user's Linux audio setup.
