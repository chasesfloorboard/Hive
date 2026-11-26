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

    private fun apic(data: ByteArray, utf16: Boolean = false, type: Int = 3): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(if (utf16) 1 else 0); out.write("image/jpeg".toByteArray()); out.write(0); out.write(type)
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

    @Test fun readsMp4CoverWhenMoovSitsAfterTheAudioWithoutBufferingIt() {
        fun box(type: String, body: ByteArray) = be(body.size + 8) + type.toByteArray() + body
        fun data(b: ByteArray) = box("data", be(13) + be(0) + b)
        val covr = box("covr", data(front) + data(back))
        val moov = box("moov", box("udta", box("meta", be(0) + box("ilst", covr))))
        // mdat (the audio) comes first and is far larger than any cover; the reader must
        // skip it, not pull it into RAM, before reaching the moov tags at the end.
        val mdat = box("mdat", ByteArray(4 * 1024 * 1024))
        val file = box("ftyp", "M4A ".toByteArray() + be(0)) + mdat + moov
        val got = EmbeddedPictures.read(file.inputStream())
        assertEquals(2, got.size)
        assertArrayEquals(front, got[0])
        assertArrayEquals(back, got[1])
    }

    @Test fun aCorruptId3SizeDoesNotAllocateHugely() {
        // A header claiming a ~256 MB tag (max syncsafe) must be refused, not allocated.
        val header = "ID3".toByteArray() + byteArrayOf(3, 0, 0) + syncsafe(0x0FFFFFFF)
        val got = EmbeddedPictures.read((header + ByteArray(16)).inputStream())
        assertEquals(0, got.size)
    }

    @Test fun knowsTheFrontFromTheBackCovers() {
        val mp3 = id3(3, listOf("APIC" to apic(front), "APIC" to apic(back, utf16 = true, type = 4), "APIC" to apic(back, type = 4)))
        assertEquals(listOf(3, 4, 4), EmbeddedPictures.readTyped(mp3.inputStream()).map { it.type })
        fun block(type: Int, last: Boolean, body: ByteArray) = byteArrayOf(((if (last) 0x80 else 0) or type).toByte()) + be(body.size, 3) + body
        fun pic(data: ByteArray, type: Int) = be(type) + be(10) + "image/jpeg".toByteArray() + be(0) + ByteArray(16) + be(data.size) + data
        val flac = "fLaC".toByteArray() + block(0, false, ByteArray(34)) + block(6, false, pic(front, 3)) + block(6, true, pic(back, 4))
        assertEquals(listOf(false, true), EmbeddedPictures.readTyped(flac.inputStream()).map { it.back })
    }

    @Test fun bestBytesPrefersTheFrontCoverOverAPrecedingNonFrontPicture() {
        val other = EmbeddedPictures.Picture(back, 0)
        val cover = EmbeddedPictures.Picture(front, EmbeddedPictures.FRONT)
        assertArrayEquals(front, EmbeddedPictures.bestBytes(listOf(other, cover)))
    }

    @Test fun bestBytesFallsBackToTheFirstPictureWhenNoneIsMarkedFront() {
        val first = EmbeddedPictures.Picture(back, 0)
        val second = EmbeddedPictures.Picture(front, EmbeddedPictures.BACK)
        assertArrayEquals(back, EmbeddedPictures.bestBytes(listOf(first, second)))
        assertEquals(null, EmbeddedPictures.bestBytes(emptyList()))
    }

    @Test fun readsThreeCoversInId3v23AndOrdersFrontFirst() {
        val cover1 = byteArrayOf(1, 2, 3, 4)
        val cover2 = byteArrayOf(5, 6, 7, 8)
        val cover3 = byteArrayOf(9, 10, 11, 12)
        val mp3 = id3(3, listOf(
            "TIT2" to byteArrayOf(0, 'U'.code.toByte()),
            "APIC" to apic(cover1, type = 0),
            "APIC" to apic(cover2, type = 3),
            "APIC" to apic(cover3, type = 0)
        ))
        val typed = EmbeddedPictures.readTyped(mp3.inputStream())
        assertEquals(3, typed.size)
        assertEquals(listOf(0, 3, 0), typed.map { it.type })
        assertArrayEquals(cover2, EmbeddedPictures.bestBytes(typed))
    }

    @Test fun aFileWithoutTagsHasNone() = assertEquals(0, EmbeddedPictures.read(ByteArray(64).inputStream()).size)

    @Test fun readsCoverFromAFlacThatHasALeadingId3Tag() {
        // Some taggers prepend an ID3v2 tag to a FLAC; the cover sits in the FLAC PICTURE
        // block after the tag, not an APIC. The reader must skip the tag and read the FLAC,
        // the way the PC's mutagen does, or a whole album shows blank covers.
        fun block(type: Int, last: Boolean, body: ByteArray) = byteArrayOf(((if (last) 0x80 else 0) or type).toByte()) + be(body.size, 3) + body
        fun pic(data: ByteArray) = be(3) + be(10) + "image/jpeg".toByteArray() + be(0) + ByteArray(16) + be(data.size) + data
        // An ID3v2.3 tag with a title frame and no APIC, its size counting its whole body
        // (as real taggers write it), so the FLAC stream begins exactly after it.
        val frame = "TIT2".toByteArray() + be(5) + byteArrayOf(0, 0) + byteArrayOf(0) + "Song".toByteArray()
        val id3Tag = "ID3".toByteArray() + byteArrayOf(3, 0, 0) + syncsafe(frame.size) + frame
        val flac = "fLaC".toByteArray() + block(0, false, ByteArray(34)) + block(6, true, pic(front))
        val got = EmbeddedPictures.read((id3Tag + flac).inputStream())
        assertEquals(1, got.size)
        assertArrayEquals(front, got[0])
    }

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

    @Test fun bandcampTrackWithOwnCoverRotatesAlbumCoverFirstThenEmbeddedCover() {
        val albumArt = byteArrayOf(1, 2, 3, 4)
        val songArt = byteArrayOf(9, 8, 7, 6)
        val sameBytes: (ByteArray, ByteArray) -> Boolean = { a, b -> a.contentEquals(b) }

        // A Bandcamp track whose embedded cover differs from the album cover rotates [albumArt, songArt].
        val rotating = EmbeddedPictures.resolveTrackRotation(albumArt, listOf(songArt), same = sameBytes)
        assertEquals(2, rotating.size)
        assertArrayEquals(albumArt, rotating[0])
        assertArrayEquals(songArt, rotating[1])

        // A sibling track whose embedded cover matches the album cover does NOT rotate.
        val normal = EmbeddedPictures.resolveTrackRotation(albumArt, listOf(albumArt.copyOf()), same = sameBytes)
        assertEquals(0, normal.size)

        // A track that already embeds [albumArt, backArt, singleArt] (like Charli XCX brat) keeps all 3 without duplicating albumArt.
        val backArt = byteArrayOf(5, 5, 5, 5)
        val multi = EmbeddedPictures.resolveTrackRotation(albumArt, listOf(albumArt.copyOf(), backArt, songArt), same = sameBytes)
        assertEquals(3, multi.size)
        assertArrayEquals(albumArt, multi[0])
        assertArrayEquals(backArt, multi[1])
        assertArrayEquals(songArt, multi[2])

        // A coverless track on an album does not rotate.
        assertEquals(0, EmbeddedPictures.resolveTrackRotation(albumArt, emptyList(), same = sameBytes).size)
    }

    @Test fun majorityCoverSelectorPicksSharedAlbumCoverEvenWhenTrackOneHasSingleArt() {
        val albumArt = byteArrayOf(1, 1, 1, 1)
        val single1 = byteArrayOf(2, 2, 2, 2)
        val single2 = byteArrayOf(3, 3, 3, 3)
        val sameBytes: (ByteArray, ByteArray) -> Boolean = { a, b -> a.contentEquals(b) }

        // Track 1 has its own single cover, Tracks 2..5 share albumArt -> picks albumArt.
        val picked = AlbumArtFetcher.pickMajorityCover(
            listOf(single1, albumArt, albumArt, single2, albumArt, albumArt),
            same = sameBytes,
        )
        assertArrayEquals(albumArt, picked)

        // Normal album: Tracks 1 & 2 share albumArt -> picks albumArt immediately.
        val normal = AlbumArtFetcher.pickMajorityCover(
            listOf(albumArt, albumArt, single1, albumArt),
            same = sameBytes,
        )
        assertArrayEquals(albumArt, normal)
    }
}
