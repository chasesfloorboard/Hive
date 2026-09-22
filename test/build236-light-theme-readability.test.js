'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');

test('Build 236 gives Light a brighter, higher-contrast default palette', () => {
  const start = renderer.indexOf("light:{name:'Light'");
  const end = renderer.indexOf("}},\n    ember:", start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /'--bg':'#f7f8fa'/);
  assert.match(block, /'--panel':'rgba\(255,255,255,.94\)'/);
  assert.match(block, /'--panel-strong':'rgba\(255,255,255,.985\)'/);
  assert.match(block, /'--text':'#171b22'/);
  assert.match(block, /'--text-dim':'#3f4651'/);
  assert.match(block, /'--text-dimmer':'#5f6875'/);
  assert.match(block, /'--ambient-a':'rgba\(83,102,216,.035\)'/);
  assert.match(block, /'--ambient-b':'rgba\(110,120,150,.025\)'/);
});

test('Build 236 makes Frosted Glass off use solid themed surfaces with no blur', () => {
  const start = css.indexOf('#main.player-glass-transparent,');
  const end = css.indexOf('}', start);
  assert.ok(start >= 0 && end > start);
  const block = css.slice(start, end + 1);
  assert.match(block, /background:var\(--panel-strong\) !important/);
  assert.match(block, /border:1px solid color-mix\(in srgb,var\(--accent\) 24%,var\(--border\)\) !important/);
  assert.match(block, /backdrop-filter:none !important/);
  assert.match(block, /-webkit-backdrop-filter:none !important/);
});

