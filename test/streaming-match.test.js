'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamingMatch } = require('../app/renderer/streaming-match');

// A local-track predicate + a fixed library, so the index/match logic is deterministic.
const isLocal = (t) => !!t?.path && t.source !== 'spotify' && t.source !== 'podcast';
function make(tracks = []) {
  return createStreamingMatch({ isLocalPlaybackTrack: isLocal, getLibraryTracks: () => tracks });
}

test('createStreamingMatch validates its injected dependencies', () => {
  assert.throws(() => createStreamingMatch({}), /isLocalPlaybackTrack.*getLibraryTracks/);
  assert.throws(() => createStreamingMatch({ isLocalPlaybackTrack: () => true }), /getLibraryTracks/);
});

test('appleMatchKey strips feat/ft brackets, trailing feat, diacritics, and punctuation', () => {
  const { appleMatchKey } = make();
  assert.equal(appleMatchKey('Beyoncé (feat. Jay-Z)'), 'beyonce');
  assert.equal(appleMatchKey('Umbrella [ft. JAY-Z]'), 'umbrella');
  assert.equal(appleMatchKey('Blinding Lights'), 'blindinglights');
  assert.equal(appleMatchKey('Dog Days Are Over feat. Someone'), 'dogdaysareover');
  assert.equal(appleMatchKey('Façade'), 'facade', 'diacritics folded');
  assert.equal(appleMatchKey('Salt & Pepa'), 'saltandpepa', 'ampersand -> and');
  assert.equal(appleMatchKey(''), '');
  assert.equal(appleMatchKey(null), '');
});

test('appleMatchKey treats "(with X)", "(explicit)", "(clean)", "(mixed)" as noise', () => {
  const { appleMatchKey } = make();
  assert.equal(appleMatchKey('Track (with Guest)'), 'track');
  assert.equal(appleMatchKey('Track (Explicit)'), 'track');
  assert.equal(appleMatchKey('Track (Clean)'), 'track');
});

test('appleLibraryIndex groups only local tracks by title key, skipping empties and streams', () => {
  const lib = [
    { path: '/m/a.mp3', title: 'Hello', artist: 'Adele' },
    { path: '/m/b.mp3', title: 'Hello', artist: 'Other' },
    { path: '', title: 'No Path', artist: 'X' },
    { path: 'spotify:z', source: 'spotify', title: 'Hello', artist: 'Streamed' },
    { path: '/m/c.mp3', title: '', artist: 'Empty Title' },
  ];
  const { appleLibraryIndex } = make(lib);
  const index = appleLibraryIndex();
  assert.deepEqual([...index.keys()], ['hello'], 'only the keyable local tracks are indexed');
  assert.equal(index.get('hello').length, 2, 'both local Hellos grouped; stream + empties excluded');
});

test('appleLibraryIndex re-reads the live library each call (lazy getter)', () => {
  let tracks = [];
  const sm = createStreamingMatch({ isLocalPlaybackTrack: isLocal, getLibraryTracks: () => tracks });
  assert.equal(sm.appleLibraryIndex().size, 0);
  tracks = [{ path: '/m/a.mp3', title: 'New', artist: 'A' }];
  assert.equal(sm.appleLibraryIndex().size, 1, 'picks up tracks added after construction');
});

test('appleLocalMatch returns a local track only when the primary artist matches', () => {
  const lib = [
    { path: '/m/a.mp3', title: 'Crazy In Love', artist: 'Beyoncé', albumArtist: '' },
    { path: '/m/b.mp3', title: 'Crazy In Love', artist: 'Wrong Band', albumArtist: '' },
  ];
  const sm = make(lib);
  const index = sm.appleLibraryIndex();
  // Streamed track: title matches two locals; primary artist 'Beyoncé, Jay-Z' -> Beyoncé.
  const streamed = { title: 'Crazy in Love (feat. JAY-Z)', artist: 'Beyoncé, JAY-Z' };
  const hit = sm.appleLocalMatch(index, streamed);
  assert.equal(hit?.path, '/m/a.mp3');
  // No artist overlap -> no match even though the title key collides.
  assert.equal(sm.appleLocalMatch(index, { title: 'Crazy In Love', artist: 'Nobody' }), null);
  // A title not in the library -> null.
  assert.equal(sm.appleLocalMatch(index, { title: 'Unknown Song', artist: 'Beyoncé' }), null);
});

test('appleLocalMatch matches on albumArtist too, and uses only the first of several artists', () => {
  const lib = [{ path: '/m/x.mp3', title: 'Song', artist: 'Various', albumArtist: 'Daft Punk' }];
  const sm = make(lib);
  const index = sm.appleLibraryIndex();
  // Primary artist is the first before a comma/&/" x "; here 'Daft Punk' matches albumArtist.
  assert.equal(sm.appleLocalMatch(index, { title: 'Song', artist: 'Daft Punk & Pharrell' })?.path, '/m/x.mp3');
});
