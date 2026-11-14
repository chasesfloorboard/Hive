package com.local.hive.mobile.data

import android.content.ContentUris
import android.content.Context
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * Every picture embedded in a song, as Hive on the PC reads them for its
 * cover carousel: MP3 and WAV (ID3v2.2–2.4 APIC/PIC), FLAC (PICTURE blocks)
 * and M4A (each `covr` image). Android's own reader gives only the first. Pictures
 * are kept per song in the cache, distinct by content, in file order.
 */
object EmbeddedPictures {
    /**
     * The album's cover found online when it shows a different picture from the one embedded in its
     * songs (Apple Music's Nothing Was The Same is the adult cover; the files have the baby one): Hive
     * shows the embedded one and keeps this as the album's second cover. Null when they agree or none.
     */
    fun onlineAlternate(context: Context, albumId: Long): File? {
        val dir = File(context.cacheDir, "hq-art")
        val art = File(dir, "$albumId.jpg")
        return art.takeIf { File(dir, "$albumId.differs").exists() && it.length() > 0 }
    }

    /** Whether two pictures show the same artwork (perhaps at other sizes): a 16×16 average hash. */
    fun looksAlike(a: ByteArray, b: ByteArray): Boolean {
        val ha = averageHash(a) ?: return false
        val hb = averageHash(b) ?: return false
        return ha.indices.count { ha[it] != hb[it] } <= LOOK_ALIKE_BITS
    }

    /**
     * The song's pictures when it has two or more distinct ones (with [albumId], the album's online
     * cover counts when it differs from the embedded one, shown after it); otherwise empty.
     */
    suspend fun forTrack(context: Context, trackId: Long, albumId: Long? = null): List<File> = withContext(Dispatchers.IO) {
        val own = embeddedForTrack(context, trackId)
        val alternate = albumId?.let { onlineAlternate(context, it) } ?: return@withContext own
        // The song's own picture first, then the online one.
        val first = if (own.isNotEmpty()) own else ownFirstPicture(context, trackId)?.let(::listOf).orEmpty()
        if (first.isEmpty()) return@withContext own
        first + alternate
    }

