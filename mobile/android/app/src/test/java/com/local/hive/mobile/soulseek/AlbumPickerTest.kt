package com.local.hive.mobile.soulseek

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlbumPickerTest {
    private val clppng = listOf(
        WantedTrack("Intro", 46_000), WantedTrack("Body & Blood", 193_000), WantedTrack("Work Work (feat. Cocc Pistol Cree)", 226_000),
        WantedTrack("Summertime (feat. Gangsta Boo)", 236_000), WantedTrack("Inside Out", 182_000),
    )
    private fun folder(root: String, ext: String, bitrate: Int, depth: Int = 0, names: List<String> = listOf("01 - Intro", "02 - Body & Blood", "03 - Work Work", "04 - Summertime", "05 - Inside Out"), lengths: List<Int> = listOf(46, 193, 226, 236, 182)) =
        names.mapIndexed { i, n -> SharedFile("$root\\$n.$ext", 10_000_000, bitrate = bitrate, lengthSec = lengths[i], bitDepth = depth) } + SharedFile("$root\\cover.jpg", 90_000)

    @Test fun picksTheCompleteFlacFolderFromAPeerWithAFreeSlot() {
        val results = listOf(
            SearchResult("slowflac", 1, folder("music\\clipping\\CLPPNG [FLAC]", "flac", 900, 16), freeSlot = false, speed = 50_000, queue = 40),
            SearchResult("fastflac", 1, folder("share\\clipping. - CLPPNG (2014)", "flac", 900, 16), freeSlot = true, speed = 4_000_000, queue = 0),
            SearchResult("mp3", 1, folder("mp3\\clipping. - CLPPNG", "mp3", 320), freeSlot = true, speed = 4_000_000, queue = 0),
            SearchResult("partial", 1, folder("x\\CLPPNG", "flac", 900, 16).take(2), freeSlot = true, speed = 9_000_000, queue = 0),
        )
        val picks = AlbumPicker.candidates("clipping.", clppng, results)
        // A queued FLAC loses to an MP3 320 that can start now.
        assertEquals(listOf("fastflac", "mp3", "slowflac"), picks.map { it.user }.take(3))
        assertTrue("a folder with two of five songs is left out", picks.none { it.user == "partial" })
        assertEquals(5, picks.first().files.size)
        assertEquals("share\\clipping. - CLPPNG (2014)\\03 - Work Work.flac", picks.first().files[2]!!.path)
        assertEquals("mp3", AlbumPicker.candidates("clipping.", clppng, results, Quality.Mp3).first().user)
    }

    @Test fun countsDiscFoldersAsOneAlbumAndReadsArtistPrefixedNames() {
        val files = listOf(
            SharedFile("a\\clipping. - CLPPNG\\CD1\\clipping. - Intro.mp3", 1, 320, 46), SharedFile("a\\clipping. - CLPPNG\\CD1\\clipping. - Body & Blood.mp3", 1, 320, 193),
            SharedFile("a\\clipping. - CLPPNG\\CD2\\1-03 Work Work.mp3", 1, 320, 226), SharedFile("a\\clipping. - CLPPNG\\CD2\\1-04 Summertime.mp3", 1, 320, 236),
            SharedFile("a\\clipping. - CLPPNG\\CD2\\05. Inside Out.mp3", 1, 320, 182),
        )
        val pick = AlbumPicker.candidates("clipping.", clppng, listOf(SearchResult("u", 1, files, true, 1, 0))).single()
        assertEquals(5, pick.files.size)
    }

    @Test fun aSameNamedSongOfTheWrongLengthIsNotTaken() {
        val wanted = listOf(WantedTrack("Nanana", 201_000))
        val results = listOf(SearchResult("u", 1, listOf(SharedFile("x\\Peggy Gou - Nanana (Extended Mix).mp3", 1, 320, 380), SharedFile("y\\Peggy Gou - (It Goes Like) Nanana.mp3", 1, 320, 202)), true, 1, 0))
        val pick = AlbumPicker.candidates("Peggy Gou", wanted, results).first()
        assertEquals("y\\Peggy Gou - (It Goes Like) Nanana.mp3", pick.files[0]!!.path)
    }

    @Test fun titlesComeFromFileNames() {
        assertEquals("Body & Blood", AlbumPicker.titleOf("02 - Body & Blood.flac", "clipping."))
        assertEquals("Body & Blood", AlbumPicker.titleOf("clipping. - Body & Blood.mp3", "clipping."))
        assertEquals("Work Work", AlbumPicker.titleOf("1-03 Work Work.mp3", "clipping."))
        assertEquals("Inside Out", AlbumPicker.titleOf("05. Inside Out.mp3", "clipping."))
    }
}
