# Build 47 — live Now Playing spectrum + Spotify playback audit

- Removed the Build 45/46 synthetic visualizer from the right-side Now Playing card.
- Removed the rounded/edgy visualizer selector from Settings.
- Added a real 64-band GStreamer spectrum analyzer to the authoritative native playback pipeline.
- Added a dedicated live spectrum page to the left-sidebar Now Playing destination.
- Added a bounded Spotify desktop URI fallback when the Spicetify bridge is unavailable.
- Hardened the public Spotify playlist import fallback so artwork URLs are retained when Spotify's page data nests them.

The spectrum is real FFT magnitude data from GStreamer's `spectrum` element; it is not generated animation. Spotify remains an external playback provider and is not routed through Hive's local audio engine.
