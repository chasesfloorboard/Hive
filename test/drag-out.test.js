'use strict';
// Songs dragged out of Hive reach other apps as files: the page gives way to
// the native drag, the drag has a picture, and the page hears when it ends.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'app');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('drag-out loads before renderer.js so its capture handler runs first', () => {
  const html = read('renderer/index.html');
  const dragOut = html.indexOf('<script src="drag-out.js"></script>');
  const renderer = html.indexOf('<script src="renderer.js"></script>');
  assert.ok(dragOut > 0 && renderer > dragOut);
});

test('file drags cancel the HTML drag in the capture phase, but streamed songs keep theirs', () => {
  const js = read('renderer/drag-out.js');
  assert.match(js, /addEventListener\('dragstart'[\s\S]*e\.preventDefault\(\)[\s\S]*\}, true\)/);
  assert.match(js, /isFilePath/);
  assert.match(js, /\.song-row, \.inline-track-row, \.album-card/);
});

test('the native drag has an icon and tells the page when it ends', () => {
  const main = read('main/main.js');
  const handler = main.slice(main.indexOf("ipcMain.on('files:startDrag'"), main.indexOf('function fileDragIcon'));
  assert.match(handler, /icon: fileDragIcon\(\)/);
  assert.doesNotMatch(handler, /nativeImage\.createEmpty\(\)\s*\}\)/);
  assert.match(handler, /send\('files:dragEnded'\)/);
  assert.match(read('main/preload.js'), /onNativeFileDragEnd:.*'files:dragEnded'/);
});

test('when the native drag ends, the element it started from hears dragend', () => {
  const js = read('renderer/drag-out.js');
  assert.match(js, /onNativeFileDragEnd/);
  assert.match(js, /dispatchEvent\(new DragEvent\('dragend', \{ bubbles: true \}\)\)/);
});