    /** The song's first embedded picture, kept as a file, for a song with only one. */
    private fun ownFirstPicture(context: Context, trackId: Long): File? {
        val file = File(context.cacheDir, "pictures/$trackId/single.img")
        if (file.length() > 0) return file
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, trackId)
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { read(it) } }.getOrNull().orEmpty().firstOrNull() ?: return null
        file.parentFile?.mkdirs()
        return runCatching { file.writeBytes(bytes); file }.getOrNull()
    }

    private suspend fun embeddedForTrack(context: Context, trackId: Long): List<File> = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "pictures/$trackId")
        val marker = File(dir, "count")
        if (marker.exists()) return@withContext (0 until (marker.readText().toIntOrNull() ?: 0)).map { File(dir, "$it.img") }.filter { it.exists() }
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, trackId)
        val pictures = runCatching { context.contentResolver.openInputStream(uri)?.use { read(it) } }.getOrNull().orEmpty()
        val distinct = lookDistinct(pictures.distinctBy { MessageDigest.getInstance("SHA-1").digest(it).contentHashCode() })
        dir.mkdirs()
        // One picture (or none) is what the normal cover already shows; only the count is kept.
        val kept = if (distinct.size > 1) distinct else emptyList()
        kept.forEachIndexed { i, bytes -> File(dir, "$i.img").writeBytes(bytes) }
        marker.writeText(kept.size.toString())
        kept.indices.map { File(dir, "$it.img") }
    }

    /**
     * The same artwork saved twice at different sizes would "turn" without
     * changing, so pictures that look alike (16×16 average hash) count once,
     * as the sharpest copy, in the place of the first.
     */
    private fun lookDistinct(pictures: List<ByteArray>): List<ByteArray> {
        val groups = mutableListOf<Pair<BooleanArray, MutableList<ByteArray>>>()
        for (p in pictures) {
            val hash = averageHash(p) ?: continue
            val near = groups.firstOrNull { (h, _) -> h.indices.count { h[it] != hash[it] } <= LOOK_ALIKE_BITS }
            if (near != null) near.second += p else groups += hash to mutableListOf(p)
        }
        return groups.map { (_, copies) -> copies.maxBy { it.size } }
    }

    private fun averageHash(bytes: ByteArray): BooleanArray? {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0) return null
        val sample = Integer.highestOneBit((maxOf(bounds.outWidth, bounds.outHeight) / 64).coerceAtLeast(1))
        val small = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val tiny = android.graphics.Bitmap.createScaledBitmap(small, 16, 16, true)
        val grey = IntArray(256) { i -> tiny.getPixel(i % 16, i / 16).let { ((it shr 16 and 0xff) * 299 + (it shr 8 and 0xff) * 587 + (it and 0xff) * 114) / 1000 } }
        val mean = grey.average()
        return BooleanArray(256) { grey[it] > mean }
    }

    /** Average hashes this close (of 256 bits) are the same picture. */
    private const val LOOK_ALIKE_BITS = 40

    /** A picture in a song's tags and its ID3 picture type (3 the front cover, 4 the back). */
    class Picture(val data: ByteArray, val type: Int) { val back get() = type == BACK }

    const val FRONT = 3
    const val BACK = 4

    /** Upper bound on an ID3 tag we will allocate, guarding against corrupt size fields. */
    private const val MAX_TAG_BYTES = 64 * 1024 * 1024

    /** Upper bound on an MP4 moov box we will hold in RAM (the tags, never the audio). */
    private const val MAX_MOOV_BYTES = 64L * 1024 * 1024

    /** The pictures in a song file's tags, in order. */
    fun read(input: InputStream): List<ByteArray> = readTyped(input).map { it.data }

    /**
     * The pictures with their types. MP4 keeps no types, so as Hive on the PC
     * reads it, its first picture is the front cover and the rest back covers.
     */
    fun readTyped(input: InputStream): List<Picture> {
        val stream = java.io.BufferedInputStream(input, 64 * 1024)
        stream.mark(16)
        val head = ByteArray(4).also { if (stream.read(it) < 4) return emptyList() }
        stream.reset()
        return when {
            head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte() -> id3PrefixedTypes(DataInputStream(stream))
            String(head, Charsets.ISO_8859_1) == "fLaC" -> flac(DataInputStream(stream))
            // MP4: the tags (moov) may sit after the audio. Walk the top-level boxes and
            // read only the moov box into RAM — skipping the (often huge) mdat audio —
            // instead of pulling the entire file in to find a cover.
            isMp4(stream) -> mp4FromStream(DataInputStream(stream))
            // WAV: the ID3 tag sits in its own chunk, usually after the audio.
            String(head, Charsets.ISO_8859_1) == "RIFF" -> WavTags.chunks(DataInputStream(stream), setOf("id3 "))?.get("id3 ")?.let { id3(DataInputStream(it.inputStream())) }.orEmpty()
            else -> emptyList()
        }
    }

    private fun isMp4(stream: java.io.BufferedInputStream): Boolean {
        stream.mark(16)
        val b = ByteArray(8).also { stream.read(it) }
        stream.reset()
        return String(b, 4, 4, Charsets.ISO_8859_1) == "ftyp"
    }

    // ---- ID3v2 ----

    fun id3(input: DataInputStream): List<Picture> =
        id3Frames(input).mapNotNull { (id, body) -> if (id == "APIC" || id == "PIC") picture(body, 0, body.size, id == "PIC") else null }

    /**
     * Some taggers prepend an ID3v2 tag to a FLAC file, keeping the cover in the FLAC
     * PICTURE block (after the tag) rather than an APIC — the PC's mutagen reads those,
     * so the phone must too, or a whole album shows blank covers. Read the ID3 pictures,
     * and if a FLAC stream follows the tag, read its pictures as well. A plain MP3 (audio
     * frames after the tag, no "fLaC" marker) is unaffected.
     */
    private fun id3PrefixedTypes(input: DataInputStream): List<Picture> {
        val out = id3(input).toMutableList()
        val marker = ByteArray(4)
        if (readFullyOrNull(input, marker) && String(marker, Charsets.ISO_8859_1) == "fLaC") {
            for (p in flacBlocks(input)) if (out.none { it.data.contentEquals(p.data) }) out += p
        }
        return out
    }

    /** An ID3v2 tag's frames, as (id, body), in order. */
    fun id3Frames(input: DataInputStream): List<Pair<String, ByteArray>> {
        val header = ByteArray(10).also { input.readFully(it) }
        val version = header[3].toInt()
        val flags = header[5].toInt()
        // The header's size field is attacker-controllable (any file on the phone can
        // be corrupt or hostile) and a syncsafe int reaches 256 MB, so a bogus header
        // would otherwise allocate that much up front and OOM. Album art lives in a few
        // MB; anything past the cap is not a tag we can use.
        val tagSize = syncsafe(header, 6)
        if (tagSize <= 0 || tagSize > MAX_TAG_BYTES) return emptyList()
        var tag = ByteArray(tagSize).also { input.readFully(it) }
        // A whole-tag unsynchronisation (v2.2/2.3) is undone before reading frames.
        if (flags and 0x80 != 0 && version < 4) tag = unsync(tag)
        var pos = 0
        // An extended header (v2.3/2.4) is skipped.
        if (flags and 0x40 != 0 && version >= 3 && tag.size >= 4) pos += if (version == 4) syncsafe(tag, 0) else int(tag, 0) + 4
        val out = mutableListOf<Pair<String, ByteArray>>()
        val idLen = if (version == 2) 3 else 4
        val headLen = if (version == 2) 6 else 10
        while (pos + headLen <= tag.size) {
            val id = String(tag, pos, idLen, Charsets.ISO_8859_1)
            if (id[0] == '\u0000') break
            val size = when (version) {
                2 -> ((tag[pos + 3].toInt() and 0xff) shl 16) or ((tag[pos + 4].toInt() and 0xff) shl 8) or (tag[pos + 5].toInt() and 0xff)
                4 -> syncsafe(tag, pos + 4)
                else -> int(tag, pos + 4)
            }
            val body = pos + headLen
            if (size <= 0 || body + size > tag.size) break
            out += id to tag.copyOfRange(body, body + size)
            pos = body + size
        }
        return out
    }

    /** An APIC (or v2.2 PIC) body: encoding, MIME (or 3-letter format), type, description, data. */
    private fun picture(b: ByteArray, from: Int, size: Int, v22: Boolean): Picture? {
        val end = from + size
        val encoding = b[from].toInt()
        var p = from + 1
        p = if (v22) p + 3 else (indexOf(b, p, end, 1) ?: return null) + 1
        if (p >= end) return null
        val type = b[p].toInt() and 0xff
        p += 1
        // The description ends with one zero byte, or two for UTF-16.
        p = if (encoding == 1 || encoding == 2) {
            var q = p
            while (q + 1 < end && !(b[q].toInt() == 0 && b[q + 1].toInt() == 0)) q += 2
            q + 2
        } else (indexOf(b, p, end, 1) ?: return null) + 1
        return if (p < end) Picture(b.copyOfRange(p, end), type) else null
    }

    // ---- FLAC ----

    fun flac(input: DataInputStream): List<Picture> {
        input.readFully(ByteArray(4)) // "fLaC"
        return flacBlocks(input)
    }

    /** The PICTURE blocks of a FLAC stream whose "fLaC" marker has already been consumed. */
    private fun flacBlocks(input: DataInputStream): List<Picture> {
        val out = mutableListOf<Picture>()
        try {
            while (true) {
                val h = input.readUnsignedByte()
                val len = (input.readUnsignedByte() shl 16) or (input.readUnsignedByte() shl 8) or input.readUnsignedByte()
                val block = ByteArray(len).also { input.readFully(it) }
                if (h and 0x7f == 6) flacPicture(block)?.let(out::add)
                if (h and 0x80 != 0) break
            }
        } catch (_: java.io.EOFException) { /* truncated metadata: keep what we read */ }
        return out
    }

    private fun flacPicture(b: ByteArray): Picture? {
        if (b.size < 32) return null
        var p = 4
        p += 4 + int(b, p)            // MIME
        p += 4 + int(b, p)            // description
        p += 16                       // width, height, depth, colours
        val len = int(b, p); p += 4
        return if (len > 0 && p + len <= b.size) Picture(b.copyOfRange(p, p + len), int(b, 0)) else null
    }

    // ---- MP4 ----

    /** Walk the file's top-level boxes, read only the moov box, and pull covers from it. */
    private fun mp4FromStream(input: DataInputStream): List<Picture> {
        while (true) {
            val header = ByteArray(8)
            if (!readFullyOrNull(input, header)) return emptyList()
            var size = int(header, 0).toLong() and 0xffffffffL
            val type = String(header, 4, 4, Charsets.ISO_8859_1)
            var head = 8L
            if (size == 1L) { val ext = ByteArray(8); if (!readFullyOrNull(input, ext)) return emptyList(); size = java.nio.ByteBuffer.wrap(ext).long; head = 16L }
            // size 0 means "to end of file": only worth reading if it is the tags box.
            val bodyLen = if (size == 0L) -1L else size - head
            if (size != 0L && bodyLen < 0) return emptyList()
            if (type == "moov") {
                if (bodyLen in 1..MAX_MOOV_BYTES) {
                    val body = ByteArray(bodyLen.toInt()); input.readFully(body); return mp4Covers(body)
                }
                if (size == 0L) { // extends to EOF; read it but stay bounded
                    val body = readBounded(input, MAX_MOOV_BYTES) ?: return emptyList(); return mp4Covers(body)
                }
                return emptyList()
            }
            if (size == 0L) return emptyList() // a non-moov box runs to EOF; moov isn't ahead
            skipFully(input, bodyLen)
        }
    }

    /** Covers inside a moov box's contents (its direct children). */
    private fun mp4Covers(b: ByteArray): List<Picture> {
        fun boxes(from: Int, to: Int): List<Triple<String, Int, Int>> {
            val list = mutableListOf<Triple<String, Int, Int>>()
            var p = from
            while (p + 8 <= to) {
                var size = int(b, p).toLong() and 0xffffffffL
                val type = String(b, p + 4, 4, Charsets.ISO_8859_1)
                var head = 8
                if (size == 1L && p + 16 <= to) { size = java.nio.ByteBuffer.wrap(b, p + 8, 8).long; head = 16 }
                if (size == 0L) size = (to - p).toLong()
                if (size < head || p + size > to) break
                list += Triple(type, p + head, (p + size).toInt())
                p = (p + size).toInt()
            }
            return list
        }
        fun child(from: Int, to: Int, type: String) = boxes(from, to).firstOrNull { it.first == type }
        val udta = child(0, b.size, "udta") ?: return emptyList()
        val meta = child(udta.second, udta.third, "meta") ?: return emptyList()
        // meta is a full box: four bytes of version and flags before its children.
        val ilst = child(meta.second + 4, meta.third, "ilst") ?: return emptyList()
        val covr = child(ilst.second, ilst.third, "covr") ?: return emptyList()
        return boxes(covr.second, covr.third).filter { it.first == "data" && it.third - it.second > 8 }.mapIndexed { i, d -> Picture(b.copyOfRange(d.second + 8, d.third), if (i == 0) FRONT else BACK) }
    }

    /** The old whole-file entry point, kept for tests and callers that already hold the bytes. */
    fun mp4(b: ByteArray): List<Picture> {
        // Find the moov box in the full buffer, then reuse the moov-body parser.
        var p = 0
        while (p + 8 <= b.size) {
            var size = int(b, p).toLong() and 0xffffffffL
            val type = String(b, p + 4, 4, Charsets.ISO_8859_1)
            var head = 8
            if (size == 1L && p + 16 <= b.size) { size = java.nio.ByteBuffer.wrap(b, p + 8, 8).long; head = 16 }
            if (size == 0L) size = (b.size - p).toLong()
            if (size < head || p + size > b.size) return emptyList()
            if (type == "moov") return mp4Covers(b.copyOfRange(p + head, (p + size).toInt()))
            p = (p + size).toInt()
        }
        return emptyList()
    }

    // ---- helpers ----

    /** Fill the array fully; false at clean end-of-stream (so a truncated box just ends the walk). */
    private fun readFullyOrNull(input: java.io.InputStream, b: ByteArray): Boolean {
        var off = 0
        while (off < b.size) {
            val n = input.read(b, off, b.size - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    /** Skip exactly n bytes, reading past any short skips (skip() may return early on a stream). */
    private fun skipFully(input: java.io.InputStream, n: Long) {
        var left = n
        val scratch = ByteArray(64 * 1024)
        while (left > 0) {
            val s = input.skip(left)
            if (s > 0) { left -= s; continue }
            val r = input.read(scratch, 0, minOf(scratch.size.toLong(), left).toInt())
            if (r < 0) return
            left -= r
        }
    }

    /** Read up to max bytes from a to-EOF box, giving up (null) if it exceeds the bound. */
    private fun readBounded(input: java.io.InputStream, max: Long): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val scratch = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val r = input.read(scratch)
            if (r < 0) break
            total += r
            if (total > max) return null
            out.write(scratch, 0, r)
        }
        return out.toByteArray()
    }

    private fun syncsafe(b: ByteArray, at: Int) = ((b[at].toInt() and 0x7f) shl 21) or ((b[at + 1].toInt() and 0x7f) shl 14) or ((b[at + 2].toInt() and 0x7f) shl 7) or (b[at + 3].toInt() and 0x7f)
    private fun int(b: ByteArray, at: Int) = ((b[at].toInt() and 0xff) shl 24) or ((b[at + 1].toInt() and 0xff) shl 16) or ((b[at + 2].toInt() and 0xff) shl 8) or (b[at + 3].toInt() and 0xff)
    private fun indexOf(b: ByteArray, from: Int, to: Int, width: Int): Int? { var i = from; while (i < to) { if (b[i].toInt() == 0) return i; i += width }; return null }
    private fun unsync(b: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream(b.size)
        var i = 0
        while (i < b.size) { out.write(b[i].toInt()); if (b[i] == 0xFF.toByte() && i + 1 < b.size && b[i + 1].toInt() == 0) i++; i++ }
        return out.toByteArray()
    }
}
