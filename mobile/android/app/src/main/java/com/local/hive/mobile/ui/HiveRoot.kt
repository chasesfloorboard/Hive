package com.local.hive.mobile.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveTheme

@Composable
fun HiveRoot(vm: MainViewModel, openPlayerInitially: Boolean) {
    val colors by vm.colors.collectAsStateWithLifecycle()
    HiveTheme(colors) { HiveContent(vm, openPlayerInitially) }
}

@Composable
private fun HiveContent(vm: MainViewModel, openPlayerInitially: Boolean) {
    val colors = Hive.colors
    val nav = rememberNavController()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var playerOpen by rememberSaveable { mutableStateOf(openPlayerInitially) }
    var queueOpen by rememberSaveable { mutableStateOf(false) }
    val hasMedia = now.trackId != null
    val bottomPadding = if (hasMedia) 76.dp else 0.dp

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

    // Hive's ambient glow: two soft radial washes over the background.
    Box(
        Modifier
            .fillMaxSize()
            .background(colors.bg)
            .background(Brush.radialGradient(listOf(colors.ambientA, colors.bg.copy(alpha = 0f)), center = Offset(0f, 0f), radius = 1400f))
            .background(Brush.radialGradient(listOf(colors.ambientB, colors.bg.copy(alpha = 0f)), center = Offset(2000f, 2600f), radius = 1600f)),
    ) {
        NavHost(nav, startDestination = "home", modifier = Modifier.fillMaxSize().navigationBarsPadding()) {
            composable("home") { HomeScreen(vm, homeNav, actions, bottomPadding) }
            composable("search") { SearchScreen(vm, actions, bottomPadding) { nav.popBackStack() } }
            composable("settings") { SettingsScreen(vm, bottomPadding) { nav.popBackStack() } }
            composable("album/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                val id = entry.arguments?.getLong("id") ?: 0L
                val albums by vm.albums.collectAsStateWithLifecycle()
                val album = albums.firstOrNull { it.albumId == id }
                CollectionScreen(
                    vm, album?.album?.ifBlank { "Unknown album" } ?: "", listOfNotNull(album?.artist, album?.year?.takeIf { it > 0 }?.toString()).joinToString(" · "),
                    Uri.parse("content://media/external/audio/albumart/$id"), vm.albumTracks(id), actions, bottomPadding, { nav.popBackStack() }, numbered = true,
                )
            }
            composable("artist/{name}") { entry ->
                val name = entry.arguments?.getString("name").orEmpty()
                CollectionScreen(vm, name.ifBlank { "Unknown artist" }, "Artist", null, vm.artistTracks(name), actions, bottomPadding, { nav.popBackStack() })
            }
            composable("genre/{name}") { entry ->
                val name = entry.arguments?.getString("name").orEmpty()
                CollectionScreen(vm, name, "Genre", null, vm.genreTracks(name), actions, bottomPadding, { nav.popBackStack() })
            }
            composable("folder/{name}") { entry ->
                val name = entry.arguments?.getString("name").orEmpty()
                CollectionScreen(vm, name.substringAfterLast('/').ifBlank { name }, name, null, vm.folderTracks(name), actions, bottomPadding, { nav.popBackStack() })
            }
            composable("playlist/{kind}") { entry ->
                val kind = runCatching { AutoPlaylist.valueOf(entry.arguments?.getString("kind").orEmpty()) }.getOrDefault(AutoPlaylist.Favorites)
                val flow = when (kind) {
                    AutoPlaylist.Favorites -> vm.favorites
                    AutoPlaylist.RecentlyAdded -> vm.recentlyAdded
                    AutoPlaylist.MostPlayed -> vm.mostPlayed
                    AutoPlaylist.RecentlyPlayed -> vm.recentlyPlayed
                }
                CollectionScreen(vm, kind.title, "Playlist", null, flow, actions, bottomPadding, { nav.popBackStack() })
            }
        }

        if (hasMedia && !playerOpen) {
            MiniPlayer(
                now,
                onOpen = { playerOpen = true },
                onTogglePlay = { vm.player.togglePlay() },
                onPrevious = { vm.player.previous() },
                onNext = { vm.player.next() },
                onQueue = { queueOpen = true },
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding(),
            )
        }

        AnimatedVisibility(playerOpen && hasMedia, enter = slideInVertically { it }, exit = slideOutVertically { it }) {
            FullPlayer(
                vm,
                onClose = { playerOpen = false },
                onOpenQueue = { queueOpen = true },
                onOpenAlbum = { playerOpen = false; nav.navigate("album/${it.albumId}") },
                onOpenArtist = { playerOpen = false; nav.navigate("artist/${enc(it.artist)}") },
            )
        }
        AnimatedVisibility(queueOpen, enter = slideInVertically { it }, exit = slideOutVertically { it }) {
            QueueScreen(vm) { queueOpen = false }
        }
        BackHandler(enabled = playerOpen || queueOpen) {
            if (queueOpen) queueOpen = false else playerOpen = false
        }
    }
}
