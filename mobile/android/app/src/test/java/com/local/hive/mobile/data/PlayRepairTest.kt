package com.local.hive.mobile.data

import com.local.hive.mobile.playback.HISTORY_MS
import org.junit.Assert.assertEquals
import org.junit.Test

class PlayRepairTest {
    private val t0 = 1_800_000_000_000L
    private fun h(id: Long, at: Long) = HistoryEntry(id.toString(), t0 + at)

    @Test fun anAlbumPlayedStraightThroughCountsEverySong() {
        // Songs 1-4 (60 s, 90 s, 30 s, 120 s) play back to back; only song 1 was counted.
        val lengths = mapOf(1L to 60_000L, 2L to 90_000L, 3L to 30_000L, 4L to 120_000L)
        val history = listOf(h(1, 5_000), h(2, 65_000), h(3, 155_000), h(4, 185_000), h(9, 305_000))
        val counted = listOf(Play(trackId = 1, playedAt = t0 + 35_000, listenedMs = 30_000))
        val found = PlayRepair.missed(history, counted, lengths)
        assertEquals(listOf(2L, 3L, 4L), found.map { it.trackId })
        assertEquals(listOf(90_000L, 30_000L, 120_000L), found.map { it.listenedMs })
        // Each is dated when it ended, as a counted play would be about then.
        assertEquals(t0 + 150_000, found[0].playedAt)
    }

    @Test fun skipsPausesAndOtherSongsAreLeftOut() {
        val lengths = mapOf(1L to 200_000L, 2L to 200_000L, 3L to 200_000L)
        val history = listOf(
            h(1, 0), // skipped after 6 s
            h(2, 6_000), // then paused for an hour
            h(3, 3_606_000),
            HistoryEntry("sp:abc", 3_806_000 + t0), // a streamed song: no id here, but it ends song 3
        )
        val found = PlayRepair.missed(history, emptyList(), lengths)
        assertEquals(listOf(3L), found.map { it.trackId })
    }

    @Test fun theLastSongWithNothingAfterItIsLeftOut() {
        assertEquals(emptyList<Play>(), PlayRepair.missed(listOf(h(1, 0)), emptyList(), mapOf(1L to 60_000L)))
        assertEquals(5_000L, HISTORY_MS)
    }
}
