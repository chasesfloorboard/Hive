package com.local.hive.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class CoverViewerTest {
    @Test
    fun viewerCoverDataClassEquality() {
        val b1 = byteArrayOf(1, 2, 3)
        val b2 = byteArrayOf(1, 2, 3)
        val b3 = byteArrayOf(4, 5, 6)

        val c1 = ViewerCover(b1, "Cover 1", "Von dutch")
        val c2 = ViewerCover(b2, "Cover 1", "Von dutch")
        val c3 = ViewerCover(b3, "Cover 2", "Von dutch")

        assertEquals(c1, c2)
        assertEquals(c1.hashCode(), c2.hashCode())
        assertNotEquals(c1, c3)
        assertEquals("Cover 1", c1.title)
        assertEquals("Von dutch", c1.caption)
    }

    @Test
    fun multiCoverDiscoveryTitleOrdering() {
        val covers = listOf(
            ViewerCover(byteArrayOf(1), "Cover 1", "The Life of Pablo"),
            ViewerCover(byteArrayOf(2), "Cover 2", "The Life of Pablo"),
            ViewerCover(byteArrayOf(3), "Cover 3", "Von dutch")
        )
        assertEquals(3, covers.size)
        assertEquals("Cover 1", covers[0].title)
        assertEquals("Cover 2", covers[1].title)
        assertEquals("Cover 3", covers[2].title)
        assertEquals("Von dutch", covers[2].caption)
    }
}
