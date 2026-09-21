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
