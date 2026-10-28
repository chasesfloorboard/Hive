package com.local.hive.mobile.stream

import org.junit.Assert.assertEquals
import org.junit.Test

class SeekerTest {
    @Test fun searchesUseTheFirstArtistAndTheAlbumAsFoldersNameIt() {
        assertEquals("Peggy Gou I Hear You", Seeker.albumQuery("Peggy Gou", "I Hear You"))
        assertEquals("Kanye West My Beautiful Dark Twisted Fantasy", Seeker.albumQuery("Kanye West, Rihanna", "My Beautiful Dark Twisted Fantasy (Deluxe Edition)"))
        assertEquals("ISOxo kidsgonemad!", Seeker.albumQuery("ISOxo", "kidsgonemad! [Remastered 2024]"))
        assertEquals("Skrillex Someone Said", Seeker.albumQuery("Skrillex & Varg2™", "Someone Said - Single"))
        assertEquals("clipping. CLPPNG", Seeker.albumQuery("clipping.", "CLPPNG"))
    }
}
