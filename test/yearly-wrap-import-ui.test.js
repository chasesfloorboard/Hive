'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
const wrap = fs.readFileSync(path.join(root, 'app/renderer/yearly-wrap.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

test('Settings exposes the MusicBee Wrapped archive importer', () => {
  assert.match(index, /id="import-musicbee-wrapped-btn"/);
  assert.match(renderer, /chooseMusicBeeWrappedImport/);
  assert.match(renderer, /importMusicBeeWrapped/);
  assert.match(preload, /yearly-wrap:chooseMusicBeeImport/);
  assert.match(preload, /yearly-wrap:importMusicBee/);
});

test('Yearly Wrap can browse imported historical years and resolves local cover references', () => {
  assert.match(preload, /yearly-wrap:getYears/);
  assert.match(wrap, /id="year-select"/);
  assert.match(wrap, /getYearlyWrapYears/);
  assert.match(wrap, /function wrapCoverSrc\(src\)/);
  assert.match(wrap, /window\.beehive\.coverUrl\(s\)/);
  assert.match(wrap, /img\.src=wrapCoverSrc\(src\)\|\|src/);
});

test('MusicBee imports retain provenance and year metadata', () => {
  assert.match(main, /MUSICBEE_WRAPPED_IMPORTS_PATH/);
  assert.match(main, /source: 'musicbee-wrapped'/);
  assert.match(main, /legacyFileUrl/);
  assert.match(main, /importedMetadata/);
  assert.match(main, /musicBeeImportPlayId/);
});

// The History/Playcounts settings tab was cluttered with a flat list of
// import/export/replace/embed/clear buttons and paragraphs of hint text.
// Redesigned down to four elements: an Embed-play-counts toggle (on by
// default), a Wrapped-data card with just Import + Export, and Clear play
// counts. Replace/Force-overwrite still exist as real actions, but only as
// internal steps of the Import flow -- see playcount-embed-safety.test.js
// for that flow and for verifying the removed actions are gone, not hidden.
test('Settings exposes the redesigned four-action History panel: embed toggle, Import/Export Wrapped data, Clear', () => {
  assert.match(index, /History &amp; Play Counts/);
  assert.match(index, /id="setting-embed-play-counts"/);
  assert.match(index, /id="import-musicbee-wrapped-btn"/);
  assert.match(index, /id="export-hive-wrapped-btn"/);
  assert.match(index, /id="clear-play-counts-btn"/);
  assert.doesNotMatch(index, /id="export-musicbee-wrapped-btn"/, 'the old MusicBee-only export button should be replaced, not duplicated');

  assert.match(renderer, /exportHiveWrappedBtn/);
  assert.match(renderer, /chooseHiveWrappedExport/);
  assert.match(renderer, /exportHiveWrapped\(destination\)/);

  assert.match(preload, /chooseHiveWrappedExport:.*yearly-wrap:chooseWrappedExport/);
  assert.match(preload, /exportHiveWrapped:.*yearly-wrap:exportWrapped/);
  assert.match(preload, /forceEmbedPlayCounts:.*stats:forceEmbedPlayCounts/);
});

// Real bugs the user found across every Yearly Wrap share image and the
// in-app slides: months rendered as raw "2026-02" strings (or just "02"
// after a naive .slice(5) on the bar labels) instead of a real month name,
// and the final slide's canvas renderer drew its own headline text twice --
// once from the generic per-slide title block every slide already gets, and
// again as its own redundant draw call -- producing two overlapping copies
// of "The music stays with you." stacked on the shared image.
test('Yearly Wrap months are formatted as real month names, never raw "2026-02" or a bare "02"', () => {
  assert.match(wrap, /const fmtMonth=s=>/);
  assert.match(wrap, /const fmtMonthYear=s=>/);
  assert.doesNotMatch(wrap, /x\.month\.slice\(5\)/);
  assert.doesNotMatch(wrap, /m\.month\.slice\(5\)/);
  assert.doesNotMatch(wrap, /\$\{data\.topMonth\?\.month\|\|/);
  assert.doesNotMatch(wrap, /\$\{data\.topMonth\.month\} was your biggest month/);
  assert.match(wrap, /esc\(fmtMonth\(x\.month\)\)/);
  assert.match(wrap, /fmtMonth\(m\.month\)/);
  assert.match(wrap, /data\.topMonth\?fmtMonthYear\(data\.topMonth\.month\):'—'/);
  assert.match(wrap, /\$\{fmtMonthYear\(data\.topMonth\.month\)\} was your biggest month/);
});

test('the final Yearly Wrap share slide draws its headline exactly once, not twice', () => {
  const elseStart = wrap.indexOf('} else {');
  const elseEnd = wrap.indexOf('\n }', elseStart);
  assert.ok(elseStart >= 0 && elseEnd > elseStart, 'expected to find the final-slide canvas branch');
  const block = wrap.slice(elseStart, elseEnd);
  assert.doesNotMatch(block, /wrapText\(ctx,'The music stays with you\.'/, 'the final slide must not redraw its own copy of the title the generic title block already drew');
  assert.match(block, /const stats=\[/);
});

test('the "Imported from MusicBee Wrapped" badge is removed from Yearly Wrap', () => {
  assert.doesNotMatch(wrap, /Imported from MusicBee Wrapped/);
  assert.doesNotMatch(wrap, /const imported=data\.imported/);
});

test('Share and Copy image are consolidated into one button -- Share already falls back to copying when no native share sheet is available', () => {
  assert.doesNotMatch(wrap, /id="copy">Copy image/);
  assert.doesNotMatch(wrap, /document\.getElementById\('copy'\)\.onclick=copyImage/);
  assert.match(wrap, /id="share">Share/);
  // shareImage() must still fall back to the same copyImage() logic itself.
  const shareStart = wrap.indexOf('async function shareImage(){');
  const shareEnd = wrap.indexOf('}\n', shareStart);
  assert.match(wrap.slice(shareStart, shareEnd + 1), /await copyImage\(\);/);
});

// Real bug the user reported with a screenshot: each month label's vertical
// position was `.bar`'s own top + a fixed margin-top, but bars are
// flex-end-aligned within a fixed-height container (only their TOP varies
// with each month's own bar height, not their bottom). So short-bar months'
// labels landed far below tall-bar months' labels instead of lining up in
// one row -- scattered labels overlapped the "Biggest day"/"Biggest month"
// cards underneath. Fixed by anchoring each label to its bar's `bottom`
// (which is always the same, container-aligned position) instead of `top` +
// margin, so every label sits the same fixed distance below the chart
// regardless of that bar's own height.
test('every month label under the bars chart lines up in one row, regardless of that bar\'s own height', () => {
  assert.match(wrap, /\.bar label\{position:absolute;left:0;right:0;bottom:-24px;text-align:center;/);
  assert.doesNotMatch(wrap, /\.bar label\{[^}]*margin-top/, 'a label position tied to its own bar\'s height (via margin-top on the height-varying bar) is what scattered the labels');
});

// Real bug the user flagged with screenshots: several of the shareable
// canvas slides (makeShareCanvas) left large stretches of the 1080x1080
// canvas empty -- the Top albums 2x2 grid used small, left-anchored covers
// (220px, pitch 250) that only reached about half the canvas's available
// content width, and the Top track/Top artist slides paired a cover with
// three sparse, short text lines and a bare (uncarded) "plays" line,
// leaving the whole bottom third of the canvas blank. Fixed by enlarging
// the covers/cards, giving "plays" the same stat-card treatment used
// elsewhere, and (for the albums grid specifically) computing its layout to
// center within and fill the canvas's actual content width instead of
// being pinned to a fixed left-anchored pitch.
test('the share-canvas slides use bigger, better-filled layouts instead of leaving large empty regions', () => {
  // Top track and Top artist: a real stat card for "plays", not a bare
  // text line, and a large (400px) cover -- mirrored between the two so
  // cover-left/text-right (track) and text-left/cover-right (artist) match.
  const trackBlock = wrap.slice(wrap.indexOf('} else if(index===2){'), wrap.indexOf('} else if(index===3){'));
  assert.match(trackBlock, /const trkW=400;/);
  assert.match(trackBlock, /roundRect\(ctx,trkTextX,trkCardY,trkCardW,trkCardH,18\);ctx\.fillStyle='rgba\(255,255,255,\.07\)';ctx\.fill\(\);/);
  assert.doesNotMatch(trackBlock, /\$\{\(top\?\.plays\|\|0\)\.toLocaleString\(\)\} plays`/, 'plays must be a stat card, not a bare "N plays" text line');

  const artistBlock = wrap.slice(wrap.indexOf('} else if(index===3){'), wrap.indexOf('} else if(index===4){'));
  assert.match(artistBlock, /const artW=400;/);
  assert.match(artistBlock, /roundRect\(ctx,pad,artCardY,artCardW,artCardH,18\);ctx\.fillStyle='rgba\(255,255,255,\.07\)';ctx\.fill\(\);/);
  assert.doesNotMatch(artistBlock, /\$\{\(artist\?\.plays\|\|0\)\.toLocaleString\(\)\} plays`/, 'plays must be a stat card, not a bare "N plays" text line');

  // Top albums: the grid must be centered within the canvas's content width
  // (pad to size-pad), not left-anchored at a fixed pitch.
  const albumsBlock = wrap.slice(wrap.indexOf('} else if(index===4){'), wrap.indexOf('} else if(index===5){'));
  assert.match(albumsBlock, /const albW=280,albGap=28,albGridW=albW\*2\+albGap,albX0=pad\+\(size-pad\*2-albGridW\)\/2,albY0=300;/);
  assert.ok(280 > 220, 'covers must be bigger than the original 220px');
});

// Requested directly: show Top genre on the final "That's your year" slide.
// Kept the slide at 4 cards (not 5) per explicit follow-up feedback --
// "Listening time" was removed instead of appended, since an earlier slide
// already shows total listening time front and center.
// Requested directly: remove the "Hive icon" watermark toggle from Yearly
// Wrap -- the user doesn't want the logo shown there at all. The IPC
// channel behind it (yearly-wrap:getBrandIcon / getYearlyWrapBrandIcon)
// stays: despite its name it's also the shared source for the MAIN
// renderer's own top-left brand button and About dialog logo (see
// renderer.js's "The Hive logo is a shared brand asset" comment) -- only
// the Yearly Wrap window's own toggle UI and its use of that data were
// removed.
test('the Yearly Wrap "Hive icon" watermark toggle is removed, but the shared brand-icon IPC channel other UI still uses stays', () => {
  assert.doesNotMatch(wrap, /Hive icon/);
  assert.doesNotMatch(wrap, /show-brand/);
  assert.doesNotMatch(wrap, /brand-toggle/);
  assert.doesNotMatch(wrap, /brandIconData/);
  assert.doesNotMatch(wrap, /syncBrand/);
  assert.doesNotMatch(wrap, /getYearlyWrapBrandIcon/);
  assert.doesNotMatch(wrap, /class="brand[" ]/);

  assert.match(main, /ipcMain\.handle\('yearly-wrap:getBrandIcon', async \(\) => \{/);
  assert.match(preload, /getYearlyWrapBrandIcon: \(\) => ipcRenderer\.invoke\('yearly-wrap:getBrandIcon'\)/);
  assert.match(renderer, /void window\.beehive\.getYearlyWrapBrandIcon\?\.\(\)\.then/);
});

test('the final slide shows Top genre and keeps 4 cards, not 5, since Listening time already has its own earlier slide', () => {
  const start = wrap.indexOf("THAT'S YOUR YEAR");
  const end = wrap.indexOf('</section>', start);
  const block = wrap.slice(start, end);
  assert.match(block, /<span>Top genre<\/span><strong>\$\{esc\(data\.topGenres\?\.\[0\]\?\.name\|\|'—'\)\}<\/strong>/);
  assert.doesNotMatch(block, /<span>Listening time<\/span>/);
  const cardCount = (block.match(/class="card"/g) || []).length;
  assert.equal(cardCount, 4);
});
