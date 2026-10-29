package com.local.hive.mobile.ui

import androidx.compose.material.icons.rounded.Radio
import com.local.hive.mobile.ui.theme.HiveIcons
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.AutoFixHigh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.ui.draw.shadow
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.FavoriteAlbum
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.mix
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow

/** A floating glass bar: back on the left, a title that fades in once the hero scrolls away, actions on the right. */
/** The veil behind a page's bar: up as soon as the page has scrolled at all. */
@Composable
fun androidx.compose.foundation.lazy.LazyListState.pageVeil(): androidx.compose.runtime.State<Float> {
    val scrolled by androidx.compose.runtime.remember(this) { androidx.compose.runtime.derivedStateOf { firstVisibleItemIndex > 0 || firstVisibleItemScrollOffset > 0 } }
    return animateFloatAsState(if (scrolled) 1f else 0f, tween(180), label = "veil")
}

@Composable
fun PageBar(title: String, titleAlpha: Float, onBack: () -> Unit, veil: Float = titleAlpha, actions: @Composable () -> Unit = {}) {
    val c = Hive.colors
    // Once the page scrolls, a veil of the page's colour comes up behind the bar and the status
    // bar, so the list slides under it instead of running into the buttons and the clock.
    Row(Modifier.fillMaxWidth().drawBehind {
        if (veil <= 0f) return@drawBehind
        val fade = 28.dp.toPx()
        drawRect(
            androidx.compose.ui.graphics.Brush.verticalGradient(
                0f to c.bg.copy(alpha = 0.92f * veil), size.height / (size.height + fade) to c.bg.copy(alpha = 0.78f * veil), 1f to Color.Transparent,
                endY = size.height + fade,
            ),
            size = androidx.compose.ui.geometry.Size(size.width, size.height + fade),
        )
    }.statusBarsPadding().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.minimumInteractiveComponentSize().size(42.dp).hiveGlass(CircleShape).clickable(onClick = onBack), contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", tint = c.text, modifier = Modifier.size(20.dp))
        }
        Box(Modifier.weight(1f).padding(horizontal = 10.dp).alpha(titleAlpha)) {
            if (title.isNotBlank()) Box(Modifier.height(42.dp).hiveGlass(HiveShape.pill).padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                Text(title, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        actions()
    }
}

/**
 * An album page, built as Samsung Music builds it and lit as Hive lights it:
 * the album's own colours behind, the cover (the same cover that was tapped,
 * grown into place), the name, artist and details, Play and Shuffle, then
 * the numbered tracklist with lengths.
 */
@Composable
fun AlbumScreen(
    vm: MainViewModel,
    albumId: Long,
    title: String,
    artist: String,
    year: Int,
    tracksFlow: Flow<List<Track>>,
    actions: TrackActions,
    bottomPadding: Dp,
    onBack: () -> Unit,
    onOpenArtist: (String) -> Unit,
) {
    val c = Hive.colors
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val colors by produceState<AuraColors?>(null, albumId) { value = vm.albumColors(albumId) }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    val veil by list.pageVeil()
    val favorite = FavoriteAlbum.keyOf(title, artist) in vm.favoriteAlbumKeys.collectAsStateWithLifecycle().value
    val cover = Uri.parse("content://media/external/audio/albumart/$albumId")
    PickableList(tracks = tracks)

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        LazyColumn(Modifier.fillMaxSize().songDragSelect(list, remember(tracks) { tracks.associateBy<Track, Any> { it.id } }, tracks), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            item {
                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 60.dp, start = 24.dp, end = 24.dp, bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    // An album whose first song carries several pictures turns through them, as its card does on the PC.
                    val frame = rotatingCover(cover, tracks.firstOrNull()?.id)
                    Artwork(frame.current, Modifier.sharedCover("album-$albumId").fillMaxWidth(0.72f).aspectRatio(1f), HiveShape.art, Icons.Rounded.LibraryMusic, glow = colors?.primary, elevation = 30.dp, replacing = frame.previous)
                    Text(title, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 22.dp))
                    if (artist.isNotBlank()) Text(artist, style = HiveText.rowStrong, color = c.accent, modifier = Modifier.padding(top = 6.dp).clip(HiveShape.pill).clickable { onOpenArtist(artist) }.padding(horizontal = 8.dp, vertical = 2.dp))
                    Text(listOfNotNull(year.takeIf { it > 0 }?.toString(), countOf(tracks.size, "track"), formatLength(tracks.sumOf { it.durationMs })).joinToString(" · "), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                    Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        PillButton("Play", HiveIcons.Play, accent = true, modifier = Modifier.weight(1f)) { vm.play(tracks) }
                        PillButton("Shuffle", HiveIcons.Shuffle, accent = false, modifier = Modifier.weight(1f)) { vm.shuffle(tracks) }
                        ControlButton(if (favorite) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (favorite) "Remove album from Favorites" else "Add album to Favorites", { vm.toggleFavoriteAlbum(title, artist) }, size = 46.dp, tint = if (favorite) c.accent else null)
                    }
                }
            }
            itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) }, subtitle = if (t.artist != artist) t.artist else "", number = t.trackNumber.takeIf { it > 0 } ?: (i + 1))
            }
        }
    }, overlay = {
        PageBar(title, titleAlpha, onBack, veil) { CollectionMenu(tracks, vm, actions, album = true) }
    })
}

