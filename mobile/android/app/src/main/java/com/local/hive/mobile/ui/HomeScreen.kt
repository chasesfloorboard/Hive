package com.local.hive.mobile.ui

import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.OneUi
import kotlinx.coroutines.launch
import kotlin.math.abs

enum class HomeTab(val label: String) { Favorites("Favorites"), Playlists("Playlists"), Albums("Albums"), Tracks("Tracks"), Artists("Artists"), Genres("Genres"), Folders("Folders") }

/** Auto playlists, which Samsung Music's Playlists tab leads with. */
enum class AutoPlaylist(val title: String) {
    Favorites("Favorites"),
    RecentlyAdded("Recently added"),
    MostPlayed("Most played"),
    RecentlyPlayed("Recently played"),
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

/**
 * Samsung Music's main screen: the app name with search and ⋮, the One UI tab
 * row (the current tab large, the rest small, sliding to centre as you swipe),
 * and one rounded panel holding the current tab.
 */
@Composable
fun HomeScreen(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottomPadding: Dp) {
    val tabs = HomeTab.entries
    val pager = rememberPagerState(initialPage = HomeTab.Tracks.ordinal) { tabs.size }
    var menu by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(OneUi.Window).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 24.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Hive", style = OneUi.AppTitle, color = OneUi.Text1, modifier = Modifier.weight(1f))
            BarIcon(Icons.Rounded.Search, "Search", nav.openSearch)
            Box {
                BarIcon(Icons.Rounded.MoreVert, "More options", { menu = true })
                OneUiMenu(menu, { menu = false }) {
                    OneUiMenuItem("Settings") { menu = false; nav.openSettings() }
                }
            }
        }
        OneUiTabs(tabs.map { it.label }, pager)
        Box(
            Modifier
                .fillMaxSize()
                .padding(horizontal = 4.dp)
                .clip(OneUi.PanelShape)
                .background(OneUi.Panel),
        ) {
            HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
                val bottom = bottomPadding + 12.dp
                when (tabs[page]) {
                    HomeTab.Favorites -> FavoritesTab(vm, nav, bottom)
                    HomeTab.Playlists -> PlaylistsTab(vm, nav, bottom)
                    HomeTab.Albums -> AlbumsTab(vm.albums.collectAsStateWithLifecycle().value, nav.openAlbum, bottom)
                    HomeTab.Tracks -> TracksTab(vm, actions, bottom)
                    HomeTab.Artists -> ArtistsTab(vm.artists.collectAsStateWithLifecycle().value, nav.openArtist, bottom)
                    HomeTab.Genres -> NamedTab(vm.genres.collectAsStateWithLifecycle().value, Icons.Rounded.Category, "No genres", nav.openGenre, bottom)
                    HomeTab.Folders -> NamedTab(vm.folders.collectAsStateWithLifecycle().value, Icons.Rounded.Folder, "No folders", nav.openFolder, bottom, isFolder = true)
                }
            }
        }
    }
}

/**
 * One UI's tab row: text only, no indicator. The current tab is drawn large
 * and white and the others small and grey; sizes follow the pager while you
 * swipe, and the current tab is brought to the middle.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun OneUiTabs(labels: List<String>, pager: PagerState) {
    val scope = rememberCoroutineScope()
    val row = rememberLazyListState()
    LaunchedEffect(pager.currentPage) { centre(row, pager.currentPage) }
    LazyRow(
        state = row,
        modifier = Modifier.fillMaxWidth().height(52.dp),
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        itemsIndexed(labels) { i, label ->
            val distance = abs(i - (pager.currentPage + pager.currentPageOffsetFraction)).coerceAtMost(1f)
            val emphasis = 1f - distance
            Text(
                label,
                style = OneUi.TabOther.copy(fontSize = lerp(OneUi.TabOther.fontSize, OneUi.TabSelected.fontSize, emphasis)),
                color = androidx.compose.ui.graphics.lerp(OneUi.Text4, OneUi.Text1, emphasis),
                maxLines = 1,
                modifier = Modifier.clickable { scope.launch { pager.animateScrollToPage(i, animationSpec = Motion.move()) } },
            )
        }
    }
}

private suspend fun centre(row: LazyListState, index: Int) {
    val info = row.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }
    if (info == null) { row.animateScrollToItem(index); return }
    val viewportCentre = (row.layoutInfo.viewportStartOffset + row.layoutInfo.viewportEndOffset) / 2
    row.animateScrollBy((info.offset + info.size / 2 - viewportCentre).toFloat(), Motion.move())
}

// ---- tabs ----

@Composable
private fun TracksTab(vm: MainViewModel, actions: TrackActions, bottom: Dp) {
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    TrackList(vm, tracks, actions, bottom, "No music", "Hive plays the music stored on this phone.", sortLabel = "Name", indexed = true)
}

/** Songs with Samsung's sort bar and, for long lists, the A–Z index. */
@Composable
fun TrackList(
    vm: MainViewModel,
    tracks: List<Track>,
    actions: TrackActions,
    bottom: Dp,
    emptyTitle: String,
    emptyBody: String,
    sortLabel: String,
    indexed: Boolean = false,
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val firstByLetter = remember(tracks) {
        buildMap { tracks.forEachIndexed { i, t -> putIfAbsent(indexLetter(LibrarySort.key(t.title)), i) } }
    }
    val showIndex = indexed && tracks.size > 30
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottom)) {
            if (tracks.isEmpty()) { if (loaded) item { EmptyState(emptyTitle, emptyBody) } }
            else {
                item { SortBar(sortLabel, onShuffle = { vm.shuffle(tracks) }, onPlay = { vm.play(tracks) }) }
                itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                    TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) }, endPadding = if (showIndex) 28.dp else 4.dp)
                }
            }
        }
        if (showIndex) {
            IndexBar(
                IndexLetters,
                onLetter = { c -> scope.launch { list.scrollToItem(jumpIndex(firstByLetter, c, tracks.lastIndex) + 1) } },
                modifier = Modifier.align(Alignment.CenterEnd).padding(top = 64.dp, bottom = bottom, end = 4.dp),
            )
        }
    }
}

