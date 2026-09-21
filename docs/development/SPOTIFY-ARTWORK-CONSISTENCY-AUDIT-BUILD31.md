# Build 31 — Spotify artwork consistency audit

Build 30 fixed the provider conversion problem, but the audit found a second class of issues: several established Hive render paths consumed only the legacy `track.cover` field instead of the canonical external-artwork resolver. That meant a Spotify item containing `artworkUrl` could still render without art in some views.

## Surfaces audited

| Surface | Build 30 path | Build 31 result |
| --- | --- | --- |
| Albums | `buildAlbums()` → album card | Fixed: album grouping now resolves `visualCoverForTrack()` and retains Spotify artwork metadata. |
| Expanded album | `makeInlineTrackDropdown()` → `album.cover` | Fixed indirectly by the album model: expanded album now receives the same resolved external artwork as the album card. |
| Tracks | `songRowHtml()` → `t.cover` | Fixed: song thumbnails use `visualCoverForTrack()`. |
| Queue | `queueRowHtml()` → `visualCoverForTrack()` | Already correct; retained. |
| Now Playing / playbar | `updateNowPlayingUI()` → `visualCoverForTrack()` | Already correct; retained. |
| Artists | `buildArtistPickerEntries()` → `t.cover` | Fixed for consistency, even though it was outside the requested five surfaces. |
| History | persisted play snapshot | Hardened so Spotify `artworkUrl`, source, and URI survive history reconstruction. |
| Spotify playlist import | bridge + public fallback | Already carried artwork; renderer preserves both `cover` and `artworkUrl`. |
| MPRIS / Music Presence | `visualCoverForTrack()` → external artwork URL | Already correct; Spotify artwork is passed as an HTTP artwork URL. |

## Canonical rule

Spotify artwork is now resolved through the same priority path wherever a track is rendered:

1. real embedded/local artwork, when present
2. Spotify external artwork (`artworkUrl` / normalized `spotify:image:`)
3. temporary automatic artwork for coverless local tracks
4. placeholder

This keeps local artwork authoritative while preventing provider artwork from being lost merely because one UI surface reads a legacy field.

## Spotify provider contract

Spotify's Web API exposes album cover art as image URLs, including `https://i.scdn.co/image/...`; track responses expose the album image set as well. citeturn0search0turn0search1

Hive does not download Spotify audio or write Spotify artwork into local music files. External artwork remains an external visual URL.

## Validation

- `node --check app/renderer/renderer.js` — PASS
- `node --check app/main/main.js` — PASS
- `node --check resources/spicetify/hive-spotify-bridge.js` — PASS
- `bash -n install.sh` — PASS
- `bash -n run.sh` — PASS
- `node scripts/check.js` — PASS
- static Spotify surface audit — PASS
- ZIP integrity — PASS
- `npm test` — expected 19/20 environment result; remaining failure is the known missing `node_modules/music-metadata/lib/index.js` dependency in the build environment.
- Runtime Spotify/Spicetify playback was not available here, so runtime success is not claimed.