/** A wide button with a label, as Samsung Music's Play and Shuffle: the accent for the main one, glass for the other. */
@Composable
fun PillButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, accent: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    val base = modifier.height(46.dp)
    Row(
        (if (accent) base.shadow(14.dp, HiveShape.pill, ambientColor = c.accentGlow, spotColor = c.accent).clip(HiveShape.pill).background(c.accent)
        else base.hiveGlass(HiveShape.pill, strength = 0.2f)).pressable(onClick, 0.96f),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tint = if (accent) readableOn(c.accent) else c.text
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, style = HiveText.rowStrong, color = tint)
    }
}

/** The page lit by its album's colours, as Hive's ambient backdrop is lit by the playing cover. */
@Composable
internal fun AlbumBackdrop(colors: AuraColors?) {
    val c = Hive.colors
    com.local.hive.mobile.ui.theme.HiveAmbient(
        colors?.primary?.copy(alpha = 0.55f) ?: c.ambientA,
        colors?.secondary?.copy(alpha = 0.45f) ?: c.ambientB,
        Modifier.fillMaxSize(), intensity = 1.1f,
    )
}

// A glass panel built from list items, so long tracklists stay lazy.
@Composable
internal fun PanelTop() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(14.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).background(panelFill()))
}

@Composable
internal fun PanelSlice(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).background(panelFill())) { content() }
}

@Composable
internal fun PanelBottom() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(14.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(bottomStart = 20.dp, bottomEnd = 20.dp)).background(panelFill()))
}

@Composable
internal fun panelFill() = Hive.colors.let { mix(it.accent, it.panelStrong, 0.07f) }

/** ⋯ on collection pages: queue the whole page, or add it to a playlist. */
@Composable
private fun CollectionMenu(tracks: List<Track>, vm: MainViewModel, actions: TrackActions, album: Boolean = false, extra: (@Composable (close: () -> Unit) -> Unit)? = null) {
    var open by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    Box {
        Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable { open = true }, contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.MoreVert, "More options", tint = Hive.colors.text, modifier = Modifier.size(20.dp))
        }
        HiveMenu(open, { open = false }) {
            HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { open = false; vm.playNext(tracks) }
            HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { open = false; vm.addToQueue(tracks) }
            HiveMenuItem("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { open = false; actions.onAddToPlaylist(tracks) }
            HiveMenuItem("Auto DJ", Icons.Rounded.Radio) { open = false; actions.onAutoDj(tracks) }
            HiveMenuItem("Share", Icons.Rounded.Share) { open = false; Share.tracks(context, tracks) }
            // An album's own tools, as Hive's album menu has them on the PC.
            if (album && tracks.isNotEmpty()) {
                val editor = LocalEditor.current
                HiveMenuDivider()
                HiveMenuItem("Edit album", Icons.Rounded.Edit) { open = false; editor.editTags(tracks) }
                HiveMenuItem("Change cover", Icons.Rounded.Image) { open = false; editor.changeCover(tracks) }
                HiveMenuItem("Auto-tag album", Icons.Rounded.AutoFixHigh) { open = false; editor.autoTag(tracks) }
            }
            extra?.let { HiveMenuDivider(); it { open = false } }
        }
    }
}

/**
 * An artist: their picture and totals over Play / Shuffle, then their
 * albums by year as Hive shows them, each opening inline.
 */
