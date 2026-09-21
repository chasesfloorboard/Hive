import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const renderer = fs.readFileSync(new URL('../app/renderer/renderer.js', import.meta.url), 'utf8');

test('current-track artwork uses one shared rotator for player, queue, album, and expanded surfaces', () => {
  assert.match(renderer, /const nowPlayingRotator = createCoverRotator\(\);/);
  assert.match(renderer, /const targets = \[el\.pbCover, el\.npCover\];/);
  assert.match(renderer, /const queueThumb = el\.queueList\?\.querySelector/);
  assert.match(renderer, /document\.querySelectorAll\('\.album-card'\)/);
  assert.match(renderer, /document\.querySelectorAll\('\.inline-album-dropdown'\)/);
  assert.doesNotMatch(renderer, /const queueThumbnailRotator = createQueueThumbnailRotator\(\);/);
  assert.doesNotMatch(renderer, /refreshQueueThumbnailRotationTarget\(\);/);
});

test('expanded album cover exposes the same cover context menu as the player', () => {
  assert.match(renderer, /expandedCover\?\.addEventListener\('contextmenu', e =>/);
  assert.match(renderer, /showCoverContextMenu\(e, first, album\)/);
});

test('expanded album retarget happens after the panel is connected', () => {
  const inserted = renderer.indexOf('lastCardInRow.after(panel);');
  const retarget = renderer.indexOf('nowPlayingRotator.retarget([expandedImg]);', inserted);
  assert.ok(inserted >= 0);
  assert.ok(retarget > inserted, 'expanded artwork must be retargeted after insertion');
});

test('queue virtual rows retarget the shared cover rotator instead of starting another timer', () => {
  assert.match(renderer, /retargetCurrentCoverRotationTargets\(queueVirtualState\.pool/);
  assert.doesNotMatch(renderer, /bindQueueRows\(\);/);
  assert.match(renderer, /function retargetCurrentCoverRotationTargets\(row = null\)/);
  assert.match(renderer, /nowPlayingRotator\.retarget\(\[queueThumb\]\)/);
});
