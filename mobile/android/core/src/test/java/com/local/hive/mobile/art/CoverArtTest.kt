package com.local.hive.mobile.art

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** Verifies the compliant cover providers parse the official APIs correctly and the registry falls back in
 *  order. All network is a local MockWebServer (providers take an injectable base URL). */
class CoverArtTest {
    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }
    @After fun tearDown() { server.shutdown() }
    private fun base() = server.url("/").toString().trimEnd('/')

    @Test fun deezer_album_returns_cover_xl_for_the_matching_title() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"data":[
                 {"title":"Random Access Memories","cover_xl":"https://img/ram_1000.jpg"},
                 {"title":"Something Else","cover_xl":"https://img/other.jpg"}
               ]}"""))
        val url = DeezerCoverProvider(base()).albumArt(AlbumQuery("Daft Punk", "Random Access Memories"))
        assertEquals("https://img/ram_1000.jpg", url)
    }

    @Test fun deezer_artist_picks_exact_name_with_most_fans() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"data":[
                 {"name":"Daft Punk","nb_fan":5000000,"picture_xl":"https://img/dp_big.jpg"},
                 {"name":"Daft Punk Tribute","nb_fan":99,"picture_xl":"https://img/tribute.jpg"}
               ]}"""))
        val url = DeezerCoverProvider(base()).artistImage(ArtistQuery("Daft Punk"))
        assertEquals("https://img/dp_big.jpg", url)
    }

    @Test fun caa_requires_an_mbid_and_returns_the_front_url_on_success() = runTest {
        val p = CoverArtArchiveProvider(base())
        assertNull(p.albumArt(AlbumQuery("A", "B", mbid = null)))
        server.enqueue(MockResponse().setResponseCode(200))
        val url = p.albumArt(AlbumQuery("A", "B", mbid = "release-1234"))
        assertEquals("${base()}/release/release-1234/front-1200", url)
    }

    @Test fun registry_tries_caa_first_when_an_mbid_is_known() = runTest {
        server.enqueue(MockResponse().setResponseCode(200)) // CAA front exists -> wins, Deezer never consulted
        val reg = CoverArtRegistry(listOf(CoverArtArchiveProvider(base()), DeezerCoverProvider(base())))
        val url = reg.albumArt(AlbumQuery("Some Artist", "Some Album", mbid = "mb-9"))
        assertEquals("${base()}/release/mb-9/front-1200", url)
    }

    @Test fun itunes_upscales_the_matched_albums_artwork_url() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"results":[
                 {"collectionName":"Random Access Memories","artistName":"Daft Punk",
                  "artworkUrl100":"https://is1.mzstatic.com/image/thumb/abc/100x100bb.jpg"},
                 {"collectionName":"Discovery","artistName":"Daft Punk",
                  "artworkUrl100":"https://is1.mzstatic.com/image/thumb/xyz/100x100bb.jpg"}
               ]}"""))
        val url = ITunesCoverProvider(base()).albumArt(AlbumQuery("Daft Punk", "Random Access Memories"))
        assertEquals("https://is1.mzstatic.com/image/thumb/abc/1200x1200bb.jpg", url)
    }

    @Test fun itunes_rejects_a_wrong_artist_even_on_a_title_match() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"results":[{"collectionName":"Random Access Memories","artistName":"Some Tribute Band",
                 "artworkUrl100":"https://is1.mzstatic.com/image/thumb/abc/100x100bb.jpg"}]}"""))
        val url = ITunesCoverProvider(base()).albumArt(AlbumQuery("Daft Punk", "Random Access Memories"))
        assertNull(url)
    }

    @Test fun musicbrainz_resolves_the_release_then_returns_its_caa_front() = runTest {
        server.enqueue(MockResponse().setBody(
            """{"releases":[{"id":"abc-123","title":"Random Access Memories","score":100}]}""")) // MB search
        server.enqueue(MockResponse().setResponseCode(200)) // CAA HEAD on the resolved release
        val url = MusicBrainzCoverProvider(mbBase = base(), caaBase = base())
            .albumArt(AlbumQuery("Daft Punk", "Random Access Memories"))
        assertEquals("${base()}/release/abc-123/front-1200", url)
    }

    @Test fun musicbrainz_returns_null_when_the_search_has_no_releases() = runTest {
        server.enqueue(MockResponse().setBody("""{"releases":[]}"""))
        val url = MusicBrainzCoverProvider(mbBase = base(), caaBase = base())
            .albumArt(AlbumQuery("Nobody", "Nothing At All"))
        assertNull(url)
    }

    @Test fun registry_falls_back_to_deezer_when_no_mbid() = runTest {
        server.enqueue(MockResponse().setBody("""{"data":[{"title":"Some Album","cover_xl":"https://img/d.jpg"}]}"""))
        val reg = CoverArtRegistry(listOf(CoverArtArchiveProvider(base()), DeezerCoverProvider(base())))
        val url = reg.albumArt(AlbumQuery("Some Artist", "Some Album")) // no mbid -> CAA returns null -> Deezer
        assertEquals("https://img/d.jpg", url)
    }
}
