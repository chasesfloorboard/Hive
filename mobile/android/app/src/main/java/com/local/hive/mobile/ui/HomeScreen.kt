package com.local.hive.mobile.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.border
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import androidx.compose.foundation.combinedClickable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
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
import androidx.compose.material.icons.rounded.CloudDownload
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.FileOpen
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.Equalizer
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
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
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.ui.layout.layout

/** The library's tabs, in Samsung Music's order, with Hive's Browse for everything beyond the phone. */
enum class HomeTab(val label: String) {
    Favorites("Favorites"), Playlists("Playlists"), Albums("Albums"), Tracks("Tracks"), Artists("Artists"),
    Visualizer("Visualizer"), Browse("Browse"), Genres("Genres"), Folders("Folders"),
}

/**
 * The order of the home tabs, as the user arranged them (hold a tab, or Settings › Library › Tabs).
 * Kept in the "ui" settings (so a restored backup keeps it); a tab added in a later version joins
 * at the end. One shared state, so Home follows a change made in Settings at once.
 */
object HomeTabOrder {
    private const val KEY = "tabs.order"
    private var state: androidx.compose.runtime.MutableState<List<HomeTab>>? = null

    fun parse(saved: String?): List<HomeTab> {
        val named = saved.orEmpty().split(',').mapNotNull { n -> HomeTab.entries.firstOrNull { it.name == n.trim() } }.distinct()
        return named + HomeTab.entries.filter { it !in named }
    }

    private fun state(context: android.content.Context) = state ?: mutableStateOf(parse(prefs(context).getString(KEY, null))).also { state = it }
    private fun prefs(context: android.content.Context) = context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE)

    fun get(context: android.content.Context): List<HomeTab> = state(context).value

    fun set(context: android.content.Context, order: List<HomeTab>) {
        val full = parse(order.joinToString(",") { it.name })
        state(context).value = full
        prefs(context).edit().putString(KEY, full.joinToString(",") { it.name }).apply()
    }
}

