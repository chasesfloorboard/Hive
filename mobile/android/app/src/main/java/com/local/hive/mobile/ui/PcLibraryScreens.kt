package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
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
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.PcTrack
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass

/** An album in Hive's PC library. */
data class PcAlbum(val key: String, val name: String, val artist: String, val year: String, val tracks: List<PcTrack>)

fun pcAlbums(tracks: List<PcTrack>): List<PcAlbum> = tracks.filter { it.album.isNotBlank() }
    .groupBy { (it.albumArtist.ifBlank { it.artist }).lowercase() + "\u0000" + it.album.lowercase() }
    .map { (key, g) ->
        val first = g.first()
        PcAlbum(key, first.album, first.albumArtist.ifBlank { first.artist }, g.firstNotNullOfOrNull { it.year.take(4).ifBlank { null } }.orEmpty(), g.sortedWith(compareBy({ it.disc }, { it.track }, { it.title })))
    }
    .let { albums -> LibrarySort.sorted(albums) { it.name } }

/**
 * Hive's library on your PC, on the phone: every album and song Hive has,
 * kept here so it opens at once, playing by streaming from Hive while the
 * PC can be reached.
 */
@Composable
fun PcLibraryScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onOpenAlbum: (String) -> Unit) {
    val c = Hive.colors
    val tracks by vm.pcTracks.collectAsStateWithLifecycle()
    val link by vm.link.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var reachable by remember { mutableStateOf<Boolean?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var view by rememberSaveable { mutableStateOf(0) }
    LaunchedEffect(Unit) { reachable = runCatching { vm.pcLibrary.refresh() }.getOrDefault(false) }
    val albums by rememberComputed(emptyList(), tracks) { pcAlbums(tracks) }
    // Songs are put in order once, off the main thread; typing only filters.
    val songsByTitle by rememberComputed(emptyList(), tracks) { LibrarySort.sorted(tracks) { it.title } }
    val q = query.trim()
    val shownAlbums by remember(albums, q) { derivedStateOf { if (q.isEmpty()) albums else albums.filter { it.name.contains(q, true) || it.artist.contains(q, true) } } }
    val shownSongs by remember(songsByTitle, q) { derivedStateOf { if (q.isEmpty()) songsByTitle else songsByTitle.filter { it.title.contains(q, true) || it.artist.contains(q, true) || it.album.contains(q, true) } } }

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 10.dp)) {
                    HiveLabel(link.serverName.ifBlank { "Hive on your PC" })
                    Text("PC library", style = HiveText.viewTitle, color = c.text)
                    Text(
                        when {
                            !link.paired -> "Pair with Hive on your PC in Settings to see its library here."
                            reachable == false -> "Hive on your PC isn't reachable right now; this is the library as it was."
                            else -> "${countOf(tracks.size, "song")} · ${countOf(albums.size, "album")}, played by streaming from Hive."
                        },
                        style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            if (link.paired && tracks.isNotEmpty()) {
                item { SearchField(query, { query = it }, "Search the PC library", onSubmit = {}, onClear = { query = "" }) }
                item { HiveToggle(listOf("Albums", "Songs"), view, { view = it }, Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                if (view == 0) {
                    items(shownAlbums.chunked(2), key = { row -> row.first().key }) { row ->
                        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            row.forEach { a -> StreamCard(a.tracks.firstNotNullOfOrNull { vm.pcLibrary.coverUrl(it) }.orEmpty(), a.name, a.artist, Modifier.weight(1f)) { onOpenAlbum(a.key) } }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                } else {
                    item {
                        Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            HiveLabel(countOf(shownSongs.size, "song"), Modifier.weight(1f))
                            ControlButton(HiveIcons.Shuffle, "Shuffle", { vm.playPc(shownSongs, shuffle = true) }, size = 38.dp)
                        }
                    }
                    itemsIndexed(shownSongs, key = { _, t -> t.id }) { i, t -> PcTrackRow(vm, t, now.mediaId == "pc:${t.id}", now.isPlaying, null) { vm.playPc(shownSongs, i) } }
                }
            } else if (link.paired) item { EmptyState(if (reachable == null) "Loading…" else "Nothing here yet", if (reachable == false) "Open this page while Hive on your PC is running." else "") }
        }
    }
}

/** An album from Hive on the PC: its cover over Play / Shuffle, then its songs. */
@Composable
fun PcAlbumScreen(vm: MainViewModel, key: String, bottomPadding: Dp, onBack: () -> Unit) {
    val c = Hive.colors
    val tracks by vm.pcTracks.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val album = remember(tracks, key) { pcAlbums(tracks).firstOrNull { it.key == key } }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(null)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            if (album == null) item { Box(Modifier.statusBarsPadding().padding(top = 100.dp).fillMaxWidth()) { EmptyState("Album not found", "") } }
            else {
                item {
                    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Artwork(album.tracks.firstNotNullOfOrNull { vm.pcLibrary.coverUrl(it) }, Modifier.size(232.dp), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 30.dp)
                        HiveLabel("On your PC", Modifier.padding(top = 20.dp))
                        Text(album.name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                        Text(album.artist, style = HiveText.rowStrong, color = c.accent, modifier = Modifier.padding(top = 6.dp))
                        Text(listOfNotNull(album.year.ifBlank { null }, countOf(album.tracks.size, "track"), formatLength(album.tracks.sumOf { it.duration })).joinToString(" · "), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                        Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            ControlButton(HiveIcons.Shuffle, "Shuffle", { vm.playPc(album.tracks, shuffle = true) }, size = 46.dp)
                            AccentPlayButton(false, { vm.playPc(album.tracks) }, size = 58.dp)
                            ControlButton(Icons.AutoMirrored.Rounded.QueueMusic, "Add to queue", { vm.addToQueuePc(album.tracks) }, size = 46.dp)
                        }
                    }
                }
                item { PanelTop() }
                itemsIndexed(album.tracks, key = { _, t -> t.id }) { i, t ->
                    PanelSlice { PcTrackRow(vm, t, now.mediaId == "pc:${t.id}", now.isPlaying, t.track.takeIf { it > 0 } ?: (i + 1), subtitle = if (t.artist != album.artist) t.artist else "") { vm.playPc(album.tracks, i) } }
                }
                item { PanelBottom() }
            }
        }
    }, overlay = { PageBar(album?.name.orEmpty(), titleAlpha, onBack) })
}

