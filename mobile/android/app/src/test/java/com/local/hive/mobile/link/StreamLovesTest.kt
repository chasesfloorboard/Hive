package com.local.hive.mobile.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StreamLovesTest {
    @Test fun keysMatchWhatHiveOnThePcStores() {
        // Keys as Hive's streamLoveKey made them for real liked songs.
        val pc = mapOf(
            ("Calvin Harris, Ellie Goulding" to "Free") to "calvinharris|free",
            ("Skrillex, Varg2™, Eurohead, Whitearmor, swedm®" to "Someone Said") to "skrillex|someonesaid",
            ("Brent Faiyaz" to "four seasons.") to "brentfaiyaz|fourseasons",
            ("Peggy Gou" to "(It Goes Like) Nanana (Edit)") to "peggygou|itgoeslikenananaedit",
            ("Calvin Harris" to "I Need Your Love (feat. Ellie Goulding)") to "calvinharris|ineedyourlove",
            ("KETTAMA" to "It Gets Better (Forever Mix)") to "kettama|itgetsbetterforevermix",
            ("Caribou" to "Melody Day (Four Tet Remix) [feat. Luke Lalonde, Adem & One Little Plane] [Mixed]") to "caribou|melodydayfourtetremixmixed",
            ("Beyoncé & Jay-Z" to "Déjà Vu") to "beyonce|dejavu",
            ("Kanye West feat. Rihanna" to "All of the Lights") to "kanyewest|allofthelights",
            ("Røyksopp" to "Eple") to "ryksopp|eple",
            ("Кино" to "Группа крови") to "кино|группакрови",
        )
        for ((song, key) in pc) assertEquals(key, StreamLoves.key(song.first, song.second))
    }

    @Test fun streamedSongsPlayOnThePcThroughYouTubeMusic() {
        assertEquals("ytm:apple:1689088958", StreamLoves.pathFor("am:1689088958"))
        assertEquals("ytm:spotify:4nb7", StreamLoves.pathFor("sp:4nb7"))
        assertEquals("", StreamLoves.pathFor("pc:abc"))
    }

    @Test fun theHeartFollowsLoveForLibrarySongsAndLikesForStreamedOnes() {
        val likes = mapOf("peggygou|nanana" to StreamLove(loved = true, at = 5), "boris|huge" to StreamLove(loved = false, at = 9))
        assertEquals(true, heartFor("12", "x", "y", setOf(12L), likes, emptySet()))
        assertEquals(false, heartFor("artist:Boris|13", "x", "y", setOf(12L), likes, emptySet()))
        assertEquals(true, heartFor("am:1", "Nanana", "Peggy Gou", emptySet(), likes, emptySet()))
        assertEquals(false, heartFor("sp:2", "Other", "Peggy Gou", emptySet(), likes, emptySet()))
        // A PC song: liked or unliked here wins, else Hive's own Love.
        assertEquals(true, heartFor("pc:p1", "Black", "Pearl Jam", emptySet(), likes, setOf("p1")))
        assertEquals(false, heartFor("pc:p1", "Huge", "Boris", emptySet(), likes, setOf("p1")))
        assertNull(heartFor("radio:x", "Live", "Station", emptySet(), likes, emptySet()))
        assertNull(heartFor("pod:abc", "Episode", "Show", emptySet(), likes, emptySet()))
        assertNull(heartFor(null, "", "", emptySet(), likes, emptySet()))
    }
}
