package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackRelinkTest {
    private fun t(id: Long, title: String, folder: String = "Music/A", file: String = "$title.mp3", album: String = "Album", ms: Long = 200_000) =
        Track(id, title, "Artist", album, "Artist", 1, ms, 1, 1, 2020, "", folder, file, 0, 0)

    @Test fun anUnchangedLibraryHasNothingToMove() {
        val lib = listOf(t(1, "One"), t(2, "Two"))
        assertTrue(TrackRelink.find(lib, lib).isEmpty)
        // A retag (same file) or a move (same title) keeps its number: nothing to do.
        assertTrue(TrackRelink.find(lib, listOf(t(1, "One (Remastered)", file = "One.mp3"), t(2, "Two", folder = "Music/B"))).isEmpty)
    }

    @Test fun aNewPhoneNumbersTheSameFilesDifferently() {
        // Old phone: 10 One, 11 Two, 12 Three. New phone: the same files as 11 Three, 12 One, 13 Two.
        val before = listOf(t(10, "One"), t(11, "Two"), t(12, "Three"))
        val after = listOf(t(11, "Three"), t(12, "One"), t(13, "Two"))
        val r = TrackRelink.find(before, after)
        assertEquals(mapOf(10L to 12L, 11L to 13L, 12L to 11L), r.moved)
        assertEquals(emptySet<Long>(), r.aside)
    }

    @Test fun foundByTagsWhenTheFileIsNamedDifferently() {
        val r = TrackRelink.find(listOf(t(5, "Song", file = "01 Song.mp3")), listOf(t(9, "Song", folder = "Music/New", file = "Artist - Song.flac", ms = 200_400)))
        assertEquals(mapOf(5L to 9L), r.moved)
    }

    @Test fun aSongNotFoundAgainDoesntHandItsThingsToAnother() {
        // Old 7 was "Gone"; on the new phone 7 is "Other", and "Gone" isn't there.
        val r = TrackRelink.find(listOf(t(7, "Gone"), t(8, "Kept")), listOf(t(7, "Other"), t(8, "Kept")))
        assertEquals(emptyMap<Long, Long>(), r.moved)
        assertEquals(setOf(7L), r.aside)
    }

    @Test fun twoCopiesWithTheSameTagsAreNotGuessed() {
        val r = TrackRelink.find(listOf(t(1, "Song", file = "a.mp3")), listOf(t(5, "Song", folder = "X", file = "b.mp3"), t(6, "Song", folder = "Y", file = "c.mp3")))
        assertTrue(r.moved.isEmpty())
    }

    @Test fun aRewrittenSongKeepsTheDayItArrived() {
        fun d(x: Track, at: Long) = x.copy(dateAdded = at)
        val before = listOf(d(t(1, "Played"), 1_000), d(t(2, "Retagged"), 2_000), d(t(3, "Old"), 3_000))
        // 1's file was written again (a new number, dated today); 2 was rewritten in place; 4 is really new.
        val after = listOf(d(t(9, "Played"), 99_000), d(t(2, "Retagged"), 98_000), d(t(3, "Old"), 3_000), d(t(4, "New"), 97_000))
        val r = TrackRelink.find(before, after)
        val kept = TrackRelink.keepAdded(before.associateBy { it.id }, emptyMap(), r, after).associate { it.id to it.dateAdded }
        assertEquals(mapOf(9L to 1_000L, 2L to 2_000L, 3L to 3_000L, 4L to 97_000L), kept)
        // A song that was away for a scan and comes back keeps its day too.
        val lost = LostTrack.of(d(t(5, "Away"), 5_000))
        val back = TrackRelink.find(listOf(lost.asTrack()), listOf(d(t(6, "Away"), 96_000)))
        assertEquals(5_000L, TrackRelink.keepAdded(emptyMap(), mapOf(5L to lost), back, listOf(d(t(6, "Away"), 96_000))).single().dateAdded)
    }
}
