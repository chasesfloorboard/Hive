package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class LoveSettleTest {
    @Test fun aHeartTappedAgainWhileTheSyncWasOutIsNotOverwritten() {
        // Sent: Loved at t=100. Meanwhile the user un-loved it (t=200, pending). The PC's "applied" for t=100 arrives.
        val sent = mapOf(1L to 100L, 2L to 100L)
        val current = mapOf(1L to LoveState(1, false, 200, pending = true), 2L to LoveState(2, true, 100, pending = true))
        val answered = listOf(LoveState(1, true, 100, pending = false), LoveState(2, true, 100, pending = false))
        assertEquals(listOf(2L), LoveSettle.unchanged(sent, current, answered).map { it.trackId })
    }

    @Test fun aSongWithNoLoveYetTakesTheAnswerButNotIfOneWasTappedMeanwhile() {
        val fresh = listOf(LoveState(3, true, 0, pending = false))
        assertEquals(1, LoveSettle.unchanged(emptyMap(), emptyMap(), fresh).size)
        assertEquals(0, LoveSettle.unchanged(emptyMap(), mapOf(3L to LoveState(3, false, 50, pending = true)), fresh).size)
    }
}
