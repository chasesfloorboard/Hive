# Podcast transport, search, and UI audit — Build 44

## Request

Fix a mixed-queue bug where a podcast queued behind a local song could be played by more than one audio transport, improve podcast searching and clearing, and overhaul the Podcasts tab UI.

## Transport fix

Hive has three playback transports: local GStreamer/Web Audio, Spotify, and the podcast HTML media element. A virtual podcast track must never be treated as a local file for gapless pre-buffering or GStreamer NEXT handling.

Build 44 therefore:

- defines local playback tracks as tracks that are neither Podcast nor Spotify virtual tracks;
- prevents Web Audio `armGaplessNext()` / `prepareNextBuffer()` from pre-buffering podcasts or Spotify tracks;
- prevents GStreamer from advertising/queuing Podcast or Spotify tracks as native NEXT streams;
- only enters GStreamer `ABOUT_TO_FINISH` waiting mode when the next track is a compatible local GStreamer track;
- tears down local/Spotify transports before starting podcast playback;
- explicitly stops the podcast HTML media element when a queue transition leaves a podcast.

Cross-transport transitions intentionally use a handoff rather than attempting gapless decoding between incompatible playback engines. The priority is one audible transport at a time and correct queue progression.

## Search improvements

- Search can run from the button or Enter.
- Search is debounced while typing (450 ms) after two characters.
- Older asynchronous search responses cannot overwrite a newer search.
- Added a dedicated clear (`×`) control.
- Escape clears the active search.
- Clearing removes the persisted podcast search value as well as the visible query.
- Empty, loading, zero-result, and error states are explicit.
- Result count is displayed.
- Search placeholder now communicates that show names, hosts, and topics can be used.

The underlying public iTunes podcast directory remains the existing source; Build 44 does not add an unverified third-party podcast index.

## UI overhaul

The Podcasts tab now has:

- a dedicated discovery hero/search area;
- stronger visual hierarchy and spacing;
- Quick Access favorite-show cards;
- a responsive results grid;
- larger show artwork;
- cleaner expandable episode lists;
- bounded episode scrolling to avoid enormous open feeds;
- loading, empty, and retry states;
- improved mobile/narrow-window behavior;
- themed controls consistent with Hive's existing dark UI.

No playback controls or GStreamer pipeline code was replaced.
