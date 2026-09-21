'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'resources', 'python', 'tag_helper.py'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app', 'main', 'main.js'), 'utf8');

test('blank artwork slots expose the same choose/search/paste/remove interaction surface as real artwork', () => {
  const blockStart = renderer.indexOf("list.querySelectorAll('.artwork-library-blank-card')");
  const blockEnd = renderer.indexOf('  }\n  let artworkEditorReloadGeneration', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = renderer.slice(blockStart, blockEnd);
  assert.match(block, /data-artwork-blank-upload/);
  assert.match(renderer, /pasteCover\(\)/);
  assert.match(block, /showContextMenu\(e\.clientX, e\.clientY/);
  assert.match(block, /Choose Picture…/);
  assert.match(block, /Paste Picture/);
  assert.match(block, /Search Internet for Cover…/);
});

test('new blank artwork defaults to front when no front cover exists and back when a front exists', () => {
  assert.match(renderer, /function defaultArtworkBlankType\(pictures = artworkEditorPictures\)\s*\{[\s\S]*?Cover \(Front\)[\s\S]*?Cover \(Back\)/);
  assert.match(renderer, /ensureArtworkEditorBlankSlot\(\)\s*\{[\s\S]*?type: defaultArtworkBlankType\(\)/);
});

test('artwork metadata persistence uses the captured slot identity and cannot reference an out-of-scope slot', () => {
  const blockStart = renderer.indexOf('const persistArtworkMeta = () =>');
  const blockEnd = renderer.indexOf("card.querySelector('[data-artwork-type]')?.addEventListener('change'", blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart);
  const block = renderer.slice(blockStart, blockEnd);
  assert.doesNotMatch(block, /slot\?\.hash/);
  assert.match(block, /changedPicture\?\.hash/);
});

test('adding a second artwork picture appends instead of clearing existing pictures', () => {
  const blockStart = helper.indexOf('def apply_artwork_flac(f, op):');
  const blockEnd = helper.indexOf('\ndef apply_artwork_mp3(', blockStart);
  const block = helper.slice(blockStart, blockEnd);
  assert.match(block, /if action=='add':/);
  assert.match(block, /old\.append\(make_flac_picture/);
  assert.match(block, /f\.clear_pictures\(\)/);
  assert.match(block, /for picture in old: f\.add_picture\(picture\)/);
  assert.match(block, /if action=='replace': old\[index\]=/);
});

test('artwork editor supports drag-and-drop image input on both filled and blank cards', () => {
  assert.match(renderer, /function bindArtworkDropTarget\(/);
  assert.match(renderer, /dataTransfer\?\.files/);
  assert.match(renderer, /image\//);
  assert.match(renderer, /fillArtworkBlankSlot\(/);
  assert.match(renderer, /replaceArtworkItem\(/);
});

test('artwork editor provides explicit front and back cover quick actions', () => {
  assert.match(renderer, /data-artwork-quick-front/);
  assert.match(renderer, /data-artwork-quick-back/);
  assert.match(renderer, /Cover \(Front\)/);
  assert.match(renderer, /Cover \(Back\)/);
});

test('artwork editor styles make the primary front/back slots visually distinct without breaking the existing theme', () => {
  assert.match(css, /\.artwork-quick-actions/);
  assert.match(css, /\.artwork-library-card\.drag-over/);
});

test('artwork reconciliation stays incremental and does not replace the full 30k-track library', () => {
  const start = renderer.indexOf('async function reconcileArtworkAfterBackgroundWrite(');
  const end = renderer.indexOf('\n  async function syncCurrentTrackArtwork(', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.doesNotMatch(block, /scanChangedLibrary\(/);
  assert.doesNotMatch(block, /applyLibrary\(lib/);
  assert.doesNotMatch(block, /buildAlbums\(/);
});

test('current-track cover rotation synchronizes player, queue, album, and expanded album surfaces', () => {
  const start = renderer.indexOf('function refreshCoverRotationTargets()');
  const end = renderer.indexOf('\n  let hiveLogoSourceDataUrl', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /const targets = \[el\.pbCover, el\.npCover\]/);
  assert.match(block, /targets\.push\(queueThumb\)/);
  assert.match(block, /document\.querySelectorAll\(\'\.album-card\'\)/);
  assert.match(block, /document\.querySelectorAll\(\'\.inline-album-dropdown\'\)/);
});

test('artwork embedding progress uses the compact top-bar status next to search', () => {
  assert.match(indexHtml, /id="metadata-embed-status"/);
  assert.match(indexHtml, /id="metadata-embed-status-text"/);
  assert.match(indexHtml, /id="metadata-embed-spinner"/);
  const start = renderer.indexOf('function showTagOperationProgress(payload)');
  const end = renderer.indexOf('\n  tagOperationOff =', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /metadataEmbedStatus/);
  assert.match(block, /metadataEmbedStatusText/);
  assert.match(block, /Embedding/);
  assert.doesNotMatch(block, /el\.scanProgress/);
  assert.doesNotMatch(block, /el\.scanFill/);
});

test('artwork metadata jobs identify themselves so only artwork writes show the embedding indicator', () => {
  const start = renderer.indexOf('for (const job of backgroundArtworkJobs)');
  const end = renderer.indexOf('const metadataJobs =', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /entry\.operation = 'artwork'/);
  assert.match(block, /entry\.artwork =/);
  assert.match(main, /operation:normalizedJobs\.some\(j=>j\.operation==='artwork'\)\?'artwork':'metadata'/);
  assert.match(main, /active:false,operation:normalizedJobs\.some\(j=>j\.operation==='artwork'\)\?'artwork':'metadata'/);
});

test('artwork embedding status has a compact spinner and stays in the top bar', () => {
  assert.match(css, /\.metadata-embed-status/);
  assert.match(css, /\.metadata-embed-spinner/);
  assert.match(css, /@keyframes metadataEmbedSpin/);
  const topbarStart = indexHtml.indexOf('<div class="topbar-right">');
  const topbarEnd = indexHtml.indexOf('</div>\n      </div>', topbarStart);
  const topbar = indexHtml.slice(topbarStart, topbarEnd > topbarStart ? topbarEnd : topbarStart + 1200);
  assert.match(topbar, /metadata-embed-status/);
});



test('album tag editor derives album scope from canonical album identity instead of a nonexistent track albumKey property', () => {
  const start = renderer.indexOf('async function openTagEditor(t, tracksOverride=null)');
  const end = renderer.indexOf('\n    document.getElementById(\'tag-editor-title\')', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /const albumMode = bulkMode && editingTracks\.every\(track => albumKey\(track\) === albumKey\(t\)\)/);
  assert.doesNotMatch(block, /track\?\.albumKey/);
});

test('album cover context menu opens the tag editor for every track in the album', () => {
  const start = renderer.indexOf('function showCoverContextMenu(e,file,model=null)');
  const end = renderer.indexOf('\n  function prepareTrackContextSelection', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /const albumTracks = Array\.isArray\(model\?\.tracks\)/);
  assert.match(block, /Change album cover…/);
  assert.match(block, /openTagEditor\(albumTracks\[0\], albumTracks\)/);
  assert.match(block, /Search Internet for album cover…/);
});

test('album track ordering parses numeric positions before title tie-breaking', () => {
  const start = renderer.indexOf('function mediaPositionNumber(value)');
  const end = renderer.indexOf('\n  function buildTrackSearchIndex', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.ok(block.includes('String(value).trim().match(/^\\s*(\\d+)/)'));
  assert.match(block, /function albumTrackCompare\(a, b\)/);
  assert.match(renderer, /a\.tracks\.sort\(albumTrackCompare\)/);
  assert.match(renderer, /slice\(\)\.sort\(albumTrackCompare\)/);
});
