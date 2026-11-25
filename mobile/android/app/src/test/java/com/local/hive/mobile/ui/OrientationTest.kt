package com.local.hive.mobile.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OrientationTest {
    @Test
    fun nestedLandscapeSurfacesKeepLandscapeUntilAllClose() {
        val counter = LandscapeLockCounter()
        assertFalse(counter.allowsLandscape)

        // Now Playing opens -> allow landscape
        assertTrue(counter.acquire())
        assertTrue(counter.allowsLandscape)

        // CoverViewer opens inside Now Playing -> already allowed
        assertFalse(counter.acquire())
        assertTrue(counter.allowsLandscape)

        // CoverViewer closes -> Now Playing still open, keep landscape
        assertFalse(counter.release())
        assertTrue(counter.allowsLandscape)

        // Now Playing closes -> back to portrait
        assertTrue(counter.release())
        assertFalse(counter.allowsLandscape)

        // Extra release is a safe no-op
        assertFalse(counter.release())
        assertFalse(counter.allowsLandscape)
    }
}
