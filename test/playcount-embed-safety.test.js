'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'index.html'), 'utf8');

// A user cleared their Hive play counts, then replaced them with an imported
// MusicBee history; after a restart the old pre-clear counts came back. Root
// cause: the scanner's stats/old-cache/track-scan merge used `stats[path]
// ?.playCount || old?.playCount || track.playCount || 0`. A legitimate 0 from
// Clear Play Counts or a play-count replacement is falsy, so it was treated
// as "no answer yet" and fell through to a stale cached count (and ultimately
// to whatever count is still embedded in the file itself, which neither
// operation touches). `??` must be used so a real 0 in stats.json is final.
test('the library scan never lets a stale cache/embedded value override a real 0 play count from stats.json', () => {
  const scanMergeSnippets = [...MAIN_JS.matchAll(/playCount: Number\(stats\[[^\]]+\][^,]*\),/g)].map(m => m[0]);
  assert.ok(scanMergeSnippets.length >= 2, 'expected the playCount merge to appear in both the incremental and full scan paths');
  for (const snippet of scanMergeSnippets) {
    assert.ok(
      snippet.includes('stats[') && /stats\[[^\]]+\]\?\.playCount\s*\?\?/.test(snippet),
      `playCount merge must use ?? (presence check), not || (truthiness check), so a real 0 is not treated as missing: ${snippet}`
    );
    assert.ok(!snippet.includes('||'), `playCount merge must not fall back with ||, which treats a real 0 as absent: ${snippet}`);
  }
});

// Revised per explicit user request: a Wrapped import resets every library
// track's play count, then a track actually present in the imported archive
// gets set back to its full count (additive -- imported plays plus whatever
// Hive has natively recorded for it, per getMusicBeeImportedPlayCounts'
// archiveMatchedKeys, not a plain overwrite that would discard native plays).
// A track Hive has only ever played natively, never present in any imported
// archive, drops to zero -- the import has no record of it. (An earlier
// version of this project only ever touched matched tracks and left
// everything else alone; that was reversed on request, with an explicit
// warning added to the renderer's confirmation dialog.)
test('replacing play counts from an import sets archive-matched tracks to their (additive) imported count and resets every other library track to zero', () => {
  const handlerMatch = MAIN_JS.match(/ipcMain\.handle\('yearly-wrap:replacePlayCounts'[\s\S]*?\n\}\)\);/);
  assert.ok(handlerMatch, 'expected to find the yearly-wrap:replacePlayCounts handler');
  const block = handlerMatch[0];
  assert.match(block, /const nextStats = \{ \.\.\.stats \};/);
  // A second pass over every library track must reset anything not matched
  // to a zero play count.
  assert.match(
    block,
    /for \(const track of tracks\) \{\s*\n\s*if \(!track\?\.path \|\| matchedPaths\.has\(track\.path\)\) continue;\s*\n\s*nextStats\[track\.path\] = \{ \.\.\.\(stats\[track\.path\] \|\| \{\}\), playCount: 0,/,
    'must reset every unmatched library track\'s stats entry to a zero play count'
  );
  // The library-cache rewrite must also apply to every track, not only
  // matched ones, so unmatched tracks visibly drop to zero without a restart.
  assert.doesNotMatch(
    block,
    /if \(!track\?\.path \|\| !matchedPaths\.has\(track\.path\)\) return track;/,
    'must not skip remapping unmatched tracks -- they need their playCount zeroed too'
  );
});

