package com.local.hive.mobile.playback

import com.local.hive.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class AutoDjTest {
    private var nextId = 1L
    private fun song(title: String, artist: String, album: String = "$artist album", genre: String = "", year: Int = 2010, albumArtist: String = "") =
        Track(nextId++, title, artist, album, albumArtist, album.hashCode().toLong(), 200_000, 1, 1, year, genre, "/m", "$title.mp3", 0, 0)

    private val bones = (1..12).map { song("Bones $it", "BONES", genre = "Hip-Hop") }
    private val collab = song("Together", "BONES & Xavier Wulf", genre = "Hip-Hop")
    private val wulf = (1..8).map { song("Wulf $it", "Xavier Wulf", genre = "Hip-Hop") }
    private val rap = (1..20).map { song("Rap $it", "Rapper $it", genre = "Hip-Hop") }
    private val jazz = (1..20).map { song("Jazz $it", "Jazz $it", genre = "Jazz", year = 1960) }
    private val library = bones + collab + wulf + rap + jazz

    @Test fun seedsComeFirstInTheirOrder() {
        val seeds = bones.take(3)
        val q = AutoDj.build(seeds, library, random = Random(1))
        assertEquals(seeds, q.take(3))
    }

    @Test fun neverRepeatsASong() {
        val q = AutoDj.build(listOf(bones[0]), library, random = Random(2))
        assertEquals(q.size, q.map { it.id }.toSet().size)
        // Everything related to BONES here is 41 songs; unrelated music doesn't pad it out.
        assertEquals(41, q.size)
        val big = library + (1..80).map { song("More $it", "Crew $it", genre = "Hip-Hop") }
        assertEquals(AutoDj.SIZE, AutoDj.build(listOf(bones[0]), big, random = Random(2)).size)
    }

    @Test fun staysNearTheSeedAndLeavesUnrelatedMusicOut() {
        val q = AutoDj.build(listOf(bones[0]), library, random = Random(3))
        assertTrue("collaborators come in", q.any { it.artist == "Xavier Wulf" })
        assertTrue("same-genre artists come in", q.any { it.artist.startsWith("Rapper") })
        assertTrue("another genre stays out", q.none { it.genre == "Jazz" })
    }

    @Test fun spacesOutTheSameArtist() {
        val big = library + (1..80).map { song("More $it", "Crew $it", genre = "Hip-Hop") }
        val q = AutoDj.build(listOf(bones[0]), big, random = Random(4)).drop(1)
        q.zipWithNext().forEach { (a, b) -> assertTrue("${a.artist} twice in a row", AutoDj.artistsOf(a).intersect(AutoDj.artistsOf(b)).isEmpty()) }
    }

    @Test fun aWholeArtistAsSeedIsCutToItsFavourites() {
        val loved = setOf(bones[7].id)
        val discography = bones + (13..30).map { song("Bones $it", "BONES", genre = "Hip-Hop") }
        val q = AutoDj.build(discography, library + discography.drop(12), plays = mapOf(bones[5].id to 40), loved = loved, random = Random(5))
        val opening = q.take(6)
        assertTrue(opening.all { it.artist == "BONES" })
        assertTrue(bones[7] in opening && bones[5] in opening)
    }

    @Test fun featuredArtistsAreSplit() {
        assertEquals(setOf("bones", "xavier wulf"), AutoDj.artistsOf(collab))
        assertEquals(setOf("a", "b"), AutoDj.artistsOf(song("x", "A feat. B")))
    }

    @Test fun aGenreFindsItsNeighboursAndBroadTagsCountLess() {
        assertEquals(1.0, AutoDj.genreAffinity("Ambient", setOf("ambient")), 0.0)
        assertEquals(0.8, AutoDj.genreAffinity("Dark Ambient", setOf("ambient")), 0.0)
        assertEquals(0.6, AutoDj.genreAffinity("Drone", setOf("ambient")), 0.0)
        assertEquals(0.0, AutoDj.genreAffinity("Death Metal", setOf("ambient")), 0.0)
        assertEquals(0.5, AutoDj.genreAffinity("Electronic", setOf("electronic")), 0.0)
        assertEquals(0.0, AutoDj.genreAffinity("New Wave", setOf("new age")), 0.0)
    }

    @Test fun anAmbientSeedReachesDroneButNotMetal() {
        val seeds = listOf(song("1/1", "Biosphere", genre = "Ambient"), song("Substrata", "Biosphere", genre = "Ambient"))
        val library = seeds + listOf(
            song("Harmony", "Tim Hecker", genre = "Drone"), song("Disintegration", "Basinski", genre = "Dark Ambient"),
            song("Angel", "Morbid", genre = "Death Metal"), song("Hit", "Pop Star", genre = "Pop"),
        )
        val q = AutoDj.build(seeds, library, random = kotlin.random.Random(1)).map { it.artist }
        assertTrue("Tim Hecker" in q && "Basinski" in q)
        assertTrue("Morbid" !in q && "Pop Star" !in q)
    }
}
