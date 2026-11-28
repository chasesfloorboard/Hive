package com.local.hive.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NowArtworkResolverTest {

    @Test
    fun realAlbumTrackUsesLiveAlbumIdOverStalePlayerUri() {
        val staleSongUri = "content://media/external/audio/media/42/albumart"
        assertEquals(
            "content://media/external/audio/albumart/900",
            NowArtworkResolver.resolve(
                nowArtworkUri = staleSongUri,
                trackId = 42L,
                trackAlbum = "Example EP",
                trackAlbumId = 900L,
            ),
        )
    }

    @Test
    fun looseCollectionTrackUsesOwnSongArtUri() {
        assertEquals(
            "content://media/external/audio/media/42/albumart",
            NowArtworkResolver.resolve(
                nowArtworkUri = "content://media/external/audio/albumart/900",
                trackId = 42L,
                trackAlbum = "",
                trackAlbumId = 900L,
            ),
        )
        assertEquals(
            "content://media/external/audio/media/42/albumart",
            NowArtworkResolver.resolve(
                nowArtworkUri = "content://media/external/audio/albumart/900",
                trackId = 42L,
                trackAlbum = "<unknown>",
                trackAlbumId = 900L,
            ),
        )
    }

    @Test
    fun hiddenAlbumCoverReturnsNullForLocalAlbumTrack() {
        assertNull(
            NowArtworkResolver.resolve(
                nowArtworkUri = "content://media/external/audio/albumart/900",
                trackId = 42L,
                trackAlbum = "Example EP",
                trackAlbumId = 900L,
                hiddenAlbumCovers = setOf(900L),
            ),
        )
    }

    @Test
    fun nonLibraryTrackFallsBackToPlayerArtworkUri() {
        val streamCover = "https://example.com/cover.jpg"
        assertEquals(
            streamCover,
            NowArtworkResolver.resolve(
                nowArtworkUri = streamCover,
                trackId = null,
                trackAlbum = null,
                trackAlbumId = null,
            ),
        )
    }

    @Test
    fun negativeWavAlbumIdPreservedForLocalTrack() {
        assertEquals(
            "content://media/external/audio/albumart/-42",
            NowArtworkResolver.resolve(
                nowArtworkUri = null,
                trackId = 42L,
                trackAlbum = "Studio Masters",
                trackAlbumId = -42L,
            ),
        )
    }
}
