# Glass Hive Logo — Build 81

## Scope

Build 81 establishes the frosted-glass hexagon as Hive's shared application brand mark. The legacy bee emoji is removed from the primary top-left Hive button and About dialog.

## Asset

`resources/hive-logo-glass.png` is a high-resolution RGBA PNG. The area outside the hexagonal glass silhouette is transparent, allowing the mark to sit cleanly on Hive's existing glass/ambient surfaces without a baked-in background.

## Integration

- `app/renderer/index.html` renders the shared logo element in the top-left brand button and About dialog.
- `app/renderer/renderer.js` obtains the brand image through the existing preload bridge.
- `app/main/main.js` resolves the same resource for Yearly Wrap branding and the Linux tray icon.
- No second logo-loading system or direct renderer filesystem access was introduced.

## Validation

- Dedicated logo tests: 2/2 passed.
- JavaScript syntax checks: passed.
- Project checker: passed.
- Full suite: 47/48 passed. The one failure is the pre-existing missing `node_modules/music-metadata/lib/index.js` dependency used by `artwork-payload.test.js`; no forced dependency changes were made.
- Runtime visual verification was not performed in this environment.