/** The first item filed under [letter], or under the next letter that has any. */
private fun jumpIndex(firstByLetter: Map<Char, Int>, letter: Char, last: Int): Int =
    IndexLetters.dropWhile { it != letter }.firstNotNullOfOrNull { firstByLetter[it] } ?: last

/**
 * Favorites as Samsung shows them: large rounded cards, the type and name
 * written over the art, the count beneath. Hive's Love is per song, so the
 * cards are Favorite tracks, then the albums and artists those songs are on.
 */
@Composable
private fun FavoritesTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    val cards = remember(favorites) {
        val albums = favorites.groupBy { it.albumId }.values.sortedByDescending { it.size }.take(24)
        val artists = favorites.filter { it.artist.isNotBlank() }.groupBy { it.artist }.values.sortedByDescending { it.size }.take(12)
        buildList {
            val a = albums.iterator()
            val b = artists.iterator()
            while (a.hasNext() || b.hasNext()) {
                if (a.hasNext()) add(false to a.next())
                if (b.hasNext()) add(true to b.next())
            }
        }
    }
    if (favorites.isEmpty()) {
        if (loaded) EmptyState("No favorites yet", "Tap ♥ on a song, or pair with Hive on your PC to bring your Favorites over.")
        return
    }
    LazyVerticalGrid(
        GridCells.Fixed(2), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 16.dp, bottom = bottom),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { FavoriteCard(favorites.first().artworkUri, null, "Favorite tracks", countOf(favorites.size, "track"), dim = true) { nav.openPlaylist(AutoPlaylist.Favorites) } }
        items(cards) { (isArtist, tracks) ->
            val first = tracks.first()
            if (isArtist) {
                FavoriteCard(first.artworkUri, "Artists", first.artist, "${countOf(tracks.distinctBy { it.albumId }.size, "album")}   ${countOf(tracks.size, "track")}") { nav.openArtist(first.artist) }
            } else {
                FavoriteCard(first.artworkUri, "Albums", first.album.ifBlank { "Unknown album" }, countOf(tracks.size, "track")) { nav.openAlbum(first.albumId) }
            }
        }
    }
}

@Composable
private fun FavoriteCard(art: Any?, kind: String?, name: String, caption: String, dim: Boolean = false, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(OneUi.Hero)) {
            Artwork(art, Modifier.fillMaxSize(), OneUi.Hero, Icons.Rounded.Favorite)
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = if (dim) 0.45f else 0.15f), Color.Black.copy(alpha = if (dim) 0.45f else 0.35f)))))
            Column(Modifier.align(Alignment.Center).padding(horizontal = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (kind != null) Text(kind, style = OneUi.Sub, color = Color.White.copy(alpha = 0.85f))
                Text(name, style = OneUi.Title, color = Color.White, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(caption, style = OneUi.Sub, color = OneUi.Text2, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun PlaylistsTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    val recent by vm.recentlyAdded.collectAsStateWithLifecycle()
    val most by vm.mostPlayed.collectAsStateWithLifecycle()
    val played by vm.recentlyPlayed.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom)) {
        item {
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(listOf(AutoPlaylist.RecentlyAdded to recent, AutoPlaylist.MostPlayed to most, AutoPlaylist.RecentlyPlayed to played)) { (kind, tracks) ->
                    Column(Modifier.width(132.dp).clickable { nav.openPlaylist(kind) }, horizontalAlignment = Alignment.CenterHorizontally) {
                        Artwork(tracks.firstOrNull()?.artworkUri, Modifier.size(132.dp), OneUi.Cover, Icons.Rounded.LibraryMusic)
                        Text(kind.title, style = OneUi.Sub, color = OneUi.Text1, modifier = Modifier.padding(top = 8.dp), maxLines = 1)
                        Text(countOf(tracks.size, "track"), style = OneUi.Sub, color = OneUi.TextSub)
                    }
                }
            }
        }
        item { SortBar("Name") }
        item { LibraryRow(favorites.firstOrNull()?.artworkUri, Icons.Rounded.Favorite, "Favorites", countOf(favorites.size, "track")) { nav.openPlaylist(AutoPlaylist.Favorites) } }
    }
}

