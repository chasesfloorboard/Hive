// Lightweight dominant-color extraction from an <img>, no dependencies.
// Buckets pixels into coarse RGB bins, picks the most common vivid-ish bucket,
// and derives a small palette (accent / soft / glow) for the ambient glass theme.

(function () {
  const SAMPLE_SIZE = 48; // downscale target for sampling

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h * 360, s, l];
  }

  function hslToCss(h, s, l, a) {
    return `hsla(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%, ${a})`;
  }

  function rgba(r, g, b, a) {
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
  }

  function darken(r, g, b, factor) {
    return [r * factor, g * factor, b * factor];
  }

  function lighten(r, g, b, factor) {
    return [r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor];
  }

  // Light theme's tuning below intentionally pushes lightness high (up to
  // 86% of the way to white for a light/monochrome cover) so a color reads
  // as a visible tint once blended at low opacity into a bright panel via
  // color-mix(). That assumption breaks for any consumer that uses --accent
  // as a full-opacity solid fill instead of a blend -- e.g. the "Colored Now
  // Playing background" setting (.playbar-left.colored-bg { background:
  // var(--accent) }) -- where a light cover's accent can end up nearly white
  // and wash the whole area out against light theme's already-bright UI.
  // This is a hard ceiling applied to every light-theme color this module
  // produces, independent of how light the source artwork is, so no cover
  // can ever push a solid-fill consumer past a safely visible brightness.
  // A small margin below the true target: callers round each channel to the
  // nearest integer for CSS output (rgba()), which can round the resulting
  // luminance back up by a fraction of a percent. The margin absorbs that so
  // the *rendered* color never exceeds the intended ceiling.
  const LIGHT_THEME_MAX_LUMINANCE = 0.70;
  function relativeLuminance(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  function capLuminance(rgbTriple, maxLuminance) {
    const [r, g, b] = rgbTriple;
    const lum = relativeLuminance(r, g, b);
    if (lum <= maxLuminance || lum <= 0) return rgbTriple;
    const scale = maxLuminance / lum;
    return [r * scale, g * scale, b * scale];
  }

  function extractPaletteFromImage(imgEl, opts) {
    // The accent this function derives is blended into frosted-glass panel
    // backgrounds via color-mix(var(--accent) X%, var(--panel)). The default
    // lightness target (36%-64%) reads as a vibrant "pop" against Hive's
    // near-black panels, but that same mid-tone color mixed at a low
    // percentage into light theme's bright white panel desaturates toward a
    // dull gray instead -- "muddy". `light: true` keeps the actual hue from
    // the cover but targets a brighter lightness so the same blend reads as
    // a bright, clean tint instead.
    const light = !!(opts && opts.light);
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        const w = SAMPLE_SIZE;
        const h = SAMPLE_SIZE;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(imgEl, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);

        const buckets = new Map(); // key -> {count, r,g,b}
        let totalPixels = 0;
        let darkPixels = 0;
        let lightPixels = 0;
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;
          totalPixels += 1;
          sumR += r; sumG += g; sumB += b;
          // Keep track of very dark/light artwork so black or white covers
          // do not accidentally borrow a tiny saturated accent (for example
          // a small green logo on an otherwise black album).
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = (r + g + b) / 3;
          if (lum <= 32) darkPixels += 1;
          if (lum >= 225) lightPixels += 1;
          // skip near-black / near-white / near-gray (low information)
          if (lum < 18 || lum > 245) continue;

          const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
          const entry = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0, score: 0 };
          entry.count += 1;
          entry.r += r; entry.g += g; entry.b += b;
          entry.score += 1 + sat * 2; // favour saturated colors
          buckets.set(key, entry);
        }

        // If the artwork is overwhelmingly black or white, prefer a neutral
        // dark ambient palette. This keeps monochrome covers monochrome instead
        // of turning a tiny colored detail into a strong green/blue/etc. theme.
        const darkRatio = totalPixels ? darkPixels / totalPixels : 0;
        const lightRatio = totalPixels ? lightPixels / totalPixels : 0;
        if (darkRatio >= 0.62 || lightRatio >= 0.62) {
          const avgR = totalPixels ? sumR / totalPixels : 0;
          const avgG = totalPixels ? sumG / totalPixels : 0;
          const avgB = totalPixels ? sumB / totalPixels : 0;
          // Keep monochrome artwork monochrome, but derive the neutral tint
          // from the actual cover instead of inventing a blue/green hue.
          // A light cover is deliberately pulled down into the dark ambient
          // range so it remains comfortable behind the glass UI.
          if (light) {
            // Same idea, inverted: pull the neutral tint UP toward white
            // instead of down toward black, so it stays a bright wash behind
            // the light theme's bright glass panels instead of a dark smudge.
            // Capped afterward (LIGHT_THEME_MAX_LUMINANCE) so a light/white
            // cover -- the exact case this branch handles -- can't push a
            // full-opacity consumer like the Colored Now Playing background
            // to a washed-out near-white.
            const [ar, ag, ab] = capLuminance(lighten(avgR, avgG, avgB, 0.86), LIGHT_THEME_MAX_LUMINANCE);
            const [br, bg, bb] = capLuminance(lighten(avgR, avgG, avgB, 0.74), LIGHT_THEME_MAX_LUMINANCE);
            const [softR, softG, softB] = capLuminance([Math.min(255, ar + 8), Math.min(255, ag + 8), Math.min(255, ab + 8)], LIGHT_THEME_MAX_LUMINANCE);
            resolve({
              accent: rgba(ar, ag, ab, 1),
              accentSoft: rgba(softR, softG, softB, 0.4),
              accentGlow: rgba(br, bg, bb, 0.5),
              ambientA: rgba(br, bg, bb, 0.4),
              ambientB: rgba(ar, ag, ab, 0.3),
              isDark: false,
              logoTone: lightRatio >= 0.62 ? 'light' : 'dark'
            });
            return;
          }
          const [ar, ag, ab] = darken(avgR, avgG, avgB, avgR + avgG + avgB > 255 ? 0.20 : 0.34);
          const [br, bg, bb] = darken(avgR, avgG, avgB, avgR + avgG + avgB > 255 ? 0.13 : 0.24);
          const neutral = Math.max(ar, ag, ab) < 18 ? [28, 28, 32] : [ar, ag, ab];
          const neutralSoft = [Math.max(20, br), Math.max(20, bg), Math.max(22, bb)];
          resolve({
            accent: rgba(neutral[0] + 48, neutral[1] + 48, neutral[2] + 48, 1),
            accentSoft: rgba(neutralSoft[0] + 30, neutralSoft[1] + 30, neutralSoft[2] + 30, 0.46),
            accentGlow: rgba(neutral[0] + 12, neutral[1] + 12, neutral[2] + 12, 0.58),
            ambientA: rgba(neutral[0], neutral[1], neutral[2], 0.56),
            ambientB: rgba(neutralSoft[0], neutralSoft[1], neutralSoft[2], 0.38),
            isDark: true,
            logoTone: lightRatio >= 0.62 ? 'light' : 'dark'
          });
          return;
        }

        const ranked = [...buckets.values()].sort((a, b) => {
          // Favor colors that are both genuinely common in the cover and
          // visibly saturated, so the theme feels vibrant without inventing
          // a hue that is not actually present in the artwork.
          const scoreA = a.count * (1 + Math.min(1, a.score / Math.max(1, a.count) - 1) * 1.8);
          const scoreB = b.count * (1 + Math.min(1, b.score / Math.max(1, b.count) - 1) * 1.8);
          return scoreB - scoreA;
        });
        let best = ranked[0];
        if (!best) {
          resolve(defaultPalette());
          return;
        }

        const r = Math.round(best.r / best.count);
        const g = Math.round(best.g / best.count);
        const b = Math.round(best.b / best.count);
        let [hh, ss, ll] = rgbToHsl(r, g, b);

        // Keep the hue from the actual cover, but make genuinely colorful
        // artwork read as vibrant in the UI. We boost saturation only; we do
        // not rotate the hue or introduce an unrelated color.
        // In light theme this same mid-tone lightness (tuned to pop against a
        // near-black panel) reads as a dull, muddy gray once blended at a low
        // percentage into a bright white panel -- same hue, just pushed
        // noticeably brighter so the blend stays a clean, vibrant tint.
        const targetS = light ? Math.min(0.82, Math.max(ss, ss * 1.05)) : Math.min(0.96, Math.max(ss, ss * 1.28));
        const accentL = light ? Math.min(0.8, Math.max(0.58, ll + 0.22)) : Math.min(0.64, Math.max(0.36, ll));
        let accentRgb = (() => {
          const c = (1 - Math.abs(2 * accentL - 1)) * targetS;
          const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
          const m = accentL - c / 2;
          let rp = 0, gp = 0, bp = 0;
          if (hh < 60) [rp, gp, bp] = [c, x, 0];
          else if (hh < 120) [rp, gp, bp] = [x, c, 0];
          else if (hh < 180) [rp, gp, bp] = [0, c, x];
          else if (hh < 240) [rp, gp, bp] = [0, x, c];
          else if (hh < 300) [rp, gp, bp] = [x, 0, c];
          else [rp, gp, bp] = [c, 0, x];
          return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255];
        })();
        // Same hard ceiling as the monochrome branch above: accentL's 0.8
        // upper bound is still bright enough, combined with a pale cover's
        // low saturation, to wash out a full-opacity consumer.
        if (light) accentRgb = capLuminance(accentRgb, LIGHT_THEME_MAX_LUMINANCE);

        // The second ambient blob comes from another actual cover color, not
        // from a fixed hue offset. This makes the whole backdrop feel like a
        // darkened extension of the artwork itself.
        const second = ranked.find((entry) => {
          const rr = entry.r / entry.count, gg = entry.g / entry.count, bb = entry.b / entry.count;
          return Math.abs(rr - r) + Math.abs(gg - g) + Math.abs(bb - b) > 35;
        }) || best;
        const sr = second.r / second.count, sg = second.g / second.count, sb = second.b / second.count;
        // The ambient blobs are large blurred glows sitting behind the glass
        // panels. Dark-theme tuning darkens them and blends them in strong,
        // since they need to read against near-black; light theme instead
        // lightens them and blends them faint, so they stay a soft color wash
        // behind bright panels instead of a dark smudge.
        // Light theme's ambient blobs used to be pulled most of the way to
        // white (0.55/0.62) *and* blended in at low alpha (0.12-0.32), which
        // stacked into an effectively invisible wash against the bright
        // panel background. Keep only a light lift here -- enough to stay
        // comfortable behind bright glass without darkening it -- and rely
        // on alpha for how strongly it reads, not on desaturating the color.
        const [ar, ag, ab] = light
          ? capLuminance(lighten(accentRgb[0], accentRgb[1], accentRgb[2], 0.18), LIGHT_THEME_MAX_LUMINANCE)
          : darken(accentRgb[0], accentRgb[1], accentRgb[2], 0.42);
        const [br, bg, bb] = light
          ? capLuminance(lighten(sr, sg, sb, 0.22), LIGHT_THEME_MAX_LUMINANCE)
          : darken(sr, sg, sb, 0.34);

        const accentSoftRgb = light
          ? capLuminance([Math.min(255, accentRgb[0] + 30), Math.min(255, accentRgb[1] + 30), Math.min(255, accentRgb[2] + 30)], LIGHT_THEME_MAX_LUMINANCE)
          : [Math.min(255, accentRgb[0] + 30), Math.min(255, accentRgb[1] + 30), Math.min(255, accentRgb[2] + 30)];
        resolve({
          accent: rgba(accentRgb[0], accentRgb[1], accentRgb[2], 1),
          accentSoft: rgba(accentSoftRgb[0], accentSoftRgb[1], accentSoftRgb[2], light ? 0.4 : 0.52),
          accentGlow: rgba(ar, ag, ab, light ? 0.55 : 0.86),
          ambientA: rgba(ar, ag, ab, light ? 0.5 : 0.62),
          ambientB: rgba(br, bg, bb, light ? 0.38 : 0.48),
          isDark: light ? false : accentL < 0.45
        });
      } catch (err) {
        resolve(defaultPalette());
      }
    });
  }

  function defaultPalette() {
    return {
      accent: 'hsla(266, 60%, 55%, 1)',
      accentSoft: 'hsla(266, 55%, 65%, 0.55)',
      accentGlow: 'hsla(266, 60%, 40%, 0.9)',
      ambientA: 'hsla(266, 55%, 25%, 0.5)',
      ambientB: 'hsla(200, 55%, 25%, 0.4)',
      isDark: true,
      logoTone: 'color'
    };
  }

  window.BeehiveColor = { extractPaletteFromImage, defaultPalette };
})();
