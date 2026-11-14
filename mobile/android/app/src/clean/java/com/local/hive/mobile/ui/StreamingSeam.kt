package com.local.hive.mobile.ui

import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track

/**
 * Hive Clean (Google Play, strict) — the no-op twins of Hive Mobile's streaming/soulseek seams. Because
 * :streaming and :soulseek are not on Clean's classpath, these are the only definitions of these names it
 * sees, so every Apple Music / Spotify / Soulseek affordance simply isn't there. Everything compliant
 * (local library, covers, MusicBrainz metadata, lrclib lyrics, radio, podcasts, Deezer artist images) comes
 * from the shared base and the :core/discovery tier and is unaffected.
 */

/** No Apple Music / Spotify pages in Clean. */
internal fun NavGraphBuilder.streamingRoutes(
    vm: MainViewModel,
    nav: NavHostController,
    bottomPadding: Dp,
    onOpenSettings: () -> Unit,
    appleRoute: (String) -> String,
    onOpenPlaylist: (Long) -> Unit,
    onToast: (String) -> Unit,
) {}

/** No Soulseek downloads in Clean, so the download bubble never shows. */
@Composable
fun DownloadBubble(modifier: Modifier = Modifier, hidden: Boolean = false) {}

/** Soulseek is absent in Clean. */
fun soulseekConfigured(context: android.content.Context): Boolean = false

fun downloadStreams(context: android.content.Context, songs: List<StreamTrack>, onToast: (String) -> Unit) {}

@Composable
fun SoulseekSignInDialog(onDismiss: () -> Unit, onSignedIn: () -> Unit, confirm: String = "Sign in and download") {}

fun Track.replaceableFromSoulseek(context: android.content.Context): Boolean = false

fun replaceFromSoulseek(context: android.content.Context, track: Track, onToast: (String) -> Unit) {}

/** No streaming accounts page in Clean (the Settings entry is hidden). */
fun streamingAccountsAvailable(): Boolean = false

fun LazyListScope.accountsSettings(vm: MainViewModel) {}

/** No Apple Music / Spotify / Google-Drive tiles in Clean's Browse tab. */
fun browseStreamingTiles(): List<Pair<Triple<String, String, ImageVector>, String>> = emptyList()

/** No Spotify/Apple "Popular playlists" shelf in Clean. */
@Composable
fun rememberBrowsePopular(): List<Pair<ServiceCard, String>> = emptyList()

/** No Google-Drive import in Clean (it needs Soulseek). */
@Composable
fun DriveImportDialog(onDismiss: () -> Unit) {}

/** No online (Apple Music / Spotify) catalogue search in Clean. */
fun streamingSearchAvailable(): Boolean = false

@Composable
fun OnlineSearchIcon(tint: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier, artFraction: Float = 22f / 42f) {}

@Composable
fun OnlineSearchResults(vm: MainViewModel, query: String, showAlbums: Boolean, onOpen: (String) -> Unit) {}

/** No Spotify OAuth in Clean. */
fun completeSpotifyReturn(app: android.app.Application, data: android.net.Uri) {}
