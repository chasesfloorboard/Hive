'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 195 exposes highlighted lyrics preference and Genius-only fallback mode', () => {
  assert.match(html, /id="setting-highlighted-lyrics"/);
  assert.match(renderer, /HIGHLIGHTED_LYRICS_KEY/);
  assert.match(renderer, /highlightedLyrics:highlightedLyricsEnabled\(\)/);
  assert.match(main, /const highlightedLyrics = query\.highlightedLyrics !== false/);
  assert.match(main, /if \(highlightedLyrics\) \{/);
  assert.match(main, /const geniusLyrics = await searchGeniusLyrics\(artist, title\);/);
});

test('Build 195 prioritizes synced lyrics and can automatically embed searched lyrics', () => {
  assert.match(main, /const lrclib = await searchLrcLibLyrics\(artist, title, album, duration\);[\s\S]*if \(lrclib\?\.synced\) return lrclib;/);
  assert.match(renderer, /EMBED_LYRICS_AUTOMATICALLY_KEY/);
  assert.match(renderer, /Embedding searched lyrics/);
  assert.match(renderer, /window\.beehive\.writeTags\(t\.path, \{ lyrics \}\)/);
  assert.match(html, /Embed songs with lyrics automatically/);
});

test('Build 195 adds per-track lyrics offset and applies it to highlighted timing', () => {
  assert.match(html, /id="tag-lyrics-offset"/);
  assert.match(renderer, /BEEHIVE_LYRICS_OFFSET/);
  assert.match(renderer, /Positive offset means the lyrics should appear later/);
  assert.match(renderer, /setMerged\('tag-lyrics-offset'/);
});

test('Build 195 documents precise start/end time entry format', () => {
  assert.match(html, /placeholder="00:00\.00"/);
  assert.match(html, /Start at this position\. Example: 00:12\.50/);
  assert.match(html, /Optional\. Leave blank to play to the end/);
});

// The embedded lyrics tag is always plain text (tag_helper.py's
// plain_from_lrc strips any [mm:ss.xx] timestamps unconditionally on every
// write). Before this, "no embedded lyrics" was the ONLY condition that
// triggered an online lookup, so once a track had any embedded lyrics at
// all, "Use highlighted lyrics" could never do anything for it -- the
// playback lyrics panel would show the static plain text forever, even with
// the setting on and a genuinely synced result available online. The lookup
// must still run for display (never for embedding, which
// embedSearchedLyricsIfEnabled's own guard already refuses) whenever the
// setting is on and the embedded text isn't already synced.
test('refreshTrackLyricsForDisplay looks up synced lyrics for display even when plain lyrics are already embedded', () => {
  const start = renderer.indexOf('function refreshTrackLyricsForDisplay(t)');
  const end = renderer.indexOf('\n\n  function updateTrackLyricsModel', start);
  assert.ok(start >= 0 && end > start, 'refreshTrackLyricsForDisplay must exist');
  const block = renderer.slice(start, end);
  assert.match(block, /const wantsSyncedLookup = !embeddedLyrics \|\| \(highlightedLyricsEnabled\(\) && !embeddedIsSynced\);/);
  assert.match(block, /if \(embeddedLyrics && !\(text && parseSyncedLyrics\(text\)\.length > 0\)\) return;/,
    'an online plain-only result must never replace already-shown embedded text');
  assert.match(block, /await embedSearchedLyricsIfEnabled\(t, found\);/,
    'the lookup result still only ever reaches the file through the existing never-overwrite-embedded-lyrics guard');

  // Both real call sites (track-change, and toggling the setting for the
  // currently playing track) must go through this one shared function
  // rather than duplicating the decision.
  assert.match(renderer, /refreshTrackLyricsForDisplay\(t\);/);
  assert.match(renderer, /refreshTrackLyricsForDisplay\(current\);/);
});

// Moved here from build172-navigation-favorites-lyrics.test.js (consolidated
// into test/playlist-sidebar-navigation.test.js) -- this is a lyrics-panel
// presentation test, not Favorites/playlists.
test('Lyrics glass bubble has no extra black outer box and active timed lyrics are only slightly larger', () => {
  const start = styles.indexOf('#lyrics-section {');
  const end = styles.indexOf('.selection-status', start);
  assert.ok(start >= 0 && end > start);
  const lyrics = styles.slice(start, end);
  assert.match(lyrics, /\.sidebar-lyrics\s*\{/);
  assert.match(lyrics, /margin:\s*0\s+10px\s+6px/);
  assert.match(lyrics, /border-radius:\s*16px/);
  assert.doesNotMatch(lyrics, /box-shadow:\s*[^;]*rgba\(0\s*,\s*0\s*,\s*0/);
  assert.match(lyrics, /\.lyrics-scroll\.lyrics-synced\s+\.lyrics-line\.current/);
  assert.match(lyrics, /font-size:\s*13(?:px)?/);
  assert.match(lyrics, /font-weight:\s*650/);
});

// Real bug, confirmed by the user with a real track (Holy Fuck - "Gold
// Flakes"): Genius search silently found nothing for almost any real query.
// Root-caused live against the actual Genius endpoints: genius.com/search's
// HTML now renders results client-side, so the server HTML's only
// *-lyrics links are a fixed "trending songs" widget unrelated to the
// query -- but that widget is always non-empty, so the code's
// `if (!candidates.length)` gate meant the real, working JSON search API
// (genius.com/api/search/multi) was never actually reached except by
// coincidence. That API also used an invalid per_page=10 (Genius caps it at
// 5, confirmed live: per_page=10 returns HTTP 422).
test('Genius search tries the real JSON search API first, with a valid per_page, before the non-functional HTML scrape', () => {
  const start = main.indexOf('async function searchGeniusLyrics(artist, title) {');
  const end = main.indexOf('\nasync function searchLrcLibLyrics', start);
  assert.ok(start >= 0 && end > start, 'expected to find searchGeniusLyrics()');
  const block = main.slice(start, end);
  const apiIndex = block.indexOf('genius.com/api/search/multi');
  const scrapeIndex = block.indexOf('https://genius.com/search?q=');
  assert.ok(apiIndex >= 0 && scrapeIndex >= 0, 'expected both discovery paths to still exist');
  assert.ok(apiIndex < scrapeIndex, 'the working JSON API must be tried before the HTML-scrape fallback');
  assert.match(block, /per_page=5/);
  assert.doesNotMatch(block, /per_page=10/);
  // The HTML-scrape fallback must only run when the API found nothing, not
  // unconditionally gate the API behind itself the way it used to.
  assert.match(block.slice(0, scrapeIndex), /if \(!candidates\.length\) \{\s*$/m);
});

// Real bug, confirmed by the user with a real track (Holy Fuck - "Gold
// Flakes"): embedded/displayed lyrics started with page-header junk ("3
// Contributors", "Gold Flakes Lyrics"). Root cause: a plain non-greedy
// regex ([\s\S]*?...</div>) cannot match a <div> against its OWN closing
// tag once other <div>s are nested inside it (which every real Genius
// lyrics container has) -- it stops at the first </div> found, silently
// fragmenting the real content, and one of the fragments was Genius's own
// header bar, which the old code had no way to distinguish from lyrics and
// just concatenated straight in. Verified directly against the real fetched
// Holy Fuck - Gold Flakes page during this fix (not reproduced here, since
// that requires a network fetch): the same functions extracted below
// correctly produced clean [Verse]/[Chorus] lyrics with zero "Contributors"
// text once fixed.
function extractMainFunction(name, nextName) {
  const start = main.indexOf(`function ${name}(`);
  const end = main.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `expected to find function ${name}`);
  return main.slice(start, end);
}
test('Genius lyrics extraction correctly matches nested <div>s and strips the page header, not just visible-tag text', () => {
  // Genius marks its header/contributors bar and similar non-lyrics UI with
  // data-exclude-from-selection="true" site-wide -- a stable semantic
  // attribute, unlike its auto-generated/versioned CSS class names.
  const excludeSrc = extractMainFunction('stripGeniusExcludedBlocks', 'stripGeniusLyricsHtml');
  assert.match(excludeSrc, /data-exclude-from-selection=\["']true\["']/);

  // Assemble the real functions (in dependency order) into one callable
  // sandbox via new Function -- same technique already used elsewhere in
  // this suite for main.js/renderer.js logic that isn't otherwise exported.
  const decodeSrc = extractMainFunction('decodeGeniusHtmlEntities', 'stripGeniusLyricsHtml');
  const balancedSrc = extractMainFunction('extractBalancedDiv', 'stripGeniusExcludedBlocks');
  const stripSrc = extractMainFunction('stripGeniusLyricsHtml', 'normalizeLyricMatch');
  const sandbox = new Function(`
    ${decodeSrc}
    ${balancedSrc}
    ${excludeSrc}
    ${stripSrc}
    return { stripGeniusLyricsHtml, extractBalancedDiv };
  `)();

  // A minimal fixture reproducing the real page's actual shape: the header
  // bar (with its own nested <div>s/<svg>/<button>) sits INSIDE the same
  // data-lyrics-container as the real lyrics that follow it.
  const fixture = `<div data-exclude-from-selection="true" class="LyricsHeader__Container-abc123"><button class="ContributorsCreditSong__Container-xyz"><span>3 Contributors</span></button><div class="LyricsHeader__GroupContainer-abc"><h2>Gold Flakes Lyrics</h2></div></div>[Verse 1]<br>Allison<br>We get as far as we both fall`;
  const text = sandbox.stripGeniusLyricsHtml(fixture);
  assert.doesNotMatch(text, /Contributors/);
  assert.doesNotMatch(text, /Gold Flakes Lyrics/);
  assert.match(text, /\[Verse 1\]/);
  assert.match(text, /Allison/);
  assert.match(text, /We get as far as we both fall/);

  // extractBalancedDiv itself: a <div> containing other <div>s must resolve
  // to its OWN true closing tag, not the first nested one.
  const nested = '<div>outer-start<div>inner</div>outer-end</div>tail';
  const result = sandbox.extractBalancedDiv(nested, '<div>'.length);
  assert.equal(result.content, 'outer-start<div>inner</div>outer-end');
  assert.equal(nested.slice(result.end), 'tail');
});
