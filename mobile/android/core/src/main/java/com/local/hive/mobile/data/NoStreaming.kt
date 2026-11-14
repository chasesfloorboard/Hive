package com.local.hive.mobile.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * No-op implementations of the streaming ports, for editions built without :streaming (Hive Clean). They
 * report "off" and do nothing, so the playback layer behaves exactly as if streaming were never installed.
 * ([NoStreamingGateway] lives next door in StreamingGateway.kt; the podcast store is the real compliant one
 * from :core/discovery, shared by both editions.)
 */

/** YouTube Music, absent: always disabled, nothing to resolve. */
object NoYouTubeMusic : YouTubeMusicPort {
    override val enabled: StateFlow<Boolean> = MutableStateFlow(false)
    override fun resolve(song: WantedSong): String = throw UnsupportedOperationException("YouTube Music is not available in this edition")
    override fun radio(song: WantedSong, max: Int): List<StreamTrack> = emptyList()
    override fun invalidate(key: String) {}
}

/** Scrobbling, absent: never reports a listen. */
object NoScrobbler : ScrobblerPort {
    override suspend fun nowPlaying(l: Listen) {}
    override suspend fun scrobble(l: Listen?) {}
}
