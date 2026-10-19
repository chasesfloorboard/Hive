package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.ui.theme.Hive
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit) {
    val colors = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    val scanning by vm.scanning.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        BackBar("Settings", onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = bottomPadding + 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Card("Hive on your PC") {
                    if (link.paired) PairedSection(vm) else PairSection(vm)
                    link.error?.let { Text(it, color = colors.accent, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
                }
            }
            item {
                Card("Library") {
                    Text("${tracks.size} tracks on this phone", color = colors.text, fontSize = 15.sp)
                    Text("Hive reads the music stored on this phone, the same files Samsung Music plays.", color = colors.textDim, fontSize = 13.sp, modifier = Modifier.padding(top = 2.dp, bottom = 10.dp))
                    OutlinedButton(onClick = { vm.rescan() }, enabled = !scanning) {
                        if (scanning) { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
                        Text(if (scanning) "Scanning…" else "Rescan library")
                    }
                }
            }
            item {
                Card("Theme") {
                    Text("Hive Mobile uses the same theme variables as Hive on the PC (--bg, --accent, --panel…). It starts with your current Hive theme.", color = colors.textDim, fontSize = 13.sp, modifier = Modifier.padding(bottom = 10.dp))
                    OutlinedButton(onClick = { vm.resetTheme() }) { Text("Use the bundled theme") }
                }
            }
            item {
                Text("Hive Mobile 0.1.0", color = colors.textDimmer, fontSize = 12.sp, modifier = Modifier.padding(start = 4.dp))
            }
        }
    }
}

@Composable
private fun Card(title: String, content: @Composable () -> Unit) {
    val colors = Hive.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(colors.radius + 6.dp)).background(colors.control).padding(18.dp)) {
        Text(title, color = colors.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 10.dp))
        content()
    }
}

@Composable
private fun PairedSection(vm: MainViewModel) {
    val colors = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Computer, null, tint = colors.accent)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(link.serverName, color = colors.text, fontSize = 15.sp)
            val state = when {
                link.syncing -> "Syncing…"
                link.live -> "Connected${if (link.host.isNotBlank()) " · ${link.host}" else ""}"
                else -> "Not connected"
            }
            Text(state, color = colors.textDim, fontSize = 13.sp)
        }
    }
    val details = buildList {
        if (link.pcTracks > 0) add("${link.matchedTracks} of your phone's songs matched to Hive's ${link.pcTracks}")
        if (link.pendingChanges > 0) add("${link.pendingChanges} changes waiting to sync")
        if (link.lastSyncAt > 0) add("Last synced ${DateUtils.getRelativeTimeSpanString(link.lastSyncAt)}")
    }
    details.forEach { Text(it, color = colors.textDim, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp)) }
    Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Button(onClick = { vm.syncNow() }, enabled = !link.syncing, colors = ButtonDefaults.buttonColors(containerColor = colors.text, contentColor = colors.bg)) { Text("Sync now") }
        OutlinedButton(onClick = { vm.unpair() }) { Text("Unpair") }
    }
}

@Composable
private fun PairSection(vm: MainViewModel) {
    val colors = Hive.colors
    val found by vm.discovered.collectAsStateWithLifecycle()
    val discovering by vm.discovering.collectAsStateWithLifecycle()
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf(HiveLinkClient.DEFAULT_PORT.toString()) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Text("Pair once and your Favorites stay in sync both ways. In Hive on the PC, open the tray menu and choose “Pair phone…” to get a code.", color = colors.textDim, fontSize = 13.sp)
    Spacer(Modifier.height(10.dp))
    OutlinedButton(onClick = { vm.discover() }, enabled = !discovering) {
        if (discovering) { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
        Text(if (discovering) "Looking on Wi-Fi…" else "Find Hive on this Wi-Fi")
    }
    found.forEach { hive ->
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(12.dp)).clickable { host = hive.host; port = hive.port.toString() }
                .background(if (host == hive.host) colors.accentSoft else colors.bg.copy(alpha = 0.4f)).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Computer, null, tint = colors.text, modifier = Modifier.size(20.dp).clip(CircleShape))
            Spacer(Modifier.width(10.dp))
            Column {
                Text(hive.name, color = colors.text, fontSize = 15.sp)
                Text("${hive.host}:${hive.port}", color = colors.textDim, fontSize = 12.sp)
            }
        }
    }
    val fieldColors = OutlinedTextFieldDefaults.colors(focusedBorderColor = colors.accent, unfocusedBorderColor = colors.border, cursorColor = colors.accent)
    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(host, { host = it }, label = { Text("PC address") }, singleLine = true, colors = fieldColors, modifier = Modifier.weight(1f),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        OutlinedTextField(port, { port = it.filter(Char::isDigit) }, label = { Text("Port") }, singleLine = true, colors = fieldColors, modifier = Modifier.width(96.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
    }
    OutlinedTextField(code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("Pairing code") }, singleLine = true, colors = fieldColors,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
    error?.let { Text(it, color = colors.accent, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp)) }
    Button(
        onClick = {
            busy = true; error = null
            scope.launch {
                error = vm.pair(host, port.toIntOrNull() ?: HiveLinkClient.DEFAULT_PORT, code)
                busy = false
            }
        },
        enabled = !busy && host.isNotBlank() && code.length == 6,
        colors = ButtonDefaults.buttonColors(containerColor = colors.text, contentColor = colors.bg),
        modifier = Modifier.padding(top = 10.dp),
    ) { Text(if (busy) "Pairing…" else "Pair") }
}
