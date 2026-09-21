const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('metadata batches suppress the filesystem watcher for their full lifetime', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');
  const start = source.indexOf('async function runMetadataBatch(');
  const end = source.indexOf('\nipcMain.on(\'metadata:saveBatch\'', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /beginLibraryBulkWrite\(bulkLabel\)/);
  assert.match(block, /finally \{[\s\S]*endLibraryBulkWrite\(bulkLabel\)/);
  assert.doesNotMatch(block, /setTimeout\(r,75\)/);
});

test('tag verification uses the native backend without decoding embedded covers', () => {
  // performWriteMetadata was extracted out of main.js into its own
  // dependency-injected module (app/main/metadata-writer.js).
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'metadata-writer.js'), 'utf8');
  const start = source.indexOf('async function performWriteMetadata(');
  const end = source.indexOf('\n  async function performWriteTags(', start);
  const block = source.slice(start, end);
  assert.match(block, /op: 'read_metadata_fields'/);
  assert.doesNotMatch(block, /ensureMM\(\)|parseFile\(/);

});
