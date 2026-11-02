package com.local.hive.mobile.ui

import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Album
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
import androidx.compose.ui.input.nestedscroll.nestedScroll
import com.local.hive.mobile.ui.theme.Motion
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
            // An album on more than one disc gets a heading where each disc starts.
            val discs = tracks.mapTo(HashSet()) { it.discNumber }.size > 1
            tracks.forEachIndexed { i, t ->
                if (discs && t.discNumber != tracks.getOrNull(i - 1)?.discNumber) item(key = "disc${t.discNumber}-$i") {
                    YearHeading(if (t.discNumber > 0) "Disc ${t.discNumber}" else "No disc number")
                }
                item(key = t.id) {
                    TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) }, subtitle = if (t.artist != artist) t.artist else "", number = t.trackNumber.takeIf { it > 0 } ?: (i + 1))
                }
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
        HiveMenu(open, { open = false }, settings = true) {
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
                HiveMenuItem("Edit covers", Icons.Rounded.Image) { open = false; editor.changeCover(tracks) }
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
    // Albums, or every track of the artist album by album; the choice stays for the next artist.
    var view by rememberSetting("view.artist", ArtistView.Albums)
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    // Album by album, oldest first (RTJ, RTJ2, RTJ3, RTJ4), each in its own order. Tapping a song
    // plays on through the rest; Shuffle at the top shuffles everything.
    val byAlbum = remember(tracks) {
        tracks.groupBy { it.albumId }.values
            .sortedWith(compareBy<List<Track>> { a -> a.maxOf { it.year }.takeIf { it > 0 } ?: Int.MAX_VALUE }.thenBy { it.first().album.lowercase() })
            .map { a -> a.sortedWith(compareBy<Track>({ it.discNumber }, { it.trackNumber }, { it.title.lowercase() })) }
    }
    val byTitle = remember(byAlbum) { byAlbum.flatten() }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        // The year groups' rows, for hold-and-drag picking of albums.
        val grouped = albums.groupBy { it.year }
        val rows = remember(albums) { grouped.values.flatMap { it.chunked(2) }.associate { row -> "r${row.first().albumId}" as Any to row.map { it.albumId } } }
        val order = remember(albums) { grouped.values.flatten().map { it.albumId } }
        if (view == ArtistView.Albums) PickableList(albums = order) else PickableList(tracks = byTitle)
        LazyColumn(Modifier.fillMaxSize().then(if (view == ArtistView.Albums) Modifier.albumDragSelect(list, rows, order) else Modifier), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            item {
                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    val photo = rememberArtistPhoto(vm, name)
                    Artwork(photo ?: firstAlbum?.let { Uri.parse("content://media/external/audio/albumart/$it") }, Modifier.size(168.dp), CircleShape, Icons.Rounded.Person, glow = colors?.primary, elevation = 24.dp)
                    Text(name.ifBlank { "Unknown artist" }, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 18.dp, start = 24.dp, end = 24.dp))
                    Text("${countOf(albums.size, "album")} · ${countOf(tracks.size, "track")}", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                    Row(Modifier.fillMaxWidth().padding(top = 18.dp, start = 24.dp, end = 24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        PillButton("Play", HiveIcons.Play, accent = true, modifier = Modifier.weight(1f)) { vm.play(tracks) }
                        PillButton("Shuffle", HiveIcons.Shuffle, accent = false, modifier = Modifier.weight(1f)) { vm.shuffle(tracks) }
                    }
                }
            }
            item(key = "view") {
                HiveToggle(ArtistView.entries.map { it.label }, view.ordinal, { view = ArtistView.entries[it] }, Modifier.padding(start = 16.dp, end = 16.dp, bottom = 6.dp))
            }
            if (view == ArtistView.Albums) grouped.forEach { (y, list2) ->
                item(key = "y$y") { YearHeading(if (y > 0) "$y" else "Unknown year") }
                list2.chunked(2).forEach { row ->
                    item(key = "r${row.first().albumId}") {
                        CoverRow(row) { a, m -> AlbumCard(a, m, subtitle = countOf(a.trackCount, "track")) { onOpenAlbum(a.albumId) } }
                    }
                }
            } else {
                var at = 0
                byAlbum.forEachIndexed { n, album ->
                    val first = album.first()
                    val year = album.maxOf { it.year }
                    // A line between albums; each album under its cover and name, its songs by number
                    // (as the album's own page lists them), with a heading where each disc starts.
                    if (n > 0) item(key = "sep${first.albumId}") {
                        Box(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp).height(1.dp).background(c.border))
                    }
                    item(key = "h${first.albumId}") {
                        AlbumGroupHeader(first.albumId, first.album.ifBlank { "Unknown album" },
                            listOfNotNull(year.takeIf { it > 0 }?.toString(), countOf(album.size, "track"), formatLength(album.sumOf { it.durationMs })).joinToString(" · ")) { onOpenAlbum(first.albumId) }
                    }
                    val discs = album.mapTo(HashSet()) { it.discNumber }.size > 1
                    album.forEachIndexed { j, t ->
                        val i = at++
                        if (discs && t.discNumber != album.getOrNull(j - 1)?.discNumber) item(key = "d${first.albumId}-${t.discNumber}-$j") {
                            YearHeading(if (t.discNumber > 0) "Disc ${t.discNumber}" else "No disc number")
                        }
                        item(key = "t${t.id}") {
                            // The artist shows only when it isn't this page's (a feature, a split release).
                            TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(byTitle, i) },
                                subtitle = if (t.artist.equals(name, true)) "" else t.artist, number = t.trackNumber.takeIf { it > 0 } ?: (j + 1))
                        }
                    }
                }
            }
        }
    }, overlay = { PageBar(name, titleAlpha, onBack, veil) { FavoriteBarActions(vm, favoriteArtist(name)); Spacer(Modifier.width(8.dp)); CollectionMenu(tracks, vm, actions) } })
}

