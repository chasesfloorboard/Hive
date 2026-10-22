package com.local.hive.mobile.ui

import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.GoneSong
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlassBorder
import kotlinx.coroutines.launch

/**
 * Songs deleted on one side since song sync last saw them on both. For each
 * side, the picked songs can be deleted on the other side too (to the PC's
 * Trash; on this phone after Android asks), copied back so both sides match
 * again, or left as they are (not asked about again).
 */
@Composable
fun DeletionsSheet(vm: MainViewModel, onDismiss: () -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val d by vm.deletions.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    // Everything starts picked; a tap leaves a song out.
    var unpicked by remember { mutableStateOf(emptySet<String>()) }
    var busy by remember { mutableStateOf(false) }
    var deletingOnPhone by remember { mutableStateOf<List<GoneSong>>(emptyList()) }
    val phoneDelete = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            vm.songSyncOps.deletedOnPhone(deletingOnPhone)
            onToast(countOf(deletingOnPhone.size, "song") + " deleted from this phone")
        }
        deletingOnPhone = emptyList()
    }
    val context = androidx.compose.ui.platform.LocalContext.current
    if (d.count == 0 && !busy) { onDismiss(); return }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.padding(16.dp).fillMaxWidth().shadow(30.dp, HiveShape.panel, ambientColor = c.accentGlow).clip(HiveShape.panel).background(c.control)
                .border(1.dp, hiveGlassBorder(), HiveShape.panel).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Song sync", style = HiveText.small, color = c.accent)
            Text("Deleted songs", style = HiveText.year, color = c.text)
            LazyColumn(Modifier.heightIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                fun section(title: String, note: String, songs: List<GoneSong>, actions: @Composable (List<GoneSong>) -> Unit) {
                    if (songs.isEmpty()) return
                    item {
                        Column(Modifier.padding(top = 10.dp, bottom = 4.dp)) {
                            Text(title, style = HiveText.rowStrong, color = c.text)
                            Text(note, style = HiveText.small, color = c.textDim)
                        }
                    }
                    items(songs, key = { it.key }) { s ->
                        val on = s.key !in unpicked
                        Row(Modifier.fillMaxWidth().clip(HiveShape.row).clickable { unpicked = if (on) unpicked + s.key else unpicked - s.key }.padding(vertical = 6.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(22.dp).clip(CircleShape).background(if (on) c.accent else Color.Transparent).border(1.5.dp, if (on) c.accent else c.textDimmer, CircleShape), contentAlignment = Alignment.Center) {
                                if (on) Icon(Icons.Rounded.Check, null, tint = readableOn(c.accent), modifier = Modifier.size(15.dp))
                            }
                            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                Text(s.title, style = HiveText.row, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(listOf(s.artist, s.album).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    item { actions(songs.filter { it.key !in unpicked }) }
                }
                section("Deleted on your PC", "Still on this phone.", d.fromPc) { picked ->
                    Actions(
                        picked,
                        "Delete from this phone" to {
                            val uris = picked.mapNotNull { it.phone?.uri }
                            if (uris.isNotEmpty()) {
                                deletingOnPhone = picked
                                phoneDelete.launch(IntentSenderRequest.Builder(MediaStore.createDeleteRequest(context.contentResolver, uris).intentSender).build())
                            }
                        },
                        "Copy back to PC" to { scope.launch { vm.songSyncOps.copyBack(picked); onToast("They'll be copied back on the next sync") } },
                        "Leave" to { vm.songSyncOps.leave(picked) },
                    )
                }
                section("Deleted on this phone", "Still on your PC.", d.fromPhone) { picked ->
                    Actions(
                        picked,
                        "Delete on PC" to {
                            busy = true
                            scope.launch {
                                runCatching { vm.songSyncOps.deleteOnPc(picked) }
                                    .onSuccess { onToast(countOf(it, "song") + " moved to the PC's Trash") }
                                    .onFailure { onToast(it.message ?: "Couldn't delete on the PC") }
                                busy = false
                            }
                        },
                        "Copy back to phone" to { scope.launch { vm.songSyncOps.copyBack(picked); onToast("They'll be copied back on the next sync") } },
                        "Leave" to { vm.songSyncOps.leave(picked) },
                    )
                }
            }
            Text(
                "Decide later", style = HiveText.rowStrong, color = c.textDim,
                modifier = Modifier.align(Alignment.End).clip(HiveShape.pill).clickable(onClick = onDismiss).padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
    }
}

/** A section's buttons for its picked songs; the first (the delete) in red. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun Actions(picked: List<GoneSong>, vararg actions: Pair<String, () -> Unit>) {
    val c = Hive.colors
    FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        actions.forEachIndexed { i, (label, act) ->
            val enabled = picked.isNotEmpty()
            Text(
                label, style = HiveText.rowStrong,
                color = when { !enabled -> c.textDimmer; i == 0 -> Color(0xFFFF8A8A); else -> c.text },
                modifier = Modifier.clip(HiveShape.pill).border(1.dp, c.border, HiveShape.pill).clickable(enabled = enabled, onClick = act).padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}
