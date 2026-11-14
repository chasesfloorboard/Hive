package com.local.hive.mobile.data

import java.io.File
import java.io.FileOutputStream

/**
 * Write [text] to this file atomically and durably: write a temp sibling, flush it to disk, then rename it
 * over the target. A crash / power loss / process kill mid-write leaves the PREVIOUS good file intact rather
 * than a torn or 0-byte one — the difference between losing the user's edits and keeping them.
 *
 * Several local JSON stores (stream Loves, smart playlists, pending PC edits, downloads, the PC-library
 * cache) used a bare `writeText`, which truncates the target to 0 and streams bytes with no temp file and no
 * flush, so a kill at the wrong moment silently wiped them — and their loaders default to empty on a parse
 * error, so the loss is silent. `LoveFiles`/`TagYears` already did temp+rename by hand; this shares that one
 * guarantee (plus an fsync) so no store is left un-hardened and no two places re-implement it.
 *
 * Callers keep their own `runCatching` (writes here are best-effort): this throws only if even the temp
 * write fails, and never leaves a temp file behind.
 */
fun File.writeTextAtomic(text: String) {
    val tmp = File(parentFile ?: absoluteFile.parentFile, "$name.tmp")
    try {
        FileOutputStream(tmp).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.flush()
            // Durability: get the bytes onto the disk before the rename makes the file visible.
            runCatching { out.fd.sync() }
        }
        // rename over the target is atomic on the app's internal storage (ext4/f2fs). renameTo can refuse to
        // overwrite on some filesystems; fall back to replace-then-rename, and a copy as a last resort.
        if (!tmp.renameTo(this) && !(delete() && tmp.renameTo(this))) {
            tmp.copyTo(this, overwrite = true)
            tmp.delete()
        }
    } catch (t: Throwable) {
        tmp.delete()
        throw t
    }
}
