package com.local.hive.mobile.ui

import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.draw.shadow
import com.local.hive.mobile.data.Track
import androidx.compose.foundation.border
import com.local.hive.mobile.ui.theme.hiveGlassBorder
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Podcasts
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.NewReleases
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.TrendingUp
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.luminance
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.local.hive.mobile.R
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveAmbient
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.LocalHiveColors
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.withAccent
import kotlinx.coroutines.launch

/**
 * The whole app wears your Hive theme (the same CSS variables as the PC), with
 * the accent and ambient colours taken from the playing cover, as Hive does.
 */
@Composable
fun HiveRoot(vm: MainViewModel, openPlayerInitially: Boolean) = HiveThemed(vm) { HiveContent(vm, openPlayerInitially) }

/** Hive's colours for [content]: the theme, with the accent following the playing cover. */
@Composable
fun HiveThemed(vm: MainViewModel, content: @Composable () -> Unit) {
    val theme by vm.colors.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    val accent by animateColorAsState(accentFor(aura, theme.accent), tween(900), label = "accent")
    val colors = theme.withAccent(accent)
    val scheme = darkColorScheme(
        primary = colors.accent, background = colors.bg, onBackground = colors.text,
        surface = colors.bg, onSurface = colors.text, surfaceVariant = colors.panelStrong,
        onSurfaceVariant = colors.textDim, outline = colors.border,
    )
    // Status and navigation bar icons dark on a light theme, light on a dark one.
    val view = androidx.compose.ui.platform.LocalView.current
    val lightTheme = colors.bg.luminance() > 0.5f
    androidx.compose.runtime.SideEffect {
        (view.context as? android.app.Activity)?.window?.let { w ->
            androidx.core.view.WindowCompat.getInsetsController(w, view).apply { isAppearanceLightStatusBars = lightTheme; isAppearanceLightNavigationBars = lightTheme }
        }
    }
    CompositionLocalProvider(LocalHiveColors provides colors) {
        MaterialTheme(colorScheme = scheme) { content() }
    }
}

// Pages push in from the right edge with One UI's 450 ms open curve while the
// page beneath drifts a quarter-width left and fades out quickly, so two glass
// pages never sit on top of each other for long. Back reverses it on the 400 ms
// close curve; during a predictive back gesture the same motion follows the
// finger one-to-one.
private const val UNDER_DRIFT = 4
private val openEnter = slideInHorizontally(Motion.open()) { it }
private val openExit = slideOutHorizontally(Motion.open()) { -it / UNDER_DRIFT } + fadeOut(tween(180))
private val closeEnter = slideInHorizontally(Motion.close()) { -it / UNDER_DRIFT } + fadeIn(tween(220, delayMillis = 60))
private val closeExit = slideOutHorizontally(Motion.close()) { it }
private val followEnter = slideInHorizontally(tween(Motion.CLOSE_MS, easing = LinearEasing)) { -it / UNDER_DRIFT } + fadeIn(tween(Motion.CLOSE_MS, easing = LinearEasing))
private val followExit = slideOutHorizontally(tween(Motion.CLOSE_MS, easing = LinearEasing)) { it }

private const val ALBUM = "album/{id}"
// An album opened from its cover: the page fades up behind the cover as it grows into place, and fades away as it shrinks back.
// The page underneath clears first (One UI's 150 ms under-fade), so the cover flies over a clean backdrop,
// and the new page's words arrive as the cover lands.
private val coverEnter = fadeIn(tween(240, delayMillis = 170, easing = Motion.SineInOut60))
private val coverExitUnder = fadeOut(tween(Motion.UNDER_FADE_MS, easing = LinearEasing))
private val coverPopEnter = fadeIn(tween(240, delayMillis = 150, easing = Motion.SineInOut60))
private val coverPopExit = fadeOut(tween(Motion.UNDER_FADE_MS, easing = LinearEasing))

/** A page that knows its own transition, so its covers can be shared with the page before it. */
private fun androidx.navigation.NavGraphBuilder.page(
    route: String,
    arguments: List<androidx.navigation.NamedNavArgument> = emptyList(),
    content: @Composable (androidx.navigation.NavBackStackEntry) -> Unit,
) = composable(route, arguments) { entry -> CompositionLocalProvider(LocalPageScope provides this) { content(entry) } }