/** Auto playlists, shown in the Playlists tab. */
enum class AutoPlaylist(val title: String) {
    Favorites("Favorites"),
    RecentlyAdded("Recently added"),
    MostPlayed("Most played"),
    RecentlyPlayed("Recently played"),
    TopRated("Top rated"),
    Perfect("Perfect albums"),
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

private enum class AlbumSort(val label: String) { Year("Release"), Name("Name"), Artist("Artist"), Added("Date added"), Perfect("Perfect") }
private enum class ArtistSort(val label: String) { Name("Name"), Songs("Most tracks") }
internal enum class TrackSort(val label: String) { Title("Name"), Artist("Artist"), Album("Album"), Added("Date added"), Length("Length") }

/**
 * Home, laid out as Samsung Music lays out its library: the app's name with
 * Create playlist, Search and More on the right, the tabs beneath, and each
 * tab a full-width list that opens with its sort control. Hive gives it its
 * look: the cover-lit backdrop, Hive's tabs and accent, Inter.
 */
@Composable
fun HomeScreen(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottomPadding: Dp) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val installedPlugins by vm.plugins.installed.collectAsStateWithLifecycle()
    val visualizerEnabled = installedPlugins.any { it.plugin.id == com.local.hive.mobile.data.PluginGallery.MONSTERCAT_ID && it.enabled }
    val orderedTabs = HomeTabOrder.get(context)
    val tabs = remember(orderedTabs, visualizerEnabled) {
        orderedTabs.filter { it != HomeTab.Visualizer || visualizerEnabled }.ifEmpty { listOf(HomeTab.Albums) }
    }
    val prefs = remember { context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE) }
    // Opens on the tab used last, as Samsung Music does (kept by name, so arranging the tabs doesn't change it;
    // older versions kept its place in the original order).
    val lastTab = remember {
        prefs.getString("tab.name", null)?.let { n -> HomeTab.entries.firstOrNull { it.name == n } }
            ?: HomeTab.entries.getOrNull(prefs.getInt("tab", HomeTab.Albums.ordinal)) ?: HomeTab.Albums
    }
    val pager = rememberPagerState(initialPage = tabs.indexOf(lastTab).coerceAtLeast(0)) { tabs.size }
    var current by remember { mutableStateOf(lastTab) }
    val tabRow = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var naming by remember { mutableStateOf(false) }
    var arranging by remember { mutableStateOf(false) }
    LaunchedEffect(pager.currentPage, tabs) {
        tabs.getOrNull(pager.currentPage)?.let { current = it; prefs.edit().putString("tab.name", it.name).apply() }
        // The chosen tab slides into view, with its neighbour showing there's more.
        tabRow.animateScrollToItem((pager.currentPage - 1).coerceAtLeast(0))
    }
    // Arranged anew: the tab open stays open, wherever it now is.
    LaunchedEffect(tabs) { tabs.indexOf(current).takeIf { it >= 0 && it != pager.currentPage }?.let { pager.scrollToPage(it) } }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        HomeBar(vm, nav, onCreatePlaylist = { naming = true })
        LinkingBanner(vm, nav.openSettings)
        LazyRow(Modifier.fillMaxWidth(), state = tabRow, contentPadding = PaddingValues(horizontal = 10.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            itemsIndexed(tabs, key = { _, t -> t.name }) { i, tab ->
                HiveTab(tab.label, pager.currentPage == i, { scope.launch { pager.animateScrollToPage(i, animationSpec = Motion.move()) } }, Modifier.animateItem(), onLongClick = { arranging = true })
            }
        }
        Spacer(Modifier.height(4.dp))
        HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 0, key = { tabs.getOrNull(it)?.name ?: it }) { page ->
            when (tabs.getOrNull(page)) {
                HomeTab.Favorites -> FavoritesTab(vm, nav, actions, bottomPadding)
                HomeTab.Playlists -> PlaylistsTab(vm, nav, bottomPadding) { naming = true }
                HomeTab.Albums -> AlbumsTab(vm, nav, bottomPadding)
                HomeTab.Tracks -> TracksTab(vm, actions, bottomPadding)
                HomeTab.Artists -> ArtistsTab(vm, nav, bottomPadding)
                HomeTab.Visualizer -> VisualizerTab(
                    vm = vm,
                    bottomPadding = bottomPadding,
                    active = tabs.getOrNull(pager.currentPage) == HomeTab.Visualizer,
                    onOpenFullScreen = { nav.open("visualizer") },
                    onOpenPluginStore = { nav.open("settings?page=plugins") },
                )
                HomeTab.Browse -> BrowseTab(vm, nav, bottomPadding)
                HomeTab.Genres -> GenresTab(vm, bottomPadding, nav.openGenre)
                HomeTab.Folders -> NamedTab(vm.folders, Icons.Rounded.Folder, "No folders yet", bottomPadding, nav.openFolder)
                null -> Unit
            }
        }
    }
    if (arranging) ArrangeTabsDialog(onDismiss = { arranging = false })
    if (naming) NameDialog("New playlist", "", "Create", onDismiss = { naming = false }) { name ->
        naming = false
        vm.createPlaylist(name, onCreated = nav.openUserPlaylist)
    }
}

/**
 * While Hive has found a PC and is trying to connect (but isn't paired yet), a slim tappable
 * line on Home says so — e.g. "Waiting for you to allow this phone on your PC" — so linking
 * doesn't happen silently behind Settings. Tapping it opens Settings to finish.
 */
@Composable
private fun LinkingBanner(vm: MainViewModel, onOpenSettings: () -> Unit) {
    val link by vm.link.collectAsStateWithLifecycle()
    val show = !link.paired && link.connecting != null
    val c = Hive.colors
    androidx.compose.animation.AnimatedVisibility(show) {
        val text = link.connecting ?: ""
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp).clip(HiveShape.pill)
                .background(mix(c.accent, c.panelStrong, 0.10f)).border(1.dp, mix(c.accent, c.border, 0.14f), HiveShape.pill)
                .clickable { onOpenSettings() }.padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Devices, null, tint = c.accent, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(text, style = HiveText.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("Open", style = HiveText.small, color = c.accent)
        }
    }
}

