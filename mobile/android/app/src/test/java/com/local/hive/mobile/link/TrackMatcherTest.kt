package com.local.hive.mobile.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