@Composable
fun ArtistScreen(
    vm: MainViewModel,
    name: String,
    tracksFlow: Flow<List<Track>>,
    actions: TrackActions,
    bottomPadding: Dp,
    onBack: () -> Unit,
    onOpenAlbum: (Long) -> Unit,
) {
    val c = Hive.colors
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    val albums = remember(tracks) {
        tracks.groupBy { it.albumId }.map { (id, t) -> AlbumSummary(id, t.first().album, t.first().displayAlbumArtist, t.maxOf { it.year }, t.size) }.sortedByDescending { it.year }
    }
    val firstAlbum = albums.firstOrNull()?.albumId
    val colors by produceState<AuraColors?>(null, firstAlbum) { value = firstAlbum?.let { vm.albumColors(it) } }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    val veil by list.pageVeil()

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        // The year groups' rows, for hold-and-drag picking of albums.
        val grouped = albums.groupBy { it.year }
        val rows = remember(albums) { grouped.values.flatMap { it.chunked(2) }.associate { row -> "r${row.first().albumId}" as Any to row.map { it.albumId } } }
        val order = remember(albums) { grouped.values.flatten().map { it.albumId } }
        PickableList(albums = order)
        LazyColumn(Modifier.fillMaxSize().albumDragSelect(list, rows, order), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            item {
                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    val photo by produceState<String?>(null, name) { value = vm.artistImage(name) }
                    Artwork(photo ?: firstAlbum?.let { Uri.parse("content://media/external/audio/albumart/$it") }, Modifier.size(168.dp), CircleShape, Icons.Rounded.Person, glow = colors?.primary, elevation = 24.dp)
                    Text(name.ifBlank { "Unknown artist" }, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 18.dp, start = 24.dp, end = 24.dp))
                    Text("${countOf(albums.size, "album")} · ${countOf(tracks.size, "track")}", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                    Row(Modifier.fillMaxWidth().padding(top = 18.dp, start = 24.dp, end = 24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        PillButton("Play", HiveIcons.Play, accent = true, modifier = Modifier.weight(1f)) { vm.play(tracks) }
                        PillButton("Shuffle", HiveIcons.Shuffle, accent = false, modifier = Modifier.weight(1f)) { vm.shuffle(tracks) }
                    }
                }
            }
            grouped.forEach { (y, list2) ->
                item(key = "y$y") { YearHeading(if (y > 0) "$y" else "Unknown year") }
                list2.chunked(2).forEach { row ->
                    item(key = "r${row.first().albumId}") {
                        CoverRow(row) { a, m -> AlbumCard(a, m) { onOpenAlbum(a.albumId) } }
                    }
                }
            }
        }
    }, overlay = { PageBar(name, titleAlpha, onBack, veil) { CollectionMenu(tracks, vm, actions) } })
}

/** A genre, folder or smart playlist: its title, then its songs in a glass panel. */
@Composable
fun SongsScreen(
    vm: MainViewModel,
    title: String,
    tracksFlow: Flow<List<Track>>,
    actions: TrackActions,
    bottomPadding: Dp,
    /** The page's own items at the end of its ⋯ menu (a smart playlist's Edit and Delete). */
    extraMenu: (@Composable (close: () -> Unit) -> Unit)? = null,
    onBack: () -> Unit,
) {
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack) { CollectionMenu(tracks, vm, actions, extra = extraMenu) }
        TrackList(vm, tracks, actions, bottomPadding, "Nothing here yet", "", header = { PanelHeader(title) })
    }
}

/**
 * Search across songs, albums and artists, results grouped as Hive's search
 * does. The button beside the search bar turns it into an online search of
 * Apple Music and Spotify instead, as albums or tracks ([onOpenService] opens
 * an album's page there).
 */
