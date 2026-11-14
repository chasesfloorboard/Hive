'use strict';
// Tag-editor field helpers: the field<->input-id table, reading a field value out of
// music-metadata's `common`/`native` objects (with the per-format fallbacks that make a
// value reappear when the editor reopens), native sort values, flattening the native tag
// object, and the merge/compare used to show one value across a multi-file selection.
// Extracted from renderer.js (docs/ai/ARCHITECTURE.md): these helpers were duplicated
// between the editor LOAD path and the far-away SAVE/diff path (~8,500 lines apart), so a
// shared dual-mode module removes that cross-file duplication rather than adding a seam.
// normalizeMetadataText / normalizeLyricsText / nativeTagValue stay in renderer (used
// widely) and are injected. Dual-mode: `window.HiveTagEditorFields` + module.exports.
(function () {
  function createTagEditorFields(deps = {}) {
    const { nativeTagValue, normalizeMetadataText, normalizeLyricsText } = deps;
    if (typeof nativeTagValue !== 'function' || typeof normalizeMetadataText !== 'function' || typeof normalizeLyricsText !== 'function') {
      throw new Error('createTagEditorFields needs { nativeTagValue, normalizeMetadataText, normalizeLyricsText }');
    }

    const TAG_EDITOR_FIELDS = [
      ['title', 'tag-title'], ['artist', 'tag-artist'], ['album', 'tag-album'], ['albumartist', 'tag-albumArtist'],
      ['genre', 'tag-genre'], ['year', 'tag-year'], ['track', 'tag-track'], ['disk', 'tag-disk'],
      ['composer', 'tag-composer'], ['publisher', 'tag-publisher'], ['conductor', 'tag-conductor'], ['bpm', 'tag-bpm'],
      ['grouping', 'tag-grouping'], ['copyright', 'tag-copyright'], ['comment', 'tag-comment'],
      ...Array.from({length:19}, (_, i) => [`custom${i+2}`, `tag-custom${i+2}`]),
      ['lyrics', 'tag-lyrics'], ['lyricist', 'tag-lyricist'], ['originalartist', 'tag-originalArtist'],
      ['originalalbum', 'tag-originalAlbum'], ['originalyear', 'tag-originalYear'], ['quality', 'tag-quality'],
      ['tempo', 'tag-tempo'], ['mood', 'tag-mood'], ['occasion', 'tag-occasion'], ['keywords', 'tag-keywords'], ['language', 'tag-language']
    ];

    function editorTextValue(common, native, key) {
      const text = (v) => Array.isArray(v) ? (v[0] ?? '') : v;
      if (key === 'genre') return text(common?.genre);
      if (key === 'composer') return text(common?.composer);
      // Tag-editor audit: music-metadata maps some fields only for some formats
      // (e.g. original artist/album only from ID3 TOPE/TOAL, publisher only as
      // "label"). Fall back to the raw tag so a value saved by Hive -- or by
      // another tagger -- always shows up again when the editor reopens.
      if (key === 'publisher') return text(common?.label) || text(common?.publisher) || nativeTagValue(native, 'PUBLISHER') || nativeTagValue(native, 'TPUB') || nativeTagValue(native, '©pub');
      if (key === 'conductor') return text(common?.conductor);
      if (key === 'comment') return normalizeMetadataText(common?.comment);
      if (key === 'lyrics') return normalizeLyricsText(common?.lyrics);
      if (key === 'lyricist') return text(common?.lyricist) || nativeTagValue(native, 'LYRICIST');
      if (key === 'originalartist') return text(common?.originalartist) || nativeTagValue(native, 'ORIGINALARTIST');
      if (key === 'originalalbum') return text(common?.originalalbum) || nativeTagValue(native, 'ORIGINALALBUM');
      if (key === 'originalyear') return common?.originalyear || String(common?.originaldate || '').slice(0, 4) || nativeTagValue(native, 'ORIGINALYEAR');
      if (key === 'mood') return text(common?.mood) || nativeTagValue(native, 'MOOD');
      if (key === 'occasion') return text(common?.occasion) || nativeTagValue(native, 'OCCASION');
      if (key === 'quality') return nativeTagValue(native, 'QUALITY');
      if (key === 'tempo') return common?.tempo ?? nativeTagValue(native, 'TEMPO');
      if (key === 'keywords') return text(common?.keywords);
      if (key === 'language') return common?.language || nativeTagValue(native, 'LANGUAGE') || '';
      if (key === 'replaygain_track_gain') return nativeTagValue(native, 'REPLAYGAIN_TRACK_GAIN');
      if (key === 'replaygain_track_peak') return nativeTagValue(native, 'REPLAYGAIN_TRACK_PEAK');
      if (key === 'replaygain_album_gain') return nativeTagValue(native, 'REPLAYGAIN_ALBUM_GAIN');
      if (key === 'replaygain_album_peak') return nativeTagValue(native, 'REPLAYGAIN_ALBUM_PEAK');
      if (key === 'r128_track_gain') return nativeTagValue(native, 'R128_TRACK_GAIN');
      if (key === 'track') return common?.track?.no ?? '';
      if (key === 'disk') return common?.disk?.no ?? '';
      if (key === 'compilation') {
        const commonCompilation = common?.compilation === true || String(common?.compilation || '').trim() === '1';
        const nativeCompilation = nativeTagValue(native, 'TCMP') || nativeTagValue(native, 'COMPILATION') || nativeTagValue(native, 'cpil');
        return (commonCompilation || /^(1|true|yes)$/i.test(String(nativeCompilation || '').trim())) ? '1' : '';
      }
      if (key === 'pcount') return nativeTagValue(native, 'p_count') || nativeTagValue(native, 'PCOUNT') || nativeTagValue(native, 'PCNT');
      if (/^custom\d+$/.test(key)) return nativeTagValue(native, key);
      return common?.[key] ?? '';
    }

    function editorSortValue(native, key, fallback='') {
      const sortIds = { title:'TSOT', album:'TSOA', albumartist:'TSO2', artist:'TSOP', composer:'TSOC' };
      return nativeTagValue(native, sortIds[key] || '') || fallback || '';
    }

    function editorNativeObject(native) {
      const out = {};
      for (const tagList of Object.values(native || {})) {
        for (const tag of (Array.isArray(tagList) ? tagList : [])) {
          if (!tag?.id || tag.value === undefined) continue;
          const raw = tag.value?.text ?? tag.value?.description ?? tag.value?.value ?? tag.value;
          if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[tag.id] = raw;
        }
      }
      return out;
    }

    function editorComparable(v) {
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v).trim();
    }

    function mergeEditorValues(values) {
      const normalized = values.map(editorComparable);
      return normalized.every(v => v === normalized[0]) ? (values[0] ?? '') : '';
    }

    return { TAG_EDITOR_FIELDS, editorTextValue, editorSortValue, editorNativeObject, editorComparable, mergeEditorValues };
  }

  const exported = { createTagEditorFields };
  if (typeof window !== 'undefined') window.HiveTagEditorFields = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
