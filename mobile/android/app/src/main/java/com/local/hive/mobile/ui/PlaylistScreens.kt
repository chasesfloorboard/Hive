package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.HideImage
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.local.hive.mobile.ui.theme.Motion
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.PlaylistRow
import com.local.hive.mobile.data.PlaylistSummary
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.launch
import androidx.compose.material.icons.rounded.SaveAlt

val PlaylistRow.title: String get() = track?.title ?: stream?.title.orEmpty()
val PlaylistRow.artist: String get() = track?.artist ?: stream?.artist.orEmpty()
val PlaylistRow.art: Any? get() = track?.artworkUri ?: stream?.artworkUrl?.ifBlank { null }
val PlaylistRow.durationMs: Long get() = track?.durationMs ?: stream?.durationMs ?: 0

/**
 * A song from Apple Music or Spotify that isn't in the library, as any song
 * row, with a badge saying how it plays: in full (through Hive on the PC or
 * YouTube Music), or its preview.
 */
@Composable
fun StreamRow(stream: StreamTrack, playing: Boolean, isPlaying: Boolean, full: Boolean, onClick: () -> Unit, onRemove: (() -> Unit)? = null, number: Int? = null, vm: MainViewModel? = null) {
    val selection = LocalSelection.current
    val context = androidx.compose.ui.platform.LocalContext.current
    val toast = LocalToast.current
    val playable = full || stream.previewUrl.isNotBlank() || stream.key.startsWith("pc:")
    // With the view model, a streamed song shows its heart and offers what a library song's menu does.
    val likes = vm?.streamLikes?.collectAsStateWithLifecycle()
    val liked = likes?.value?.get(com.local.hive.mobile.link.StreamLoves.key(stream.artist, stream.title))?.loved == true
    var signIn by remember { mutableStateOf(false) }
    if (signIn) SoulseekSignInDialog(onDismiss = { signIn = false }, onSignedIn = { signIn = false; downloadStreams(context, listOf(stream), toast) })
    SongRow(
        stream.artworkUrl.ifBlank { null }, stream.title, listOf(stream.artist, stream.album).filter { it.isNotBlank() }.joinToString(" · "),
        playing, isPlaying, onClick, number = number, trailing = if (number != null && stream.durationMs > 0) formatDuration(stream.durationMs) else null,
        loved = liked,
        picked = selection != null && stream in selection, picking = selection?.active == true, onPick = selection?.let { s -> { s.toggle(stream) } },
        onHold = selection?.let { s -> { s.startTrackDrag(stream) } },
        enabled = playable,
        badge = if (full) null else { { StreamBadge(if (playable) "Preview" else "${stream.source} only") } },
        menu = if (vm == null && onRemove == null) null else { expanded, dismiss ->
            HiveMenu(expanded, dismiss) {
                if (vm != null) {
                    HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { dismiss(); vm.playNextStreams(listOf(stream)) }
                    HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { dismiss(); vm.addToQueueStreams(listOf(stream)) }
                    HiveMenuItem(if (liked) "Remove from Favorites" else "Add to Favorites", if (liked) Icons.Rounded.FavoriteBorder else Icons.Rounded.Favorite) { dismiss(); vm.setStreamLiked(stream, !liked) }
                    if (!stream.key.startsWith("pc:")) HiveMenuItem("Download", Icons.Rounded.Download) {
                        dismiss()
                        if (com.local.hive.mobile.soulseek.SoulseekSettings(context).configured) downloadStreams(context, listOf(stream), toast) else signIn = true
                    }
                }
                onRemove?.let { remove -> HiveMenuItem("Remove from playlist", Icons.Rounded.RemoveCircleOutline, destructive = true) { dismiss(); remove() } }
            }
        },
    )
}

