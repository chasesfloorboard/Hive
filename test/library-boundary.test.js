'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLibraryBoundary, LIBRARY_BOUNDARY_ERROR } = require('../app/main/library-boundary');

test('LIBRARY_BOUNDARY_ERROR is a stable message exported both ways', () => {
  assert.equal(LIBRARY_BOUNDARY_ERROR, 'File is outside a configured Hive library folder.');
  const b = createLibraryBoundary({ libraryFolders: async () => [] });
  assert.equal(b.LIBRARY_BOUNDARY_ERROR, LIBRARY_BOUNDARY_ERROR);
});

test('isPathInsideFolder: inside, equal, escape and absolute cases', () => {
  const { isPathInsideFolder } = createLibraryBoundary({ libraryFolders: async () => [] });
  const root = path.resolve('/music/lib');
  assert.equal(isPathInsideFolder(path.join(root, 'a/b.flac'), root), true, 'nested file is inside');
  assert.equal(isPathInsideFolder(root, root), true, 'the folder itself counts as inside');
  assert.equal(isPathInsideFolder('/music/other/x.flac', root), false, 'a sibling folder is outside');
  assert.equal(isPathInsideFolder('/etc/passwd', root), false, 'an unrelated absolute path is outside');
  assert.equal(isPathInsideFolder('', root), false, 'empty file path is rejected');
  assert.equal(isPathInsideFolder(root + '/a', ''), false, 'empty folder path is rejected');
  // a prefix that is not a path boundary must not count as inside
  assert.equal(isPathInsideFolder('/music/library-2/x.flac', '/music/lib'), false, 'prefix-not-boundary rejected');
});

test('isTrackPathAllowedInLibrary accepts a path under any configured folder, rejects others', async () => {
  const folders = ['/music/a', '/mnt/portable/b'];
  const b = createLibraryBoundary({ libraryFolders: async () => folders });
  assert.equal(await b.isTrackPathAllowedInLibrary('/music/a/artist/song.flac'), true);
  assert.equal(await b.isTrackPathAllowedInLibrary('/mnt/portable/b/x.mp3'), true, 'second (portable) root honoured');
  assert.equal(await b.isTrackPathAllowedInLibrary('/music/c/song.flac'), false, 'outside every root is rejected');
  assert.equal(await b.isTrackPathAllowedInLibrary(''), false, 'empty path is rejected');
});

test('with no configured folders, nothing is allowed (fail-closed)', async () => {
  const b = createLibraryBoundary({ libraryFolders: async () => [] });
  assert.equal(await b.isTrackPathAllowedInLibrary('/music/a/song.flac'), false);
});

test('a "../" traversal out of a configured folder is rejected', async () => {
  const b = createLibraryBoundary({ libraryFolders: async () => ['/music/lib'] });
  assert.equal(await b.isTrackPathAllowedInLibrary('/music/lib/../secret/song.flac'), false);
});
