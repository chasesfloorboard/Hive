package com.local.hive.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DragAutoScrollTest {
    @Test fun middleZoneReturnsZeroAndEdgesAccelerateSmoothly() {
        val mid = DragAutoScroll.computeEdgeScrollDelta(500f, 1000f, 150f, 30f, canScrollBackward = true, canScrollForward = true)
        assertEquals(0f, mid, 0.001f)

        val nearTop = DragAutoScroll.computeEdgeScrollDelta(120f, 1000f, 150f, 30f, canScrollBackward = true, canScrollForward = true)
        val veryTop = DragAutoScroll.computeEdgeScrollDelta(10f, 1000f, 150f, 30f, canScrollBackward = true, canScrollForward = true)
        assertTrue("Expected upward scroll near top, got $nearTop", nearTop < 0f)
        assertTrue("Expected faster upward scroll closer to edge ($veryTop < $nearTop)", veryTop < nearTop)

        val nearBottom = DragAutoScroll.computeEdgeScrollDelta(960f, 1000f, 150f, 30f, canScrollBackward = true, canScrollForward = true)
        assertTrue("Expected downward scroll near bottom, got $nearBottom", nearBottom > 0f)

        val cantScrollUp = DragAutoScroll.computeEdgeScrollDelta(10f, 1000f, 150f, 30f, canScrollBackward = false, canScrollForward = true)
        assertEquals(0f, cantScrollUp, 0.001f)
    }

    @Test fun hitTestSkipsPinnedFavoritesAndSnapsToTopRowWhenDraggingAbove() {
        val slots = listOf(
            DragAutoScroll.VisibleSlot("favorites", 0f, 0f, 500f, 500f),
            DragAutoScroll.VisibleSlot("album:1", 520f, 0f, 1020f, 500f),
            DragAutoScroll.VisibleSlot("album:2", 0f, 520f, 500f, 1020f),
            DragAutoScroll.VisibleSlot("album:3", 520f, 520f, 1020f, 1020f),
        )
        assertNull(DragAutoScroll.findSwapTargetKey("album:3", "favorites", 200f, 200f, slots))
        assertEquals("album:1", DragAutoScroll.findSwapTargetKey("album:3", "favorites", 700f, 200f, slots))
        // Dragging above the viewport while auto-scrolling up targets top movable tile "album:1".
        assertEquals("album:1", DragAutoScroll.findSwapTargetKey("album:3", "favorites", 700f, -40f, slots))
    }
}
