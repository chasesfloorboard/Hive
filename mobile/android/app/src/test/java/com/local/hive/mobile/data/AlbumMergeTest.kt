package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AlbumMergeTest {
    private var nextId = 1L
    private fun song(albumId: Long, album: String, artist: String, albumArtist: String = "", folder: String = "Music/beautiful sounds pc") = Track(
        id = nextId++, title = "t$nextId", artist = artist, album = album, albumArtist = albumArtist, albumId = albumId,
        durationMs = 1, trackNumber = 1, discNumber = 1, year = 0, genre = "", folder = folder, fileName = "f.mp3", dateAdded = 0, sizeBytes = 0,
    )

    private fun ids(tracks: List<Track>) = AlbumMerge.apply(tracks).map { it.albumId }.distinct()

    @Test fun `a song without an album artist joins its album`() {
        val tracks = List(13) { song(1, "MTV Unplugged 2.0", "Lauryn Hill", "Lauryn Hill") } + List(9) { song(2, "MTV Unplugged 2.0", "Lauryn Hill") }
        assertEquals(listOf(1L), ids(tracks))
    }

    @Test fun `artist case and a credited partner don't split an album`() {
        assertEquals(1, ids(List(16) { song(1, "Failure", "BONES", "BONES") } + List(16) { song(2, "Failure", "Bones", "Bones") }).size)
        assertEquals(1, ids(List(11) { song(1, "Voir Dire", "Earl Sweatshirt/The Alchemist", "Earl Sweatshirt") } + List(11) { song(2, "Voir Dire", "Earl Sweatshirt", "Earl Sweatshirt & The Alchemist") }).size)
        assertEquals(1, ids(List(11) { song(1, "No Idols", "Domo Genesis X Alchemist", "Domo Genesis X Alchemist") } + List(12) { song(2, "No Idols", "Domo Genesis/The Alchemist", "Domo Genesis") }).size)
    }

    @Test fun `a song in another folder joins its album, under the larger part's id`() {
        val tracks = List(19) { song(7, "Meat Puppets II", "Meat Puppets", "Meat Puppets") } + song(8, "Meat Puppets II", "Meat Puppets", "Meat Puppets", folder = "Music/Meat Puppets/Meat Puppets II")
        assertEquals(listOf(7L), ids(tracks))
    }

    @Test fun `albums that only share a name stay apart`() {
        val tracks = List(14) { song(1, "Utopia", "Björk") } + List(19) { song(2, "Utopia", "Travis Scott", "Travis Scott") } + List(5) { song(3, "13", "Denzel Curry", "Denzel Curry") } + List(13) { song(4, "13", "Blur", "Blur") }
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
