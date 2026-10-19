package com.local.hive.mobile.ui

import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.FileOpen
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.R
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.FavoriteAlbum
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.mix
import kotlinx.coroutines.launch

enum class HomeTab(val label: String) { Music("Music"), Playlists("Playlists"), Favorites("Favorites") }

/** Auto playlists, shown in the Playlists tab and the sidebar. */
enum class AutoPlaylist(val title: String) {
    Favorites("Favorites"),
    RecentlyAdded("Recently Added"),
    MostPlayed("Top 25 Most Played"),
    RecentlyPlayed("History"),
}

data class HomeNavigation(
    val openAlbum: (Long) -> Unit,
    val openArtist: (String) -> Unit,
    val openGenre: (String) -> Unit,
    val openFolder: (String) -> Unit,
    val openPlaylist: (AutoPlaylist) -> Unit,
    val openUserPlaylist: (Long) -> Unit,
    val openSearch: () -> Unit,
    val openSettings: () -> Unit,
    val openSidebar: () -> Unit,
)

private enum class MusicView(val label: String) { Albums("Albums"), Tracks("Tracks"), Artists("Artists") }
private enum class AlbumSort(val label: String) { Year("Year"), Name("A–Z"), Artist("Artist"), Added("Added") }
private enum class ArtistSort(val label: String) { Name("A–Z"), Songs("Most songs") }

/**
 * Hive's main window, folded for a phone: the brand and search in the top
 * bar, the top tabs as Hive pills, and each view in a glass panel over the
 * ambient backdrop.
 */
@Composable
fun HomeScreen(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottomPadding: Dp) {
    val tabs = HomeTab.entries
    val pager = rememberPagerState { tabs.size }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 14.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.clip(HiveShape.tab).clickable(onClick = nav.openSidebar).padding(horizontal = 6.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val c = Hive.colors
                Image(painterResource(R.drawable.hive_logo), "Hive", Modifier.size(26.dp).shadow(6.dp, HiveShape.thumb, ambientColor = c.accentGlow, spotColor = c.accentGlow))
                Spacer(Modifier.width(8.dp))
                Text("Hive", style = HiveText.brand, color = c.text)
                Icon(Icons.Rounded.KeyboardArrowDown, "Open sidebar", tint = c.textDim, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.weight(1f))
            SearchPill(nav.openSearch)
        }
        LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            itemsIndexed(tabs) { i, tab -> HiveTab(tab.label, pager.currentPage == i, { scope.launch { pager.animateScrollToPage(i, animationSpec = Motion.move()) } }) }
        }
        Spacer(Modifier.height(10.dp))
        HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
            Box(Modifier.fillMaxSize().padding(horizontal = 8.dp).hiveGlass(HiveShape.panel)) {
                when (tabs[page]) {
                    HomeTab.Music -> MusicPanel(vm, nav, actions, bottomPadding)
                    HomeTab.Playlists -> PlaylistsPanel(vm, nav, bottomPadding)
                    HomeTab.Favorites -> FavoritesPanel(vm, nav, actions, bottomPadding)
                }
            }
        }
    }
}

@Composable
private fun SearchPill(onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.height(36.dp).clip(HiveShape.pill).background(mix(c.accent, c.panelStrong, 0.05f)).border(1.dp, c.border, HiveShape.pill)
            .clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.Search, null, tint = c.textDim, modifier = Modifier.size(17.dp))
        Spacer(Modifier.width(8.dp))
        Text("Search library…", style = HiveText.small, color = c.textDimmer)
    }
}

/** The view header inside a panel: the view title, with optional controls on the right. */
@Composable
internal fun PanelHeader(title: String, controls: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, top = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HiveText.viewTitle, color = Hive.colors.text, modifier = Modifier.weight(1f))
        controls()
    }
}

// ---- Music ----

@Composable
private fun MusicPanel(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottom: Dp) {
    var view by rememberSaveable { mutableStateOf(MusicView.Albums) }
    var albumSort by rememberSaveable { mutableStateOf(AlbumSort.Year) }
    var artistSort by rememberSaveable { mutableStateOf(ArtistSort.Name) }
    Column(Modifier.fillMaxSize()) {
        PanelHeader(view.label)
        HiveToggle(MusicView.entries.map { it.label }, view.ordinal, { view = MusicView.entries[it] }, Modifier.padding(horizontal = 14.dp, vertical = 4.dp))
        // Sort pills as Hive's column header offers them.
        if (view != MusicView.Tracks) androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            item { HiveLabel("Sort", Modifier.padding(end = 4.dp)) }
            if (view == MusicView.Albums) items(AlbumSort.entries) { s -> HivePill(s.label, albumSort == s) { albumSort = s } }
            else items(ArtistSort.entries) { s -> HivePill(s.label, artistSort == s) { artistSort = s } }
        }
        when (view) {
            MusicView.Albums -> AlbumsView(vm, nav, actions, albumSort, bottom)
            MusicView.Tracks -> TracksView(vm, actions, bottom)
            MusicView.Artists -> {
                val artists by vm.artists.collectAsStateWithLifecycle()
                ArtistsView(vm, remember(artists, artistSort) { if (artistSort == ArtistSort.Songs) artists.sortedByDescending { it.trackCount } else artists }, nav.openArtist, bottom)
            }
        }
    }
}

