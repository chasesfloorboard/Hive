package com.local.hive.mobile.ui

import org.junit.Assert.assertTrue
import org.junit.Test

class SearchFoldTest {
    @Test fun `search ignores case, accents and ligatures`() {
        assertTrue("aenima" in LibrarySort.fold("Ænima"))
        assertTrue("bjork" in LibrarySort.fold("Björk"))
        assertTrue("beyonce" in LibrarySort.fold("BEYONCÉ"))
        assertTrue("sigur ros" in LibrarySort.fold("Sigur Rós"))
        assertTrue("motorhead" in LibrarySort.fold("Motörhead"))
    }

    @Test fun `search finds every word in any order, ignoring brackets`() {
        val song = "(It Goes Like) Nanana (Edit) Peggy Gou I Hear You"
        for (q in listOf("nanana", "it goes like", "edit", "Nanana (Edit)", "edit nanana", "peggy nanana", "goes nanana", "NANANA"))
            assertTrue(q, LibrarySort.matches(song, LibrarySort.words(q)))
        assertTrue(!LibrarySort.matches(song, LibrarySort.words("nanana remix")))
        assertTrue(LibrarySort.words("  ").isEmpty())
    }
}
