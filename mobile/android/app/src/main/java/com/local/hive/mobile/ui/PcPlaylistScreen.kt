package com.local.hive.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText

/**
 * One of Hive's playlists from the PC, read only: its songs play from the
 * phone's own copies where it has them, else through Hive on the PC. "Copy
 * to this phone" makes it a phone playlist.
 */
@Composable
fun PcPlaylistScreen(vm: MainViewModel, id: String, bottomPadding: Dp, onBack: () -> Unit, onOpenPlaylist: (Long) -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val lists by vm.pcPlaylists.collectAsStateWithLifecycle()
    val pcTracks by vm.pcTracks.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { runCatching { vm.pcLibrary.refresh() } }
    val p = lists.firstOrNull { it.id == id }
    val byId = remember(pcTracks) { pcTracks.associateBy { it.id } }
    // Each song as the phone shows it: its own copy, or Hive's details.
    val rows by produceState<List<Pair<Track?, StreamTrack>>>(emptyList(), p, byId) {
        value = p?.songs.orEmpty().map { s ->
            val shown = if (s.kind == "track") byId[s.id]?.let { t -> StreamTrack("pc:${t.id}", "Hive", t.title, t.artist, t.album, t.duration, vm.pcLibrary.coverUrl(t).orEmpty(), "", "") } ?: vm.pcStream(s).copy(title = "Song on your PC")
            else vm.pcStream(s)
            vm.localFor(s) to shown
        }
    }
    var copying by remember { mutableStateOf(false) }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(null)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            if (p == null) item { Box(Modifier.statusBarsPadding().padding(top = 100.dp).fillMaxWidth()) { EmptyState("Playlist not found", "It may have been removed on the PC.") } }
            else {
                item {
                    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Artwork(vm.pcLibrary.coverFor(p.cover) ?: p.artworkUrl.ifBlank { null }, Modifier.size(200.dp), HiveShape.art, Icons.AutoMirrored.Rounded.QueueMusic, elevation = 30.dp)
                        HiveLabel("On your PC", Modifier.padding(top = 20.dp))
                        Text(p.name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                        Text(listOf(countOf(p.songs.size, "song"), "${rows.count { it.first != null }} on this phone").joinToString(" · "), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 6.dp))
                        Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            ControlButton(Icons.Rounded.Shuffle, "Shuffle", { vm.playPcPlaylist(p.songs, shuffle = true) }, size = 46.dp)
                            AccentPlayButton(false, { vm.playPcPlaylist(p.songs) }, size = 58.dp)
                            ControlButton(Icons.AutoMirrored.Rounded.PlaylistAdd, "Copy to this phone", {
                                if (!copying) { copying = true; vm.copyPcPlaylist(p) { newId, msg -> copying = false; onToast(msg); onOpenPlaylist(newId) } }
                            }, size = 46.dp)
                        }
                    }
                }
                item { PanelTop() }
                itemsIndexed(rows) { i, (local, shown) ->
                    PanelSlice {
                        val loved by vm.lovedIds.collectAsStateWithLifecycle()
                        if (local != null) TrackRow(local, local.id in loved, now.trackId == local.id, now.isPlaying, TrackActions({}, {}, {}, {}, {}), onClick = { vm.playPcPlaylist(p.songs, i) })
                        else StreamRow(shown, now.mediaId == shown.key || now.mediaId == "pc:${shown.key.removePrefix("pc:")}", now.isPlaying, full = true, onClick = { vm.playPcPlaylist(p.songs, i) })
                    }
                }
                item { PanelBottom() }
            }
        }
    }, overlay = { PageBar(p?.name.orEmpty(), titleAlpha, onBack) })
}
