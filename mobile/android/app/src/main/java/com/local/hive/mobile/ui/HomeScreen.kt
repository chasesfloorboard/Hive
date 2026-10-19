package com.local.hive.mobile.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.TrendingUp
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.NewReleases
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

enum class HomeTab(val label: String) { Favorites("Favorites"), Playlists("Playlists"), Albums("Albums"), Tracks("Tracks"), Artists("Artists"), Genres("Genres"), Folders("Folders") }

/** Auto playlists, the way Samsung Music's Playlists tab leads with them. */
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottomPadding: androidx.compose.ui.unit.Dp) {
    val colors = Hive.colors
    val tabs = HomeTab.entries
    val pager = rememberPagerState(initialPage = HomeTab.Tracks.ordinal) { tabs.size }
    val scope = rememberCoroutineScope()

    BoxWithConstraints(Modifier.fillMaxSize()) {
        // One UI's large title: about a third of the screen when expanded,
        // collapsing into the toolbar as the list scrolls.
        val density = LocalDensity.current
        val toolbarPx = with(density) { 56.dp.toPx() }
        val expandedPx = with(density) { (maxHeight * 0.3f).toPx() }.coerceAtLeast(toolbarPx * 2)
        val range = expandedPx - toolbarPx
        var collapse by remember { mutableFloatStateOf(0f) } // 0 expanded … range collapsed
        val connection = remember(range) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    if (available.y >= 0) return Offset.Zero
                    val before = collapse
                    collapse = (collapse - available.y).coerceIn(0f, range)
                    return Offset(0f, -(collapse - before))
                }
                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    if (available.y <= 0) return Offset.Zero
                    val before = collapse
                    collapse = (collapse - available.y).coerceIn(0f, range)
                    return Offset(0f, before - collapse)
                }
            }
        }
        val progress = if (range > 0) collapse / range else 1f
        val headerHeight = with(density) { (expandedPx - collapse).toDp() }

        Column(Modifier.fillMaxSize().nestedScroll(connection)) {
            Box(Modifier.fillMaxWidth().statusBarsPadding().height(headerHeight)) {
                // Expanded title, centred in the space above the toolbar.
                Column(
                    Modifier.fillMaxWidth().padding(bottom = 56.dp).align(Alignment.Center).alpha(1f - progress * 1.6f),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("Hive", color = colors.text, fontSize = 40.sp, fontWeight = FontWeight.Light)
                    val count = vm.tracks.collectAsStateWithLifecycle().value.size
                    if (count > 0) Text("$count tracks", color = colors.textDim, fontSize = 14.sp)
                }
                Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(56.dp).padding(start = 20.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Hive", color = colors.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f).alpha(((progress - 0.5f) * 2f).coerceIn(0f, 1f)))
                    IconButton(onClick = nav.openSearch) { Icon(Icons.Rounded.Search, "Search", tint = colors.text) }
                    IconButton(onClick = nav.openSettings) { Icon(Icons.Rounded.Settings, "Settings", tint = colors.text) }
                }
            }
            SecondaryScrollableTabRow(
                selectedTabIndex = pager.currentPage,
                containerColor = colors.bg,
                contentColor = colors.text,
                edgePadding = 12.dp,
                divider = {},
                indicator = {
                    TabRowDefaults.SecondaryIndicator(
                        Modifier.tabIndicatorOffset(pager.currentPage, matchContentSize = true),
                        height = 2.dp,
                        color = colors.text,
                    )
                },
            ) {
                tabs.forEachIndexed { i, tab ->
                    Tab(
                        selected = pager.currentPage == i,
                        onClick = { scope.launch { pager.animateScrollToPage(i) } },
                        text = {
                            Text(
                                tab.label,
                                fontSize = 15.sp,
                                fontWeight = if (pager.currentPage == i) FontWeight.SemiBold else FontWeight.Normal,
                                color = if (pager.currentPage == i) colors.text else colors.textDim,
                            )
                        },
                    )
                }
            }
            HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
                val pad = PaddingValues(bottom = bottomPadding + 8.dp)
                when (tabs[page]) {
                    HomeTab.Favorites -> FavoritesTab(vm, actions, pad)
                    HomeTab.Playlists -> PlaylistsTab(vm, nav, pad)
                    HomeTab.Albums -> AlbumsTab(vm.albums.collectAsStateWithLifecycle().value, nav.openAlbum, pad)
                    HomeTab.Tracks -> TracksTab(vm, actions, pad)
                    HomeTab.Artists -> ArtistsTab(vm.artists.collectAsStateWithLifecycle().value, nav.openArtist, pad)
                    HomeTab.Genres -> NamedTab(vm.genres.collectAsStateWithLifecycle().value, Icons.Rounded.Category, "No genres", nav.openGenre, pad)
                    HomeTab.Folders -> NamedTab(vm.folders.collectAsStateWithLifecycle().value, Icons.Rounded.Folder, "No folders", nav.openFolder, pad)
                }
            }
        }
    }
}

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
    LazyColumn(Modifier.fillMaxSize(), contentPadding = contentPadding) {
        if (header != null) item { header() }
        if (tracks.isEmpty()) item { EmptyState(emptyTitle, emptyBody) }
        else {
            item { ListHeader(tracks.size, "track", { vm.shuffle(tracks) }, { vm.play(tracks) }) }
            itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                TrackRow(t, t.id in loved, now.trackId == t.id, actions, onClick = { vm.play(tracks, i) })
            }
        }
    }
}

