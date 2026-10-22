package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

class WavTagsTest {
    private fun le(n: Int) = byteArrayOf(n.toByte(), (n shr 8).toByte(), (n shr 16).toByte(), (n shr 24).toByte())
    private fun chunk(id: String, body: ByteArray) = id.toByteArray() + le(body.size) + body + (if (body.size % 2 == 1) byteArrayOf(0) else byteArrayOf())
    private fun wav(vararg chunks: ByteArray): ByteArray {
        val body = chunks.fold("WAVE".toByteArray()) { acc, c -> acc + c }
        return "RIFF".toByteArray() + le(body.size) + body
    }
    private fun syncsafe(n: Int) = byteArrayOf((n shr 21 and 0x7f).toByte(), (n shr 14 and 0x7f).toByte(), (n shr 7 and 0x7f).toByte(), (n and 0x7f).toByte())
    private fun id3(vararg frames: Pair<String, String>): ByteArray {
        val out = ByteArrayOutputStream()
        for ((id, text) in frames) { val b = byteArrayOf(3) + text.toByteArray(Charsets.UTF_8); out.write(id.toByteArray()); out.write(syncsafe(b.size)); out.write(byteArrayOf(0, 0)); out.write(b) }
        val tag = out.toByteArray()
        return "ID3".toByteArray() + byteArrayOf(4, 0, 0) + syncsafe(tag.size) + tag
    }

    @Test fun readsTheId3ChunkAfterTheAudio() {
        val file = wav(chunk("fmt ", ByteArray(16)), chunk("data", ByteArray(4001)), chunk("id3 ", id3("TIT2" to "Battles And Brotherhood", "TPE1" to "3 Inches Of Blood", "TALB" to "Fire Up the Blades", "TRCK" to "1/12", "TDRC" to "2007")))
        val info = WavTags.read(file.inputStream())!!
        assertEquals("Battles And Brotherhood", info.title)
        assertEquals("3 Inches Of Blood", info.artist)
        assertEquals("Fire Up the Blades", info.album)
        assertEquals(1, info.track)
        assertEquals(2007, info.year)
    }

    @Test fun fallsBackToRiffInfo() {
        val info = "INFO".toByteArray() + chunk("INAM", "Song\u0000".toByteArray()) + chunk("IART", "Artist\u0000".toByteArray())
        val got = WavTags.read(wav(chunk("data", ByteArray(10)), chunk("LIST", info)).inputStream())!!
        assertEquals("Song", got.title); assertEquals("Artist", got.artist)
    }

    @Test fun notAWav() = assertNull(WavTags.read(ByteArray(40).inputStream()))

    @Test fun picturesInAWavAreFound() {
        val apic = byteArrayOf(0) + "image/jpeg".toByteArray() + byteArrayOf(0, 3, 0) + byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 7)
        val tag = "APIC".toByteArray() + syncsafe(apic.size) + byteArrayOf(0, 0) + apic
        val id3 = "ID3".toByteArray() + byteArrayOf(4, 0, 0) + syncsafe(tag.size) + tag
        assertEquals(1, EmbeddedPictures.read(wav(chunk("data", ByteArray(8)), chunk("id3 ", id3)).inputStream()).size)
    }

    @Test fun mojibakeIsRepairedAndRealAccentsAreLeftAlone() {
        assertEquals("Dangerous You Shouldn’t Be Here", TextRepair.mojibake("Dangerous You Shouldnâ€™t Be Here"))
        assertEquals("Björk", TextRepair.mojibake("Björk"))
        assertEquals("Sigur Rós", TextRepair.mojibake("Sigur Rós"))
        assertEquals("渋谷", TextRepair.mojibake(String("渋谷".toByteArray(Charsets.UTF_8), Charsets.ISO_8859_1)))
        assertEquals("plain", TextRepair.mojibake("plain"))
    }

    /** A real WAV from the PC library (skipped where it isn't). */
    @Test fun realWav() {
        val f = File(System.getProperty("user.home"), "Music/01. 3 Inches Of Blood - Battles And Brotherhood.wav")
        assumeTrue(f.exists())
        val info = WavTags.read(f.inputStream())!!
        assertEquals("3 Inches Of Blood", info.artist)
        assertEquals(1, EmbeddedPictures.read(f.inputStream()).size.coerceAtMost(1))
    }
}