@Composable
private fun HiveContent(vm: MainViewModel, openPlayerInitially: Boolean) {
    val c = Hive.colors
    val nav = rememberNavController()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var playerOpen by rememberSaveable { mutableStateOf(openPlayerInitially) }
    var queueOpen by rememberSaveable { mutableStateOf(false) }
    var lyricsOpen by rememberSaveable { mutableStateOf(false) }
    val hasMedia = now.mediaId != null
    val bottomPadding = if (hasMedia) 82.dp else 0.dp
    val route by nav.currentBackStackEntryAsState()

    fun enc(s: String) = Uri.encode(s)
    // An Apple Music link opens the artist page for an artist, the collection page otherwise.
    fun appleRoute(url: String) = if ("/artist/" in url) "apple/a?url=${enc(url)}" else "apple/c?url=${enc(url)}"
    fun go(path: String) { nav.navigate(path) { launchSingleTop = true } }
    var toast by remember { mutableStateOf<String?>(null) }
    var addTarget by remember { mutableStateOf<List<Track>?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    var deleting by remember { mutableStateOf<List<Track>?>(null) }
    // Android asks the user before any file goes; Hive rescans once it has.
    val deleteLauncher = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val gone = deleting
        deleting = null
        if (result.resultCode == android.app.Activity.RESULT_OK && gone != null) { toast = "Deleted ${countOf(gone.size, "song")}"; vm.rescan() }
    }
    fun deleteRequest(tracks: List<Track>) {
        if (tracks.isEmpty()) return
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) { toast = "Deleting needs Android 11 or later"; return }
        deleting = tracks
        val request = android.provider.MediaStore.createDeleteRequest(context.contentResolver, tracks.map { it.uri })
        deleteLauncher.launch(androidx.activity.result.IntentSenderRequest.Builder(request.intentSender).build())
    }
    val selection = remember { Selection() }
    // Picking ends when the page changes.
    LaunchedEffect(route?.id) { selection.clear() }
    var infoTarget by remember { mutableStateOf<Track?>(null) }
    val actions = TrackActions(
        onPlayNext = { vm.playNext(listOf(it)) },
        onAddToQueue = { vm.addToQueue(listOf(it)) },
        onToggleLove = { vm.toggleLoved(it.id) },
        onGoToAlbum = { nav.navigate("album/${it.albumId}") },
        onGoToArtist = { nav.navigate("artist/${enc(it.artist)}") },
        onAddToPlaylist = { addTarget = it },
        onInfo = { infoTarget = it },
        onDelete = { tracks -> deleteRequest(tracks) },
    )
    val homeNav = HomeNavigation(
        openAlbum = { nav.navigate("album/$it") },
        openArtist = { nav.navigate("artist/${enc(it)}") },
        openGenre = { nav.navigate("genre/${enc(it)}") },
        openFolder = { nav.navigate("folder/${enc(it)}") },
        openPlaylist = { nav.navigate("playlist/${it.name}") },
        openUserPlaylist = { nav.navigate("userplaylist/$it") },
        openPcPlaylist = { nav.navigate("pcplaylist?id=${enc(it)}") },
        openSearch = { nav.navigate("search") },
        openSettings = { go("settings") },
        open = { go(it) },
    )

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(c.bg)) {
            HiveAmbient(aura?.primary?.copy(alpha = 0.32f) ?: c.ambientA, aura?.secondary?.copy(alpha = 0.26f) ?: c.ambientB, Modifier.fillMaxSize())
            HiveGlassLayers(
                Modifier.fillMaxSize(),
                content = {
                    CompositionLocalProvider(LocalSelection provides selection) {
                    // No SharedTransitionLayout around the NavHost: it turns on lookahead for
                    // every page, so each list row was measured and placed twice per frame
                    // (a quarter of the UI thread while scrolling). Covers use the cover
                    // enter/exit transitions below; sharedCover() is a no-op without a scope.
                    NavHost(
                        nav, startDestination = "home", modifier = Modifier.fillMaxSize().navigationBarsPadding(),
                        enterTransition = { if (targetState.destination.route == ALBUM) coverEnter else openEnter },
                        exitTransition = { if (targetState.destination.route == ALBUM) coverExitUnder else openExit },
                        popEnterTransition = { if (initialState.destination.route == ALBUM) coverPopEnter else closeEnter },
                        popExitTransition = { if (initialState.destination.route == ALBUM) coverPopExit else closeExit },
                        predictivePopEnterTransition = { followEnter }, predictivePopExitTransition = { followExit },
                    ) {
                        page("home") { HomeScreen(vm, homeNav, actions, bottomPadding) }
                        page("search") { SearchScreen(vm, actions, bottomPadding, { nav.popBackStack() }, homeNav.openAlbum, homeNav.openArtist) }
                        page("settings") { SettingsScreen(vm, bottomPadding, onOpenEqualiser = { nav.navigate("equaliser") }) { nav.popBackStack() } }
                        page("equaliser") { EqualiserScreen(vm, bottomPadding) { nav.popBackStack() } }
                        page(ALBUM, listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                            val id = entry.arguments?.getLong("id") ?: 0L
                            val albums by vm.albums.collectAsStateWithLifecycle()
                            val album = albums.firstOrNull { it.albumId == id }
                            AlbumScreen(
                                vm, id, album?.album?.ifBlank { "Unknown album" } ?: "", album?.artist.orEmpty(), album?.year ?: 0,
                                vm.albumTracks(id), actions, bottomPadding, onBack = { nav.popBackStack() }, onOpenArtist = homeNav.openArtist,
                            )
                        }
                        page("artist/{name}") { entry ->
                            val name = entry.arguments?.getString("name").orEmpty()
                            ArtistScreen(vm, name, vm.artistTracks(name), actions, bottomPadding, onBack = { nav.popBackStack() }, onOpenAlbum = homeNav.openAlbum)
                        }
                        page("genre/{name}") { entry ->
                            val name = entry.arguments?.getString("name").orEmpty()
                            SongsScreen(vm, name, vm.genreTracks(name), actions, bottomPadding) { nav.popBackStack() }
                        }
                        page("folder/{name}") { entry ->
                            val name = entry.arguments?.getString("name").orEmpty()
                            SongsScreen(vm, name.trimEnd('/').substringAfterLast('/').ifBlank { name }, vm.folderTracks(name), actions, bottomPadding) { nav.popBackStack() }
                        }
                        page("apple") {
                            AppleMusicScreen(vm, bottomPadding, onBack = { nav.popBackStack() }) { url -> nav.navigate(appleRoute(url)) }
                        }
                        page("apple/a?url={url}") { entry ->
                            AppleArtistScreen(vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() }) { url -> nav.navigate(appleRoute(url)) }
                        }
                        page("apple/c?url={url}") { entry ->
                            AppleCollectionScreen(
                                vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() },
                                onOpen = { url -> nav.navigate(appleRoute(url)) }, onOpenPlaylist = homeNav.openUserPlaylist, onToast = { toast = it },
                            )
                        }
                        page("pcplaylist?id={id}") { entry ->
                            PcPlaylistScreen(vm, entry.arguments?.getString("id").orEmpty(), bottomPadding, onBack = { nav.popBackStack() }, onOpenPlaylist = homeNav.openUserPlaylist, onToast = { toast = it })
                        }
                        page("remote") { RemoteScreen(vm, bottomPadding, onBack = { nav.popBackStack() }, onToast = { toast = it }) }
                        page("pc") { PcLibraryScreen(vm, bottomPadding, onBack = { nav.popBackStack() }) { key -> nav.navigate("pc/album?key=${enc(key)}") } }
                        page("pc/album?key={key}") { entry -> PcAlbumScreen(vm, entry.arguments?.getString("key").orEmpty(), bottomPadding) { nav.popBackStack() } }
                        page("wrap") { YearlyWrapScreen(vm, bottomPadding) { nav.popBackStack() } }
                        page("podcasts") { PodcastsScreen(vm, bottomPadding, onBack = { nav.popBackStack() }) { url -> nav.navigate("podcast?feed=${enc(url)}") } }
                        page("podcast?feed={feed}") { entry -> PodcastShowScreen(vm, entry.arguments?.getString("feed").orEmpty(), bottomPadding) { nav.popBackStack() } }
                        page("radio") { RadioScreen(vm, bottomPadding, onBack = { nav.popBackStack() }, onToast = { toast = it }) }
                        page("spotify") {
                            SpotifyScreen(vm, bottomPadding, onBack = { nav.popBackStack() }, onOpenSettings = homeNav.openSettings) { url -> nav.navigate("spotify/c?url=${enc(url)}") }
                        }
                        page("spotify/c?url={url}") { entry ->
                            SpotifyCollectionScreen(vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() }, onOpenPlaylist = homeNav.openUserPlaylist, onToast = { toast = it })
                        }
                        page("userplaylist/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                            PlaylistScreen(vm, entry.arguments?.getLong("id") ?: 0L, actions, bottomPadding) { nav.popBackStack() }
                        }
                        page("playlist/{kind}") { entry ->
                            val kind = runCatching { AutoPlaylist.valueOf(entry.arguments?.getString("kind").orEmpty()) }.getOrDefault(AutoPlaylist.Favorites)
                            val flow = when (kind) {
                                AutoPlaylist.Favorites -> vm.favorites
                                AutoPlaylist.RecentlyAdded -> vm.recentlyAdded
                                AutoPlaylist.MostPlayed -> vm.topMostPlayed
                                AutoPlaylist.RecentlyPlayed -> vm.recentlyPlayed
                                AutoPlaylist.TopRated -> vm.topRated
                            }
                            SongsScreen(vm, kind.title, flow, actions, bottomPadding) { nav.popBackStack() }
                        }
                    }
                    }
                },
                overlay = {
                    if (hasMedia) {
                        PlayerSheet(
                            vm,
                            open = playerOpen,
                            onOpenChange = { playerOpen = it; if (!it) queueOpen = false },
                            queueOpen = queueOpen,
                            onQueueChange = { queueOpen = it; if (it) playerOpen = true },
                            onOpenAlbum = { playerOpen = false; nav.navigate("album/${it.albumId}") },
                            onOpenArtist = { playerOpen = false; nav.navigate("artist/${enc(it.artist)}") },
                            onInfo = { infoTarget = it },
                            onAddToPlaylist = { addTarget = listOf(it) },
                            onOpenLyrics = { lyricsOpen = true },
                            onOpenEqualiser = { playerOpen = false; nav.navigate("equaliser") { launchSingleTop = true } },
                            onToast = { toast = it },
                        )
                    }
                    SelectionBar(vm, selection, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = bottomPadding + 8.dp), onAddToPlaylist = { addTarget = it }, onDelete = { deleteRequest(it) }, onToast = { toast = it })
                    HiveToast(toast, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = bottomPadding + 16.dp)) { toast = null }
                    AnimatedVisibility(lyricsOpen, enter = slideInVertically(Motion.open()) { it } + fadeIn(Motion.underFade()), exit = slideOutVertically(Motion.close()) { it } + fadeOut(Motion.close())) {
                        LyricsScreen(vm) { lyricsOpen = false }
                    }
                },
            )
        }
        infoTarget?.let { t -> TrackInfoSheet(vm, t, onDismiss = { infoTarget = null }) { playerOpen = false; nav.navigate("album/${it.albumId}") } }
        addTarget?.let { tracks -> AddToPlaylistSheet(vm, tracks, onDismiss = { addTarget = null }) { name -> toast = "Added to $name" } }
        BackHandler(enabled = selection.active) { selection.clear() }
        BackHandler(enabled = playerOpen || queueOpen || lyricsOpen) {
            when {
                lyricsOpen -> lyricsOpen = false
                queueOpen -> queueOpen = false
                else -> playerOpen = false
            }
        }
    }
}

/** A brief Hive note above the playbar, e.g. "Added to Road trip". */
@Composable
private fun HiveToast(message: String?, modifier: Modifier, onDone: () -> Unit) {
    val c = Hive.colors
    var shown by remember { mutableStateOf("") }
    if (message != null) shown = message
    LaunchedEffect(message) { if (message != null) { kotlinx.coroutines.delay(2_200); onDone() } }
    AnimatedVisibility(message != null, modifier, enter = fadeIn(tween(160)) + slideInVertically(Motion.open()) { it / 2 }, exit = fadeOut(tween(200))) {
        Text(
            shown, style = HiveText.pill, color = c.text,
            modifier = Modifier.shadow(18.dp, HiveShape.pill, ambientColor = c.accentGlow).clip(HiveShape.pill).background(c.control)
                .border(1.dp, hiveGlassBorder(), HiveShape.pill).padding(horizontal = 18.dp, vertical = 11.dp),
        )
    }
}
