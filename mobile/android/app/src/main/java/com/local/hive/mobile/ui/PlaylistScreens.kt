package com.local.hive.mobile.ui

import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.PlaylistSummary
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.hiveGlassBorder

/** A playlist's cover: its own image (imports), else the first song's album. */
fun playlistCover(p: PlaylistSummary): Any? = p.imageUrl.ifBlank { null } ?: p.coverAlbumId?.let { Uri.parse("content://media/external/audio/albumart/$it") }

/**
 * "Add to playlist": Hive's playlist picker as a sheet. New playlist first,
 * then the user's playlists, most recently changed at the top.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddToPlaylistSheet(vm: MainViewModel, tracks: List<Track>, onDismiss: () -> Unit, onAdded: (String) -> Unit) {
    val c = Hive.colors
    val playlists by vm.playlists.collectAsStateWithLifecycle()
    var naming by remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss, sheetState = sheet, containerColor = c.control, contentColor = c.text,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp), scrimColor = Color.Black.copy(alpha = 0.45f),
        dragHandle = { Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(36.dp, 4.dp).clip(HiveShape.pill).background(c.text.copy(alpha = 0.22f))) },
    ) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 8.dp)) {
            Text("Add to playlist", style = HiveText.viewTitle, color = c.text, modifier = Modifier.padding(start = 20.dp, top = 4.dp))
            Text(if (tracks.size == 1) tracks[0].title else countOf(tracks.size, "track"), style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 10.dp))
            LazyColumn(Modifier.heightIn(max = 460.dp)) {
                item { LibraryRow(null, Icons.Rounded.Add, "New playlist", "") { naming = true } }
                items(playlists, key = { it.id }) { p ->
                    LibraryRow(playlistCover(p), Icons.AutoMirrored.Rounded.QueueMusic, p.name, countOf(p.trackCount, "track")) {
                        vm.addToPlaylist(p.id, tracks); onAdded(p.name); onDismiss()
                    }
                }
            }
        }
    }
    if (naming) NameDialog("New playlist", "", "Create", onDismiss = { naming = false }) { name ->
        naming = false
        vm.createPlaylist(name, tracks); onAdded(name.trim().ifBlank { "New playlist" }); onDismiss()
    }
}

/** A small Hive dialog asking for a name. */
@Composable
fun NameDialog(title: String, initial: String, confirm: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val c = Hive.colors
    var name by remember { mutableStateOf(initial) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().shadow(30.dp, HiveShape.panel, ambientColor = c.accentGlow).clip(HiveShape.panel).background(c.control)
                .border(1.dp, hiveGlassBorder(), HiveShape.panel).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(title, style = HiveText.year, color = c.text)
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.bg.copy(alpha = 0.5f)).border(1.dp, c.border, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 12.dp)) {
                if (name.isEmpty()) Text("Playlist name", style = HiveText.row, color = c.textDimmer)
                BasicTextField(
                    name, { name = it }, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (name.isNotBlank()) onConfirm(name) }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                DialogButton("Cancel", false, true, onDismiss)
                DialogButton(confirm, true, name.isNotBlank()) { onConfirm(name) }
            }
        }
    }
}

/** A plain confirmation in Hive's dialog style. */
@Composable
fun ConfirmDialog(title: String, body: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val c = Hive.colors
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().shadow(30.dp, HiveShape.panel, ambientColor = c.accentGlow).clip(HiveShape.panel).background(c.control)
                .border(1.dp, hiveGlassBorder(), HiveShape.panel).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = HiveText.year, color = c.text)
            Text(body, style = HiveText.body, color = c.textDim)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                DialogButton("Cancel", false, true, onDismiss)
                DialogButton(confirm, true, true, onConfirm)
            }
        }
    }
}

@Composable
private fun DialogButton(label: String, primary: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = Hive.colors
    Box(
        Modifier.height(40.dp).clip(RoundedCornerShape(12.dp)).background(if (primary) c.accent.copy(alpha = if (enabled) 1f else 0.45f) else Color.Transparent)
            .border(1.dp, if (primary) Color.Transparent else c.border, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveText.pill, color = if (primary) readableOn(c.accent) else c.text) }
}

/**
 * A playlist: its cover lit by its colours over Play / Shuffle, then the
 * songs in a glass panel. Edit shows handles to reorder and buttons to
 * remove; the order is saved when editing ends.
 */
