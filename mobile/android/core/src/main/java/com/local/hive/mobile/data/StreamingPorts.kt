package com.local.hive.mobile.data

import android.net.Uri
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable

/**
 * The narrow contracts the playback layer needs from the streaming world, defined in :core so that
 * :playback (and the shared UI) can name them WITHOUT depending on :streaming. The full F-Droid edition
 * ("Hive Mobile") wires in :streaming's concrete classes, which implement these; the Google Play edition
 * ("Hive Clean") supplies no-op implementations, so :streaming is absent from its build entirely.
 *
 * The data carriers [WantedSong] and [Listen] live here too; :streaming keeps its historical
 * `com.local.hive.mobile.stream.WantedSong` / `…stream.Listen` names as typealiases onto these, so no
 * streaming or app code changes when they move.
 */

/** A song Hive wants to stream in full because the phone doesn't have it. */
data class WantedSong(
    val key: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
)

/** One listen, for Last.fm now-playing and scrobbling. Serialized for the scrobbler's pending-listen queue. */
@Serializable
data class Listen(
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val startedAt: Long,
    val service: String = "",
)

/** The `ytm://` address a streamed song is played from when it comes from YouTube Music. */
fun ytmUriFor(s: WantedSong): String = Uri.Builder().scheme("ytm").authority("song")
    .appendQueryParameter("key", s.key).appendQueryParameter("title", s.title).appendQueryParameter("artist", s.artist)
    .appendQueryParameter("album", s.album).appendQueryParameter("duration", s.durationMs.toString()).build().toString()

/** Parse a `ytm://` uri back into the [WantedSong] it was built from, or null if it isn't one. */
fun wantedFrom(uri: Uri): WantedSong? = if (uri.scheme != "ytm") null else WantedSong(
    uri.getQueryParameter("key") ?: return null, uri.getQueryParameter("title").orEmpty(), uri.getQueryParameter("artist").orEmpty(),
    uri.getQueryParameter("album").orEmpty(), uri.getQueryParameter("duration")?.toLongOrNull() ?: 0,
)

/** What the playback service needs of YouTube Music. `stream.YouTubeMusic` implements it. */
interface YouTubeMusicPort {
    val enabled: StateFlow<Boolean>
    /** The playable address for [song]; blocking, so call it off the main thread. Throws if no match. */
    fun resolve(song: WantedSong): String
    /** YouTube Music radio seeded from [song] (for Auto DJ), already matched, without [song] itself. */
    fun radio(song: WantedSong, max: Int = 25): List<StreamTrack>
    /** Forget [key]'s cached audio link (it was refused), so the next resolve fetches a new one. */
    fun invalidate(key: String)
}

/** What the playback service needs of the Last.fm scrobbler. `stream.Scrobbler` implements it. */
interface ScrobblerPort {
    suspend fun nowPlaying(l: Listen)
    suspend fun scrobble(l: Listen?)
}

/** What the playback service needs of the podcast progress store. `stream.PodcastStore` implements it. */
interface PodcastStorePort {
    val progress: StateFlow<Map<String, Long>>
    fun setProgress(mediaId: String, positionMs: Long)

    companion object {
        /** Progress sentinel: the episode has been played to the end. */
        const val FINISHED = -1L
    }
}
