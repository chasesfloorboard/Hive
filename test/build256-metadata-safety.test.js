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

test('Build 256: metadata replacement requires a recoverable original backup', () => {
  assert.match(metadataWriter, /async function backupFileBeforeMetadataCommit\(trackPath\)/);
  assert.match(metadataWriter, /purpose:'metadata write recovery backup'/);
  assert.match(metadataWriter, /await backupFileBeforeMetadataCommit\(trackPath\);/);
  assert.match(metadataWriter, /If the backup cannot be created, do not replace the original/);
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

test('album auto-tag maps every track conservatively and writes only changed metadata', () => {
  assert.match(renderer, /function autoTagNeedsMetadata\(track\)/);
  assert.match(renderer, /function buildAutoTagMapping\(localTracks, remoteTracks\)/);
  assert.match(renderer, /if \(candidate\.score < 45\) continue;/);
  assert.match(renderer, /const changed = mapped\.map\(m => \({ \.\.\.m, tags: autoTagChangedFields/);
  assert.match(renderer, /mapped\.length !== albumTracks\.length/);
  assert.match(renderer, /Only fields that differ will be changed/);
});
