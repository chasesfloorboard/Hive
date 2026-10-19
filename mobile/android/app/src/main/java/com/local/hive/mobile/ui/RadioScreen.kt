package com.local.hive.mobile.ui

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.local.hive.mobile.stream.Station
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.launch

/**
 * Hive's internet radio: the stations you keep, then radio-browser.info's
 * most popular or those matching a search (by name or genre), and any
 * station added by its URL.
 */
@Composable
fun RadioScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val saved by vm.savedStations.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var submitted by rememberSaveable { mutableStateOf("") }
    var stations by remember { mutableStateOf<List<Station>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    var adding by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(submitted, attempt) {
        stations = null; error = null
        runCatching { if (submitted.isBlank()) vm.radio.popular() else vm.radio.search(submitted) }
            .onSuccess { stations = it }.onFailure { error = if (it is java.net.UnknownHostException) "Couldn't reach the radio directory. Check your connection." else it.message }
    }
    val savedIds = saved.map { it.id }.toSet()

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 14.dp, top = 2.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        HiveLabel("Browse")
                        Text("Radio", style = HiveText.viewTitle, color = c.text)
                        Text("Stations from radio-browser.info, or add one by its URL.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                    }
                    HivePill("Add by URL", active = false) { adding = true }
                }
            }
            item { SearchField(query, { query = it }, "Search stations or genres", onSubmit = { submitted = query.trim() }, onClear = { query = ""; submitted = "" }) }
            if (saved.isNotEmpty() && submitted.isBlank()) {
                item { YearHeading("Your stations") }
                item {
                    Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
                        saved.forEach { s -> StationRow(s, true, now.mediaId == s.mediaId, now.isPlaying, { vm.toggleStation(s) }) { vm.playStation(s) } }
                    }
                }
            }
            item { YearHeading(if (submitted.isBlank()) "Popular" else "Stations") }
            val list = stations
            when {
                error != null -> item {
                    Column(Modifier.fillMaxWidth().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(error.orEmpty(), style = HiveText.body, color = c.textDim, textAlign = TextAlign.Center)
                        HivePill("Try again", active = false) { attempt++ }
                    }
                }
                list == null -> item { Box(Modifier.fillMaxWidth().padding(28.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.accent) } }
                list.isEmpty() -> item { EmptyState("No stations found", "Try a station's name or a genre like jazz or lo-fi.") }
                else -> item {
                    Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
                        list.forEach { s -> StationRow(s, s.id in savedIds, now.mediaId == s.mediaId, now.isPlaying, { vm.toggleStation(s) }) { vm.playStation(s) } }
                    }
                }
            }
        }
    }
    if (adding) StationUrlDialog(onDismiss = { adding = false }) { url, name ->
        adding = false
        scope.launch {
            runCatching { vm.radio.fromUrl(url, name) }
                .onSuccess { s -> vm.toggleStation(s); vm.playStation(s); onToast("Added “${s.name}”") }
                .onFailure { onToast(it.message ?: "Couldn't add that station.") }
        }
    }
}

@Composable
private fun StationRow(s: Station, saved: Boolean, playing: Boolean, isPlaying: Boolean, onToggleSaved: () -> Unit, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 6.dp).height(64.dp).clip(HiveShape.row)
            .background(if (playing) c.accentSoft.copy(alpha = 0.22f) else Color.Transparent).clickable(onClick = onClick).padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(44.dp)) {
            Artwork(s.favicon.ifBlank { null }, Modifier.size(44.dp), HiveShape.thumb, Icons.Rounded.Radio)
            if (playing) Box(Modifier.size(44.dp).clip(HiveShape.thumb).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) { NowPlayingBars(isPlaying, c.accent) }
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(s.name, style = HiveText.row, color = if (playing) c.accent else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(s.tags.take(2).joinToString(", ").ifBlank { null }, s.country.ifBlank { null }, listOfNotNull(s.codec.ifBlank { null }, s.bitrate.takeIf { it > 0 }?.let { "$it kbps" }).joinToString(" ").ifBlank { null }).joinToString(" · "),
                style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onToggleSaved), contentAlignment = Alignment.Center) {
            Icon(if (saved) Icons.Rounded.Star else Icons.Rounded.StarBorder, if (saved) "Remove from your stations" else "Keep this station", tint = if (saved) c.accent else c.textDim, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(4.dp))
    }
}

@Composable
private fun StationUrlDialog(onDismiss: () -> Unit, onConfirm: (String, String) -> Unit) =
    FieldsDialog("Add a station", listOf("Stream or playlist URL (.pls, .m3u)", "Name (optional)"), "Add", onDismiss) { (url, name) -> onConfirm(url, name) }
