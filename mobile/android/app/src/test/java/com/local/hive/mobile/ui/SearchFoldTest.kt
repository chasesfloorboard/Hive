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
}
