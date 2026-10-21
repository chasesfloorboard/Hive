package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.rounded.LibraryMusic
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.R
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
        Image(painterResource(R.drawable.hive_logo), null, Modifier.size(28.dp).shadow(8.dp, HiveShape.thumb, ambientColor = c.accentGlow, spotColor = c.accentGlow))
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
    var sort by rememberSaveable { mutableStateOf(AlbumSort.Year) }
    val sections by rememberComputed(emptyList<Pair<String, List<AlbumSummary>>>(), albums, sort) {
        when (sort) {
            AlbumSort.Year -> albums.groupBy { it.year }.toSortedMap(compareByDescending { it }).map { (y, list) -> (if (y > 0) "$y" else "Unknown year") to list }
            AlbumSort.Name -> listOf("" to albums)
            AlbumSort.Artist -> listOf("" to LibrarySort.sorted(albums, compareBy { it.year }) { it.artist })
            AlbumSort.Added -> listOf("" to albums.sortedByDescending { it.added })
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(AlbumSort.entries, sort, { it.label }, { sort = it }, countOf(albums.size, "album")) }
        if (albums.isEmpty()) item { EmptyState("No albums yet", "Albums appear once Hive finds music on this phone.") }
        sections.forEach { (heading, list) ->
            if (heading.isNotBlank()) item(key = "y$heading") { YearHeading(heading) }
            list.chunked(2).forEach { row ->
                item(key = "r${row.first().albumId}") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        row.forEach { a -> AlbumCard(a, false, Modifier.weight(1f)) { nav.openAlbum(a.albumId) } }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/** Hive's `.album-card`: rounded art with a deep soft shadow, bold title, dim artist. The cover is the album page's cover. */
@Composable
internal fun AlbumCard(a: AlbumSummary, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Column(modifier.pressable(onClick)) {
        Box {
            Artwork(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Modifier.sharedCover("album-${a.albumId}").fillMaxWidth().aspectRatio(1f), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 14.dp)
            if (selected) Box(Modifier.matchParentSize().clip(HiveShape.art).background(c.accentSoft.copy(alpha = 0.2f)))
        }
        Text(a.album.ifBlank { "Unknown album" }, style = HiveText.cardTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        Text(a.artist.ifBlank { "Unknown artist" }, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// ---- Tracks ----

/** Songs in one of Samsung Music's orders; called off the main thread. */
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
    var sort by rememberSaveable { mutableStateOf(TrackSort.Title) }
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
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val firstByLetter by rememberComputed(emptyMap(), tracks, indexed) {
        if (!indexed) emptyMap() else buildMap { tracks.forEachIndexed { i, t -> putIfAbsent(indexLetter(LibrarySort.key(t.title)), i) } }
    }
    val showIndex = indexed && tracks.size > 30
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottom + 12.dp, end = if (showIndex) 14.dp else 0.dp)) {
            if (header != null) item { header() }
            if (tracks.isEmpty()) { if (loaded) item { EmptyState(emptyTitle, emptyBody) } }
            else {
                item {
                    val count = countOf(tracks.size, "track")
                    if (sortHeader != null) sortHeader(count, { vm.shuffle(tracks) }, { vm.play(tracks) })
                    else ListHeader(emptyList<Unit>(), null, { "" }, {}, "$count · ${formatLength(tracks.sumOf { it.durationMs })}", { vm.shuffle(tracks) }, { vm.play(tracks) })
                }
                itemsIndexed(tracks, key = { _, t -> t.id }, contentType = { _, _ -> "track" }) { i, t ->
                    TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) })
                }
            }
        }
        if (showIndex) {
            IndexBar(IndexLetters, onLetter = { ch ->
                val target = IndexLetters.dropWhile { it != ch }.firstNotNullOfOrNull { firstByLetter[it] } ?: tracks.lastIndex
                scope.launch { list.scrollToItem(target + 1 + if (header != null) 1 else 0) }
            }, modifier = Modifier.align(Alignment.CenterEnd).padding(top = 56.dp, bottom = bottom))
        }
    }
}

// ---- Artists ----

@Composable
private fun ArtistsTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val all by vm.artists.collectAsStateWithLifecycle()
    var sort by rememberSaveable { mutableStateOf(ArtistSort.Name) }
    val artists = remember(all, sort) { if (sort == ArtistSort.Songs) all.sortedByDescending { it.trackCount } else all }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(ArtistSort.entries, sort, { it.label }, { sort = it }, countOf(artists.size, "artist")) }
        if (artists.isEmpty()) item { EmptyState("No artists yet", "") }
        items(artists, key = { it.artist }) { a -> ArtistRow(vm, a) { nav.openArtist(a.artist) } }
    }
}

@Composable
private fun ArtistRow(vm: MainViewModel, a: ArtistSummary, onClick: () -> Unit) {
    // Hive's artist photo once found, the artist's album cover until then.
    val photo by produceState<String?>(null, a.artist) { value = vm.artistImage(a.artist) }
    LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist, "${countOf(a.albumCount, "album")} · ${countOf(a.trackCount, "track")}", round = true, onClick = onClick)
}

