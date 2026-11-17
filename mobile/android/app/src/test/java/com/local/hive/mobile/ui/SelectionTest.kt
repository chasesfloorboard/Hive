package com.local.hive.mobile.ui

import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behaviour of [Selection] — the multi-select state machine lifted out of Components.kt.
 * Drives the public interface only (toggle / drag / select-all / picked), never internals.
 */
class SelectionTest {
    private fun track(id: Long, albumId: Long = 0, trackNo: Int = 0, disc: Int = 0) =
        Track(id, "t$id", "artist", "album", "albumArtist", albumId, 0, trackNo, disc, 0, "", "", "f$id", 0, 0)

    private fun stream(key: String) = StreamTrack(key, "apple", "t", "a", "al", 0, "", "", "")

    @Test fun toggleTrackFlipsMembershipAndActive() {
        val s = Selection()
        val a = track(1)
        assertFalse(s.active)
        s.toggle(a)
        assertTrue(a in s); assertTrue(s.active); assertEquals(1, s.tracks.size)
        s.toggle(a)
        assertFalse(a in s); assertFalse(s.active)
    }

    @Test fun toggleStreamFlipsMembership() {
        val s = Selection()
        val x = stream("apple:1")
        s.toggle(x); assertTrue(x in s)
        s.toggle(x); assertFalse(x in s)
    }

    @Test fun toggleAlbumFlipsMembership() {
        val s = Selection()
        s.toggleAlbum(9); assertTrue(s.hasAlbum(9))
        s.toggleAlbum(9); assertFalse(s.hasAlbum(9))
    }

    @Test fun songDragForwardPicksInclusiveRange() {
        val s = Selection()
        val a = track(1); val b = track(2); val c = track(3); val d = track(4)
        s.trackOrder = listOf(a, b, c, d)
        s.startTrackDrag(a)
        s.dragToTrack(c)
        assertEquals(setOf(1L, 2L, 3L), s.tracks.map { it.id }.toSet())
        assertFalse(d in s)
    }

    @Test fun songDragBackwardPicksInclusiveRange() {
        val s = Selection()
        val a = track(1); val b = track(2); val c = track(3); val d = track(4)
        s.trackOrder = listOf(a, b, c, d)
        s.startTrackDrag(d)
        s.dragToTrack(b)
        assertEquals(setOf(2L, 3L, 4L), s.tracks.map { it.id }.toSet())
    }

    @Test fun songDragBegunOnPickedItemUnpicksTheRange() {
        val s = Selection()
        val a = track(1); val b = track(2); val c = track(3); val d = track(4)
        listOf(a, b, c).forEach { s.toggle(it) }   // pre-pick a, b, c
        s.trackOrder = listOf(a, b, c, d)
        s.startTrackDrag(c)   // began on a picked item → un-pick mode
        s.dragToTrack(a)      // drag back across a..c
        assertTrue(s.tracks.isEmpty())
    }

    @Test fun albumDragForwardPicksInclusiveRange() {
        val s = Selection()
        s.albumOrder = listOf(1L, 2L, 3L, 4L)
        s.startAlbumDrag(1L)
        s.dragTo(3L)
        assertEquals(setOf(1L, 2L, 3L), s.albums.toSet())
        assertFalse(s.hasAlbum(4L))
    }

    @Test fun selectAllThenDeselectOverAScope() {
        val s = Selection()
        val a = track(1); val b = track(2); val c = track(3)
        s.register(Selection.Scope(tracks = listOf(a, b, c)))
        assertFalse(s.allPicked)
        s.toggleAll()
        assertTrue(s.allPicked)
        assertEquals(setOf(1L, 2L, 3L), s.tracks.map { it.id }.toSet())
        s.toggleAll()
        assertTrue(s.tracks.isEmpty())
    }

    @Test fun pickedReturnsAlbumTracksInDiscThenTrackOrder() {
        val s = Selection()
        s.toggleAlbum(5)
        val library = listOf(
            track(30, albumId = 5, trackNo = 2, disc = 1),
            track(31, albumId = 5, trackNo = 1, disc = 1),
            track(32, albumId = 5, trackNo = 1, disc = 2),
            track(99, albumId = 7),   // different album — excluded
        )
        assertEquals(listOf(31L, 30L, 32L), s.picked(library).map { it.id })
    }

    @Test fun pickedPutsLooseSongsFirstAndDedupes() {
        val s = Selection()
        s.toggle(track(1))       // a loose pick…
        s.toggleAlbum(5)         // …that also lives in a picked album
        val library = listOf(track(10, albumId = 5, trackNo = 1), track(1, albumId = 5, trackNo = 2))
        assertEquals(listOf(1L, 10L), s.picked(library).map { it.id })
    }

    @Test fun clearResetsPicksAndDragAnchors() {
        val s = Selection()
        val a = track(1); val b = track(2)
        s.trackOrder = listOf(a, b)
        s.startTrackDrag(a)
        s.toggleAlbum(9)
        assertTrue(s.active)
        s.clear()
        assertFalse(s.active)
        assertTrue(s.tracks.isEmpty())
        assertTrue(s.albums.isEmpty())
        assertEquals(null, s.trackDragAnchor)
    }
}
