package com.local.hive.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText

/**
 * A fresh install that finds Hive Mobile's backup (on the phone, or kept on the PC) asks once
 * whether to come back exactly as it was. Restoring starts Hive again with everything put back.
 */
@Composable
fun RestoreOfferDialog(vm: MainViewModel) {
    val offer by vm.restoreOffer.collectAsStateWithLifecycle()
    val o = offer ?: return
    val c = Hive.colors
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val date = remember(o.savedAt) { java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(o.savedAt)) }
    HiveDialog(onDismiss = {}) {
        Text(if (o.replaces) "Restore" else "Welcome back", style = HiveText.small, color = c.accent)
        Text("Restore Hive Mobile as it was?", style = HiveText.year, color = c.text)
        Text(
            (if (o.picked != null) "This backup is from $date, made on ${o.deviceName.ifBlank { "a phone" }}" else "Hive found its backup from $date" + (if (o.pcDevice != null) ", kept on your PC" else ", on this phone")) +
                ". Your favorites, favorite albums and playlists, plays and Yearly Wrap, ratings, settings and the PC connection all come back, and Hive starts again." +
                (if (o.replaces) " What Hive has on this phone now is replaced." else "") +
                (if (o.picked != null) " Hive keeps that file up to date from then on." else ""),
            style = HiveText.row, color = c.textDim,
        )
        error?.let { Text(it, style = HiveText.rowSub, color = c.accent) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            HiveButton(if (o.replaces) "Cancel" else "Start fresh", enabled = !busy) { vm.declineRestore() }
            HiveButton(if (busy) "Restoring…" else "Restore", primary = true, enabled = !busy) {
                busy = true; error = null
                vm.restoreBackup(o) { busy = false; error = "Couldn't restore: $it" }
            }
        }
    }
}
