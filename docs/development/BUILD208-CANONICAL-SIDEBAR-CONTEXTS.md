# Build 208 — Canonical Sidebar Contexts

## Problem

Sidebar destinations were modeled as navigation into shared renderer state. The renderer had already begun creating canonical navigation tabs, but top-level surfaces still wrote through the active `el` bindings and some renderers used document-global selectors. Hidden canonical contexts therefore remained vulnerable to stale DOM/state reuse: a Podcasts surface could initialize once and later appear empty, while Playlist/Sandbox/other surfaces could paint into the wrong active destination.

## Architecture

Build 208 makes the canonical sidebar destination the owner of its visual context.

- Every non-divider sidebar destination receives one persistent canonical context/tab, whether pinned or unpinned.
- `hidden` only controls top-bar projection. It does not control whether the context exists or can be activated from the sidebar.
- Sidebar activation resolves the destination's canonical `navId` context before rendering.
- Each canonical context receives its own persistent `tab-content-host` and DOM surface.
- Playlist Manager resolves its own canonical Playlists tab DOM rather than using `document.getElementById()` for the manager list.
- Podcasts resolves its own canonical Podcasts tab DOM and stores initialization state on that context instead of on a shared element dataset.
- Sandbox launcher/plugin surfaces and Yearly Wrap receive the active canonical tab explicitly and paint into that tab's `contentTools` surface.
- Existing Music `+` tabs remain independent user-created Music browser contexts.

## Regression protection

The Build 208 tests cover:

1. canonical contexts for pinned and unpinned sidebar destinations;
2. canonical destination resolution before rendering;
3. persistent per-context DOM hosts;
4. Playlist Manager isolation from non-Playlists tabs;
5. per-context Podcasts initialization and DOM scoping;
6. top-level Sandbox/Yearly Wrap surface ownership;
7. existing async tab-isolation regressions;
8. existing Playlist/Sandbox UI contracts.

## Validation

- `node --check app/renderer/renderer.js` — passed.
- Targeted canonical/navigation regression tests — passed (21/21).
- Full `npm test` — 429 passed; the remaining known failure is the pre-existing environment/dependency test `artwork-payload.test.js`, which cannot load `node_modules/music-metadata/lib/index.js` from the supplied source tree. No dependency was forcibly changed to make that test pass.
- No Electron GUI/runtime validation was available in this environment.
- No Stable build was modified.
