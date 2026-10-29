package com.local.hive.mobile.ui

import androidx.compose.foundation.combinedClickable
import kotlinx.coroutines.flow.first
import com.local.hive.mobile.ui.theme.HiveIcons
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.FileOpen
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.NewReleases
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Podcasts
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.TrendingUp
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
import androidx.compose.animation.togetherWith
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.PlaylistEntry
import com.local.hive.mobile.data.PlaylistRow
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.mix
import kotlinx.coroutines.launch

/** The library's tabs, in Samsung Music's order, with Hive's Browse for everything beyond the phone. */
enum class HomeTab(val label: String) {
    Favorites("Favorites"), Playlists("Playlists"), Albums("Albums"), Tracks("Tracks"), Artists("Artists"),
    Browse("Browse"), Genres("Genres"), Folders("Folders"),
}

/** Auto playlists, shown in the Playlists tab. */
enum class AutoPlaylist(val title: String) {
    Favorites("Favorites"),
    RecentlyAdded("Recently added"),
    MostPlayed("Most played"),
    RecentlyPlayed("Recently played"),
    TopRated("Top rated"),
}

data class HomeNavigation(
    val openAlbum: (Long) -> Unit,
    val openArtist: (String) -> Unit,
    val openGenre: (String) -> Unit,
    val openFolder: (String) -> Unit,
    val openPlaylist: (AutoPlaylist) -> Unit,
    val openUserPlaylist: (Long) -> Unit,
    val openPcPlaylist: (String) -> Unit,
    val openSearch: () -> Unit,
    val openSettings: () -> Unit,
    /** Any other page by its route: "apple", "radio", "wrap", … */
    val open: (String) -> Unit,
    /** Auto DJ from a held artist or playlist. */
    val autoDj: (AutoDjRequest) -> Unit = {},
    /** A held artist or playlist: play, queue, add to a playlist or Auto DJ it as a whole. */
    val collection: (AutoDjRequest) -> Unit = autoDj,
)

private enum class AlbumSort(val label: String) { Year("Release"), Name("Name"), Artist("Artist"), Added("Date added") }
private enum class ArtistSort(val label: String) { Name("Name"), Songs("Most tracks") }
private enum class TrackSort(val label: String) { Title("Name"), Artist("Artist"), Album("Album"), Added("Date added"), Length("Length") }

/**
 * Home, laid out as Samsung Music lays out its library: the app's name with
 * Create playlist, Search and More on the right, the tabs beneath, and each
 * tab a full-width list that opens with its sort control. Hive gives it its
 * look: the cover-lit backdrop, Hive's tabs and accent, Inter.
 */
@Composable
fun HomeScreen(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottomPadding: Dp) {
    val tabs = HomeTab.entries
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE) }
    // Opens on the tab used last, as Samsung Music does.
    val pager = rememberPagerState(initialPage = prefs.getInt("tab", HomeTab.Albums.ordinal).coerceIn(tabs.indices)) { tabs.size }
    val tabRow = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var naming by remember { mutableStateOf(false) }
    LaunchedEffect(pager.currentPage) {
        prefs.edit().putInt("tab", pager.currentPage).apply()
        // The chosen tab slides into view, with its neighbour showing there's more.
        tabRow.animateScrollToItem((pager.currentPage - 1).coerceAtLeast(0))
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        HomeBar(vm, nav, onCreatePlaylist = { naming = true })
        LazyRow(Modifier.fillMaxWidth(), state = tabRow, contentPadding = PaddingValues(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            itemsIndexed(tabs) { i, tab -> HiveTab(tab.label, pager.currentPage == i, { scope.launch { pager.animateScrollToPage(i, animationSpec = Motion.move()) } }) }
        }
        Spacer(Modifier.height(4.dp))
        HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 0, key = { tabs[it] }) { page ->
            when (tabs[page]) {
                HomeTab.Favorites -> FavoritesTab(vm, nav, actions, bottomPadding)
                HomeTab.Playlists -> PlaylistsTab(vm, nav, bottomPadding) { naming = true }
                HomeTab.Albums -> AlbumsTab(vm, nav, bottomPadding)
                HomeTab.Tracks -> TracksTab(vm, actions, bottomPadding)
                HomeTab.Artists -> ArtistsTab(vm, nav, bottomPadding)
                HomeTab.Browse -> BrowseTab(vm, nav, bottomPadding)
                HomeTab.Genres -> NamedTab(vm.genres, Icons.Rounded.Category, "No genres yet", bottomPadding, nav.openGenre)
                HomeTab.Folders -> NamedTab(vm.folders, Icons.Rounded.Folder, "No folders yet", bottomPadding, nav.openFolder)
            }
        }
    }
    if (naming) NameDialog("New playlist", "", "Create", onDismiss = { naming = false }) { name ->
        naming = false
        vm.createPlaylist(name, onCreated = nav.openUserPlaylist)
    }
}