// Companion bug: after "Replace Hive play counts from MusicBee", the button's
// disk write succeeded, but the renderer's in-memory library.tracks (a
// separate copy of the same data) was never updated, so the Tracks view kept
// showing whatever it had before -- all zero, if the user had just run Clear
// Play Counts. The IPC handler must hand back the new counts, and the
// renderer must apply them to library.tracks before re-rendering.
test('replacing play counts from MusicBee returns updated per-track counts, and the renderer applies them in place', () => {
  const handlerMatch = MAIN_JS.match(/ipcMain\.handle\('yearly-wrap:replacePlayCounts'[\s\S]*?\n\}\)\);/);
  assert.ok(handlerMatch, 'expected to find the yearly-wrap:replacePlayCounts handler');
  assert.match(handlerMatch[0], /updatedPlayCounts/, 'the handler must return the new per-path play counts so the renderer can sync its in-memory library without a restart');

  assert.match(
    RENDERER_JS,
    /replaceMusicBeePlayCounts\(\)[\s\S]{0,1200}updatedPlayCounts[\s\S]{0,400}track\.playCount\s*=/,
    'the Replace button handler must apply result.updatedPlayCounts onto library.tracks, the same way the Clear Play Counts handler zeroes it in place'
  );
});

// New feature: after importing + replacing play counts from a MusicBee
// Wrapped archive on a clean install, the user wants those counts stamped
// into the actual files even if that means *lowering* an already-embedded
// P_count -- something the ordinary Embed action deliberately never does
// (it only ever adds a delta on top of the existing value). This is invoked
// internally from the combined Import flow, not exposed as its own preview
// dialog (that got simplified away -- see the redesign test below).
test('force-embedding play counts writes the absolute local count (not a delta) and resets the embedded baseline', () => {
  const handlerMatch = MAIN_JS.match(/ipcMain\.handle\('stats:forceEmbedPlayCounts'[\s\S]*?\n\}\)\);/);
  assert.ok(handlerMatch, 'expected to find the stats:forceEmbedPlayCounts handler');
  const block = handlerMatch[0];
  // Must call writeEmbeddedPlayCount(path, localCount) directly -- not
  // embedPlayCountDelta, which only ever adds and never lowers a value.
  assert.match(block, /writeEmbeddedPlayCount\(trackPath, localCount\)/);
  assert.doesNotMatch(block, /embedPlayCountDelta\(/, 'force-embed must not go through the delta-only embed path');
  // The file must be backed up before being overwritten. This used to be a
  // dedicated backupFileBeforePlayCountOverwrite call; play-count embedding
  // was since unified onto the same temp-copy+backup+atomic-commit pipeline
  // every other metadata writer uses (writeEmbeddedPlayCount ->
  // commitMetadataTemp -> backupFileBeforeMetadataCommit, all in
  // app/main/metadata-writer.js-adjacent code), which is why this handler no
  // longer calls a play-count-specific backup function directly -- it's
  // exercised end to end in test/metadata-writer-module.test.js.
  const writerMatch = MAIN_JS.match(/async function writeEmbeddedPlayCount\([\s\S]*?\n\}/);
  assert.ok(writerMatch, 'expected to find writeEmbeddedPlayCount');
  assert.match(writerMatch[0], /await commitMetadataTemp\(temp, trackPath, false\)/, 'writeEmbeddedPlayCount must commit through the shared backed-up atomic-rename path');
  // The baseline must be reset to the new value so a later ordinary Embed
  // resumes as a normal incremental delta on top of this new starting point.
  assert.match(block, /entry\.pCountEmbeddedLocal = localCount/);
});

// Companion to the replace-reset test above: force-embed accepts an explicit
// paths argument rather than unconditionally sweeping stats.json itself, and
// the Import flow passes it whatever Replace just wrote back
// (updatedPlayCounts), so the two stay in lockstep. Since a Wrapped import
// now resets the whole library (matched tracks to their imported count,
// everything else to zero), updatedPlayCounts legitimately covers the whole
// library in that flow -- the scoping mechanism itself is still what lets a
// caller that only wants a subset (e.g. one file's Embed action) avoid
// touching stats.json entries it wasn't asked about.
test('force-embedding play counts is scoped to the given paths when provided, and the Import flow passes it the paths Replace just wrote', () => {
  const handlerMatch = MAIN_JS.match(/ipcMain\.handle\('stats:forceEmbedPlayCounts'[\s\S]*?\n\}\)\);/);
  const block = handlerMatch[0];
  assert.match(block, /async \(_evt, paths\) =>/, 'the handler must accept an optional paths argument');
  assert.match(block, /scopedPaths/);
  assert.doesNotMatch(
    block,
    /for \(const \[trackPath, rawEntry\] of Object\.entries\(stats\)\)/,
    'must not unconditionally iterate the entire stats object once scoping is available'
  );

  const start = RENDERER_JS.indexOf("el.importMusicBeeWrappedBtn?.addEventListener('click'");
  const end = RENDERER_JS.indexOf("\n  });", start);
  const flowBlock = RENDERER_JS.slice(start, end);
  assert.match(
    flowBlock,
    /forceEmbedPlayCounts\(Object\.keys\(updatedPlayCounts \|\| \{\}\)\)/,
    'the Import flow must pass forceEmbedPlayCounts exactly the paths Replace just returned'
  );
});

