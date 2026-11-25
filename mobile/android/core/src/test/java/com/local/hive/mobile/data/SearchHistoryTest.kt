package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class SearchHistoryTest {
    @Test fun recordDeduplicatesCaseInsensitivelyMovesToTopAndCaps() {
        var list = emptyList<String>()
        list = SearchHistoryRules.record(list, "a") // too short (< 2)
        assertEquals(emptyList<String>(), list)

        list = SearchHistoryRules.record(list, "Loscil")
        list = SearchHistoryRules.record(list, "  Björk  ")
        list = SearchHistoryRules.record(list, "loscil")
        assertEquals(listOf("loscil", "Björk"), list)

        for (i in 1..25) list = SearchHistoryRules.record(list, "Artist $i", max = 10)
        assertEquals(10, list.size)
        assertEquals("Artist 25", list.first())
    }

    @Test fun suggestPrioritizesPrefixMatchesAndRemoveDeletesOne() {
        val history = listOf("Radiohead", "Loscil", "First Narrows", "Boards of Canada", "Radio Dept")
        assertEquals(listOf("Radiohead", "Radio Dept"), SearchHistoryRules.suggest(history, "rad"))
        assertEquals(listOf("First Narrows"), SearchHistoryRules.suggest(history, "narrow"))
        assertEquals(emptyList<String>(), SearchHistoryRules.suggest(history, "loscil"))
        assertEquals(history.take(3), SearchHistoryRules.suggest(history, "", limit = 3))

        val afterRemove = SearchHistoryRules.remove(history, "LOSCIL")
        assertEquals(listOf("Radiohead", "First Narrows", "Boards of Canada", "Radio Dept"), afterRemove)
    }
}
