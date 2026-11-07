package com.local.hive.mobile.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files

/**
 * The phone and Hive on the PC must reach the same signature for the same audio, or every tag
 * change would copy the whole file again. These are the bytes of test/fixtures-audio-signature.js,
 * and the signatures test/hive-link.test.js expects from the PC.
 */
class AudioSignatureTest {
    private fun audio(n: Int, seed: Int) = ByteArray(n) { i -> ((i.toLong() * 7 + seed) % 251).toByte() }
    private fun fill(n: Int, v: Int) = ByteArray(n) { v.toByte() }
    private fun cat(vararg parts: ByteArray) = ByteArrayOutputStream().apply { parts.forEach { write(it) } }.toByteArray()
    private fun id3v2(body: Int, v: Int) = cat(byteArrayOf(0x49, 0x44, 0x33, 3, 0, 0, ((body shr 21) and 0x7f).toByte(), ((body shr 14) and 0x7f).toByte(), ((body shr 7) and 0x7f).toByte(), (body and 0x7f).toByte()), fill(body, v))
    private fun id3v1(v: Int) = cat("TAG".toByteArray(), fill(125, v))
    private fun flacBlock(type: Int, len: Int, last: Boolean, v: Int) = cat(byteArrayOf(((if (last) 0x80 else 0) or type).toByte(), (len shr 16).toByte(), (len shr 8).toByte(), len.toByte()), fill(len, v))
    private fun box(type: String, body: ByteArray): ByteArray { val n = 8 + body.size; return cat(byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte()), type.toByteArray(Charsets.ISO_8859_1), body) }
    private fun chunk(id: String, body: ByteArray): ByteArray { val n = body.size; return cat(id.toByteArray(Charsets.ISO_8859_1), byteArrayOf(n.toByte(), (n ushr 8).toByte(), (n ushr 16).toByte(), (n ushr 24).toByte()), body, if (n and 1 == 1) ByteArray(1) else ByteArray(0)) }
    private val flacHead = "fLaC".toByteArray()
    private fun riff(vararg chunks: ByteArray) = cat("RIFF".toByteArray(), ByteArray(4), "WAVE".toByteArray(), *chunks)

    private fun fixtures(): Map<String, Triple<ByteArray, ByteArray, ByteArray>> {
        val big = audio(3 * 1024 * 1024 + 17, 3)
        return mapOf(
            "mp3" to Triple(cat(id3v2(20, 1), audio(3000, 1), id3v1(2)), cat(id3v2(300, 9), audio(3000, 1)), cat(id3v2(20, 1), audio(3000, 2))),
            "bigmp3" to Triple(cat(id3v2(40, 1), big), cat(id3v2(4000, 5), big, id3v1(1)), cat(id3v2(40, 1), big.copyOfRange(0, big.size - 1), byteArrayOf(255.toByte()))),
            "flac" to Triple(
                cat(flacHead, flacBlock(0, 34, false, 1), flacBlock(4, 10, true, 2), audio(2000, 4)),
                cat(flacHead, flacBlock(0, 34, false, 1), flacBlock(4, 90, false, 3), flacBlock(6, 500, true, 4), audio(2000, 4)),
                cat(flacHead, flacBlock(0, 34, false, 1), flacBlock(4, 10, true, 2), audio(2001, 4))),
            "m4a" to Triple(
                cat(box("ftyp", fill(8, 1)), box("moov", fill(12, 2)), box("mdat", audio(2500, 5))),
                cat(box("ftyp", fill(8, 1)), box("mdat", audio(2500, 5)), box("moov", fill(700, 3))),
                cat(box("ftyp", fill(8, 1)), box("moov", fill(12, 2)), box("mdat", audio(2500, 6)))),
            "wav" to Triple(
                riff(chunk("fmt ", fill(16, 1)), chunk("data", audio(1001, 7))),
                riff(chunk("fmt ", fill(16, 1)), chunk("LIST", fill(60, 4)), chunk("data", audio(1001, 7))),
                riff(chunk("fmt ", fill(16, 1)), chunk("data", audio(1001, 8)))),
        )
    }

    private val expected = mapOf(
        "mp3" to ("aa97edbea4b768857aef75824bcd6500" to "523ecc648149cd23aad13196517a39c2"),
        "bigmp3" to ("e73d08479de57fa84488c202ccc1bcae" to "08f58b11c04dd4616f717c0d7daf25d0"),
        "flac" to ("cd68a5aaf20c8d4424f813e5d09829b3" to "eff20654c7e0d8106ce2629674ebee24"),
        "m4a" to ("fbac4b6e8091f7e8c52658171cb4824c" to "d4ca2d60a5fb7928410b189e91e4f258"),
        "wav" to ("8d62692c5dfd3993a7fe2b1d1419f225" to "caa414f697c85b37181a1e1267f54aa7"),
    )

    @Test fun sameSignaturesAsThePc() {
        val dir = Files.createTempDirectory("sig").toFile()
        try {
            for ((kind, files) in fixtures()) {
                val ext = if (kind == "bigmp3") "mp3" else kind
                fun sig(name: String, bytes: ByteArray) = AudioSignature.of(File(dir, "$kind-$name.$ext").apply { writeBytes(bytes) })
                val a = sig("a", files.first); val b = sig("b", files.second); val other = sig("other", files.third)
                assertEquals(kind, expected.getValue(kind).first, a)
                assertEquals("$kind: other tags, same audio", a, b)
                assertEquals("$kind: other audio", expected.getValue(kind).second, other)
            }
            assertNull(AudioSignature.of(File(dir, "x.opus").apply { writeText("OggS...") }))
            assertNull(AudioSignature.of(File(dir, "broken.flac").apply { writeText("not a flac") }))
        } finally { dir.deleteRecursively() }
    }

    @Test fun placeIsWhereTheAudioIs() {
        val dir = Files.createTempDirectory("place").toFile()
        try {
            val (a, b, _) = fixtures().getValue("mp3")
            val fa = File(dir, "a.mp3").apply { writeBytes(a) }; val fb = File(dir, "b.mp3").apply { writeBytes(b) }
            val pa = AudioSignature.place(fa)!!; val pb = AudioSignature.place(fb)!!
            assertEquals(30L, pa.start); assertEquals(3030L, pa.end); assertEquals(a.size.toLong(), pa.size)
            // b's tags around a's audio is b, byte for byte: what the tag sync builds.
            val rebuilt = b.copyOfRange(0, pb.start.toInt()) + a.copyOfRange(pa.start.toInt(), pa.end.toInt()) + b.copyOfRange(pb.end.toInt(), b.size)
            assertTrue(rebuilt.contentEquals(b))
            assertEquals(AudioSignature.sha256(fb), AudioSignature.sha256(File(dir, "r.mp3").apply { writeBytes(rebuilt) }))
        } finally { dir.deleteRecursively() }
    }
}
