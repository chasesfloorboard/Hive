package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.scrollBy
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.QueueItem
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Each queue row: default is a ⋯ song menu; while selecting it becomes a 58dp-tall row's drag handle. */
private val QueueRow = 58.dp

/**
 * The queue inside Now Playing: tap to jump, the ⋯ menu for a song's actions
 * (Go to album, Love, Remove from queue…). Long-press a song to select; while
 * selecting, every row's ⋯ turns into a drag handle to reorder, and the bottom
 * bar acts on all the picked songs at once.
 */
@Composable
fun QueueList(
    vm: MainViewModel,
    modifier: Modifier,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
    onAddToPlaylist: (Track) -> Unit,
) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val tracks = now.queue
    val library by vm.tracks.collectAsStateWithLifecycle()
    val lovedIds by vm.lovedIds.collectAsStateWithLifecycle()
    // Stable row keys (song and occurrence), so a reordered queue coming back from the player doesn't flicker.
    val keys = remember(tracks) { val seen = HashMap<String, Int>(); tracks.map { t -> val n = seen.merge(t.mediaId, 1, Int::plus)!!; "${t.mediaId}#$n" } }
    var order by remember(keys) { mutableStateOf(keys) }
    var dragKey by remember { mutableStateOf<String?>(null) }
    var dragFrom by remember { mutableIntStateOf(-1) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    val rowPx = with(LocalDensity.current) { QueueRow.toPx() }
    val listState = rememberLazyListState()
    val edgeZone = with(LocalDensity.current) { 88.dp.toPx() }
    val maxStep = with(LocalDensity.current) { 18.dp.toPx() }
    LaunchedEffect(dragKey) {
        val k = dragKey ?: return@LaunchedEffect
        while (dragKey == k) {
            androidx.compose.runtime.withFrameNanos { }
            val info = listState.layoutInfo
            val vh = (info.viewportEndOffset - info.viewportStartOffset).toFloat()
            val me = info.visibleItemsInfo.firstOrNull { it.key == k } ?: continue
            val centerY = me.offset + dragOffset + me.size / 2f
            val delta = DragAutoScroll.computeEdgeScrollDelta(centerY, vh, edgeZone, maxStep, listState.canScrollBackward, listState.canScrollForward)
            if (delta != 0f) {
                val scrolled = listState.scrollBy(delta)
                dragOffset += scrolled
                val pos = order.indexOf(k)
                val target = when {
                    dragOffset > rowPx / 2f && pos in 0 until order.lastIndex -> pos + 1
                    dragOffset < -rowPx / 2f && pos > 0 -> pos - 1
                    else -> null
                }
                if (target != null) {
                    order = order.toMutableList().apply { add(target, removeAt(pos)) }
                    dragOffset -= (target - pos) * rowPx
                }
            }
        }
    }
    // The playing song is brought into view when the song changes, not when the queue is edited:
    // taking a song out leaves the list where it was.
    LaunchedEffect(now.mediaId) { if (now.queueIndex in tracks.indices) listState.scrollToItem((now.queueIndex - 2).coerceAtLeast(0)) }

    // Picking songs: hold one, then drag over the others (the list scrolls near its edges); taps add or remove.
    var picked by remember { mutableStateOf<Set<String>>(emptySet()) }
    var anchor by remember { mutableStateOf<String?>(null) }
    var pickedBefore by remember { mutableStateOf<Set<String>>(emptySet()) }
    // Songs that left the queue leave the selection too.
    LaunchedEffect(keys) { picked = picked.filterTo(HashSet()) { it in keys } }
    val picking = picked.isNotEmpty()
    androidx.activity.compose.BackHandler(enabled = picking) { picked = emptySet() }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    fun indicesOf(set: Set<String>) = set.mapNotNull { k -> keys.indexOf(k).takeIf { it >= 0 } }
    fun dragTo(k: String) {
        val from = order.indexOf(anchor ?: return)
        val to = order.indexOf(k)
        if (from < 0 || to < 0) return
        picked = pickedBefore + order.subList(minOf(from, to), maxOf(from, to) + 1)
    }
    val scope = rememberCoroutineScope()
    val edge = with(LocalDensity.current) { 64.dp.toPx() }
    fun keyAt(y: Float): String? {
        val info = listState.layoutInfo
        val at = y + info.viewportStartOffset
        return info.visibleItemsInfo.firstOrNull { at >= it.offset && at < it.offset + it.size }?.key as? String
    }

    Column(modifier) {
        LazyColumn(
            state = listState, contentPadding = PaddingValues(bottom = 20.dp),
            modifier = Modifier.weight(1f).pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false, pass = androidx.compose.ui.input.pointer.PointerEventPass.Initial)
                    var speed = 0f
                    var finger = 0f
                    var scroller: Job? = null
                    try {
                        while (true) {
                            val change = awaitPointerEvent(androidx.compose.ui.input.pointer.PointerEventPass.Initial).changes.firstOrNull() ?: break
                            if (!change.pressed) break
                            if (anchor == null) continue
                            // Picking, not scrolling: the list doesn't get this drag.
                            change.consume()
                            finger = change.position.y
                            keyAt(finger)?.let(::dragTo)
                            speed = when {
                                finger < edge -> -(edge - finger) / edge * 24f
                                finger > size.height - edge -> (finger - (size.height - edge)) / edge * 24f
                                else -> 0f
                            }
                            if (speed != 0f && scroller?.isActive != true) scroller = scope.launch {
                                while (speed != 0f) { listState.scrollBy(speed); keyAt(finger)?.let(::dragTo); androidx.compose.runtime.withFrameNanos { } }
                            }
                        }
                    } finally { speed = 0f; scroller?.cancel(); anchor = null }
                }
            },
        ) {
                itemsIndexed(order, key = { _, k -> k }) { _, k ->
                    val i = keys.indexOf(k)
                    val t = tracks[i]
                    val playing = i == now.queueIndex
                    val past = i < now.queueIndex
                    val lifted = dragKey == k
                    val isPicked = k in picked
                    Row(
                        Modifier.then(if (lifted) Modifier.zIndex(1f).graphicsLayer { translationY = dragOffset; scaleX = 1.02f; scaleY = 1.02f } else Modifier.animateItem())
                            .fillMaxWidth().padding(horizontal = 8.dp).height(QueueRow)
                            .then(if (lifted) Modifier.shadow(16.dp, HiveShape.row, ambientColor = c.accentGlow) else Modifier)
                            .clip(HiveShape.row)
                            .background(when { lifted -> c.control; isPicked -> c.accentSoft.copy(alpha = 0.45f); playing -> c.accentSoft.copy(alpha = 0.3f); else -> Color.Transparent })
                            .combinedClickable(
                                onClick = { if (picking) picked = if (isPicked) picked - k else picked + k else vm.player.skipToQueueIndex(i) },
                                onLongClick = {
                                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                                    pickedBefore = picked; anchor = k; picked = picked + k
                                },
                            )
                            .alpha(if (past && !lifted && !isPicked) 0.5f else 1f).padding(start = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(if (playing) c.accent else Color.Transparent))
                        Spacer(Modifier.width(8.dp))
                        Box(contentAlignment = Alignment.Center) {
                            // The playing song's row turns with the player's cover, as Hive's queue does on the PC.
                            val frame = if (playing) rotatingCover(t.artworkUri, t.trackId) else CoverFrame(t.artworkUri, null)
                            Artwork(frame.current, Modifier.size(40.dp).then(if (playing) Modifier.border(1.dp, c.accentSoft, HiveShape.thumb) else Modifier), replacing = frame.previous)
                            if (isPicked) Box(Modifier.size(40.dp).clip(HiveShape.thumb).background(c.accent.copy(alpha = 0.85f)), contentAlignment = Alignment.Center) {
                                Icon(Icons.Rounded.Check, "Picked", tint = readableOn(c.accent), modifier = Modifier.size(20.dp))
                            }
                        }
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(t.title, style = HiveText.row, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(t.artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (t.durationMs > 0) Text(formatDuration(t.durationMs), style = HiveText.numbers, color = c.textDimmer)
                        // Default: the ⋯ song menu. While selecting: a drag handle to reorder.
                        if (picking) {
                            // Drag the handle to move the song; neighbours make room as it passes half a row.
                            Box(
                                Modifier.size(44.dp).pointerInput(k) {
                                    detectDragGestures(
                                        onDragStart = { dragKey = k; dragFrom = order.indexOf(k); dragOffset = 0f },
                                        onDrag = { change, amount ->
                                            change.consume()
                                            dragOffset += amount.y
                                            val pos = order.indexOf(k)
                                            val target = when {
                                                dragOffset > rowPx / 2 && pos < order.lastIndex -> pos + 1
                                                dragOffset < -rowPx / 2 && pos > 0 -> pos - 1
                                                else -> null
                                            }
                                            if (target != null) {
                                                order = order.toMutableList().apply { add(target, removeAt(pos)) }
                                                dragOffset -= (target - pos) * rowPx
                                            }
                                        },
                                        onDragEnd = { val to = order.indexOf(k); if (to != dragFrom && dragFrom >= 0) vm.player.moveInQueue(dragFrom, to); dragKey = null; dragOffset = 0f },
                                        onDragCancel = { order = keys; dragKey = null; dragOffset = 0f },
                                    )
                                },
                                contentAlignment = Alignment.Center,
                            ) { Icon(Icons.Rounded.DragHandle, "Drag to reorder", tint = if (lifted) c.accent else c.textDimmer, modifier = Modifier.size(20.dp)) }
                        } else {
                            var menuOpen by remember { mutableStateOf(false) }
                            val track = library.firstOrNull { it.id == t.trackId }
                            Box {
                                Box(Modifier.size(width = 44.dp, height = 48.dp).clip(CircleShape).clickable { menuOpen = true }, contentAlignment = Alignment.Center) {
                                    Icon(Icons.Rounded.MoreVert, "More options", tint = c.textDimmer, modifier = Modifier.size(20.dp))
                                }
                                QueueRowMenu(
                                    expanded = menuOpen, onDismiss = { menuOpen = false },
                                    item = t, index = i, playing = playing,
                                    track = track, loved = track != null && track.id in lovedIds,
                                    onOpenAlbum = onOpenAlbum, onOpenArtist = onOpenArtist, onAddToPlaylist = onAddToPlaylist,
                                    vm = vm,
                                )
                            }
                        }
                    }
                }
        }
        // While picking: the actions at the bottom, as in the library: Select all, how many, Actions and ✕.
        androidx.compose.animation.AnimatedVisibility(picking, enter = androidx.compose.animation.slideInVertically { it } + androidx.compose.animation.fadeIn(), exit = androidx.compose.animation.slideOutVertically { it } + androidx.compose.animation.fadeOut()) {
            QueuePickBar(
                vm, picked.size, all = picked.size == keys.size,
                onToggleAll = { picked = if (picked.size == keys.size) emptySet() else keys.toSet() },
                onPlayNext = { vm.player.playNextFromQueue(indicesOf(picked)); picked = emptySet() },
                lovable = { indicesOf(picked).mapNotNull { tracks[it].trackId } },
                // The playing song stays (Select all, then Remove, clears the rest of the queue).
                onRemove = { vm.player.removeFromQueue(indicesOf(picked) - now.queueIndex); picked = emptySet() },
                onDone = { picked = emptySet() },
            )
        }
        // Taking songs out can be undone for a few seconds, as in a desktop app's Ctrl+Z.
        val undoable by vm.player.undoable.collectAsStateWithLifecycle()
        LaunchedEffect(undoable) { if (undoable > 0) { kotlinx.coroutines.delay(6_000); vm.player.forgetUndo() } }
        androidx.compose.animation.AnimatedVisibility(undoable > 0, enter = androidx.compose.animation.expandVertically() + androidx.compose.animation.fadeIn(), exit = androidx.compose.animation.shrinkVertically() + androidx.compose.animation.fadeOut()) {
            var shown by remember { mutableIntStateOf(1) }
            if (undoable > 0) shown = undoable
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp).clip(HiveShape.pill).background(c.accentSoft.copy(alpha = 0.35f)).padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (shown == 1) "Removed 1 song" else "Removed $shown songs", style = HiveText.rowStrong, color = c.text, modifier = Modifier.weight(1f))
                Text("Undo", style = HiveText.rowStrong, color = c.accent, modifier = Modifier.clip(HiveShape.pill).clickable { vm.player.undoRemove() }.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    }
}

