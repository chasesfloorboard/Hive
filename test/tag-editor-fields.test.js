'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTagEditorFields } = require('../app/renderer/tag-editor-fields');

// Fakes for the injected renderer helpers. nativeTagValue reads a plain {ID: value} map
// (uppercased), matching the real matcher closely enough for the fallback branches.
const normalizeMetadataText = (v) => String(v ?? '').trim();
const normalizeLyricsText = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();
function makeNative(map = {}) {
  const up = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toUpperCase(), v]));
  return (_native, wanted) => String(up[String(wanted).toUpperCase()] ?? '').trim();
}
const build = (map) => createTagEditorFields({ nativeTagValue: makeNative(map), normalizeMetadataText, normalizeLyricsText });

test('createTagEditorFields validates its injected dependencies', () => {
  assert.throws(() => createTagEditorFields({}), /nativeTagValue, normalizeMetadataText, normalizeLyricsText/);
  assert.throws(() => createTagEditorFields({ nativeTagValue: () => '', normalizeMetadataText: () => '' }), /normalizeLyricsText/);
});

test('TAG_EDITOR_FIELDS pairs field keys with input ids and includes the 19 custom slots', () => {
  const { TAG_EDITOR_FIELDS } = build();
  const map = Object.fromEntries(TAG_EDITOR_FIELDS);
  assert.equal(map.title, 'tag-title');
  assert.equal(map.albumartist, 'tag-albumArtist');
  assert.equal(map.custom2, 'tag-custom2');
  assert.equal(map.custom20, 'tag-custom20');
  assert.ok(!('custom21' in map), 'custom slots stop at 20 (2..20 = 19 of them)');
});

test('editorTextValue reads common first, with native fallbacks for format-specific fields', () => {
  const { editorTextValue } = build({ PUBLISHER: 'Native Label', ORIGINALARTIST: 'OG Artist' });
  // genre/composer take the first of an array.
  assert.equal(editorTextValue({ genre: ['Rock', 'Alt'] }, {}, 'genre'), 'Rock');
  // publisher: common.label wins; else common.publisher; else the native tag.
  assert.equal(editorTextValue({ label: 'Album Label' }, {}, 'publisher'), 'Album Label');
  assert.equal(editorTextValue({}, {}, 'publisher'), 'Native Label', 'falls back to the raw native tag');
  // originalartist: native fallback when common is absent.
  assert.equal(editorTextValue({}, {}, 'originalartist'), 'OG Artist');
  // track/disk read the nested .no.
  assert.equal(editorTextValue({ track: { no: 5 } }, {}, 'track'), 5);
  assert.equal(editorTextValue({ disk: { no: 2 } }, {}, 'disk'), 2);
  // comment/lyrics go through the injected normalizers.
  assert.equal(editorTextValue({ comment: '  hi  ' }, {}, 'comment'), 'hi');
  assert.equal(editorTextValue({ lyrics: 'a\r\nb' }, {}, 'lyrics'), 'a\nb');
  // a plain field falls through to common[key].
  assert.equal(editorTextValue({ bpm: 120 }, {}, 'bpm'), 120);
});

test('editorTextValue compilation is "1" only when common or native says so', () => {
  assert.equal(build().editorTextValue({ compilation: true }, {}, 'compilation'), '1');
  assert.equal(build({ TCMP: '1' }).editorTextValue({}, {}, 'compilation'), '1');
  assert.equal(build({ COMPILATION: 'yes' }).editorTextValue({}, {}, 'compilation'), '1');
  assert.equal(build().editorTextValue({ compilation: false }, {}, 'compilation'), '');
});

test('editorTextValue custom slots read the native tag by key', () => {
  const { editorTextValue } = build({ custom5: 'my value' });
  assert.equal(editorTextValue({}, {}, 'custom5'), 'my value');
});

test('editorSortValue maps sort-order fields to their native ids, else the fallback', () => {
  const { editorSortValue } = build({ TSOP: 'Beatles, The' });
  assert.equal(editorSortValue({}, 'artist', 'The Beatles'), 'Beatles, The', 'native sort id wins');
  assert.equal(editorSortValue({}, 'title', 'Fallback Title'), 'Fallback Title', 'no native -> fallback');
  assert.equal(editorSortValue({}, 'unknownfield', ''), '');
});

test('editorNativeObject flattens a native tag map to id -> scalar, skipping non-scalars', () => {
  const { editorNativeObject } = build();
  const native = {
    'ID3v2.4': [
      { id: 'TXXX:FOO', value: { text: 'bar' } },
      { id: 'TIT2', value: 'Title' },
      { id: 'APIC', value: { data: 'binary' } }, // object .data -> non-scalar, skipped
      { id: '', value: 'no id' },                 // no id -> skipped
      { id: 'TCMP', value: 1 },
    ],
  };
  const out = editorNativeObject(native);
  assert.deepEqual(out, { 'TXXX:FOO': 'bar', TIT2: 'Title', TCMP: 1 });
});

test('editorComparable stringifies for comparison; mergeEditorValues returns the shared value or empty', () => {
  const { editorComparable, mergeEditorValues } = build();
  assert.equal(editorComparable(null), '');
  assert.equal(editorComparable('  x  '), 'x');
  assert.equal(editorComparable({ a: 1 }), '{"a":1}');
  // All agree -> that value; any differ -> '' (so a mixed selection shows blank).
  assert.equal(mergeEditorValues(['Same', 'Same', 'Same']), 'Same');
  assert.equal(mergeEditorValues(['A', 'B']), '');
  assert.equal(mergeEditorValues([' x ', 'x']), ' x ', 'compares trimmed but returns the original');
});
