package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The pure resume-cursor math from PlaybackMemory.restore(). The important case is a saved "current"
 * song that was removed from the phone: the index must never point past the playable queue (media3
 * throws IllegalSeekPositionException otherwise).
 */
class PlaybackMemoryTest {
    private fun resume(ids: List<String>, playable: Set<String>, current: String?, savedIndex: Int): Int {
        val kept = ids.filter { it in playable }
        return PlaybackMemory.resumeIndex(ids, playable, kept, current, savedIndex)
    }

    @Test fun noSavedCurrentStartsAtZero() {
        assertEquals(0, resume(listOf("A", "B", "C"), setOf("A", "B", "C"), null, 1))
    }

    @Test fun currentAtSavedSlotAccountsForDroppedEarlierSongs() {
        // B is gone; current C was at index 2 -> lands at kept index 1 ([A, C]).
        assertEquals(1, resume(listOf("A", "B", "C"), setOf("A", "C"), "C", 2))
    }

    @Test fun deletedCurrentWithAllPlayableBeforeItDoesNotSeekPastTheEnd() {
        // The crash case: current C sat at the saved index but is no longer playable, and every
        // playable song is before it. The old code returned kept.size (2) -> crash; now it clamps.
        val kept = listOf("A", "B") // ids filtered by playable {A, B}
        val idx = PlaybackMemory.resumeIndex(listOf("A", "B", "C"), setOf("A", "B"), kept, "C", 2)
        assertEquals(0, idx)
        assert(idx in kept.indices) { "index $idx must be a valid position in a 2-item queue" }
    }

    @Test fun driftedSavedIndexFallsBackToFirstOccurrence() {
        assertEquals(2, resume(listOf("A", "B", "C"), setOf("A", "B", "C"), "C", 0))
    }

    @Test fun duplicateCurrentPrefersTheSavedSlot() {
        // "X" appears twice; saved slot 2 should win over indexOf (which would give 0).
        assertEquals(2, resume(listOf("X", "A", "X"), setOf("X", "A"), "X", 2))
    }

    @Test fun unknownCurrentClampsToZero() {
        assertEquals(0, resume(listOf("A", "B"), setOf("A", "B"), "Z", 0))
    }

    @Test fun emptyKeptIsZero() {
        assertEquals(0, PlaybackMemory.resumeIndex(listOf("A"), emptySet(), emptyList(), "A", 0))
    }
}
