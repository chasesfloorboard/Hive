'use strict';

// Every writer here follows the same safety contract, established after a
// corruption-risk audit (see docs/ai for the full writeup once added):
//   1. Wait for the target file to be released by the native player
//      (waitForPlaybackProtectionRelease) before touching it.
//   2. Acquire the per-path write lock (withMusicBeeWriteLock) so Love,
//      Rating, artwork, and general metadata writes for the SAME file never
//      race each other -- each one independently snapshots the file, edits
//      its own copy, and renames it back, so two concurrent writers would
//      otherwise let whichever rename lands last silently discard the other.
//   3. Copy the original to a temp file on the SAME filesystem
//      (createMetadataTempPath's ".beehive-tmp" sibling directory, not the
//      OS temp dir) so the final commit is a real atomic rename, not a
//      non-atomic copy+unlink -- which matters because a music library
//      commonly lives on a different filesystem/device than the OS temp dir.
//   4. Verify the write against the temp copy, back up the original
//      (backupFileBeforeMetadataCommit), then atomically rename the temp
//      file over the original (commitMetadataTemp). On any failure, the
//      original file is left completely untouched.
//
// Extracted out of app/main/main.js so this logic is a plain, dependency-
// injected module: it can be constructed with fakes/spies in a test and
// exercised directly, instead of only being checkable by grepping main.js's
// source text for the right patterns.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');

