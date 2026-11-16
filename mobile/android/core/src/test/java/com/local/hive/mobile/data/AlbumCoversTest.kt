package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlbumCoversTest {
    @Test fun aClearedAlbumHasNoCoverModel() {
        assertNull(AlbumCovers.model(42, setOf(42)))
    }

    @Test fun anAlbumThatIsNotClearedKeepsItsAlbumArtAddress() {
        assertEquals("content://media/external/audio/albumart/42", AlbumCovers.model(42, emptySet()))
        // Another album being cleared doesn't touch this one.
        assertEquals("content://media/external/audio/albumart/42", AlbumCovers.model(42, setOf(7)))
    }

    @Test fun negativeOwnAlbumIdsWorkToo() {
        // Hive's own album ids (WAV songs) are negative; they clear and resolve the same way.
        assertEquals("content://media/external/audio/albumart/-5", AlbumCovers.model(-5, emptySet()))
        assertNull(AlbumCovers.model(-5, setOf(-5)))
    }
}
