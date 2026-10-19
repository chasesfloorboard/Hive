package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.mix

/** Settings laid out as in Hive: titled sections with a description, label-and-hint rows with the control on the right. */
@Composable
fun SettingsScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit) {
    val link by vm.link.collectAsStateWithLifecycle()
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    val scanning by vm.scanning.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 8.dp, end = 8.dp, bottom = bottomPadding + 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("Settings", style = HiveText.viewTitle, color = Hive.colors.text, modifier = Modifier.padding(start = 12.dp, top = 4.dp, bottom = 6.dp)) }
            item {
                Section("Hive on your PC", "Brings Hive's Favorites to this phone over Wi-Fi. For now, changes you make here stay on this phone.") {
                    if (link.paired) PairedRows(vm) else PairRows(vm)
                }
            }
            item {
                Section("Library", "The music stored on this phone, kept up to date as files change.") {
                    SettingRow(countOf(tracks.size, "track"), "Read from this phone's music.") {
                        SmallButton(if (scanning) "Scanning…" else "Rescan", enabled = !scanning) { vm.rescan() }
                    }
                }
            }
            item {
                Section("Appearance", "Hive Mobile uses your Hive theme. While a song plays, the accent and backdrop follow its cover.") {
                    SettingRow("Theme", "The theme variables from Hive on your PC.") { SmallButton("Reset") { vm.resetTheme() } }
                }
            }
            item { Section("About", "") { SettingRow("Hive Mobile", "Version 0.4 · Inter is licensed under the SIL Open Font License.") {} } }
        }
    }
}

@Composable
private fun Section(title: String, description: String, content: @Composable () -> Unit) {
    val c = Hive.colors
    Column(Modifier.fillMaxWidth().hiveGlass(HiveShape.panel).padding(vertical = 14.dp)) {
        Column(Modifier.padding(horizontal = 18.dp).padding(bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = HiveText.year, color = c.text)
            if (description.isNotBlank()) Text(description, style = HiveText.small, color = c.textDim)
        }
        content()
    }
}

@Composable
private fun SettingRow(label: String, hint: String, control: @Composable () -> Unit) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = HiveText.rowStrong, color = c.text)
            if (hint.isNotBlank()) Text(hint, style = HiveText.small, color = c.textDim)
        }
        control()
    }
}

/** Hive's small control button (`.sidebar-add`). */
@Composable
private fun SmallButton(label: String, enabled: Boolean = true, primary: Boolean = false, onClick: () -> Unit) {
    val c = Hive.colors
    Box(
        Modifier.height(36.dp).clip(RoundedCornerShape(10.dp))
            .alpha(if (enabled) 1f else 0.45f)
            .background(if (primary) c.accent else mix(c.accent, c.panelStrong, 0.05f))
            .border(1.dp, mix(c.accent, c.border, 0.14f), RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveText.pill, color = if (primary) readableOn(c.accent) else c.text) }
}

@Composable
private fun PairedRows(vm: MainViewModel) {
    val c = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    val state = when {
        link.syncing -> "Syncing…"
        link.live -> "Connected" + if (link.host.isNotBlank()) " · ${link.host}" else ""
        else -> "Not connected right now"
    }
    SettingRow(link.serverName, state) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(if (link.live) Color(0xFF7BE0A0) else c.textDimmer))
    }
    val detail = buildList {
        if (link.pcTracks > 0) add("%,d of this phone's songs matched to Hive's %,d".format(link.matchedTracks, link.pcTracks))
        if (link.pendingChanges > 0) add("${link.pendingChanges} changes kept on this phone")
        if (link.lastSyncAt > 0) add("Synced ${DateUtils.getRelativeTimeSpanString(link.lastSyncAt)}")
    }.joinToString("\n")
    SettingRow("Favorites sync", detail) { SmallButton(if (link.syncing) "Syncing…" else "Sync now", enabled = !link.syncing, primary = true) { vm.syncNow() } }
    link.error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    SettingRow("Unpair this phone", "Stops syncing. Favorites already here stay.") { SmallButton("Unpair") { vm.unpair() } }
}

@Composable
private fun PairRows(vm: MainViewModel) {
    val c = Hive.colors
    val found by vm.discovered.collectAsStateWithLifecycle()
    val discovering by vm.discovering.collectAsStateWithLifecycle()
    val busy by vm.pairing.collectAsStateWithLifecycle()
    val error by vm.pairError.collectAsStateWithLifecycle()
    val linkError by vm.link.collectAsStateWithLifecycle()
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf(HiveLinkClient.DEFAULT_PORT.toString()) }
    var code by remember { mutableStateOf("") }

    SettingRow("Find Hive on this Wi-Fi", "On the PC: Settings › Connections › Hive Mobile › Pair phone.") {
        if (discovering) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.accent)
        else SmallButton("Search") { vm.discover() }
    }
    found.forEach { hive ->
        val selected = host == hive.host
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp).clip(HiveShape.row).background(if (selected) c.accentSoft.copy(alpha = 0.3f) else Color.Transparent)
                .clickable { host = hive.host; port = hive.port.toString() }.padding(horizontal = 10.dp, vertical = 10.dp),
        ) {
            Column {
                Text(hive.name, style = HiveText.rowStrong, color = c.text)
                Text("${hive.host}:${hive.port}", style = HiveText.small, color = c.textDim)
            }
        }
    }
    Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Field(host, { host = it }, "PC address", KeyboardType.Uri, Modifier.weight(1f))
        Field(port, { port = it.filter(Char::isDigit) }, "Port", KeyboardType.Number, Modifier.width(96.dp))
    }
    Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        Field(code, { code = it.filter(Char::isDigit).take(6) }, "Pairing code", KeyboardType.NumberPassword, Modifier.fillMaxWidth())
    }
    (error ?: linkError.error)?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A), modifier = Modifier.padding(horizontal = 18.dp, vertical = 4.dp)) }
    Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
        SmallButton(if (busy) "Pairing…" else "Pair", enabled = !busy && host.isNotBlank() && code.length == 6, primary = true) {
            vm.pair(host, port.toIntOrNull() ?: HiveLinkClient.DEFAULT_PORT, code)
        }
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, type: KeyboardType, modifier: Modifier) {
    val c = Hive.colors
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(mix(c.accent, c.panelStrong, 0.05f)).border(1.dp, c.border, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 9.dp)) {
        HiveLabel(label)
        BasicTextField(value, onChange, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = SolidColor(c.accent), keyboardOptions = KeyboardOptions(keyboardType = type), modifier = Modifier.fillMaxWidth().padding(top = 2.dp))
    }
}
