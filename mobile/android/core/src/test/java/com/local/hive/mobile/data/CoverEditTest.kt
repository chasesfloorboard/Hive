package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class CoverEditTest {
    private fun pic(name: String, type: Int) = EmbeddedPictures.Picture(name.toByteArray(), type)
    private fun shown(list: List<Pair<ByteArray, Int>>) = list.map { (b, t) -> String(b) + if (t == EmbeddedPictures.BACK) " (back)" else if (t == EmbeddedPictures.FRONT) " (front)" else " ($t)" }

    private val album = listOf(pic("colour", 3), pic("mono", 4))
    private val single = listOf(pic("colour", 3), pic("mono", 4), pic("single", 4), pic("booklet", 0))

    @Test fun anAlbumsBackCoverReplacesEachSongsFirstBackCoverOnly() {
        val edit = CoverEdit(backs = mapOf(0 to "new mono".toByteArray()))
        assertEquals(listOf("colour (front)", "new mono (back)"), shown(edit.applyTo(album)))
        assertEquals(listOf("colour (front)", "new mono (back)", "single (back)", "booklet (0)"), shown(edit.applyTo(single)))
    }

    @Test fun aSongWithoutABackCoverGetsOneAdded() =
        assertEquals(listOf("colour (front)", "mono (back)"), shown(CoverEdit(backs = mapOf(0 to "mono".toByteArray())).applyTo(listOf(pic("colour", 3)))))

    @Test fun aThirdBackCoverIsAddedAfterTheOthers() =
        assertEquals(listOf("colour (front)", "mono (back)", "single (back)"), shown(CoverEdit(backs = mapOf(5 to "single".toByteArray())).applyTo(album)))

    @Test fun aBackCoverCanBeTakenOff() =
        assertEquals(listOf("colour (front)", "single (back)", "booklet (0)"), shown(CoverEdit(backs = mapOf(0 to null)).applyTo(single)))

    @Test fun aNewFrontCoverKeepsTheBackCovers() {
        assertEquals(listOf("new (front)", "mono (back)"), shown(CoverEdit(front = "new".toByteArray()).applyTo(album)))
        assertEquals(listOf("new (front)"), shown(CoverEdit(front = "new".toByteArray()).applyTo(emptyList())))
    }

    @Test fun itunesSpacePaddedSortFramesDoNotDropFollowingId3Frames() {
        val f = java.io.File.createTempFile("hive-id3-", ".mp3")
        try {
            fun frame(id: String, text: String): ByteArray {
                val body = byteArrayOf(0) + text.toByteArray(Charsets.ISO_8859_1)
                val size = java.nio.ByteBuffer.allocate(4).putInt(body.size).array()
                return id.toByteArray(Charsets.ISO_8859_1) + size + byteArrayOf(0, 0) + body
            }
            val frames = frame("TS2 ", "JPEGMAFIA x Freaky") +
                frame("TST ", "BUMBOPUSSYRASCLAT") +
                frame("TALB", "The 2nd Amendment") +
                frame("TPE1", "JPEGMAFIA x Freaky") +
                frame("TIT2", "BUMBOPUSSYRASCLAT")
            val s = frames.size
            val header = byteArrayOf(
                'I'.code.toByte(), 'D'.code.toByte(), '3'.code.toByte(), 3, 0, 0,
                ((s shr 21) and 0x7f).toByte(), ((s shr 14) and 0x7f).toByte(), ((s shr 7) and 0x7f).toByte(), (s and 0x7f).toByte(),
            )
            // Minimal valid MPEG-1 Layer 3 frame (128 kbps, 44.1 kHz, 417 bytes) repeated so jaudiotagger reads an audio header.
            val mp3Frame = ByteArray(417).also { it[0] = 0xFF.toByte(); it[1] = 0xFB.toByte(); it[2] = 0x90.toByte() }
            f.writeBytes(header + frames + mp3Frame + mp3Frame)

            TagWriter.repairId3FrameIds(f)
            val audio = org.jaudiotagger.audio.AudioFileIO.read(f)
            assertEquals("BUMBOPUSSYRASCLAT", audio.tag.getFirst(org.jaudiotagger.tag.FieldKey.TITLE))
            assertEquals("JPEGMAFIA x Freaky", audio.tag.getFirst(org.jaudiotagger.tag.FieldKey.ARTIST))
            assertEquals("The 2nd Amendment", audio.tag.getFirst(org.jaudiotagger.tag.FieldKey.ALBUM))
        } finally {
            f.delete()
        }
    }
}