@Composable
fun SearchScreen(vm: MainViewModel, actions: TrackActions, bottomPadding: Dp, onBack: () -> Unit, onOpenAlbum: (Long) -> Unit, onOpenArtist: (String) -> Unit, onOpenService: (String) -> Unit = {}) {
    val c = Hive.colors
    var query by rememberSaveable { mutableStateOf("") }
    var online by rememberSetting("search.online", false)
    var onlineAlbums by rememberSetting("search.onlineAlbums", true)
    var results by remember { mutableStateOf<List<Track>>(emptyList()) }
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val albums by vm.albums.collectAsStateWithLifecycle()
    val artists by vm.artists.collectAsStateWithLifecycle()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    // Results follow the library, so a deleted or newly scanned song shows at once.
    val library by vm.tracks.collectAsStateWithLifecycle()
    LaunchedEffect(query, library) { delay(140); results = vm.search(query) }
    // Library picks and online picks don't mix: switching search ends picking.
    val selection = LocalSelection.current
    var pickedFrom by rememberSaveable { mutableStateOf(online) }
    LaunchedEffect(online) { if (online != pickedFrom) { pickedFrom = online; selection?.clear() } }
    val q = query.trim()
    val fq = remember(q) { LibrarySort.words(q) }
    val longEnough = fq.sumOf { it.length } >= 2
    val albumHits by remember(fq, albums) { derivedStateOf { if (!longEnough) emptyList() else albums.filter { LibrarySort.matches("${it.album} ${it.artist}", fq) }.take(8) } }
    val liked by vm.streamFavorites.collectAsStateWithLifecycle()
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    val likedHits by remember(fq, liked) { derivedStateOf { if (!longEnough) emptyList() else liked.map { it.first }.filter { LibrarySort.matches("${it.title} ${it.artist} ${it.album}", fq) }.take(30) } }
    if (!online) PickableList(tracks = results, streams = likedHits)
    val artistHits by remember(fq, artists) { derivedStateOf { if (!longEnough) emptyList() else artists.filter { LibrarySort.matches(it.artist, fq) }.take(6) } }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable(onClick = onBack), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", tint = c.text, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(10.dp))
            SearchField(query, { query = it }, if (online) "Search Apple Music & Spotify…" else "Search library…", onSubmit = {}, onClear = { query = "" }, modifier = Modifier.weight(1f), focus = focus)
            Spacer(Modifier.width(10.dp))
            // Library or online (Apple Music and Spotify): lit while searching online.
            Box(
                Modifier.size(42.dp).hiveGlass(CircleShape).then(if (online) Modifier.background(c.accent.copy(alpha = 0.22f), CircleShape) else Modifier)
                    .clickable {
                        online = !online
                        // With something typed, the results take the screen instead of the keyboard.
                        if (query.isNotBlank()) focusManager.clearFocus()
                    }.semantics { contentDescription = if (online) "Search your library" else "Search Apple Music and Spotify" },
                contentAlignment = Alignment.Center,
            ) { OnlineSearchIcon(if (online) c.accent else c.text, Modifier.fillMaxSize()) }
        }
        Spacer(Modifier.height(8.dp))
        if (online) {
            HiveToggle(listOf("Albums", "Tracks"), if (onlineAlbums) 0 else 1, { onlineAlbums = it == 0 }, Modifier.padding(horizontal = 16.dp))
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 12.dp, bottom = bottomPadding + 12.dp)) {
                item { OnlineSearchResults(vm, query, onlineAlbums, onOpenService) }
            }
            return@Column
        }
        Box(Modifier.fillMaxSize()) {
            // Hold a song and drag over the others: library songs and liked streamed ones alike.
            val searchList = androidx.compose.foundation.lazy.rememberLazyListState()
            val dragRows: Map<Any, Any> = remember(results, likedHits) { (results.associate { ("t" + it.id) as Any to (it as Any) } + likedHits.associate { ("s" + it.key) as Any to (it as Any) }) }
            LazyColumn(Modifier.fillMaxSize().songDragSelect(searchList, dragRows, dragRows.values.toList()), state = searchList, contentPadding = PaddingValues(top = 8.dp, bottom = bottomPadding + 12.dp)) {
                if (q.isEmpty()) item { EmptyState("Search your library", "Songs, albums and artists on this phone.") }
                else if (results.isEmpty() && albumHits.isEmpty() && artistHits.isEmpty() && likedHits.isEmpty()) item { EmptyState("No results", "Nothing matches “$q”.") }
                if (artistHits.isNotEmpty()) {
                    item { HiveLabel("Artists", Modifier.padding(start = 18.dp, top = 10.dp, bottom = 4.dp)) }
                    items(artistHits, key = { "a" + it.artist }) { a -> LibraryRow(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.Person, a.artist, countOf(a.trackCount, "track"), round = true) { onOpenArtist(a.artist) } }
                }
                if (albumHits.isNotEmpty()) {
                    item { HiveLabel("Albums", Modifier.padding(start = 18.dp, top = 10.dp, bottom = 4.dp)) }
                    items(albumHits, key = { "l" + it.albumId }) { a -> LibraryRow(Uri.parse("content://media/external/audio/albumart/${a.albumId}"), Icons.Rounded.LibraryMusic, a.album, a.artist) { onOpenAlbum(a.albumId) } }
                }
                if (results.isNotEmpty() || likedHits.isNotEmpty()) {
                    item { HiveLabel("Songs", Modifier.padding(start = 18.dp, top = 10.dp, bottom = 4.dp)) }
                    itemsIndexed(results, key = { _, t -> "t" + t.id }) { i, t -> TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(results, i) }) }
                    // Liked Apple Music and Spotify songs are in Favorites, so search finds them too.
                    itemsIndexed(likedHits, key = { _, s -> "s" + s.key }) { i, s -> StreamRow(s, now.mediaId == s.key, now.isPlaying, full, onClick = { vm.playStreams(likedHits, i) }, vm = vm) }
                }
            }
        }
    }
}
