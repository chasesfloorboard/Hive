const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
// Rating/artwork/general-metadata writers were extracted out of main.js into
// their own dependency-injected, unit-testable module (see
// love-playback-safety.test.js for direct behavioral coverage of that
// module); source-pattern checks for that logic now read this file instead.
const metadataWriter = fs.readFileSync(path.join(root, 'app/main/metadata-writer.js'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'resources/python/tag_helper.py'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const { mp4Atom, mp4AtomWithPayload, rebuildMp4Parent } = require('../app/main/mp4-atoms');

test('Build 256: MP4 FullBox meta header is preserved during native rating/Love patching', () => {
  // `meta` is an ISO BMFF FullBox: its first 4 payload bytes are a
  // version/flags prefix, not a child atom. Build 255 dropped those bytes
  // while rebuilding moov/udta/meta, corrupting every ilst entry. Assert the
  // actual rebuild behavior (not source text) so this survives refactors.
  const fullBoxPrefix = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const oldChild = mp4AtomWithPayload('ilst', Buffer.from('old-ilst-payload'));
  const metaBuffer = Buffer.concat([mp4AtomWithPayload('meta', Buffer.concat([fullBoxPrefix, oldChild])), Buffer.alloc(0)]);
  const meta = mp4Atom(metaBuffer, 0);

  const newChild = mp4AtomWithPayload('ilst', Buffer.from('new-ilst-payload'));
  const rebuilt = rebuildMp4Parent(metaBuffer, meta, { offset: meta.offset + meta.header + fullBoxPrefix.length, size: oldChild.length }, newChild);

  assert.deepEqual(rebuilt.subarray(meta.header, meta.header + 4), fullBoxPrefix, 'FullBox version/flags prefix must be preserved');
  assert.ok(rebuilt.includes(newChild), 'rebuilt meta atom must contain the new ilst child');
});

// Superseded: a full-file backup used to be made before every metadata
// commit (recoverable via backupFileBeforeMetadataCommit). Removed -- it ran
// on every write, including the automatic per-track play-count embed, and
// grew unbounded with no pruning (98GB on one real library). The temp-copy-
// then-atomic-rename sequence commitMetadataTemp already does (see the test
// below) means a failed/interrupted write still can never leave a
// half-written file in place; that safety property never depended on the
// backup copy.
test('metadata commits are staged via an atomic rename, with no full-file backup step', () => {
  assert.doesNotMatch(metadataWriter, /function backupFileBeforeMetadataCommit/);
  assert.doesNotMatch(metadataWriter, /Tag Backups/);
  const start = metadataWriter.indexOf('async function commitMetadataTemp(temp, trackPath, background = false) {');
  const end = metadataWriter.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start, 'expected to find commitMetadataTemp()');
  const block = metadataWriter.slice(start, end);
  assert.match(block, /await fsp\.rename\(temp, trackPath\);/);
});

test('Build 256: ordinary tag writes verify embedded artwork was not changed', () => {
  assert.match(helper, /def artwork_fingerprint\(path\):/);
  assert.match(helper, /if op=='artwork_fingerprint': return/);
  assert.match(metadataWriter, /const artworkBefore = artworkWasIntentionallyChanged \? null/);
  assert.match(metadataWriter, /Metadata save changed embedded artwork unexpectedly/);
});

test('Build 256: rating and Love writes stage changes before committing them', () => {
  assert.match(metadataWriter, /const temp = await createMetadataTempPath\(trackPath, 'rating'\);/);
  assert.match(metadataWriter, /await copyMetadataFile\(trackPath, temp, false\);/);
  assert.match(metadataWriter, /await commitMetadataTemp\(temp, trackPath, false\);/);
  // The main Love write path uses app/workers/metadata-worker.js's
  // format-specific writers (MP3/WAV/M4A hand-rolled atom surgery, FLAC and
  // any other format via the bundled Mutagen backend); main.js's own
  // embedLoveInFile is a secondary/recovery path that still stages through
  // the same shared createMetadataTempPath.
  assert.match(main, /const temp = await createMetadataTempPath\(trackPath, 'love'\);/);
});

// Security-audit finding, fixed before 1.0: tracks:deleteFromDisk and the
// mbfile:// protocol handler already reject a path outside every configured
// library folder (isPathInsideFolder against config.folders), but the
// metadata/artwork writers only checked the file existed -- any track
// record pointing outside config.folders (e.g. an imported playlist
// referencing an external file) could have that file silently rewritten by
// an ordinary Love/Rating/Tag-Editor/Auto-Tag write. Fixed with the same
// isPathInsideFolder() check, reused as isTrackPathAllowedInLibrary(), at
// every entry point: the 5 direct single-file IPC handlers AND the
// metadata:saveBatch queue (runMetadataBatch), since both ultimately reach
// the same writer functions.
test('every metadata/artwork write entry point rejects a path outside the configured library folders', () => {
  assert.match(main, /async function isTrackPathAllowedInLibrary\(trackPath\) \{/);
  const guardBlock = main.slice(main.indexOf('async function isTrackPathAllowedInLibrary'), main.indexOf('\n}', main.indexOf('async function isTrackPathAllowedInLibrary')));
  assert.match(guardBlock, /folders\.some\(folder => isPathInsideFolder\(resolved, folder\)\)/);

  for (const channel of ['track:writeArtwork', 'track:modifyArtwork', 'track:removeFrontArtwork', 'track:removeArtwork', 'track:writeTags']) {
    const start = main.indexOf(`ipcMain.handle('${channel}',`);
    assert.ok(start >= 0, `expected an ipcMain.handle for ${channel}`);
    const end = main.indexOf('});', start);
    const block = main.slice(start, end);
    assert.match(block, /if \(!\(await isTrackPathAllowedInLibrary\(trackPath\)\)\) throw new Error\(LIBRARY_BOUNDARY_ERROR\);/, `${channel} must reject an out-of-library path before delegating to the writer`);
  }

  // The batch queue path (Tag Editor Save / Auto-Tag / multi-file operations)
  // is a separate entry point from the 5 single-file handlers above and
  // needed its own guard inside the per-job loop.
  const batchStart = main.indexOf('async function runMetadataBatch(normalizedJobs, sender, options = {}) {');
  const batchLoopStart = main.indexOf('for(const job of normalizedJobs){', batchStart);
  const batchBlock = main.slice(batchLoopStart, main.indexOf('let attempts=Number(job.attempts||0)', batchLoopStart));
  assert.match(batchBlock, /if \(!\(await isTrackPathAllowedInLibrary\(job\.path\)\)\) \{/);
  assert.match(batchBlock, /errors\.push\(\{path:job\.path,error:LIBRARY_BOUNDARY_ERROR\}\);/);
});

test('album auto-tag maps every track conservatively and writes only changed metadata', () => {
  assert.match(renderer, /function autoTagNeedsMetadata\(track\)/);
  assert.match(renderer, /function buildAutoTagMapping\(localTracks, remoteTracks\)/);
  assert.match(renderer, /if \(candidate\.score < 45\) continue;/);
  assert.match(renderer, /const changed = mapped\.map\(m => \({ \.\.\.m, tags: autoTagChangedFields/);
  assert.match(renderer, /mapped\.length !== albumTracks\.length/);
  assert.match(renderer, /Only fields that differ will be changed/);
});