function createMetadataWriter(deps) {
  const {
    runTagHelper,
    copyMetadataFile,
    markLibraryInternalWrite,
    waitForPlaybackProtectionRelease,
    normalizePictureType,
    readEmbeddedRating,
    tagBackupsDir,
    // Optional: defaults to the real OS temp dir (via node:os, which works
    // identically whether this module runs inside Electron's main process or
    // a plain Node test/CLI context). Only main.js needs to override this --
    // it passes Electron's app.getPath('temp') so the fallback path matches
    // exactly what the rest of the app already uses for scratch files.
    // `require('electron')` is deliberately NOT used directly in this module:
    // outside a real Electron process it resolves to a path string, not the
    // {app, ...} object, so calling `.getPath` on it would throw -- exactly
    // the kind of landmine dependency injection exists to avoid.
    osTempDir = () => os.tmpdir(),
  } = deps;

  const musicBeeWriteLocks = new Map();

  async function withMusicBeeWriteLock(trackPath, fn) {
    const key = path.resolve(trackPath);
    const previous = musicBeeWriteLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    musicBeeWriteLocks.set(key, current);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (musicBeeWriteLocks.get(key) === current) musicBeeWriteLocks.delete(key);
    }
  }

  async function createMetadataTempPath(trackPath, label) {
    const ext = path.extname(trackPath).toLowerCase();
    const filename = `media-${process.pid}-${Date.now()}-${label}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    // Prefer a hidden sibling directory on the SAME filesystem as the target so
    // commitMetadataTemp()'s rename is a real atomic rename, not its non-atomic
    // copy+unlink EXDEV fallback. That fallback is not a rare edge case: a music
    // library commonly lives on a different filesystem/device than the OS temp
    // dir (e.g. a tmpfs /tmp vs. a library on a separate drive or NAS mount),
    // so without this, ordinary tag/rating/love writes on such a setup were
    // silently taking the non-atomic path every time -- exactly the kind of
    // write a crash or force-quit mid-copy could turn into a truncated audio
    // file. ".beehive-tmp" is the existing convention the library scanner
    // (see the walk() directory-skip check in main.js) and the filesystem
    // watcher already recognize and ignore, so nothing written here is ever
    // indexed as a track.
    const siblingDir = path.join(path.dirname(trackPath), '.beehive-tmp');
    try {
      await fsp.mkdir(siblingDir, { recursive: true, mode: 0o700 });
      return path.join(siblingDir, filename);
    } catch {
      // Read-only/unwritable library directory (e.g. a mounted read-only
      // share): fall back to the OS temp dir. commitMetadataTemp's own EXDEV
      // handling still covers the resulting cross-device rename.
      const dir = path.join(osTempDir(), 'beehive-metadata');
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      return path.join(dir, filename);
    }
  }

  async function backupFileBeforeMetadataCommit(trackPath) {
    const absolutePath = path.resolve(String(trackPath));
    await fsp.mkdir(tagBackupsDir(), { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hash = crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
    const safeBase = path.basename(absolutePath).replace(/[^A-Za-z0-9._-]+/g, '_');
    const backupPath = path.join(tagBackupsDir(), `${stamp}-${hash}-${safeBase}`);
    const originalSha256 = crypto.createHash('sha256').update(await fsp.readFile(absolutePath)).digest('hex');
    await fsp.copyFile(absolutePath, backupPath);
    const manifestPath = path.join(tagBackupsDir(), `${stamp}-${hash}-manifest.json`);
    await fsp.writeFile(manifestPath, JSON.stringify({ hive:'Hive', purpose:'metadata write recovery backup', createdAt:new Date().toISOString(), originalPath:absolutePath, backupPath, originalSha256 }, null, 2), { mode:0o600 });
    return { backupPath, manifestPath, originalSha256 };
  }

  async function commitMetadataTemp(temp, trackPath, background = false) {
    // A successful temp-file write is not enough: the pre-write media must remain
    // recoverable. If the backup cannot be created, do not replace the original.
    await backupFileBeforeMetadataCommit(trackPath);
    try {
      await fsp.rename(temp, trackPath);
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err;
      await copyMetadataFile(temp, trackPath, background);
      await fsp.unlink(temp);
    }
  }

  async function embedRatingInFile(trackPath, stars) {
    if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
    const value = Math.max(0, Math.min(5, Number(stars) || 0));
    // A rating write reads the whole file into a temp copy and later renames it
    // over the original (see commitMetadataTemp). If GStreamer is actively
    // decoding this exact path when that rename lands, the player can be left
    // reading from a file that no longer matches what its own file descriptor
    // expected. Love writes and play-count embedding already wait for the
    // active track to be released before touching its file; rating must too.
    await waitForPlaybackProtectionRelease(path.resolve(String(trackPath)));
    // Hold the same per-path lock every other metadata writer (Love, artwork,
    // the general tag-editor save) uses, for the whole read-modify-commit
    // sequence. Without it, liking a track and rating it 5 stars in quick
    // succession could race: each writer snapshots the file, edits its own
    // copy, and renames it back independently, so whichever rename lands last
    // would silently win in its entirety and discard the other edit.
    return withMusicBeeWriteLock(trackPath, async () => {
      const temp = await createMetadataTempPath(trackPath, 'rating');
      const artworkBefore = await runTagHelper({ op:'artwork_fingerprint', path:trackPath });
      try {
        await copyMetadataFile(trackPath, temp, false);
        // Metadata writes are deliberately delegated to the bundled Mutagen backend.
        // No FFmpeg/container reconstruction is allowed for a one-field tag edit.
        await runTagHelper({ op:'write_rating', path:temp, rating:value });
        const readBack = await readEmbeddedRating(temp);
        if (Math.abs(readBack - value) > 0.01) {
          throw new Error(`Rating write verification failed: expected ${value}, read back ${readBack}`);
        }
        const artworkAfter = await runTagHelper({ op:'artwork_fingerprint', path:temp });
        if (artworkBefore?.fingerprint !== artworkAfter?.fingerprint) {
          throw new Error('Rating write changed embedded artwork unexpectedly; the original file was left untouched.');
        }
        await commitMetadataTemp(temp, trackPath, false);
        return true;
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not embed rating: ${err.message}`);
      }
    });
  }

  async function performWriteArtwork(trackPath, imagePath, artworkMeta = {}, options = {}) {
    if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
    // See embedRatingInFile: this writer's temp-copy-then-rename can otherwise
    // land its rename while the native player still has this exact path open.
    await waitForPlaybackProtectionRelease(path.resolve(String(trackPath)));
    markLibraryInternalWrite(trackPath);
    if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Artwork file not found.');
    // Same per-path lock as embedRatingInFile: serializes this against Love,
    // Rating and any other metadata writer for the same file.
    return withMusicBeeWriteLock(trackPath, async () => {
      const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
      const ext = path.extname(trackPath).toLowerCase();
      const temp = await createMetadataTempPath(trackPath, 'art');
      try {
        await copyMetadataFile(trackPath, temp, !!options.background);
        const pictureType = normalizePictureType(artworkMeta?.pictureType || 'Cover (Front)');
        if (pictureType === 'Cover (Front)') {
          await runTagHelper({ __background: !!options.background, op: 'replace_front', path: temp, imagePath, pictureType: 'Cover (Front)', comment: String(artworkMeta?.comment || '') });
        } else {
          await runTagHelper({ __background: !!options.background, op: 'modify_artwork', path: temp, operation: { action:'add', imagePath, pictureType, comment: String(artworkMeta?.comment || '') } });
        }
        const wanted = crypto.createHash('sha256').update(await fsp.readFile(imagePath)).digest('hex');
        const verify = await runTagHelper({ __background: !!options.background, op: 'artwork_contains_hash', path: temp, sha256: wanted });
        const ok = verify?.match === true;
        if (!ok) throw new Error('The new artwork could not be verified in the file after the save completed.');
        const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
        if (protectedBefore !== protectedAfter) throw new Error('Artwork save changed unrelated tags; the original file was left untouched.');
        await commitMetadataTemp(temp, trackPath, !!options.background);
        return true;
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not write artwork: ${err.message}`);
      }
    });
  }

  async function performModifyArtwork(trackPath, operation = {}, options = {}) {
    if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
    await waitForPlaybackProtectionRelease(path.resolve(String(trackPath)));
    markLibraryInternalWrite(trackPath);
    return withMusicBeeWriteLock(trackPath, async () => {
      const ext = path.extname(trackPath).toLowerCase();
      const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
      const temp = await createMetadataTempPath(trackPath, 'artmod');
      try {
        await copyMetadataFile(trackPath, temp, !!options.background);
        const verify = await runTagHelper({ __background: !!options.background, op: 'modify_artwork', path: temp, operation });
        const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
        if (protectedBefore !== protectedAfter) throw new Error('Artwork edit changed unrelated tags; the original file was left untouched.');
        await commitMetadataTemp(temp, trackPath, !!options.background);
        return (verify.pictures || []).map(pic => ({ index:pic.index, type:pic.type, description:pic.description, mime:pic.mime }));
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not modify artwork: ${err.message}`);
      }
    });
  }

  async function performRemoveFrontArtwork(trackPath, options = {}) {
    if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
    await waitForPlaybackProtectionRelease(path.resolve(String(trackPath)));
    markLibraryInternalWrite(trackPath);
    return withMusicBeeWriteLock(trackPath, async () => {
      const ext = path.extname(trackPath).toLowerCase();
      // The artwork-excluded fingerprint includes all other metadata, including
      // Love and Rating. One before/after comparison is sufficient and avoids the
      // extra full-file reads that previously made bulk removal unnecessarily heavy.
      const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
      const temp = await createMetadataTempPath(trackPath, 'no-front');
      try {
        await copyMetadataFile(trackPath, temp, !!options.background);
        const result = await runTagHelper({ __background: !!options.background, op: 'remove_front', path: temp });
        const remaining = Array.isArray(result?.pictures) ? result.pictures : [];
        if (remaining.some(p => normalizePictureType(p?.type || 'Other') === 'Cover (Front)')) {
          throw new Error('Front artwork could not be fully removed from the file.');
        }
        const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
        if (protectedBefore !== protectedAfter) throw new Error('Artwork removal changed unrelated tags; the original file was left untouched.');
        await commitMetadataTemp(temp, trackPath, !!options.background);
        return true;
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not remove front artwork: ${err.message}`);
      }
    });
  }

  async function performRemoveArtwork(trackPath, options = {}) {
    if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
    await waitForPlaybackProtectionRelease(path.resolve(String(trackPath)));
    markLibraryInternalWrite(trackPath);
    return withMusicBeeWriteLock(trackPath, async () => {
      const ext = path.extname(trackPath).toLowerCase();
      const protectedBefore = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: trackPath })).fingerprint;
      const temp = await createMetadataTempPath(trackPath, 'no-art');
      try {
        await copyMetadataFile(trackPath, temp, !!options.background);
        // clear_artwork already rereads the pictures and returns the result. Avoid
        // launching a second artwork reader for the same file.
        const result = await runTagHelper({ __background: !!options.background, op: 'clear_artwork', path: temp });
        if ((result?.pictures || []).length) throw new Error('Embedded artwork could not be fully removed from the file.');
        const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
        if (protectedBefore !== protectedAfter) throw new Error('Artwork removal changed unrelated tags; the original file was left untouched.');
        await commitMetadataTemp(temp, trackPath, !!options.background);
        return true;
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not remove artwork: ${err.message}`);
      }
    });
  }

  async function performWriteMetadata(trackPath, tags = {}, artwork = null, options = {}) {
    if (!trackPath || !fs.existsSync(trackPath)) throw new Error('Track file not found.');
    // This is the tag editor's general Save path (title/artist/rating-adjacent
    // fields/lyrics/etc.) -- the same temp-copy-then-rename risk as
    // embedRatingInFile applies here, and it is hit far more often.
    await waitForPlaybackProtectionRelease(path.resolve(String(trackPath)));
    markLibraryInternalWrite(trackPath);
    return withMusicBeeWriteLock(trackPath, async () => {
      const temp = await createMetadataTempPath(trackPath, 'metadata');
      const artworkAction = String(artwork?.action || '').toLowerCase();
      const artworkWasIntentionallyChanged = ['add','write','replace','replace_slot','remove_all','remove_front'].includes(artworkAction);
      const artworkBefore = artworkWasIntentionallyChanged ? null : (await runTagHelper({ __background: !!options.background, op: 'artwork_fingerprint', path: trackPath })).fingerprint;
      try {
        await copyMetadataFile(trackPath, temp, !!options.background);
        await runTagHelper({ __background: !!options.background, op: 'write_metadata', path: temp, tags: tags || {}, artwork: artwork || null });
        const st = await fsp.stat(temp);
        if (!st.size) throw new Error('native metadata writer produced an empty file');

        // Verify metadata without decoding embedded covers. Album tagging can involve
        // large artwork, and the old skipCovers:false verification paid to parse those
        // images even when only text tags changed.
        if (Object.keys(tags || {}).length) {
          // Verify through the canonical Mutagen backend itself. The previous
          // verifier dynamically imported music-metadata here; a portable release
          // may intentionally omit Node-side parsing dependencies, and a tag edit
          // must not fail after the native writer has already succeeded merely
          // because an unrelated read-side package is unavailable.
          const fields = ['title','artist','album','albumArtist','genre','comment','composer','grouping','copyright','publisher','conductor','lyrics']
            .filter(key => Object.prototype.hasOwnProperty.call(tags || {}, key));
          if (fields.length) {
            const nativeVerify = await runTagHelper({ __background: !!options.background, op: 'read_metadata_fields', path: temp, fields });
            const got = nativeVerify?.fields || {};
            const norm = value => String(value ?? '').trim();
            for (const key of fields) {
              if (norm(tags[key]) !== norm(got[key])) throw new Error(`Tag write verification failed for ${key}: expected ${JSON.stringify(tags[key])}, read back ${JSON.stringify(got[key])}`);
            }
          }
          if (Object.prototype.hasOwnProperty.call(tags || {}, 'compilation')) {
            const nativeVerify = await runTagHelper({ __background: !!options.background, op: 'read_compilation', path: temp });
            const expected = String(tags.compilation) === '1' ? '1' : '0';
            const actual = String(nativeVerify?.compilation || '0') === '1' ? '1' : '0';
            if (expected !== actual) throw new Error(`Tag write verification failed for compilation: expected ${expected}, read back ${actual}`);
          }
        }

        if (artworkBefore) {
          const artworkAfter = (await runTagHelper({ __background: !!options.background, op: 'artwork_fingerprint', path: temp })).fingerprint;
          if (artworkBefore !== artworkAfter) throw new Error('Metadata save changed embedded artwork unexpectedly; the original file was left untouched.');
        }

        if (artwork) {
          const action = String(artwork.action || '').toLowerCase();
          if (['add','write','replace','replace_slot'].includes(action)) {
            if (!artwork.imagePath || !fs.existsSync(artwork.imagePath)) throw new Error('Artwork file not found.');
            const wanted = crypto.createHash('sha256').update(await fsp.readFile(artwork.imagePath)).digest('hex');
            const verify = await runTagHelper({ __background: !!options.background, op: 'artwork_contains_hash', path: temp, sha256: wanted });
            if (verify?.match !== true) throw new Error('The new artwork could not be verified in the file after the save completed.');
          } else if (action === 'remove_all' || action === 'remove_front') {
            const result = await runTagHelper({ __background: !!options.background, op: 'read_artwork_metadata', path: temp });
            const pictures = Array.isArray(result?.pictures) ? result.pictures : [];
            if (action === 'remove_all' && pictures.length) throw new Error('Embedded artwork could not be fully removed from the file.');
            if (action === 'remove_front' && pictures.some(p => normalizePictureType(p?.type || 'Other') === 'Cover (Front)')) throw new Error('Front artwork could not be fully removed from the file.');
          }
        }

        const protectedBefore = options.protectedBefore;
        if (protectedBefore) {
          const protectedAfter = (await runTagHelper({ __background: !!options.background, op: 'protected_metadata_fingerprint', path: temp })).fingerprint;
          if (protectedBefore !== protectedAfter) throw new Error('Metadata save changed protected metadata unexpectedly; the original file was left untouched.');
        }
        await commitMetadataTemp(temp, trackPath, !!options.background);
        return true;
      } catch (err) {
        try { await fsp.unlink(temp); } catch {}
        throw new Error(`Could not write metadata: ${err.message}`);
      }
    });
  }

  async function performWriteTags(trackPath, tags, options = {}) {
    // Keep the existing single-file API, but use the same optimized writer as the
    // album batch path. Verification no longer decodes embedded artwork.
    return performWriteMetadata(trackPath, tags, null, options);
  }

  return {
    withMusicBeeWriteLock,
    createMetadataTempPath,
    backupFileBeforeMetadataCommit,
    commitMetadataTemp,
    embedRatingInFile,
    performWriteArtwork,
    performModifyArtwork,
    performRemoveFrontArtwork,
    performRemoveArtwork,
    performWriteMetadata,
    performWriteTags,
  };
}

module.exports = { createMetadataWriter };
