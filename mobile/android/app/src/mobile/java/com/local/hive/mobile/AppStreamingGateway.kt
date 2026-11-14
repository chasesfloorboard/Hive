package com.local.hive.mobile

import com.local.hive.mobile.data.StreamingGateway
import com.local.hive.mobile.stream.AppleMusic
import com.local.hive.mobile.stream.Spotify

/**
 * Hive Mobile's [StreamingGateway]: the genuinely Spotify-specific operations common code needs, backed by
 * the real service. (Hive Clean uses [com.local.hive.mobile.data.NoStreamingGateway], so Spotify is absent.)
 * Everything compliant — cover art, metadata, lyrics, radio, podcasts, artist images — is NOT here; it lives
 * in the shared :core `discovery` tier and both editions use it directly.
 */
class AppStreamingGateway(private val spotify: Spotify, private val appleMusic: AppleMusic) : StreamingGateway {
    override suspend fun spotifyAlbumOf(spTrackId: String): String? = spotify.albumOf(spTrackId)
    override suspend fun spotifyCovers(spTrackIds: List<String>): Map<String, String> = spotify.covers(spTrackIds)
    override suspend fun appleAlbumOf(appleSongId: String): String? = appleMusic.songLinks(appleSongId).first
    override suspend fun appleArtistOf(appleSongId: String): String? = appleMusic.songLinks(appleSongId).second
}
