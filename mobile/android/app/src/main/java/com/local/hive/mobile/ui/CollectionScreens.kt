package com.local.hive.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBackIos
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.OneUi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow

/**
 * Samsung's page toolbar: back, a title that appears once the header has
 * scrolled away, and the page's actions on the right.
 */
@Composable
fun PageBar(title: String, titleAlpha: Float, onBack: () -> Unit, actions: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(64.dp).padding(start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        BarIcon(Icons.AutoMirrored.Rounded.ArrowBackIos, "Navigate up", onBack)
        Text(title, style = OneUi.PageTitle, color = OneUi.Text1, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).alpha(titleAlpha))
        actions()
    }
}

/** The rounded panel's top edge, opening a run of panel-coloured list items. */
private fun LazyListScope.panelTop() = item {
    Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp).height(26.dp).clip(OneUi.PanelShape).background(OneUi.Panel))
}

/** Lets the panel run to the bottom of the screen below a short list. */
private fun LazyListScope.panelFill(bottom: Dp) = item {
    Box(Modifier.fillParentMaxHeight(0.6f).fillMaxWidth().padding(horizontal = 4.dp).background(OneUi.Panel).padding(bottom = bottom))
}

@Composable
private fun PanelItem(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp).background(OneUi.Panel)) { content() }
}

@Composable
private fun PlayButtons(tracks: List<Track>, vm: MainViewModel) {
    Row(Modifier.fillMaxWidth().height(52.dp).padding(end = 14.dp), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
        CircleButton(Icons.Rounded.Shuffle, "Shuffle", { vm.shuffle(tracks) })
        Spacer(Modifier.width(10.dp))
        CircleButton(Icons.Rounded.PlayArrow, "Play all", { vm.play(tracks) })
    }
}

/**
 * An album as Samsung shows it: the cover, title, artist and "year | length"
 * centred on black, then the panel of numbered tracks with their durations.
 */
@Composable
fun AlbumScreen(
    vm: MainViewModel,
    title: String,
    artist: String,
    year: Int,
    artwork: Any?,
    tracksFlow: Flow<List<Track>>,
    actions: TrackActions,
    bottomPadding: Dp,
    onBack: () -> Unit,
    onSearch: (() -> Unit)? = null,
) {
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, label = "title")
    val allLoved = tracks.isNotEmpty() && tracks.all { it.id in loved }
    Column(Modifier.fillMaxSize().background(OneUi.Window)) {
        PageBar(title, titleAlpha, onBack) {
            BarIcon(if (allLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (allLoved) "Remove album from Favorites" else "Add album to Favorites", { vm.setLoved(tracks, !allLoved) }, tint = if (allLoved) OneUi.Primary else OneUi.Text1)
            if (onSearch != null) BarIcon(Icons.Rounded.Search, "Search", onSearch)
            CollectionMenu(tracks, vm)
        }
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding)) {
            item {
                Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Artwork(artwork, Modifier.size(152.dp), OneUi.Hero, Icons.Rounded.LibraryMusic)
                    Text(title, style = OneUi.HeroTitle, color = OneUi.Text1, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 16.dp, start = 32.dp, end = 32.dp))
                    if (artist.isNotBlank()) Text(artist, style = OneUi.Sub.copy(fontSize = OneUi.PlayerArtist.fontSize * 0.95f), color = OneUi.Text1, modifier = Modifier.padding(top = 10.dp))
                    val meta = listOfNotNull(year.takeIf { it > 0 }?.toString(), tracks.takeIf { it.isNotEmpty() }?.let { formatDuration(it.sumOf { t -> t.durationMs }) }).joinToString(" | ")
                    if (meta.isNotBlank()) Text(meta, style = OneUi.Sub, color = OneUi.Text2, modifier = Modifier.padding(top = 4.dp))
                }
            }
            panelTop()
            item { PanelItem { PlayButtons(tracks, vm) } }
            itemsIndexed(tracks, key = { _, t -> t.id }) { _, t ->
                PanelItem {
                    TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, tracks.indexOf(t)) }, number = t.trackNumber, showDivider = false)
                }
            }
            panelFill(bottomPadding)
        }
    }
}

