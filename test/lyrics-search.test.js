'use strict';
// Lyrics search titles: credit brackets in tags are dropped before searching
// Genius/LRCLIB, which list songs by their plain titles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { lyricsSearchTitle } = require('../app/main/lyrics-provider');

test('production and feature credits are dropped from the search title', () => {
  assert.equal(lyricsSearchTitle('Supervillain Intro (Prod. By Doom) (Co-Prod. By & Feat. Mr. Chop)'), 'Supervillain Intro');
  assert.equal(lyricsSearchTitle('Yessir! (Feat. Raekwon) (Prod. By Doom)'), 'Yessir!');
  assert.equal(lyricsSearchTitle('Song [ft. Someone]'), 'Song');
  assert.equal(lyricsSearchTitle('Track [Explicit]'), 'Track');
  assert.equal(lyricsSearchTitle('Wish You Were Here - 2011 Remaster'), 'Wish You Were Here');
});

test('meaningful version labels stay, and a title is never emptied', () => {
  assert.equal(lyricsSearchTitle('Song (Remix)'), 'Song (Remix)');
  assert.equal(lyricsSearchTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
  assert.equal(lyricsSearchTitle('Slow It Down'), 'Slow It Down');
  assert.equal(lyricsSearchTitle('(Intro)'), '(Intro)');
});
