'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 199 removes the obsolete per-track compilation and shuffle-sequence switches', () => {
  assert.doesNotMatch(html, /id="tag-compilation-setting"/);
  assert.doesNotMatch(html, /id="tag-keep-sequence"/);
  assert.doesNotMatch(renderer, /'tag-compilation-setting'/);
  assert.doesNotMatch(renderer, /'tag-keep-sequence'/);
  assert.doesNotMatch(renderer, /BEEHIVE_KEEP_SEQUENCE.*tag-keep-sequence/);
});

test('Build 199 uses ordinary signed seconds for lyric offset', () => {
  assert.match(html, /id="tag-lyrics-offset"[^>]*placeholder="\+0\.00"/);
  assert.match(html, /add <strong>−<\/strong> to move them earlier/);
  assert.match(renderer, /BEEHIVE_LYRICS_OFFSET/);
  assert.match(renderer, /Lyrics offset must be a number of seconds/);
});

test('Build 199 keeps ReplayGain metadata fields in the per-track editor', () => {
  for (const id of ['tag-replaygain-track-gain','tag-replaygain-track-peak','tag-replaygain-album-gain','tag-replaygain-album-peak','tag-r128-track-gain']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(renderer, /REPLAYGAIN_TRACK_GAIN/);
  assert.match(renderer, /REPLAYGAIN_ALBUM_GAIN/);
  assert.match(renderer, /R128_TRACK_GAIN/);
});

test('Build 199 lyrics tab is an actual online-results workspace and auto-searches on open', () => {
  assert.match(html, /id="tag-lyrics-preview"/);
  assert.match(html, /id="tag-lyrics-source"/);
  assert.match(html, /id="tag-lyrics-result-meta"/);
  assert.match(renderer, /if \(tab === 'lyrics' && editingTrack\) void refreshTagEditorLyrics\(editingTrack\)/);
  assert.match(renderer, /window\.beehive\.searchLyrics\(\{ artist: track\.artist/);
  assert.match(renderer, /renderTagEditorLyricsPreview\(tagLyricsPayload\.text/);
});

// The Lyrics tab only ever shows/edits the plain embedded lyrics -- the
// field actually written to the audio file -- since a later fix made the
// embedded tag always plain (see resources/python/tag_helper.py). The
// synced/plain radio toggle and its LYRICS_SYNC save-time field were removed
// as a result; the player's synced-lyrics highlighting during playback is a
// separate display-time concern that never affects what gets embedded.
test('lyrics tab has no synced/plain format toggle and never writes LYRICS_SYNC', () => {
  assert.doesNotMatch(html, /name="tag-lyrics-sync"/);
  assert.doesNotMatch(html, /id="tag-lyrics-format-hint"/);
  assert.doesNotMatch(renderer, /tagLyricsPayload\.mode/);
  assert.doesNotMatch(renderer, /perTrack\.LYRICS_SYNC/);
  assert.match(renderer, /let tagLyricsPayload = \{ text: '', editing: false \};/);
});

// The "Search online" button (forceSearch=true) is an explicit redo request
// and must always reach the actual search, even when the track already has
// embedded lyrics -- which is effectively every track with lyrics at all,
// since the embedded tag is always plain text. The embedded-lyrics shortcut
// used to run unconditionally before checking forceSearch, so clicking
// "Search online" on any track that already had lyrics silently did nothing.
test('the Search online button redoes the lyrics search even when the track already has embedded lyrics', () => {
  const start = renderer.indexOf('async function refreshTagEditorLyrics(track, forceSearch = false)');
  const end = renderer.indexOf('\n\n  document.querySelectorAll(\'.tag-editor-tab\'', start);
  assert.ok(start >= 0 && end > start, 'refreshTagEditorLyrics must exist');
  const block = renderer.slice(start, end);
  const guardIndex = block.indexOf('if (!forceSearch) {');
  const shortcutIndex = block.indexOf('if (embeddedText) {');
  const searchCallIndex = block.indexOf('window.beehive.searchLyrics(');
  assert.ok(guardIndex >= 0 && shortcutIndex > guardIndex, 'the embedded-lyrics shortcut must be nested inside the !forceSearch guard');
  assert.ok(searchCallIndex > shortcutIndex, 'the actual search must be reachable after the embedded-lyrics shortcut');
  // The click handler itself must request forceSearch.
  assert.match(renderer, /getElementById\('tag-lyrics-search'\)\?\.addEventListener\('click', \(\) => \{\s*if \(editingTrack\) void refreshTagEditorLyrics\(editingTrack, true\);/);
});

test('the tag editor always searches Genius/plain lyrics, never LRCLIB/synced, independent of the left-side Highlighted lyrics setting', () => {
  // Real bug: this call reused highlightedLyricsEnabled() -- the setting
  // that controls the left-side synced-lyrics *display* -- to decide
  // whether to query LRCLIB (synced) first. With that setting on (the
  // user's own stated preference for the left side), clicking "Search
  // online" in the tag editor searched LRCLIB/synced instead of Genius.
  // The editor only ever manages standard/plain embedded lyrics and must
  // always request Genius specifically, regardless of that setting.
  const start = renderer.indexOf('async function refreshTagEditorLyrics(track, forceSearch = false)');
  const end = renderer.indexOf('\n\n  document.querySelectorAll(\'.tag-editor-tab\'', start);
  assert.ok(start >= 0 && end > start, 'refreshTagEditorLyrics must exist');
  const block = renderer.slice(start, end);
  assert.match(block, /highlightedLyrics:\s*false/);
  assert.doesNotMatch(block, /highlightedLyrics:\s*highlightedLyricsEnabled\(\)/);
  // Must not share a cache entry with the left-side panel's own lookup
  // (refreshTrackLyricsForDisplay), which caches under the bare per-track
  // id using whatever highlightedLyricsEnabled() preferred at the time --
  // reusing that cache here could still serve/consider a synced-preferring
  // result instead of actually searching Genius.
  assert.match(block, /const lookupId = `\$\{lyricsLookupIdForTrack\(track\)\}\|editor-plain`;/);
});

test('lyrics timestamp stripping recognizes both bracket and angle-bracket formats, with either a period or comma fraction separator', () => {
  // Real bug: the stripping regex only matched [mm:ss.xx]/[mm:ss:xx]. Any
  // other real-world LRC variant (enhanced/word-level <mm:ss.xx> karaoke
  // tags, or a comma fraction separator some providers/tools use) silently
  // passed through UNCHANGED instead of failing safely -- confirmed live:
  // visible timestamps leaked into the "plain" lyrics tag editor.
  assert.match(renderer, /const LYRICS_TIMESTAMP_RE = \/\[\[<\]\(\?:\(\?:\\d\+\):\)\?\\d\{1,3\}:\\d\{2\}\(\?:\[\.,:\]\\d\{1,3\}\)\?\[\\\]>\]\/g;/);
});

test('Build 199 makes the edit dialog tabs and Save action consistently sized controls', () => {
  assert.match(css, /\.tag-editor-tab \{[^}]*white-space:nowrap;/s);
  assert.match(css, /\.tag-actions #tag-save \{[^}]*background:var\(--control-bg\)/s);
  assert.match(css, /\.tag-actions \.sidebar-add \{[^}]*min-height:34px/);
  assert.match(css, /\.tag-time-grid input, \.tag-time-offset input \{[^}]*min-height:38px/s);
});
