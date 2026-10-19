package com.local.hive.mobile.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrackMatcherTest {
    private fun c(key: String, title: String, artist: String, durationMs: Long = 200_000, albumArtist: String = "") =
        TrackMatcher.Candidate(key, title, artist, albumArtist, durationMs)

    @Test fun matchesAcrossFeatCreditsAndPunctuation() {
        val index = TrackMatcher.Index(listOf(c("pc1", "Together (feat. Nikki Nair, Jessy Lanza & Prentiss)", "The Avalanches")))
        assertEquals("pc1", index.match("Together", "The Avalanches", "", 201_000)?.key)
    }

    @Test fun multiArtistTagsOverlap() {
        // Samsung Music showed "Flume/KUČKA/SOPHIE"; Hive may hold just the lead artist.
        val index = TrackMatcher.Index(listOf(c("pc1", "Voices", "Flume")))
        assertEquals("pc1", index.match("Voices", "Flume/KUČKA/SOPHIE", "", 200_000)?.key)
    }

    @Test fun differentArtistWithSameTitleDoesNotMatch() {
        val index = TrackMatcher.Index(listOf(c("pc1", "Black", "Sevdaliza")))
        assertNull(index.match("Black", "Pearl Jam", "", 343_000))
    }

    @Test fun durationPicksBetweenVersions() {
        val index = TrackMatcher.Index(listOf(c("studio", "Debaser", "Pixies", 172_000), c("live", "Debaser", "Pixies", 260_000)))
        assertEquals("live", index.match("Debaser", "Pixies", "", 258_500)?.key)
        assertEquals("studio", index.match("Debaser", "Pixies", "", 171_000)?.key)
    }

    @Test fun farOffDurationIsADifferentRecording() {
        val index = TrackMatcher.Index(listOf(c("pc1", "Huge", "Boris", 201_000)))
        assertNull(index.match("Huge", "Boris", "", 600_000))
    }

    @Test fun unicodeTitlesNormalize() {
        val index = TrackMatcher.Index(listOf(c("pc1", "James Bonb D - Nipples", "Orange Doll 橘娃娃")))
        assertEquals("pc1", index.match("James Bonb D - Nipples", "Orange Doll 橘娃娃", "", 200_000)?.key)
        assertEquals("beyonce", TrackMatcher.normalize("Beyoncé"))
    }
}