// Each changed file's force-embed involves a full-file backup+hash plus an
// ffmpeg remux, so processing files one at a time made a large Wrapped
// import/overwrite visibly slow. Every other per-track I/O loop in this file
// (readEmbeddedPlayCount scans, etc.) already uses a bounded worker pool;
// force-embed must too, instead of a plain sequential for-of.
test('force-embedding play counts processes files concurrently through a bounded worker pool, not one at a time', () => {
  const handlerMatch = MAIN_JS.match(/ipcMain\.handle\('stats:forceEmbedPlayCounts'[\s\S]*?\n\}\)\);/);
  assert.ok(handlerMatch, 'expected to find the stats:forceEmbedPlayCounts handler');
  const block = handlerMatch[0];
  assert.match(block, /const workerCount = Math\.min\(8, Math\.max\(1, entries\.length\)\)/);
  assert.match(block, /Array\.from\(\{ length: workerCount \}/);
  assert.match(block, /await Promise\.all\(workers\)/);
  assert.doesNotMatch(
    block,
    /^\s*for \(const \[trackPath, rawEntry\] of entries\)/m,
    'must not process the entries array with a plain sequential for-of loop'
  );
});

// The "Export Hive Wrapped" feature needs native Hive plays to always land
// in the same per-year Wrapped store used for a MusicBee import/export --
// not only once the user has explicitly imported a MusicBee archive -- so
// export works from a totally clean install with zero imports ever done.
test('native Hive plays mirror into the Wrapped store unconditionally, not only once a MusicBee archive has been imported', () => {
  const start = MAIN_JS.indexOf("ipcMain.handle('listening:record'");
  const end = MAIN_JS.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, 'expected to find the listening:record handler');
  const block = MAIN_JS.slice(start, end);
  assert.doesNotMatch(
    block,
    /if \(importState\?\.syncEnabled\)/,
    'mirroring into the Wrapped store must not be gated behind a prior explicit MusicBee import'
  );
  assert.match(block, /appendMusicBeeHiveEvent\(HIVE_WRAPPED_DATA_ROOT\(\), event\)/);

  const exportMatch = MAIN_JS.match(/ipcMain\.handle\('yearly-wrap:exportWrapped'[\s\S]*?\n\}\);/);
  assert.ok(exportMatch, 'expected the renamed yearly-wrap:exportWrapped export handler');
  assert.doesNotMatch(
    exportMatch[0],
    /state\?\.syncEnabled/,
    'exporting Hive Wrapped data must not require a prior explicit MusicBee import, only that some Wrapped history exists'
  );
});