/** Hive's brand on the left; Create playlist, Search and More on the right, as Samsung Music's bar has them. */
@Composable
private fun HomeBar(vm: MainViewModel, nav: HomeNavigation, onCreatePlaylist: () -> Unit) {
    val c = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().height(60.dp).padding(start = 11.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        // Hive's mark; held, it shuffles the themes (a 48 dp touch, the mark where it always was).
        ShufflingHiveMark(vm.themes)
        Spacer(Modifier.width(1.dp))
        Text("Hive", style = HiveText.viewTitle, color = c.text, modifier = Modifier.weight(1f))
        BarIcon(Icons.Rounded.Add, "Create playlist", onCreatePlaylist)
        BarIcon(Icons.Rounded.Search, "Search", nav.openSearch)
        Box {
            BarIcon(Icons.Rounded.MoreVert, "More options", { menu = true })
            HiveMenu(menu, { menu = false }) {
                HiveMenuItem("Equaliser", Icons.Rounded.GraphicEq) { menu = false; nav.open("equaliser") }
                HiveMenuItem("Visualizer", Icons.Rounded.Equalizer) { menu = false; nav.open("visualizer") }
                HiveMenuItem("Plugins & Store", Icons.Rounded.Explore) { menu = false; nav.open("settings?page=plugins") }
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
    val perfectIds by vm.perfectAlbumIds.collectAsStateWithLifecycle()
    var sort by rememberSetting("sort.albums", AlbumSort.Year)
    // Worked out right away the first time (not empty while a background sort runs), so coming back from an
    // album finds the rows already there and the list keeps its place instead of jumping to the top.
    val sections by rememberComputed(remember { albumSections(albums, sort, perfectIds) }, albums, sort, perfectIds) {
        albumSections(albums, sort, perfectIds)
    }
    val list = rememberLazyListState()
    // Each grid row's albums by its item key, and every album in order, for hold-and-drag picking.
    val rows = remember(sections) { sections.flatMap { (_, l) -> l.chunked(2) }.associate { row -> "r${row.first().albumId}" as Any to row.map { it.albumId } } }
    val order = remember(sections) { sections.flatMap { (_, l) -> l.map { it.albumId } } }
    PickableList(albums = order)
    LazyColumn(Modifier.fillMaxSize().albumDragSelect(list, rows, order), state = list, contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(AlbumSort.entries, sort, { it.label }, { sort = it }, countOf(albums.size, "album")) }
        if (albums.isEmpty()) item {
            val canRead by vm.hasAudioPermission.collectAsStateWithLifecycle()
            if (!canRead) EmptyState(
                "Hive needs permission to see your music",
                "Let Hive read the audio on this phone and your albums show up here.",
                icon = Icons.Rounded.LibraryMusic,
                action = "Allow music access" to { vm.requestAudioPermission() },
            ) else EmptyState("No albums yet", "Albums appear once Hive finds music on this phone, or pair with your PC in Settings.", icon = Icons.Rounded.LibraryMusic)
        }
        sections.forEach { (heading, list) ->
            if (heading.isNotBlank()) item(key = "y$heading") { YearHeading(heading) }
            list.chunked(2).forEach { row ->
                item(key = "r${row.first().albumId}") {
                    CoverRow(row) { a, m -> AlbumCard(a, m, perfect = a.albumId in perfectIds) { nav.openAlbum(a.albumId) } }
                }
            }
        }
    }
}

private fun albumSections(albums: List<AlbumSummary>, sort: AlbumSort, perfectIds: Set<Long>): List<Pair<String, List<AlbumSummary>>> =
    when (sort) {
        AlbumSort.Year -> albums.groupBy { it.year }.toSortedMap(compareByDescending { it }).map { (y, list) -> (if (y > 0) "$y" else "Unknown year") to list }
        AlbumSort.Name -> listOf("" to albums)
        AlbumSort.Artist -> listOf("" to LibrarySort.sorted(albums, compareBy { it.year }) { it.artist })
        AlbumSort.Added -> listOf("" to albums.sortedByDescending { it.added })
        // Perfect albums (every track loved) grouped at the top, the rest below.
        AlbumSort.Perfect -> albums.partition { it.albumId in perfectIds }.let { (perfect, rest) ->
            listOfNotNull(
                ("Perfect" to LibrarySort.sorted(perfect) { it.album }).takeIf { perfect.isNotEmpty() },
                ("Other albums" to rest).takeIf { rest.isNotEmpty() },
            )
        }
    }

/** A library album as Hive's album card; hold to start picking albums (and drag over others), tap to add or remove while picking. */
@Composable
internal fun AlbumCard(a: AlbumSummary, modifier: Modifier, perfect: Boolean = false, subtitle: String = listOfNotNull(a.artist.ifBlank { "Unknown artist" }, a.year.takeIf { it > 0 }?.toString()).joinToString(" · "), onClick: () -> Unit) {
    val selection = LocalSelection.current
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    CoverCard(
        Uri.parse("content://media/external/audio/albumart/${a.albumId}"), a.album.ifBlank { "Unknown album" }, subtitle, modifier,
        artModifier = Modifier.sharedCover("album-${a.albumId}"),
        picked = selection?.hasAlbum(a.albumId) == true,
        perfect = perfect,
        onLongClick = selection?.let { s -> { haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); s.startAlbumDrag(a.albumId) } },
        onClick = { if (selection?.active == true) selection.toggleAlbum(a.albumId) else onClick() },
    )
}

// ---- Tracks ----

/** Songs in one of Samsung Music's orders; called off the main thread. */
/** Favorite files and liked streamed songs as one list, ordered by [sort] ("Added": newest favorited first). */
internal fun favoriteRows(tracks: List<Track>, streams: List<Pair<StreamTrack, Long>>, sort: TrackSort, favoritedAt: Map<Long, Long>): List<PlaylistRow> {
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

internal fun sortTracks(tracks: List<Track>, sort: TrackSort): List<Track> = when (sort) {
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
    /** The list's scroll, for a page that fades its title in as the header scrolls away. */
    list: androidx.compose.foundation.lazy.LazyListState = rememberLazyListState(),
    /** When searching: rows at this index and after are the non-matching rest, shown dimmed below the matches. */
    dimFrom: Int? = null,
    /** Tapping a dimmed (non-matching) row clears the search instead of playing — the next tap hits a clear row. */
    onDimTap: (() -> Unit)? = null,
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loaded by vm.libraryLoaded.collectAsStateWithLifecycle()
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val titles = remember(tracks, rows) { rows?.map { it.track?.title ?: it.stream?.title.orEmpty() } ?: tracks.map { it.title } }
    val firstByLetter by rememberComputed(emptyMap(), titles, indexed) {
        if (!indexed) emptyMap() else buildMap { titles.forEachIndexed { i, t -> putIfAbsent(indexLetter(LibrarySort.key(t)), i) } }
    }
    val showIndex = indexed && titles.size > 30
    var restRevealed by remember(dimFrom, tracks) { mutableStateOf(false) }
    val dimBlur by animateDpAsState(if (!restRevealed && dimFrom != null) 3.dp else 0.dp, tween(260), label = "dimBlur")
    val dimAlpha by animateFloatAsState(if (!restRevealed && dimFrom != null) 0.45f else 1f, tween(260), label = "dimAlpha")
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
                    // While searching, the non-matching rest (index >= dimFrom) is dimmed so the matches stand out.
                    Box(Modifier.animateItem()) {
                        val isRest = dimFrom != null && i >= dimFrom
                        val rowModifier = if (isRest) {
                            if (dimBlur > 0.dp) Modifier.blur(dimBlur).alpha(dimAlpha) else Modifier.alpha(dimAlpha)
                        } else Modifier
                        Box(rowModifier) { TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) }) }
                        // Tapping the blurred rest fades away the blur and reveals the tracks underneath without jumping or clearing search
                        if (isRest && !restRevealed) {
                            Box(Modifier.matchParentSize().clickable {
                                restRevealed = true
                                onDimTap?.invoke()
                            })
                        }
                    }
                } else itemsIndexed(rows, key = { _, r -> r.track?.id?.toString() ?: r.stream?.key.orEmpty() }, contentType = { _, _ -> "track" }) { i, r ->
                    Box(Modifier.animateItem()) {
                        val isRest = dimFrom != null && i >= dimFrom
                        val rowModifier = if (isRest) {
                            if (dimBlur > 0.dp) Modifier.blur(dimBlur).alpha(dimAlpha) else Modifier.alpha(dimAlpha)
                        } else Modifier
                        Box(rowModifier) {
                            val t = r.track
                            if (t != null) TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.playRows(rows, i) })
                            else r.stream?.let { st -> StreamRow(st, now.mediaId == st.key, now.isPlaying, full, onClick = { vm.playRows(rows, i) }, vm = vm) }
                        }
                        if (isRest && !restRevealed) {
                            Box(Modifier.matchParentSize().clickable {
                                restRevealed = true
                                onDimTap?.invoke()
                            })
                        }
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
    val covers by vm.artistCovers.collectAsStateWithLifecycle()
    var sort by rememberSetting("sort.artists", ArtistSort.Name)
    val artists = remember(all, sort) { if (sort == ArtistSort.Songs) all.sortedByDescending { it.trackCount } else all }
    androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
        androidx.compose.foundation.lazy.grid.GridCells.Fixed(2),
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = bottom + 12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) {
            // The header lines up with the other tabs' (it keeps its own side padding), so it's laid out past the grid's.
            Box(Modifier.layout { m, c ->
                val extra = 32.dp.roundToPx()
                val p = m.measure(c.copy(minWidth = c.maxWidth + extra, maxWidth = c.maxWidth + extra))
                layout(c.maxWidth, p.height) { p.place(-extra / 2, 0) }
            }) { ListHeader(ArtistSort.entries, sort, { it.label }, { sort = it }, countOf(artists.size, "artist")) }
        }
        if (artists.isEmpty()) item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) { EmptyState("No artists yet", "") }
        gridItems(artists, key = { it.artist }) { a ->
            // Hold to pick an artist (all their songs), as albums are picked; while picking, a tap picks more.
            val pickArtist = rememberArtistPicker(vm, a.artist)
            val selection = LocalSelection.current
            ArtistSquare(vm, a, covers[a.artist].orEmpty(), picked = selection?.hasGroup(artistGroupKey(a.artist)) == true, onLongClick = pickArtist) {
                if (selection?.active == true) pickArtist() else nav.openArtist(a.artist)
            }
        }
    }
}

