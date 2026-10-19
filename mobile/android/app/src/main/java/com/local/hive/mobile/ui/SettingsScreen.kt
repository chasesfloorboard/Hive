package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.ui.theme.OneUi

private val CardShape = RoundedCornerShape(26.dp)

/** One UI settings: grouped rounded cards on black, plain rows, blue actions. */
@Composable
fun SettingsScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit) {
    val link by vm.link.collectAsStateWithLifecycle()
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    val scanning by vm.scanning.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().background(OneUi.Window)) {
        PageBar("Settings", 1f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = bottomPadding + 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Subheader("Hive on your PC") }
            item { Card { if (link.paired) PairedSection(vm) else PairSection(vm) } }
            item { Subheader("Library") }
            item {
                Card {
                    SettingRow(countOf(tracks.size, "track") + " on this phone", "Hive reads the music stored on this phone and keeps up as files change.")
                    ActionRow(if (scanning) "Scanning…" else "Rescan now", enabled = !scanning) { vm.rescan() }
                }
            }
            item { Subheader("About") }
            item { Card { SettingRow("Hive", "Version 0.3") } }
        }
    }
}

@Composable
private fun Subheader(text: String) {
    Text(text, style = OneUi.Sub.copy(fontSize = OneUi.SortLabel.fontSize), color = OneUi.Primary, modifier = Modifier.padding(start = 24.dp, top = 12.dp))
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(CardShape).background(OneUi.Panel).padding(vertical = 6.dp)) { content() }
}

@Composable
private fun SettingRow(title: String, summary: String = "", onClick: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 24.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Text(title, style = OneUi.Title, color = OneUi.Text1)
        if (summary.isNotBlank()) Text(summary, style = OneUi.Sub, color = OneUi.TextSub)
    }
}

@Composable
private fun ActionRow(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Text(
        label, style = OneUi.Title, color = if (enabled) OneUi.Primary else OneUi.TextSub,
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 24.dp, vertical = 14.dp),
    )
}

@Composable
private fun PairedSection(vm: MainViewModel) {
    val link by vm.link.collectAsStateWithLifecycle()
    val state = when {
        link.syncing -> "Syncing…"
        link.live -> "Connected" + if (link.host.isNotBlank()) " · ${link.host}" else ""
        else -> "Not connected right now"
    }
    SettingRow(link.serverName, state)
    val details = buildList {
        if (link.pcTracks > 0) add("%,d of this phone's songs matched to Hive's %,d".format(link.matchedTracks, link.pcTracks))
        if (link.pendingChanges > 0) add("${link.pendingChanges} changes waiting to sync")
        if (link.lastSyncAt > 0) add("Last synced ${DateUtils.getRelativeTimeSpanString(link.lastSyncAt)}")
    }
    if (details.isNotEmpty()) SettingRow("Favorites sync", details.joinToString("\n"))
    link.error?.let { Text(it, style = OneUi.Sub, color = Color(0xFFFF6B6B), modifier = Modifier.padding(horizontal = 24.dp, vertical = 6.dp)) }
    ActionRow(if (link.syncing) "Syncing…" else "Sync now", enabled = !link.syncing) { vm.syncNow() }
    ActionRow("Unpair") { vm.unpair() }
}

@Composable
private fun PairSection(vm: MainViewModel) {
    val link by vm.link.collectAsStateWithLifecycle()
    val found by vm.discovered.collectAsStateWithLifecycle()
    val discovering by vm.discovering.collectAsStateWithLifecycle()
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf(HiveLinkClient.DEFAULT_PORT.toString()) }
    var code by remember { mutableStateOf("") }
    val busy by vm.pairing.collectAsStateWithLifecycle()
    val error by vm.pairError.collectAsStateWithLifecycle()

    SettingRow("Pair with Hive", "Pair once and your Favorites stay in sync both ways. In Hive on the PC, open the tray menu and choose Pair phone… to get a code.")
    Row(Modifier.fillMaxWidth().clickable(enabled = !discovering) { vm.discover() }.padding(horizontal = 24.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (discovering) "Looking on Wi-Fi…" else "Find Hive on this Wi-Fi", style = OneUi.Title, color = OneUi.Primary, modifier = Modifier.weight(1f))
        if (discovering) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = OneUi.Primary)
    }
    found.forEach { hive ->
        val selected = host == hive.host
        Column(
            Modifier.fillMaxWidth().clickable { host = hive.host; port = hive.port.toString() }
                .background(if (selected) OneUi.Raised else Color.Transparent).padding(horizontal = 24.dp, vertical = 12.dp),
        ) {
            Text(hive.name, style = OneUi.Title, color = OneUi.Text1)
            Text("${hive.host}:${hive.port}", style = OneUi.Sub, color = OneUi.TextSub)
        }
    }
    Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Field(host, { host = it }, "PC address", KeyboardType.Uri, Modifier.weight(1f))
        Field(port, { port = it.filter(Char::isDigit) }, "Port", KeyboardType.Number, Modifier.width(96.dp))
    }
    Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
        Field(code, { code = it.filter(Char::isDigit).take(6) }, "Pairing code", KeyboardType.NumberPassword, Modifier.fillMaxWidth())
    }
    (error ?: link.error)?.let { Text(it, style = OneUi.Sub, color = Color(0xFFFF6B6B), modifier = Modifier.padding(horizontal = 24.dp, vertical = 6.dp)) }
    ActionRow(if (busy) "Pairing…" else "Pair", enabled = !busy && host.isNotBlank() && code.length == 6) {
        vm.pair(host, port.toIntOrNull() ?: HiveLinkClient.DEFAULT_PORT, code)
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, type: KeyboardType, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(OneUi.Raised).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Text(label, style = OneUi.Sub, color = OneUi.TextSub)
        BasicTextField(
            value, onChange, singleLine = true,
            textStyle = OneUi.Title.copy(color = OneUi.Text1),
            cursorBrush = SolidColor(OneUi.Primary),
            keyboardOptions = KeyboardOptions(keyboardType = type),
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        )
    }
}
