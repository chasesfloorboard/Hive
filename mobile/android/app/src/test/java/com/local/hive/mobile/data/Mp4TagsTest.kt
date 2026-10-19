package com.local.hive.mobile.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer

class Mp4TagsTest {
    private fun box(type: String, body: ByteArray) = ByteBuffer.allocate(8 + body.size).putInt(8 + body.size).put(type.toByteArray(Charsets.ISO_8859_1)).put(body).array()

    /** ftyp, a moov whose one chunk offset points at the audio in the mdat after it, then the mdat. */
    private fun file(audio: ByteArray): ByteArray {
        val ftyp = box("ftyp", "M4A ".toByteArray() + ByteArray(4))
        fun moov(offset: Int) = box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stco", ByteBuffer.allocate(12).putInt(0).putInt(1).putInt(offset).array()))))))
        val moovSize = moov(0).size
        return ftyp + moov(ftyp.size + moovSize + 8) + box("mdat", audio)
    }

    private fun chunkOffset(f: ByteArray): Int {
        val at = String(f, Charsets.ISO_8859_1).indexOf("stco")
        return ByteBuffer.wrap(f, at + 12, 4).int
    }

    @Test fun `tags are written and read back`() {
        val out = Mp4Tags.write(file(byteArrayOf(1, 2, 3, 4)), SongTags("Ænima", "TOOL", album = "Ænima", year = "1996", cover = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 9)))
        val tags = Mp4Tags.read(out)
        assertEquals("Ænima", tags["©nam"])
        assertEquals("TOOL", tags["©ART"])
        assertEquals("1996", tags["©day"])
        assertEquals("<3 bytes>", tags["covr"])
    }

    @Test fun `the audio stays where its chunk offsets say it is`() {
        val audio = byteArrayOf(7, 7, 7, 7)
        val out = Mp4Tags.write(file(audio), SongTags("Title", "Artist"))
        val at = chunkOffset(out)
        assertArrayEquals(audio, out.copyOfRange(at, at + 4))
    }

    @Test fun `tagging twice replaces the old tags`() {
        val once = Mp4Tags.write(file(byteArrayOf(5)), SongTags("Old", "A"))
        val twice = Mp4Tags.write(once, SongTags("New", "B"))
        assertEquals("New", Mp4Tags.read(twice)["©nam"])
        assertEquals(1, String(twice, Charsets.ISO_8859_1).windowed(4).count { it == "udta" })
        val at = chunkOffset(twice)
        assertEquals(5.toByte(), twice[at])
    }
}