// The History settings tab was redesigned down to exactly four actions: an
// Embed-play-counts toggle (on by default), Import/Export inside a single
// Wrapped-data card, and Clear play counts. Everything else -- "Embed
// current play counts", its zero-conflict preview/overwrite dialog,
// "Import embedded P_count", the standalone "Replace play counts" button,
// and the standalone "Force-overwrite" button + its own preview/modal -- is
// gone. Replace and Force-overwrite are still real backend actions, but are
// now invoked internally from one guided Import flow instead of exposed as
// separate buttons/dialogs.
test('the settings redesign removes every action except the four kept buttons/toggle, not just hides them', () => {
  assert.doesNotMatch(INDEX_HTML, /id="embed-play-counts-now-btn"/);
  assert.doesNotMatch(INDEX_HTML, /id="import-embedded-play-counts-btn"/);
  assert.doesNotMatch(INDEX_HTML, /id="replace-musicbee-playcounts-btn"/);
  assert.doesNotMatch(INDEX_HTML, /id="force-embed-playcounts-btn"/);
  assert.doesNotMatch(INDEX_HTML, /id="force-embed-playcounts-modal"/);

  assert.doesNotMatch(MAIN_JS, /'stats:embedCurrentPlayCounts'/);
  assert.doesNotMatch(MAIN_JS, /'stats:getEmbedPlayCountConflicts'/);
  assert.doesNotMatch(MAIN_JS, /'stats:importEmbeddedPlayCounts'/);
  assert.doesNotMatch(MAIN_JS, /'yearly-wrap:previewPlayCountReplacement'/);
  assert.doesNotMatch(MAIN_JS, /'stats:previewForceEmbedPlayCounts'/);
  assert.doesNotMatch(MAIN_JS, /collectEmbeddedPlayCountConflicts/);
  assert.doesNotMatch(MAIN_JS, /importEmbeddedPlayCountsIntoStats/);
  assert.doesNotMatch(MAIN_JS, /playcount-embed-policy/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'app', 'main', 'playcount-embed-policy.js')));

  assert.doesNotMatch(RENDERER_JS, /embedPlayCountsNowBtn/);
  assert.doesNotMatch(RENDERER_JS, /importEmbeddedPlayCountsBtn/);
  assert.doesNotMatch(RENDERER_JS, /replaceMusicBeePlaycountsBtn/);
  assert.doesNotMatch(RENDERER_JS, /forceEmbedPlaycounts/);
  assert.doesNotMatch(RENDERER_JS, /previewMusicBeePlayCountReplacement/);
  assert.doesNotMatch(RENDERER_JS, /previewForceEmbedPlayCounts/);

  // The four kept elements must still be present.
  assert.match(INDEX_HTML, /id="setting-embed-play-counts"/);
  assert.match(INDEX_HTML, /id="import-musicbee-wrapped-btn"/);
  assert.match(INDEX_HTML, /id="export-hive-wrapped-btn"/);
  assert.match(INDEX_HTML, /id="clear-play-counts-btn"/);
});

