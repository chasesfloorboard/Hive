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
