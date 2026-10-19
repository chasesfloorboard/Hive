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
fun HiveRoot(vm: MainViewModel, openPlayerInitially: Boolean) {
    val theme by vm.colors.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    val accent by animateColorAsState(accentFor(aura, theme.accent), tween(900), label = "accent")
    val colors = theme.withAccent(accent)
    val scheme = darkColorScheme(
        primary = colors.accent, background = colors.bg, onBackground = colors.text,
        surface = colors.bg, onSurface = colors.text, surfaceVariant = colors.panelStrong,
        onSurfaceVariant = colors.textDim, outline = colors.border,
    )
    CompositionLocalProvider(LocalHiveColors provides colors) {
        MaterialTheme(colorScheme = scheme) { HiveContent(vm, openPlayerInitially) }
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

@Composable
private fun HiveContent(vm: MainViewModel, openPlayerInitially: Boolean) {
    val c = Hive.colors
    val nav = rememberNavController()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var playerOpen by rememberSaveable { mutableStateOf(openPlayerInitially) }
    var queueOpen by rememberSaveable { mutableStateOf(false) }
    var lyricsOpen by rememberSaveable { mutableStateOf(false) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val hasMedia = now.mediaId != null
    val bottomPadding = if (hasMedia) 82.dp else 0.dp
    val route by nav.currentBackStackEntryAsState()

    fun enc(s: String) = Uri.encode(s)
    fun go(path: String) { scope.launch { drawer.close() }; nav.navigate(path) { launchSingleTop = true } }
    var addTarget by remember { mutableStateOf<List<Track>?>(null) }
    var infoTarget by remember { mutableStateOf<Track?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }
    val actions = TrackActions(
        onPlayNext = { vm.playNext(listOf(it)) },
        onAddToQueue = { vm.addToQueue(listOf(it)) },
        onToggleLove = { vm.toggleLoved(it.id) },
        onGoToAlbum = { nav.navigate("album/${it.albumId}") },
        onGoToArtist = { nav.navigate("artist/${enc(it.artist)}") },
        onAddToPlaylist = { addTarget = it },
        onInfo = { infoTarget = it },
    )
    val homeNav = HomeNavigation(
        openAlbum = { nav.navigate("album/$it") },
        openArtist = { nav.navigate("artist/${enc(it)}") },
        openGenre = { nav.navigate("genre/${enc(it)}") },
        openFolder = { nav.navigate("folder/${enc(it)}") },
        openPlaylist = { nav.navigate("playlist/${it.name}") },
        openUserPlaylist = { nav.navigate("userplaylist/$it") },
        openSearch = { nav.navigate("search") },
        openSettings = { nav.navigate("settings") },
        openSidebar = { scope.launch { drawer.open() } },
    )

    ModalNavigationDrawer(
        drawerState = drawer,
        // An edge swipe on a page means back; the sidebar only swipes open from Home.
        gesturesEnabled = drawer.isOpen || route?.destination?.route == "home",
        scrimColor = Color.Black.copy(alpha = 0.45f),
        drawerContent = { Sidebar(vm, route?.destination?.route.orEmpty() + (route?.arguments?.getString("kind") ?: ""), ::go) },
    ) {
        Box(Modifier.fillMaxSize().background(c.bg)) {
            HiveAmbient(aura?.primary?.copy(alpha = 0.32f) ?: c.ambientA, aura?.secondary?.copy(alpha = 0.26f) ?: c.ambientB, Modifier.fillMaxSize())
            HiveGlassLayers(
                Modifier.fillMaxSize(),
                content = {
                    NavHost(
                        nav, startDestination = "home", modifier = Modifier.fillMaxSize().navigationBarsPadding(),
                        enterTransition = { openEnter }, exitTransition = { openExit },
                        popEnterTransition = { closeEnter }, popExitTransition = { closeExit },
                        predictivePopEnterTransition = { followEnter }, predictivePopExitTransition = { followExit },
                    ) {
                        composable("home") { HomeScreen(vm, homeNav, actions, bottomPadding) }
                        composable("search") { SearchScreen(vm, actions, bottomPadding, { nav.popBackStack() }, homeNav.openAlbum, homeNav.openArtist) }
                        composable("settings") { SettingsScreen(vm, bottomPadding, onOpenEqualiser = { nav.navigate("equaliser") }) { nav.popBackStack() } }
                        composable("equaliser") { EqualiserScreen(vm, bottomPadding) { nav.popBackStack() } }
                        composable("album/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                            val id = entry.arguments?.getLong("id") ?: 0L
                            val albums by vm.albums.collectAsStateWithLifecycle()
                            val album = albums.firstOrNull { it.albumId == id }
                            AlbumScreen(
                                vm, id, album?.album?.ifBlank { "Unknown album" } ?: "", album?.artist.orEmpty(), album?.year ?: 0,
                                vm.albumTracks(id), actions, bottomPadding, onBack = { nav.popBackStack() }, onOpenArtist = homeNav.openArtist,
                            )
                        }
                        composable("artist/{name}") { entry ->
                            val name = entry.arguments?.getString("name").orEmpty()
                            ArtistScreen(vm, name, vm.artistTracks(name), actions, bottomPadding, onBack = { nav.popBackStack() }, onOpenAlbum = homeNav.openAlbum)
                        }
                        composable("genres") { NamedListScreen("Genres", vm.genres, Icons.Rounded.Category, bottomPadding, { nav.popBackStack() }) { homeNav.openGenre(it) } }
                        composable("folders") { NamedListScreen("Folders", vm.folders, Icons.Rounded.Folder, bottomPadding, { nav.popBackStack() }) { homeNav.openFolder(it) } }
                        composable("genre/{name}") { entry ->
                            val name = entry.arguments?.getString("name").orEmpty()
                            SongsScreen(vm, name, vm.genreTracks(name), actions, bottomPadding) { nav.popBackStack() }
                        }
                        composable("folder/{name}") { entry ->
                            val name = entry.arguments?.getString("name").orEmpty()
                            SongsScreen(vm, name.trimEnd('/').substringAfterLast('/').ifBlank { name }, vm.folderTracks(name), actions, bottomPadding) { nav.popBackStack() }
                        }
                        composable("apple") {
                            AppleMusicScreen(vm, bottomPadding, onBack = { nav.popBackStack() }) { url -> nav.navigate("apple/c?url=${enc(url)}") }
                        }
                        composable("apple/c?url={url}") { entry ->
                            AppleCollectionScreen(
                                vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() },
                                onOpen = { url -> nav.navigate("apple/c?url=${enc(url)}") }, onOpenPlaylist = homeNav.openUserPlaylist, onToast = { toast = it },
                            )
                        }
                        composable("spotify") {
                            SpotifyScreen(vm, bottomPadding, onBack = { nav.popBackStack() }, onOpenSettings = homeNav.openSettings) { url -> nav.navigate("spotify/c?url=${enc(url)}") }
                        }
                        composable("spotify/c?url={url}") { entry ->
                            SpotifyCollectionScreen(vm, entry.arguments?.getString("url").orEmpty(), bottomPadding, onBack = { nav.popBackStack() }, onOpenPlaylist = homeNav.openUserPlaylist, onToast = { toast = it })
                        }
                        composable("userplaylist/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                            PlaylistScreen(vm, entry.arguments?.getLong("id") ?: 0L, actions, bottomPadding) { nav.popBackStack() }
                        }
                        composable("playlist/{kind}") { entry ->
                            val kind = runCatching { AutoPlaylist.valueOf(entry.arguments?.getString("kind").orEmpty()) }.getOrDefault(AutoPlaylist.Favorites)
                            val flow = when (kind) {
                                AutoPlaylist.Favorites -> vm.favorites
                                AutoPlaylist.RecentlyAdded -> vm.recentlyAdded
                                AutoPlaylist.MostPlayed -> vm.topMostPlayed
                                AutoPlaylist.RecentlyPlayed -> vm.recentlyPlayed
                            }
                            SongsScreen(vm, kind.title, flow, actions, bottomPadding) { nav.popBackStack() }
                        }
                    }
                },
                overlay = {
                    if (hasMedia) {
                        PlayerSheet(
                            vm,
                            open = playerOpen,
                            onOpenChange = { playerOpen = it },
                            onOpenQueue = { queueOpen = true },
                            onOpenAlbum = { playerOpen = false; nav.navigate("album/${it.albumId}") },
                            onOpenArtist = { playerOpen = false; nav.navigate("artist/${enc(it.artist)}") },
                            onInfo = { infoTarget = it },
                            onAddToPlaylist = { addTarget = listOf(it) },
                            onOpenLyrics = { lyricsOpen = true },
                            onOpenEqualiser = { playerOpen = false; nav.navigate("equaliser") { launchSingleTop = true } },
                        )
                    }
                    HiveToast(toast, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = bottomPadding + 16.dp)) { toast = null }
                    AnimatedVisibility(queueOpen, enter = slideInVertically(Motion.open()) { it } + fadeIn(Motion.underFade()), exit = slideOutVertically(Motion.close()) { it } + fadeOut(Motion.close())) {
                        QueueScreen(vm) { queueOpen = false }
                    }
                    AnimatedVisibility(lyricsOpen, enter = slideInVertically(Motion.open()) { it } + fadeIn(Motion.underFade()), exit = slideOutVertically(Motion.close()) { it } + fadeOut(Motion.close())) {
                        LyricsScreen(vm) { lyricsOpen = false }
                    }
                },
            )
        }
        infoTarget?.let { t -> TrackInfoSheet(vm, t, onDismiss = { infoTarget = null }) { playerOpen = false; nav.navigate("album/${it.albumId}") } }
        addTarget?.let { tracks -> AddToPlaylistSheet(vm, tracks, onDismiss = { addTarget = null }) { name -> toast = "Added to $name" } }
        BackHandler(enabled = playerOpen || queueOpen || lyricsOpen || drawer.isOpen) {
            when {
                drawer.isOpen -> scope.launch { drawer.close() }
                lyricsOpen -> lyricsOpen = false
                queueOpen -> queueOpen = false
                else -> playerOpen = false
            }
        }
    }
}

/**
 * Hive's sidebar as a drawer: the brand, the library views, the phone's
 * folders and genres, then Settings. The current view is lit the way Hive
 * lights `.sidebar-item.active`: an accent-soft wash from the left with a 2dp
 * accent bar.
 */
@Composable
private fun Sidebar(vm: MainViewModel, current: String, go: (String) -> Unit) {
    val c = Hive.colors
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    // The drawer sits above the blur layer, so it is Hive's strong panel made solid rather than glass.
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(topEnd = 24.dp, bottomEnd = 24.dp)
    Column(
        Modifier.fillMaxHeight().width(290.dp).clip(shape).background(c.control).border(1.dp, hiveGlassBorder(), shape)
            .statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 14.dp),
    ) {
        Row(Modifier.padding(start = 8.dp, bottom = 18.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Image(painterResource(R.drawable.hive_logo), null, Modifier.size(30.dp))
            Spacer(Modifier.width(10.dp))
            Text("Hive", style = HiveText.brand.copy(fontSize = HiveText.viewTitle.fontSize), color = c.text)
        }
        SidebarItem("Music", Icons.Rounded.LibraryMusic, current == "home") { go("home") }
        SidebarItem("Favorites", Icons.Rounded.Favorite, current == "playlist/{kind}Favorites", countOf(favorites.size, "track")) { go("playlist/${AutoPlaylist.Favorites.name}") }
        SidebarDivider("Library")
        SidebarItem("History", Icons.Rounded.History, current == "playlist/{kind}RecentlyPlayed") { go("playlist/${AutoPlaylist.RecentlyPlayed.name}") }
        SidebarItem("Top 25 Most Played", Icons.Rounded.TrendingUp, current == "playlist/{kind}MostPlayed") { go("playlist/${AutoPlaylist.MostPlayed.name}") }
        SidebarItem("Recently Added", Icons.Rounded.NewReleases, current == "playlist/{kind}RecentlyAdded") { go("playlist/${AutoPlaylist.RecentlyAdded.name}") }
        SidebarDivider("Streaming")
        SidebarItem("Apple Music", Icons.Rounded.Explore, current == "apple" || current.startsWith("apple/")) { go("apple") }
        SidebarItem("Spotify", Icons.Rounded.GraphicEq, current == "spotify" || current.startsWith("spotify/")) { go("spotify") }
        SidebarDivider("This phone")
        SidebarItem("Genres", Icons.Rounded.Category, current == "genres") { go("genres") }
        SidebarItem("Folders", Icons.Rounded.Folder, current == "folders") { go("folders") }
        Spacer(Modifier.height(18.dp))
        SidebarItem("Settings", Icons.Rounded.Settings, current == "settings") { go("settings") }
    }
}

@Composable
private fun SidebarItem(label: String, icon: ImageVector, active: Boolean, detail: String? = null, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().height(46.dp).clip(HiveShape.row)
            .drawBehind {
                if (active) {
                    drawRect(Brush.horizontalGradient(listOf(c.accentSoft, Color.Transparent)))
                    drawRect(c.accent, size = Size(2.dp.toPx(), size.height))
                }
            }
            .clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, tint = if (active) c.accent else c.textDim, modifier = Modifier.size(19.dp))
        Text(label, style = HiveText.body, color = if (active) c.text else c.textDim, modifier = Modifier.weight(1f))
        if (detail != null) Text(detail, style = HiveText.small, color = c.textDimmer)
    }
}

@Composable
private fun SidebarDivider(label: String) {
    HiveLabel(label, Modifier.padding(start = 12.dp, top = 18.dp, bottom = 6.dp))
}

/** Genres or folders as a list. */
@Composable
private fun NamedListScreen(
    title: String,
    source: kotlinx.coroutines.flow.StateFlow<List<com.local.hive.mobile.data.NamedCount>>,
    icon: ImageVector,
    bottomPadding: androidx.compose.ui.unit.Dp,
    onBack: () -> Unit,
    open: (String) -> Unit,
) {
    val items by source.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        Box(Modifier.fillMaxSize().padding(horizontal = 8.dp).hiveGlass(HiveShape.panel)) {
            androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = bottomPadding + 12.dp)) {
                item { PanelHeader(title) }
                if (items.isEmpty()) item { EmptyState("Nothing here yet", "") }
                items(items.size, key = { items[it].name }) { i ->
                    val g = items[i]
                    val name = g.name.trimEnd('/').substringAfterLast('/').ifBlank { g.name.ifBlank { "Music" } }
                    LibraryRow(null, icon, name, if (g.name.contains('/')) "${countOf(g.trackCount, "track")} · /${g.name}" else countOf(g.trackCount, "track")) { open(g.name) }
                }
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
