'use strict';
// Canonical, stable home for Love metadata semantics: the LOVE RATING tag
// itself, its playback-safety write path, its embedded/native-tag fallback
// reading, and its durable database projection. Edit this file in place
// when Love's architecture legitimately changes.
//
// This subsystem previously had its Love-specific tests scattered across
// ~6 separate buildNNN-*.test.js files that also mixed in unrelated
// Favorites/playlist-sidebar and Star Favorites smart-playlist tests (now
// consolidated into test/playlist-sidebar-navigation.test.js instead). See
// CHANGELOG.md builds 149/154/166/211/215/228 for the history, and
// docs/ai/HIVE-METADATA-BACKEND-CANON.md for the current canonical writer
// architecture Love's file writes go through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const loveTool = fs.readFileSync(path.join(root, 'scripts/hive-love-validator.js'), 'utf8');
const dbWorker = fs.readFileSync(path.join(root, 'app/workers/database-worker.py'), 'utf8');

// --- Playback safety: Love must never interrupt or restart transport ---

test('Love metadata waits for explicit playback-path release without a wall-clock bypass', () => {
  assert.match(main, /const playbackProtection = new PlaybackProtection\(\);/);
  assert.match(main, /async function waitForPlaybackProtectionRelease\(trackPath\)\s*\{\s*await playbackProtection\.waitForRelease\(trackPath\);/);
  assert.doesNotMatch(main, /waitForPlaybackProtectionRelease\(trackPath,\s*timeoutMs/);
});

test('Love UI updates never send native transport STOP/LOAD commands', () => {
  const start = renderer.indexOf('async function setTrackLove(');
  const end = renderer.indexOf('\n  // Apply a Love/rating command', start);
  assert.ok(start >= 0 && end > start);
  const loveBlock = renderer.slice(start, end);
  assert.doesNotMatch(loveBlock, /gstSend\(['"`]STOP|gstSend\(['"`]LOAD|requestLoadAndPlayCurrent/);
  assert.match(loveBlock, /queueLoveFileWrite\(t\.path, value\)/);
});

// --- Canonical tag identity and value semantics ---

test('Love semantics are owned by Hive and the canonical tag remains embedded', () => {
  const { isLoveFieldName, isLovedValue, CANONICAL_LOVE_TAG } = require(path.join(root, 'app/main/hive-love'));
  assert.equal(CANONICAL_LOVE_TAG, 'LOVE RATING');
  assert.equal(isLoveFieldName('LOVE RATING'), true);
  assert.equal(isLovedValue('L'), true);
  assert.equal(isLovedValue('0'), false);
});

test('MusicBee LOVE RATING alias is recognized exactly', () => {
  const love = require(path.join(root, 'app/main/musicbee-love'));
  assert.equal(love.isBeehiveLoveFieldName('MUSICBEE LOVE RATING'), true);
  assert.equal(love.isBeehiveLoveFieldName('unrelated field'), false);
});

test('Rating/POPM/FMPS metadata is never treated as Love state', () => {
  assert.match(loveTool, /Love/i);
  assert.match(loveTool, /Rating\/POPM\/FMPS metadata is intentionally not used to determine Love state/);
});

// --- Reading Love back from native/embedded tags (fallback path) ---

test('native metadata Love fallback recognizes canonical and legacy embedded fields', () => {
  const { readLovedFromNativeTags } = require(path.join(root, 'app/main/hive-love'));
  assert.equal(readLovedFromNativeTags({ 'ID3v2.3': [
    { id: 'TXXX:LOVE RATING', value: { description: 'LOVE RATING', text: ['U', 'L'] } }
  ] }), true);
  assert.equal(readLovedFromNativeTags({ 'ID3v2.3': [
    { id: 'TXXX:LOVE RATING', value: { description: 'LOVE RATING', text: ['U'] } }
  ] }), false);
  assert.equal(readLovedFromNativeTags({ 'ID3v2.3': [
    { id: 'TXXX:RATING', value: { description: 'RATING', text: ['L'] } }
  ] }), false);
});

test('a short ID3 declaration does not automatically hide an embedded Love frame', () => {
  const { readId3LoveFromBuffer } = require(path.join(root, 'app/main/musicbee-love'));
  function syncSize(n) { return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]); }
  function frame(desc, value) {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(desc), Buffer.from([0]), Buffer.from(value)]);
    return Buffer.concat([Buffer.from('TXXX'), syncSize(body.length), Buffer.alloc(2), body]);
  }
  function tag(frames, declaredSize) {
    const payload = Buffer.concat(frames);
    return Buffer.concat([Buffer.from('ID3\x04\x00\x00'), syncSize(declaredSize ?? payload.length), payload]);
  }
  const love = tag([frame('LOVE RATING', 'L')], 999999);
  assert.equal(readId3LoveFromBuffer(love), true);
});

// --- Repairing inconsistent/legacy Love values across sources ---

test('Love integrity repair uses L whenever any Love field contains a Loved value', () => {
  const helperPath = path.join(root, 'app/main/love-integrity.js');
  assert.ok(fs.existsSync(helperPath), 'love-integrity helper should exist');
  const { analyzeLoveValues, CANONICAL_LOVE_TAG } = require(helperPath);
  assert.equal(CANONICAL_LOVE_TAG, 'LOVE RATING');
  assert.deepEqual(analyzeLoveValues(['U', 'L', 'u']), { flagged: true, loved: true, canonicalValue: 'L' });
  assert.deepEqual(analyzeLoveValues(['L', 'L']), { flagged: true, loved: true, canonicalValue: 'L' });
  assert.deepEqual(analyzeLoveValues(['U', 'u']), { flagged: true, loved: false, canonicalValue: '0' });
});

test('Love integrity repair remains available while its old Settings bubble is removed', () => {
  assert.doesNotMatch(html, /Tag Backups/);
  assert.match(renderer, /repair.*Love|Love.*repair/i);
  assert.match(main, /audio:integrity-repair-love/);
});

test('Love repair creates a backup before modifying a file', () => {
  assert.match(main, /Tag Backups/);
  assert.match(main, /backup.*before|before.*backup/i);
  assert.match(main, /copyFile|cp.*backup/i);
  assert.match(main, /audio:integrity-repair-love/);
});

test('a dry-run/manual Love validator exists with canonical LOVE RATING=L repair', () => {
  assert.match(loveTool, /--interactive/);
  assert.match(loveTool, /--apply/);
  assert.match(loveTool, /LOVE RATING/);
  assert.match(loveTool, /normalize/i);
  assert.match(loveTool, /backup/i);
  assert.doesNotMatch(loveTool, /import\(['"]music-metadata['"]\)|from ['"]music-metadata['"]/);
  assert.match(loveTool, /ffprobe|metaflac/);
  assert.match(loveTool, /parseId3|parseMp4|native/);
  assert.match(loveTool, /LOVE_FIELDS/);
  const worker = fs.readFileSync(path.join(root, 'app/workers/metadata-worker.js'), 'utf8');
  assert.match(worker, /MUSICBEE\/LOVE RATING/);
  assert.match(worker, /MUSICBEE\/LOVERATING/);
  assert.match(worker, /MUSICBEE LOVE RATING/);
  assert.match(loveTool, /fork|child_process/);
});

// --- Durable database projection (so Love survives without re-scanning tags) ---

test('Love is persisted as a structured database field', () => {
  assert.match(dbWorker, /loved\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/);
  assert.match(dbWorker, /ALTER TABLE tracks ADD COLUMN loved INTEGER/);
  assert.match(dbWorker, /t\.get\('loved'\)/);
});

test('the database exposes a targeted durable Loved-path query', () => {
  assert.match(dbWorker, /cmd==['"]get_loved_paths['"]/);
  assert.match(dbWorker, /SELECT path FROM tracks WHERE loved=1/);
});

test('the durable Love projection is updated after native tag writes', () => {
  assert.match(main, /await updateCachedLoved\(absolutePath, value\)/);
  assert.match(main, /databaseRequest\(['"]upsert_tracks['"]/);
  assert.match(main, /loved:\s*!!t\.loved/);
});

test('the renderer Love cache is not the only durable source of truth', () => {
  assert.match(main, /databaseRequest\(['"]get_loved_paths['"]/);
});

test('the now-playing Love read-back waits for an in-flight write before trusting disk state', () => {
  // Real bug: loving a track then letting it repeat (repeat-one) restarts
  // the same track, which re-runs the "authoritative Love state" disk read.
  // setTrackLove's write is queued in the background (loveWriteQueue) after
  // an optimistic UI update, so if that reload's disk read fired before the
  // queued write landed, it read the stale pre-write value and stomped the
  // heart back to unloved. The read must wait on any pending write for the
  // same path first.
  const start = renderer.indexOf('Now that the new track is visibly painted, verify the authoritative Love');
  const end = renderer.indexOf('const libTrack = libraryTrackByPath.get', start);
  assert.ok(start >= 0 && end > start, 'expected to find the now-playing Love verification block');
  const block = renderer.slice(start, end);
  assert.match(block, /loveWriteQueue\.get\(t\.path\)/);
  assert.match(block, /await pendingLoveWrite/);
  // The wait must happen before the disk read, not after.
  assert.ok(block.indexOf('pendingLoveWrite') < block.indexOf('window.beehive.readLove(t.path)'));
});
