'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectNativeTags } = require('../app/main/native-tag-summary');

test('native tag summaries do not retain embedded binary artwork', () => {
  const binary = Buffer.alloc(50 * 1024 * 1024, 7);
  const tags = collectNativeTags({ ID3: [{ id: 'APIC', value: { description: 'Cover', mime: 'image/jpeg', data: binary } }, { id: 'TIT2', value: 'Title' }] });
  assert.equal(tags.TIT2, 'Title');
  assert.deepEqual(tags.APIC, { description: 'Cover', mime: 'image/jpeg', data: '<Binary 52428800 bytes>' });
  assert.ok(JSON.stringify(tags).length < 1024);
});