@Composable
private fun FavoritesTab(vm: MainViewModel, actions: TrackActions, pad: PaddingValues) {
    val tracks by vm.favorites.collectAsStateWithLifecycle()
    TrackList(vm, tracks, actions, pad, "No favorites yet", "Tap ♥ on a song, or pair with Hive on your PC to bring your Favorites over.")
}

@Composable
private fun TracksTab(vm: MainViewModel, actions: TrackActions, pad: PaddingValues) {
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    TrackList(vm, tracks, actions, pad, "No music found", "Hive shows the music stored on this phone. Allow access to music, or rescan in Settings.")
}

@Composable
private fun PlaylistsTab(vm: MainViewModel, nav: HomeNavigation, pad: PaddingValues) {
    val colors = Hive.colors
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    val recent by vm.recentlyAdded.collectAsStateWithLifecycle()
    val most by vm.mostPlayed.collectAsStateWithLifecycle()
    val played by vm.recentlyPlayed.collectAsStateWithLifecycle()
    val counts = mapOf(
        AutoPlaylist.Favorites to favorites.size, AutoPlaylist.RecentlyAdded to recent.size,
        AutoPlaylist.MostPlayed to most.size, AutoPlaylist.RecentlyPlayed to played.size,
    )
    LazyColumn(Modifier.fillMaxSize(), contentPadding = pad) {
        item {
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(AutoPlaylist.entries.drop(1)) { p ->
                    Column(Modifier.width(120.dp).clickable { nav.openPlaylist(p) }) {
                        Box(Modifier.size(120.dp).clip(RoundedCornerShape(colors.radius)).background(colors.control), contentAlignment = Alignment.Center) {
                            Icon(p.icon, null, tint = colors.accent, modifier = Modifier.size(40.dp))
                        }
                        Text(p.title, color = colors.text, fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp), maxLines = 1)
                        Text("${counts[p]} tracks", color = colors.textDim, fontSize = 12.sp)
                    }
                }
            }
        }
        item {
            Row(
                Modifier.fillMaxWidth().clickable { nav.openPlaylist(AutoPlaylist.Favorites) }.padding(horizontal = 20.dp).height(64.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(46.dp).clip(RoundedCornerShape(8.dp)).background(colors.control), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Favorite, null, tint = colors.accent)
                }
                Spacer(Modifier.width(14.dp))
                Text("Favorites", color = colors.text, fontSize = 16.sp, modifier = Modifier.weight(1f))
                Text("${favorites.size} tracks", color = colors.textDim, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun AlbumsTab(albums: List<AlbumSummary>, open: (Long) -> Unit, pad: PaddingValues) {
    val colors = Hive.colors
    LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = pad.calculateBottomPadding()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        item(span = { GridItemSpan(maxLineSpan) }) { ListHeader(albums.size, "album", null, null) }
        if (albums.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { EmptyState("No albums", "Albums appear once Hive finds music on this phone.") }
        items(albums, key = { it.albumId }) { a ->
            Column(Modifier.clickable { open(a.albumId) }.padding(vertical = 8.dp)) {
                Artwork(android.net.Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.fillMaxWidth().aspectRatio(1f), RoundedCornerShape(colors.radius), Icons.Rounded.LibraryMusic)
                Text(a.album.ifBlank { "Unknown album" }, color = colors.text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                Text(a.artist.ifBlank { "Unknown artist" }, color = colors.textDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun ArtistsTab(artists: List<ArtistSummary>, open: (String) -> Unit, pad: PaddingValues) {
    val colors = Hive.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = pad) {
        item { ListHeader(artists.size, "artist", null, null) }
        if (artists.isEmpty()) item { EmptyState("No artists", "Artists appear once Hive finds music on this phone.") }
        items(artists, key = { it.artist }) { a ->
            Row(Modifier.fillMaxWidth().clickable { open(a.artist) }.padding(horizontal = 20.dp).height(64.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(46.dp).clip(CircleShape).background(colors.control), contentAlignment = Alignment.Center) {
                    Text(a.artist.take(1).uppercase(), color = colors.text, fontSize = 18.sp)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(a.artist, color = colors.text, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${a.albumCount} albums · ${a.trackCount} tracks", color = colors.textDim, fontSize = 13.sp)
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
        items(items, key = { it.name }) { g ->
            Row(Modifier.fillMaxWidth().clickable { open(g.name) }.padding(horizontal = 20.dp).height(64.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(46.dp).clip(RoundedCornerShape(8.dp)).background(colors.control), contentAlignment = Alignment.Center) {
                    Icon(icon, null, tint = colors.textDim)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(g.name.substringAfterLast('/').ifBlank { g.name.ifBlank { "Music" } }, color = colors.text, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (g.name.contains('/')) "${g.trackCount} tracks · ${g.name}" else "${g.trackCount} tracks", color = colors.textDim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
