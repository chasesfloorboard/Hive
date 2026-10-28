package com.local.hive.mobile.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import kotlinx.coroutines.launch

/**
 * What a held album, artist or playlist can do as a whole: play or shuffle it,
 * put it next or at the end of the queue, add it to a playlist, or Auto DJ from it.
 * Its songs are looked up when an action is picked.
 */
@Composable
fun CollectionSheet(
    vm: MainViewModel, request: AutoDjRequest, onDismiss: () -> Unit, onToast: (String) -> Unit,
    onAddToPlaylist: (List<Track>) -> Unit, onAutoDj: (AutoDjRequest) -> Unit,
) {
    val c = Hive.colors
    val scope = rememberCoroutineScope()
    fun withSongs(act: (List<Track>) -> Unit) {
        onDismiss()
        scope.launch { request.seeds().takeIf { it.isNotEmpty() }?.let(act) ?: onToast("No songs on this phone") }
    }
    HiveDialog(onDismiss, padding = PaddingValues(14.dp), spacing = 2.dp) {
            Text(request.label, style = HiveText.year, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 8.dp))
            HiveMenuItem("Play", Icons.Rounded.PlayArrow) { withSongs { vm.play(it) } }
            HiveMenuItem("Shuffle", Icons.Rounded.Shuffle) { withSongs { vm.shuffle(it) } }
            HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { withSongs { vm.playNext(it); onToast("${countOf(it.size, "song")} play next") } }
            HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { withSongs { vm.addToQueue(it); onToast("${countOf(it.size, "song")} added to the queue") } }
            HiveMenuItem("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { withSongs(onAddToPlaylist) }
            HiveMenuItem("Auto DJ", Icons.Rounded.Radio) { onDismiss(); onAutoDj(request) }
    }
}
