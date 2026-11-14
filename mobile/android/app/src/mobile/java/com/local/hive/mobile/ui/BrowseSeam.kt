package com.local.hive.mobile.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CloudDownload
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Hive Mobile's streaming/soulseek pieces of the Browse tab: the Apple Music / Spotify / Google-Drive tiles,
 * the "Popular playlists" shelf, and the Google-Drive import dialog. Hive Clean defines the same names as
 * no-ops, so none of it is in the Play build. (Radio, Podcasts and the PC tiles stay in the shared Browse tab.)
 */

/** The streaming/soulseek Browse tiles (Apple Music, Spotify, Google Drive). Empty in Hive Clean. */
fun browseStreamingTiles(): List<Pair<Triple<String, String, ImageVector>, String>> = listOf(
    Triple("Apple Music", "Charts and albums", Icons.Rounded.Explore) to "apple",
    Triple("Spotify", "Playlists and links", Icons.Rounded.GraphicEq) to "spotify",
    Triple("Google Drive", "Import a shared folder", Icons.Rounded.CloudDownload) to "drive",
)

/** Popular Spotify/Apple playlists for the Browse tab. Empty in Hive Clean. */
@Composable
fun rememberBrowsePopular(): List<Pair<ServiceCard, String>> {
    val svm = rememberStreamingVm()
    val popular by produceState(emptyList<Pair<ServiceCard, String>>()) {
        val sp = runCatching { svm.spotify.picks() }.getOrDefault(emptyList()).map { ServiceCard(it.name, it.subtitle.ifBlank { "Spotify" }, it.artwork, it.url) to "spotify/c?url=${android.net.Uri.encode(it.url)}" }
        val am = runCatching { svm.appleMusic.browse() }.getOrDefault(emptyList()).flatMap { it.cards }.filter { it.kind == "playlist" }
            .map { val url = it.url.ifBlank { "https://music.apple.com/us/playlist/x/${it.id}" }; ServiceCard(it.name, it.curator.ifBlank { "Apple Music" }, it.artwork, url) to "apple/c?url=${android.net.Uri.encode(url)}" }
        value = (0 until maxOf(sp.size, am.size)).flatMap { i -> listOfNotNull(sp.getOrNull(i), am.getOrNull(i)) }.distinctBy { it.first.url }.take(16)
    }
    return popular
}

/** The Google-Drive import dialog. A no-op in Hive Clean (no Soulseek, so no Drive import). */
@Composable
fun DriveImportDialog(onDismiss: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val toast = LocalToast.current
    val copied = remember {
        runCatching { (context.getSystemService(android.content.ClipboardManager::class.java)).primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty() }.getOrDefault("")
            .takeIf { com.local.hive.mobile.soulseek.DriveLinks.parse(it) != null }.orEmpty()
    }
    NameDialog("Import from Google Drive", copied, "Import", onDismiss = onDismiss, hint = "Link to a shared folder or song") { text ->
        onDismiss()
        if (com.local.hive.mobile.soulseek.DriveImportWorker.enqueue(context, text)) toast("Importing from Google Drive. It's in your downloads, and becomes a playlist when it's done.")
        else toast("That isn't a Google Drive link. Share the folder as “Anyone with the link” and copy its link.")
    }
}
