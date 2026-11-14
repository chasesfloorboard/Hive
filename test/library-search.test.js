const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The library search, as the phone's: a song matches when every typed word is
// somewhere in its tags, in any order, ignoring case, accents and punctuation.
function loadFold() {
  // foldSearchText lives in the extracted search-text.js now (docs/ai/ARCHITECTURE.md).
  return require('../app/renderer/search-text').foldSearchText;
}

test('search matches every word in any order, ignoring brackets, case and accents', () => {
  const fold = loadFold();
  const tags = fold('(It Goes Like) Nanana (Edit) Peggy Gou I Hear You');
  const matches = q => fold(q).trim().split(' ').filter(Boolean).every(w => tags.includes(w));
  for (const q of ['nanana', 'it goes like', 'edit', 'Nanana (Edit)', 'edit nanana', 'peggy nanana', 'NANANA']) assert.ok(matches(q), q);
  assert.ok(!matches('nanana remix'));
  assert.equal(fold('Björk Ænima Motörhead').trim(), 'bjork aenima motorhead');
});

// The collection re-render on each keystroke is search's most expensive act on a
// large library, so typing is debounced (~140ms, matching the phone) while the
// term and its clear button update immediately, and emptying the field renders at
// once. These guard that the debounce stays in place and that clearing stays instant.
function loadSearchDebounce() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
  const start = source.indexOf('  function renderSearchResults() {');
  const anchor = source.indexOf("el.search.addEventListener('input'", start);
  const end = source.indexOf('});', anchor);
  assert.ok(start >= 0 && anchor > start && end > anchor, 'search debounce block not found');
  const block = source.slice(start, end + 3);

  const timers = [];
  let now = 0;
  const env = {
    renders: 0, clearButtonUpdates: 0,
    specialView: null, viewMode: 'albums', artistSearchTerm: '', searchTerm: '',
    setView() { env.renders++; },
    updateSearchClearButton() { env.clearButtonUpdates++; },
    el: { search: { value: '', _handlers: {}, addEventListener(type, fn) { this._handlers[type] = fn; } } },
    setTimeout(fn, ms) { const h = { fn, at: now + ms, live: true }; timers.push(h); return h; },
    clearTimeout(h) { if (h) h.live = false; },
    advance(ms) { now += ms; for (const h of timers) if (h.live && h.at <= now) { h.live = false; h.fn(); } },
  };
  // Run the extracted block with every free name bound to the fake environment.
  new Function('env', `
    let { specialView, viewMode, artistSearchTerm, searchTerm, el } = env;
    const setView = env.setView, updateSearchClearButton = env.updateSearchClearButton;
    const setTimeout = env.setTimeout, clearTimeout = env.clearTimeout;
    ${block}
  `)(env);
  return env;
}

test('typing debounces the render; the term and clear button update immediately', () => {
  const env = loadSearchDebounce();
  const fire = value => { env.el.search.value = value; env.el.search._handlers.input(); };

  for (const k of ['p', 'pe', 'peg', 'pegg', 'peggy']) fire(k);
  // Keystrokes update the clear button each time but have not rendered yet.
  assert.equal(env.clearButtonUpdates, 5);
  assert.equal(env.renders, 0, 'no render before the debounce elapses');

  env.advance(139);
  assert.equal(env.renders, 0, 'still waiting just under the window');
  env.advance(1);
  assert.equal(env.renders, 1, 'exactly one coalesced render after ~140ms');
});

test('clearing the field renders immediately, not on a timer', () => {
  const env = loadSearchDebounce();
  const fire = value => { env.el.search.value = value; env.el.search._handlers.input(); };

  fire('peggy');
  env.advance(140);
  assert.equal(env.renders, 1);

  fire('');
  assert.equal(env.renders, 2, 'emptying renders synchronously, no debounce wait');
});
