package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class SmartPlaylistTest {
    private val day = 86_400_000L
    private val now = 1_000 * day
    private fun t(id: Long, title: String, genre: String, year: Int, ext: String = "mp3", added: Long = now - 100 * day) =
        Track(id, title, "Artist $id", "Album", "", 1, 200_000, id.toInt(), 1, year, genre, "Music", "$title.$ext", added, 1000)

    private val lib = listOf(
        t(1, "One", "Deep House", 2019, "flac", added = now - 2 * day),
        t(2, "Two", "House", 2005),
        t(3, "Three", "Techno", 2021, "flac"),
        t(4, "Four", "Ambient", 1990),
    )

    private fun pick(vararg rules: SmartRule, all: Boolean = true, sort: SmartSort = SmartSort.Title, limit: Int = 0, plays: Map<Long, Int> = emptyMap(), ratings: Map<Long, Float> = emptyMap(), loved: Set<Long> = emptySet()) =
        SmartPlaylist(1, "x", rules.toList(), all, sort, limit).select(lib, plays, ratings, loved, now).map { it.id }

    @Test fun textRulesIgnoreCase() {
        assertEquals(listOf(1L, 2L), pick(SmartRule(SmartField.Genre, SmartOp.Contains, "house"), sort = SmartSort.Album))
        assertEquals(listOf(2L), pick(SmartRule(SmartField.Genre, SmartOp.Is, "HOUSE")))
    }

    @Test fun allOrAnyRule() {
        val house = SmartRule(SmartField.Genre, SmartOp.Contains, "house")
        val lossless = SmartRule(SmartField.Lossless, SmartOp.Yes)
        assertEquals(listOf(1L), pick(house, lossless))
        assertEquals(setOf(1L, 2L, 3L), pick(house, lossless, all = false).toSet())
    }

    @Test fun numbersDaysRatingsPlaysAndFavorites() {
        assertEquals(setOf(1L, 3L), pick(SmartRule(SmartField.Year, SmartOp.AtLeast, "2010")).toSet())
        assertEquals(listOf(1L), pick(SmartRule(SmartField.AddedDays, SmartOp.InLast, "7")))
        assertEquals(listOf(4L), pick(SmartRule(SmartField.Rating, SmartOp.AtLeast, "4"), ratings = mapOf(4L to 4.5f, 2L to 3f)))
        assertEquals(listOf(2L), pick(SmartRule(SmartField.Plays, SmartOp.AtLeast, "3"), plays = mapOf(2L to 5)))
        assertEquals(listOf(3L), pick(SmartRule(SmartField.Favorite, SmartOp.Yes), loved = setOf(3L)))
    }

    @Test fun sortAndLimit() {
        assertEquals(listOf(3L, 1L), pick(sort = SmartSort.Newest, limit = 2))
        assertEquals(listOf(2L, 4L), pick(sort = SmartSort.MostPlayed, limit = 2, plays = mapOf(2L to 9, 4L to 3)))
    }

    @Test fun anEditSaysOnlyWhatChanged() {
        assertEquals(mapOf("title" to "New", "disk" to "2"), TagEdit(title = "New", disc = "2").pcTags())
        assertEquals(true, TagEdit().isEmpty)
    }
}
