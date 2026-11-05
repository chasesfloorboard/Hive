const test = require('node:test');
const assert = require('node:assert');
const { textOnAccent, contrastRatio } = require('../app/renderer/accent-contrast.js');

const parse = s => s.match(/\d+/g).map(Number);

test('text on an accent always reaches at least 4.5:1 for typical theme accents', () => {
  const accents = [[104, 97, 107], [255, 236, 120], [124, 58, 237], [16, 185, 129], [239, 68, 68], [255, 255, 255], [0, 0, 0], [120, 120, 120]];
  for (const a of accents) {
    const text = parse(textOnAccent(a));
    assert.ok(contrastRatio(a, text) >= 4.5, `accent ${a} gave ${contrastRatio(a, text).toFixed(2)}`);
  }
});

test('a muted grey accent (the Dark theme) gets white text, a pale one gets dark text', () => {
  assert.strictEqual(textOnAccent([104, 97, 107]), 'rgb(255, 255, 255)');
  assert.strictEqual(textOnAccent([255, 236, 120]), 'rgb(6, 6, 8)');
});

test('the page loads the helper and accent surfaces use its colour', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require.resolve('../app/renderer/index.html'), 'utf8');
  assert.match(html, /<script src="accent-contrast\.js"><\/script>/);
  const css = fs.readFileSync(require.resolve('../app/renderer/styles.css'), 'utf8');
  assert.match(css, /\.playlist-new-primary[^}]*var\(--accent-contrast/);
});
