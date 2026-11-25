package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LockPlayerPolicyTest {

    @Test
    fun displayTransitionsDetectOnAndOffAcrossDozeAndOffStates() {
        // Off (1) -> On (2)
        assertEquals(DisplayTransition.TURNED_ON, LockPlayerPolicy.classifyDisplayTransition(1, 2))
        // Doze (3) / DozeSuspend (4) -> On (2) (Pixel AOD waking for notification or tap in car)
        assertEquals(DisplayTransition.TURNED_ON, LockPlayerPolicy.classifyDisplayTransition(3, 2))
        assertEquals(DisplayTransition.TURNED_ON, LockPlayerPolicy.classifyDisplayTransition(4, 2))
        // On (2) -> Off (1) / Doze (3) / DozeSuspend (4)
        assertEquals(DisplayTransition.TURNED_OFF, LockPlayerPolicy.classifyDisplayTransition(2, 1))
        assertEquals(DisplayTransition.TURNED_OFF, LockPlayerPolicy.classifyDisplayTransition(2, 3))
        assertEquals(DisplayTransition.TURNED_OFF, LockPlayerPolicy.classifyDisplayTransition(2, 4))
        // Non-interactive transitions stay NONE
        assertEquals(DisplayTransition.NONE, LockPlayerPolicy.classifyDisplayTransition(1, 3))
        assertEquals(DisplayTransition.NONE, LockPlayerPolicy.classifyDisplayTransition(3, 4))
        assertEquals(DisplayTransition.NONE, LockPlayerPolicy.classifyDisplayTransition(2, 2))
    }

    @Test
    fun reassertAllowedOnceWithinWakeWindowWhileLockedAndDisplayOn() {
        assertTrue(
            LockPlayerPolicy.shouldReassertOnStop(
                isLocked = true,
                displayOn = true,
                leaving = false,
                sentAway = false,
                inCall = false,
                elapsedSinceOpenMs = 113L,
                reassertAttempts = 0,
            ),
        )
        // Second attempt on the same wake is always refused (prevents loops)
        assertFalse(
            LockPlayerPolicy.shouldReassertOnStop(
                isLocked = true,
                displayOn = true,
                leaving = false,
                sentAway = false,
                inCall = false,
                elapsedSinceOpenMs = 500L,
                reassertAttempts = 1,
            ),
        )
    }

    @Test
    fun reassertRefusedWhenDisplayOffUnlockedDismissedInCallOrPastWindow() {
        assertFalse(LockPlayerPolicy.shouldReassertOnStop(isLocked = true, displayOn = false, leaving = false, sentAway = false, inCall = false, elapsedSinceOpenMs = 100L, reassertAttempts = 0))
        assertFalse(LockPlayerPolicy.shouldReassertOnStop(isLocked = false, displayOn = true, leaving = false, sentAway = false, inCall = false, elapsedSinceOpenMs = 100L, reassertAttempts = 0))
        assertFalse(LockPlayerPolicy.shouldReassertOnStop(isLocked = true, displayOn = true, leaving = true, sentAway = false, inCall = false, elapsedSinceOpenMs = 100L, reassertAttempts = 0))
        assertFalse(LockPlayerPolicy.shouldReassertOnStop(isLocked = true, displayOn = true, leaving = false, sentAway = true, inCall = false, elapsedSinceOpenMs = 100L, reassertAttempts = 0))
        assertFalse(LockPlayerPolicy.shouldReassertOnStop(isLocked = true, displayOn = true, leaving = false, sentAway = false, inCall = true, elapsedSinceOpenMs = 100L, reassertAttempts = 0))
        assertFalse(LockPlayerPolicy.shouldReassertOnStop(isLocked = true, displayOn = true, leaving = false, sentAway = false, inCall = false, elapsedSinceOpenMs = 2_500L, reassertAttempts = 0))
    }

    @Test
    fun playStartOnlyShowsWhenPlayingLockedAndDisplayAlreadyOn() {
        assertTrue(LockPlayerPolicy.shouldShowOnPlayStart(isPlaying = true, isLocked = true, displayOn = true))
        assertFalse(LockPlayerPolicy.shouldShowOnPlayStart(isPlaying = true, isLocked = true, displayOn = false))
        assertFalse(LockPlayerPolicy.shouldShowOnPlayStart(isPlaying = true, isLocked = false, displayOn = true))
        assertFalse(LockPlayerPolicy.shouldShowOnPlayStart(isPlaying = false, isLocked = true, displayOn = true))
    }
}