/**
 * An album's heading in an artist's Tracks view, as Samsung Music has it: the cover, the album's
 * name, and its year, songs and length. Tapping it opens the album.
 */
@Composable
fun AlbumGroupHeader(albumId: Long, title: String, detail: String, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, top = 14.dp, bottom = 4.dp).clip(HiveShape.thumb).clickable(onClick = onClick).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Artwork(Uri.parse("content://media/external/audio/albumart/$albumId"), Modifier.size(64.dp).sharedCover("album-$albumId"), HiveShape.thumb, Icons.Rounded.Album, elevation = 10.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = HiveText.year, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(detail, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "Open album", tint = c.textDimmer, modifier = Modifier.size(20.dp))
    }
}

/** An artist's page: their albums by year, or all their tracks. */
enum class ArtistView(val label: String) { Albums("Albums"), Tracks("Tracks") }

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
    /** Buttons before the ⋯ menu (a playlist's heart and picture). */
    barActions: @Composable () -> Unit = {},
    /** The page's own picture, if the user chose one (see [com.local.hive.mobile.data.PlaylistImages]). */
    imageKey: String? = null,
    /** What the list's own order is called in the sort menu (Favorites: "Date favorited"). */
    ownOrder: String = "Default order",
    onBack: () -> Unit,
) {
    val all by tracksFlow.collectAsStateWithLifecycle(emptyList())
    // Pull the list down past its top for a search of just this page, as in Favorites.
    var query by rememberSaveable { mutableStateOf("") }
    val q = remember(query) { LibrarySort.words(query.trim()) }
    // Its own order (newest favorited, most played…), or by name, artist, album or length; kept per page.
    val sorts = remember { listOf(TrackSort.Title, TrackSort.Artist, TrackSort.Album, TrackSort.Length) }
    var sortAt by rememberIntSetting("sort.songs.$title", 0)
    val tracks by rememberComputed(all, all, q, sortAt) {
        val found = if (q.isEmpty()) all else all.filter { LibrarySort.matches("${it.title} ${it.artist} ${it.album}", q) }
        sorts.getOrNull(sortAt - 1)?.let { sortTracks(found, it) } ?: found
    }
    val search = rememberPullToReveal(keepShown = query.isNotEmpty())
    // Its songs, or the albums and artists they're from.
    var view by rememberSaveable { mutableStateOf(SongsView.Tracks) }
    var groupSort by rememberSaveable { mutableStateOf(GroupSort.Most) }
    val counts = remember(tracks) { songsCounts(tracks) }
    // Laid out as a playlist of your own: its picture (or four of its covers), name, length, Shuffle and Play.
    val images by vm.playlistImages.collectAsStateWithLifecycle()
    val chosen = imageKey?.let { images[it] }
    val pickImage = rememberPlaylistImagePicker(vm, imageKey)
    val covers = remember(all) { mosaicCovers(all) }
    val firstAlbum = all.firstOrNull()?.albumId
    val colors by produceState<AuraColors?>(null, firstAlbum) { value = firstAlbum?.let { vm.albumColors(it) } }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    val veil by list.pageVeil()
    val c = Hive.colors
    val hero: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (chosen == null && covers.size >= 4) Box(Modifier.size(200.dp).softShadow(30.dp, HiveShape.art, colors?.primary ?: Color.Black).clip(HiveShape.art)) { CoverMosaic(covers) }
            else Artwork(chosen ?: covers.firstOrNull(), Modifier.size(200.dp), HiveShape.art, Icons.AutoMirrored.Rounded.QueueMusic, glow = colors?.primary, elevation = 30.dp)
            Text(title, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 22.dp))
            Text(listOf(countOf(all.size, "track"), formatLength(all.sumOf { it.durationMs })).joinToString(" · "), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 6.dp))
            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                ControlButton(HiveIcons.Shuffle, "Shuffle", { vm.shuffle(tracks) }, size = 46.dp)
                AccentPlayButton(false, { vm.play(tracks) }, size = 58.dp)
            }
        }
        // Hidden until the list is pulled down past its top.
        androidx.compose.animation.AnimatedVisibility(search.shown, enter = androidx.compose.animation.expandVertically(Motion.open()) + androidx.compose.animation.fadeIn(Motion.swap()),
            exit = androidx.compose.animation.shrinkVertically(Motion.close()) + androidx.compose.animation.fadeOut(Motion.underFade())) {
            SearchField(query, { query = it }, "Search $title", onSubmit = {}, onClear = { query = "" }, modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 10.dp))
        }
    }
    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        Box(Modifier.fillMaxSize().nestedScroll(search.connection)) {
            if (view == SongsView.Tracks) TrackList(vm, tracks, actions, bottomPadding, if (q.isEmpty()) "Nothing here yet" else "Nothing matches", if (q.isEmpty()) "" else "Nothing in $title matches “${query.trim()}”.",
                header = { Column { hero() } }, list = list,
                sortHeader = { count, _, _ -> SongsHeader(view, counts, { view = it }, listOf(ownOrder) + sorts.map { it.label }, sortAt, { sortAt = it }, "$count · ${(listOf(ownOrder) + sorts.map { it.label })[sortAt.coerceIn(0, sorts.size)]}") },
                indexed = sorts.getOrNull(sortAt - 1) == TrackSort.Title)
            else LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
                item { Column { hero() } }
                item { SongsHeader(view, counts, { view = it }, GroupSort.entries.map { it.label }, groupSort.ordinal, { groupSort = GroupSort.entries[it] }, groupDetail(view, counts, groupSort)) }
                songGroups(vm, view, tracks, actions, groupSort)
            }
        }
    }, overlay = { PageBar(title, titleAlpha, onBack, veil) {
        barActions(); Spacer(Modifier.width(8.dp))
        CollectionMenu(tracks, vm, actions, extra = if (imageKey == null) extraMenu else { close ->
            PlaylistImageItems(vm, imageKey, pickImage, close)
            if (extraMenu != null) extraMenu(close)
        })
    } })
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
