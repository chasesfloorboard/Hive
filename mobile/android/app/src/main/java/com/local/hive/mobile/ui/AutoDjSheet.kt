package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlassBorder

/** What the user held for Auto DJ: a name for it, and its songs (looked up when asked). */
class AutoDjRequest(val label: String, val seeds: suspend () -> List<Track>)

/** "Auto DJ: <album>", "<artist>", "<song>", or the first song "and more". */
fun autoDjLabel(tracks: List<Track>): String = when {
    tracks.isEmpty() -> "Auto DJ"
    tracks.size == 1 -> tracks.first().title
    tracks.all { it.albumId == tracks.first().albumId } -> tracks.first().album.ifBlank { tracks.first().title }
    tracks.all { it.displayAlbumArtist == tracks.first().displayAlbumArtist } -> tracks.first().displayAlbumArtist
    else -> "${tracks.first().title} and more"
}

/**
 * Auto DJ's queue for what was held: a preview of how it starts, then Play
 * (replaces the queue) or Save as playlist. Remix draws it again.
 */
@Composable
fun AutoDjSheet(vm: MainViewModel, request: AutoDjRequest, onDismiss: () -> Unit, onToast: (String) -> Unit, onOpenPlaylist: (Long) -> Unit) {
    val c = Hive.colors
    var queue by remember { mutableStateOf<List<Track>?>(null) }
    var round by remember { mutableIntStateOf(0) }
    LaunchedEffect(round) { queue = null; queue = vm.autoDj(request.seeds()) }
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().shadow(30.dp, HiveShape.panel, ambientColor = c.accentGlow).clip(HiveShape.panel).background(c.control)
                .border(1.dp, hiveGlassBorder(), HiveShape.panel).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Auto DJ", style = HiveText.small, color = c.accent)
            Text(request.label, style = HiveText.year, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val q = queue
            if (q == null) {
                Row(Modifier.fillMaxWidth().height(120.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.accent)
                }
            } else if (q.isEmpty()) {
                Text("Nothing on this phone to build a mix from.", style = HiveText.row, color = c.textDim)
            } else {
                Text("${countOf(q.size, "song")} · ${formatLength(q.sumOf { it.durationMs })} · ${countOf(q.map { it.displayAlbumArtist }.distinct().size, "artist")}", style = HiveText.small, color = c.textDim)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    q.take(6).forEach { t ->
                        Text("${t.title} · ${t.artist}", style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (q.size > 6) Text("…", style = HiveText.rowSub, color = c.textDimmer)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                Text("Remix", style = HiveText.rowStrong, maxLines = 1, softWrap = false, color = if (q != null) c.textDim else c.textDimmer,
                    modifier = Modifier.clip(HiveShape.pill).clickable(enabled = q != null) { round++ }.padding(horizontal = 8.dp, vertical = 10.dp))
                Text("Save playlist", style = HiveText.rowStrong, maxLines = 1, softWrap = false, color = if (!q.isNullOrEmpty()) c.text else c.textDimmer,
                    modifier = Modifier.clip(HiveShape.pill).clickable(enabled = !q.isNullOrEmpty()) {
                        vm.createPlaylist("Auto DJ: ${request.label}", q.orEmpty()) { id -> onToast("Saved Auto DJ: ${request.label}"); onOpenPlaylist(id) }
                        onDismiss()
                    }.padding(horizontal = 8.dp, vertical = 10.dp))
                Text("Play", style = HiveText.rowStrong, maxLines = 1, softWrap = false, color = readableOn(c.accent),
                    modifier = Modifier.clip(HiveShape.pill).background(if (!q.isNullOrEmpty()) c.accent else c.accent.copy(alpha = 0.4f))
                        .clickable(enabled = !q.isNullOrEmpty()) { vm.play(q.orEmpty()); onDismiss() }.padding(horizontal = 18.dp, vertical = 10.dp))
            }
        }
    }
}
