package com.local.hive.mobile.ui

import android.net.Uri
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.NewReleases
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.TrendingUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.GlassWeight
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveType
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.Radius
import com.local.hive.mobile.ui.theme.Space
import com.local.hive.mobile.ui.theme.GlassLayers
import com.local.hive.mobile.ui.theme.glass
import com.local.hive.mobile.ui.theme.glassEdge
import kotlinx.coroutines.launch

enum class HomeTab(val label: String) { Favorites("Favorites"), Playlists("Playlists"), Albums("Albums"), Tracks("Tracks"), Artists("Artists"), Genres("Genres"), Folders("Folders") }

/** Auto playlists, which Samsung Music's Playlists tab leads with. */
enum class AutoPlaylist(val title: String, val icon: ImageVector) {
    Favorites("Favorites", Icons.Rounded.Favorite),
    RecentlyAdded("Recently added", Icons.Rounded.NewReleases),
    MostPlayed("Most played", Icons.Rounded.TrendingUp),
    RecentlyPlayed("Recently played", Icons.Rounded.History),
}

data class HomeNavigation(
    val openAlbum: (Long) -> Unit,
    val openArtist: (String) -> Unit,
    val openGenre: (String) -> Unit,
    val openFolder: (String) -> Unit,
    val openPlaylist: (AutoPlaylist) -> Unit,
    val openSearch: () -> Unit,
    val openSettings: () -> Unit,
)

private val BarHeight = 60.dp

@Composable
fun HomeScreen(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottomPadding: Dp) {
    val colors = Hive.colors
    val tabs = HomeTab.entries
    val pager = rememberPagerState(initialPage = HomeTab.Tracks.ordinal) { tabs.size }
    val scope = rememberCoroutineScope()
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    val albums by vm.albums.collectAsStateWithLifecycle()
    val artists by vm.artists.collectAsStateWithLifecycle()
    val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()

    BoxWithConstraints(Modifier.fillMaxSize()) {
        // One UI's large title: a quarter of the screen when expanded, folding
        // away as the list scrolls until only the glass bar remains.
        val density = LocalDensity.current
        val titlePx = with(density) { (maxHeight * 0.24f).toPx() }
        var collapse by remember { mutableFloatStateOf(0f) }
        val connection = remember(titlePx) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    if (available.y >= 0) return Offset.Zero
                    val before = collapse
                    collapse = (collapse - available.y).coerceIn(0f, titlePx)
                    return Offset(0f, -(collapse - before))
                }
                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    if (available.y <= 0) return Offset.Zero
                    val before = collapse
                    collapse = (collapse - available.y).coerceIn(0f, titlePx)
                    return Offset(0f, before - collapse)
                }
            }
        }
        val progress = if (titlePx > 0) collapse / titlePx else 1f
        val titleHeight = with(density) { (titlePx - collapse).toDp() }

        Column(Modifier.fillMaxSize().nestedScroll(connection)) {
            Spacer(Modifier.height(statusTop))
            Box(Modifier.fillMaxWidth().height(titleHeight), contentAlignment = Alignment.Center) {
                Column(Modifier.alpha((1f - progress * 1.7f).coerceIn(0f, 1f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Hive", style = HiveType.display, color = colors.text)
                    if (tracks.isNotEmpty()) {
                        Text(
                            "%,d songs · %,d albums · %,d artists".format(tracks.size, albums.size, artists.size),
                            style = HiveType.secondary, color = colors.textDim, modifier = Modifier.padding(top = Space.xs),
                        )
                    }
                }
            }
            GlassLayers(Modifier.fillMaxSize(), content = {
                HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
                    val pad = PaddingValues(top = BarHeight + Space.xs, bottom = bottomPadding + Space.lg)
                    when (tabs[page]) {
                        HomeTab.Favorites -> FavoritesTab(vm, actions, pad)
                        HomeTab.Playlists -> PlaylistsTab(vm, nav, pad)
                        HomeTab.Albums -> AlbumsTab(albums, nav.openAlbum, pad)
                        HomeTab.Tracks -> TrackList(vm, tracks, actions, pad, "No music yet", "Hive plays the music stored on this phone. Allow access to music, or rescan in Settings.")
                        HomeTab.Artists -> ArtistsTab(artists, nav.openArtist, pad)
                        HomeTab.Genres -> NamedTab(vm.genres.collectAsStateWithLifecycle().value, Icons.Rounded.Category, "No genres", nav.openGenre, pad)
                        HomeTab.Folders -> NamedTab(vm.folders.collectAsStateWithLifecycle().value, Icons.Rounded.Folder, "No folders", nav.openFolder, pad)
                    }
                }
            }, overlay = {
                // One slim glass capsule: the tabs as pills, then search and settings.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Space.sm)
                        .height(BarHeight - Space.xs)
                        .glass(Radius.pill, GlassWeight.Thin),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val tabList = rememberLazyListState()
                    LaunchedEffect(pager.currentPage) { tabList.animateScrollToItem((pager.currentPage - 1).coerceAtLeast(0)) }
                    LazyRow(state = tabList, contentPadding = PaddingValues(horizontal = Space.xs), horizontalArrangement = Arrangement.spacedBy(Space.xxs), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.weight(1f)) {
                        itemsIndexed(tabs) { i, tab ->
                            TabPill(tab.label, pager.currentPage == i) { scope.launch { pager.animateScrollToPage(i, animationSpec = Motion.move()) } }
                        }
                    }
                    Box(Modifier.width(0.5.dp).height(22.dp).background(colors.border))
                    BarIcon(Icons.Rounded.Search, "Search", nav.openSearch)
                    BarIcon(Icons.Rounded.Settings, "Settings", nav.openSettings)
                    Spacer(Modifier.width(Space.xxs))
                }
            })
        }
    }
}

