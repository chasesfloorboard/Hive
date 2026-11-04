package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class UpNextTest {
    @Test fun fourSongsPlayNextInTheOrderPickedThenTheShuffleCarriesOn() {
        // A shuffled queue of 0..5 playing 3 (order 3, 0, 5, 1, 4, 2); A..D (6..9) picked one at a time.
        var order = listOf(3, 0, 5, 1, 4, 2)
        val ids = (0..9).associateWith { if (it >= 6) "ABCD"[it - 6].toString() else "s$it" }
        val upNext = ArrayList<String>()
        for (song in 6..9) {
            val withIt = order + song
            val run = UpNext.run(order, 3, { ids.getValue(it) }, upNext)
            order = UpNext.place(withIt, 3, listOf(song), run)
            upNext += ids.getValue(song)
        }
        assertEquals(listOf(3, 6, 7, 8, 9, 0, 5, 1, 4, 2), order)
    }

    @Test fun afterOneHasPlayedTheNextGoesAfterThoseStillToCome() {
        // Playing A (6), B (7) still to come: C goes after B.
        val order = listOf(3, 6, 7, 0, 5)
        val ids = mapOf(3 to "s3", 6 to "A", 7 to "B", 0 to "s0", 5 to "s5", 8 to "C")
        val run = UpNext.run(order, 6, { ids.getValue(it) }, listOf("B"))
        assertEquals(1, run)
        assertEquals(listOf(3, 6, 7, 8, 0, 5), UpNext.place(order + 8, 6, listOf(8), run))
    }

    @Test fun aSongTakenOutOfTheWayEndsTheRun() {
        // B was removed from the queue: C goes straight after the playing song.
        val order = listOf(3, 0, 5)
        assertEquals(0, UpNext.run(order, 3, { "s$it" }, listOf("B")))
    }
}