/** A row for things that aren't songs: art, name, detail line. */
@Composable
fun LibraryRow(art: Any?, fallback: ImageVector, title: String, subtitle: String, round: Boolean = false, trailing: String? = null, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        modifier.fillMaxWidth().padding(horizontal = 8.dp).height(68.dp).clip(HiveShape.row).clickable(onClick = onClick).padding(horizontal = 10.dp),
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
    val recent by vm.recentlyAdded.collectAsStateWithLifecycle()
    val most by vm.mostPlayed.collectAsStateWithLifecycle()
    val played by vm.recentlyPlayed.collectAsStateWithLifecycle()
    val rated by vm.topRated.collectAsStateWithLifecycle()
    val mine by vm.playlists.collectAsStateWithLifecycle()
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
        Triple(AutoPlaylist.RecentlyPlayed, played, Icons.Rounded.History),
        Triple(AutoPlaylist.TopRated, rated, Icons.Rounded.Star),
    )
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
            item {
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(smart) { (kind, tracks, icon) -> SmartCard(kind.title, countOf(tracks.size, "track"), tracks.map { it.artworkUri }.distinct().take(4), icon) { nav.openPlaylist(kind) } }
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 8.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("My playlists", style = HiveText.year, color = Hive.colors.text, modifier = Modifier.weight(1f))
                    BarIcon(Icons.Rounded.FileOpen, "Import M3U", { importer.launch(arrayOf("audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "*/*")) })
                    BarIcon(Icons.Rounded.Add, "Create playlist", onCreate)
                }
            }
            if (mine.isEmpty()) item { LibraryRow(null, Icons.Rounded.Add, "Create playlist", "Or add songs from any ⋮ menu", onClick = onCreate) }
            items(mine, key = { it.id }) { p ->
                LibraryRow(playlistCover(p), Icons.AutoMirrored.Rounded.QueueMusic, p.name, listOfNotNull(countOf(p.trackCount, "track"), p.source.ifBlank { null }).joinToString(" · "), modifier = Modifier.animateItem()) { nav.openUserPlaylist(p.id) }
            }
            if (link.paired && onPc.isNotEmpty()) {
                item { Text("On ${link.serverName.ifBlank { "your PC" }}", style = HiveText.year, color = Hive.colors.text, modifier = Modifier.padding(start = 18.dp, top = 22.dp, bottom = 6.dp)) }
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
private fun SmartCard(title: String, detail: String, covers: List<Uri>, icon: ImageVector, onClick: () -> Unit) {
    val c = Hive.colors
    Column(Modifier.width(132.dp).pressable(onClick)) {
        Box(Modifier.size(132.dp).shadow(12.dp, HiveShape.art, ambientColor = c.accentGlow).clip(HiveShape.art).background(mix(c.accent, c.panelStrong, 0.12f))) {
            when {
                covers.size >= 4 -> Column {
                    covers.chunked(2).forEach { pair -> Row(Modifier.weight(1f)) { pair.forEach { Artwork(it, Modifier.weight(1f).fillMaxSize(), androidx.compose.ui.graphics.RectangleShape) } } }
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
    val tracks by vm.favorites.collectAsStateWithLifecycle()
    val albums by vm.favoriteAlbums.collectAsStateWithLifecycle()
    var view by rememberSaveable { mutableStateOf(FavoriteView.Tracks) }
    var sort by rememberSaveable { mutableStateOf(TrackSort.Added) }
    // The artists of favorite songs, most favorited first.
    val artists by rememberComputed(emptyList(), tracks) {
        tracks.filter { it.artist.isNotBlank() }.groupBy { it.artist }
            .map { (name, songs) -> ArtistSummary(name, songs.first().albumId, songs.distinctBy { it.albumId }.size, songs.size) }
            .let { list -> LibrarySort.sorted(list) { it.artist } }
            .sortedByDescending { it.trackCount } // stable: equal counts stay in name order
    }
    val counts = mapOf(FavoriteView.Tracks to tracks.size, FavoriteView.Albums to albums.size, FavoriteView.Artists to artists.size)
    Column(Modifier.fillMaxSize()) {
        FavoriteViewPicker(view, counts) { view = it }
        androidx.compose.animation.AnimatedContent(view, transitionSpec = {
            val dir = if (targetState.ordinal > initialState.ordinal) 1 else -1
            (androidx.compose.animation.slideInHorizontally(Motion.move()) { it / 6 * dir } + androidx.compose.animation.fadeIn(Motion.swap()))
                .togetherWith(androidx.compose.animation.slideOutHorizontally(Motion.move()) { -it / 6 * dir } + androidx.compose.animation.fadeOut(Motion.underFade()))
        }, label = "favoritesView") { shown ->
            when (shown) {
                FavoriteView.Tracks -> {
                    // Favorites come newest-favorited first, which is what "Added" shows here.
                    val sorted by rememberComputed(tracks, tracks, sort) { if (sort == TrackSort.Added) tracks else sortTracks(tracks, sort) }
                    TrackList(vm, sorted, actions, bottom, "No favorite songs yet", "Tap ♥ on a song, or pair with Hive on your PC to bring your Favorites over.",
                        indexed = sort == TrackSort.Title,
                        sortHeader = { count, shuffle, play -> ListHeader(TrackSort.entries, sort, { if (it == TrackSort.Added) "Date favorited" else it.label }, { sort = it }, count, shuffle, play) })
                }
                FavoriteView.Artists -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (artists.isEmpty()) item { EmptyState("No favorite artists yet", "Artists show up here once you ♥ their songs.") }
                    items(artists, key = { it.artist }) { a ->
                        val photo by produceState<String?>(null, a.artist) { value = vm.artistImage(a.artist) }
                        LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist,
                            countOf(a.trackCount, "favorite song"), round = true) { nav.openArtist(a.artist) }
                    }
                }
                FavoriteView.Albums -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (albums.isEmpty()) item { EmptyState("No favorite albums yet", "Tap ♥ on an album's page to keep it here.") }
                    albums.chunked(2).forEach { row ->
                        item(key = "f${row.first().albumId}") {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                row.forEach { a -> AlbumCard(a, false, Modifier.weight(1f)) { nav.openAlbum(a.albumId) } }
                                if (row.size == 1) Spacer(Modifier.weight(1f))
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
