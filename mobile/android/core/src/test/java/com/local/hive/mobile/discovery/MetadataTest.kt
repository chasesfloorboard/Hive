package com.local.hive.mobile.discovery

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Verifies the compliant MusicBrainz metadata provider parses the official web service correctly. All
 *  network is a local MockWebServer (the provider takes an injectable base URL). */
class MetadataTest {
    private lateinit var server: MockWebServer
    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }
    private fun base() = server.url("/ws/2").toString().trimEnd('/')

    @Test fun search_parses_releases_with_artist_credit_year_and_caa_cover() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"releases":[
                 {"id":"rel-1","title":"Discovery","date":"2001-03-12","track-count":14,
                  "artist-credit":[{"name":"Daft Punk","joinphrase":""}],
                  "cover-art-archive":{"front":"true"}},
                 {"id":"rel-2","title":"No Cover","date":"1999","track-count":3,
                  "artist-credit":[{"name":"A","joinphrase":" & "},{"name":"B","joinphrase":""}],
                  "cover-art-archive":{"front":"false"}}
               ]}"""))
        val hits = MusicBrainzMetadata(base()).searchAlbums("Daft Punk Discovery")
        assertEquals(2, hits.size)
        assertEquals("rel-1", hits[0].id)
        assertEquals("Discovery", hits[0].title)
        assertEquals("Daft Punk", hits[0].artist)
        assertEquals("2001", hits[0].year)
        assertEquals(14, hits[0].trackCount)
        assertEquals("https://coverartarchive.org/release/rel-1/front-500", hits[0].coverUrl)
        // joinphrase builds a combined credit; no front cover -> empty cover url.
        assertEquals("A & B", hits[1].artist)
        assertEquals("", hits[1].coverUrl)
    }

    @Test fun search_blank_query_makes_no_request() = runTest {
        val hits = MusicBrainzMetadata(base()).searchAlbums("   ")
        assertTrue(hits.isEmpty())
        assertEquals(0, server.requestCount)
    }

    @Test fun album_parses_tracklist_across_discs_with_recording_fallback() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"id":"rel-1","title":"Discovery","date":"2001-03-12",
                "artist-credit":[{"name":"Daft Punk","joinphrase":""}],
                "cover-art-archive":{"front":"true"},
                "media":[
                  {"track-count":2,"tracks":[
                    {"number":"1","position":1,"title":"One More Time","length":320000,
                     "artist-credit":[{"name":"Daft Punk","joinphrase":""}]},
                    {"number":"2","position":2,
                     "recording":{"title":"Aerodynamic","length":224000}}
                  ]},
                  {"track-count":1,"tracks":[
                    {"number":"1","position":1,"title":"Disc Two Opener","length":100000}
                  ]}
                ]}"""))
        val a = MusicBrainzMetadata(base()).album("rel-1")!!
        assertEquals("Discovery", a.title)
        assertEquals("Daft Punk", a.artist)
        assertEquals("2001", a.year)
        assertEquals("https://coverartarchive.org/release/rel-1/front-1200", a.coverUrl)
        assertEquals(3, a.tracks.size)
        // Track 1: own title/length/credit.
        assertEquals("One More Time", a.tracks[0].title)
        assertEquals(1, a.tracks[0].trackNumber); assertEquals(1, a.tracks[0].discNumber)
        assertEquals(320000L, a.tracks[0].durationMs)
        // Track 2: title + length fall back to the recording; artist falls back to the album artist.
        assertEquals("Aerodynamic", a.tracks[1].title)
        assertEquals(224000L, a.tracks[1].durationMs)
        assertEquals("Daft Punk", a.tracks[1].artist)
        // Disc 2 numbering.
        assertEquals(2, a.tracks[2].discNumber); assertEquals(1, a.tracks[2].trackNumber)
        assertEquals("Disc Two Opener", a.tracks[2].title)
    }

    @Test fun album_blank_id_returns_null_without_a_request() = runTest {
        assertNull(MusicBrainzMetadata(base()).album(""))
        assertEquals(0, server.requestCount)
    }

    @Test fun itunes_cover_search_upscales_and_drops_untitled_results() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"results":[
                 {"collectionId":123,"collectionName":"Discovery","artistName":"Daft Punk",
                  "artworkUrl100":"https://is1.mzstatic.com/image/x/100x100bb.jpg"},
                 {"collectionName":"","artistName":"No Title","artworkUrl100":"https://x/100x100bb.jpg"}
               ]}"""))
        val root = server.url("/").toString().trimEnd('/')
        val hits = ITunesCoverSearch(root).search("Daft Punk Discovery")
        assertEquals(1, hits.size)
        assertEquals("Discovery", hits[0].title)
        assertEquals("Daft Punk", hits[0].artist)
        assertEquals("https://is1.mzstatic.com/image/x/300x300bb.jpg", hits[0].thumbUrl)
        assertEquals("https://is1.mzstatic.com/image/x/1200x1200bb.jpg", hits[0].fullUrl)
    }

    @Test fun itunes_cover_search_blank_query_makes_no_request() = runTest {
        assertTrue(ITunesCoverSearch(server.url("/").toString().trimEnd('/')).search("  ").isEmpty())
        assertEquals(0, server.requestCount)
    }
}
