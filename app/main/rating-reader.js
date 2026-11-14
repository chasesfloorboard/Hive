'use strict';

// Read a track's embedded star rating from the audio file. Extracted from main.js (QUALITY-ROADMAP,
// Native playback/stats region). Read-only: it never writes tags (that is the metadata writer's job).
//
// Hive's rating authority, by format:
//   - MP3/WAV: ONLY the MusicBee POPM frame (email "MusicBee"). Other apps' POPM and FMPS are deliberately
//     ignored for display, so a foreign player's rating-0 POPM can't hide MusicBee's 255.
//   - FLAC/Vorbis/MP4: the portable FMPS_RATING field Hive itself writes (normalised 0.0–1.0), read via the
//     music-metadata library. Generic/provider rating tags are intentionally ignored.
//
// id3-frames (POPM/size/TXXX helpers) and wav-id3 are pure shared modules required directly; ensureMM (the
// lazy music-metadata loader) is injected because it owns main's cached import.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { readId3Size, musicBeePopmByte, musicBeePopmStars, txxxDescription } = require('./id3-frames');
const { readWavMusicBeePopmRaw } = require('./wav-id3');

function createRatingReader({ ensureMM }) {
  // The raw MusicBee POPM byte (0–255) from an MP3, or 0. ID3 can legally hold more than one POPM frame
  // (one per application/email); never trust the first blindly — take MusicBee's.
  async function readMp3PopmRaw(filePath) {
    try {
      const fd = await fsp.open(filePath, 'r');
      try {
        const head = Buffer.alloc(10);
        const { bytesRead } = await fd.read(head, 0, 10, 0);
        if (bytesRead < 10 || head.toString('ascii', 0, 3) !== 'ID3') return 0;
        const major = head[3];
        const flags = head[5];
        const tagSize = readId3Size(head);
        const payload = Buffer.alloc(tagSize);
        await fd.read(payload, 0, tagSize, 10);

        let pos = 0;
        // ID3v2.3/v2.4 extended headers precede the frames when the flag is set.
        if (major >= 3 && (flags & 0x40)) {
          if (payload.length >= 4) {
            const extSize = major >= 4
              ? ((payload[0] & 0x7f) << 21) | ((payload[1] & 0x7f) << 14) | ((payload[2] & 0x7f) << 7) | (payload[3] & 0x7f)
              : payload.readUInt32BE(0);
            // v2.3's size excludes its four-byte size field; v2.4 includes the size field.
            pos = major >= 4 ? extSize : 4 + extSize;
            if (pos > payload.length) pos = 0;
          }
        }

        let musicBeeRating = 0;
        let anyPopmRating = 0;
        let fmpsRating = 0;
        while (pos < payload.length) {
          if (major === 2) {
            if (pos + 6 > payload.length) break;
            const id = payload.toString('ascii', pos, pos + 3);
            const size = (payload[pos + 3] << 16) | (payload[pos + 4] << 8) | payload[pos + 5];
            if (!/^[A-Z0-9]{3}$/.test(id) || size <= 0 || pos + 6 + size > payload.length) break;
            if (id === 'POP') {
              const frame = payload.subarray(pos + 6, pos + 6 + size);
              const nul = frame.indexOf(0);
              if (nul >= 0 && nul + 1 < frame.length) {
                const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
                const raw = musicBeePopmByte(frame[nul + 1]);
                anyPopmRating = Math.max(anyPopmRating, raw);
                if (email === 'musicbee') musicBeeRating = Math.max(musicBeeRating, raw);
              }
            }
            pos += 6 + size;
          } else {
            if (pos + 10 > payload.length) break;
            const id = payload.toString('ascii', pos, pos + 4);
            const b = payload.subarray(pos + 4, pos + 8);
            const size = major >= 4
              ? ((b[0] & 0x7f) << 21) | ((b[1] & 0x7f) << 14) | ((b[2] & 0x7f) << 7) | (b[3] & 0x7f)
              : b.readUInt32BE(0);
            if (/^\x00{4}$/.test(id)) {
              let next = pos;
              while (next < payload.length && payload[next] === 0) next++;
              if (next + 10 <= payload.length) {
                const nextId = payload.toString('ascii', next, next + 4);
                const nextSize = major >= 4
                  ? ((payload[next + 4] & 0x7f) << 21) | ((payload[next + 5] & 0x7f) << 14) | ((payload[next + 6] & 0x7f) << 7) | (payload[next + 7] & 0x7f)
                  : payload.readUInt32BE(next + 4);
                if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
                  pos = next;
                  continue;
                }
              }
              break;
            }
            if (!/^[A-Z0-9]{4}$/.test(id) || size <= 0) break;
            if (pos + 10 + size > payload.length) break;
            const frame = payload.subarray(pos + 10, pos + 10 + size);
            if (id === 'POPM') {
              const nul = frame.indexOf(0);
              if (nul >= 0 && nul + 1 < frame.length) {
                const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
                const raw = musicBeePopmByte(frame[nul + 1]);
                anyPopmRating = Math.max(anyPopmRating, raw);
                if (email === 'musicbee') musicBeeRating = Math.max(musicBeeRating, raw);
              }
            } else if (id === 'TXXX') {
              // Strawberry's portable fallback is TXXX:FMPS_Rating with a
              // normalized 0.0-1.0 value. Read it if no POPM is available.
              const desc = txxxDescription(frame).trim().toUpperCase();
              if (desc === 'FMPS_RATING') {
                const encoding = frame[0];
                const body = frame.subarray(1);
                let sep = -1;
                if (encoding === 0 || encoding === 3) {
                  sep = body.indexOf(0);
                  if (sep >= 0) {
                    const valueText = body.subarray(sep + 1).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
                    const normalized = Number.parseFloat(valueText);
                    if (Number.isFinite(normalized) && normalized > fmpsRating) fmpsRating = Math.max(0, Math.min(1, normalized));
                  }
                } else {
                  for (let i = 0; i + 1 < body.length; i += 2) {
                    if (body[i] === 0 && body[i + 1] === 0) { sep = i; break; }
                  }
                  if (sep >= 0) {
                    const valueText = body.subarray(sep + 2).toString('utf16le').trim();
                    const normalized = Number.parseFloat(valueText);
                    if (Number.isFinite(normalized) && normalized > fmpsRating) fmpsRating = Math.max(0, Math.min(1, normalized));
                  }
                }
              }
            }
            pos += 10 + size;
          }
        }
        // Hive's MP3 rating authority is ONLY the MusicBee POPM frame.
        // Other POPM applications and FMPS are deliberately ignored for display.
        return musicBeeRating || 0;
      } finally {
        await fd.close();
      }
    } catch {
      return 0;
    }
  }

  async function readMp3PopmRating(filePath) {
    const raw = await readMp3PopmRaw(filePath);
    return musicBeePopmStars(raw);
  }

  async function readNativeEmbeddedRating(filePath, metadataLib) {
    const meta = await metadataLib.parseFile(filePath, { duration: false, skipCovers: true });
    const normalize = (raw, scale255 = false, scaleNormalized = false) => {
      if (raw === null || raw === undefined || raw === '') return 0;
      if (typeof raw === 'object') return normalize(raw.rating ?? raw.text ?? raw.value, scale255, scaleNormalized);
      const n = Number(String(raw).replace(/[^0-9.+-]/g, ''));
      if (!Number.isFinite(n)) return 0;
      if (scale255) return musicBeePopmStars(n);
      if (scaleNormalized) return Math.max(0, Math.min(5, Math.round(n * 10) / 2));
      if (n <= 5) return Math.round(n * 2) / 2;
      if (n <= 100) return Math.max(0, Math.min(5, Math.round(n / 10) / 2));
      return musicBeePopmStars(n);
    };

    let rating = 0;
    for (const tagList of Object.values(meta.native || {})) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) {
        // MP4/M4A freeform atoms come back from music-metadata namespaced as
        // "----:com.apple.iTunes:FMPS_Rating", not the bare field name. Matching
        // only the bare id here silently discarded every rating Hive itself wrote
        // to an M4A file (write_rating -> tag_helper.py always succeeded; only the
        // read-back for display was broken). Compare the segment after the last
        // ':' so both bare (FLAC/Vorbis) and namespaced (MP4 freeform) ids work.
        const rawId = String(tag?.id || '');
        const id = (rawId.includes(':') ? rawId.slice(rawId.lastIndexOf(':') + 1) : rawId).toUpperCase();
        const desc = String(tag?.value?.description || '').toUpperCase();
        // Only read the exact portable field Hive writes for non-MP3 files.
        // Generic/provider rating tags are intentionally ignored.
        if (id === 'FMPS_RATING' || desc === 'FMPS_RATING' || id === 'FMPS/RATING' || desc === 'FMPS/RATING') {
          rating = Math.max(rating, normalize(
            tag?.value?.rating ?? tag?.value?.text ?? tag?.value?.value ?? tag?.value,
            false,
            true
          ));
        }
      }
    }
    return Math.max(0, Math.min(5, rating));
  }

  async function readEmbeddedRating(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') return readMp3PopmRating(filePath);
    if (ext === '.wav') return musicBeePopmStars(await readWavMusicBeePopmRaw(filePath));
    const metadataLib = await ensureMM();
    return readNativeEmbeddedRating(filePath, metadataLib);
  }

  return { readMp3PopmRaw, readMp3PopmRating, readNativeEmbeddedRating, readEmbeddedRating };
}

module.exports = { createRatingReader };
