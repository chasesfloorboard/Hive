'use strict';
// Canonical, stable home for the light-theme cover-art accent palette's
// brightness guarantee (app/renderer/colorExtract.js). Edit this file in
// place when that architecture legitimately changes.
//
// Real bug: colorExtract.js tunes light-theme colors to be blended at low
// opacity into bright panels via color-mix() -- for a light/monochrome
// cover it deliberately pushes lightness up to 86% of the way to white so
// that blend still reads as a visible tint. .playbar-left.colored-bg in
// styles.css instead applies --accent as a full-opacity solid background,
// which breaks that assumption: any light-ish album cover could wash the
// whole "Colored Now Playing background" area out to near-white. Fixed with
// a hard luminance ceiling (LIGHT_THEME_MAX_LUMINANCE) applied to every
// color colorExtract.js produces for light theme, independent of how light
// the source artwork is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(root, 'app', 'renderer', 'colorExtract.js');

function relativeLuminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function parseRgba(css) {
  const m = String(css || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// colorExtract.js is written as a plain browser script (window.BeehiveColor =
// ...), not a Node module -- load it against minimal document/window mocks
// that fake a solid-color <canvas> source, matching how the real renderer
// samples pixels from an <img> drawn onto an offscreen canvas.
async function extractForFlatColor(rgb, opts) {
  const size = 48 * 48;
  global.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => {
          const data = new Uint8ClampedArray(size * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
          }
          return { data };
        }
      })
    })
  };
  global.window = {};
  delete require.cache[require.resolve(MODULE_PATH)];
  require(MODULE_PATH);
  try {
    return await global.window.BeehiveColor.extractPaletteFromImage({}, opts);
  } finally {
    delete global.document;
    delete global.window;
    delete require.cache[require.resolve(MODULE_PATH)];
  }
}

test('colorExtract.js defines a hard light-theme luminance ceiling applied to every color it produces', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.match(source, /const LIGHT_THEME_MAX_LUMINANCE = 0\.84;/);
  assert.match(source, /function capLuminance\(rgbTriple, maxLuminance\)/);
  // Every color key the light branches resolve must run through the cap,
  // not just the primary accent -- accentSoft's own "+30 brightness" boost
  // on top of an already-capped base was the one spot this was missed on
  // the first pass.
  const capCallCount = (source.match(/capLuminance\(/g) || []).length;
  assert.ok(capCallCount >= 6, `expected capLuminance to be applied at least 6 times (found ${capCallCount})`);
});

test('a near-white cover never produces a light-theme accent that exceeds the luminance ceiling', async () => {
  const palette = await extractForFlatColor([255, 255, 255], { light: true });
  for (const key of ['accent', 'accentSoft', 'accentGlow', 'ambientA', 'ambientB']) {
    const rgb = parseRgba(palette[key]);
    assert.ok(rgb, `${key} should be an rgba() color, got ${palette[key]}`);
    const lum = relativeLuminance(...rgb);
    assert.ok(lum <= 0.86, `${key} luminance ${lum.toFixed(3)} exceeds the light-theme ceiling (color: ${palette[key]})`);
  }
});

test('a saturated colorful cover also stays under the light-theme luminance ceiling', async () => {
  // A single flat saturated color skips colorExtract.js's monochrome branch
  // (it needs real pixel variance to find a "second" ambient color), so this
  // exercises the other light-theme code path -- the hue-preserving accent
  // computed from actual HSL, not the neutral-tint fallback.
  const palette = await extractForFlatColor([230, 40, 40], { light: true });
  for (const key of ['accent', 'accentSoft', 'accentGlow', 'ambientA', 'ambientB']) {
    const rgb = parseRgba(palette[key]);
    if (!rgb) continue;
    const lum = relativeLuminance(...rgb);
    assert.ok(lum <= 0.86, `${key} luminance ${lum.toFixed(3)} exceeds the light-theme ceiling (color: ${palette[key]})`);
  }
});

test('dark theme is unaffected by the light-theme luminance cap', async () => {
  // Dark theme's own tuning already darkens light covers toward near-black
  // (a different, older mechanism); the light-theme cap must not change
  // that path's behavior.
  const palette = await extractForFlatColor([255, 255, 255], { light: false });
  const rgb = parseRgba(palette.accent);
  const lum = relativeLuminance(...rgb);
  // Dark theme's neutral-tint fallback for a light cover targets a dim
  // accent for contrast against near-black panels -- a different, older
  // mechanism than the light-theme cap this file is about. Just confirm it
  // isn't being pulled up anywhere near the light-theme ceiling.
  assert.ok(lum < 0.6, `dark theme accent for a white cover should stay well under the light-theme ceiling, got luminance ${lum.toFixed(3)}`);
});

test('light theme accent reads brighter than dark theme accent for the same saturated cover', async () => {
  // Real bug (1.0.3): LIGHT_THEME_MAX_LUMINANCE was set low enough (0.70)
  // that ordinary saturated hues (green/cyan covers routinely land near
  // 0.79-0.87 pre-cap) got clamped to LESS luminance than dark theme's own
  // accent for that same hue -- backwards, since light theme's tuning
  // exists specifically to read brighter than dark. Also, the old cap
  // scaled the RGB triple toward black to reduce luminance, which
  // desaturates a color faster than it dims it once lightness is above
  // 50% (exactly where light theme's palette lives) -- the actual source
  // of the "muddy" look. capLuminance now trims HSL lightness only, so hue
  // and saturation survive the cap.
  for (const rgb of [[40, 200, 90], [40, 200, 200], [200, 40, 200]]) {
    const lightPalette = await extractForFlatColor(rgb, { light: true });
    const darkPalette = await extractForFlatColor(rgb, { light: false });
    const lightLum = relativeLuminance(...parseRgba(lightPalette.accent));
    const darkLum = relativeLuminance(...parseRgba(darkPalette.accent));
    assert.ok(
      lightLum >= darkLum,
      `cover [${rgb}]: light accent luminance ${lightLum.toFixed(3)} should be >= dark accent luminance ${darkLum.toFixed(3)}`
    );
  }
});

// Light mode: Settings and every dialog use Apple system blue, not the theme's
// indigo. #settings-modal is itself a .modal-overlay and its base accent rule
// includes the ID, so the light override must name the ID too, or its lower
// specificity leaves Settings indigo (it did, in 1.0.3).
test('light-mode Settings and dialogs get the Apple-blue accent', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'renderer', 'styles.css'), 'utf8');
  const rule = css.match(/((?:html\[data-hive-theme="light"\][^{,]*,\s*)*html\[data-hive-theme="light"\][^{,]*)\{\s*--accent:\s*#0A84FF;/i);
  assert.ok(rule, 'expected a light-theme --accent: #0A84FF rule');
  assert.match(rule[1], /html\[data-hive-theme="light"\] #settings-modal\b/);
  assert.match(rule[1], /html\[data-hive-theme="light"\] \.modal-overlay\b/);
});
