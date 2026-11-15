package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class TrackEditTest {
    private val base = Track(
        id = 7, title = "Old Title", artist = "Old Artist", album = "Old Album", albumArtist = "Old AA",
        albumId = 42, durationMs = 180_000, trackNumber = 3, discNumber = 1, year = 2010, genre = "Old Genre",
        folder = "/music/x", fileName = "x.mp3", dateAdded = 1, sizeBytes = 100,
    )

    @Test fun applies_set_fields_and_keeps_identity() {
        val out = base.applying(TagEdit(title = "New", artist = "A", album = "OCTANE", albumArtist = "Don Toliver", year = "2026", track = "5", genre = "Rap"))
        assertEquals("New", out.title)
        assertEquals("A", out.artist)
        assertEquals("OCTANE", out.album)
        assertEquals("Don Toliver", out.albumArtist)
        assertEquals(2026, out.year)
        assertEquals(5, out.trackNumber)
        assertEquals("Rap", out.genre)
        // Identity + things the edit doesn't touch are preserved (albumId especially — MediaStore owns it).
        assertEquals(7, out.id)
        assertEquals(42, out.albumId)
        assertEquals("x.mp3", out.fileName)
        assertEquals(180_000, out.durationMs)
        assertEquals(1, out.discNumber)
    }

    @Test fun null_fields_leave_values_unchanged() {
        val out = base.applying(TagEdit(title = "Only title"))
        assertEquals("Only title", out.title)
        assertEquals("Old Artist", out.artist)
        assertEquals("Old Album", out.album)
        assertEquals(2010, out.year)
        assertEquals(3, out.trackNumber)
    }

    @Test fun blank_fields_clear_the_value() {
        val out = base.applying(TagEdit(album = "", year = "", track = ""))
        assertEquals("", out.album)
        assertEquals(0, out.year)
        assertEquals(0, out.trackNumber)
        // A year that isn't a number is cleared too, never left half-set.
        assertEquals(0, base.applying(TagEdit(year = "n/a")).year)
    }
}
