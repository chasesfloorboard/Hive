package com.local.hive.mobile.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.stream.AmCard
import com.local.hive.mobile.stream.AmCollection
import com.local.hive.mobile.stream.AmSearch
import com.local.hive.mobile.stream.AmShelf
import com.local.hive.mobile.stream.AmSong
import com.local.hive.mobile.stream.AppleMusic
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass

/** Loading, a failure, or the page's content. */
private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Failed(val message: String) : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
}

private fun Throwable.friendly(service: String) = when (this) {
    is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException -> "Couldn't reach $service. Check your connection."
    else -> message ?: "Couldn't reach $service."
}

/**
 * Hive's Apple Music page: Apple Music's Browse shelves, then search for
 * playlists and albums, or paste a music.apple.com link.
 */
@Composable
fun AppleMusicScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = Hive.colors
    var query by rememberSaveable { mutableStateOf("") }
    var submitted by rememberSaveable { mutableStateOf("") }
    var browse by remember { mutableStateOf<Load<List<AmShelf>>>(Load.Loading) }
    var results by remember { mutableStateOf<Load<AmSearch>?>(null) }
    var attempt by remember { mutableStateOf(0) }
    vm.tracks.collectAsStateWithLifecycle() // keeps the library index fresh for matching

    LaunchedEffect(attempt) { browse = runCatching { vm.appleMusic.browse() }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Apple Music")) }) }
    LaunchedEffect(submitted, attempt) {
        results = if (submitted.isBlank()) null else {
            results = Load.Loading
            runCatching { vm.appleMusic.search(submitted) }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Apple Music")) })
        }
    }
    fun submit() {
        val q = query.trim()
        if (q.isEmpty()) return
        if (AppleMusic.isAppleMusicLink(q)) onOpen(q) else submitted = q
    }

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp)) {
                    HiveLabel("Browse")
                    Text("Apple Music", style = HiveText.viewTitle, color = c.text)
                    Text("Songs in your library play from your files; the rest play Apple's 30-second previews.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                }
            }
            item {
                SearchField(query, { query = it }, "Search playlists and albums, or paste a link", onSubmit = ::submit, onClear = { query = ""; submitted = "" })
            }
            when (val r = results) {
                null -> when (val b = browse) {
                    Load.Loading -> item { Busy("Loading Apple Music…") }
                    is Load.Failed -> item { Failed(b.message) { attempt++ } }
                    is Load.Ready -> b.value.forEach { shelf ->
                        item(key = "h" + shelf.title) { YearHeading(shelf.title.ifBlank { "More" }) }
                        if (shelf.cards.isNotEmpty()) item(key = "c" + shelf.title) { CardShelf(shelf.cards, onOpen) }
                        else item(key = "s" + shelf.title) { SongShelf(vm, shelf.songs.take(10)) }
                    }
                }
                Load.Loading -> item { Busy("Searching Apple Music…") }
                is Load.Failed -> item { Failed(r.message) { attempt++ } }
                is Load.Ready -> {
                    if (r.value.playlists.isEmpty() && r.value.albums.isEmpty()) item { EmptyState("Nothing found", "Try another search, or paste a music.apple.com link.") }
                    if (r.value.playlists.isNotEmpty()) { item { YearHeading("Playlists") }; item { CardShelf(r.value.playlists, onOpen) } }
                    if (r.value.albums.isNotEmpty()) { item { YearHeading("Albums") }; item { CardShelf(r.value.albums, onOpen) } }
                }
            }
        }
    }
}

/** Hive's search pill. */
@Composable
fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String, onSubmit: () -> Unit, onClear: () -> Unit) {
    val c = Hive.colors
    Row(Modifier.padding(horizontal = 14.dp).fillMaxWidth().height(48.dp).hiveGlass(HiveShape.pill).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Search, null, tint = c.textDim, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, style = HiveText.row, color = c.textDimmer, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(value, onChange, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { onSubmit() }), modifier = Modifier.fillMaxWidth())
        }
        if (value.isNotEmpty()) Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onClear), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Close, "Clear search", tint = c.textDim, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Busy(label: String) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.accent)
        Spacer(Modifier.width(12.dp))
        Text(label, style = HiveText.small, color = c.textDim)
    }
}

@Composable
private fun Failed(message: String, onRetry: () -> Unit) {
    val c = Hive.colors
    Column(Modifier.fillMaxWidth().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(message, style = HiveText.body, color = c.textDim, textAlign = TextAlign.Center)
        HivePill("Try again", active = false, onClick = onRetry)
    }
}

@Composable
private fun CardShelf(cards: List<AmCard>, onOpen: (String) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(cards, key = { it.kind + it.id }) { card -> StreamCard(card.artwork, card.name, card.curator, Modifier.width(150.dp)) { onOpen(card.url.ifBlank { "https://music.apple.com/us/${card.kind}/x/${card.id}" }) } }
    }
}