@Composable
private fun BarIcon(icon: ImageVector, label: String, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).pressable(onClick, 0.88f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = Hive.colors.text, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun TabPill(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = Hive.colors
    val fill by animateColorAsState(if (selected) colors.text.copy(alpha = 0.12f) else Color.Transparent, Motion.swap(), label = "pill")
    val text by animateColorAsState(if (selected) colors.text else colors.textDim, Motion.swap(), label = "pillText")
    Box(
        Modifier
            .height(34.dp)
            .clip(Radius.pill)
            .background(fill)
            .then(if (selected) Modifier.glassEdge(Radius.pill) else Modifier)
            .pressable(onClick, 0.94f)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveType.tab, color = text) }
}

// ---- lists ----

@Composable
fun TrackList(
    vm: MainViewModel,
    tracks: List<Track>,
    actions: TrackActions,
    contentPadding: PaddingValues,
    emptyTitle: String,
    emptyBody: String,
    header: (@Composable () -> Unit)? = null,
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = contentPadding) {
        if (header != null) item { header() }
        if (tracks.isEmpty()) { if (loaded) item { EmptyState(emptyTitle, emptyBody) } }
        else {
            item { PlayBar(tracks.size, "song", { vm.shuffle(tracks) }, { vm.play(tracks) }) }
            itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) })
            }
        }
    }
}

@Composable
private fun FavoritesTab(vm: MainViewModel, actions: TrackActions, pad: PaddingValues) {
    val tracks by vm.favorites.collectAsStateWithLifecycle()
    TrackList(vm, tracks, actions, pad, "No Favorites yet", "Tap ♥ on a song, or pair with Hive on your PC to bring your Favorites over.")
}

@Composable
private fun PlaylistsTab(vm: MainViewModel, nav: HomeNavigation, pad: PaddingValues) {
    val colors = Hive.colors
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    val recent by vm.recentlyAdded.collectAsStateWithLifecycle()
    val most by vm.mostPlayed.collectAsStateWithLifecycle()
    val played by vm.recentlyPlayed.collectAsStateWithLifecycle()
    val lists = listOf(
        Triple(AutoPlaylist.Favorites, favorites, colors.accent),
        Triple(AutoPlaylist.RecentlyAdded, recent, Color(0xFF8FB8FF)),
        Triple(AutoPlaylist.MostPlayed, most, Color(0xFFFFB38A)),
        Triple(AutoPlaylist.RecentlyPlayed, played, Color(0xFFB9A6FF)),
    )
    LazyVerticalGrid(
        GridCells.Fixed(2), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, top = pad.calculateTopPadding(), bottom = pad.calculateBottomPadding()),
        horizontalArrangement = Arrangement.spacedBy(Space.md), verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) { Text("MADE FOR YOU", style = HiveType.label, color = colors.textDimmer, modifier = Modifier.padding(top = Space.xs)) }
        items(lists) { (kind, list, hue) -> PlaylistCard(kind, list, hue) { nav.openPlaylist(kind) } }
    }
}

