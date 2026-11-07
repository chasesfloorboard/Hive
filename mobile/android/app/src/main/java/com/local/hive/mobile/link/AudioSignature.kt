package com.local.hive.mobile.link

import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * The audio's own signature: two copies of a song whose tags differ (a Love, a play count, a
 * new cover) are the same song underneath. It covers the audio alone, so the file mirror can
 * tell a tag change (sent as tags) from new audio (sent as the file). Hive on the PC works it
 * out the same way (audioSignature in app/main/file-mirror.js); both are tested on the same bytes.
 */
object AudioSignature {
    private const val SAMPLE = 1024 * 1024

    /** Where the audio is in the file ([start], [end]) of [size] bytes. */
    data class Place(val start: Long, val end: Long, val size: Long)

    /** The audio's place in [file], or null for a kind without a known layout. */
    fun place(file: File): Place? = runCatching {
        RandomAccessFile(file, "r").use { f ->
            val size = f.length()
            region(f, file.extension.lowercase(), size)?.takeIf { it.second > it.first }?.let { Place(it.first, it.second, size) }
        }
    }.getOrNull()

    /** sha256 of the whole file, as hex. */
    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buf = ByteArray(1 shl 16); while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** sha256 over the audio's length and its first and last megabyte, as 32 hex characters; null for a kind it can't look inside (Ogg, Opus...). */
    fun of(file: File): String? = runCatching {
        RandomAccessFile(file, "r").use { f ->
            val size = f.length()
            val (start, end) = region(f, file.extension.lowercase(), size) ?: return null
            if (end <= start) return null
            val length = end - start
            val md = MessageDigest.getInstance("SHA-256")
            md.update("$length:".toByteArray(Charsets.US_ASCII))
            md.update(readAt(f, start, minOf(SAMPLE.toLong(), length).toInt()))
            md.update(readAt(f, maxOf(start, end - SAMPLE), minOf(SAMPLE.toLong(), length).toInt()))
            md.digest().joinToString("") { "%02x".format(it) }.take(32)
        }
    }.getOrNull()

    private fun readAt(f: RandomAccessFile, position: Long, length: Int): ByteArray {
        if (length <= 0 || position >= f.length()) return ByteArray(0)
        val buf = ByteArray(minOf(length.toLong(), f.length() - position).toInt())
        f.seek(position); f.readFully(buf)
        return buf
    }

    private fun latin(b: ByteArray, from: Int, n: Int) = if (b.size < from + n) "" else String(b, from, n, Charsets.ISO_8859_1)
    private fun u(b: ByteArray, i: Int) = b[i].toInt() and 0xff
    private fun be32(b: ByteArray, i: Int) = (u(b, i).toLong() shl 24) or (u(b, i + 1).toLong() shl 16) or (u(b, i + 2).toLong() shl 8) or u(b, i + 3).toLong()
    private fun le32(b: ByteArray, i: Int) = (u(b, i + 3).toLong() shl 24) or (u(b, i + 2).toLong() shl 16) or (u(b, i + 1).toLong() shl 8) or u(b, i).toLong()

    private fun skipId3v2(f: RandomAccessFile, from: Long, size: Long): Long {
        var at = from
        while (true) {
            val h = readAt(f, at, 10)
            if (h.size < 10 || latin(h, 0, 3) != "ID3") return at
            val tag = ((u(h, 6) and 0x7f) shl 21) or ((u(h, 7) and 0x7f) shl 14) or ((u(h, 8) and 0x7f) shl 7) or (u(h, 9) and 0x7f)
            val next = at + 10 + tag + if (u(h, 5) and 0x10 != 0) 10 else 0
            if (next > size) return at
            at = next
        }
    }

    private fun trimTail(f: RandomAccessFile, start: Long, endIn: Long): Long {
        var end = endIn
        if (end - start >= 128 && latin(readAt(f, end - 128, 3), 0, 3) == "TAG") end -= 128
        if (end - start >= 32) {
            val ft = readAt(f, end - 32, 32)
            if (latin(ft, 0, 8) == "APETAGEX") {
                val tag = le32(ft, 12) + if (le32(ft, 20) and 0x80000000L != 0L) 32 else 0
                if (tag in 1..(end - start)) end -= tag
            }
        }
        return end
    }

    private fun region(f: RandomAccessFile, ext: String, size: Long): Pair<Long, Long>? = when (ext) {
        "mp3", "mp2", "aac" -> skipId3v2(f, 0, size).let { it to trimTail(f, it, size) }
        "flac" -> {
            var at = skipId3v2(f, 0, size)
            if (latin(readAt(f, at, 4), 0, 4) != "fLaC") null else {
                at += 4
                var ok = true
                while (true) {
                    val h = readAt(f, at, 4)
                    if (h.size < 4) { ok = false; break }
                    at += 4 + ((u(h, 1) shl 16) or (u(h, 2) shl 8) or u(h, 3))
                    if (at > size) { ok = false; break }
                    if (u(h, 0) and 0x80 != 0) break
                }
                if (ok) at to trimTail(f, at, size) else null
            }
        }
        "m4a", "m4b", "mp4", "alac" -> {
            var best: Pair<Long, Long>? = null
            var at = 0L
            while (at + 8 <= size) {
                val h = readAt(f, at, 16)
                if (h.size < 8) break
                var box = be32(h, 0); var header = 8
                if (box == 1L) { if (h.size < 16) break; box = (be32(h, 8) shl 32) or be32(h, 12); header = 16 } else if (box == 0L) box = size - at
                if (box < header || at + box > size) break
                if (latin(h, 4, 4) == "mdat" && (best == null || box - header > best.second - best.first)) best = (at + header) to (at + box)
                at += box
            }
            best
        }
        "wav" -> {
            val h = readAt(f, 0, 12)
            if (latin(h, 0, 4) != "RIFF" || latin(h, 8, 4) != "WAVE") null else {
                var at = 12L; var found: Pair<Long, Long>? = null
                while (at + 8 <= size) {
                    val c = readAt(f, at, 8)
                    if (c.size < 8) break
                    val len = le32(c, 4)
                    if (latin(c, 0, 4) == "data") { found = (at + 8) to minOf(size, at + 8 + len); break }
                    at += 8 + len + (len and 1)
                }
                found
            }
        }
        else -> null
    }
}
