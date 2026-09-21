# Build 117 — Plugin Platform and Real Spectrum Audit

## Research conclusions

Music-player plugin ecosystems tend to expose a stable host API rather than treating plugins as cosmetic scripts. MusicBee's API is explicitly designed for player events, tag access, player control, and future GUI/streaming extensions. Spicetify separates extensions (modify existing behavior), custom apps (new pages), and themes (visual styling), and recommends event-driven extensions, cleanup, and avoiding polling. Electron provides sandboxed renderer processes and utility processes for CPU-heavy or crash-prone work, but Hive's current plugin runner is still trusted renderer JavaScript and is not yet a security sandbox.

## Real spectrum contract

GStreamer emits spectrum magnitudes in dB. Hive's native player now converts that data at the playback boundary into a canonical 64-band 0..1 level stream. Plugins consume that contract directly. The first-party Spectrum Visualizer previously normalized the already-normalized values a second time, which made the signal effectively collapse toward zero. Build 117 removes that second normalization.

The plugin must never own or replace playback. It receives analysis events and renders independently.

## First-party plugin examples

- **Spectrum Visualizer** — full-page radial/bar spectrum with live energy bloom, particles, rings, smoothing, and mirror mode. Enabled by default.
- **Signal Rings** — optional circular bass/body/air frequency instrument using the same real spectrum stream.
- **Session Pulse** — optional practical listening panel showing current track, playback state, elapsed time, and live bass/body/air energy.

Optional first-party plugins are disabled by default so the Now Playing workspace remains intentional. Settings now persists plugin enable/disable state.

## Current safety boundary

Build 117 adds explicit plugin enable state and an `audio` API surface (`getSpectrum`, `onSpectrum`), but plugin JavaScript still executes in the trusted renderer. This is intentionally documented rather than mislabeled as sandboxed.

Future platform work should move third-party execution behind a capability broker and isolated process. The broker should validate permissions and expose narrow APIs for player control, library access, artwork/tag writes, network, UI registration, and audio analysis. Plugin-local storage should be scoped to the plugin. A crashing or hung plugin should be terminable without taking the playback process down.

## Validation targets

- Native GStreamer remains the only local playback engine.
- No plugin may create an AudioContext or competing playback path.
- Spectrum data crosses the native boundary as a small numeric frame rather than PCM.
- Plugin lifecycle cleanup remains required.
- Disabled plugins are not injected or executed.
- Full runtime validation on Arch/Electron must still be performed by the user because this build environment cannot run the user's desktop GStreamer stack.
