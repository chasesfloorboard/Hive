package com.local.hive.mobile.data

import java.io.DataInputStream
import java.io.InputStream

/** What a WAV file is tagged with. Empty fields were not tagged. */
data class WavInfo(
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val albumArtist: String = "",
    val year: Int = 0,
    val genre: String = "",
    val track: Int = 0,
    val disc: Int = 0,
) {
    val isEmpty get() = title.isBlank() && artist.isBlank() && album.isBlank()
}

/**
 * Tags inside WAV files, which Android doesn't read (it shows them as
 * "<unknown>" by their file name): the `id3 ` chunk Hive and most taggers
 * write, else the RIFF `LIST/INFO` one. The audio itself is skipped over, not read.
 */
object WavTags {
    fun read(input: InputStream): WavInfo? {
        val chunks = chunks(DataInputStream(input.buffered()), wanted = setOf("id3 ", "ID3 ", "LIST")) ?: return null
        chunks["id3 "]?.let { fromId3(it) }?.takeIf { !it.isEmpty }?.let { return it }
        return chunks["LIST"]?.let { fromInfo(it) }?.takeIf { !it.isEmpty }
    }

    /** The bytes of each [wanted] chunk (the first of each), the rest skipped; null if not a WAV. */
    fun chunks(input: DataInputStream, wanted: Set<String>): Map<String, ByteArray>? {
        val head = ByteArray(12)
        if (runCatching { input.readFully(head) }.isFailure) return null
        if (String(head, 0, 4, Charsets.ISO_8859_1) != "RIFF" || String(head, 8, 4, Charsets.ISO_8859_1) != "WAVE") return null
        val out = HashMap<String, ByteArray>()
        val id = ByteArray(4)
        while (true) {
            if (runCatching { input.readFully(id) }.isFailure) break
            val size = runCatching { Integer.reverseBytes(input.readInt()).toLong() and 0xffffffffL }.getOrNull() ?: break
            val name = String(id, Charsets.ISO_8859_1)
            // "id3 " and "ID3 " are the same chunk by two spellings.
            val key = if (name.equals("id3 ", ignoreCase = true)) "id3 " else name
            if ((name in wanted || key in wanted) && key !in out && size < 64L * 1024 * 1024) {
                out[key] = ByteArray(size.toInt()).also { input.readFully(it) }
            } else {
                var left = size
                while (left > 0) { val n = input.skip(left); if (n <= 0) { if (input.read() < 0) return out; left-- } else left -= n }
            }
            // Chunks are padded to an even length.
            if (size % 2 == 1L) input.read()
        }
        return out
    }

    private fun fromId3(tag: ByteArray): WavInfo? {
        val frames = runCatching { EmbeddedPictures.id3Frames(DataInputStream(tag.inputStream())) }.getOrNull() ?: return null
        fun text(vararg ids: String): String = ids.firstNotNullOfOrNull { id -> frames.firstOrNull { it.first == id }?.second?.let(::id3Text)?.takeIf { it.isNotBlank() } }.orEmpty()
        return WavInfo(
            title = text("TIT2", "TT2"), artist = text("TPE1", "TP1"), album = text("TALB", "TAL"), albumArtist = text("TPE2", "TP2"),
            year = text("TDRC", "TYER", "TYE").take(4).toIntOrNull() ?: 0, genre = text("TCON", "TCO").replace(Regex("""^\(\d+\)"""), ""),
            track = text("TRCK", "TRK").substringBefore('/').trim().toIntOrNull() ?: 0, disc = text("TPOS", "TPA").substringBefore('/').trim().toIntOrNull() ?: 0,
        )
    }

    /** An ID3 text frame: an encoding byte, then the text (several values split by zeros; the first is kept). */
    fun id3Text(body: ByteArray): String {
        if (body.isEmpty()) return ""
        val raw = body.copyOfRange(1, body.size)
        val text = when (body[0].toInt()) {
            1 -> String(raw, Charsets.UTF_16)
            2 -> String(raw, Charsets.UTF_16BE)
            3 -> String(raw, Charsets.UTF_8)
            else -> String(raw, Charsets.ISO_8859_1)
        }
        return text.split('\u0000').firstOrNull { it.isNotBlank() }.orEmpty().trim()
    }

    private fun fromInfo(list: ByteArray): WavInfo? {
        if (list.size < 4 || String(list, 0, 4, Charsets.ISO_8859_1) != "INFO") return null
        val values = HashMap<String, String>()
        var p = 4
        while (p + 8 <= list.size) {
            val id = String(list, p, 4, Charsets.ISO_8859_1)
            val size = (list[p + 4].toInt() and 0xff) or ((list[p + 5].toInt() and 0xff) shl 8) or ((list[p + 6].toInt() and 0xff) shl 16) or ((list[p + 7].toInt() and 0xff) shl 24)
            if (size < 0 || p + 8 + size > list.size) break
            values[id] = String(list, p + 8, size, Charsets.UTF_8).trim('\u0000', ' ')
            p += 8 + size + (size and 1)
        }
        return WavInfo(
            title = values["INAM"].orEmpty(), artist = values["IART"].orEmpty(), album = values["IPRD"].orEmpty(),
            year = values["ICRD"]?.take(4)?.toIntOrNull() ?: 0, genre = values["IGNR"].orEmpty(),
            track = values["ITRK"]?.substringBefore('/')?.toIntOrNull() ?: values["IPRT"]?.toIntOrNull() ?: 0,
        )
    }
}

/**
 * Tags written as UTF-8 but read as Windows-1252/Latin-1 ("Shouldnâ€™t",
 * "å¼å¸è¸æ°") are turned back into what they say. Only text whose bytes
 * then form valid UTF-8 is changed, so real accents ("Björk") stay as they are.
 */
object TextRepair {
    private const val CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ"

    fun mojibake(text: String): String {
        if (text.none { it.code in 0x80..0xFF || it in CP1252_HIGH }) return text
        val bytes = ByteArray(text.length)
        for ((i, ch) in text.withIndex()) {
            bytes[i] = when {
                ch.code < 0x80 -> ch.code.toByte()
                CP1252_HIGH.indexOf(ch) >= 0 -> (0x80 + CP1252_HIGH.indexOf(ch)).toByte()
                ch.code <= 0xFF -> ch.code.toByte()
                else -> return text
            }
        }
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return runCatching { decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrNull()?.takeIf { it != text } ?: text
    }
}
