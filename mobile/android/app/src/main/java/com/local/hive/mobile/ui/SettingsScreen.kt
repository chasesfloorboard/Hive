package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Palette
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.ui.theme.GlassLayers
import com.local.hive.mobile.ui.theme.GlassWeight
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveType
import com.local.hive.mobile.ui.theme.Radius
import com.local.hive.mobile.ui.theme.Space
import com.local.hive.mobile.ui.theme.glass
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit) {
    val colors = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    val tracks by vm.tracks.collectAsStateWithLifecycle()
    val scanning by vm.scanning.collectAsStateWithLifecycle()

    GlassLayers(Modifier.fillMaxSize(), content = {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = Space.md, end = Space.md, top = 112.dp, bottom = bottomPadding + Space.xl),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            item { Text("Settings", style = HiveType.title, color = colors.text, modifier = Modifier.padding(start = Space.xs, bottom = Space.sm)) }
            item { SectionLabel("Hive on your PC", Modifier.padding(start = 0.dp)) }
            item {
                SettingsCard {
                    if (link.paired) PairedSection(vm) else PairSection(vm)
                    link.error?.let { Text(it, style = HiveType.secondary, color = colors.accent, modifier = Modifier.padding(top = Space.sm)) }
                }
            }
            item { SectionLabel("Library") }
            item {
                SettingsCard {
                    CardHeader(Icons.Rounded.Refresh, "%,d songs on this phone".format(tracks.size), "Read from the music stored on this phone, and kept up to date as files change.")
                    Row(Modifier.padding(top = Space.md)) {
                        GlassPill(if (scanning) "Scanning…" else "Rescan now", null, { if (!scanning) vm.rescan() })
                    }
                }
            }
            item { SectionLabel("Appearance") }
            item {
                SettingsCard {
                    CardHeader(Icons.Rounded.Palette, "Your Hive theme", "Hive Mobile reads the same theme variables as Hive on the PC. While a song plays, the accent follows its cover.")
                    Row(Modifier.padding(top = Space.md)) { GlassPill("Use the bundled theme", null, { vm.resetTheme() }) }
                }
            }
            item { Text("Hive Mobile 0.2", style = HiveType.caption, color = colors.textDimmer, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = Space.lg)) }
        }
    }, overlay = { FloatingBar("Settings", 0f, onBack) })
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().glass(Radius.card, GlassWeight.Regular).padding(Space.lg)) { content() }
}

@Composable
private fun CardHeader(icon: ImageVector, title: String, body: String) {
    val colors = Hive.colors
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(colors.accent.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = colors.accent, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(Space.md))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            Text(title, style = HiveType.body, color = colors.text)
            if (body.isNotBlank()) Text(body, style = HiveType.secondary, color = colors.textDim)
        }
    }
}

