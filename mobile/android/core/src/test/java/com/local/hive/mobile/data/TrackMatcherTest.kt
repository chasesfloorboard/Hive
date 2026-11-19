package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File

class TrackMatcherTest {
    private fun c(key: String, title: String, artist: String, durationMs: Long = 200_000, albumArtist: String = "") =
        TrackMatcher.Candidate(key, title, artist, albumArtist, durationMs)

    @Test fun aSingleAndTheSameSongOnItsAlbumGoToTheRightCopy() {
        val index = TrackMatcher.Index(listOf(
            TrackMatcher.Candidate("single", "Music", "underscores", "underscores", 180_000, "Music - Single"),
            TrackMatcher.Candidate("album", "Music", "underscores", "underscores", 180_000, "U"),
        ))
        assertEquals("album", index.match("Music", "underscores", "", 180_000, "U")?.key)
        assertEquals("single", index.match("Music", "underscores", "", 180_000, "Music - Single")?.key)
        // No album known: the closest length decides, as before.
        assertTrue(index.match("Music", "underscores", "", 180_000) != null)
    }

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

    /** The vectors Hive's own matcher (app/main/song-match.js) is tested with: both must agree. */
    @Test fun agreesWithHiveOnSharedVectors() {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "test/fixtures/song-match-vectors.json") }.first { it.exists() }
        val root = Json.parseToJsonElement(file.readText()) as JsonObject
        for (pair in root["normalize"]!!.jsonArray) {
            val (input, expected) = pair.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(input, expected, TrackMatcher.normalize(input))
        }
        for (case in root["cases"]!!.jsonArray.map { it as JsonObject }) {
            val index = TrackMatcher.Index(case["candidates"]!!.jsonArray.map { row ->
                val r = row.jsonArray
                c(r[0].jsonPrimitive.content, r[1].jsonPrimitive.content, r[2].jsonPrimitive.content, r[4].jsonPrimitive.long, r[3].jsonPrimitive.content)
            })
            val q = case["query"] as JsonArray
            val got = index.match(q[0].jsonPrimitive.content, q[1].jsonPrimitive.content, q[2].jsonPrimitive.content, q[3].jsonPrimitive.long)?.key
            val expected = case["expect"].takeUnless { it is JsonNull }?.jsonPrimitive?.content
            assertEquals(case["name"]!!.jsonPrimitive.content, expected, got)
        }
    }

    @Test fun derivativeMismatchDetectsInstrumentalsCoversAndVariations() {
        assertTrue(hasDerivativeKeywords("All Eyes On Me (Instrumental)"))
        assertTrue(hasDerivativeKeywords("Clipse - All Eyes On Me [Inst]"))
        assertTrue(hasDerivativeKeywords("Song (Acapella)"))
        assertTrue(hasDerivativeKeywords("Song (A Cappella)"))
        assertTrue(hasDerivativeKeywords("Song (Karaoke Version)"))
        assertTrue(hasDerivativeKeywords("Song (Slowed + Reverb)"))
        assertTrue(hasDerivativeKeywords("Song (Sped Up)"))
        assertTrue(hasDerivativeKeywords("Song (Nightcore)"))

        // Ambient, regular titles, and musical terms do not trigger
        assertTrue(!hasDerivativeKeywords("All Eyes On Me (feat. Keri Hilson)"))
        assertTrue(!hasDerivativeKeywords("Ambient 1: Music for Airports"))
        assertTrue(!hasDerivativeKeywords("Selected Ambient Works 85-92"))
        assertTrue(!hasDerivativeKeywords("Structures from Silence"))
        assertTrue(!hasDerivativeKeywords("Digital Reverb"))
        assertTrue(!hasDerivativeKeywords("Cover Me"))
        assertTrue(!hasDerivativeKeywords("Instant Karma!"))
        assertTrue(!hasDerivativeKeywords("Recovery"))
        assertTrue(!hasDerivativeKeywords("Discovery"))
        assertTrue(!hasDerivativeKeywords("Undercover"))

        // Mismatches for standard vocal tracks
        assertTrue(isDerivativeMismatch("All Eyes On Me", "All Eyes On Me (Instrumental)"))
        assertTrue(isDerivativeMismatch("All Eyes On Me", "Clipse - All Eyes On Me [Inst]"))
        assertTrue(isDerivativeMismatch("All Eyes On Me (Instrumental)", "All Eyes On Me"))
        assertTrue(!isDerivativeMismatch("All Eyes On Me", "All Eyes On Me (feat. Keri Hilson)"))
        assertTrue(!isDerivativeMismatch("All Eyes On Me (Instrumental)", "Clipse - All Eyes On Me (Instrumental)"))

        // When the user specifically requests an instrumental release, instrumental candidates are allowed
        assertTrue(!isDerivativeMismatch("All Eyes On Me", "All Eyes On Me (Instrumental)", wantedAllowed = true))
    }
}