/** Hive's brand on the left; Create playlist, Search and More on the right, as Samsung Music's bar has them. */
@Composable
private fun HomeBar(vm: MainViewModel, nav: HomeNavigation, onCreatePlaylist: () -> Unit) {
    val c = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().height(60.dp).padding(start = 20.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        // Hive's mark in the theme's accent, glowing with it.
        HiveMark(Modifier.size(30.dp).shadow(10.dp, androidx.compose.foundation.shape.CircleShape, ambientColor = c.accentGlow, spotColor = c.accentGlow))
        Spacer(Modifier.width(10.dp))
        Text("Hive", style = HiveText.viewTitle, color = c.text, modifier = Modifier.weight(1f))
        BarIcon(Icons.Rounded.Add, "Create playlist", onCreatePlaylist)
        BarIcon(Icons.Rounded.Search, "Search", nav.openSearch)
        Box {
            BarIcon(Icons.Rounded.MoreVert, "More options", { menu = true })
            HiveMenu(menu, { menu = false }) {
                HiveMenuItem("Equaliser", Icons.Rounded.GraphicEq) { menu = false; nav.open("equaliser") }
                HiveMenuItem("Yearly Wrap", Icons.Rounded.AutoAwesome) { menu = false; nav.open("wrap") }
                if (link.paired) HiveMenuItem("Playing on your PC", Icons.Rounded.Devices) { menu = false; nav.open("remote") }
                HiveMenuDivider()
                HiveMenuItem("Settings", Icons.Rounded.Settings) { menu = false; nav.openSettings() }
            }
        }
    }
}

/**
 * Samsung Music's list header: the sort on the left ("Name ▾"), opening a
 * menu of orders; Hive adds the count, Shuffle and Play on the right.
 */
@Composable
fun <T> ListHeader(
    sorts: List<T>,
    sort: T?,
    label: (T) -> String,
    onSort: (T) -> Unit,
    count: String,
    onShuffle: (() -> Unit)? = null,
    onPlay: (() -> Unit)? = null,
) {
    val c = Hive.colors
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().height(52.dp).padding(start = 10.dp, end = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        if (sort != null) Box {
            Row(Modifier.height(40.dp).clip(HiveShape.pill).clickable { open = true }.padding(start = 10.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label(sort), style = HiveText.rowStrong, color = c.text)
                Icon(Icons.Rounded.ArrowDropDown, "Sort", tint = c.textDim, modifier = Modifier.size(22.dp))
            }
            HiveMenu(open, { open = false }) {
                Text("Sort by", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(start = 12.dp, top = 6.dp, bottom = 4.dp))
                sorts.forEach { s -> HiveMenuItem(label(s), if (s == sort) Icons.Rounded.Check else null) { open = false; onSort(s) } }
            }
        }
        Text(count, style = HiveText.small, color = c.textDim, modifier = Modifier.weight(1f).padding(start = if (sort != null) 6.dp else 10.dp))
        if (onShuffle != null) ControlButton(HiveIcons.Shuffle, "Shuffle", onShuffle, size = 38.dp)
        if (onPlay != null) { Spacer(Modifier.width(8.dp)); AccentPlayButton(false, onPlay, size = 38.dp) }
    }
}

// ---- Albums ----

/** A two-column grid of covers; with Release order, under Hive's year headings. Tapping a cover opens its album. */
@Composable
private fun AlbumsTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val albums by vm.albums.collectAsStateWithLifecycle()
    var sort by rememberSetting("sort.albums", AlbumSort.Year)
    val sections by rememberComputed(emptyList<Pair<String, List<AlbumSummary>>>(), albums, sort) {
        when (sort) {
            AlbumSort.Year -> albums.groupBy { it.year }.toSortedMap(compareByDescending { it }).map { (y, list) -> (if (y > 0) "$y" else "Unknown year") to list }
            AlbumSort.Name -> listOf("" to albums)
            AlbumSort.Artist -> listOf("" to LibrarySort.sorted(albums, compareBy { it.year }) { it.artist })
            AlbumSort.Added -> listOf("" to albums.sortedByDescending { it.added })
        }
    }
    val list = rememberLazyListState()
    // Each grid row's albums by its item key, and every album in order, for hold-and-drag picking.
    val rows = remember(sections) { sections.flatMap { (_, l) -> l.chunked(2) }.associate { row -> "r${row.first().albumId}" as Any to row.map { it.albumId } } }
    val order = remember(sections) { sections.flatMap { (_, l) -> l.map { it.albumId } } }
    PickableList(albums = order)
    LazyColumn(Modifier.fillMaxSize().albumDragSelect(list, rows, order), state = list, contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(AlbumSort.entries, sort, { it.label }, { sort = it }, countOf(albums.size, "album")) }
        if (albums.isEmpty()) item { EmptyState("No albums yet", "Albums appear once Hive finds music on this phone.") }
        sections.forEach { (heading, list) ->
            if (heading.isNotBlank()) item(key = "y$heading") { YearHeading(heading) }
            list.chunked(2).forEach { row ->
                item(key = "r${row.first().albumId}") {
                    CoverRow(row) { a, m -> AlbumCard(a, m) { nav.openAlbum(a.albumId) } }
                }
            }
        }
    }
}