test('Build 236 uses white current-track artists in dark themes and dark artists in Light', () => {
  assert.match(css, /#queue-list li\.playing \.q-artist,[\s\S]*?#np-artist,[\s\S]*?#pb-artist \{ color:#fff; \}/);
  assert.match(css, /html\[data-hive-theme="light"\] #queue-list li\.playing \.q-artist,[\s\S]*?#np-artist,[\s\S]*?#pb-artist \{ color:#252a31; \}/);
});

// Real bug, confirmed: --control-bg/--control-bg-hover mix a small accent
// percentage (5%/12%) into --panel-strong, which the base rule for .glass
// right above already documented as broken in Light -- --panel-strong there
// is a near-fully-opaque white (rgba(255,255,255,.985)), so that small a mix
// reads as no color change at all. A selected song/queue row therefore
// looked almost pure white, with only the solid 2px accent-colored edge
// (box-shadow: inset 2px 0 0 var(--accent)) visibly distinguishing it.
test('Light theme boosts --control-bg/--control-bg-hover so a selected row is actually visible, not just its edge', () => {
  const start = css.indexOf('--control-bg: color-mix(in srgb, var(--accent) 18%, var(--panel-strong));');
  assert.ok(start >= 0, 'expected the light-theme --control-bg override');
  const block = css.slice(Math.max(0, start - 200), start + 200);
  assert.match(block, /html\[data-hive-theme="light"\] \{/);
  assert.match(block, /--control-bg-hover: color-mix\(in srgb, var\(--accent\) 26%, var\(--panel-strong\)\);/);
});

// The theme labeled "Midnight" and the theme labeled "Violet" swapped
// display names (internal ids/keys are deliberately unchanged, so an
// existing user's saved beehive:builtin-theme selection still resolves to
// the same actual palette they had -- just under its new name): the old
// "Midnight" (id: midnight) is now labeled "Dark", and the old "Violet"
// (id: violet) is now labeled "Midnight".
test('the midnight-id theme is labeled Dark and the violet-id theme is labeled Midnight', () => {
  assert.match(renderer, /midnight:\{name:'Dark',description:'Deep neutral surfaces/);
  assert.match(renderer, /violet:\{name:'Midnight',description:'Muted plum and graphite/);
  assert.doesNotMatch(renderer, /name:'Violet'/);
});

// Real feature: a themes folder the user can drop .hive-theme packs into
// directly, instead of always going through the Import file-picker. Same
// on-disk format theme:export already writes.
test('the themes folder feature lists/applies .hive-theme packs from a dedicated userData folder', () => {
  const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');
  assert.match(main, /const THEMES_DIR = \(\) => path\.join\(USER_DATA\(\), 'themes'\);/);
  assert.match(main, /ipcMain\.handle\('themes:list', async \(\) => \{/);
  assert.match(main, /ipcMain\.handle\('themes:openFolder', async \(\) => \{/);
  assert.match(preload, /listThemeFolder: \(\) => ipcRenderer\.invoke\('themes:list'\)/);
  assert.match(preload, /openThemeFolder: \(\) => ipcRenderer\.invoke\('themes:openFolder'\)/);

  assert.match(renderer, /async function loadThemeFolderThemes\(\)\{/);
  assert.match(renderer, /async function applyFolderTheme\(file, persist=true\)\{/);
  // Selecting a folder theme applies it via the existing custom-CSS overlay
  // mechanism (same as Import), not a second styling system.
  const applyFolderStart = renderer.indexOf('async function applyFolderTheme(file, persist=true){');
  const applyFolderEnd = renderer.indexOf('\n  }', applyFolderStart);
  const applyFolderBlock = renderer.slice(applyFolderStart, applyFolderEnd);
  assert.match(applyFolderBlock, /window\.beehive\.setCustomCss\?\.\(theme\.css\)/);
  assert.match(applyFolderBlock, /applyCustomCss\(theme\.css, true, theme\.name\)/);
});

// Real bug: the built-in themes (Dark/Light/Ember/Forest/Ocean/Midnight) only
// ever existed as hardcoded BUILTIN_THEMES CSS-variable objects -- opening
// the themes folder showed nothing to start editing from, even though the
// folder feature itself worked for user-supplied packs.
test('built-in themes are seeded into the themes folder as real .hive-theme files the user can edit', () => {
  const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'app/main/preload.js'), 'utf8');

  assert.match(main, /ipcMain\.handle\('themes:seedStock', async \(_evt, themes = \[\]\) => \{/);
  const seedStart = main.indexOf("ipcMain.handle('themes:seedStock'");
  const seedEnd = main.indexOf("\n});", seedStart);
  const seedBlock = main.slice(seedStart, seedEnd);
  // Never overwrites a file that's already there -- an edited (or untouched)
  // stock theme must survive every subsequent app launch's seeding pass.
  assert.match(seedBlock, /try \{ await fsp\.access\(target\); continue; \} catch \{\}/);
  assert.match(preload, /seedStockThemes: \(themes\) => ipcRenderer\.invoke\('themes:seedStock', themes\)/);

  assert.match(renderer, /function builtinThemeToCss\(theme\)\{/);
  assert.match(renderer, /async function seedStockThemesIntoFolder\(\)\{/);
  const seedRendererStart = renderer.indexOf('async function seedStockThemesIntoFolder(){');
  const seedRendererEnd = renderer.indexOf('\n  }', seedRendererStart);
  const seedRendererBlock = renderer.slice(seedRendererStart, seedRendererEnd);
  assert.match(seedRendererBlock, /Object\.values\(BUILTIN_THEMES\)\.map\(theme => \(\{/);
  assert.match(seedRendererBlock, /window\.beehive\.seedStockThemes\?\.\(themes\)/);

  // Seeding runs unconditionally on startup (via loadThemeFolderThemes, which
  // itself runs unconditionally via renderBuiltinThemes()), not only after
  // the user opens Settings/Appearance -- and defensively again from the
  // "Open themes folder" button itself.
  const loadStart = renderer.indexOf('async function loadThemeFolderThemes(){');
  const loadEnd = renderer.indexOf('\n  }', loadStart);
  assert.match(renderer.slice(loadStart, loadEnd), /await seedStockThemesIntoFolder\(\);/);
  assert.match(renderer, /theme-open-folder-btn'\)\?\.addEventListener\('click',async\(\)=>\{ try \{ await seedStockThemesIntoFolder\(\);/);
});

// Real bug, confirmed by the user (build236): since seeding writes one file
// per built-in theme with the SAME display name as its built-in entry,
// every stock theme appeared twice in the dropdown -- once as a hardcoded
// "built-in" option, once again under "Your themes" -- unless its on-disk
// css happened to byte-for-byte match the canonical BUILTIN_THEMES entry
// used to detect and skip the duplicate. That comparison was fragile (any
// drift between BUILTIN_THEMES and an old seeded file broke the dedup, even
// for a file the user never touched) and still produced a "Your themes"
// label on a default the user didn't create.
//
// Fixed properly rather than patched: there is no longer a second,
// hardcoded "built-in" option list at all. The dropdown is sourced
// exclusively from the themes folder (BUILTIN_THEMES is still the seed data
// and the last-resort fallback if the folder is unreadable, but is never
// rendered into the <select> directly) -- so the same theme can only ever
// have one entry, and there is no separate "Your themes" grouping to
// mislabel a default under.
test('the theme dropdown is sourced only from the themes folder, with no separate built-in option list and no "Your themes" grouping', () => {
  const start = renderer.indexOf('async function renderBuiltinThemes(){');
  const end = renderer.indexOf('\n  }', start);
  const block = renderer.slice(start, end);
  assert.match(block, /select\.innerHTML=themeFolderThemes\.map\(t=>`<option value="folder:\$\{escapeHtml\(t\.file\)\}">\$\{escapeHtml\(t\.name\)\}<\/option>`\)\.join\(''\);/);
  assert.doesNotMatch(block, /Object\.entries\(BUILTIN_THEMES\)\.map/, 'BUILTIN_THEMES must not be rendered as a separate top-level option list');
  assert.doesNotMatch(renderer, /<optgroup label="Your themes">/);
  assert.doesNotMatch(renderer, /editableFolderThemes/, 'the old CSS-byte-comparison dedup is obsolete now that there is only one source of options');
});

// A stock (unedited, default) theme applied via the folder must still show
// its original built-in description, not "From your themes folder: X" --
// that phrasing is reserved for a theme the user actually made or edited,
// per the user's explicit complaint that defaults were being labeled as
// their own.
test('a stock folder theme keeps its built-in description instead of being labeled "From your themes folder"', () => {
  const start = renderer.indexOf('async function applyFolderTheme(file, persist=true){');
  const end = renderer.indexOf('\n  }', start);
  const block = renderer.slice(start, end);
  assert.match(block, /theme\.stock && builtinDescByName\.has\(theme\.name\)/);
  assert.match(block, /builtinDescByName\.get\(theme\.name\)/);
  assert.match(block, /`From your themes folder: \$\{theme\.name\}`/);
});

// Moved here from build239-transport-ramp-canonical.test.js and
// build246-volume-isolation-light-back-arrow.test.js during the #12 buildNNN
// consolidation pass -- both were plain Light-theme color-contrast fixes
// misfiled under transport/volume build names; this is their real home.
test('playback time text is white in dark themes and dark in Light', () => {
  assert.match(css, /#playbar \.time \{ color:#fff; \}/);
  assert.match(css, /html\[data-hive-theme="light"\] #playbar \.time \{ color:#252a31; \}/);
});

test('the custom album back arrow is inverted to black in Light theme', () => {
  const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
  assert.match(html, /artist-back-icon/);
  assert.match(css, /html\[data-hive-theme="light"\] \.artist-back-icon \{ filter: invert\(1\); \}/);
});
