const test = require('node:test');
const assert = require('node:assert/strict');
const { findReplace, changeCase, planTagTool } = require('../app/renderer/tag-tools');

test('find & replace: plain, case-sensitive, whole word and regex', () => {
  assert.equal(findReplace('Feat. Someone feat. Other', { find: 'feat.', replace: 'ft.' }), 'ft. Someone ft. Other');
  assert.equal(findReplace('Feat. Someone feat. Other', { find: 'feat.', replace: 'ft.', caseSensitive: true }), 'Feat. Someone ft. Other');
  assert.equal(findReplace('Rap and Rapture', { find: 'Rap', replace: 'Hip Hop', wholeWord: true }), 'Hip Hop and Rapture');
  assert.equal(findReplace('Track (Remastered 2011)', { find: '\\s*\\(Remaster(ed)?[^)]*\\)', replace: '', regex: true }), 'Track');
  assert.equal(findReplace('a$b', { find: '$', replace: '&' }), 'a&b', 'plain mode treats $ and & literally');
  assert.throws(() => findReplace('x', { find: '(', regex: true }));
});

test('case modes', () => {
  assert.equal(changeCase('the end of the world as we know it', 'title'), 'The End of the World as We Know It');
  assert.equal(changeCase('AC/DC live at donington', 'title'), 'AC/DC Live at Donington');
  assert.equal(changeCase('pump up the jam: the album', 'title'), 'Pump Up the Jam: The Album');
  assert.equal(changeCase('HELLO WORLD. GOODBYE', 'sentence'), 'Hello world. Goodbye');
  assert.equal(changeCase('Mixed Case', 'upper'), 'MIXED CASE');
  assert.equal(changeCase('Mixed Case', 'lower'), 'mixed case');
});

test('plans only real changes and supports copy, swap and fill-empty', () => {
  const tracks = [
    { path: '/a.mp3', title: 'song one', artist: 'Artist', albumArtist: '' },
    { path: '/b.mp3', title: 'Already Fine', artist: 'X', albumArtist: 'Y' }
  ];
  const titles = planTagTool(tracks, { kind: 'case', field: 'title', mode: 'title' });
  assert.deepEqual(titles.map(p => [p.path, p.tags]), [['/a.mp3', { title: 'Song One' }]]);
  const fill = planTagTool(tracks, { kind: 'copy', from: 'artist', to: 'albumArtist', onlyEmpty: true });
  assert.deepEqual(fill.map(p => [p.path, p.tags]), [['/a.mp3', { albumArtist: 'Artist' }]]);
  const swap = planTagTool([tracks[1]], { kind: 'copy', from: 'artist', to: 'albumArtist', swap: true });
  assert.deepEqual(swap[0].tags, { albumArtist: 'X', artist: 'Y' });
});
