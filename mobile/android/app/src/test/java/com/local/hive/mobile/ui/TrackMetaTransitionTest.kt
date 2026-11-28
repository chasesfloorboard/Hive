package com.local.hive.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class TrackMetaTransitionTest {

    @Test
    fun forwardSkipReturnsRightToLeft() {
        assertEquals(1, resolveTrackSkipDirection(wentBack = false, shuffle = false, fromIndex = 2, toIndex = 3, queueSize = 10))
    }

    @Test
    fun backwardSkipReturnsLeftToRight() {
        assertEquals(-1, resolveTrackSkipDirection(wentBack = true, shuffle = false, fromIndex = 3, toIndex = 2, queueSize = 10))
    }

    @Test
    fun shuffleNextWithLowerQueueIndexStillSlidesForward() {
        // In shuffle mode, pressing Next can jump to a lower queue index; direction must follow the button, not index.
        assertEquals(1, resolveTrackSkipDirection(wentBack = false, shuffle = true, fromIndex = 8, toIndex = 1, queueSize = 10))
    }

    @Test
    fun shufflePreviousWithHigherQueueIndexStillSlidesBackward() {
        assertEquals(-1, resolveTrackSkipDirection(wentBack = true, shuffle = true, fromIndex = 1, toIndex = 8, queueSize = 10))
    }

    @Test
    fun repeatAllWrapFromLastToFirstSlidesForward() {
        assertEquals(1, resolveTrackSkipDirection(wentBack = false, shuffle = false, fromIndex = 9, toIndex = 0, queueSize = 10))
    }

    @Test
    fun externalMediaPreviousInOrderedQueueSlidesBackward() {
        // Bluetooth / notification Previous doesn't go through UI previous(), so ordered index drop still resolves backward.
        assertEquals(-1, resolveTrackSkipDirection(wentBack = false, shuffle = false, fromIndex = 4, toIndex = 3, queueSize = 10))
    }

    @Test
    fun externalMediaWrapBackwardFromFirstToLastSlidesBackward() {
        assertEquals(-1, resolveTrackSkipDirection(wentBack = false, shuffle = false, fromIndex = 0, toIndex = 9, queueSize = 10))
        // In a 2-song queue, 0 -> 1 is a normal forward skip, not a wrap-backward.
        assertEquals(1, resolveTrackSkipDirection(wentBack = false, shuffle = false, fromIndex = 0, toIndex = 1, queueSize = 2))
    }
}