/** A small tag on a streamed song: "Preview", "In library", "Apple Music only". */
@Composable
fun StreamBadge(label: String, accent: Boolean = false) {
    val c = Hive.colors
    Text(label.uppercase(), style = HiveText.label.copy(fontSize = 9.sp), color = if (accent) c.accent else c.textDim,
        modifier = Modifier.clip(RoundedCornerShape(5.dp)).border(1.dp, if (accent) c.accentSoft else c.border, RoundedCornerShape(5.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
}

/** A playlist's cover: its own image (imports), else the first song's album. */
fun playlistCover(p: PlaylistSummary): Any? = p.imageUrl.ifBlank { null } ?: p.coverAlbumId?.let { Uri.parse("content://media/external/audio/albumart/$it") } ?: p.streamArt?.ifBlank { null }

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
                // Favorites as a playlist: adding to it adds the songs to Favorites.
                item { LibraryRow(null, Icons.Rounded.Favorite, "Favorites", "") { vm.setLoved(tracks, true); onAdded("Favorites"); onDismiss() } }
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
    HiveDialog(onDismiss, spacing = 14.dp) {
            Text(title, style = HiveText.year, color = c.text)
            HiveField(name, { name = it }, "Playlist name", capitalization = KeyboardCapitalization.Sentences, focus = focus, onDone = { if (name.isNotBlank()) onConfirm(name) })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HiveButton("Cancel", onClick = onDismiss)
                HiveButton(confirm, primary = true, enabled = name.isNotBlank()) { onConfirm(name) }
            }
    }
}

/** A Hive dialog with a few labelled fields; the first must be filled. */
@Composable
fun FieldsDialog(title: String, placeholders: List<String>, confirm: String, onDismiss: () -> Unit, onConfirm: (List<String>) -> Unit) {
    val c = Hive.colors
    val values = remember { androidx.compose.runtime.mutableStateListOf(*Array(placeholders.size) { "" }) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    HiveDialog(onDismiss) {
            Text(title, style = HiveText.year, color = c.text)
            placeholders.forEachIndexed { i, hint ->
                HiveField(values[i], { values[i] = it }, hint, focus = if (i == 0) focus else null)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HiveButton("Cancel", onClick = onDismiss)
                HiveButton(confirm, primary = true, enabled = values[0].isNotBlank()) { onConfirm(values.toList()) }
            }
    }
}

/** A plain confirmation in Hive's dialog style. */
@Composable
fun ConfirmDialog(title: String, body: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val c = Hive.colors
    HiveDialog(onDismiss, spacing = 10.dp) {
            Text(title, style = HiveText.year, color = c.text)
            Text(body, style = HiveText.body, color = c.textDim)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                HiveButton("Cancel", onClick = onDismiss)
                HiveButton(confirm, primary = true, onClick = onConfirm)
            }
    }
}


/**
 * A playlist: its cover lit by its colours over Play / Shuffle, then the
 * songs in a glass panel. Edit shows handles to reorder and buttons to
 * remove; the order is saved when editing ends.
 */
@Composable
fun PlaylistScreen(vm: MainViewModel, id: Long, actions: TrackActions, bottomPadding: Dp, initialQuery: String = "", onBack: () -> Unit) {
    val c = Hive.colors
    val playlist by remember(id) { vm.playlist(id) }.collectAsStateWithLifecycle(null)
    val allRows by remember(id) { vm.playlistRows(id) }.collectAsStateWithLifecycle(emptyList())
    LaunchedEffect(allRows.size) { vm.fillSpotifyCovers(allRows) }
    // Slots whose library song has since gone from the phone are left out.
    val rows = remember(allRows) { allRows.filter { it.track != null || it.stream != null } }
    val summaries by vm.playlists.collectAsStateWithLifecycle()
    val summary = summaries.firstOrNull { it.id == id }
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    val colors by produceState<AuraColors?>(null, summary?.coverAlbumId) { value = summary?.coverAlbumId?.let { vm.albumColors(it) } }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    val veil by list.pageVeil()
    var editing by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val toast = LocalToast.current
    // The playlist's picture: a photo from the phone, copied into Hive's files.
    val photo = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null) vm.setPlaylistPhoto(id, uri) }
    val exporter = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.CreateDocument("audio/x-mpegurl")) { uri ->
        if (uri != null) scope.launch {
            val text = vm.m3uFor(id)
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) } }
        }
    }

    // While editing, a local order of slots, saved when done.
    val keys = remember(rows) { rows.map { it.entry.rowId.toString() } }
    val byKey = remember(rows) { rows.associateBy { it.entry.rowId.toString() } }
    var order by remember(keys) { mutableStateOf(keys) }
    var dragKey by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var rowPx by remember { mutableIntStateOf(1) }
    val rowHeight = 64.dp
    rowPx = with(LocalDensity.current) { rowHeight.roundToPx() }
    fun finishEditing() { editing = false; if (order != keys) vm.setPlaylistEntries(id, order.mapNotNull { byKey[it]?.entry }) }
    val shown = if (editing) order.mapNotNull { byKey[it] } else rows
    // Searching the playlist: its songs by title, artist or album. A found song plays the playlist from there.
    var query by rememberSaveable(id) { mutableStateOf(initialQuery) }
    val q = LibrarySort.words(query)
    val positions = remember(keys) { keys.withIndex().associate { it.value to it.index } }
    val listed = if (editing || q.isEmpty()) (if (editing) order else keys) else keys.filter { k -> byKey[k]?.let { r -> LibrarySort.matches(songText(r), q) } == true }
    val listedRows = listed.mapNotNull { byKey[it] }
    PickableList(tracks = listedRows.mapNotNull { it.track }, streams = listedRows.filter { it.track == null }.mapNotNull { it.stream })
    val search = rememberPullToReveal(keepShown = query.isNotEmpty())
    val name = playlist?.name.orEmpty()

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        // Hold a song and drag to pick the ones between (not while reordering).
        val dragRows = remember(listed, byKey, editing) { if (editing) emptyMap() else listed.mapNotNull { k -> byKey[k]?.let { r -> (r.track ?: r.stream)?.let { k as Any to (it as Any) } } }.toMap() }
        LazyColumn(Modifier.fillMaxSize().nestedScroll(search.connection).songDragSelect(list, dragRows, dragRows.values.toList()), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            item {
                Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Artwork(summary?.let(::playlistCover), Modifier.size(200.dp), HiveShape.art, Icons.AutoMirrored.Rounded.QueueMusic, glow = colors?.primary, elevation = 30.dp)
                    Text(name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 22.dp))
                    Text(
                        listOfNotNull(playlist?.source?.ifBlank { null }?.let { "From $it" }, countOf(rows.size, "track"), formatLength(rows.sumOf { it.durationMs })).joinToString(" · "),
                        style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 6.dp),
                    )
                    Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        ControlButton(HiveIcons.Shuffle, "Shuffle", { vm.playRows(rows, shuffle = true) }, size = 46.dp)
                        AccentPlayButton(false, { vm.playRows(rows) }, size = 58.dp)
                        ControlButton(if (editing) Icons.Rounded.Check else Icons.Rounded.Edit, if (editing) "Done editing" else "Edit playlist", { if (editing) finishEditing() else editing = true }, size = 46.dp, tint = if (editing) c.accent else null)
                    }
                }
            }
            // Hidden until the list is pulled down past its top.
            if (!editing && rows.isNotEmpty()) item {
                androidx.compose.animation.AnimatedVisibility(search.shown, enter = androidx.compose.animation.expandVertically(Motion.open()) + androidx.compose.animation.fadeIn(Motion.swap()),
                    exit = androidx.compose.animation.shrinkVertically(Motion.close()) + androidx.compose.animation.fadeOut(Motion.underFade())) {
                    SearchField(query, { query = it }, "Search this playlist", onSubmit = {}, onClear = { query = "" }, modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 10.dp))
                }
            }
            if (rows.isEmpty() && playlist != null) item { EmptyState("This playlist is empty", "Add songs from any song's ⋯ menu, or an album's.") }
            else if (listed.isEmpty()) item { EmptyState("No songs match", "Nothing in “$name” matches “${query.trim()}”.") }
            else {
                item { PanelTop() }
                itemsIndexed(listed, key = { _, k -> k }) { pos, k ->
                    val row = byKey[k] ?: return@itemsIndexed
                    // Its place in the playlist (what plays and what's removed), not in the search results.
                    val i = if (editing) pos else positions[k] ?: pos
                    val remove: () -> Unit = { vm.setPlaylistEntries(id, rows.filterIndexed { j, _ -> j != i }.map { it.entry }) }
                    PanelSlice {
                        if (!editing) {
                            val t = row.track
                            if (t != null) TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions.copy(onRemoveFromPlaylist = { remove() }), onClick = { vm.playRows(rows, i) })
                            else StreamRow(row.stream!!, now.mediaId == row.stream.key, now.isPlaying, full, onClick = { vm.playRows(rows, i) }, onRemove = remove, vm = vm)
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
                                    Icon(Icons.Rounded.RemoveCircleOutline, "Remove ${row.title}", tint = Color(0xFFFF8A8A), modifier = Modifier.size(21.dp))
                                }
                                Artwork(row.art, Modifier.size(40.dp))
                                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                                    Text(row.title, style = HiveText.row, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(row.artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                                ) { Icon(Icons.Rounded.DragHandle, "Drag ${row.title} to reorder", tint = if (lifted) c.accent else c.textDim, modifier = Modifier.size(22.dp)) }
                            }
                        }
                    }
                }
                item { PanelBottom() }
            }
        }
    }, overlay = {
        PageBar(name, titleAlpha, { if (editing) finishEditing(); onBack() }, veil) {
            Box {
                Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.MoreHoriz, "Playlist options", tint = c.text, modifier = Modifier.size(20.dp))
                }
                HiveMenu(menu, { menu = false }) {
                    HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { menu = false; vm.playNextRows(shown) }
                    HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; vm.addToQueueRows(shown) }
                    HiveMenuItem("Add to another playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { menu = false; actions.onAddToPlaylist(shown.mapNotNull { it.track }) }
                    HiveMenuDivider()
                    HiveMenuItem("Export as M3U", Icons.Rounded.SaveAlt) { menu = false; exporter.launch("$name.m3u8") }
                    HiveMenuItem("Rename", Icons.Rounded.Edit) { menu = false; renaming = true }
                    HiveMenuItem("Choose a photo", Icons.Rounded.Image) { menu = false; photo.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                    if (playlist?.imageUrl?.startsWith("file:") == true) HiveMenuItem("Remove photo", Icons.Rounded.HideImage) { menu = false; vm.setPlaylistPhoto(id, null) }
                    HiveMenuItem("Duplicate", Icons.Rounded.ContentCopy) { menu = false; vm.duplicatePlaylist(id) { toast("Made “$name copy”") } }
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

/**
 * Recently played: library songs and streamed ones (from the PC, Apple
 * Music, Spotify) alike, newest first; a song shows after a few seconds.
 */
@Composable
fun HistoryScreen(vm: MainViewModel, actions: TrackActions, bottomPadding: Dp, onBack: () -> Unit) {
    val all by vm.recentlyPlayed.collectAsStateWithLifecycle()
    // A library song since deleted from the phone is left out.
    val rows = remember(all) { all.filter { it.track != null || it.stream != null } }
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    PickableList(tracks = rows.mapNotNull { it.track }, streams = rows.filter { it.track == null }.mapNotNull { it.stream })
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        val historyList = androidx.compose.foundation.lazy.rememberLazyListState()
        val dragRows: Map<Any, Any> = remember(rows) { rows.mapNotNull { r -> (r.track ?: r.stream)?.let { (r.entry.streamKey.ifBlank { r.entry.trackId.toString() } as Any) to (it as Any) } }.toMap() }
        LazyColumn(Modifier.fillMaxSize().songDragSelect(historyList, dragRows, dragRows.values.toList()), state = historyList, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            item { PanelHeader("Recently played") }
            if (rows.isEmpty()) item { EmptyState("Nothing here yet", "Songs show here after a few seconds of listening.") }
            else {
                item { PanelTop() }
                itemsIndexed(rows, key = { _, r -> r.entry.streamKey.ifBlank { r.entry.trackId.toString() } }) { i, row ->
                    Box(Modifier.animateItem()) {
                        PanelSlice {
                            val t = row.track
                            if (t != null) TrackRow(t, t.id in loved, now.trackId == t.id, now.isPlaying, actions, onClick = { vm.playRows(rows, i) })
                            else StreamRow(row.stream!!, now.mediaId == row.stream.key, now.isPlaying, full, onClick = { vm.playRows(rows, i) }, vm = vm)
                        }
                    }
                }
                item { PanelBottom() }
            }
        }
    }
}

/** A playlist slot's title, artist and album, for searching it. */
internal fun songText(r: PlaylistRow) = r.track?.let { "${it.title} ${it.artist} ${it.album}" } ?: r.stream?.let { "${it.title} ${it.artist} ${it.album}" }.orEmpty()
