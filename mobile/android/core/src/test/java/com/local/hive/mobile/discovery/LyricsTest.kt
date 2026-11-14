package com.local.hive.mobile.discovery

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Verifies the compliant LRCLIB lyrics client parses the public API and matches safely. Context-free
 *  (the Context-dependent cache/own-lyrics live in LyricsStore); network is a local MockWebServer. */
class LyricsTest {
    private lateinit var server: MockWebServer
    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }
    private fun lrclib() = Lrclib(OkHttpClient(), server.url("").toString().trimEnd('/'))

    @Test fun exact_prefers_synced_lyrics() {
        server.enqueue(MockResponse().setBody("""{"syncedLyrics":"[00:12.00]one\n[00:15.00]two","plainLyrics":"one\ntwo"}"""))
        val l = lrclib().exact("Daft Punk", "One More Time", "Discovery", 320_000)!!
        assertTrue(l.synced)
        assertEquals("LRCLIB", l.source)
        assertEquals(2, l.lines().size)
    }

    @Test fun exact_falls_back_to_plain_when_no_synced() {
        server.enqueue(MockResponse().setBody("""{"syncedLyrics":"","plainLyrics":"just the words"}"""))
        val l = lrclib().exact("A", "B", "", 0)!!
        assertFalse(l.synced)
        assertEquals("just the words", l.text)
    }

    @Test fun search_keeps_only_a_matching_title_artist_and_close_length() {
        server.enqueue(MockResponse().setBody(
            """[
                 {"trackName":"Wrong Song","artistName":"Daft Punk","duration":200,"syncedLyrics":"[00:01.00]no"},
                 {"trackName":"One More Time","artistName":"Daft Punk","duration":320,"syncedLyrics":"[00:01.00]yes"}
               ]"""))
        val l = lrclib().search("Daft Punk", "One More Time", 320_000)!!
        assertTrue(l.synced)
        assertEquals("yes", l.lines().first().text)
    }

    @Test fun search_rejects_a_different_artist() {
        server.enqueue(MockResponse().setBody(
            """[{"trackName":"One More Time","artistName":"Someone Else","duration":320,"syncedLyrics":"[00:01.00]no"}]"""))
        assertNull(lrclib().search("Daft Punk", "One More Time", 320_000))
    }

    @Test fun search_title_strips_credit_brackets_but_keeps_real_ones() {
        assertEquals("Song", lyricsSearchTitle("Song (feat. Someone)"))
        assertEquals("Song (Live)", lyricsSearchTitle("Song (Live)"))
    }
}