/**
 * Albums as Hive shows them: grouped by year under a heading and hairline
 * rule, two covers to a row. Tapping a cover opens the album right there in
 * the grid (Hive's inline album), below its row; tapping again closes it.
 */
@Composable
private fun AlbumsView(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, sort: AlbumSort, bottom: Dp) {
    val albums by vm.albums.collectAsStateWithLifecycle()
    var open by rememberSaveable { mutableStateOf<Long?>(null) }
    val sections = remember(albums, sort) {
        when (sort) {
            AlbumSort.Year -> albums.groupBy { it.year }.toSortedMap(compareByDescending { it }).map { (y, list) -> (if (y > 0) "$y" else "Unknown year") to list }
            AlbumSort.Name -> listOf("" to albums)
            AlbumSort.Artist -> listOf("" to albums.sortedWith(compareBy<AlbumSummary, String>(LibrarySort.collator) { LibrarySort.key(it.artist) }.thenBy { it.year }))
            AlbumSort.Added -> listOf("" to albums.sortedByDescending { it.added })
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        if (albums.isEmpty()) item { EmptyState("No albums yet", "Albums appear once Hive finds music on this phone.") }
        sections.forEach { (heading, list) ->
            if (heading.isNotBlank()) item(key = "y$heading") { YearHeading(heading) }
            list.chunked(2).forEach { row ->
                item(key = "r${row.first().albumId}") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        row.forEach { a -> AlbumCard(a, a.albumId == open, Modifier.weight(1f)) { open = if (open == a.albumId) null else a.albumId } }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
                val inRow = row.firstOrNull { it.albumId == open }
                item(key = "i${row.first().albumId}") {
                    AnimatedVisibility(inRow != null, enter = expandVertically(tween(220)) + fadeIn(tween(220)), exit = shrinkVertically(tween(180)) + fadeOut(tween(140))) {
                        inRow?.let { InlineAlbum(vm, it, actions, onOpenPage = { nav.openAlbum(it.albumId) }) }
                    }
                }
            }
        }
    }
}

/** Hive's `.album-card`: rounded art with a deep soft shadow, bold title, dim artist; an accent ring when open. */
@Composable
internal fun AlbumCard(a: AlbumSummary, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Column(modifier.pressable(onClick)) {
        Box {
            Artwork(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.fillMaxWidth().aspectRatio(1f), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 14.dp)
            if (selected) Box(Modifier.matchParentSize().border(2.dp, c.accent, HiveShape.art))
        }
        Text(a.album.ifBlank { "Unknown album" }, style = HiveText.cardTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        Text(a.artist.ifBlank { "Unknown artist" }, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Hive's inline album: an accent-tinted panel with the cover beside the
 * album's name and details, Play / Shuffle / ♥, then its tracklist.
 */
@Composable
internal fun InlineAlbum(vm: MainViewModel, a: AlbumSummary, actions: TrackActions, onOpenPage: () -> Unit) {
    val c = Hive.colors
    val tracks by remember(a.albumId) { vm.albumTracks(a.albumId) }.collectAsStateWithLifecycle(emptyList())
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val favorite = FavoriteAlbum.keyOf(a.album, a.artist) in vm.favoriteAlbumKeys.collectAsStateWithLifecycle().value
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp)
            .shadow(18.dp, HiveShape.menu, ambientColor = c.accentGlow, spotColor = Color.Black)
            .clip(HiveShape.menu)
            .background(mix(c.accent, c.panelStrong.copy(alpha = 0.96f), 0.08f))
            .border(1.dp, mix(c.accent, Color.Transparent, 0.10f), HiveShape.menu)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Artwork(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.size(112.dp).clickable(onClick = onOpenPage), androidx.compose.foundation.shape.RoundedCornerShape(6.dp), Icons.Rounded.LibraryMusic)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(a.album.ifBlank { "Unknown album" }, style = HiveText.cardTitle.copy(fontSize = HiveText.row.fontSize), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable(onClick = onOpenPage))
                Text(listOfNotNull(a.artist.ifBlank { null }, a.year.takeIf { it > 0 }?.toString()).joinToString(" · "), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 3.dp))
                Text("${countOf(tracks.size, "track")} · ${formatLength(tracks.sumOf { it.durationMs })}", style = HiveText.small, color = c.textDimmer)
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    AccentPlayButton(false, { vm.play(tracks) }, size = 38.dp)
                    ControlButton(Icons.Rounded.Shuffle, "Shuffle", { vm.shuffle(tracks) }, size = 38.dp)
                    ControlButton(if (favorite) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (favorite) "Remove album from Favorites" else "Add album to Favorites", { vm.toggleFavoriteAlbum(a.album, a.artist) }, size = 38.dp, tint = if (favorite) c.accent else null)
                }
            }
        }
        Box(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp).height(1.dp).background(c.border))
        tracks.forEachIndexed { i, t ->
            TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) }, subtitle = if (t.artist != a.artist) t.artist else "", number = t.trackNumber.takeIf { it > 0 } ?: (i + 1))
        }
    }
}