@Composable
fun PlaylistScreen(vm: MainViewModel, id: Long, actions: TrackActions, bottomPadding: Dp, onBack: () -> Unit) {
    val c = Hive.colors
    val playlist by remember(id) { vm.playlist(id) }.collectAsStateWithLifecycle(null)
    val tracks by remember(id) { vm.playlistTracks(id) }.collectAsStateWithLifecycle(emptyList())
    val summaries by vm.playlists.collectAsStateWithLifecycle()
    val summary = summaries.firstOrNull { it.id == id }
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val colors by produceState<AuraColors?>(null, summary?.coverAlbumId) { value = summary?.coverAlbumId?.let { vm.albumColors(it) } }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    var editing by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    // While editing, a local order: rows keyed by song and occurrence, saved when done.
    val keys = remember(tracks) { val seen = HashMap<Long, Int>(); tracks.map { t -> "${t.id}#${seen.merge(t.id, 1, Int::plus)}" } }
    val byKey = remember(keys) { keys.zip(tracks).toMap() }
    var order by remember(keys) { mutableStateOf(keys) }
    var dragKey by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var rowPx by remember { mutableIntStateOf(1) }
    val rowHeight = 64.dp
    rowPx = with(LocalDensity.current) { rowHeight.roundToPx() }
    fun finishEditing() { editing = false; if (order != keys) vm.setPlaylistOrder(id, order.mapNotNull { byKey[it] }) }
    val shown = if (editing) order.mapNotNull { byKey[it] } else tracks
    val name = playlist?.name.orEmpty()

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            item {
                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Artwork(summary?.let(::playlistCover), Modifier.size(200.dp), HiveShape.art, Icons.AutoMirrored.Rounded.QueueMusic, glow = colors?.primary, elevation = 30.dp)
                    Text(name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 22.dp))
                    Text(
                        listOfNotNull(playlist?.source?.ifBlank { null }?.let { "From $it" }, countOf(tracks.size, "track"), formatLength(tracks.sumOf { it.durationMs })).joinToString(" · "),
                        style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 6.dp),
                    )
                    Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        ControlButton(Icons.Rounded.Shuffle, "Shuffle", { vm.shuffle(tracks) }, size = 46.dp)
                        AccentPlayButton(false, { vm.play(tracks) }, size = 58.dp)
                        ControlButton(if (editing) Icons.Rounded.Check else Icons.Rounded.Edit, if (editing) "Done editing" else "Edit playlist", { if (editing) finishEditing() else editing = true }, size = 46.dp, tint = if (editing) c.accent else null)
                    }
                }
            }
            if (tracks.isEmpty() && playlist != null) item { EmptyState("This playlist is empty", "Add songs from any song's ⋯ menu, or an album's.") }
            else {
                item { PanelTop() }
                itemsIndexed(if (editing) order else keys, key = { _, k -> k }) { i, k ->
                    val t = byKey[k] ?: return@itemsIndexed
                    PanelSlice {
                        if (!editing) {
                            TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions.copy(onRemoveFromPlaylist = { vm.setPlaylistOrder(id, tracks.filterIndexed { j, _ -> j != i }) }), onClick = { vm.play(tracks, i) })
                        } else {
                            val lifted = dragKey == k
                            Row(
                                Modifier.then(if (lifted) Modifier.zIndex(1f).graphicsLayer { translationY = dragOffset; scaleX = 1.02f; scaleY = 1.02f } else Modifier.animateItem())
                                    .fillMaxWidth().height(rowHeight).padding(horizontal = 8.dp)
                                    .then(if (lifted) Modifier.shadow(16.dp, HiveShape.row, ambientColor = c.accentGlow) else Modifier)
                                    .clip(HiveShape.row).background(if (lifted) c.control else Color.Transparent),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(Modifier.size(44.dp).clip(CircleShape).clickable { order = order - k }, contentAlignment = Alignment.Center) {
                                    Icon(Icons.Rounded.RemoveCircleOutline, "Remove ${t.title}", tint = Color(0xFFFF8A8A), modifier = Modifier.size(21.dp))
                                }
                                Artwork(t.artworkUri, Modifier.size(40.dp))
                                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                                    Text(t.title, style = HiveText.row, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(t.artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                Box(
                                    Modifier.size(48.dp).pointerInput(k) {
                                        detectDragGestures(
                                            onDragStart = { dragKey = k; dragOffset = 0f },
                                            onDrag = { change, amount ->
                                                change.consume()
                                                dragOffset += amount.y
                                                val pos = order.indexOf(k)
                                                val target = when {
                                                    dragOffset > rowPx / 2f && pos < order.lastIndex -> pos + 1
                                                    dragOffset < -rowPx / 2f && pos > 0 -> pos - 1
                                                    else -> null
                                                }
                                                if (target != null) {
                                                    order = order.toMutableList().apply { add(target, removeAt(pos)) }
                                                    dragOffset -= (target - pos) * rowPx
                                                }
                                            },
                                            onDragEnd = { dragKey = null; dragOffset = 0f },
                                            onDragCancel = { dragKey = null; dragOffset = 0f },
                                        )
                                    },
                                    contentAlignment = Alignment.Center,
                                ) { Icon(Icons.Rounded.DragHandle, "Drag ${t.title} to reorder", tint = if (lifted) c.accent else c.textDim, modifier = Modifier.size(22.dp)) }
                            }
                        }
                    }
                }
                item { PanelBottom() }
            }
        }
    }, overlay = {
        PageBar(name, titleAlpha, { if (editing) finishEditing(); onBack() }) {
            Box {
                Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.MoreHoriz, "Playlist options", tint = c.text, modifier = Modifier.size(20.dp))
                }
                HiveMenu(menu, { menu = false }) {
                    HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { menu = false; vm.playNext(shown) }
                    HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; vm.addToQueue(shown) }
                    HiveMenuItem("Add to another playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { menu = false; actions.onAddToPlaylist(shown) }
                    HiveMenuDivider()
                    HiveMenuItem("Rename", Icons.Rounded.Edit) { menu = false; renaming = true }
                    HiveMenuItem("Delete playlist", Icons.Rounded.Delete, destructive = true) { menu = false; deleting = true }
                }
            }
        }
    })
    if (renaming) NameDialog("Rename playlist", name, "Rename", onDismiss = { renaming = false }) { vm.renamePlaylist(id, it); renaming = false }
    if (deleting) ConfirmDialog("Delete “$name”?", "The playlist goes; the songs stay in your library.", "Delete", onDismiss = { deleting = false }) {
        deleting = false; vm.deletePlaylist(id); onBack()
    }
}
