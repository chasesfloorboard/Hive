'use strict';
// Stable home for how the tag editor treats a multi-file selection: a field
// or checkbox the user didn't touch must never copy one file's value onto the
// others. (A real bug: Sorting fields, track/disc totals and the option
// checkboxes were filled from the first file only, and Save wrote them to every
// file whose own value differed -- even when nothing was edited.) Edit in place.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const renderer = fs.readFileSync(path.join(__dirname, '../app/renderer/renderer.js'), 'utf8');

function functionSource(name) {
  const start = renderer.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected to find function ${name}`);
  let depth = 0;
  for (let i = renderer.indexOf('{', start); i < renderer.length; i++) {
    if (renderer[i] === '{') depth++;
    else if (renderer[i] === '}' && --depth === 0) return renderer.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function load(nodes) {
  const context = { document: { getElementById: id => nodes[id] || null } };
  vm.createContext(context);
  const isTrue = renderer.match(/const isTrueTagValue = [^\n]+/)[0];
  vm.runInContext([functionSource('editorComparable'), functionSource('mergeEditorValues'), isTrue,
    functionSource('setMergedCheck'), functionSource('tagCheckboxChanged'),
    'this.api = { mergeEditorValues, setMergedCheck, tagCheckboxChanged };'].join('\n'), context);
  return context.api;
}

const box = () => ({ checked: false, indeterminate: false, dataset: {} });

test('a checkbox shows the shared state, or indeterminate when the files differ', () => {
  const nodes = { same: box(), mixed: box() };
  const api = load(nodes);
  api.setMergedCheck('same', ['1', 'true']);
  assert.equal(nodes.same.checked, true);
  assert.equal(nodes.same.indeterminate, false);
  api.setMergedCheck('mixed', ['1', '', '1']);
  assert.equal(nodes.mixed.checked, false);
  assert.equal(nodes.mixed.indeterminate, true);
});

test('an untouched checkbox is never written to a selection; a touched one is', () => {
  const nodes = { mixed: box(), same: box() };
  const api = load(nodes);
  api.setMergedCheck('mixed', ['1', '']);
  assert.equal(api.tagCheckboxChanged(nodes.mixed), false, 'untouched mixed checkbox');
  nodes.mixed.indeterminate = false; // what a click does to an indeterminate checkbox
  nodes.mixed.checked = true;
  assert.equal(api.tagCheckboxChanged(nodes.mixed), true);

  api.setMergedCheck('same', ['', '']);
  assert.equal(api.tagCheckboxChanged(nodes.same), false);
  nodes.same.checked = true;
  assert.equal(api.tagCheckboxChanged(nodes.same), true);
  nodes.same.checked = false;
  assert.equal(api.tagCheckboxChanged(nodes.same), false, 'toggled back to how it was');
});

test('bulk sort fields compare against the value the whole selection shares', () => {
  const { mergeEditorValues } = load({});
  // Every file's own sort title differs: the editor shows blank, and an
  // untouched blank field matches the merged blank, so nothing is written.
  assert.equal(mergeEditorValues(['Black', 'Alive', 'Jeremy']), '');
  assert.equal(mergeEditorValues(['Pearl Jam', 'Pearl Jam']), 'Pearl Jam');
  const save = renderer.slice(renderer.indexOf('async function saveTagEdits'));
  assert.match(save.slice(0, save.indexOf('const settingFields')), /const original = bulk\s*\?\s*mergeEditorValues\(editingTagSnapshots\.map/);
});

test('per-track playback flags set by the tag editor take effect without a rescan', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${functionSource('playbackSettingEnabled')}\nthis.fn = playbackSettingEnabled;`, context);
  const enabled = context.fn;
  assert.equal(enabled({ doNotCrossfade: '1' }, 'BEEHIVE_DO_NOT_CROSSFADE'), true);
  assert.equal(enabled({ excludePlayback: '1' }, 'BEEHIVE_EXCLUDE_PLAYBACK'), true);
  assert.equal(enabled({ rememberPosition: '1' }, 'BEEHIVE_REMEMBER_POSITION'), true);
  assert.equal(enabled({ customTags: { BEEHIVE_EXCLUDE_PLAYBACK: 'yes' } }, 'BEEHIVE_EXCLUDE_PLAYBACK'), true);
  assert.equal(enabled({}, 'BEEHIVE_DO_NOT_CROSSFADE'), false);
});
