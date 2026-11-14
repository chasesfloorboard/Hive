package com.local.hive.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import com.local.hive.mobile.HiveApp

/**
 * The streaming-only view-model surface — Apple Music, Spotify, radio, podcasts, lyrics and the
 * Apple-catalogue album lookup used by Auto-tag. It is present only in the full F-Droid edition
 * ("Hive Mobile"); its screens live in the mobile source set and Hive Clean never builds it.
 *
 * Everything here returns a :streaming type, which is exactly why it can't live on the edition-agnostic
 * [MainViewModel]. Playback, importing and liking of streamed songs stay on [MainViewModel] (they use
 * only :core types), so a streaming screen takes both the shared `vm` and this `svm`.
 */
class StreamingVm(private val app: HiveApp) {
    // ---- Apple Music and Spotify ----
    val appleMusic get() = app.appleMusic
    val spotify get() = app.spotify
    val spotifyAccount get() = app.spotifyAccount
    val appleAccount get() = app.appleAccount
    val appleUser = app.appleAccount.user
    val spotifyUser = app.spotifyAccount.user

    /** Spotify search, with this phone's own sign-in (Hive on the PC no longer starts its Spotify app to search). */
    suspend fun searchSpotify(q: String): com.local.hive.mobile.stream.SpotifyAccount.Results {
        if (spotifyUser.value.signedIn) return app.spotifyAccount.search(q)
        // No sign-in: the same albums are found on Apple Music's open catalogue, and each one's Spotify
        // link is resolved on demand when it is shared. (Spotify links still open without a sign-in.)
        val am = app.appleMusic.search(q)
        return com.local.hive.mobile.stream.SpotifyAccount.Results(
            playlists = emptyList(),
            albums = am.albums.map { com.local.hive.mobile.stream.SpCard("album", it.id, it.name, it.curator, it.artwork, sourceUrl = it.url.ifBlank { "https://music.apple.com/us/album/x/${it.id}" }) },
            songs = emptyList(),
        )
    }

    // ---- scrobbling (Last.fm / ListenBrainz sign-in lives on the concrete Scrobbler) ----
    val scrobbler get() = app.scrobbler

}

/** The [StreamingVm] for the running app, remembered for the current composition (Hive Mobile only). */
@Composable
fun rememberStreamingVm(): StreamingVm {
    val app = LocalContext.current.applicationContext as HiveApp
    return remember { StreamingVm(app) }
}