@Composable
private fun PcTrackRow(vm: MainViewModel, t: PcTrack, playing: Boolean, isPlaying: Boolean, number: Int?, subtitle: String = listOf(t.artist, t.album).filter { it.isNotBlank() }.joinToString(" · "), onClick: () -> Unit) {
    val c = Hive.colors
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(if (number == null) 64.dp else 54.dp).clip(HiveShape.row)
            .background(if (playing) c.accentSoft.copy(alpha = 0.22f) else Color.Transparent).clickable(onClick = onClick).padding(start = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (number == null) {
            Box(Modifier.size(44.dp)) {
                Artwork(vm.pcLibrary.coverUrl(t), Modifier.size(44.dp))
                if (playing) Box(Modifier.size(44.dp).clip(HiveShape.thumb).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) { NowPlayingBars(isPlaying, Color.White) }
            }
        } else Box(Modifier.width(28.dp)) {
            if (playing) NowPlayingBars(isPlaying, c.accent) else Text("$number", style = HiveText.numbers, color = c.textDimmer)
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(t.title.ifBlank { t.file }, style = HiveText.row, color = if (playing) c.accent else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (t.duration > 0) Text(formatDuration(t.duration), style = HiveText.numbers, color = c.textDimmer)
        Box {
            Box(Modifier.size(width = 40.dp, height = 48.dp).clip(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.MoreHoriz, "More options", tint = c.textDim, modifier = Modifier.size(20.dp))
            }
            HiveMenu(menu, { menu = false }) {
                HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { menu = false; vm.playNextPc(listOf(t)) }
                HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; vm.addToQueuePc(listOf(t)) }
            }
        }
    }
}