/** A library album as Hive's album card; hold to start picking albums (and drag over others), tap to add or remove while picking. */
@Composable
internal fun AlbumCard(a: AlbumSummary, modifier: Modifier, onClick: () -> Unit) {
    val selection = LocalSelection.current
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    CoverCard(
        Uri.parse("content://media/external/audio/albumart/${a.albumId}"), a.album.ifBlank { "Unknown album" }, a.artist.ifBlank { "Unknown artist" }, modifier,
        artModifier = Modifier.sharedCover("album-${a.albumId}"),
        picked = selection?.hasAlbum(a.albumId) == true,
        onLongClick = selection?.let { s -> { haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); s.startAlbumDrag(a.albumId) } },
        onClick = { if (selection?.active == true) selection.toggleAlbum(a.albumId) else onClick() },
    )
}

// ---- Tracks ----

/** Songs in one of Samsung Music's orders; called off the main thread. */
/** Favorite files and liked streamed songs as one list, ordered by [sort] ("Added": newest favorited first). */
private fun favoriteRows(tracks: List<Track>, streams: List<Pair<StreamTrack, Long>>, sort: TrackSort, favoritedAt: Map<Long, Long>): List<PlaylistRow> {
    class Fav(val row: PlaylistRow, val title: String, val artist: String, val album: String, val at: Long, val length: Long)
    val all = tracks.map { Fav(PlaylistRow(PlaylistEntry(playlistId = 0, trackId = it.id, position = 0), it, null), it.title, it.artist, it.album, favoritedAt[it.id] ?: 0, it.durationMs) } +
        streams.map { (s, at) -> Fav(PlaylistRow(PlaylistEntry(playlistId = 0, trackId = 0, position = 0, streamKey = s.key), null, s), s.title, s.artist, s.album, at, s.durationMs) }
    return when (sort) {
        TrackSort.Title -> LibrarySort.sorted(all) { it.title }
        TrackSort.Artist -> LibrarySort.sorted(all, compareBy<Fav> { it.album }) { it.artist }
        TrackSort.Album -> LibrarySort.sorted(all) { it.album }
        TrackSort.Added -> all.sortedByDescending { it.at }
        TrackSort.Length -> all.sortedByDescending { it.length }
    }.map { it.row }
}

private fun sortTracks(tracks: List<Track>, sort: TrackSort): List<Track> = when (sort) {
    TrackSort.Title -> LibrarySort.sorted(tracks) { it.title }
    TrackSort.Artist -> LibrarySort.sorted(tracks, compareBy<Track> { it.album }.thenBy { it.trackNumber }) { it.artist }
    TrackSort.Album -> LibrarySort.sorted(tracks, compareBy<Track> { it.discNumber }.thenBy { it.trackNumber }) { it.album }
    TrackSort.Added -> tracks.sortedByDescending { it.dateAdded }
    TrackSort.Length -> tracks.sortedByDescending { it.durationMs }
}

/** Every song, in any of Samsung Music's orders, with the A–Z index on name order. */
@Composable
private fun TracksTab(vm: MainViewModel, actions: TrackActions, bottom: Dp) {
    val all by vm.tracks.collectAsStateWithLifecycle()
    var sort by rememberSetting("sort.tracks", TrackSort.Title)
    val tracks by rememberComputed(all, all, sort) { sortTracks(all, sort) }
    TrackList(vm, tracks, actions, bottom, "No music yet", "Hive plays the music stored on this phone.", indexed = sort == TrackSort.Title,
        sortHeader = { count, shuffle, play -> ListHeader(TrackSort.entries, sort, { it.label }, { sort = it }, count, shuffle, play) })
}