/**
 * An artist as Samsung shows it: "Tracks (n) | Album (n)" at the top, then
 * the songs grouped under each album, or the albums as a grid.
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
    onSearch: (() -> Unit)? = null,
) {
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var showAlbums by remember { mutableStateOf(false) }
    val albums = remember(tracks) { tracks.groupBy { it.albumId }.values.toList() }
    Column(Modifier.fillMaxSize().background(OneUi.Window)) {
        PageBar(name.ifBlank { "Unknown artist" }, 1f, onBack) {
            val allLoved = tracks.isNotEmpty() && tracks.all { it.id in loved }
            BarIcon(if (allLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (allLoved) "Remove artist from Favorites" else "Add artist to Favorites", { vm.setLoved(tracks, !allLoved) }, tint = if (allLoved) OneUi.Primary else OneUi.Text1)
            if (onSearch != null) BarIcon(Icons.Rounded.Search, "Search", onSearch)
            CollectionMenu(tracks, vm)
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).height(48.dp)) {
            Segment("Tracks (${tracks.size})", !showAlbums, Modifier.weight(1f)) { showAlbums = false }
            Segment("Album (${albums.size})", showAlbums, Modifier.weight(1f)) { showAlbums = true }
        }
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxSize().padding(horizontal = 4.dp).clip(OneUi.PanelShape).background(OneUi.Panel)) {
            if (showAlbums) {
                LazyVerticalGrid(
                    GridCells.Fixed(2), Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 16.dp, bottom = bottomPadding + 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(albums) { album ->
                        val first = album.first()
                        Column(Modifier.clickable { onOpenAlbum(first.albumId) }, horizontalAlignment = Alignment.CenterHorizontally) {
                            Artwork(first.artworkUri, Modifier.fillMaxWidth().aspectRatio(1f), OneUi.Hero, Icons.Rounded.LibraryMusic)
                            Text(first.album.ifBlank { "Unknown album" }, style = OneUi.GridTitle, color = OneUi.Text1, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                            Text(listOfNotNull(first.year.takeIf { it > 0 }?.toString(), countOf(album.size, "track")).joinToString(" | "), style = OneUi.Sub, color = OneUi.TextSub)
                        }
                    }
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 12.dp)) {
                    item { PlayButtons(tracks, vm) }
                    albums.forEach { album ->
                        val first = album.first()
                        item(key = "album-${first.albumId}") {
                            Row(Modifier.fillMaxWidth().clickable { onOpenAlbum(first.albumId) }.padding(horizontal = OneUi.Gutter, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Artwork(first.artworkUri, Modifier.size(64.dp), OneUi.Thumb, Icons.Rounded.LibraryMusic)
                                Spacer(Modifier.width(OneUi.ThumbGap))
                                Column {
                                    Text(first.album.ifBlank { "Unknown album" }, style = OneUi.Title, color = OneUi.Text1, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    if (first.year > 0) Text("${first.year}", style = OneUi.Sub, color = OneUi.TextSub)
                                }
                            }
                        }
                        itemsIndexed(album, key = { _, t -> t.id }) { i, t ->
                            TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, tracks.indexOf(t)) }, number = t.trackNumber.takeIf { it > 0 } ?: (i + 1), showDivider = i < album.lastIndex)
                        }
                    }
                }
            }
        }
    }
}

/** ⋮ on album and artist pages: queue the whole page. */
@Composable
private fun CollectionMenu(tracks: List<Track>, vm: MainViewModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        BarIcon(Icons.Rounded.MoreVert, "More options", { open = true })
        OneUiMenu(open, { open = false }) {
            OneUiMenuItem("Play next") { open = false; vm.playNext(tracks) }
            OneUiMenuItem("Add to queue") { open = false; vm.addToQueue(tracks) }
        }
    }
}

@Composable
private fun Segment(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.fillMaxSize().clip(OneUi.Pill).background(if (selected) OneUi.Raised else androidx.compose.ui.graphics.Color.Transparent).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = OneUi.SortLabel, color = if (selected) OneUi.Text1 else OneUi.Text4) }
}

/** A genre, folder or playlist: the page title, then the panel of songs. */
@Composable
fun SongsScreen(
    vm: MainViewModel,
    title: String,
    tracksFlow: Flow<List<Track>>,
    actions: TrackActions,
    bottomPadding: Dp,
    onBack: () -> Unit,
) {
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    Column(Modifier.fillMaxSize().background(OneUi.Window)) {
        PageBar(title, 1f, onBack)
        Box(Modifier.fillMaxSize().padding(horizontal = 4.dp).clip(OneUi.PanelShape).background(OneUi.Panel)) {
            TrackList(vm, tracks, actions, bottomPadding + 12.dp, "Nothing here yet", "", sortLabel = countOf(tracks.size, "track"))
        }
    }
}

@Composable
fun SearchScreen(vm: MainViewModel, actions: TrackActions, bottomPadding: Dp, onBack: () -> Unit) {
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Track>>(emptyList()) }
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(query) {
        delay(140)
        results = vm.search(query)
    }
    Column(Modifier.fillMaxSize().background(OneUi.Window)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(64.dp).padding(start = 4.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            BarIcon(Icons.AutoMirrored.Rounded.ArrowBackIos, "Navigate up", onBack)
            Row(Modifier.weight(1f).height(44.dp).clip(OneUi.Pill).background(OneUi.Raised).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Search, null, tint = OneUi.TextSub, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text("Search", style = OneUi.Title, color = OneUi.TextSub)
                    BasicTextField(
                        query, { query = it }, singleLine = true,
                        textStyle = OneUi.Title.copy(color = OneUi.Text1),
                        cursorBrush = SolidColor(OneUi.Primary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                }
                if (query.isNotEmpty()) Box(Modifier.size(32.dp).clip(OneUi.Pill).clickable { query = "" }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Close, "Clear", tint = OneUi.TextSub, modifier = Modifier.size(18.dp))
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxSize().padding(horizontal = 4.dp).clip(OneUi.PanelShape).background(OneUi.Panel)) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = bottomPadding + 12.dp)) {
                if (query.isNotBlank() && results.isEmpty()) item { EmptyState("No results", "Nothing in your library matches “$query”.") }
                itemsIndexed(results, key = { _, t -> t.id }) { i, t ->
                    TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(results, i) })
                }
            }
        }
    }
}