private enum class TrackSort(val label: String) { Title("Title"), Artist("Artist"), Album("Album"), Added("Added"), Length("Length") }

/** Every song, sortable like Hive's song table, with the A–Z index on title sort. */
@Composable
private fun TracksView(vm: MainViewModel, actions: TrackActions, bottom: Dp) {
    val all by vm.tracks.collectAsStateWithLifecycle()
    var sort by rememberSaveable { mutableStateOf(TrackSort.Title) }
    val tracks = remember(all, sort) {
        when (sort) {
            TrackSort.Title -> all
            TrackSort.Artist -> all.sortedWith(compareBy<Track, String>(LibrarySort.collator) { LibrarySort.key(it.artist) }.thenBy { it.album }.thenBy { it.trackNumber })
            TrackSort.Album -> all.sortedWith(compareBy<Track, String>(LibrarySort.collator) { LibrarySort.key(it.album) }.thenBy { it.discNumber }.thenBy { it.trackNumber })
            TrackSort.Added -> all.sortedByDescending { it.dateAdded }
            TrackSort.Length -> all.sortedByDescending { it.durationMs }
        }
    }
    Column(Modifier.fillMaxSize()) {
        LazyRow(contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            item { HiveLabel("Sort", Modifier.padding(end = 6.dp)) }
            items(TrackSort.entries) { s -> HivePill(s.label, s == sort) { sort = s } }
        }
        TrackList(vm, tracks, actions, bottom, "No music yet", "Hive plays the music stored on this phone.", indexed = sort == TrackSort.Title)
    }
}

/** Songs with Play all / Shuffle and, when sorted by title, the A–Z index. */
@Composable
fun TrackList(
    vm: MainViewModel,
    tracks: List<Track>,
    actions: TrackActions,
    bottom: Dp,
    emptyTitle: String,
    emptyBody: String,
    indexed: Boolean = false,
    header: (@Composable () -> Unit)? = null,
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val firstByLetter = remember(tracks, indexed) {
        if (!indexed) emptyMap() else buildMap { tracks.forEachIndexed { i, t -> putIfAbsent(indexLetter(LibrarySort.key(t.title)), i) } }
    }
    val showIndex = indexed && tracks.size > 30
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottom + 12.dp, end = if (showIndex) 14.dp else 0.dp)) {
            if (header != null) item { header() }
            if (tracks.isEmpty()) { if (loaded) item { EmptyState(emptyTitle, emptyBody) } }
            else {
                item {
                    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, top = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        HiveLabel(countOf(tracks.size, "track") + " · " + formatLength(tracks.sumOf { it.durationMs }), Modifier.weight(1f))
                        ControlButton(Icons.Rounded.Shuffle, "Shuffle", { vm.shuffle(tracks) }, size = 38.dp)
                        Spacer(Modifier.width(8.dp))
                        AccentPlayButton(false, { vm.play(tracks) }, size = 38.dp)
                    }
                }
                itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                    TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) })
                }
            }
        }
        if (showIndex) {
            IndexBar(IndexLetters, onLetter = { ch ->
                val target = IndexLetters.dropWhile { it != ch }.firstNotNullOfOrNull { firstByLetter[it] } ?: tracks.lastIndex
                scope.launch { list.scrollToItem(target + 1 + if (header != null) 1 else 0) }
            }, modifier = Modifier.align(Alignment.CenterEnd).padding(top = 48.dp, bottom = bottom))
        }
    }
}

@Composable
private fun ArtistsView(vm: MainViewModel, artists: List<ArtistSummary>, open: (String) -> Unit, bottom: Dp) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 4.dp, bottom = bottom + 12.dp)) {
        if (artists.isEmpty()) item { EmptyState("No artists yet", "") }
        items(artists, key = { it.artist }) { a ->
            // Hive's artist photo once found, the artist's album cover until then.
            val photo by produceState<String?>(null, a.artist) { value = vm.artistImage(a.artist) }
            LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist, "${countOf(a.albumCount, "album")} · ${countOf(a.trackCount, "track")}", round = true) { open(a.artist) }
        }
    }
}