@Composable
private fun PairedSection(vm: MainViewModel) {
    val colors = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    val state = when {
        link.syncing -> "Syncing…"
        link.live -> "Connected" + if (link.host.isNotBlank()) " · ${link.host}" else ""
        else -> "Not connected right now"
    }
    val dot by animateColorAsState(if (link.live) Color(0xFF7BE0A0) else colors.textDimmer, label = "dot")
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(colors.accent.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Computer, null, tint = colors.accent, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(Space.md))
        Column(Modifier.weight(1f)) {
            Text(link.serverName, style = HiveType.body, color = colors.text)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(dot))
                Spacer(Modifier.width(6.dp))
                Text(state, style = HiveType.secondary, color = colors.textDim)
            }
        }
    }
    val details = buildList {
        if (link.pcTracks > 0) add("%,d of your phone's songs matched to Hive's %,d".format(link.matchedTracks, link.pcTracks))
        if (link.pendingChanges > 0) add("${link.pendingChanges} changes waiting to sync")
        if (link.lastSyncAt > 0) add("Synced ${DateUtils.getRelativeTimeSpanString(link.lastSyncAt)}")
    }
    if (details.isNotEmpty()) {
        Column(Modifier.padding(top = Space.md), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
            details.forEach { Text(it, style = HiveType.secondary, color = colors.textDim) }
        }
    }
    Row(Modifier.padding(top = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        PrimaryPill(if (link.syncing) "Syncing…" else "Sync now", Icons.Rounded.Sync, { if (!link.syncing) vm.syncNow() })
        GlassPill("Unpair", null, { vm.unpair() })
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

    CardHeader(Icons.Rounded.Computer, "Pair with Hive", "Pair once and your Favorites stay in sync both ways. On the PC, open Hive's tray menu and choose “Pair phone…” for a code.")
    Row(Modifier.padding(top = Space.md), verticalAlignment = Alignment.CenterVertically) {
        GlassPill(if (discovering) "Looking on Wi-Fi…" else "Find Hive on Wi-Fi", Icons.Rounded.Wifi, { if (!discovering) vm.discover() })
        if (discovering) { Spacer(Modifier.width(Space.sm)); CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accent) }
    }
    found.forEach { hive ->
        val selected = host == hive.host
        Row(
            Modifier.fillMaxWidth().padding(top = Space.sm).clip(Radius.card)
                .background(if (selected) colors.accent.copy(alpha = 0.14f) else colors.text.copy(alpha = 0.04f))
                .pressable({ host = hive.host; port = hive.port.toString() }, 0.98f).padding(Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Computer, null, tint = if (selected) colors.accent else colors.textDim, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(Space.sm))
            Column {
                Text(hive.name, style = HiveType.body, color = colors.text)
                Text("${hive.host}:${hive.port}", style = HiveType.caption, color = colors.textDim)
            }
        }
    }
    Row(Modifier.padding(top = Space.md), horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
        Field(host, { host = it }, "PC address", KeyboardType.Uri, Modifier.weight(1f))
        Field(port, { port = it.filter(Char::isDigit) }, "Port", KeyboardType.Number, Modifier.width(96.dp))
    }
    CodeField(code) { code = it.filter(Char::isDigit).take(6) }
    error?.let { Text(it, style = HiveType.secondary, color = colors.accent, modifier = Modifier.padding(top = Space.xs)) }
    Row(Modifier.padding(top = Space.md).alpha(if (host.isNotBlank() && code.length == 6) 1f else 0.4f)) {
        PrimaryPill(if (busy) "Pairing…" else "Pair", null, {
            if (busy || host.isBlank() || code.length != 6) return@PrimaryPill
            busy = true; error = null
            scope.launch {
                error = vm.pair(host, port.toIntOrNull() ?: HiveLinkClient.DEFAULT_PORT, code)
                busy = false
            }
        })
    }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, type: KeyboardType, modifier: Modifier) {
    val colors = Hive.colors
    Column(modifier.clip(Radius.card).background(colors.text.copy(alpha = 0.05f)).padding(horizontal = Space.md, vertical = Space.sm)) {
        Text(label.uppercase(), style = HiveType.label.copy(fontSize = HiveType.label.fontSize * 0.9f), color = colors.textDimmer)
        BasicTextField(
            value, onChange, singleLine = true,
            textStyle = HiveType.body.copy(color = colors.text, fontWeight = FontWeight.Normal),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(keyboardType = type),
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
        )
    }
}

/** Six digit boxes, like a one-time code. */
@Composable
private fun CodeField(code: String, onChange: (String) -> Unit) {
    val colors = Hive.colors
    BasicTextField(
        code, onChange, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        cursorBrush = SolidColor(Color.Transparent),
        modifier = Modifier.fillMaxWidth().padding(top = Space.sm),
        decorationBox = {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                repeat(6) { i ->
                    val active = i == code.length
                    Box(
                        Modifier.weight(1f).height(52.dp).clip(Radius.card)
                            .background(if (active) colors.accent.copy(alpha = 0.14f) else colors.text.copy(alpha = 0.05f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(code.getOrNull(i)?.toString() ?: "", style = HiveType.headline.copy(letterSpacing = 0.em), color = colors.text)
                    }
                }
            }
        },
    )
}
