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

    @Test fun withMp3ChosenAnMp3WinsOverAFasterFlacAndFlacIsOnlyALastResort() {
        val fastFlac = SearchResult("fastflac", 1, folder("share\\clipping. - CLPPNG (2014)", "flac", 900, 16), freeSlot = true, speed = 9_000_000, queue = 0)
        val slowMp3 = SearchResult("slowmp3", 1, folder("mp3\\clipping. - CLPPNG", "mp3", 320), freeSlot = false, speed = 20_000, queue = 50)
        assertEquals("slowmp3", AlbumPicker.candidates("clipping.", clppng, listOf(fastFlac, slowMp3), Quality.Mp3).first().user)
        assertEquals("fastflac", AlbumPicker.candidates("clipping.", clppng, listOf(fastFlac), Quality.Mp3).first().user)
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

    @Test fun instrumentalFolderIsDisqualifiedForStandardAlbum() {
        val results = listOf(
            SearchResult("instPeer", 1, folder("share\\clipping. - CLPPNG (Instrumentals)", "flac", 900, 16), freeSlot = true, speed = 10_000_000, queue = 0),
            SearchResult("vocalPeer", 1, folder("share\\clipping. - CLPPNG", "flac", 900, 16), freeSlot = true, speed = 1_000_000, queue = 0),
        )
        val picks = AlbumPicker.candidates("clipping.", clppng, results)
        assertEquals(1, picks.size)
        assertEquals("vocalPeer", picks.first().user)
    }

    @Test fun instrumentalFileDoesNotMatchVocalTrack() {
        val wanted = listOf(WantedTrack("All Eyes On Me", 231_000))
        val files = listOf(
            SharedFile("share\\Clipse\\09 - All Eyes On Me (Instrumental).mp3", 1, 320, 231),
            SharedFile("share\\Clipse\\09 - All Eyes On Me (feat. Keri Hilson).mp3", 1, 320, 231),
        )
        val matched = AlbumPicker.match("Clipse", wanted, files)
        assertEquals(1, matched.size)
        assertEquals("share\\Clipse\\09 - All Eyes On Me (feat. Keri Hilson).mp3", matched[0]!!.path)
    }

    @Test fun instrumentalTrackMatchesWhenExplicitlyWanted() {
        val wanted = listOf(WantedTrack("All Eyes On Me (Instrumental)", 231_000))
        val files = listOf(
            SharedFile("share\\Clipse\\09 - All Eyes On Me (Instrumental).mp3", 1, 320, 231),
            SharedFile("share\\Clipse\\09 - All Eyes On Me (feat. Keri Hilson).mp3", 1, 320, 231),
        )
        val matched = AlbumPicker.match("Clipse", wanted, files)
        assertEquals(1, matched.size)
        assertEquals("share\\Clipse\\09 - All Eyes On Me (Instrumental).mp3", matched[0]!!.path)
    }

    @Test fun instrumentalAlbumRequestSelectsInstrumentalFolder() {
        val wanted = listOf(WantedTrack("Freedom", 226_000), WantedTrack("Popular Demand", 259_000))
        val results = listOf(
            SearchResult("instPeer", 1, listOf(
                SharedFile("share\\Clipse - Til the Casket Drops (Instrumentals)\\01 - Freedom (Instrumental).mp3", 1, 320, 226),
                SharedFile("share\\Clipse - Til the Casket Drops (Instrumentals)\\02 - Popular Demand (Instrumental).mp3", 1, 320, 259),
            ), freeSlot = true, speed = 10_000_000, queue = 0),
            SearchResult("vocalPeer", 1, listOf(
                SharedFile("share\\Clipse - Til the Casket Drops\\01 - Freedom.mp3", 1, 320, 226),
                SharedFile("share\\Clipse - Til the Casket Drops\\02 - Popular Demand.mp3", 1, 320, 259),
            ), freeSlot = true, speed = 1_000_000, queue = 0),
        )
        val picks = AlbumPicker.candidates("Clipse", wanted, results, album = "Til the Casket Drops (Instrumentals)")
        assertEquals("instPeer", picks.first().user)
        assertEquals(2, picks.first().files.size)
    }

    @Test fun ambientAlbumsMatchAndDownloadNormally() {
        val enoTracks = listOf(
            WantedTrack("1/1", 1005_000),
            WantedTrack("2/1", 504_000),
            WantedTrack("1/2", 725_000),
            WantedTrack("2/2", 360_000),
        )
        val files = listOf(
            SharedFile("Ambient\\Brian Eno - Ambient 1 Music for Airports\\01 - 1-1.flac", 1, 800, 1005),
            SharedFile("Ambient\\Brian Eno - Ambient 1 Music for Airports\\02 - 2-1.flac", 1, 800, 504),
            SharedFile("Ambient\\Brian Eno - Ambient 1 Music for Airports\\03 - 1-2.flac", 1, 800, 725),
            SharedFile("Ambient\\Brian Eno - Ambient 1 Music for Airports\\04 - 2-2.flac", 1, 800, 360),
        )
        val results = listOf(SearchResult("ambientSharer", 1, files, freeSlot = true, speed = 5_000_000, queue = 0))
        val picks = AlbumPicker.candidates("Brian Eno", enoTracks, results, album = "Ambient 1: Music for Airports")
        assertEquals(1, picks.size)
        assertEquals(4, picks.first().files.size)
    }

    @Test fun cleanAlbumsDisqualifiedWhenExplicitWanted() {
        val wanted = listOf(WantedTrack("All Eyes on Me", 231_000), WantedTrack("Freedom", 226_000))
        val results = listOf(
            SearchResult("cleanPeer", 1, listOf(
                SharedFile("share\\Clipse - Til the Casket Drops (Clean)\\01 - Freedom.mp3", 1, 320, 226),
                SharedFile("share\\Clipse - Til the Casket Drops (Clean)\\02 - All Eyes on Me (Clean).mp3", 1, 320, 231),
            ), freeSlot = true, speed = 10_000_000, queue = 0),
            SearchResult("explicitPeer", 1, listOf(
                SharedFile("share\\Clipse - Til the Casket Drops\\01 - Freedom.mp3", 1, 320, 226),
                SharedFile("share\\Clipse - Til the Casket Drops\\02 - All Eyes on Me.mp3", 1, 320, 231),
            ), freeSlot = true, speed = 1_000_000, queue = 0),
        )
        val picks = AlbumPicker.candidates("Clipse", wanted, results, album = "Til the Casket Drops")
        assertEquals(1, picks.size)
        assertEquals("explicitPeer", picks.first().user)
    }
}