/** An artist as a square: Hive's photo of them when artist photos are on, else four of their most played albums' covers (or their one). */
@Composable
private fun ArtistSquare(vm: MainViewModel, a: ArtistSummary, covers: List<Any>, picked: Boolean = false, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val photo = rememberArtistPhoto(vm, a.artist)
    val pictures = when {
        photo != null -> listOf<Any>(photo)
        covers.size >= 4 -> covers
        covers.isNotEmpty() -> covers.take(1)
        else -> listOf<Any>(Uri.parse("content://media/external/audio/albumart/${a.albumId}"))
    }
    FavoriteSquare(a.artist, pictures, round = false, icon = Icons.Rounded.Person, subtitle = "${countOf(a.albumCount, "album")} · ${countOf(a.trackCount, "track")}", picked = picked, onLongClick = onLongClick, onClick = onClick)
}

/** An artist's key among the picked groups (the same artist picked from any list is one pick). */
internal fun artistGroupKey(name: String) = "artist:" + name.trim().lowercase()

/** Picks or un-picks an artist, as all their songs. */
@Composable
internal fun rememberArtistPicker(vm: MainViewModel, name: String): () -> Unit {
    val selection = LocalSelection.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    return remember(name, selection) {
        {
            val sel = selection
            if (sel != null) {
                if (!sel.active) haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                scope.launch { sel.toggleGroup(artistGroupKey(name), "artist", vm.tracksOfArtist(name)) }
            }
        }
    }
}

