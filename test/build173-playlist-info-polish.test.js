'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app', 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app', 'renderer', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');

function block(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing block start: ${startNeedle}`);
  assert.ok(end >= 0, `missing block end: ${endNeedle}`);
  return source.slice(start, end);
}

test('Playlist Details modal has a bounded scrolling content region', () => {
  const modal = styles.slice(styles.indexOf('.playlist-info-modal'));
  assert.match(modal, /display:\s*flex/);
  assert.match(modal, /flex-direction:\s*column/);
  assert.match(modal, /max-height:\s*min\(90vh/);
  assert.match(modal, /overflow:\s*hidden/);
  assert.match(modal, /\.playlist-info-body\s*\{/);
  assert.match(modal, /overflow-y:\s*auto/);
  assert.match(modal, /min-height:\s*0/);
});

test('Playlist Details icon picker is compact and does not offer the lightning icon', () => {
  const picker = block(renderer, 'const SIDEBAR_ICON_CHOICES', 'let playlistInfoEditingId');
  const choicesLine = picker.split('\n')[0];
  assert.doesNotMatch(choicesLine, /⚡/);
  assert.match(choicesLine, /SIDEBAR_ICON_CHOICES\s*=\s*\[/);

  const iconStart = styles.indexOf('/* Build 173');
  const iconCss = styles.slice(iconStart);
  assert.match(iconCss, /background:\s*transparent/);
  assert.match(iconCss, /border:\s*0/);
  assert.match(iconCss, /box-shadow:\s*none/);
  assert.match(iconCss, /width:\s*28px/);
});

test('Playlist Details uses a cleaner inspector hierarchy with preview and compact settings', () => {
  assert.match(html, /class="modal-body playlist-info-body"/);
  assert.match(html, /class="playlist-info-live-preview"/);
  assert.match(html, /class="playlist-info-preview-card"/);
  const info = block(renderer, 'function showPlaylistInfo(pl)', 'async function savePlaylistInfoChanges');
  assert.match(info, /playlist-info-stat-grid/);
  assert.match(info, /renderPlaylistInfoIcons/);
  assert.match(info, /setPlaylistInfoLabelEditor/);
  const sectionCss = block(styles, '.playlist-info-appearance', '.playlist-info-actions');
  assert.match(sectionCss, /border-radius:\s*11px/);
  assert.match(sectionCss, /background:/);
});
