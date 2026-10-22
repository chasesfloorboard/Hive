package com.local.hive.mobile.data

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** What a saved song is tagged with, as iTunes-style MP4 atoms. */
data class SongTags(
    val title: String,
    val artist: String,
    val album: String = "",
    val albumArtist: String = "",
    val year: String = "",
    val track: Int = 0,
    val cover: ByteArray? = null,
)

/**
 * Tags an .m4a in place of any it had: moov › udta › meta › ilst with the
 * title, artists, album, year, track and cover. Chunk offsets (stco/co64)
 * that point past the grown moov are moved along with the media.
 */
object Mp4Tags {
    fun write(file: ByteArray, tags: SongTags): ByteArray {
        val top = children(file, 0, file.size)
        val moov = top.firstOrNull { it.type == "moov" } ?: throw IllegalArgumentException("Not an MP4 file: no moov.")
        // The new moov: its children without any old udta, then ours.
        val kept = children(file, moov.body, moov.end).filter { it.type != "udta" }
        val body = ByteArrayOutputStream()
        kept.forEach { body.write(file, it.start, it.size) }
        body.write(udta(tags))
        val newMoov = box("moov", body.toByteArray())
        val delta = newMoov.size - moov.size
        // Media stored after moov moves by delta; offsets into it must follow.
        if (delta != 0 && top.any { it.type == "mdat" && it.start > moov.start }) shiftChunkOffsets(newMoov, moov.end.toLong(), delta)
        val out = ByteArrayOutputStream(file.size + newMoov.size)
        out.write(file, 0, moov.start)
        out.write(newMoov)
        out.write(file, moov.end, file.size - moov.end)
        return out.toByteArray()
    }

    /** Reads the text atoms back (for tests and checks): "©nam" → title, … */
    fun read(file: ByteArray): Map<String, String> {
        val moov = children(file, 0, file.size).firstOrNull { it.type == "moov" } ?: return emptyMap()
        val udta = children(file, moov.body, moov.end).firstOrNull { it.type == "udta" } ?: return emptyMap()
        val meta = children(file, udta.body, udta.end).firstOrNull { it.type == "meta" } ?: return emptyMap()
        val ilst = children(file, meta.body + 4, meta.end).firstOrNull { it.type == "ilst" } ?: return emptyMap()
        return children(file, ilst.body, ilst.end).associate { item ->
            val data = children(file, item.body, item.end).firstOrNull { it.type == "data" }
            item.type to (data?.let { val kind = ByteBuffer.wrap(file, it.body, 4).int and 0xFFFFFF; if (kind == 1) String(file, it.body + 8, it.end - it.body - 8, Charsets.UTF_8) else "<${it.end - it.body - 8} bytes>" } ?: "")
        }
    }

    private class Box(val type: String, val start: Int, val size: Int, val header: Int) {
        val body get() = start + header
        val end get() = start + size
    }

    private fun children(b: ByteArray, from: Int, to: Int): List<Box> {
        val out = ArrayList<Box>()
        var at = from
        while (at + 8 <= to) {
            var size = ByteBuffer.wrap(b, at, 4).int.toLong() and 0xFFFFFFFFL
            val type = String(b, at + 4, 4, Charsets.ISO_8859_1)
            var header = 8
            if (size == 1L && at + 16 <= to) { size = ByteBuffer.wrap(b, at + 8, 8).long; header = 16 }
            if (size == 0L) size = (to - at).toLong()
            if (size < header || at + size > to) break
            out += Box(type, at, size.toInt(), header)
            at += size.toInt()
        }
        return out
    }

    private fun shiftChunkOffsets(moov: ByteArray, after: Long, delta: Int) {
        fun walk(from: Int, to: Int) {
            for (c in children(moov, from, to)) when (c.type) {
                "trak", "mdia", "minf", "stbl" -> walk(c.body, c.end)
                "stco" -> {
                    val n = ByteBuffer.wrap(moov, c.body + 4, 4).int
                    for (i in 0 until n) {
                        val p = c.body + 8 + i * 4
                        val v = ByteBuffer.wrap(moov, p, 4).int.toLong() and 0xFFFFFFFFL
                        if (v >= after) ByteBuffer.wrap(moov, p, 4).putInt((v + delta).toInt())
                    }
                }
                "co64" -> {
                    val n = ByteBuffer.wrap(moov, c.body + 4, 4).int
                    for (i in 0 until n) {
                        val p = c.body + 8 + i * 8
                        val v = ByteBuffer.wrap(moov, p, 8).long
                        if (v >= after) ByteBuffer.wrap(moov, p, 8).putLong(v + delta)
                    }
                }
            }
        }
        walk(8, moov.size)
    }

    private fun udta(t: SongTags): ByteArray {
        val items = ByteArrayOutputStream()
        fun text(type: String, value: String) { if (value.isNotBlank()) items.write(box(type, data(1, value.toByteArray(Charsets.UTF_8)))) }
        text("©nam", t.title); text("©ART", t.artist); text("©alb", t.album); text("aART", t.albumArtist); text("©day", t.year)
        if (t.track > 0) items.write(box("trkn", data(0, byteArrayOf(0, 0, (t.track shr 8).toByte(), t.track.toByte(), 0, 0, 0, 0))))
        t.cover?.let { c -> items.write(box("covr", data(if (c.size > 3 && c[0] == 0x89.toByte() && c[1] == 'P'.code.toByte()) 14 else 13, c))) }
        val hdlr = box("hdlr", ByteArray(4) + ByteArray(4) + "mdirappl".toByteArray(Charsets.ISO_8859_1) + ByteArray(9))
        val meta = box("meta", ByteArray(4) + hdlr + box("ilst", items.toByteArray()))
        return box("udta", meta)
    }

    /** A 'data' atom: its kind (1 text, 13 JPEG, 14 PNG, 0 binary), a zero locale, then the value. */
    private fun data(kind: Int, value: ByteArray) = box("data", ByteBuffer.allocate(8).putInt(kind).putInt(0).array() + value)

    private fun box(type: String, body: ByteArray): ByteArray =
        ByteBuffer.allocate(8 + body.size).putInt(8 + body.size).put(type.toByteArray(Charsets.ISO_8859_1)).put(body).array()
}
