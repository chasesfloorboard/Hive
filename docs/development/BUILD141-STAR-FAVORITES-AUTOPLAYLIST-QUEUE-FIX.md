# Build 141 — Star Favorites Auto Playlist + Queue Visibility Fix

## Star Favorites

- Added a persisted `Star Favorites` playlist record using the existing Smart/Auto Playlist schema.
- Its default rule is `Love is Loved`, with automatic library evaluation rather than a stored track list.
- The Favorites sidebar resolves this same playlist record, so edits to the Auto Playlist rules affect the Favorites view as well as the playlist manager.
- Existing Smart/Auto Playlists can now be opened in the same editor used to create them.
- Editing preserves the playlist ID and dynamic `smart:true` behavior.
- Smart/Auto Playlist rows are labeled `AUTO PLAYLIST` and expose the same editing/renaming surfaces as user-created playlists.
- The shipped Star Favorites record includes an instructional description showing that `Love is Loved` is the example rule users can recreate with the Smart Playlist creator.

## Queue

- Pooled queue rows now use an explicit absolute `top` offset for their queue index instead of relying on a translated list item.
- This preserves bounded virtualization while making newly queued large collections, including Favorites, remain in the queue scroll layer.

## Preservation

- GStreamer remains the authoritative local playback engine.
- Compact queue/transport persistence remains intact.
- Favorites/Love native-tag behavior remains unchanged.
- No Spotify playback architecture changes were made.