@Composable
private fun AlbumsTab(albums: List<AlbumSummary>, open: (Long) -> Unit, bottom: Dp) {
    LazyVerticalGrid(
        GridCells.Fixed(2), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = bottom),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) { SortBar("Name") }
        if (albums.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { EmptyState("No albums", "") }
        items(albums, key = { it.albumId }) { a ->
            Column(Modifier.clickable { open(a.albumId) }, horizontalAlignment = Alignment.CenterHorizontally) {
                Artwork(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.fillMaxWidth().aspectRatio(1f), OneUi.Hero, Icons.Rounded.LibraryMusic)
                Text(a.album.ifBlank { "Unknown album" }, style = OneUi.GridTitle, color = OneUi.Text1, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp))
                Text("${a.artist.ifBlank { "Unknown" }} | ${countOf(a.trackCount, "track")}", style = OneUi.Sub, color = OneUi.TextSub, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 4.dp))
            }
        }
    }
}

@Composable
private fun ArtistsTab(artists: List<ArtistSummary>, open: (String) -> Unit, bottom: Dp) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val firstByLetter = remember(artists) { buildMap { artists.forEachIndexed { i, a -> putIfAbsent(indexLetter(LibrarySort.key(a.artist)), i) } } }
    val showIndex = artists.size > 30
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottom)) {
            item { SortBar("Name") }
            if (artists.isEmpty()) item { EmptyState("No artists", "") }
            items(artists, key = { it.artist }) { a ->
                LibraryRow(
                    Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist,
                    "${countOf(a.albumCount, "album")} | ${countOf(a.trackCount, "track")}", endPadding = if (showIndex) 28.dp else OneUi.Gutter,
                ) { open(a.artist) }
            }
        }
        if (showIndex) {
            IndexBar(
                IndexLetters,
                onLetter = { c -> scope.launch { list.scrollToItem(jumpIndex(firstByLetter, c, artists.lastIndex) + 1) } },
                modifier = Modifier.align(Alignment.CenterEnd).padding(top = 64.dp, bottom = bottom, end = 4.dp),
            )
        }
    }
}

@Composable
private fun NamedTab(items: List<NamedCount>, icon: ImageVector, empty: String, open: (String) -> Unit, bottom: Dp, isFolder: Boolean = false) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom)) {
        item { SortBar("Name") }
        if (items.isEmpty()) item { EmptyState(empty, "") }
        items(items, key = { it.name }) { g ->
            val name = if (isFolder) g.name.trimEnd('/').substringAfterLast('/').ifBlank { "Music" } else g.name
            LibraryRow(null, icon, name, if (isFolder) "/${g.name}" else countOf(g.trackCount, "track")) { open(g.name) }
        }
    }
}

/** A Samsung list row for things that aren't songs: art, name, detail line. */
@Composable
fun LibraryRow(art: Any?, fallback: ImageVector, title: String, subtitle: String, endPadding: Dp = OneUi.Gutter, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(OneUi.RowHeight).clickable(onClick = onClick)) {
        Row(Modifier.fillMaxSize().padding(start = OneUi.Gutter, end = endPadding), verticalAlignment = Alignment.CenterVertically) {
            Artwork(art, Modifier.size(OneUi.ThumbSize), OneUi.Thumb, fallback)
            Spacer(Modifier.width(OneUi.ThumbGap))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = OneUi.Title, color = OneUi.Text1, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(subtitle, style = OneUi.Sub, color = OneUi.TextSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Box(Modifier.align(Alignment.BottomStart).padding(start = OneUi.DividerInset, end = OneUi.Gutter).fillMaxWidth().height(0.5.dp).background(OneUi.Divider))
    }
}