/** A playlist or album from a streaming service: cover, name, curator. */
@Composable
fun StreamCard(art: String, name: String, subtitle: String, modifier: Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Column(modifier.pressable(onClick)) {
        Artwork(art.ifBlank { null }, Modifier.fillMaxWidth().aspectRatio(1f), HiveShape.art, Icons.AutoMirrored.Rounded.QueueMusic, elevation = 10.dp)
        Text(name, style = HiveText.cardTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SongShelf(vm: MainViewModel, songs: List<AmSong>) {
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val library by vm.tracks.collectAsStateWithLifecycle()
    val songsWithPreviews = remember(songs) { mutableStateOf(songs) }
    LaunchedEffect(songs) { songsWithPreviews.value = runCatching { vm.appleMusic.withPreviews(songs) }.getOrDefault(songs) }
    val list = songsWithPreviews.value
    val matches = remember(list, library) { list.map { vm.localMatch(it) } }
    Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
        list.forEachIndexed { i, s -> AppleSongRow(vm, s, matches[i] != null, now.mediaId == (matches[i]?.id?.toString() ?: "am:${s.appleId}"), now.isPlaying, null) { vm.playApple(listOf(s)) } }
    }
}

/** An Apple Music song with a badge saying how Hive plays it. */
@Composable
private fun AppleSongRow(vm: MainViewModel, s: AmSong, inLibrary: Boolean, playing: Boolean, isPlaying: Boolean, number: Int?, onClick: () -> Unit) {
    val c = Hive.colors
    var menu by remember { mutableStateOf(false) }
    val playable = inLibrary || s.previewUrl.isNotBlank()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 6.dp).height(62.dp).clip(HiveShape.row)
            .background(if (playing) c.accentSoft.copy(alpha = 0.22f) else Color.Transparent)
            .clickable(enabled = playable, onClick = onClick).padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (number != null) Text("$number", style = HiveText.numbers, color = c.textDimmer, textAlign = TextAlign.Center, modifier = Modifier.width(26.dp).padding(end = 4.dp))
        Box(Modifier.size(42.dp)) {
            Artwork(s.artwork.ifBlank { null }, Modifier.size(42.dp))
            if (playing) Box(Modifier.size(42.dp).clip(HiveShape.thumb).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) { NowPlayingBars(isPlaying, c.accent) }
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(s.title, style = HiveText.row, color = if (playing) c.accent else if (playable) c.text else c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                when {
                    inLibrary -> StreamBadge("In library", accent = true)
                    s.previewUrl.isNotBlank() -> StreamBadge("Preview")
                    else -> StreamBadge("Apple Music only")
                }
                Text(listOf(s.artist, s.album).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (s.durationMs > 0) Text(formatDuration(s.durationMs), style = HiveText.numbers, color = c.textDimmer)
        Box {
            Box(Modifier.size(44.dp).clip(CircleShape).clickable(enabled = playable) { menu = true }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.MoreHoriz, "More options", tint = c.textDim, modifier = Modifier.size(18.dp))
            }
            HiveMenu(menu, { menu = false }) {
                HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { menu = false; vm.playNextApple(listOf(s)) }
                HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; vm.addToQueueApple(listOf(s)) }
            }
        }
    }
}

/**
 * An Apple Music playlist or album: its cover over Play / Shuffle / Import,
 * how many of its songs are in the library, then its songs and "More like this".
 */
@Composable
fun AppleCollectionScreen(vm: MainViewModel, url: String, bottomPadding: Dp, onBack: () -> Unit, onOpen: (String) -> Unit, onOpenPlaylist: (Long) -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    var page by remember(url) { mutableStateOf<Load<AmCollection>>(Load.Loading) }
    var attempt by remember { mutableStateOf(0) }
    val library by vm.tracks.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    var importing by remember { mutableStateOf(false) }
    var showAll by remember { mutableStateOf(false) }
    LaunchedEffect(url, attempt) { page = Load.Loading; page = runCatching { vm.appleMusic.collection(url) }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Apple Music")) }) }
    val collection = (page as? Load.Ready)?.value
    val matches = remember(collection, library) { collection?.songs?.map { vm.localMatch(it) }.orEmpty() }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(null)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            when (val p = page) {
                Load.Loading -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Busy("Loading…") } }
                is Load.Failed -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Failed(p.message) { attempt++ } } }
                is Load.Ready -> {
                    val col = p.value
                    val inLibrary = matches.count { it != null }
                    item {
                        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Artwork(col.artwork.ifBlank { null }, Modifier.size(220.dp), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 30.dp)
                            HiveLabel(if (col.kind == "album") "Album" else "Playlist", Modifier.padding(top = 20.dp))
                            Text(col.name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                            Text(listOf(col.curator, countOf(col.songs.size, "song"), "$inLibrary in your library").filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
                            if (col.description.isNotBlank()) Text(col.description, style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, maxLines = if (showAll) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(top = 10.dp).clickable { showAll = !showAll })
                            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                ControlButton(Icons.Rounded.Shuffle, "Shuffle", { vm.playApple(col.songs, shuffle = true) }, size = 46.dp)
                                AccentPlayButton(false, { vm.playApple(col.songs) }, size = 58.dp)
                                ControlButton(Icons.AutoMirrored.Rounded.PlaylistAdd, "Import as playlist", {
                                    if (!importing) { importing = true; vm.importApple(col) { id, summary -> importing = false; onToast("Imported “${col.name}”: $summary"); onOpenPlaylist(id) } }
                                }, size = 46.dp)
                            }
                            Text("Songs you don't own play as 30-second previews.", style = HiveText.small, color = c.textDimmer, modifier = Modifier.padding(top = 12.dp))
                        }
                    }
                    item { PanelTop() }
                    itemsIndexed(col.songs, key = { i, s -> "$i:${s.appleId}" }) { i, s ->
                        PanelSlice {
                            val local = matches.getOrNull(i)
                            AppleSongRow(vm, s, local != null, now.mediaId == (local?.id?.toString() ?: "am:${s.appleId}"), now.isPlaying, i + 1) { vm.playApple(col.songs, i) }
                        }
                    }
                    item { PanelBottom() }
                    if (col.more.isNotEmpty()) {
                        item { YearHeading("More like this") }
                        item { CardShelf(col.more, onOpen) }
                    }
                }
            }
        }
    }, overlay = {
        PageBar(collection?.name.orEmpty(), titleAlpha, onBack) {
            if (collection != null) Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(collection.url))) }
            }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.OpenInNew, "Open in Apple Music", tint = c.text, modifier = Modifier.size(19.dp))
            }
        }
    })
}
