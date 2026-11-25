package com.local.hive.mobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.PluginGallery
import com.local.hive.mobile.data.PluginStore
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass

/** Settings › Plugins & Store page (installed plugins + Verified & Community/Untested Store + Submit). */
fun LazyListScope.pluginsAndStorePage(
    vm: MainViewModel,
    onOpenPlugin: (String) -> Unit,
    onToast: (String) -> Unit,
) {
    item { PluginsAndStoreBody(vm, onOpenPlugin, onToast) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PluginsAndStoreBody(
    vm: MainViewModel,
    onOpenPlugin: (String) -> Unit,
    onToast: (String) -> Unit,
) {
    val context = LocalContext.current
    val c = Hive.colors
    val installed by vm.plugins.installed.collectAsStateWithLifecycle()
    val installedById = remember(installed) { installed.associateBy { it.plugin.id } }

    var catalog by remember { mutableStateOf<PluginGallery.CatalogResult?>(null) }
    LaunchedEffect(Unit) {
        catalog = PluginGallery.load(context, com.local.hive.mobile.data.defaultHttp())
    }

    var tierIdx by remember { mutableIntStateOf(0) } // 0 = Verified, 1 = Community (Untested)
    var pendingInstall by remember { mutableStateOf<PluginGallery.StorePlugin?>(null) }
    var editingSettings by remember { mutableStateOf<PluginStore.InstalledPlugin?>(null) }
    var submitting by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // ---- Installed plugins ----
        Section("Installed", "Every plugin runs inside Hive's zero-network sandbox with only its declared permissions.") {
            if (installed.isEmpty()) {
                Text(
                    "No plugins installed yet. Pick one from the Plugin Store below.",
                    style = HiveText.small,
                    color = c.textDim,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
                )
            } else {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    installed.forEach { item ->
                        val p = item.plugin
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(14.dp))
                                .background(c.control)
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Box(
                                    Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(c.accent.copy(alpha = 0.16f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(p.icon, style = HiveText.rowStrong, color = c.accent)
                                }
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(p.name, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        TierBadge(verified = p.verified)
                                        Text(
                                            "v${p.version} · ${p.author.ifBlank { "Community" }}",
                                            style = HiveText.small,
                                            color = c.textDim,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.weight(1f),
                                        )
                                    }
                                }
                                HiveToggle(listOf("Off", "On"), if (item.enabled) 1 else 0, { i ->
                                    vm.plugins.setEnabled(p.id, i == 1)
                                })
                            }
                            if (p.description.isNotBlank()) {
                                Text(p.description, style = HiveText.small, color = c.textDim)
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (item.enabled && "ui.view" in p.permissions) {
                                    HiveButton("Open", primary = true) { onOpenPlugin(p.id) }
                                }
                                if (p.settings.isNotEmpty()) {
                                    HiveButton("Settings") { editingSettings = item }
                                }
                                if (!p.builtin) {
                                    HiveButton("Remove") {
                                        vm.plugins.remove(p.id)
                                        onToast("Removed ${p.name}")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---- Plugin Store (Verified + Community/Untested) ----
        Section("Plugin Store", "Browse verified plugins or untested community uploads.") {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                HiveToggle(listOf("Verified", "Community (Untested)"), tierIdx, { tierIdx = it }, Modifier.fillMaxWidth())

                if (tierIdx == 1) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0x24F59E0B))
                            .border(1.dp, Color(0x66F59E0B), RoundedCornerShape(12.dp))
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(Icons.Rounded.WarningAmber, null, tint = Color(0xFFFBBF24), modifier = Modifier.size(20.dp))
                        Text(
                            "Untested community section: plugins here are submitted by users and have NOT been audited by Hive. They still run inside Hive's zero-network sandbox, and permissions are shown before install.",
                            style = HiveText.small,
                            color = c.text,
                        )
                    }
                }

                val cat = catalog
                if (cat == null) {
                    Busy("Loading Plugin Store…")
                } else {
                    val items = if (tierIdx == 0) cat.verified else cat.community
                    Text(
                        if (cat.online) "${items.size} plugin${if (items.size == 1) "" else "s"} in this section"
                        else "Offline catalog · ${items.size} plugin${if (items.size == 1) "" else "s"}",
                        style = HiveText.small,
                        color = c.textDim,
                    )
                    if (items.isEmpty()) {
                        Text("Nothing listed in this section yet.", style = HiveText.small, color = c.textDim)
                    }
                    items.forEach { sp ->
                        val have = installedById[sp.id]
                        val sameVersion = have != null && have.plugin.version == sp.version
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(14.dp))
                                .background(c.control)
                                .then(if (!sp.verified) Modifier.border(1.dp, Color(0x40F59E0B), RoundedCornerShape(14.dp)) else Modifier)
                                .padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Box(
                                    Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(c.accent.copy(alpha = 0.16f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(sp.icon, style = HiveText.rowStrong, color = c.accent)
                                }
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(sp.name, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        TierBadge(verified = sp.verified)
                                        Text(
                                            "v${sp.version} · by ${sp.author.ifBlank { "Community" }}",
                                            style = HiveText.small,
                                            color = c.textDim,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.weight(1f),
                                        )
                                    }
                                }
                            }
                            if (sp.description.isNotBlank()) {
                                Text(sp.description, style = HiveText.small, color = c.textDim)
                            }
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                val perms = sp.permissions.ifEmpty { listOf("No special permissions") }
                                perms.forEach { perm ->
                                    Text(
                                        PluginGallery.permissionLabel(perm),
                                        style = HiveText.small,
                                        color = c.textDim,
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(c.text.copy(alpha = 0.08f))
                                            .padding(horizontal = 8.dp, vertical = 3.dp),
                                    )
                                }
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                HiveButton(
                                    when {
                                        sameVersion && have?.enabled == true -> "Installed"
                                        sameVersion -> "Enable"
                                        have != null -> "Update"
                                        sp.verified -> "Install"
                                        else -> "Install (Untested)"
                                    },
                                    primary = !sameVersion || have?.enabled != true,
                                    enabled = !(sameVersion && have?.enabled == true),
                                ) {
                                    if (sameVersion) {
                                        vm.plugins.setEnabled(sp.id, true)
                                        onToast("Enabled ${sp.name}")
                                    } else {
                                        pendingInstall = sp
                                    }
                                }
                                if (have != null && have.enabled && "ui.view" in sp.permissions) {
                                    HiveButton("Open") { onOpenPlugin(sp.id) }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---- Submit your own plugin ----
        Section("Share a plugin", "Submit a Hive API v2 plugin for verification, or upload it to the untested Community section.") {
            SettingRow("Submit your plugin", "Opens a pre-filled GitHub submission for Verified review or Community (Untested).") {
                HiveButton("Submit…", primary = true) { submitting = true }
            }
        }
    }

    pendingInstall?.let { sp ->
        PluginInstallConfirmDialog(
            plugin = sp,
            onDismiss = { pendingInstall = null },
            onConfirm = {
                vm.plugins.install(sp)
                pendingInstall = null
                onToast("Installed ${sp.name}")
            },
        )
    }

    editingSettings?.let { item ->
        val fresh = installedById[item.plugin.id] ?: item
        PluginSettingsDialog(vm, fresh) { editingSettings = null }
    }

    if (submitting) {
        SubmitPluginDialog(onToast = onToast) { submitting = false }
    }
}

@Composable
private fun TierBadge(verified: Boolean) {
    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (verified) Color(0x2834D399) else Color(0x28F59E0B))
            .padding(horizontal = 7.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(
            if (verified) Icons.Rounded.Shield else Icons.Rounded.WarningAmber,
            null,
            tint = if (verified) Color(0xFF6EE7B7) else Color(0xFFFBBF24),
            modifier = Modifier.size(12.dp),
        )
        Text(
            if (verified) "Verified" else "Untested",
            style = HiveText.small.copy(fontWeight = FontWeight.SemiBold),
            color = if (verified) Color(0xFF6EE7B7) else Color(0xFFFBBF24),
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun PluginInstallConfirmDialog(
    plugin: PluginGallery.StorePlugin,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val c = Hive.colors
    HiveDialog(onDismiss, spacing = 10.dp) {
        Text(
            if (plugin.verified) "Install ${plugin.name}?" else "Install untested plugin?",
            style = HiveText.year,
            color = c.text,
        )
        Text(
            if (plugin.verified) {
                "Verified plugin by ${plugin.author.ifBlank { "Hive" }}. Runs in Hive's zero-network sandbox with only the permissions below."
            } else {
                "WARNING: “${plugin.name}” is in the Community / Untested section and has NOT been audited by Hive. It runs inside Hive's zero-network sandbox (no files, no internet), but install only if you trust the author."
            },
            style = HiveText.body,
            color = if (plugin.verified) c.textDim else Color(0xFFFCD34D),
        )
        Text(
            "Permissions: " + (plugin.permissions.map(PluginGallery::permissionLabel).ifEmpty { listOf("None") }.joinToString(", ")),
            style = HiveText.small,
            color = c.textDim,
        )
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HiveButton("Cancel", onClick = onDismiss)
            HiveButton(if (plugin.verified) "Install" else "Install anyway", primary = true, onClick = onConfirm)
        }
    }
}

@Composable
internal fun PluginSettingsDialog(
    vm: MainViewModel,
    entry: PluginStore.InstalledPlugin,
    onDismiss: () -> Unit,
) {
    val c = Hive.colors
    val plugin = entry.plugin
    HiveDialog(onDismiss, spacing = 10.dp) {
        Text("${plugin.name} settings", style = HiveText.year, color = c.text)
        plugin.settings.forEach { def ->
            val current = entry.settings[def.id]
            when (def.type) {
                "boolean" -> {
                    val on = current?.toBooleanStrictOrNull() ?: (def.defaultBool ?: false)
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(def.label, style = HiveText.rowStrong, color = c.text)
                            if (def.description.isNotBlank()) Text(def.description, style = HiveText.small, color = c.textDim)
                        }
                        HiveToggle(listOf("Off", "On"), if (on) 1 else 0, { i ->
                            vm.plugins.updateSettings(plugin.id, mapOf(def.id to (i == 1).toString()))
                        })
                    }
                }
                "number" -> {
                    val min = (def.min ?: 0.0).toFloat()
                    val max = (def.max ?: 100.0).toFloat().coerceAtLeast(min + 1f)
                    val value = (current?.toFloatOrNull() ?: (def.defaultNum ?: min.toDouble()).toFloat()).coerceIn(min, max)
                    Column(Modifier.fillMaxWidth()) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(def.label, style = HiveText.rowStrong, color = c.text)
                            Text(value.toInt().toString(), style = HiveText.numbers, color = c.accent)
                        }
                        if (def.description.isNotBlank()) Text(def.description, style = HiveText.small, color = c.textDim)
                        Slider(
                            value = value,
                            onValueChange = { v ->
                                val step = (def.step ?: 1.0).toFloat().coerceAtLeast(1f)
                                val snapped = (kotlin.math.round(v / step) * step).coerceIn(min, max)
                                vm.plugins.updateSettings(plugin.id, mapOf(def.id to snapped.toInt().toString()))
                            },
                            valueRange = min..max,
                            colors = SliderDefaults.colors(thumbColor = c.accent, activeTrackColor = c.accent),
                        )
                    }
                }
                else -> {
                    var draft by remember(def.id, current) { mutableStateOf(current ?: def.defaultStr.orEmpty()) }
                    HiveField(draft, {
                        draft = it
                        vm.plugins.updateSettings(plugin.id, mapOf(def.id to it))
                    }, def.label)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.End) {
            HiveButton("Done", primary = true, onClick = onDismiss)
        }
    }
}

@Composable
private fun SubmitPluginDialog(onToast: (String) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val c = Hive.colors
    var targetIdx by remember { mutableIntStateOf(0) } // 0 = Verified review, 1 = Community (Untested)
    var name by remember { mutableStateOf("") }
    var author by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var jsCode by remember { mutableStateOf("return (async function(Hive) {\n  Hive.ui.registerView({ id: 'main', title: 'My Plugin', mount(host) { host.textContent = 'Hello Hive!'; } });\n})(Hive);") }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { com.local.hive.mobile.data.ThemeGallery.loadBlocked(context) }

    HiveDialog(onDismiss, spacing = 10.dp) {
        Text("Submit a plugin", style = HiveText.year, color = c.text)
        HiveToggle(listOf("Verified review", "Community (Untested)"), targetIdx, { targetIdx = it }, Modifier.fillMaxWidth())
        Text(
            if (targetIdx == 0) "Maintainers review your code and apply the approved label to publish it to the Verified store."
            else "Targets the Community / Untested section (still zero-network sandboxed, marked untested until reviewed).",
            style = HiveText.small,
            color = c.textDim,
        )
        HiveField(name, { name = it; error = null }, "Plugin name")
        HiveField(author, { author = it; error = null }, "Author name")
        HiveField(description, { description = it; error = null }, "Short description")
        HiveField(jsCode, { jsCode = it; error = null }, "plugin.js (Hive API v2)")
        error?.let { Text(it, style = HiveText.small, color = Color(0xFFFF8A8A)) }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HiveButton("Cancel", onClick = onDismiss)
            HiveButton("Open GitHub form", primary = true, enabled = name.isNotBlank() && jsCode.isNotBlank()) {
                val id = "community." + name.trim().lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "plugin" }
                runCatching {
                    PluginGallery.submitUrl(
                        id = id,
                        name = name.trim(),
                        author = author.trim(),
                        description = description.trim(),
                        permissions = listOf("player.read", "ui.view", "settings"),
                        js = jsCode,
                        css = "",
                        target = if (targetIdx == 0) "verified" else "community",
                    )
                }.onSuccess { (url, jsonPayload) ->
                    val clip = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    clip?.setPrimaryClip(ClipData.newPlainText("Hive plugin JSON", jsonPayload))
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                    onToast("Plugin JSON copied & submission opened")
                    onDismiss()
                }.onFailure { error = it.message }
            }
        }
    }
}
