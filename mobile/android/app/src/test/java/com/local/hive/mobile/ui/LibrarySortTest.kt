package com.local.hive.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class LibrarySortTest {
    private val titles = listOf("The Avalanches", "!", "\"Excuse Me\"", "abba", "Björk", "bjork", "Zebra", "a Tribe", "2 Become 1", "10 Songs", "Ænima", "", "an Ending")

    @Test fun sameOrderAsComparingKeysDirectly() {
        val old = titles.sortedWith(compareBy(LibrarySort.collator) { LibrarySort.key(it) })
        assertEquals(old, LibrarySort.sorted(titles) { it })
    }

    @Test fun tieBreakApplies() {
        data class T(val artist: String, val n: Int)
        val items = listOf(T("Pixies", 3), T("The Pixies", 1), T("pixies", 2), T("Abba", 9))
        assertEquals(listOf(9, 1, 2, 3), LibrarySort.sorted(items, compareBy { it.n }) { it.artist }.map { it.n })
    }
}