/** A row for things that aren't songs: art, name, detail line. */
@Composable
fun LibraryRow(art: Any?, fallback: ImageVector, title: String, subtitle: String, round: Boolean = false, trailing: String? = null, modifier: Modifier = Modifier, picked: Boolean = false, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        modifier.fillMaxWidth().padding(horizontal = 8.dp).height(68.dp).clip(HiveShape.row)
            .then(if (picked) Modifier.background(c.accent.copy(alpha = 0.18f)) else Modifier)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(horizontal = 10.dp),
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
    val perfectTracks by vm.perfectAlbumTracks.collectAsStateWithLifecycle()
    val mine by vm.playlists.collectAsStateWithLifecycle()
    val smartLists by vm.smartPlaylists.collectAsStateWithLifecycle()
    var newSmart by remember { mutableStateOf(false) }
    val images by vm.playlistImages.collectAsStateWithLifecycle()
    if (newSmart) SmartPlaylistDialog(vm, null, onDismiss = { newSmart = false }) { id -> newSmart = false; nav.open("smart/$id") }
    val onPc by vm.pcPlaylists.collectAsStateWithLifecycle()
    val playlistsInStep by vm.playlistSyncActive.collectAsStateWithLifecycle()
    val link by vm.link.collectAsStateWithLifecycle()
    // Again after each sync, so a playlist made on the PC shows up without leaving the tab.
    LaunchedEffect(link.paired, link.lastSyncAt) { if (link.paired) runCatching { vm.pcLibrary.refreshPlaylists() } }
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
                    items(smart) { (kind, tracks, icon) -> SmartCard(kind.title, countOf(tracks.size + if (kind == AutoPlaylist.Favorites) likedStreams.size else 0, "track"),
                        (if (kind == AutoPlaylist.Favorites) images[com.local.hive.mobile.data.PlaylistImages.FAVORITES] else images["auto:${kind.name}"])?.let { listOf<Any>(it) } ?: mosaicCovers(tracks), icon,
                        onLongClick = { nav.collection(AutoDjRequest(kind.title) { tracks }) }) { nav.openPlaylist(kind) } }
                    // Recently played holds streamed songs too, so it's built from its rows.
                    item { SmartCard(AutoPlaylist.RecentlyPlayed.title, countOf(played.size, "track"), played.mapNotNull { it.art }.distinct().take(4), Icons.Rounded.History,
                        onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.RecentlyPlayed.title) { played.mapNotNull { it.track } }) }) { nav.openPlaylist(AutoPlaylist.RecentlyPlayed) } }
                    item { SmartCard(AutoPlaylist.TopRated.title, countOf(rated.size, "track"), mosaicCovers(rated), Icons.Rounded.Star,
                        onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.TopRated.title) { rated }) }) { nav.openPlaylist(AutoPlaylist.TopRated) } }
                    // Appears once you have an album with every track loved.
                    if (perfectTracks.isNotEmpty()) item { SmartCard(AutoPlaylist.Perfect.title, countOf(perfectTracks.size, "track"), mosaicCovers(perfectTracks), Icons.Rounded.AutoAwesome,
                        onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.Perfect.title) { perfectTracks }) }) { nav.openPlaylist(AutoPlaylist.Perfect) } }
                }
            }
            item {
                Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 8.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("My playlists", style = HiveText.year, color = Hive.colors.text, modifier = Modifier.weight(1f))
                    BarIcon(Icons.Rounded.FileOpen, "Import M3U", { importer.launch(arrayOf("audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "*/*")) })
                }
            }
            // New playlist, always first: a plain one, or a smart one kept up to date by its rules.
            item(key = "new") {
                var choose by remember { mutableStateOf(false) }
                Box {
                    LibraryRow(null, Icons.Rounded.Add, "New playlist", "", modifier = Modifier.animateItem()) { choose = true }
                    HiveMenu(choose, { choose = false }) {
                        HiveMenuItem("Playlist", Icons.AutoMirrored.Rounded.QueueMusic) { choose = false; onCreate() }
                        HiveMenuItem("Smart playlist", Icons.Rounded.AutoAwesome) { choose = false; newSmart = true }
                    }
                }
            }
            // Favorites heads the user's playlists too, not only as the card above.
            item(key = "favorites") {
                LibraryRow(images[com.local.hive.mobile.data.PlaylistImages.FAVORITES] ?: favorites.firstOrNull()?.songArtUri ?: likedStreams.firstOrNull()?.first?.artworkUrl, Icons.Rounded.Favorite, AutoPlaylist.Favorites.title,
                    countOf(favorites.size + likedStreams.size, "track"), modifier = Modifier.animateItem(),
                    onLongClick = { nav.collection(AutoDjRequest(AutoPlaylist.Favorites.title) { favorites }) }) { nav.openPlaylist(AutoPlaylist.Favorites) }
            }
            // Smart playlists: made here by rules, kept up to date by themselves.
            items(smartLists, key = { "smart" + it.id }) { p ->
                // Its own picture, else the cover of the first song it holds now.
                val first by remember(p.id) { vm.smartTracks(p.id).map { it.firstOrNull()?.songArtUri } }.collectAsStateWithLifecycle(null)
                LibraryRow(images[com.local.hive.mobile.data.PlaylistImages.smart(p.id)] ?: first, Icons.Rounded.AutoAwesome, p.name, "Smart · " + countOf(p.rules.size, "rule"), modifier = Modifier.animateItem(),
                    onLongClick = { nav.collection(AutoDjRequest(p.name) { vm.smartTracks(p.id).first() }) }) { nav.open("smart/${p.id}") }
            }
            items(mine, key = { it.id }) { p ->
                LibraryRow(images[com.local.hive.mobile.data.PlaylistImages.user(p.id)] ?: playlistCover(p), Icons.AutoMirrored.Rounded.QueueMusic, p.name, listOfNotNull(countOf(p.trackCount, "track"), p.source.ifBlank { null }).joinToString(" · "), modifier = Modifier.animateItem(),
                    onLongClick = { nav.collection(AutoDjRequest(p.name) { vm.playlistRows(p.id).first().mapNotNull { it.track } }) }) { nav.openUserPlaylist(p.id) }
            }
            // Kept in step with Hive, the PC's playlists are among the ones above; only an older Hive lists them apart.
            if (link.paired && onPc.isNotEmpty() && !playlistsInStep) {
                // The PC's name is already "Hive on <PC>".
                item { Text(link.serverName.ifBlank { "On your PC" }, style = HiveText.year, color = Hive.colors.text, modifier = Modifier.padding(start = 18.dp, top = 22.dp, bottom = 6.dp)) }
                items(onPc, key = { "pc" + it.id }) { p ->
                    LibraryRow(images[com.local.hive.mobile.data.PlaylistImages.pc(p.id)] ?: vm.pcLibrary.playlistCover(p), Icons.AutoMirrored.Rounded.QueueMusic, p.name, countOf(p.songs.size, "song")) { nav.openPcPlaylist(p.id) }
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
                covers.size >= 4 -> CoverMosaic(covers)
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


