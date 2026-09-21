# Build 40 — SpotX + Favorites Context Audit

## Spotify installer

Hive now treats SpotX-Bash as a required dependency for the Spotify integration when a local Spotify desktop installation is detected. SpotX is an external client patcher and is therefore handled as an explicit trust boundary:

1. Spotify must already be installed by the user/distribution.
2. Hive detects the real Spotify installation path before applying patches.
3. If the user lacks write access, Hive offers the narrower per-user ACL fix and asks for administrator authentication through `sudo`.
4. Only after that step does Hive offer to download SpotX-Bash from the official `SpotX-Official/SpotX-Bash` repository.
5. The downloaded script is stored in a private temporary file; its SHA-256 is displayed; execution requires explicit confirmation. Hive does not use `curl | bash`.
6. SpotX is run before Spicetify, matching the SpotX-Bash FAQ's documented order for using both tools, while noting that SpotX-Bash and Spicetify do not officially support the combined configuration.
7. Hive records successful Hive-managed SpotX setup in per-user state so the patcher is not repeatedly executed.

Source verification: the current SpotX-Bash documentation says SpotX-Bash should be run after Spotify is installed and states that if SpotX-Bash and Spicetify are used together, SpotX-Bash should be run first; it also explicitly says the combined setup is not officially supported by either project.

## Favorites/view synchronization

The screenshot regression had two independent visual-state problems:

- The rendered Favorites content could be Tracks while the toolbar still visually highlighted Albums because `showLibraryView()` rendered the collection without synchronizing the toolbar buttons.
- A restored Music tab carrying `specialView === 'favorites'` could leave the generic Music sidebar item visually active instead of the Favorites destination.

Build 40 adds a single context synchronization path used by both collection rendering and tab-state restoration. The content renderer, toolbar selection, and sidebar selection now derive from the same `specialView` + `viewMode` state.

## Validation targets

- `node --check app/renderer/renderer.js`
- `node --check app/main/main.js`
- `node --check app/main/preload.js`
- `bash -n install.sh`
- installer assertions for SpotX consent, official source, no `curl | bash`, ACL path, and path normalization
- renderer assertions for Favorites context and view-button synchronization
- ZIP integrity

Runtime Spotify/Spicetify execution is not claimed in the build environment.
