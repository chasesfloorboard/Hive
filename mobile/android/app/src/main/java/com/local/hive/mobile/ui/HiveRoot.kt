package com.local.hive.mobile.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.OneUi

/** Material components (menus, text fields) drawn in Samsung Music's dark colours. */
private val OneUiScheme = darkColorScheme(
    primary = OneUi.Primary,
    onPrimary = OneUi.Text1,
    background = OneUi.Window,
    onBackground = OneUi.Text1,
    surface = OneUi.Panel,
    onSurface = OneUi.Text1,
    surfaceVariant = OneUi.Raised,
    onSurfaceVariant = OneUi.TextSub,
    surfaceContainer = OneUi.Raised,
    outline = OneUi.Divider,
)

@Composable
fun HiveRoot(vm: MainViewModel, openPlayerInitially: Boolean) {
    MaterialTheme(colorScheme = OneUiScheme) { HiveContent(vm, openPlayerInitially) }
}

// One UI's sesl_fragment_open/close: the new page slides in from the right
// (450 ms) while the page beneath fades (150 ms); back reverses it in 400 ms.
private val openEnter = slideInHorizontally(Motion.open()) { it }
private val openExit = fadeOut(Motion.underFade())
private val closeEnter = fadeIn(Motion.underFade())
private val closeExit = slideOutHorizontally(Motion.close()) { it }

@Composable
private fun HiveContent(vm: MainViewModel, openPlayerInitially: Boolean) {
    val nav = rememberNavController()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var playerOpen by rememberSaveable { mutableStateOf(openPlayerInitially) }
    var queueOpen by rememberSaveable { mutableStateOf(false) }
    val hasMedia = now.trackId != null
    val bottomPadding = if (hasMedia) 78.dp else 0.dp

    fun enc(s: String) = Uri.encode(s)
    val actions = TrackActions(
        onPlayNext = { vm.playNext(listOf(it)) },
        onAddToQueue = { vm.addToQueue(listOf(it)) },
        onToggleLove = { vm.toggleLoved(it.id) },
        onGoToAlbum = { nav.navigate("album/${it.albumId}") },
        onGoToArtist = { nav.navigate("artist/${enc(it.artist)}") },
    )
    val homeNav = HomeNavigation(
        openAlbum = { nav.navigate("album/$it") },
        openArtist = { nav.navigate("artist/${enc(it)}") },
        openGenre = { nav.navigate("genre/${enc(it)}") },
        openFolder = { nav.navigate("folder/${enc(it)}") },
        openPlaylist = { nav.navigate("playlist/${it.name}") },
        openSearch = { nav.navigate("search") },
        openSettings = { nav.navigate("settings") },
    )

    Box(Modifier.fillMaxSize().background(OneUi.Window)) {
        NavHost(
            nav, startDestination = "home", modifier = Modifier.fillMaxSize().navigationBarsPadding(),
            enterTransition = { openEnter }, exitTransition = { openExit },
            popEnterTransition = { closeEnter }, popExitTransition = { closeExit },
        ) {
            composable("home") { HomeScreen(vm, homeNav, actions, bottomPadding) }
            composable("search") { SearchScreen(vm, actions, bottomPadding) { nav.popBackStack() } }
            composable("settings") { SettingsScreen(vm, bottomPadding) { nav.popBackStack() } }
            composable("album/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                val id = entry.arguments?.getLong("id") ?: 0L
                val albums by vm.albums.collectAsStateWithLifecycle()
                val album = albums.firstOrNull { it.albumId == id }
                AlbumScreen(
                    vm, album?.album?.ifBlank { "Unknown album" } ?: "", album?.artist.orEmpty(), album?.year ?: 0,
                    Uri.parse("content://media/external/audio/albumart/$id"), vm.albumTracks(id), actions, bottomPadding,
                    onBack = { nav.popBackStack() }, onSearch = { nav.navigate("search") },
                )
            }
            composable("artist/{name}") { entry ->
                val name = entry.arguments?.getString("name").orEmpty()
                ArtistScreen(vm, name, vm.artistTracks(name), actions, bottomPadding, onBack = { nav.popBackStack() }, onOpenAlbum = { nav.navigate("album/$it") }, onSearch = { nav.navigate("search") })
            }
            composable("genre/{name}") { entry ->
                val name = entry.arguments?.getString("name").orEmpty()
                SongsScreen(vm, name, vm.genreTracks(name), actions, bottomPadding) { nav.popBackStack() }
            }
            composable("folder/{name}") { entry ->
                val name = entry.arguments?.getString("name").orEmpty()
                SongsScreen(vm, name.trimEnd('/').substringAfterLast('/').ifBlank { name }, vm.folderTracks(name), actions, bottomPadding) { nav.popBackStack() }
            }
            composable("playlist/{kind}") { entry ->
                val kind = runCatching { AutoPlaylist.valueOf(entry.arguments?.getString("kind").orEmpty()) }.getOrDefault(AutoPlaylist.Favorites)
                val flow = when (kind) {
                    AutoPlaylist.Favorites -> vm.favorites
                    AutoPlaylist.RecentlyAdded -> vm.recentlyAdded
                    AutoPlaylist.MostPlayed -> vm.mostPlayed
                    AutoPlaylist.RecentlyPlayed -> vm.recentlyPlayed
                }
                SongsScreen(vm, kind.title, flow, actions, bottomPadding) { nav.popBackStack() }
            }
        }

        if (hasMedia) {
            PlayerSheet(
                vm,
                open = playerOpen,
                onOpenChange = { playerOpen = it },
                onOpenQueue = { queueOpen = true },
                onOpenAlbum = { playerOpen = false; nav.navigate("album/${it.albumId}") },
                onOpenArtist = { playerOpen = false; nav.navigate("artist/${enc(it.artist)}") },
            )
        }
        AnimatedVisibility(queueOpen, enter = slideInVertically(Motion.open()) { it } + fadeIn(Motion.underFade()), exit = slideOutVertically(Motion.close()) { it } + fadeOut(Motion.close())) {
            QueueScreen(vm) { queueOpen = false }
        }
        BackHandler(enabled = playerOpen || queueOpen) {
            if (queueOpen) queueOpen = false else playerOpen = false
        }
    }
}
