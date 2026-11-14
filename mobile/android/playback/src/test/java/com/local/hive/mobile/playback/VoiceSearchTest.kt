package com.local.hive.mobile.playback

import com.local.hive.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class VoiceSearchTest {
    private var nextId = 1L
    private fun t(title: String, artist: String, album: String, n: Int, genre: String = "", albumId: Long = album.hashCode().toLong()) =
        Track(nextId++, title, artist, album, "", albumId, 200_000, n, 1, 2000, genre, "Music", "$title.mp3", 0, 1000)

    private val lib = listOf(
        t("Hey Ya!", "OutKast", "Speakerboxxx/The Love Below", 9, "Hip-Hop"),
        t("Roses", "OutKast", "Speakerboxxx/The Love Below", 12, "Hip-Hop"),
        t("Ms. Jackson", "OutKast", "Stankonia", 3, "Hip-Hop"),
        t("B.O.B.", "OutKast", "Stankonia", 1, "Hip-Hop"),
        t("An Ending (Ascent)", "Brian Eno", "Apollo", 2, "Ambient"),
        t("Deep Blue Day", "Brian Eno", "Apollo", 1, "Ambient"),
    )

    @Test fun anArtistPlaysAllTheirSongsShuffled() {
        val got = VoiceSearch.pick(lib, "play outkast on Hive", random = Random(1))
        assertEquals(4, got.size); assertTrue(got.all { it.artist == "OutKast" })
    }

    @Test fun anAlbumPlaysInOrder() {
        assertEquals(listOf("B.O.B.", "Ms. Jackson"), VoiceSearch.pick(lib, "Stankonia").map { it.title })
    }

    @Test fun aSongPlaysFirstThenItsAlbum() {
        assertEquals(listOf("Ms. Jackson", "B.O.B."), VoiceSearch.pick(lib, "ms jackson by outkast").map { it.title })
    }

    @Test fun theAssistantsHintsWinAndAGenreShuffles() {
        assertEquals(listOf("Deep Blue Day", "An Ending (Ascent)"), VoiceSearch.pick(lib, "anything", VoiceSearch.Hint(album = "Apollo")).map { it.title })
        assertEquals(2, VoiceSearch.pick(lib, "ambient").size)
    }

    @Test fun plainMusicShufflesEverythingAndNothingFoundIsEmpty() {
        assertEquals(lib.size, VoiceSearch.pick(lib, "play some music").size)
        assertTrue(VoiceSearch.pick(lib, "nonexistent band").isEmpty())
    }

    @Test fun anAlbumByAnArtistWithDotsPlaysHoweverItIsSpelled() {
        val fontaines = listOf(
            t("Six Shot Morning", "Fontaines D.C.", "Dopamine Chamber", 1, albumId = 77),
            t("Marianne", "Fontaines D.C.", "Dopamine Chamber", 2, albumId = 77),
        )
        val library = lib + fontaines
        for (said in listOf("dopamine chamber by fontaines dc", "Dopamine Chamber by Fontaine's DC", "play dopamine chamber by fontaines d.c. on hive", "dopamine chamber by fontaine dc", "dopamine chamber"))
            assertEquals(said, listOf("Six Shot Morning", "Marianne"), VoiceSearch.pick(library, said).map { it.title })
        assertEquals(listOf("Six Shot Morning", "Marianne"), VoiceSearch.pick(library, "", VoiceSearch.Hint(artist = "Fontaine DC", album = "Dopamine Chamber")).map { it.title })
        assertEquals(listOf("Marianne", "Six Shot Morning"), VoiceSearch.pick(library, "marianne by fontaine dc").map { it.title })
    }
}