/**
 * Songs with Shuffle and Play over them and, in name order, the A–Z index.
 * [sortHeader] replaces the plain header with one that has a sort.
 */
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
    sortHeader: (@Composable (count: String, shuffle: () -> Unit, play: () -> Unit) -> Unit)? = null,
    // Files and streamed songs together (Favorites with liked streamed songs), in order, playing as one queue.
    rows: List<PlaylistRow>? = null,
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val titles = remember(tracks, rows) { rows?.map { it.track?.title ?: it.stream?.title.orEmpty() } ?: tracks.map { it.title } }
    val firstByLetter by rememberComputed(emptyMap(), titles, indexed) {
        if (!indexed) emptyMap() else buildMap { titles.forEachIndexed { i, t -> putIfAbsent(indexLetter(LibrarySort.key(t)), i) } }
    }
    val showIndex = indexed && titles.size > 30
    if (rows == null) PickableList(tracks = tracks) else PickableList(tracks = rows.mapNotNull { it.track }, streams = rows.filter { it.track == null }.mapNotNull { it.stream })
    val play = { if (rows == null) vm.play(tracks) else vm.playRows(rows) }
    val shuffle = { if (rows == null) vm.shuffle(tracks) else vm.playRows(rows, shuffle = true) }
    // Hold a song and drag: the songs between are picked (keys as the rows below use them).
    val dragRows: Map<Any, Any> = remember(tracks, rows) {
        if (rows == null) tracks.associateBy<Track, Any> { it.id }
        else rows.mapNotNull { r -> r.track?.let { t -> (t.id.toString() as Any) to (t as Any) } ?: r.stream?.let { st -> (st.key as Any) to (st as Any) } }.toMap()
    }
    val dragOrder: List<Any> = remember(tracks, rows) { rows?.mapNotNull { it.track ?: it.stream } ?: tracks }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().songDragSelect(list, dragRows, dragOrder), state = list, contentPadding = PaddingValues(bottom = bottom + 12.dp, end = if (showIndex) 14.dp else 0.dp)) {
            if (header != null) item { header() }
            if (titles.isEmpty()) { if (loaded) item { EmptyState(emptyTitle, emptyBody) } }
            else {
                item {
                    val count = countOf(titles.size, "track")
                    if (sortHeader != null) sortHeader(count, shuffle, play)
                    else ListHeader(emptyList<Unit>(), null, { "" }, {}, "$count · ${formatLength(tracks.sumOf { it.durationMs })}", shuffle, play)
                }
                if (rows == null) itemsIndexed(tracks, key = { _, t -> t.id }, contentType = { _, _ -> "track" }) { i, t ->
                    // Rows glide into place when the list changes (a sort, a deletion, a new song).
                    Box(Modifier.animateItem()) { TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) }) }
                } else itemsIndexed(rows, key = { _, r -> r.track?.id?.toString() ?: r.stream?.key.orEmpty() }, contentType = { _, _ -> "track" }) { i, r ->
                    Box(Modifier.animateItem()) {
                        val t = r.track
                        if (t != null) TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.playRows(rows, i) })
                        else r.stream?.let { st -> StreamRow(st, now.mediaId == st.key, now.isPlaying, full, onClick = { vm.playRows(rows, i) }, vm = vm) }
                    }
                }
            }
        }
        if (showIndex) {
            IndexBar(IndexLetters, onLetter = { ch ->
                val target = IndexLetters.dropWhile { it != ch }.firstNotNullOfOrNull { firstByLetter[it] } ?: titles.lastIndex
                scope.launch { list.scrollToItem(target + 1 + if (header != null) 1 else 0) }
            }, modifier = Modifier.align(Alignment.CenterEnd).padding(top = 56.dp, bottom = bottom))
        }
    }
}

// ---- Artists ----

@Composable
private fun ArtistsTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val all by vm.artists.collectAsStateWithLifecycle()
    var sort by rememberSetting("sort.artists", ArtistSort.Name)
    val artists = remember(all, sort) { if (sort == ArtistSort.Songs) all.sortedByDescending { it.trackCount } else all }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(ArtistSort.entries, sort, { it.label }, { sort = it }, countOf(artists.size, "artist")) }
        if (artists.isEmpty()) item { EmptyState("No artists yet", "") }
        items(artists, key = { it.artist }) { a ->
            ArtistRow(vm, a, onLongClick = { nav.collection(AutoDjRequest(a.artist) { vm.artistTracks(a.artist).first() }) }) { nav.openArtist(a.artist) }
        }
    }
}

@Composable
private fun ArtistRow(vm: MainViewModel, a: ArtistSummary, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    // Hive's artist photo once found, the artist's album cover until then.
    val photo by produceState<String?>(null, a.artist) { value = vm.artistImage(a.artist) }
    LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist, "${countOf(a.albumCount, "album")} · ${countOf(a.trackCount, "track")}", round = true, onLongClick = onLongClick, onClick = onClick)
}