/**
 * A queue row's ⋯ menu: the same song actions as a library row (Go to album,
 * Go to artist, Add to playlist, Love, Share) plus Remove from queue. For a
 * streamed or PC song not on the phone ([track] null), only Go to album/artist
 * (via [LocalStreamNav]) and Remove. The playing row can't be removed.
 */
@Composable
private fun QueueRowMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    item: QueueItem,
    index: Int,
    playing: Boolean,
    track: Track?,
    loved: Boolean,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
    onAddToPlaylist: (Track) -> Unit,
    vm: MainViewModel,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val streamNav = LocalStreamNav.current
    HiveMenu(expanded, onDismiss) {
        SongMenuHeader(item.artworkUri, item.title, item.artist)
        if (track != null) {
            SongMenuQuickRow {
                SongMenuQuick(if (loved) "Loved" else "Love", if (loved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, active = loved) { onDismiss(); vm.toggleLoved(track.id) }
                SongMenuQuick("Share", Icons.Rounded.Share) { onDismiss(); Share.tracks(context, listOf(track)) }
                SongMenuQuick("Playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { onDismiss(); onAddToPlaylist(track) }
            }
            HiveMenuItem("Go to album", Icons.Rounded.Album) { onDismiss(); onOpenAlbum(track) }
            HiveMenuItem("Go to artist", Icons.Rounded.Person) { onDismiss(); onOpenArtist(track) }
        } else {
            // A streamed (Apple Music / Spotify) or PC song that isn't on the phone.
            queueStream(item)?.let { stream ->
                HiveMenuItem("Go to album", Icons.Rounded.Album) { onDismiss(); streamNav.album(stream) }
                HiveMenuItem("Go to artist", Icons.Rounded.Person) { onDismiss(); streamNav.artist(stream) }
            }
        }
        // The playing song stays; everything else can leave the queue (with Undo).
        if (!playing) {
            HiveMenuDivider()
            HiveMenuItem("Remove from queue", Icons.Rounded.Close, destructive = true) { onDismiss(); vm.player.removeFromQueue(index) }
        }
    }
}

/** A streamed/PC queue item as a [StreamTrack] for "Go to album/artist"; null for a library or local song. */
private fun queueStream(item: QueueItem): StreamTrack? {
    val id = item.mediaId
    val streamed = id.startsWith("am:") || id.startsWith("sp:")
    val fromPc = id.startsWith(com.local.hive.mobile.link.PcLibrary.MEDIA_PREFIX)
    if (!streamed && !fromPc) return null
    return StreamTrack(id, if (id.startsWith("sp:")) "Spotify" else "Apple Music", item.title, item.artist, "", item.durationMs, item.artworkUri.orEmpty(), "", "")
}

/** The queue's picking bar: Select all (then Deselect all), how many are picked, Actions and ✕. */
@Composable
private fun QueuePickBar(vm: MainViewModel, n: Int, all: Boolean, onToggleAll: () -> Unit, onPlayNext: () -> Unit, lovable: () -> List<Long>, onRemove: () -> Unit, onDone: () -> Unit) {
    val c = Hive.colors
    var open by remember { mutableStateOf(false) }
    val library by vm.tracks.collectAsStateWithLifecycle()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).height(52.dp)
            .shadow(22.dp, HiveShape.pill, ambientColor = c.accentGlow).hiveGlass(HiveShape.pill, strength = 0.3f).padding(start = 6.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.height(44.dp).clip(HiveShape.pill).clickable(onClick = onToggleAll).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (all) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, null, tint = c.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (all) "Deselect all" else "Select all", style = HiveText.rowStrong, color = c.text)
        }
        Text(countOf(n, "song"), style = HiveText.rowSub, color = c.textDim, maxLines = 1, modifier = Modifier.weight(1f).padding(start = 4.dp))
        Box {
            Row(
                Modifier.height(40.dp).clip(HiveShape.pill).background(c.accent).clickable { open = true }.padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("Actions", style = HiveText.pill, color = readableOn(c.accent))
                Icon(Icons.Rounded.KeyboardArrowUp, null, tint = readableOn(c.accent), modifier = Modifier.size(18.dp))
            }
            HiveMenu(open, { open = false }, above = 40.dp) {
                HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { open = false; onPlayNext() }
                val ids = lovable()
                if (ids.isNotEmpty()) HiveMenuItem("Add to Favorites", Icons.Rounded.Favorite) {
                    open = false
                    val wanted = ids.toSet()
                    vm.setLoved(library.filter { it.id in wanted }, true)
                    onDone()
                }
                HiveMenuDivider()
                HiveMenuItem("Remove from queue", Icons.Rounded.Close, destructive = true) { open = false; onRemove() }
            }
        }
        Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onDone), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Close, "Stop picking", tint = c.textDim, modifier = Modifier.size(20.dp))
        }
    }
}
