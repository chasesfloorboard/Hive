package com.local.hive.mobile.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.local.hive.mobile.ui.theme.GlassLayers
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveTheme

@Composable
fun HiveRoot(vm: MainViewModel, openPlayerInitially: Boolean) {
    val theme by vm.colors.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    // While something plays, Hive's accent follows the cover, as on the desktop.
    val accent by animateColorAsState(accentFor(aura, theme.accent), tween(700), label = "accent")
    HiveTheme(theme.copy(accent = accent)) { HiveContent(vm, openPlayerInitially) }
}

private val enterScreen = fadeIn(tween(260)) + scaleIn(tween(320, easing = FastOutSlowInEasing), initialScale = 0.96f)
private val exitScreen = fadeOut(tween(200))

@Composable
private fun HiveContent(vm: MainViewModel, openPlayerInitially: Boolean) {
    val colors = Hive.colors
    val nav = rememberNavController()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var playerOpen by rememberSaveable { mutableStateOf(openPlayerInitially) }
    var queueOpen by rememberSaveable { mutableStateOf(false) }
    val hasMedia = now.trackId != null
    val bottomPadding = if (hasMedia) 84.dp else 0.dp
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f

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

    GlassLayers(
        Modifier.fillMaxSize(),
        content = {
            // A quiet aura behind every screen; the full player turns it up.
            AuraBackground(aura, progress, intensity = 0.55f, base = colors.bg, modifier = Modifier.fillMaxSize())
            NavHost(
                nav, startDestination = "home", modifier = Modifier.fillMaxSize().navigationBarsPadding(),
                enterTransition = { enterScreen }, exitTransition = { exitScreen },
                popEnterTransition = { fadeIn(tween(260)) }, popExitTransition = { fadeOut(tween(200)) + scaleOut(tween(260), targetScale = 0.96f) },
            ) {
                composable("home") { HomeScreen(vm, homeNav, actions, bottomPadding) }
                composable("search") { SearchScreen(vm, actions, bottomPadding) { nav.popBackStack() } }
                composable("settings") { SettingsScreen(vm, bottomPadding) { nav.popBackStack() } }
                composable("album/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                    val id = entry.arguments?.getLong("id") ?: 0L
                    val albums by vm.albums.collectAsStateWithLifecycle()
                    val album = albums.firstOrNull { it.albumId == id }
                    CollectionScreen(
                        vm, album?.album?.ifBlank { "Unknown album" } ?: "",
                        listOfNotNull(album?.artist?.ifBlank { null }, album?.year?.takeIf { it > 0 }?.toString()).joinToString(" · "),
                        Uri.parse("content://media/external/audio/albumart/$id"), id, vm.albumTracks(id), actions, bottomPadding, { nav.popBackStack() }, numbered = true,
                    )
                }
                composable("artist/{name}") { entry ->
                    val name = entry.arguments?.getString("name").orEmpty()
                    CollectionScreen(vm, name.ifBlank { "Unknown artist" }, "Artist", null, null, vm.artistTracks(name), actions, bottomPadding, { nav.popBackStack() })
                }
                composable("genre/{name}") { entry ->
                    val name = entry.arguments?.getString("name").orEmpty()
                    CollectionScreen(vm, name, "Genre", null, null, vm.genreTracks(name), actions, bottomPadding, { nav.popBackStack() })
                }
                composable("folder/{name}") { entry ->
                    val name = entry.arguments?.getString("name").orEmpty()
                    CollectionScreen(vm, name.substringAfterLast('/').ifBlank { name }, name, null, null, vm.folderTracks(name), actions, bottomPadding, { nav.popBackStack() })
                }
                composable("playlist/{kind}") { entry ->
                    val kind = runCatching { AutoPlaylist.valueOf(entry.arguments?.getString("kind").orEmpty()) }.getOrDefault(AutoPlaylist.Favorites)
                    val flow = when (kind) {
                        AutoPlaylist.Favorites -> vm.favorites
                        AutoPlaylist.RecentlyAdded -> vm.recentlyAdded
                        AutoPlaylist.MostPlayed -> vm.mostPlayed
                        AutoPlaylist.RecentlyPlayed -> vm.recentlyPlayed
                    }
                    CollectionScreen(vm, kind.title, "Playlist", null, null, flow, actions, bottomPadding, { nav.popBackStack() })
                }
            }
        },
        overlay = {
            AnimatedVisibility(
                hasMedia && !playerOpen,
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding(),
                enter = slideInVertically(tween(320)) { it } + fadeIn(),
                exit = slideOutVertically(tween(240)) { it } + fadeOut(),
            ) {
                MiniPlayer(
                    now,
                    onOpen = { playerOpen = true },
                    onTogglePlay = { vm.player.togglePlay() },
                    onNext = { vm.player.next() },
                    onQueue = { queueOpen = true },
                )
            }
            AnimatedVisibility(playerOpen && hasMedia, enter = slideInVertically(tween(380, easing = FastOutSlowInEasing)) { it }, exit = slideOutVertically(tween(300)) { it }) {
                FullPlayer(
                    vm,
                    onClose = { playerOpen = false },
                    onOpenQueue = { queueOpen = true },
                    onOpenAlbum = { playerOpen = false; nav.navigate("album/${it.albumId}") },
                    onOpenArtist = { playerOpen = false; nav.navigate("artist/${enc(it.artist)}") },
                )
            }
            AnimatedVisibility(queueOpen, enter = slideInVertically(tween(340, easing = FastOutSlowInEasing)) { it }, exit = slideOutVertically(tween(260)) { it }) {
                QueueScreen(vm) { queueOpen = false }
            }
            BackHandler(enabled = playerOpen || queueOpen) {
                if (queueOpen) queueOpen = false else playerOpen = false
            }
        },
    )
}