/** A row for things that aren't songs: art, name, detail line. */
@Composable
fun LibraryRow(art: Any?, fallback: ImageVector, title: String, subtitle: String, round: Boolean = false, trailing: String? = null, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        modifier.fillMaxWidth().padding(horizontal = 8.dp).height(68.dp).clip(HiveShape.row).combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Artwork(art, Modifier.size(48.dp), if (round) CircleShape else HiveShape.thumb, fallback)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) Text(trailing, style = HiveText.numbers, color = c.textDimmer)
    }
}

// ---- Playlists ----

/**
 * Samsung Music's Playlists tab: the automatic playlists as cards along the
 * top, then the user's own (with Create and Import), then the PC's.
 */
@Composable
private fun PlaylistsTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp, onCreate: () -> Unit) {
    val favorites by vm.favorites.collectAsStateWithLifecycle()
    val likedStreams by vm.streamFavorites.collectAsStateWithLifecycle()
    val recent by vm.recentlyAdded.collectAsStateWithLifecycle()
    val most by vm.mostPlayed.collectAsStateWithLifecycle()
    val played by vm.recentlyPlayed.collectAsStateWithLifecycle()
    val rated by vm.topRated.collectAsStateWithLifecycle()
    val mine by vm.playlists.collectAsStateWithLifecycle()
    val smartLists by vm.smartPlaylists.collectAsStateWithLifecycle()
    var newSmart by remember { mutableStateOf(false) }
    if (newSmart) SmartPlaylistDialog(vm, null, onDismiss = { newSmart = false }) { id -> newSmart = false; nav.open("smart/$id") }
    val onPc by vm.pcPlaylists.collectAsStateWithLifecycle()
    val link by vm.link.collectAsStateWithLifecycle()
    LaunchedEffect(link.paired) { if (link.paired) runCatching { vm.pcLibrary.refresh() } }
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
    val smart = listOf(
        Triple(AutoPlaylist.Favorites, favorites, Icons.Rounded.Favorite),
        Triple(AutoPlaylist.RecentlyAdded, recent, Icons.Rounded.NewReleases),
        Triple(AutoPlaylist.MostPlayed, most.take(25), Icons.Rounded.TrendingUp),
    )
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
            item {
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    // Favorites counts the liked streamed songs it lists too.
                    // Holding a card opens the playlist's menu, as holding a playlist does.
                    items(smart) { (kind, tracks, icon) -> SmartCard(kind.title, countOf(tracks.size + if (kind == AutoPlaylist.Favorites) likedStreams.size else 0, "track"), tracks.map { it.artworkUri }.distinct().take(4), icon,
                        onLongClick = { nav.collection(AutoDjRequest(kind.title) { tracks }) }) { nav.openPlaylist(kind) } }
                    // Recently played holds streamed songs too, so it's built from its rows.
                    item { SmartCard(AutoPlaylist.RecentlyPlayed.title, countOf(played.size, "track"), played.mapNotNull { it.art }.distinct().take(4), Icons.Rounded.History,
                        onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.RecentlyPlayed.title) { played.mapNotNull { it.track } }) }) { nav.openPlaylist(AutoPlaylist.RecentlyPlayed) } }
                    item { SmartCard(AutoPlaylist.TopRated.title, countOf(rated.size, "track"), rated.map { it.artworkUri }.distinct().take(4), Icons.Rounded.Star,
                        onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.TopRated.title) { rated }) }) { nav.openPlaylist(AutoPlaylist.TopRated) } }
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 8.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("My playlists", style = HiveText.year, color = Hive.colors.text, modifier = Modifier.weight(1f))
                    BarIcon(Icons.Rounded.FileOpen, "Import M3U", { importer.launch(arrayOf("audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "*/*")) })
                    BarIcon(Icons.Rounded.Add, "Create playlist", onCreate)
                }
            }
            // Favorites heads the user's playlists too, not only as the card above.
            item(key = "favorites") {
                LibraryRow(favorites.firstOrNull()?.artworkUri ?: likedStreams.firstOrNull()?.first?.artworkUrl, Icons.Rounded.Favorite, AutoPlaylist.Favorites.title,
                    countOf(favorites.size + likedStreams.size, "track"), modifier = Modifier.animateItem(),
                    onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.Favorites.title) { favorites }) }) { nav.openPlaylist(AutoPlaylist.Favorites) }
            }
            if (mine.isEmpty()) item { LibraryRow(null, Icons.Rounded.Add, "Create playlist", "Or add songs from any ⋮ menu", onClick = onCreate) }
            // Smart playlists: made here by rules, kept up to date by themselves.
            items(smartLists, key = { "smart" + it.id }) { p ->
                LibraryRow(null, Icons.Rounded.AutoAwesome, p.name, "Smart · " + countOf(p.rules.size, "rule"), modifier = Modifier.animateItem(),
                    onLongClick = { nav.collection(AutoDjRequest(p.name) { vm.smartTracks(p.id).first() }) }) { nav.open("smart/${p.id}") }
            }
            item { NewSmartPlaylistRow { newSmart = true } }
            items(mine, key = { it.id }) { p ->
                LibraryRow(playlistCover(p), Icons.AutoMirrored.Rounded.QueueMusic, p.name, listOfNotNull(countOf(p.trackCount, "track"), p.source.ifBlank { null }).joinToString(" · "), modifier = Modifier.animateItem(),
                    onLongClick = { nav.collection(AutoDjRequest(p.name) { vm.playlistRows(p.id).first().mapNotNull { it.track } }) }) { nav.openUserPlaylist(p.id) }
            }
            if (link.paired && onPc.isNotEmpty()) {
                // The PC's name is already "Hive on <PC>".
                item { Text(link.serverName.ifBlank { "On your PC" }, style = HiveText.year, color = Hive.colors.text, modifier = Modifier.padding(start = 18.dp, top = 22.dp, bottom = 6.dp)) }
                items(onPc, key = { "pc" + it.id }) { p ->
                    LibraryRow(vm.pcLibrary.coverFor(p.cover) ?: p.artworkUrl.ifBlank { null }, Icons.AutoMirrored.Rounded.QueueMusic, p.name, countOf(p.songs.size, "song")) { nav.openPcPlaylist(p.id) }
                }
            }
        }
        note?.let {
            Text(it, style = HiveText.pill, color = Hive.colors.text, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = bottom + 20.dp).clip(HiveShape.pill).background(Hive.colors.control).padding(horizontal = 18.dp, vertical = 10.dp))
        }
    }
}

/** An automatic playlist as a card: up to four of its covers in a square, its name and size. */
@Composable
private fun SmartCard(title: String, detail: String, covers: List<Any>, icon: ImageVector, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val c = Hive.colors
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    Column(Modifier.width(132.dp).pressable(onClick, onLongClick = onLongClick?.let { hold -> { haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); hold() } })) {
        Box(Modifier.size(132.dp).shadow(12.dp, HiveShape.art, ambientColor = c.accentGlow).clip(HiveShape.art).background(mix(c.accent, c.panelStrong, 0.12f))) {
            when {
                // A tile whose song has no cover shows another of the four, never an empty square.
                covers.size >= 4 -> Column {
                    covers.chunked(2).forEachIndexed { r, pair -> Row(Modifier.weight(1f)) { pair.forEachIndexed { i, cover ->
                        Artwork(cover, Modifier.weight(1f).fillMaxSize(), androidx.compose.ui.graphics.RectangleShape, orElse = covers[(r * 2 + i + 1) % covers.size])
                    } } }
                }
                covers.isNotEmpty() -> Artwork(covers.first(), Modifier.fillMaxSize(), androidx.compose.ui.graphics.RectangleShape)
            }
            // Hive's mark of what the list is, in a glass chip.
            Box(Modifier.align(Alignment.BottomStart).padding(8.dp).size(30.dp).hiveGlass(CircleShape, strength = 0.4f), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = c.accent, modifier = Modifier.size(16.dp))
            }
        }
        Text(title, style = HiveText.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        Text(detail, style = HiveText.cardSub, color = c.textDim, maxLines = 1)
    }
}

// ---- Favorites ----

private enum class FavoriteView(val label: String) { Tracks("Tracks"), Albums("Albums"), Artists("Artists") }

/** Which Favorites to show: the current one as a heading with ▾, the rest in a menu with their counts. */
@Composable
private fun FavoriteViewPicker(view: FavoriteView, counts: Map<FavoriteView, Int>, onPick: (FavoriteView) -> Unit) {
    val c = Hive.colors
    var open by remember { mutableStateOf(false) }
    Box(Modifier.padding(start = 10.dp, top = 6.dp, bottom = 2.dp)) {
        Row(Modifier.height(44.dp).clip(HiveShape.pill).clickable { open = true }.padding(start = 10.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(view.label, style = HiveText.rowStrong.copy(fontSize = 19.sp), color = c.text)
            Icon(Icons.Rounded.ArrowDropDown, "Show favorite tracks, albums or artists", tint = c.textDim, modifier = Modifier.size(24.dp))
        }
        HiveMenu(open, { open = false }) {
            FavoriteView.entries.forEach { v ->
                HiveMenuItem("${v.label} · ${"%,d".format(counts[v] ?: 0)}", if (v == view) Icons.Rounded.Check else null) { open = false; onPick(v) }
            }
        }
    }
}

/**
 * Favorites with Samsung Music's switch at the top: Tracks is every song
 * you've favorited, Albums the albums you've hearted (each opening the whole
 * album). They're kept apart, as Samsung Music keeps them.
 */
@Composable
private fun FavoritesTab(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottom: Dp) {
    val allTracks by vm.favorites.collectAsStateWithLifecycle()
    val allStreams by vm.streamFavorites.collectAsStateWithLifecycle()
    val favoritedAt by vm.favoritedAt.collectAsStateWithLifecycle()
    val allAlbums by vm.favoriteAlbums.collectAsStateWithLifecycle()
    // Searching Favorites searches only Favorites: songs by title, artist or album, albums by name or artist.
    var query by rememberSaveable { mutableStateOf("") }
    val q = LibrarySort.words(query)
    val tracks by rememberComputed(allTracks, allTracks, q) { if (q.isEmpty()) allTracks else allTracks.filter { LibrarySort.matches("${it.title} ${it.artist} ${it.album}", q) } }
    val streams by rememberComputed(allStreams, allStreams, q) { if (q.isEmpty()) allStreams else allStreams.filter { (s, _) -> LibrarySort.matches("${s.title} ${s.artist} ${s.album}", q) } }
    val albums by rememberComputed(allAlbums, allAlbums, q) { if (q.isEmpty()) allAlbums else allAlbums.filter { LibrarySort.matches("${it.album} ${it.artist}", q) } }
    var view by rememberSetting("view.favorites", FavoriteView.Tracks)
    var sort by rememberSaveable { mutableStateOf(TrackSort.Added) }
    // The artists of favorite songs, most favorited first.
    val artists by rememberComputed(emptyList(), allTracks, q) {
        allTracks.filter { it.artist.isNotBlank() && LibrarySort.matches(it.artist, q) }.groupBy { it.artist }
            .map { (name, songs) -> ArtistSummary(name, songs.first().albumId, songs.distinctBy { it.albumId }.size, songs.size) }
            .let { list -> LibrarySort.sorted(list) { it.artist } }
            .sortedByDescending { it.trackCount } // stable: equal counts stay in name order
    }
    val counts = mapOf(FavoriteView.Tracks to tracks.size + streams.size, FavoriteView.Albums to albums.size, FavoriteView.Artists to artists.size)
    Column(Modifier.fillMaxSize()) {
        FavoriteViewPicker(view, counts) { view = it }
        // Hidden until the list is pulled down past its top.
        val search = rememberPullToReveal(keepShown = query.isNotEmpty())
        androidx.compose.animation.AnimatedVisibility(search.shown, enter = androidx.compose.animation.expandVertically(Motion.open()) + androidx.compose.animation.fadeIn(Motion.swap()),
            exit = androidx.compose.animation.shrinkVertically(Motion.close()) + androidx.compose.animation.fadeOut(Motion.underFade())) {
            SearchField(query, { query = it }, "Search Favorites", onSubmit = {}, onClear = { query = "" }, modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 6.dp))
        }
        androidx.compose.animation.AnimatedContent(view, Modifier.nestedScroll(search.connection), transitionSpec = {
            val dir = if (targetState.ordinal > initialState.ordinal) 1 else -1
            (androidx.compose.animation.slideInHorizontally(Motion.move()) { it / 6 * dir } + androidx.compose.animation.fadeIn(Motion.swap()))
                .togetherWith(androidx.compose.animation.slideOutHorizontally(Motion.move()) { -it / 6 * dir } + androidx.compose.animation.fadeOut(Motion.underFade()))
        }, label = "favoritesView") { shown ->
            when (shown) {
                FavoriteView.Tracks -> {
                    // Favorites come newest-favorited first, which is what "Added" shows here.
                    val sorted by rememberComputed(tracks, tracks, sort) { if (sort == TrackSort.Added) tracks else sortTracks(tracks, sort) }
                    // Liked streamed songs among them, in the same order.
                    val rows by rememberComputed<List<PlaylistRow>?>(null, tracks, streams, sort, favoritedAt) { if (streams.isEmpty()) null else favoriteRows(tracks, streams, sort, favoritedAt) }
                    TrackList(vm, sorted, actions, bottom, rows = rows, emptyTitle = if (q.isEmpty()) "No favorite songs yet" else "No favorite songs match", emptyBody = if (q.isEmpty()) "Tap ♥ on a song, or pair with Hive on your PC to bring your Favorites over." else "Nothing in Favorites matches “${query.trim()}”.",
                        indexed = sort == TrackSort.Title,
                        sortHeader = { count, shuffle, play -> ListHeader(TrackSort.entries, sort, { if (it == TrackSort.Added) "Date favorited" else it.label }, { sort = it }, count, shuffle, play) })
                }
                FavoriteView.Artists -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (artists.isEmpty()) item { if (q.isEmpty()) EmptyState("No favorite artists yet", "Artists show up here once you ♥ their songs.") else EmptyState("No favorite artists match", "Nothing in Favorites matches “${query.trim()}”.") }
                    items(artists, key = { it.artist }) { a ->
                        val photo by produceState<String?>(null, a.artist) { value = vm.artistImage(a.artist) }
                        LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist,
                            countOf(a.trackCount, "favorite song"), round = true) { nav.openArtist(a.artist) }
                    }
                }
                FavoriteView.Albums -> {
                    val list = rememberLazyListState()
                    val rows = remember(albums) { albums.chunked(2).associate { row -> "f${row.first().albumId}" as Any to row.map { it.albumId } } }
                    val order = remember(albums) { albums.map { it.albumId } }
                    PickableList(albums = order)
                    LazyColumn(Modifier.fillMaxSize().albumDragSelect(list, rows, order), state = list, contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (albums.isEmpty()) item { if (q.isEmpty()) EmptyState("No favorite albums yet", "Tap ♥ on an album's page to keep it here.") else EmptyState("No favorite albums match", "Nothing in Favorites matches “${query.trim()}”.") }
                    albums.chunked(2).forEach { row ->
                        item(key = "f${row.first().albumId}") {
                            CoverRow(row) { a, m -> AlbumCard(a, m) { nav.openAlbum(a.albumId) } }
                        }
                    }
                    }
                }
            }
        }
    }
}

// ---- Browse ----

/** Everything beyond the phone's own files: the streaming services, radio, podcasts and Hive on the PC. */
@Composable
private fun BrowseTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val link by vm.link.collectAsStateWithLifecycle()
    val tiles = buildList {
        add(Triple("Apple Music", "Charts and shared links", Icons.Rounded.Explore) to "apple")
        add(Triple("Spotify", "Playlists and shared links", Icons.Rounded.GraphicEq) to "spotify")
        add(Triple("Radio", "Stations worldwide", Icons.Rounded.Radio) to "radio")
        add(Triple("Podcasts", "Shows and episodes", Icons.Rounded.Podcasts) to "podcasts")
        if (link.paired) {
            add(Triple("PC library", "Every song on your PC", Icons.Rounded.Computer) to "pc")
            add(Triple("Playing on your PC", "Control it from here", Icons.Rounded.Devices) to "remote")
        }
        add(Triple("Yearly Wrap", "Your year in music", Icons.Rounded.AutoAwesome) to "wrap")
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp, bottom = bottom + 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(tiles.chunked(2)) { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { (t, route) -> BrowseTile(t.first, t.second, t.third, Modifier.weight(1f)) { nav.open(route) } }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun BrowseTile(title: String, detail: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Column(modifier.height(124.dp).pressable(onClick).hiveGlass(HiveShape.panel, strength = 0.1f).padding(16.dp)) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(mix(c.accent, c.panelStrong, 0.22f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = c.accent, modifier = Modifier.size(21.dp))
        }
        Spacer(Modifier.weight(1f))
        Text(title, style = HiveText.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(detail, style = HiveText.cardSub, color = c.textDim, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

// ---- Genres and Folders ----

@Composable
private fun NamedTab(source: kotlinx.coroutines.flow.StateFlow<List<NamedCount>>, icon: ImageVector, empty: String, bottom: Dp, open: (String) -> Unit) {
    val items by source.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(emptyList<Unit>(), null, { "" }, {}, countOf(items.size, if (icon == Icons.Rounded.Folder) "folder" else "genre")) }
        if (items.isEmpty()) item { EmptyState(empty, "") }
        items(items, key = { it.name }) { g ->
            val name = g.name.trimEnd('/').substringAfterLast('/').ifBlank { g.name.ifBlank { "Music" } }
            LibraryRow(null, icon, name, if (g.name.contains('/')) "${countOf(g.trackCount, "track")} · /${g.name}" else countOf(g.trackCount, "track")) { open(g.name) }
        }
    }
}

/** The view header used by pages that keep a title in the list. */
@Composable
internal fun PanelHeader(title: String, controls: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, top = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HiveText.viewTitle, color = Hive.colors.text, modifier = Modifier.weight(1f))
        controls()
    }
}
