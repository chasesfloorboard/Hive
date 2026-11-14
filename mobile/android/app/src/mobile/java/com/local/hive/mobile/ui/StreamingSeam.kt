package com.local.hive.mobile.ui

import androidx.compose.ui.unit.Dp
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.data.Track
import kotlinx.coroutines.launch

/**
 * Hive Mobile's real implementations of the streaming/soulseek seams that edition-agnostic (src/main) code
 * calls. Hive Clean (src/clean) defines the same names as no-ops, so :streaming and :soulseek are absent
 * from the Play build. Everything compliant (radio, podcasts, lyrics, covers, metadata, artist images) is NOT
 * seamed — it lives in the shared base and the :core/discovery tier, so both editions use it directly.
 */

/** The Apple Music + Spotify navigation pages (absent in Hive Clean). */
internal fun NavGraphBuilder.streamingRoutes(
    vm: MainViewModel,
    nav: NavHostController,
    bottomPadding: Dp,
    onOpenSettings: () -> Unit,
    appleRoute: (String) -> String,
    onOpenPlaylist: (Long) -> Unit,
    onToast: (String) -> Unit,
) {
    fun enc(s: String) = android.net.Uri.encode(s)
    page("apple") {
        AppleMusicScreen(vm, bottomPadding, onBack = { nav.popBackStack() }, onOpenSettings = onOpenSettings) { url -> nav.navigate(appleRoute(url)) }
    }
    page("apple/a?url={url}") { entry ->
        AppleArtistScreen(vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() }) { url -> nav.navigate(appleRoute(url)) }
    }
    page("apple/c?url={url}") { entry ->
        AppleCollectionScreen(
            vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() },
            onOpen = { url -> nav.navigate(appleRoute(url)) }, onOpenPlaylist = onOpenPlaylist, onToast = onToast,
        )
    }
    page("spotify") {
        SpotifyScreen(vm, bottomPadding, onBack = { nav.popBackStack() }, onOpenSettings = onOpenSettings) { url -> nav.navigate(if ("open.spotify.com" in url) "spotify/c?url=${enc(url)}" else appleRoute(url)) }
    }
    page("spotify/c?url={url}") { entry ->
        SpotifyCollectionScreen(vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() }, onOpenPlaylist = onOpenPlaylist, onToast = onToast)
    }
}

/** Whether Soulseek downloading is set up (always false in Hive Clean, which has no Soulseek). */
fun soulseekConfigured(context: android.content.Context): Boolean =
    com.local.hive.mobile.soulseek.SoulseekSettings(context).configured

/** Whether online (Apple Music / Spotify) catalogue search is offered (false in Hive Clean). */
fun streamingSearchAvailable(): Boolean = true

/** Completes a Spotify OAuth redirect back into the app (a no-op in Hive Clean). */
fun completeSpotifyReturn(app: android.app.Application, data: android.net.Uri) {
    (app as? HiveApp)?.let { it.scope.launch { it.spotifyAccount.complete(data) } }
}

/**
 * A lossy song Hive downloaded itself from Soulseek (a lossless copy wasn't found then): a
 * lossless copy can still replace it. Only Hive's own files, which Android lets Hive delete.
 */
fun Track.isLossySoulseekDownload(context: android.content.Context): Boolean {
    val home = com.local.hive.mobile.soulseek.SoulseekSettings(context).folder.trim('/')
    return home.isNotEmpty() && folder.trim('/').startsWith("Music/$home/", ignoreCase = true) &&
        fileName.substringAfterLast('.').lowercase() !in setOf("flac", "wav", "alac", "aiff", "ape", "wv")
}

/** Whether a Soulseek copy can take this song's place: a YouTube download, or a lossy Soulseek one. */
fun Track.replaceableFromSoulseek(context: android.content.Context) = isYouTubeDownload || isLossySoulseekDownload(context)

/** Downloads [track] from Soulseek; the new copy takes the old one's place (see SoulseekWorker.takeOver). */
fun replaceFromSoulseek(context: android.content.Context, track: Track, onToast: (String) -> Unit) {
    if (!com.local.hive.mobile.soulseek.SoulseekSettings(context).configured) { onToast("Sign in to Soulseek in Settings first"); return }
    val lossless = !track.isYouTubeDownload
    com.local.hive.mobile.soulseek.SoulseekWorker.enqueue(context, com.local.hive.mobile.soulseek.SoulseekRequest(
        track.displayAlbumArtist.substringBefore(",").trim(), track.album,
        listOf(com.local.hive.mobile.soulseek.SoulseekRequest.Track(track.title, track.durationMs, replaces = track.id)), "track", losslessOnly = lossless))
    onToast(if (lossless) "Looking for a lossless copy of ${track.title} on Soulseek" else "Getting ${track.title} from Soulseek; it replaces the old copy")
}
