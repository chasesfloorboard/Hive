package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class FavoriteOrderRulesTest {
    private data class Tile(val key: String, val addedAt: Long)

    @Test fun unlikingDropsSavedPositionAndRelikingMovesToTop() {
        val savedOrder = listOf("album:a", "artist:b", "playlist:c", "album:d")
        // User unlikes "album:d" (which was at position 3)
        val afterUnlike = FavoriteOrderRules.forgetKeys(savedOrder, "album:d")
        assertEquals(listOf("album:a", "artist:b", "playlist:c"), afterUnlike)

        // User re-likes "album:d" with a fresh timestamp -> MUST jump to index 0 (very top)!
        val tiles = listOf(
            Tile("album:a", 100),
            Tile("artist:b", 200),
            Tile("playlist:c", 300),
            Tile("album:d", 999),
        )
        val arranged = FavoriteOrderRules.arrange(tiles, afterUnlike, { it.key }, { it.addedAt })
        assertEquals(listOf("album:d", "album:a", "artist:b", "playlist:c"), arranged.map { it.key })
    }

    @Test fun multipleFreshLikesSortNewestFirstAheadOfSavedOrder() {
        val savedOrder = listOf("album:old1", "album:old2")
        val tiles = listOf(
            Tile("album:old2", 10),
            Tile("album:old1", 20),
            Tile("artist:new1", 500),
            Tile("playlist:new2", 800),
        )
        val arranged = FavoriteOrderRules.arrange(tiles, savedOrder, { it.key }, { it.addedAt })
        assertEquals(listOf("playlist:new2", "artist:new1", "album:old1", "album:old2"), arranged.map { it.key })
    }
}
