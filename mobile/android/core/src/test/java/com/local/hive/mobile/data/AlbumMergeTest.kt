package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AlbumMergeTest {
    private var nextId = 1L
    private fun song(albumId: Long, album: String, artist: String, albumArtist: String = "", folder: String = "Music/My Music", track: Int = 1) = Track(
        id = nextId++, title = "t$nextId", artist = artist, album = album, albumArtist = albumArtist, albumId = albumId,
        durationMs = 1, trackNumber = track, discNumber = 1, year = 0, genre = "", folder = folder, fileName = "f.mp3", dateAdded = 0, sizeBytes = 0,
    )

    private fun ids(tracks: List<Track>) = AlbumMerge.apply(tracks).map { it.albumId }.distinct()

    @Test fun `a song without an album artist joins its album`() {
        val tracks = List(13) { i -> song(1, "MTV Unplugged 2.0", "Lauryn Hill", "Lauryn Hill", track = i + 1) } +
            List(9) { i -> song(2, "MTV Unplugged 2.0", "Lauryn Hill", track = i + 14) }
        assertEquals(listOf(1L), ids(tracks))
    }

    @Test fun `artist case and a credited partner don't split an album`() {
        val bones = List(8) { i -> song(1, "Failure", "BONES", "BONES", track = i + 1) } +
            List(8) { i -> song(2, "Failure", "Bones", "Bones", track = i + 9) }
        assertEquals(1, ids(bones).size)

        val partner = List(10) { i -> song(1, "No Idols", "Domo Genesis", "Domo Genesis", track = i + 1) } +
            song(2, "No Idols", "Domo Genesis/The Alchemist", "Domo Genesis", track = 11)
        assertEquals(1, ids(partner).size)
    }

    @Test fun `multiple editions or duplicate track lists stay separate and never merge into 112233`() {
        // Voir Dire: Gala Music edition (tracks 1..11) vs DSP edition (tracks 1..11)
        val voirDire = List(11) { i -> song(1, "Voir Dire", "Earl Sweatshirt/The Alchemist", "Earl Sweatshirt", track = i + 1) } +
            List(11) { i -> song(2, "Voir Dire", "Earl Sweatshirt", "Earl Sweatshirt & The Alchemist", track = i + 1) }
        assertEquals(2, ids(voirDire).size)

        // Black Ben Carson: 38-track original vs 22-track remaster
        val bbc = List(22) { i -> song(3, "Black Ben Carson", "JPEGMAFIA", "JPEGMAFIA", track = i + 1) } +
            List(38) { i -> song(4, "Black Ben Carson", "JPEGMAFIA", "JPEGMAFIA", track = i + 1) }
        assertEquals(2, ids(bbc).size)
    }

    @Test fun `a song in another folder joins its album, under the larger part's id`() {
        val tracks = List(19) { i -> song(7, "Meat Puppets II", "Meat Puppets", "Meat Puppets", track = i + 1) } +
            song(8, "Meat Puppets II", "Meat Puppets", "Meat Puppets", folder = "Music/Meat Puppets/Meat Puppets II", track = 20)
        assertEquals(listOf(7L), ids(tracks))
    }

    @Test fun `albums that only share a name stay apart`() {
        val tracks = List(14) { i -> song(1, "Utopia", "Björk", track = i + 1) } +
            List(19) { i -> song(2, "Utopia", "Travis Scott", "Travis Scott", track = i + 1) } +
            List(5) { i -> song(3, "13", "Denzel Curry", "Denzel Curry", track = i + 1) } +
            List(13) { i -> song(4, "13", "Blur", "Blur", track = i + 1) }
        assertEquals(4, ids(tracks).size)
    }

    @Test fun `lead artists are compared loosely`() {
        assertEquals(AlbumMerge.artistKey("BONES"), AlbumMerge.artistKey("Bones"))
        assertEquals(AlbumMerge.artistKey("Foster the People"), AlbumMerge.artistKey("Foster The People"))
        assertEquals(AlbumMerge.artistKey("Björk"), AlbumMerge.artistKey("Bjork"))
        assertNotEquals(AlbumMerge.artistKey("Björk"), AlbumMerge.artistKey("Travis Scott"))
        assertEquals(AlbumMerge.artistKey("MF Grimm"), AlbumMerge.artistKey("MF Grimm/MF Doom"))
    }
}