// The Import button now drives one guided flow: an explanatory dialog before
// the file picker, the import itself, then a single yes/no prompt to apply
// the imported counts as Hive's authoritative play counts -- which must call
// both replaceMusicBeePlayCounts() (Hive's local counts) and
// forceEmbedPlayCounts() (each file's embedded P_count) together, so the
// user's "10 plays imported, listen once more -> 11 everywhere" expectation
// holds for both the local count and the embedded tag.
test('the Import Wrapped data flow explains itself, then offers to overwrite both Hive counts and embedded P_count together', () => {
  const start = RENDERER_JS.indexOf("el.importMusicBeeWrappedBtn?.addEventListener('click'");
  const end = RENDERER_JS.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start, 'expected to find the Import Wrapped data click handler');
  const block = RENDERER_JS.slice(start, end);
  assert.match(block, /themedAlert\(/, 'must explain the MusicBee/Hive format before opening the file picker');
  assert.match(block, /chooseMusicBeeWrappedImport\(\)/);
  assert.match(block, /importMusicBeeWrapped\(archivePath\)/);
  assert.match(block, /themedConfirm\(/, 'must ask a single yes/no question about overwriting play counts');
  assert.match(block, /replaceMusicBeePlayCounts\(\)/);
  assert.match(block, /forceEmbedPlayCounts\(/);
  // Force-embed must only run after the user says yes, not unconditionally.
  const confirmIndex = block.indexOf('themedConfirm(');
  const replaceIndex = block.indexOf('replaceMusicBeePlayCounts()');
  const embedIndex = block.indexOf('forceEmbedPlayCounts(');
  assert.ok(confirmIndex < replaceIndex && replaceIndex < embedIndex, 'must confirm, then replace Hive counts, then force-embed, in that order');
});

// Embedding is now on by default; only an explicit prior opt-out (a saved
// `false`) should keep it off. A profile that never touched the setting must
// read as enabled.
test('embed-play-counts defaults to enabled unless explicitly turned off', () => {
  const getterMatch = MAIN_JS.match(/ipcMain\.handle\('stats:getEmbedPlayCounts'[\s\S]*?\n\}\);/);
  assert.ok(getterMatch, 'expected the stats:getEmbedPlayCounts handler');
  assert.match(getterMatch[0], /config\.embedPlayCounts !== false/);
  assert.doesNotMatch(getterMatch[0], /!!config\.embedPlayCounts/, 'must not use a truthiness check, which would default to off');

  const recordPlayStart = MAIN_JS.indexOf("ipcMain.handle('track:recordPlay'");
  const recordPlayEnd = MAIN_JS.indexOf('\n});', recordPlayStart);
  const recordPlayBlock = MAIN_JS.slice(recordPlayStart, recordPlayEnd);
  assert.match(recordPlayBlock, /config\.embedPlayCounts !== false/);
});

// Clear Play Counts used to only reset stats.json/the library cache, a
// display-layer cache -- the real source of truth (listening-events.json
// and the Hive Wrapped Data store) was left completely untouched. That made
// a "cleared" library still hand its old native listening history back to a
// later Wrapped import, silently reintroducing counts the user thought
// they'd just wiped. Clearing must also drop Hive's own native
// (source:'hive'/non-'musicbee-wrapped') listening history, while
// preserving anything that came from an already-imported archive.
test('clearing play counts also drops Hive\'s native listening history, not just the stats.json display cache', () => {
  const handlerMatch = MAIN_JS.match(/ipcMain\.handle\('stats:clearPlayCounts'[\s\S]*?\n\}\)\);/);
  assert.ok(handlerMatch, 'expected to find the stats:clearPlayCounts handler');
  const block = handlerMatch[0];
  assert.match(
    block,
    /events\.filter\(e => e\?\.source === 'musicbee-wrapped'\)/,
    'must filter listening-events.json down to only archive-imported events, dropping native ones'
  );
  assert.match(
    block,
    /survivors = priorPlays\.filter\(p => p\.source !== 'hive'\)/,
    'must drop native (\'hive\'-sourced) plays from every year of the Hive Wrapped Data store'
  );
  assert.doesNotMatch(
    INDEX_HTML.match(/id="clear-play-counts-modal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] || '',
    /history will not be deleted or modified/,
    'the confirmation dialog must not claim history is preserved now that native listening history is cleared too'
  );
});

// Embedding P_count after an ordinary song finishes playing used to trigger a
// visible library rescan/refresh ~900ms later, for no reason a listener would
// expect. Root cause: unlike every other metadata writer (Rating, Love,
// artwork, general tag-editor save all call markLibraryInternalWrite before
// touching the file), writeEmbeddedPlayCount never marked its own write as
// internal, so the filesystem watcher treated Hive's own P_count write as an
// external library change and queued a rescan of the affected path(s).
test('writeEmbeddedPlayCount marks its own write as internal so the library watcher does not treat it as an external change', () => {
  const writerMatch = MAIN_JS.match(/async function writeEmbeddedPlayCount\([\s\S]*?\n\}/);
  assert.ok(writerMatch, 'expected to find writeEmbeddedPlayCount');
  const block = writerMatch[0];
  const markIndex = block.indexOf('markLibraryInternalWrite(trackPath)');
  const tempIndex = block.indexOf('createMetadataTempPath(trackPath');
  assert.ok(markIndex >= 0, 'writeEmbeddedPlayCount must mark itself as an internal write');
  assert.ok(tempIndex > markIndex, 'the write must be marked internal before the file is touched, not after');
});
