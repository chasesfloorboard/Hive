package com.local.hive.mobile.ui

import com.local.hive.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Test

class AutoTagMatchTest {
    private fun t(id: Long, title: String, n: Int, file: String = "$title.mp3") = Track(id, title, "A", "Album", "", 1, 200_000, n, 0, 0, "", "Music", file, 0, 1000)
    private val release = listOf("Intro", "Black (Remastered)", "Jeremy")

    @Test fun byTrackNumberWhenTheAlbumHasThem() {
        val got = matchRelease(listOf(t(1, "whatever", 2), t(2, "x", 3)), release) { it }
        assertEquals(listOf(1L to 1, 2L to 2), got.map { it.first.id to it.second })
    }

    @Test fun byTitleWithoutNumbers() {
        val got = matchRelease(listOf(t(1, "Jeremy", 0), t(2, "Black", 0)), release) { it }
        assertEquals(setOf(1L to 2, 2L to 1), got.map { it.first.id to it.second }.toSet())
    }

    @Test fun inOrderAsALastResort() {
        val got = matchRelease(listOf(t(1, "Track 02", 0, "b.mp3"), t(2, "Track 01", 0, "a.mp3")), release) { it }
        assertEquals(listOf(2L to 0, 1L to 1), got.map { it.first.id to it.second })
    }
}
