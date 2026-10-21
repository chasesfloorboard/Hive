package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass

/** The actions for picked songs, rising over the playbar while picking. */
@Composable
fun SelectionBar(vm: MainViewModel, selection: Selection, modifier: Modifier, onAddToPlaylist: (List<Track>) -> Unit, onDelete: (List<Track>) -> Unit, onToast: (String) -> Unit, onAutoDj: (List<Track>) -> Unit = {}) {
    val c = Hive.colors
    val library by vm.tracks.collectAsStateWithLifecycle()
    AnimatedVisibility(selection.active, modifier, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
        // Picked albums stand for all their songs.
        val picked = selection.picked(library)
        val context = androidx.compose.ui.platform.LocalContext.current
        fun done(message: String) { selection.clear(); onToast(message) }
        Column(Modifier.padding(horizontal = 10.dp).fillMaxWidth().shadow(22.dp, HiveShape.menu, ambientColor = c.accentGlow).hiveGlass(HiveShape.menu, strength = 0.3f).padding(horizontal = 6.dp, vertical = 6.dp)) {
            Row(Modifier.fillMaxWidth().padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                val what = listOfNotNull(selection.albums.size.takeIf { it > 0 }?.let { countOf(it, "album") }, selection.tracks.size.takeIf { it > 0 }?.let { countOf(it, "song") }).joinToString(" and ")
                Text("$what picked", style = HiveText.rowStrong, color = c.text, modifier = Modifier.weight(1f))
                Box(Modifier.size(40.dp).clip(CircleShape).clickable { onDelete(picked); selection.clear() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Delete, "Delete from phone", tint = c.textDim, modifier = Modifier.size(20.dp))
                }
                Box(Modifier.size(40.dp).clip(CircleShape).clickable { selection.clear() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Close, "Stop picking", tint = c.textDim, modifier = Modifier.size(20.dp))
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                Action("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { vm.playNext(picked); done("${countOf(picked.size, "song")} play next") }
                Action("Queue", Icons.AutoMirrored.Rounded.QueueMusic) { vm.addToQueue(picked); done("Added ${countOf(picked.size, "song")} to the queue") }
                Action("Playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { onAddToPlaylist(picked); selection.clear() }
                Action("Auto DJ", Icons.Rounded.Radio) { onAutoDj(picked); selection.clear() }
                Action("Favorite", Icons.Rounded.Favorite) { vm.setLoved(picked, true); done("Added ${countOf(picked.size, "song")} to Favorites") }
                Action("Share", Icons.Rounded.Share) { Share.tracks(context, picked); selection.clear() }
            }
        }
    }
}

@Composable
private fun Action(label: String, icon: ImageVector, onClick: () -> Unit) {
    val c = Hive.colors
    Column(Modifier.clip(HiveShape.row).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, null, tint = c.accent, modifier = Modifier.size(22.dp).padding(bottom = 2.dp))
        Text(label, style = HiveText.small, color = c.text, modifier = Modifier.height(18.dp))
    }
}
