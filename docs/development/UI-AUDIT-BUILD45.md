# Hive Build 45 — Editorial UI audit

## Verdict
The navigation model was the clearest structural inconsistency: Navigation layout and Top tabs described two different systems. Build 45 makes the top bar a pinned projection of the Navigation layout and removes the duplicate Top tabs editor.

## Improvements shipped
- Pin/unpin controls live beside each navigation destination.
- Top bar reflects pinned destinations in navigation order.
- Music remains the primary unremovable destination.
- Built-in base Playlist/Podcast surfaces remain internal and do not create duplicate visible tabs.
- Binary controls use one left/right switch language throughout the interface.
- Appearance now has five deliberately restrained built-in themes rather than an empty/custom-CSS-first presentation.
- Now Playing has an animated, theme-aware visualizer with Rounded and Edgy rendering modes.

## Editorial findings still worth watching
1. **Now Playing hierarchy:** artwork remains the visual anchor; metadata and visualizer should not compete with it. If the queue panel becomes narrower, the visualizer should stay compact rather than force the cover below the fold.
2. **Theme selection:** the five presets are intentionally different in temperature and mood without becoming novelty skins. Future themes should be held to this bar.
3. **Navigation density:** pinning many destinations can crowd the top bar. The current top-bar overflow behavior should be tested with all nine destinations pinned. A future pass could introduce horizontal scrolling or a compact overflow menu if needed.
4. **Settings density:** Settings is now coherent, but some Community/Extensions areas remain information-dense. These should be treated as a later information-architecture pass rather than adding more nested cards.
5. **Visualizer performance:** the visualizer is procedural and does not create a second playback engine or decode audio. Runtime GPU/frame-time testing on the user's real Wayland setup is still required before calling it performance-proven.

## Protected behavior
- GStreamer remains authoritative for local playback.
- Podcast/Spotify transport separation remains intact.
- Player Shuffle is not coupled to collection visual auto-shuffle.
- MPRIS remains the external playback-state authority.
