package com.local.hive.mobile.ui

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.LibraryMusic
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
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
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
import com.local.hive.mobile.ui.theme.GlassWeight
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveType
import com.local.hive.mobile.ui.theme.Radius
import com.local.hive.mobile.ui.theme.Space
import com.local.hive.mobile.ui.theme.GlassLayers
import com.local.hive.mobile.ui.theme.glass
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow

/** A floating glass bar: back on the left, an optional title that fades in. */
@Composable
fun FloatingBar(title: String, titleAlpha: Float, onBack: () -> Unit) {
    val colors = Hive.colors
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Space.sm, vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
        GlassIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", onBack)
        if (title.isNotBlank()) {
            Box(Modifier.weight(1f).padding(horizontal = Space.sm).alpha(titleAlpha)) {
                Box(Modifier.height(44.dp).glass(Radius.pill).padding(horizontal = Space.lg), contentAlignment = Alignment.Center) {
                    Text(title, style = HiveType.tab, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.width(44.dp))
        }
    }
}

/**
 * An album, artist, genre, folder or playlist. The page is lit by the
 * album's own colours; the cover floats with a matching glow over a large
 * title, then Play and Shuffle, then the songs.
 */
@Composable
fun CollectionScreen(
    vm: MainViewModel,
    title: String,
    subtitle: String,
    artwork: Any?,
    albumIdForColors: Long?,
    tracksFlow: Flow<List<Track>>,
    actions: TrackActions,
    bottomPadding: Dp,
    onBack: () -> Unit,
    numbered: Boolean = false,
) {
    val colors = Hive.colors
    val tracks by tracksFlow.collectAsStateWithLifecycle(emptyList())
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val heroAlbum = albumIdForColors ?: tracks.firstOrNull()?.albumId
    val aura by produceState<AuraColors?>(null, heroAlbum) { value = heroAlbum?.let { vm.albumColors(it) } }
    val list = rememberLazyListState()
    val barAlpha by remember { derivedStateOf { if (list.firstVisibleItemIndex > 0) 1f else (list.firstVisibleItemScrollOffset / 600f).coerceIn(0f, 1f) } }
    val cover = artwork ?: tracks.firstOrNull()?.artworkUri

    GlassLayers(Modifier.fillMaxSize(), content = {
        AuraBackground(aura, progress = 0f, intensity = 0.9f, base = colors.bg.copy(alpha = 0f), modifier = Modifier.fillMaxWidth().height(520.dp))
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + Space.lg)) {
            item {
                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = Space.xl, end = Space.xl, bottom = Space.md), horizontalAlignment = Alignment.CenterHorizontally) {
                    Artwork(cover, Modifier.size(232.dp), Radius.hero, Icons.Rounded.LibraryMusic, glow = aura?.primary, elevation = 28.dp)
                    Spacer(Modifier.height(Space.xl))
                    Text(title, style = HiveType.title, color = colors.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (subtitle.isNotBlank()) Text(subtitle, style = HiveType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Normal), color = aura?.accent ?: colors.textDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = Space.xxs))
                    if (tracks.isNotEmpty()) Text("%s · %s".format(countOf(tracks.size, "song"), formatLength(tracks.sumOf { it.durationMs })), style = HiveType.caption, color = colors.textDimmer, modifier = Modifier.padding(top = Space.xs))
                    if (tracks.isNotEmpty()) {
                        Row(Modifier.padding(top = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            PrimaryPill("Play", Icons.Rounded.PlayArrow, { vm.play(tracks) })
                            GlassPill("Shuffle", Icons.Rounded.Shuffle, { vm.shuffle(tracks) })
                        }
                    }
                }
            }
            if (tracks.isEmpty()) item { EmptyState("Nothing here yet", "") }
            itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                TrackRow(
                    t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(tracks, i) },
                    subtitle = if (numbered) listOf(t.artist, formatDuration(t.durationMs)).filter { it.isNotBlank() }.joinToString(" · ") else listOf(t.artist, t.album).filter { it.isNotBlank() }.joinToString(" · "),
                    number = if (numbered) t.trackNumber else null,
                )
            }
        }
    }, overlay = { FloatingBar(title, barAlpha, onBack) })
}

@Composable
fun SearchScreen(vm: MainViewModel, actions: TrackActions, bottomPadding: Dp, onBack: () -> Unit) {
    val colors = Hive.colors
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
    GlassLayers(Modifier.fillMaxSize(), content = {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 120.dp, bottom = bottomPadding + Space.lg)) {
            if (query.isBlank()) item { EmptyState("Search your library", "Songs, artists and albums on this phone.") }
            else if (results.isEmpty()) item { EmptyState("No results", "Nothing matches “$query”.") }
            else item { SectionLabel("Songs") }
            itemsIndexed(results, key = { _, t -> t.id }) { i, t ->
                TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.play(results, i) })
            }
        }
    }, overlay = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Space.sm, vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
            GlassIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", onBack)
            Spacer(Modifier.width(Space.sm))
            Row(Modifier.weight(1f).height(48.dp).glass(Radius.pill, GlassWeight.Regular).padding(horizontal = Space.md), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Search, null, tint = colors.textDim, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(Space.sm))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text("Songs, artists, albums", style = HiveType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Normal), color = colors.textDimmer)
                    BasicTextField(
                        query, { query = it }, singleLine = true,
                        textStyle = HiveType.body.copy(color = colors.text, fontWeight = androidx.compose.ui.text.font.FontWeight.Normal),
                        cursorBrush = SolidColor(colors.accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                }
                if (query.isNotEmpty()) Box(Modifier.size(32.dp).pressable({ query = "" }, 0.85f), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Close, "Clear", tint = colors.textDim, modifier = Modifier.size(18.dp))
                }
            }
        }
    })
}
