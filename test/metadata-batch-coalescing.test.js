const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('tag editor coalesces per-file tag and artwork work into one metadata job', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /Coalesce all changes for each file into one durable metadata job/);
  assert.match(source, /const metadataByPath = new Map\(\)/);
  assert.match(source, /entry\.artwork = \{/);
  assert.match(source, /const metadataJobs = \[\.\.\.metadataByPath\.values\(\)\]/);
  assert.doesNotMatch(source, /const metadataJobs = \[\s*\.\.\.backgroundTagJobs\.map/);
});

test('auto-tag album maps and queues all safely matched tracks and one shared front cover', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function applyAutoTagRelease(modal)');
  const end = source.indexOf('\n  async function openAutoTagAlbum(album)', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /mapped\.length !== albumTracks\.length/);
  assert.match(block, /autoTagChangedFields\(m\.local, m\.remote, release\)/);
  assert.match(block, /window\.beehive\.downloadSearchCover\(release\.artworkUrl\)/);
  assert.match(block, /kind:'metadata'/);
  assert.match(block, /action:'write'/);
  assert.match(block, /pictureType:'Cover \(Front\)'/);
  assert.match(block, /window\.beehive\.queueMetadataSave\(jobs\)/);
});

test('auto-tag album preview uses the downloaded cover data URL, not the raw temp download path', () => {
  // coverSrc() only routes bare filesystem paths through window.beehive.coverUrl(),
  // which the main process resolves as mbcover://<name> -> path.join(COVERS_DIR(), name)
  // -- scoped to Hive's own persistent covers cache directory, not an arbitrary
  // absolute path. cover:downloadSearchResult's returned `path` is a raw OS temp
  // download path (app.getPath('temp')/beehive-artwork/...); joining that onto
  // COVERS_DIR() resolves to a nonexistent file, so the album grid rendered a
  // genuine broken-image icon instead of Hive's own placeholder immediately
  // after Auto-tag ran. coverSrc() already special-cases data: URLs for exactly
  // this optimistic-preview-before-the-background-write-lands case, so the
  // preview must use the returned `dataUrl`, not `path`.
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function applyAutoTagRelease(modal)');
  const end = source.indexOf('\n  async function openAutoTagAlbum(album)', start);
  const block = source.slice(start, end);
  assert.match(block, /coverDataUrl\s*=\s*String\(chosen\?\.dataUrl \|\| ''\)/);
  assert.match(block, /if \(coverDataUrl\) local\.cover = coverDataUrl;/);
  assert.doesNotMatch(block, /local\.cover = coverPath/);
});

test('auto-tag opens with an automatic best-release search while retaining human review for ambiguous matches', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /runAutoTagSearch\(modal, \{ autoSelect:true \}\)/);
  assert.match(source, /Number\(best\.score \|\| 0\) >= 180/);
  assert.match(source, /mapped\.length === albumTracks\.length/);
});

// Real bug, confirmed live: editing an album's cover showed a genuinely
// blank image (not even the no-cover placeholder) until Hive was restarted.
// Root cause: setPendingArtwork's local-file-pick path stores an ALREADY
// coverSrc()-wrapped mbcover:// URL into track.cover as the optimistic
// preview. buildAlbums() carries that into album.cover, and the album grid
// calls coverSrc(album.cover) again on every render -- coverSrc was not
// idempotent, so the second call re-wrapped the already-wrapped URL into a
// nested mbcover://mbcover%3A%2F%2F... string that can never resolve to a
// real file. A full library rescan (restart) is what overwrites track.cover
// with a plain, unwrapped path again, which is why it "fixed itself" then.
test('coverSrc is idempotent -- calling it twice on its own output does not re-wrap an already-resolved URL', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  const normStart = source.indexOf('function normalizeSpotifyArtworkSource(value) {');
  const normEnd = source.indexOf('\n  }', normStart);
  const coverStart = source.indexOf('function coverSrc(coverFile) {');
  const coverEnd = source.indexOf('\n  }', coverStart);
  assert.ok(normStart >= 0 && coverStart >= 0);
  const sandbox = new Function(`
    const window = { beehive: { coverUrl: (f) => f ? 'mbcover://' + encodeURIComponent(f) : null } };
    function placeholderCover() { return 'data:image/svg+xml;utf8,placeholder'; }
    ${source.slice(normStart, normEnd + 4)}
    ${source.slice(coverStart, coverEnd + 4)}
    return { coverSrc };
  `)();

  const wrappedOnce = sandbox.coverSrc('/home/user/Music/cover.jpg');
  assert.match(wrappedOnce, /^mbcover:\/\//, 'a bare filesystem path must be wrapped into an mbcover:// URL');
  const wrappedTwice = sandbox.coverSrc(wrappedOnce);
  assert.equal(wrappedTwice, wrappedOnce, 'calling coverSrc on its own already-wrapped output must be a no-op, not a second wrap');
  assert.doesNotMatch(wrappedTwice, /mbcover%3A%2F%2F/i, 'must never nest-encode a previous mbcover:// URL inside another one');

  // The other already-resolved schemes this function has always passed
  // through unchanged must still work.
  for (const passthrough of ['https://example.com/cover.jpg', 'data:image/png;base64,abc', 'blob:http://localhost/xyz']) {
    assert.equal(sandbox.coverSrc(passthrough), passthrough);
  }
});
