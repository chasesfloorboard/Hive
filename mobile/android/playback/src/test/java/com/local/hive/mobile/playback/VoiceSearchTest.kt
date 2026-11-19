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

    @Test fun carAndConversationalPhrasesAreCleaned() {
        val carQueries = listOf(
            "play outkast while I'm driving",
            "can you play sade",
            "could you please play outkast in the car",
            "i want to hear outkast while driving",
            "play some outkast in my car",
            "put on some outkast for my drive",
            "play outkast on the road",
            "start outkast right now",
        )
        for (q in carQueries) {
            val got = VoiceSearch.pick(lib, q, random = Random(1))
            if ("sade" in q) {
                assertTrue(got.isEmpty()) // Sade is not in this mini lib
            } else {
                assertEquals(q, 4, got.size)
                assertTrue(q, got.all { it.artist == "OutKast" })
            }
        }
    }

    @Test fun songAndAlbumWithCarPhrases() {
        assertEquals(listOf("B.O.B.", "Ms. Jackson"), VoiceSearch.pick(lib, "play stankonia while I am driving").map { it.title })
        assertEquals(listOf("Hey Ya!", "Roses"), VoiceSearch.pick(lib, "play hey ya while driving").map { it.title })
    }

    @Test fun favoritesAndLikedSongs() {
        val favIds = setOf(lib[0].id, lib[2].id) // Hey Ya! and Ms. Jackson
        val gotFavs = VoiceSearch.pick(lib, "play my favorites in the car", favorites = favIds, random = Random(1))
        assertEquals(2, gotFavs.size)
        assertTrue(gotFavs.all { it.id in favIds })

        val gotLiked = VoiceSearch.pick(lib, "play liked songs while driving", favorites = favIds, random = Random(1))
        assertEquals(2, gotLiked.size)
        assertTrue(gotLiked.all { it.id in favIds })
    }

    @Test fun anAlbumPlaysInOrder() {
        assertEquals(listOf("B.O.B.", "Ms. Jackson"), VoiceSearch.pick(lib, "Stankonia").map { it.title })
        assertEquals(listOf("B.O.B.", "Ms. Jackson"), VoiceSearch.pick(lib, "play the album Stankonia").map { it.title })
        assertEquals(listOf("B.O.B.", "Ms. Jackson"), VoiceSearch.pick(lib, "play Outkast Stankonia").map { it.title })
    }

    @Test fun artistNotAlbumShufflesArtist() {
        val notAlbum1 = VoiceSearch.pick(lib, "play outkast not an album", random = Random(1))
        assertEquals(4, notAlbum1.size)
        assertTrue(notAlbum1.all { it.artist == "OutKast" })

        val notAlbum2 = VoiceSearch.pick(lib, "play outkast and not an album while driving", random = Random(1))
        assertEquals(4, notAlbum2.size)
        assertTrue(notAlbum2.all { it.artist == "OutKast" })
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
