package com.local.hive.mobile.ui

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.border
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.foundation.layout.offset
import androidx.compose.runtime.withFrameNanos
import kotlin.math.roundToInt
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

/** The Home screen's Favorites tab -- its view picker, search, liked rows, home grid and squares --
  * lifted out of the 1069-line HomeScreen.kt. HomeScreen calls [FavoritesTab]; the rest is this file's own. */

// ---- Favorites ----

internal enum class FavoriteView(val label: String) { Home("Favorites"), Tracks("Tracks"), Albums("Albums"), Artists("Artists"), Playlists("Playlists") }

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
internal fun FavoritesTab(vm: MainViewModel, nav: HomeNavigation, actions: TrackActions, bottom: Dp) {
    val allTracks by vm.favorites.collectAsStateWithLifecycle()
    val allStreams by vm.streamFavorites.collectAsStateWithLifecycle()
    val favoritedAt by vm.favoritedAt.collectAsStateWithLifecycle()
    // Searching Favorites searches only Favorites: songs by title, artist or album, albums by name or artist.
    var query by rememberSaveable { mutableStateOf("") }
    val q = LibrarySort.words(query)
    val tracks by rememberComputed(allTracks, allTracks, q) { if (q.isEmpty()) allTracks else allTracks.filter { LibrarySort.matches("${it.title} ${it.artist} ${it.album}", q) } }
    val streams by rememberComputed(allStreams, allStreams, q) { if (q.isEmpty()) allStreams else allStreams.filter { (s, _) -> LibrarySort.matches("${s.title} ${s.artist} ${s.album}", q) } }
    // Every album and artist with a song you've favorited, the most favorited first (newest-liked tie-break).
    val likedAlbums by rememberComputed(emptyList<LikedGroup>(), allTracks, favoritedAt, q) {
        allTracks.groupBy { it.albumId }.map { (id, songs) ->
            LikedGroup(songs.first().album, songs.first().displayAlbumArtist, id, songs.size, songs.maxOfOrNull { favoritedAt[it.id] ?: 0L } ?: 0L)
        }
            .filter { q.isEmpty() || LibrarySort.matches("${it.name} ${it.artist}", q) }
            .sortedWith(compareByDescending<LikedGroup> { it.liked }.thenByDescending { it.latestLovedAt }.thenBy { it.name.lowercase() })
    }
    val likedArtists by rememberComputed(emptyList<LikedGroup>(), allTracks, favoritedAt, q) {
        allTracks.filter { it.artist.isNotBlank() && it.artist != "<unknown>" }.groupBy { it.artist.trim().lowercase() }
            .map { (_, songs) ->
                LikedGroup(songs.first().artist.trim(), "", songs.groupingBy { it.albumId }.eachCount().maxBy { it.value }.key, songs.size, songs.maxOfOrNull { favoritedAt[it.id] ?: 0L } ?: 0L)
            }
            .filter { q.isEmpty() || LibrarySort.matches(it.name, q) }
            .sortedWith(compareByDescending<LikedGroup> { it.liked }.thenByDescending { it.latestLovedAt }.thenBy { it.name.lowercase() })
    }
    // A new setting name, so everyone starts on the Favorites page itself.
    var view by rememberSetting("view.favorites.v2", FavoriteView.Home)
    val tiles by vm.favoriteTiles.collectAsStateWithLifecycle()
    val shownTiles by rememberComputed(tiles, tiles, q) { if (q.isEmpty()) tiles else tiles.filter { LibrarySort.matches("${it.title} ${it.subtitle}", q) } }
    val images by vm.playlistImages.collectAsStateWithLifecycle()
    var sort by rememberSaveable { mutableStateOf(TrackSort.Added) }
    // Liked artists (♥ on an artist's page), the most recently liked first.
    val playlists = shownTiles.filter { it.kind == "playlist" }
    val counts = mapOf(FavoriteView.Home to tiles.size + 1, FavoriteView.Tracks to tracks.size + streams.size, FavoriteView.Albums to likedAlbums.size, FavoriteView.Artists to likedArtists.size, FavoriteView.Playlists to playlists.size)
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
                FavoriteView.Home -> FavoritesHome(vm, nav, tracks, streams, shownTiles, images[com.local.hive.mobile.data.PlaylistImages.FAVORITES], bottom, searching = q.isNotEmpty())
                FavoriteView.Artists -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (likedArtists.isEmpty()) item { if (q.isEmpty()) EmptyState("No favorite artists yet", "Tap ♥ on a song and its artist shows here.") else EmptyState("No favorite artists match", "Nothing in Favorites matches “${query.trim()}”.") }
                    items(likedArtists, key = { "a" + it.name.lowercase() }) { a -> LikedArtistRow(vm, a) { nav.openArtist(a.name) } }
                }
                FavoriteView.Playlists -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (playlists.isEmpty()) item { if (q.isEmpty()) EmptyState("No favorite playlists yet", "Tap ♥ on any playlist, yours or from Apple Music or Spotify, to keep it here.") else EmptyState("No favorite playlists match", "Nothing in Favorites matches “${query.trim()}”.") }
                    items(playlists, key = { it.key }) { p ->
                        LibraryRow(p.art, Icons.AutoMirrored.Rounded.QueueMusic, p.title, p.subtitle.ifBlank { "Playlist" }) { nav.open(p.route) }
                    }
                }
                FavoriteView.Albums -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 6.dp, bottom = bottom + 12.dp)) {
                    if (likedAlbums.isEmpty()) item { if (q.isEmpty()) EmptyState("No favorite albums yet", "Tap ♥ on a song and its album shows here.") else EmptyState("No favorite albums match", "Nothing in Favorites matches “${query.trim()}”.") }
                    likedAlbums.chunked(2).forEach { row ->
                        item(key = "f${row.first().albumId}") {
                            CoverRow(row) { a, m ->
                                CoverCard(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), a.name.ifBlank { "Unknown album" }, likedLine(a.liked, a.artist.ifBlank { "Unknown artist" }), m,
                                    artModifier = Modifier.sharedCover("album-${a.albumId}")) { nav.openAlbum(a.albumId) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** An album or artist with songs you've favorited: [liked] of them. [albumId] is the album, or the artist's most liked album (for a picture). */
private data class LikedGroup(val name: String, val artist: String, val albumId: Long, val liked: Int, val latestLovedAt: Long = 0L)

/** "♥ 3 · Artist": how many songs are favorited, then the rest. */
private fun likedLine(liked: Int, rest: String = "") = listOf("♥ ${countOf(liked, "song")}", rest).filter { it.isNotBlank() }.joinToString(" · ")

/** An artist with songs you've favorited: Hive's photo of them once found, and how many songs. */
@Composable
private fun LikedArtistRow(vm: MainViewModel, a: LikedGroup, onClick: () -> Unit) {
    val photo = rememberArtistPhoto(vm, a.name)
    val pick = rememberArtistPicker(vm, a.name)
    val selection = LocalSelection.current
    LibraryRow(photo ?: Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.name, likedLine(a.liked), round = true,
        picked = selection?.hasGroup(artistGroupKey(a.name)) == true, onLongClick = pick) { if (selection?.active == true) pick() else onClick() }
}

/**
 * The Favorites page: big squares, the Favorites playlist first, then every liked playlist, artist
 * and album, the most recently liked first. Each square is just its picture, its name underneath.
 */
@Composable
private fun FavoritesHome(vm: MainViewModel, nav: HomeNavigation, tracks: List<Track>, streams: List<Pair<StreamTrack, Long>>, tiles: List<FavoriteTile>, favoritesImage: String?, bottom: Dp, searching: Boolean) {
    val c = Hive.colors
    val density = LocalDensity.current
    val selection = LocalSelection.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val perfectIds by vm.perfectAlbumIds.collectAsStateWithLifecycle()
    val grid = androidx.compose.foundation.lazy.grid.rememberLazyGridState()
    // The squares in the order the user arranged them; newly liked or re-liked ones jump straight to the top.
    val order by vm.favoriteOrder.collectAsStateWithLifecycle()
    val arranged = remember(tiles, order) {
        com.local.hive.mobile.data.FavoriteOrderRules.arrange(tiles, order, { it.key }, { it.addedAt })
    }
    // What the grid shows: the arranged order, or the order mid-drag.
    val shown = remember { androidx.compose.runtime.mutableStateListOf<FavoriteTile>() }
    var dragging by remember { mutableStateOf<String?>(null) }
    var pointerPos by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var grabOffset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    var draggedSize by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    var viewportHeightPx by remember { mutableStateOf(0f) }
    var lastSwapMs by remember { mutableStateOf(0L) }
    LaunchedEffect(arranged) { if (dragging == null) { shown.clear(); shown.addAll(arranged) } }
    fun groupKey(t: FavoriteTile) = "fav:" + t.key
    fun kindOf(t: FavoriteTile) = when (t.kind) { "album", "artist" -> t.kind; else -> "playlist" }
    fun pick(t: FavoriteTile) { val sel = selection ?: return; scope.launch { sel.toggleGroup(groupKey(t), kindOf(t), vm.tracksForTile(t)) } }

    fun trySwapAtPointer(throttleMs: Long = 0L) {
        val key = dragging ?: return
        val nowMs = System.currentTimeMillis()
        if (throttleMs > 0L && nowMs - lastSwapMs < throttleMs) return
        val visible = grid.layoutInfo.visibleItemsInfo.map { item ->
            DragAutoScroll.VisibleSlot(
                key = item.key,
                left = item.offset.x.toFloat(),
                top = item.offset.y.toFloat(),
                right = (item.offset.x + item.size.width).toFloat(),
                bottom = (item.offset.y + item.size.height).toFloat(),
            )
        }
        val targetKey = DragAutoScroll.findSwapTargetKey(
            draggedKey = key,
            pinnedKey = "favorites",
            centerX = pointerPos.x,
            centerY = pointerPos.y,
            visible = visible,
        ) ?: return
        val from = shown.indexOfFirst { it.key == key }
        val to = shown.indexOfFirst { it.key == targetKey }
        if (from < 0 || to < 0 || from == to) return
        shown.add(to, shown.removeAt(from))
        lastSwapMs = nowMs
        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
    }

    // Smooth auto-scroll when dragging an album/artist/playlist near the top or bottom edge of the screen.
    val edgeZonePx = with(density) { 104.dp.toPx() }
    val maxScrollStepPx = with(density) { 24.dp.toPx() }
    LaunchedEffect(dragging) {
        if (dragging == null) return@LaunchedEffect
        while (dragging != null) {
            withFrameNanos { }
            val vh = viewportHeightPx
            if (vh > 0f) {
                val delta = DragAutoScroll.computeEdgeScrollDelta(
                    pointerY = pointerPos.y,
                    viewportHeight = vh,
                    edgeZonePx = edgeZonePx,
                    maxStepPx = maxScrollStepPx,
                    canScrollBackward = grid.canScrollBackward,
                    canScrollForward = grid.canScrollForward,
                )
                if (delta != 0f) {
                    grid.scrollBy(delta)
                    trySwapAtPointer(throttleMs = 90L)
                }
            }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .onSizeChanged { viewportHeightPx = it.height.toFloat() }
    ) {
        androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
            androidx.compose.foundation.lazy.grid.GridCells.Fixed(2),
            Modifier
                .fillMaxSize()
                // Gesture lives on the grid container (not individual tiles) so auto-scrolling past the
                // original screen never cancels the drag!
                .pointerInput(searching) {
                    if (searching) return@pointerInput
                    detectDragGesturesAfterLongPress(
                        onDragStart = { start ->
                            val hit = grid.layoutInfo.visibleItemsInfo.firstOrNull { item ->
                                item.key is String && item.key != "favorites" &&
                                    start.x >= item.offset.x && start.x <= item.offset.x + item.size.width &&
                                    start.y >= item.offset.y && start.y <= item.offset.y + item.size.height
                            } ?: return@detectDragGesturesAfterLongPress
                            val key = hit.key as String
                            val tile = shown.firstOrNull { it.key == key } ?: return@detectDragGesturesAfterLongPress
                            haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                            if (selection?.hasGroup(groupKey(tile)) != true) pick(tile)
                            dragging = key
                            pointerPos = start
                            grabOffset = androidx.compose.ui.geometry.Offset(start.x - hit.offset.x, start.y - hit.offset.y)
                            draggedSize = hit.size
                        },
                        onDrag = { change, amount ->
                            if (dragging == null) return@detectDragGesturesAfterLongPress
                            change.consume()
                            pointerPos += amount
                            trySwapAtPointer()
                        },
                        onDragEnd = {
                            if (dragging != null) {
                                dragging = null
                                vm.setFavoriteOrder(shown.map { it.key })
                            }
                        },
                        onDragCancel = {
                            if (dragging != null) {
                                dragging = null
                                vm.setFavoriteOrder(shown.map { it.key })
                            }
                        },
                    )
                },
            state = grid,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 6.dp, bottom = bottom + 12.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (!searching) item(key = "favorites") {
                val covers: List<Any> = favoritesImage?.let { listOf(it) } ?: mosaicCovers(tracks) + streams.mapNotNull { it.first.artworkUrl.ifBlank { null } }.distinct().take(MOSAIC)
                // Hold: the Favorites menu (play, shuffle, play next, add to queue…), as holding its card on Playlists does.
                FavoriteSquare(AutoPlaylist.Favorites.title, covers, round = false, icon = Icons.Rounded.Favorite,
                    onLongClick = if (tracks.isEmpty()) null else ({ haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); nav.collection(AutoDjRequest(AutoPlaylist.Favorites.title) { tracks }) })) {
                    nav.openPlaylist(AutoPlaylist.Favorites)
                }
            }
            gridItems(shown, key = { it.key }) { t ->
                val isDragged = dragging == t.key
                val picked = selection?.hasGroup(groupKey(t)) == true
                Box(
                    Modifier
                        .animateItem()
                        .alpha(if (isDragged) 0f else 1f),
                ) {
                    FavoriteSquare(t.title, listOfNotNull(t.art), round = false, icon = when (t.kind) { "artist" -> Icons.Rounded.Person; "album" -> Icons.Rounded.LibraryMusic; else -> Icons.AutoMirrored.Rounded.QueueMusic }, picked = picked,
                        perfect = t.kind == "album" && t.route.removePrefix("album/").toLongOrNull()?.let { it in perfectIds } == true) {
                        // While picking, a tap picks or un-picks; otherwise it opens.
                        if (selection?.active == true) pick(t) else nav.open(t.route)
                    }
                }
            }
            if (tiles.isEmpty() && !searching) item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) {
                Text("Tap ♥ on an album, an artist or any playlist and it shows here.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp))
            }
        }

        // Floating dragged tile overlay: stays glued right under the finger even while the grid scrolls across rows.
        val draggedTile = dragging?.let { k -> shown.firstOrNull { it.key == k } }
        if (draggedTile != null && draggedSize.width > 0) {
            val widthDp = with(density) { draggedSize.width.toDp() }
            val xPx = (pointerPos.x - grabOffset.x).roundToInt()
            val yPx = (pointerPos.y - grabOffset.y).roundToInt()
            Box(
                Modifier
                    .offset { IntOffset(xPx, yPx) }
                    .width(widthDp)
                    .zIndex(10f)
                    .graphicsLayer { scaleX = 1.06f; scaleY = 1.06f; alpha = 0.96f },
            ) {
                FavoriteSquare(
                    draggedTile.title,
                    listOfNotNull(draggedTile.art),
                    round = false,
                    icon = when (draggedTile.kind) { "artist" -> Icons.Rounded.Person; "album" -> Icons.Rounded.LibraryMusic; else -> Icons.AutoMirrored.Rounded.QueueMusic },
                    picked = selection?.hasGroup(groupKey(draggedTile)) == true,
                    perfect = draggedTile.kind == "album" && draggedTile.route.removePrefix("album/").toLongOrNull()?.let { it in perfectIds } == true,
                ) {}
            }
        }
    }
}

/** A four-cover mosaic: the first four songs, one per album. */
private const val MOSAIC = 4

/** Songs' own pictures for a mosaic, one song per album (never one song's cover twice, nor an album's on a song without one). */
internal fun mosaicCovers(tracks: List<Track>): List<Any> = tracks.distinctBy { it.albumId }.take(MOSAIC).map { it.songArtUri }

/** Four covers in a square, each its song's own: a song without a picture shows none, never another's. */
@Composable
internal fun CoverMosaic(covers: List<Any>) = Column {
    covers.take(4).chunked(2).forEachIndexed { r, pair -> Row(Modifier.weight(1f)) { pair.forEachIndexed { i, cover ->
        Artwork(cover, Modifier.weight(1f).fillMaxSize(), androidx.compose.ui.graphics.RectangleShape)
    } } }
}

/** A big square on the Favorites page: the picture (four covers for Favorites) and the name under it. */
@Composable
internal fun FavoriteSquare(title: String, covers: List<Any>, round: Boolean, icon: ImageVector, subtitle: String? = null, picked: Boolean = false, perfect: Boolean = false, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    val c = Hive.colors
    val shape = if (round) CircleShape else HiveShape.art
    Column(Modifier.fillMaxWidth().pressable(onClick, onLongClick = onLongClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f).softShadow(18.dp, shape).clip(shape).background(mix(c.accent, c.panelStrong, 0.12f))
            .then(if (picked) Modifier.border(3.dp, c.accent, shape) else Modifier), contentAlignment = Alignment.Center) {
            when {
                covers.size >= 4 -> CoverMosaic(covers)
                covers.isNotEmpty() -> Artwork(covers.first(), Modifier.fillMaxSize(), androidx.compose.ui.graphics.RectangleShape, icon)
                else -> Icon(icon, null, tint = c.textDim, modifier = Modifier.size(40.dp))
            }
            if (perfect && !picked) PerfectBadge(Modifier.align(Alignment.TopEnd).padding(8.dp))
            // Picked: a tick in the corner, as picked album cards show.
            if (picked) Box(Modifier.align(Alignment.TopEnd).padding(8.dp).size(26.dp).clip(CircleShape).background(c.accent), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Check, "Picked", tint = readableOn(c.accent), modifier = Modifier.size(18.dp))
            }
        }
        Text(title, style = HiveText.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp, start = 2.dp, end = 2.dp))
        if (subtitle != null) Text(subtitle, style = HiveText.small, color = c.textDim, maxLines = 1, modifier = Modifier.padding(start = 2.dp, end = 2.dp))
    }
}
