package com.local.hive.mobile.data

/**
 * The few genuinely Spotify-specific operations that edition-agnostic (common) code needs, named in :core
 * types only so the shared UI and [MainViewModel] can call them WITHOUT depending on :streaming.
 *
 * The full F-Droid edition ("Hive Mobile") backs this with the real Spotify service; the Google Play edition
 * ("Hive Clean") supplies [NoStreamingGateway], so Spotify is absent from its build entirely. Everything
 * compliant — cover art, metadata, lyrics, radio, podcasts, artist images — is NOT here: it lives in the
 * shared :core `discovery` tier and both editions use it directly.
 */
interface StreamingGateway {
    /** The Spotify album-page URL for a `sp:` song key (without the prefix), or null. */
    suspend fun spotifyAlbumOf(spTrackId: String): String?
    /** Album-cover URLs for bare Spotify song keys (id → cover url); empty when unavailable. */
    suspend fun spotifyCovers(spTrackIds: List<String>): Map<String, String>
    /** The Apple Music album-page URL for an `am:` Apple song id (without the prefix), or null. Defaulted so
     *  editions without :streaming (Hive Clean) answer null and need no override. */
    suspend fun appleAlbumOf(appleSongId: String): String? = null
    /** The Apple Music artist-page URL for an `am:` Apple song id (without the prefix), or null. */
    suspend fun appleArtistOf(appleSongId: String): String? = null
}

/** The streaming gateway for editions built without :streaming (Hive Clean): Spotify is absent. */
object NoStreamingGateway : StreamingGateway {
    override suspend fun spotifyAlbumOf(spTrackId: String): String? = null
    override suspend fun spotifyCovers(spTrackIds: List<String>): Map<String, String> = emptyMap()
}
