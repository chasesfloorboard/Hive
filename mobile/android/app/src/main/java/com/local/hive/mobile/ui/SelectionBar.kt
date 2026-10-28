package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.clickable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.foundation.background
import androidx.compose.material.icons.rounded.KeyboardArrowUp
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
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
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

/**
 * While picking: a small pill over the playbar's right end with how many are
 * picked, Actions (the options pop up from it) and ✕, so the list's last songs
 * stay in view (lists also gain room at their foot while picking).
 */
@Composable
fun SelectionBar(vm: MainViewModel, selection: Selection, modifier: Modifier, onAddToPlaylist: (List<Track>) -> Unit, onDelete: (List<Track>) -> Unit, onToast: (String) -> Unit, onAutoDj: (List<Track>) -> Unit = {}) {
    val c = Hive.colors
    val library by vm.tracks.collectAsStateWithLifecycle()
    AnimatedVisibility(selection.active, modifier, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
        // Picked albums stand for all their songs.
        val picked = selection.picked(library)
        val context = androidx.compose.ui.platform.LocalContext.current
        val editor = LocalEditor.current
        fun done(message: String) { selection.clear(); onToast(message) }
        var signIn by remember { mutableStateOf<List<com.local.hive.mobile.data.StreamTrack>?>(null) }
        var open by remember { mutableStateOf(false) }
        signIn?.let { streams -> SoulseekSignInDialog(onDismiss = { signIn = null }, onSignedIn = { signIn = null; downloadStreams(context, streams, onToast); selection.clear() }) }
        val streams = selection.streams.toList()
        val all = picked.size + streams.size
        Row(
            Modifier.padding(end = 12.dp).height(52.dp).shadow(22.dp, HiveShape.pill, ambientColor = c.accentGlow).hiveGlass(HiveShape.pill, strength = 0.3f).padding(start = 18.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val what = listOfNotNull(selection.albums.size.takeIf { it > 0 }?.let { countOf(it, "album") }, (selection.tracks.size + selection.streams.size).takeIf { it > 0 }?.let { countOf(it, "song") }).joinToString(" · ")
            Text(what, style = HiveText.rowStrong, color = c.text)
            Box(Modifier.padding(start = 10.dp)) {
                Row(
                    Modifier.height(40.dp).clip(HiveShape.pill).background(c.accent).clickable { open = true }.padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text("Actions", style = HiveText.pill, color = readableOn(c.accent))
                    Icon(Icons.Rounded.KeyboardArrowUp, null, tint = readableOn(c.accent), modifier = Modifier.size(18.dp))
                }
                HiveMenu(open, { open = false }, above = 40.dp) {
                    fun item(label: String, icon: ImageVector, destructive: Boolean = false, action: () -> Unit) = @Composable { HiveMenuItem(label, icon, destructive) { open = false; action() } }
                    if (streams.isNotEmpty()) {
                        // Streamed songs (Apple Music, Spotify), with any library songs picked beside them.
                        item("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { vm.playNextStreams(streams); if (picked.isNotEmpty()) vm.playNext(picked); done("${countOf(all, "song")} play next") }()
                        item("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { if (picked.isNotEmpty()) vm.addToQueue(picked); vm.addToQueueStreams(streams); done("Added ${countOf(all, "song")} to the queue") }()
                        item("Download", Icons.Rounded.Download) {
                            if (com.local.hive.mobile.soulseek.SoulseekSettings(context).configured) { downloadStreams(context, streams, onToast); selection.clear() } else signIn = streams
                        }()
                        item("Add to Favorites", Icons.Rounded.Favorite) { if (picked.isNotEmpty()) vm.setLoved(picked, true); streams.forEach { vm.likeStream(it) }; done("Added ${countOf(all, "song")} to Favorites") }()
                    } else {
                        item("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { vm.playNext(picked); done("${countOf(picked.size, "song")} play next") }()
                        item("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { vm.addToQueue(picked); done("Added ${countOf(picked.size, "song")} to the queue") }()
                        item("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { onAddToPlaylist(picked); selection.clear() }()
                        item("Auto DJ", Icons.Rounded.Radio) { onAutoDj(picked); selection.clear() }()
                        item("Add to Favorites", Icons.Rounded.Favorite) { vm.setLoved(picked, true); done("Added ${countOf(picked.size, "song")} to Favorites") }()
                        item("Share", Icons.Rounded.Share) { Share.tracks(context, picked); selection.clear() }()
                        HiveMenuDivider()
                        item("Edit tags", Icons.Rounded.Edit) { editor.editTags(picked); selection.clear() }()
                        item("Delete from phone", Icons.Rounded.Delete, destructive = true) { onDelete(picked); selection.clear() }()
                    }
                }
            }
            Box(Modifier.size(44.dp).clip(CircleShape).clickable { selection.clear() }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Close, "Stop picking", tint = c.textDim, modifier = Modifier.size(20.dp))
            }
        }
    }
}
