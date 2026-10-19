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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow

@Composable
fun BackBar(title: String, onBack: () -> Unit) {
    val colors = Hive.colors
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", tint = colors.text) }
        Text(title, color = colors.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * An album, artist, genre, folder or auto playlist: the big One UI header
 * (cover, name, "n tracks"), then Shuffle/Play all and the tracks.
 */
@Composable
fun CollectionScreen(
    vm: MainViewModel,
    title: String,
    subtitle: String,
    artwork: Any?,
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
    Column(Modifier.fillMaxSize()) {
        BackBar("", onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 8.dp)) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (artwork != null) {
                        Artwork(artwork, Modifier.size(200.dp), RoundedCornerShape(colors.radius + 4.dp), Icons.Rounded.LibraryMusic)
                        Spacer(Modifier.height(16.dp))
                    }
                    Text(title, color = colors.text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (subtitle.isNotBlank()) Text(subtitle, color = colors.textDim, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                    val total = tracks.sumOf { it.durationMs }
                    if (tracks.isNotEmpty()) Text("${tracks.size} tracks · ${formatDuration(total)}", color = colors.textDimmer, fontSize = 13.sp, modifier = Modifier.padding(top = 2.dp))
                }
            }
            if (tracks.isEmpty()) item { EmptyState("Nothing here yet", "") }
            else item { ListHeader(tracks.size, "track", { vm.shuffle(tracks) }, { vm.play(tracks) }) }
            itemsIndexed(tracks, key = { _, t -> t.id }) { i, t ->
                TrackRow(
                    t, t.id in loved, now.trackId == t.id, actions, onClick = { vm.play(tracks, i) },
                    subtitle = if (numbered) listOf(t.artist, formatDuration(t.durationMs)).filter { it.isNotBlank() }.joinToString(" · ") else listOf(t.artist, t.album).filter { it.isNotBlank() }.joinToString(" · "),
                    leading = if (numbered) ({
                        Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
                            Text(if (t.trackNumber > 0) "${t.trackNumber}" else "–", color = colors.textDim, fontSize = 15.sp)
                        }
                    }) else null,
                )
            }
        }
    }
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
        delay(150)
        results = vm.search(query)
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", tint = colors.text) }
            TextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search your library") },
                singleLine = true,
                leadingIcon = { Icon(Icons.Rounded.Search, null) },
                trailingIcon = { if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Rounded.Close, "Clear") } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                shape = RoundedCornerShape(28.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = colors.control, unfocusedContainerColor = colors.control,
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    cursorColor = colors.accent,
                ),
                modifier = Modifier.weight(1f).padding(end = 12.dp).focusRequester(focus),
            )
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 8.dp), verticalArrangement = Arrangement.Top) {
            if (query.isNotBlank() && results.isEmpty()) item { EmptyState("No results", "Nothing in your library matches \"$query\".") }
            itemsIndexed(results, key = { _, t -> t.id }) { i, t ->
                TrackRow(t, t.id in loved, now.trackId == t.id, actions, onClick = { vm.play(results, i) })
            }
        }
    }
}
