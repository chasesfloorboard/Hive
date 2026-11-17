package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.launch

/** Tells Select all what this list holds, while it's on screen. */
@Composable
fun PickableList(tracks: List<Track> = emptyList(), albums: List<Long> = emptyList(), streams: List<StreamTrack> = emptyList()) {
    val selection = LocalSelection.current ?: return
    androidx.compose.runtime.DisposableEffect(selection, tracks, albums, streams) {
        val scope = Selection.Scope(tracks, albums, streams)
        selection.register(scope)
        onDispose { selection.unregister(scope) }
    }
}

/** While picking, in the page's top-left corner (over its back button): Select all, then Deselect all. */
@Composable
fun SelectAllButton(selection: Selection, modifier: Modifier = Modifier) {
    val c = Hive.colors
    AnimatedVisibility(selection.active, modifier, enter = fadeIn(tween(160)) + scaleIn(tween(160), initialScale = 0.9f), exit = fadeOut(tween(120))) {
        val all = selection.allPicked
        Row(
            Modifier.minimumInteractiveComponentSize().height(42.dp).hiveGlass(HiveShape.pill).clip(HiveShape.pill).clickable { selection.toggleAll() }.padding(start = 12.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (all) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, null, tint = c.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (all) "Deselect all" else "Select all", style = HiveText.rowStrong, color = c.text)
        }
    }
}

/**
 * Hold an album, then drag: every album between it and the one under the
 * finger is picked, and the list scrolls when the finger nears its top or
 * bottom edge. [rows] maps each list item's key to its albums, left to right;
 * the finger is placed by the list's own layout, so nothing extra runs per card.
 */
@Composable
fun Modifier.albumDragSelect(list: androidx.compose.foundation.lazy.LazyListState, rows: Map<Any, List<Long>>, order: List<Long>): Modifier {
    val selection = LocalSelection.current ?: return this
    androidx.compose.runtime.SideEffect { selection.albumOrder = order }
    val currentRows by androidx.compose.runtime.rememberUpdatedState(rows)
    return pickDrag(list, selection, active = { selection.dragAnchor != null }, end = selection::endAlbumDrag) { key, x, width ->
        val albums = currentRows[key] ?: return@pickDrag
        (albums.getOrNull(if (x < width / 2f) 0 else 1) ?: albums.lastOrNull())?.let(selection::dragTo)
    }
}

/**
 * Hold a song, then drag: every song between it and the one under the finger
 * is picked, down to the end of a long album or playlist, as the list scrolls
 * when the finger nears its top or bottom edge. [rows] maps list keys to songs.
 */
@Composable
fun Modifier.songDragSelect(list: androidx.compose.foundation.lazy.LazyListState, rows: Map<Any, Any>, order: List<Any>): Modifier {
    val selection = LocalSelection.current ?: return this
    androidx.compose.runtime.SideEffect { selection.trackOrder = order }
    val currentRows by androidx.compose.runtime.rememberUpdatedState(rows)
    return pickDrag(list, selection, active = { selection.trackDragAnchor != null }, end = selection::endTrackDrag) { key, _, _ ->
        currentRows[key]?.let(selection::dragToTrack)
    }
}

/** The finger after a hold: what's under it is picked ([pick]), and the list scrolls near its edges. */
@Composable
private fun Modifier.pickDrag(
    list: androidx.compose.foundation.lazy.LazyListState,
    selection: Selection,
    active: () -> Boolean,
    end: () -> Unit,
    pick: (key: Any, x: Float, width: Int) -> Unit,
): Modifier {
    val scope = rememberCoroutineScope()
    val currentPick by androidx.compose.runtime.rememberUpdatedState(pick)
    val edge = with(androidx.compose.ui.platform.LocalDensity.current) { 72.dp.toPx() }
    fun at(x: Float, y: Float, width: Int) {
        val info = list.layoutInfo
        val p = y + info.viewportStartOffset
        val item = info.visibleItemsInfo.firstOrNull { p >= it.offset && p < it.offset + it.size } ?: return
        currentPick(item.key, x, width)
    }
    return pointerInput(selection, list) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = androidx.compose.ui.input.pointer.PointerEventPass.Initial)
            // A new touch: a drag left over from a hold in a list without hold-and-drag ends here.
            end()
            var speed = 0f
            var finger = androidx.compose.ui.geometry.Offset.Zero
            var scroller: kotlinx.coroutines.Job? = null
            try {
                while (true) {
                    val change = awaitPointerEvent(androidx.compose.ui.input.pointer.PointerEventPass.Initial).changes.firstOrNull() ?: break
                    if (!change.pressed) break
                    if (!active()) continue
                    // Picking, not scrolling: the list doesn't get this drag.
                    change.consume()
                    finger = change.position
                    at(finger.x, finger.y, size.width)
                    // Faster the nearer the edge, so a long album or playlist is crossed quickly.
                    speed = when {
                        finger.y < edge -> -(edge - finger.y) / edge * 34f
                        finger.y > size.height - edge -> (finger.y - (size.height - edge)) / edge * 34f
                        else -> 0f
                    }
                    if (speed != 0f && scroller?.isActive != true) scroller = scope.launch {
                        while (speed != 0f) {
                            list.scrollBy(speed)
                            at(finger.x, finger.y, size.width)
                            androidx.compose.runtime.withFrameNanos { }
                        }
                    }
                }
            } finally {
                speed = 0f
                scroller?.cancel()
                end()
            }
        }
    }
}
