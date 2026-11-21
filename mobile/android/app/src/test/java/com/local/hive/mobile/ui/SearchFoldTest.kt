package com.local.hive.mobile.ui

import org.junit.Assert.assertEquals
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

    @Test fun `search collapses acronym dots and currency symbols`() {
        assertEquals(listOf("nerd"), LibrarySort.words("n.e.r.d"))
        assertEquals(listOf("nerd"), LibrarySort.words("N.E.R.D."))
        assertEquals(listOf("asap", "rocky"), LibrarySort.words("A\$AP Rocky"))
        assertTrue(LibrarySort.matches("N.E.R.D.", LibrarySort.words("n.e.r.d")))
        assertTrue(LibrarySort.matches("Pegboard Nerds", LibrarySort.words("n.e.r.d")))
        assertTrue(!LibrarySort.matches("30 Seconds To Mars", LibrarySort.words("n.e.r.d")))
        assertTrue(!LibrarySort.matches("A\$AP Rocky", LibrarySort.words("n.e.r.d")))
    }

    @Test fun `search requires word-boundary matching for short words`() {
        assertTrue(LibrarySort.matches("Red Alert", LibrarySort.words("red")))
        assertTrue(!LibrarySort.matches("2 Xame Filtered", LibrarySort.words("red")))
        assertTrue(!LibrarySort.matches("mirrored heart", LibrarySort.words("red")))
        assertTrue(LibrarySort.matches("In The End", LibrarySort.words("in")))
        assertTrue(!LibrarySort.matches("Shining Like The Sun", LibrarySort.words("in")))
    }

    @Test fun `search finds every word in any order, ignoring brackets`() {
        val song = "(It Goes Like) Nanana (Edit) Peggy Gou I Hear You"
        for (q in listOf("nanana", "it goes like", "edit", "Nanana (Edit)", "edit nanana", "peggy nanana", "goes nanana", "NANANA"))
            assertTrue(q, LibrarySort.matches(song, LibrarySort.words(q)))
        assertTrue(!LibrarySort.matches(song, LibrarySort.words("nanana remix")))
        assertTrue(LibrarySort.words("  ").isEmpty())
    }
}
