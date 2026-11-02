package com.local.hive.mobile.data

import org.jaudiotagger.tag.FieldKey
import org.jaudiotagger.tag.id3.AbstractID3v2Frame
import org.jaudiotagger.tag.id3.ID3v23Tag
import org.jaudiotagger.tag.id3.ID3v24Tag
import org.jaudiotagger.tag.id3.framebody.FrameBodyTXXX
import org.jaudiotagger.tag.mp4.Mp4Tag
import org.jaudiotagger.tag.mp4.field.Mp4TagReverseDnsField
import org.jaudiotagger.tag.vorbiscomment.VorbisCommentTag
import org.jaudiotagger.tag.vorbiscomment.VorbisCommentTagField
import org.jaudiotagger.tag.wav.WavTag
import org.jaudiotagger.audio.wav.WavOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Love in the file, as Hive on the PC reads and writes it (tag_helper.py): "LOVE RATING" = "L". */
class LoveTagTest {
    private fun txxx(tag: ID3v23Tag) = tag.getFields("TXXX").map { ((it as AbstractID3v2Frame).body as FrameBodyTXXX).let { b -> b.description to b.firstTextValue } }

    @Test fun id3LoveIsSetAndTakenOffLeavingOtherCustomTags() {
        val tag = ID3v23Tag()
        tag.setField(FieldKey.TITLE, "Peasantry")
        tag.addField(tag.createFrame("TXXX").apply { body = FrameBodyTXXX(0, "REPLAYGAIN_TRACK_GAIN", "-6.5 dB") })
        assertFalse(LoveTag.read(tag))
        LoveTag.set(tag, true)
        assertTrue(LoveTag.read(tag))
        assertEquals(setOf("REPLAYGAIN_TRACK_GAIN" to "-6.5 dB", "LOVE RATING" to "L"), txxx(tag).toSet())
        // Setting it again doesn't add a second one.
        LoveTag.set(tag, true)
        assertEquals(1, txxx(tag).count { it.first == "LOVE RATING" })
        LoveTag.set(tag, false)
        assertFalse(LoveTag.read(tag))
        assertEquals(listOf("REPLAYGAIN_TRACK_GAIN" to "-6.5 dB"), txxx(tag))
        assertEquals("Peasantry", tag.getFirst(FieldKey.TITLE))
    }

    @Test fun musicBeeSpellingsCountAndAreReplacedByHivesOwn() {
        val tag = ID3v24Tag()
        tag.addField(tag.createFrame("TXXX").apply { body = FrameBodyTXXX(0, "MusicBee/Love Rating", "l") })
        assertTrue(LoveTag.read(tag))
        LoveTag.set(tag, false)
        assertFalse(LoveTag.read(tag))
        assertEquals(0, tag.getFields("TXXX").size)
    }

    @Test fun vorbisCommentLove() {
        val tag = VorbisCommentTag.createNewTag()
        tag.addField(VorbisCommentTagField("LOVE", "L"))
        assertTrue(LoveTag.read(tag))
        LoveTag.set(tag, true)
        assertEquals(listOf("LOVE RATING"), tag.fields.asSequence().map { it.id }.filter { it.contains("LOVE") }.toList())
        LoveTag.set(tag, false)
        assertFalse(LoveTag.read(tag))
    }

    @Test fun mp4FreeformLove() {
        val tag = Mp4Tag()
        assertFalse(LoveTag.read(tag))
        LoveTag.set(tag, true)
        assertTrue(LoveTag.read(tag))
        val field = tag.fields.asSequence().filterIsInstance<Mp4TagReverseDnsField>().single()
        assertEquals("com.apple.iTunes" to "LOVE RATING", field.issuer to field.descriptor)
        LoveTag.set(tag, false)
        assertFalse(LoveTag.read(tag))
    }

    @Test fun wavLoveGoesInItsId3Tag() {
        val tag = WavTag(WavOptions.READ_ID3_ONLY)
        LoveTag.set(tag, true)
        assertTrue(LoveTag.read(tag))
        assertTrue(LoveTag.read(tag.getID3Tag()))
    }
}

/**
 * Real files, checked afterwards by the PC's own reader: set HIVE_LOVE_FILES to a folder of songs
 * (copies) and each gets Loved as the phone writes it. Skipped otherwise.
 */
class LoveTagFilesTest {
    @Test fun writesLoveIntoRealFiles() {
        val dir = System.getenv("HIVE_LOVE_FILES")?.let { java.io.File(it) } ?: return
        for (f in dir.listFiles().orEmpty().filter { it.isFile }) {
            val audio = org.jaudiotagger.audio.AudioFileIO.read(f)
            val tag = audio.tagOrCreateAndSetDefault
            LoveTag.set(tag, f.name.startsWith("x."))
            audio.commit()
            assertEquals(f.name.startsWith("x."), LoveTag.readFile(f))
        }
    }
}
