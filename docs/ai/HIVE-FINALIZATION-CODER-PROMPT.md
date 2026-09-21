# Hive 1.0 Finalization — Engineering Prompt

This document is the authoritative finalization operating guide for Hive/BeehiveMusicBrainz. Read it before making or packaging any development build. The repository, this document, and the existing build history are the source of truth.

## Mission
Finish Hive 1.0 by fixing regressions, completing existing UI work, and preserving proven behavior. Do not rewrite working systems for elegance. A change is successful only when the requested behavior works without disturbing unrelated behavior.

## Canonical UI
Hive Build 219 is the canonical UI baseline. Preserve its layout, styling, spacing, theming, controls, dialogs, tabs, queue, artwork presentation, and interaction language unless the user explicitly requests a UI change. Stable builds are immutable.

## Engineering rules
1. Inspect the actual implementation and relevant history before changing anything.
2. Trace the complete behavior path before diagnosing a bug: UI → renderer → IPC → native/backend → observable result.
3. When the user has already identified a likely cause, treat that information as a hypothesis to verify—not something to rediscover or contradict without evidence.
4. Prefer the smallest permanent fix that fits the existing architecture. Consolidate competing paths instead of adding layers.
5. Preserve GStreamer-authoritative local playback, persistent playbin/playbin3, seamless queue handoff, native seeking, scrubber invariants, and the 10 ms transport anti-pop ramp. Ordinary volume control must remain separate from transport ramping.
6. Preserve queue, playback persistence, Favorites/Love/rating, artwork, tabs, theming, MPRIS, plugins, scrobbling, Spotify/Spicetify, podcasts, and portable-library behavior.
7. Metadata/tagging/artwork/autotag work must follow `docs/ai/HIVE-METADATA-BACKEND-CANON.md`. Use one authoritative write backend, staged recovery-safe writes, verification, and community-backed identification/matching.
8. Never use `npm audit fix --force` or forced dependency churn.
9. Test the changed path and adjacent regression surfaces. Clearly separate static inspection from runtime testing.
10. If testing exposes a regression, fix it before handoff when practical. If another development build is required, make the next build rather than stopping at a broken intermediate state.
11. Development builds go in Editor Builds using the existing sequential build number. Never modify Stable.

## Finalization mindset
We are stabilizing a product, not accumulating patches. Every change should reduce uncertainty, preserve known-good behavior, and leave the codebase easier to reason about. When uncertain, preserve the working implementation and investigate before changing it.
