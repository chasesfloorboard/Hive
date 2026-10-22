package com.local.hive.mobile.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File

class EmbeddedPicturesTest {
    private val front = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3)
    private val back = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 9, 8)

    private fun be(n: Int, bytes: Int = 4) = ByteArray(bytes) { i -> (n shr (8 * (bytes - 1 - i))).toByte() }
    private fun syncsafe(n: Int) = byteArrayOf((n shr 21 and 0x7f).toByte(), (n shr 14 and 0x7f).toByte(), (n shr 7 and 0x7f).toByte(), (n and 0x7f).toByte())

    private fun id3(version: Int, frames: List<Pair<String, ByteArray>>): ByteArray {
        val body = ByteArrayOutputStream()
        for ((id, data) in frames) {
            body.write(id.toByteArray()); body.write(if (version == 4) syncsafe(data.size) else be(data.size)); body.write(byteArrayOf(0, 0)); body.write(data)
        }
        val tag = body.toByteArray()
        return "ID3".toByteArray() + byteArrayOf(version.toByte(), 0, 0) + syncsafe(tag.size) + tag + ByteArray(32)
    }

    private fun apic(data: ByteArray, utf16: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(if (utf16) 1 else 0); out.write("image/jpeg".toByteArray()); out.write(0); out.write(3)
        if (utf16) out.write(byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 'x'.code.toByte(), 0, 0, 0)) else { out.write("cover".toByteArray()); out.write(0) }
        out.write(data)
        return out.toByteArray()
    }

    @Test fun readsEveryApicInId3v23AndV24() {
        for (v in listOf(3, 4)) {
            val file = id3(v, listOf("TIT2" to byteArrayOf(0, 'a'.code.toByte()), "APIC" to apic(front), "APIC" to apic(back, utf16 = true)))
            val got = EmbeddedPictures.read(file.inputStream())
            assertEquals(2, got.size)
            assertArrayEquals(front, got[0]); assertArrayEquals(back, got[1])
        }
    }

    @Test fun readsFlacPictureBlocks() {
        fun block(type: Int, last: Boolean, body: ByteArray) = byteArrayOf(((if (last) 0x80 else 0) or type).toByte()) + be(body.size, 3) + body
        fun pic(data: ByteArray) = be(3) + be(10) + "image/jpeg".toByteArray() + be(0) + ByteArray(16) + be(data.size) + data
        val file = "fLaC".toByteArray() + block(0, false, ByteArray(34)) + block(6, false, pic(front)) + block(6, true, pic(back)) + ByteArray(16)
        val got = EmbeddedPictures.read(file.inputStream())
        assertEquals(2, got.size)
        assertArrayEquals(back, got[1])
    }

    @Test fun readsEachMp4CovrImage() {
        fun box(type: String, body: ByteArray) = be(body.size + 8) + type.toByteArray() + body
        fun data(b: ByteArray) = box("data", be(13) + be(0) + b)
        val covr = box("covr", data(front) + data(back))
        val file = box("ftyp", "M4A ".toByteArray() + be(0)) + box("moov", box("udta", box("meta", be(0) + box("ilst", covr))))
        val got = EmbeddedPictures.read(file.inputStream())
        assertEquals(2, got.size)
        assertArrayEquals(front, got[0])
    }

    @Test fun aFileWithoutTagsHasNone() = assertEquals(0, EmbeddedPictures.read(ByteArray(64).inputStream()).size)

    /** Real songs from the PC library with two covers each (skipped where they aren't). */
    @Test fun realFilesWithTwoCovers() {
        val files = listOf("#1 \$tunna.mp3", "01 Black Blood and The Chocolate Pickles_Black Blood (In the Mississippi Mud).flac", "01 Prelude 3. 0.m4a")
            .map { File(System.getProperty("user.home"), "Music/$it") }.filter { it.exists() }
        assumeTrue(files.isNotEmpty())
        for (f in files) assertEquals(f.name, 2, EmbeddedPictures.read(f.inputStream()).distinctBy { it.contentHashCode() }.size)
    }

    /** Optional audit: HIVE_PICTURE_AUDIT names a "path<TAB>count" list (Hive on the PC's counts) to compare against. */
    @Test fun auditAgainstThePc() {
        val list = System.getenv("HIVE_PICTURE_AUDIT")?.let(::File)?.takeIf { it.exists() }
        assumeTrue(list != null)
        val rows = list!!.readLines().filter { it.isNotBlank() }.map { it.split('\t') }
        val wrong = rows.filter { (path, count) -> File(path).exists() && EmbeddedPictures.read(File(path).inputStream()).distinctBy { it.contentHashCode() }.size != count.toInt() }
        println("picture audit: ${rows.size - wrong.size} of ${rows.size} match; e.g. ${wrong.take(5).map { it[0].substringAfterLast('/') + " (pc " + it[1] + ")" }}")
    }
}