/** An auto playlist: a mosaic of its first covers under a wash of its colour. */
@Composable
private fun PlaylistCard(kind: AutoPlaylist, tracks: List<Track>, hue: Color, onClick: () -> Unit) {
    val colors = Hive.colors
    Column(Modifier.pressable(onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(Radius.cover).background(colors.panelStrong.copy(alpha = 1f))) {
            val covers = tracks.distinctBy { it.albumId }.take(4)
            if (covers.size >= 4) {
                Column {
                    for (row in 0..1) Row(Modifier.weight(1f)) {
                        for (col in 0..1) Artwork(covers[row * 2 + col].artworkUri, Modifier.weight(1f).fillMaxSize(), androidx.compose.ui.graphics.RectangleShape)
                    }
                }
            } else if (covers.isNotEmpty()) Artwork(covers[0].artworkUri, Modifier.fillMaxSize(), androidx.compose.ui.graphics.RectangleShape)
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(hue.copy(alpha = 0.25f), Color.Black.copy(alpha = 0.55f)))))
            Icon(kind.icon, null, tint = Color.White, modifier = Modifier.align(Alignment.BottomStart).padding(Space.md).size(26.dp))
        }
        Text(kind.title, style = HiveType.body, color = colors.text, modifier = Modifier.padding(top = Space.sm))
        Text(countOf(tracks.size, "song"), style = HiveType.secondary, color = colors.textDim)
    }
}

@Composable
private fun AlbumsTab(albums: List<AlbumSummary>, open: (Long) -> Unit, pad: PaddingValues) {
    val colors = Hive.colors
    LazyVerticalGrid(
        GridCells.Adaptive(156.dp), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, top = pad.calculateTopPadding(), bottom = pad.calculateBottomPadding()),
        horizontalArrangement = Arrangement.spacedBy(Space.md), verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) { Text("%,d ALBUMS".format(albums.size), style = HiveType.label, color = colors.textDimmer, modifier = Modifier.padding(top = Space.xs)) }
        if (albums.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { EmptyState("No albums yet", "Albums appear once Hive finds music on this phone.") }
        items(albums, key = { it.albumId }) { a ->
            Column(Modifier.pressable({ open(a.albumId) })) {
                Artwork(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.fillMaxWidth().aspectRatio(1f), Radius.cover, Icons.Rounded.LibraryMusic, elevation = 10.dp)
                Text(a.album.ifBlank { "Unknown album" }, style = HiveType.body, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = Space.sm))
                Text(listOf(a.artist.ifBlank { "Unknown artist" }, a.year.takeIf { it > 0 }?.toString()).filterNotNull().joinToString(" · "), style = HiveType.secondary, color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun ArtistsTab(artists: List<ArtistSummary>, open: (String) -> Unit, pad: PaddingValues) {
    val colors = Hive.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = pad) {
        item { SectionLabel("%,d artists".format(artists.size)) }
        if (artists.isEmpty()) item { EmptyState("No artists yet", "Artists appear once Hive finds music on this phone.") }
        items(artists, key = { it.artist }) { a ->
            Row(Modifier.fillMaxWidth().pressable({ open(a.artist) }, 0.985f).padding(horizontal = Space.gutter).height(68.dp), verticalAlignment = Alignment.CenterVertically) {
                Artwork(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.size(50.dp), CircleShape)
                Spacer(Modifier.width(Space.md))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(a.artist, style = HiveType.body, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${countOf(a.albumCount, "album")} · ${countOf(a.trackCount, "song")}", style = HiveType.secondary, color = colors.textDim)
                }
            }
        }
    }
}

@Composable
private fun NamedTab(items: List<NamedCount>, icon: ImageVector, empty: String, open: (String) -> Unit, pad: PaddingValues) {
    val colors = Hive.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = pad) {
        if (items.isEmpty()) item { EmptyState(empty, "Nothing to show here yet.") }
        else item { SectionLabel("%,d".format(items.size) + " " + empty.removePrefix("No ")) }
        items(items, key = { it.name }) { g ->
            Row(Modifier.fillMaxWidth().pressable({ open(g.name) }, 0.985f).padding(horizontal = Space.gutter).height(64.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(46.dp).glass(Radius.art, GlassWeight.Regular), contentAlignment = Alignment.Center) {
                    Icon(icon, null, tint = colors.textDim, modifier = Modifier.size(22.dp))
                }
                Spacer(Modifier.width(Space.md))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(g.name.substringAfterLast('/').ifBlank { g.name.ifBlank { "Music" } }, style = HiveType.body, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (g.name.contains('/')) "${countOf(g.trackCount, "song")} · ${g.name}" else countOf(g.trackCount, "song"), style = HiveType.secondary, color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
