package com.local.hive.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.data.CrashLog
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText

/** After Hive closed unexpectedly: asks once whether to share the report. Nothing is sent otherwise. */
@Composable
fun CrashPrompt() {
    val context = LocalContext.current
    var crash by remember { mutableStateOf(CrashLog.unseenCrash(context)) }
    val entry = crash ?: return
    val c = Hive.colors
    fun done() { CrashLog.markSeen(context); crash = null }
    HiveDialog(::done, spacing = 10.dp) {
        Text("Hive closed unexpectedly", style = HiveText.year, color = c.text)
        Text("Sending the report helps get it fixed. It says what Hive was doing when it closed, with no songs, accounts or personal details. You choose where it goes.", style = HiveText.body, color = c.textDim)
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HiveButton("Not now", onClick = ::done)
            HiveButton("Send report", primary = true, onClick = { CrashLog.share(context, entry); done() })
        }
    }
}
