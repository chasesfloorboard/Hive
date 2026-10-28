package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.SmartField
import com.local.hive.mobile.data.SmartOp
import com.local.hive.mobile.data.SmartPlaylist
import com.local.hive.mobile.data.SmartRule
import com.local.hive.mobile.data.SmartSort
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.mix

/** A smart playlist's page: its songs as they are now, with Edit and Delete in ⋯. */
@Composable
fun SmartPlaylistScreen(vm: MainViewModel, id: Long, actions: TrackActions, bottomPadding: Dp, onBack: () -> Unit) {
    val all by vm.smartPlaylists.collectAsStateWithLifecycle()
    val playlist = all.firstOrNull { it.id == id }
    var editing by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val flow = remember(id) { vm.smartTracks(id) }
    SongsScreen(vm, playlist?.name ?: "", flow, actions, bottomPadding, extraMenu = { close ->
        HiveMenuItem("Edit smart playlist", Icons.Rounded.Edit) { close(); editing = true }
        HiveMenuItem("Delete smart playlist", Icons.Rounded.Delete, destructive = true) { close(); deleting = true }
    }, onBack = onBack)
    if (editing && playlist != null) SmartPlaylistDialog(vm, playlist, onDismiss = { editing = false }) { editing = false }
    if (deleting && playlist != null) ConfirmDialog("Delete “${playlist.name}”?", "Only the playlist goes; the songs stay in your library.", "Delete", onDismiss = { deleting = false }) {
        deleting = false; vm.deleteSmartPlaylist(id); onBack()
    }
}

/**
 * Making or changing a smart playlist: rules such as "Genre contains house"
 * and "Added in the last 30 days", all or any of them, a sort and a limit.
 * How many songs match shows as the rules change.
 */
@Composable
fun SmartPlaylistDialog(vm: MainViewModel, existing: SmartPlaylist?, onDismiss: () -> Unit, onSaved: (Long) -> Unit) {
    val c = Hive.colors
    var name by remember { mutableStateOf(existing?.name ?: "") }
    val rules = remember { mutableStateListOf<SmartRule>().apply { addAll(existing?.rules ?: listOf(SmartRule(SmartField.Genre, SmartOp.Contains, ""))) } }
    var matchAll by remember { mutableStateOf(existing?.matchAll ?: true) }
    var sort by remember { mutableStateOf(existing?.sort ?: SmartSort.Artist) }
    var limit by remember { mutableStateOf(existing?.limit?.takeIf { it > 0 }?.toString() ?: "") }
    val id = remember { existing?.id ?: System.currentTimeMillis() }
    val draft = SmartPlaylist(id, name.trim(), rules.toList(), matchAll, sort, limit.toIntOrNull() ?: 0)

    // How many songs the rules pick, worked out as they change.
    val library by vm.tracks.collectAsStateWithLifecycle()
    val ratings by vm.ratings.collectAsStateWithLifecycle()
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val count by rememberComputed(-1, draft, library, ratings, loved) { draft.select(library, emptyMap(), ratings, loved).size }

    HiveDialog(onDismiss, wide = true, spacing = 10.dp) {
        Text(if (existing == null) "New smart playlist" else "Edit smart playlist", style = HiveText.year, color = c.text)
        HiveField(name, { name = it }, "Name", capitalization = KeyboardCapitalization.Sentences)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Songs that match", style = HiveText.body, color = c.text, modifier = Modifier.weight(1f))
            HiveToggle(listOf("All rules", "Any rule"), if (matchAll) 0 else 1, { matchAll = it == 0 })
        }
        rules.forEachIndexed { i, rule -> RuleRow(rule, onChange = { rules[i] = it }, onRemove = if (rules.size > 1) ({ rules.removeAt(i) }) else null) }
        Text("Add a rule", style = HiveText.rowStrong, color = c.accent, modifier = Modifier.clip(HiveShape.pill).clickable { rules += SmartRule(SmartField.Artist, SmartOp.Contains, "") }.padding(vertical = 8.dp, horizontal = 4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Picker("Sort", sort.label, SmartSort.entries.map { it.label }, Modifier.weight(1f)) { sort = SmartSort.entries[it] }
            HiveField(limit, { limit = it.filter(Char::isDigit).take(5) }, "Limit", Modifier.width(130.dp), type = KeyboardType.Number)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (count < 0) "" else if (count == 1) "1 song matches now" else countOf(count, "song") + " match now", style = HiveText.small, color = c.textDim, modifier = Modifier.weight(1f))
            HiveButton("Cancel") { onDismiss() }
            Box(Modifier.width(8.dp))
            HiveButton("Save", primary = true, enabled = name.isNotBlank()) { vm.saveSmartPlaylist(draft); onSaved(draft.id) }
        }
    }
}

/** One rule: what to look at, how, and the value (none for yes/no rules). */
@Composable
private fun RuleRow(rule: SmartRule, onChange: (SmartRule) -> Unit, onRemove: (() -> Unit)?) {
    val c = Hive.colors
    Column(Modifier.fillMaxWidth().clip(HiveShape.row).background(mix(c.accent, c.panelStrong, 0.04f)).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Picker("", rule.field.label, SmartField.entries.map { it.label }, Modifier.weight(1f)) { i ->
                val f = SmartField.entries[i]
                onChange(SmartRule(f, if (rule.op in f.ops) rule.op else f.ops.first(), if (f.kind == rule.field.kind) rule.value else ""))
            }
            Picker("", rule.op.label, rule.field.ops.map { it.label }, Modifier.weight(1f)) { onChange(rule.copy(op = rule.field.ops[it])) }
            if (onRemove != null) Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onRemove), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Close, "Remove rule", tint = c.textDim, modifier = Modifier.size(18.dp))
            }
        }
        if (rule.field.kind != SmartField.Kind.Flag) {
            val number = rule.field.kind != SmartField.Kind.Text
            HiveField(rule.value, { onChange(rule.copy(value = if (number) it.filter { ch -> ch.isDigit() || ch == '.' } else it)) },
                when (rule.field.kind) { SmartField.Kind.Days -> "Days"; SmartField.Kind.Number -> if (rule.field == SmartField.Rating) "Stars (0 to 5)" else "Number"; else -> "Text" },
                type = if (number) KeyboardType.Decimal else KeyboardType.Text)
        }
    }
}

/** A value picked from a short list: the current one as a pill, the list in Hive's menu. */
@Composable
private fun Picker(label: String, current: String, options: List<String>, modifier: Modifier = Modifier, onPick: (Int) -> Unit) {
    val c = Hive.colors
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        Column(Modifier.fillMaxWidth().clip(HiveShape.row).background(mix(c.accent, c.panelStrong, 0.08f)).clickable { open = true }.padding(horizontal = 12.dp, vertical = 8.dp)) {
            if (label.isNotEmpty()) HiveLabel(label)
            Text(current, style = HiveText.body, color = c.text, maxLines = 1, modifier = Modifier.height(22.dp))
        }
        HiveMenu(open, { open = false }) {
            options.forEachIndexed { i, o -> HiveMenuItem(o, if (o == current) Icons.Rounded.Check else null) { open = false; onPick(i) } }
        }
    }
}

/** "New smart playlist" as a row, for the Playlists tab. */
@Composable
fun NewSmartPlaylistRow(onClick: () -> Unit) = LibraryRow(null, Icons.Rounded.Add, "New smart playlist", "Fills itself by rules: genre, rating, plays, when added…", onClick = onClick)
