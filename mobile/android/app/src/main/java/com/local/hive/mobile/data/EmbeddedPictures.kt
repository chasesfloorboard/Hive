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
 * cover carousel: MP3 (ID3v2.2–2.4 APIC/PIC), FLAC (PICTURE blocks) and M4A
 * (each `covr` image). Android's own reader gives only the first. Pictures
 * are kept per song in the cache, distinct by content, in file order.
 */
object EmbeddedPictures {
    /** The song's pictures when it has two or more distinct ones; otherwise empty. */
    suspend fun forTrack(context: Context, trackId: Long): List<File> = withContext(Dispatchers.IO) {
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

    /** The pictures in a song file's tags, in order. */
    fun read(input: InputStream): List<ByteArray> {
        val stream = java.io.BufferedInputStream(input, 64 * 1024)
        stream.mark(16)
        val head = ByteArray(4).also { if (stream.read(it) < 4) return emptyList() }
        stream.reset()
        return when {
            head[0] == 'I'.code.toByte() && head[1] == 'D'.code.toByte() && head[2] == '3'.code.toByte() -> id3(DataInputStream(stream))
            String(head, Charsets.ISO_8859_1) == "fLaC" -> flac(DataInputStream(stream))
            // MP4: the tags (moov) may sit after the audio, so the whole file is read.
            isMp4(stream) -> mp4(stream.readBytes())
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

    fun id3(input: DataInputStream): List<ByteArray> {
        val header = ByteArray(10).also { input.readFully(it) }
        val version = header[3].toInt()
        val flags = header[5].toInt()
        var tag = ByteArray(syncsafe(header, 6)).also { input.readFully(it) }
        // A whole-tag unsynchronisation (v2.2/2.3) is undone before reading frames.
        if (flags and 0x80 != 0 && version < 4) tag = unsync(tag)
        var pos = 0
        // An extended header (v2.3/2.4) is skipped.
        if (flags and 0x40 != 0 && version >= 3 && tag.size >= 4) pos += if (version == 4) syncsafe(tag, 0) else int(tag, 0) + 4
        val out = mutableListOf<ByteArray>()
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
            if (id == "APIC" || id == "PIC") picture(tag, body, size, version == 2)?.let(out::add)
            pos = body + size
        }
        return out
    }

    /** An APIC (or v2.2 PIC) body: encoding, MIME (or 3-letter format), type, description, data. */
    private fun picture(b: ByteArray, from: Int, size: Int, v22: Boolean): ByteArray? {
        val end = from + size
        val encoding = b[from].toInt()
        var p = from + 1
        p = if (v22) p + 3 else (indexOf(b, p, end, 1) ?: return null) + 1
        p += 1 // picture type
        // The description ends with one zero byte, or two for UTF-16.
        p = if (encoding == 1 || encoding == 2) {
            var q = p
            while (q + 1 < end && !(b[q].toInt() == 0 && b[q + 1].toInt() == 0)) q += 2
            q + 2
        } else (indexOf(b, p, end, 1) ?: return null) + 1
        return if (p < end) b.copyOfRange(p, end) else null
    }

    // ---- FLAC ----

    fun flac(input: DataInputStream): List<ByteArray> {
        input.readFully(ByteArray(4))
        val out = mutableListOf<ByteArray>()
        while (true) {
            val h = input.readUnsignedByte()
            val len = (input.readUnsignedByte() shl 16) or (input.readUnsignedByte() shl 8) or input.readUnsignedByte()
            val block = ByteArray(len).also { input.readFully(it) }
            if (h and 0x7f == 6) flacPicture(block)?.let(out::add)
            if (h and 0x80 != 0) break
        }
        return out
    }

    private fun flacPicture(b: ByteArray): ByteArray? {
        var p = 4
        p += 4 + int(b, p)            // MIME
        p += 4 + int(b, p)            // description
        p += 16                       // width, height, depth, colours
        val len = int(b, p); p += 4
        return if (len > 0 && p + len <= b.size) b.copyOfRange(p, p + len) else null
    }

    // ---- MP4 ----

    fun mp4(b: ByteArray): List<ByteArray> {
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
        val moov = child(0, b.size, "moov") ?: return emptyList()
        val udta = child(moov.second, moov.third, "udta") ?: return emptyList()
        val meta = child(udta.second, udta.third, "meta") ?: return emptyList()
        // meta is a full box: four bytes of version and flags before its children.
        val ilst = child(meta.second + 4, meta.third, "ilst") ?: return emptyList()
        val covr = child(ilst.second, ilst.third, "covr") ?: return emptyList()
        return boxes(covr.second, covr.third).filter { it.first == "data" && it.third - it.second > 8 }.map { b.copyOfRange(it.second + 8, it.third) }
    }

    // ---- helpers ----

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