/** A row for things that aren't songs: art, name, detail line. */
@Composable
fun LibraryRow(art: Any?, fallback: androidx.compose.ui.graphics.vector.ImageVector, title: String, subtitle: String, round: Boolean = false, trailing: String? = null, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        modifier.fillMaxWidth().padding(horizontal = 8.dp).height(66.dp).clip(HiveShape.row).clickable(onClick = onClick).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Artwork(art, Modifier.size(46.dp), if (round) androidx.compose.foundation.shape.CircleShape else HiveShape.thumb, fallback)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) Text(trailing, style = HiveText.numbers, color = c.textDimmer)
    }
}

// ---- Playlists and Favorites ----

@Composable
private fun PlaylistsPanel(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    val recent by vm.recentlyAdded.collectAsStateWithLifecycle()
    val most by vm.mostPlayed.collectAsStateWithLifecycle()
    val played by vm.recentlyPlayed.collectAsStateWithLifecycle()
    val mine by vm.playlists.collectAsStateWithLifecycle()
    var naming by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    // Import an M3U: matched to this phone's songs by file name, then by artist and title.
    val importer = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val name = runCatching { context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } }.getOrNull()?.substringBeforeLast('.') ?: "Imported playlist"
        val text = runCatching { context.contentResolver.openInputStream(uri)?.bufferedReader()?.readText() }.getOrNull()
        if (text == null) note = "Couldn't read that file." else vm.importM3u(name, text) { id, message -> note = message; id?.let(nav.openUserPlaylist) }
    }
    LaunchedEffect(note) { if (note != null) { kotlinx.coroutines.delay(4_000); note = null } }
    val rows = listOf(AutoPlaylist.Favorites to favorites, AutoPlaylist.RecentlyAdded to recent, AutoPlaylist.MostPlayed to most.take(25), AutoPlaylist.RecentlyPlayed to played)
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
            item { PanelHeader("Playlists") }
            item { HiveLabel("Your playlists", Modifier.padding(start = 18.dp, top = 6.dp, bottom = 6.dp)) }
            item { LibraryRow(null, Icons.Rounded.Add, "New playlist", if (mine.isEmpty()) "Make one, or add songs from any ⋯ menu" else "") { naming = true } }
            item { LibraryRow(null, Icons.Rounded.FileOpen, "Import M3U", "A playlist file from Hive, MusicBee or another player") { importer.launch(arrayOf("audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "*/*")) } }
            items(mine, key = { it.id }) { p ->
                LibraryRow(playlistCover(p), Icons.AutoMirrored.Rounded.QueueMusic, p.name, listOfNotNull(countOf(p.trackCount, "track"), p.source.ifBlank { null }).joinToString(" · "), modifier = Modifier.animateItem()) { nav.openUserPlaylist(p.id) }
            }
            item { HiveLabel("Smart playlists", Modifier.padding(start = 18.dp, top = 18.dp, bottom = 6.dp)) }
            items(rows) { (kind, tracks) ->
                LibraryRow(tracks.firstOrNull()?.artworkUri, if (kind == AutoPlaylist.Favorites) Icons.Rounded.Favorite else Icons.Rounded.LibraryMusic, kind.title, countOf(tracks.size, "track")) { nav.openPlaylist(kind) }
            }
        }
        note?.let {
            Text(it, style = HiveText.pill, color = Hive.colors.text, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = bottom + 20.dp).clip(HiveShape.pill).background(Hive.colors.control).padding(horizontal = 18.dp, vertical = 10.dp))
        }
    }
    if (naming) NameDialog("New playlist", "", "Create", onDismiss = { naming = false }) { name ->
        naming = false
        vm.createPlaylist(name, onCreated = nav.openUserPlaylist)
    }
}

@Composable
private fun FavoritesPanel(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottom: Dp) {
    val tracks by vm.favorites.collectAsStateWithLifecycle()
    val albums by vm.favoriteAlbums.collectAsStateWithLifecycle()
    TrackList(
        vm, tracks, actions, bottom,
        if (albums.isEmpty()) "No Favorites yet" else "No favorite songs yet",
        "Tap ♥ on a song or an album, or pair with Hive on your PC to bring your Favorites over.",
        header = { Column {
            PanelHeader("Favorites")
            if (albums.isNotEmpty()) {
                YearHeading("Albums")
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                    items(albums, key = { it.albumId }) { a -> AlbumCard(a, false, Modifier.width(136.dp).animateItem()) { nav.openAlbum(a.albumId) } }
                }
                if (tracks.isNotEmpty()) YearHeading("Songs")
            }
        } },
    )
}
