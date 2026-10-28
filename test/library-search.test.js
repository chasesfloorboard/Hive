const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The library search, as the phone's: a song matches when every typed word is
// somewhere in its tags, in any order, ignoring case, accents and punctuation.
function loadFold() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  const start = source.indexOf('function foldSearchText(value) {');
  const end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start);
  return new Function(`${source.slice(start, end + 4)}; return foldSearchText;`)();
}

test('search matches every word in any order, ignoring brackets, case and accents', () => {
  const fold = loadFold();
  const tags = fold('(It Goes Like) Nanana (Edit) Peggy Gou I Hear You');
  const matches = q => fold(q).trim().split(' ').filter(Boolean).every(w => tags.includes(w));
  for (const q of ['nanana', 'it goes like', 'edit', 'Nanana (Edit)', 'edit nanana', 'peggy nanana', 'NANANA']) assert.ok(matches(q), q);
  assert.ok(!matches('nanana remix'));
  assert.equal(fold('Björk Ænima Motörhead').trim(), 'bjork aenima motorhead');
});
