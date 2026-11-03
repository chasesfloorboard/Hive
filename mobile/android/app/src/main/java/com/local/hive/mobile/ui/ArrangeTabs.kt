package com.local.hive.mobile.ui

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.mix

private val ROW = 56.dp

private fun HomeTab.icon() = when (this) {
    HomeTab.Favorites -> Icons.Rounded.Favorite
    HomeTab.Playlists -> Icons.AutoMirrored.Rounded.QueueMusic
    HomeTab.Albums -> Icons.Rounded.Album
    HomeTab.Tracks -> Icons.Rounded.MusicNote
    HomeTab.Artists -> Icons.Rounded.Person
    HomeTab.Browse -> Icons.Rounded.Explore
    HomeTab.Genres -> Icons.Rounded.Category
    HomeTab.Folders -> Icons.Rounded.Folder
}

/**
 * Arrange the home tabs: drag a row by anywhere on it (it lifts, the others make way, a tick at
 * each step), top is leftmost. Each move is kept at once, so Home follows behind the dialog.
 */
@Composable
fun ArrangeTabsDialog(onDismiss: () -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val rowPx = with(LocalDensity.current) { ROW.toPx() }
    val order = remember { mutableStateListOf<HomeTab>().apply { addAll(HomeTabOrder.get(context)) } }
    var dragging by remember { mutableStateOf<HomeTab?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }

    HiveDialog(onDismiss, spacing = 8.dp) {
        Text("Arrange tabs", style = HiveText.viewTitle, color = c.text)
        Text("Drag a tab up or down. The top one is the furthest left.", style = HiveText.small, color = c.textDim)
        Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
            // Each row keyed to its tab, so a row keeps its finger as it trades places.
            order.forEach { tab -> androidx.compose.runtime.key(tab) {
                val lifted = dragging == tab
                // A row that makes way glides from its old place to its new one.
                val slot = order.indexOf(tab)
                val lastSlot = remember { androidx.compose.runtime.mutableIntStateOf(slot) }
                val glide = remember { androidx.compose.animation.core.Animatable(0f) }
                androidx.compose.runtime.LaunchedEffect(slot) {
                    val from = (lastSlot.intValue - slot) * rowPx
                    lastSlot.intValue = slot
                    if (!lifted && from != 0f) { glide.snapTo(from); glide.animateTo(0f, spring(dampingRatio = 0.8f, stiffness = 500f)) }
                }
                val scale by animateFloatAsState(if (lifted) 1.03f else 1f, spring(stiffness = 600f), label = "lift")
                val elevation by animateDpAsState(if (lifted) 14.dp else 0.dp, label = "liftShadow")
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(ROW)
                        .zIndex(if (lifted) 1f else 0f)
                        .graphicsLayer { translationY = if (lifted) offset else glide.value; scaleX = scale; scaleY = scale }
                        .shadow(elevation, HiveShape.row)
                        .clip(HiveShape.row)
                        .background(if (lifted) mix(c.accent, c.panelStrong, 0.18f) else androidx.compose.ui.graphics.Color.Transparent)
                        .pointerInput(tab) {
                            detectDragGestures(
                                onDragStart = { dragging = tab; offset = 0f; haptics.performHapticFeedback(HapticFeedbackType.LongPress) },
                                onDragEnd = { dragging = null; offset = 0f; HomeTabOrder.set(context, order.toList()) },
                                onDragCancel = { dragging = null; offset = 0f },
                            ) { change, drag ->
                                change.consume()
                                offset += drag.y
                                val at = order.indexOf(tab)
                                // Past half a row, it trades places with its neighbour and carries on from there.
                                if (offset > rowPx / 2 && at < order.lastIndex) {
                                    order.add(at + 1, order.removeAt(at)); offset -= rowPx
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                } else if (offset < -rowPx / 2 && at > 0) {
                                    order.add(at - 1, order.removeAt(at)); offset += rowPx
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                }
                            }
                        }
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(34.dp).clip(HiveShape.thumb).background(mix(c.accent, c.panelStrong, 0.22f)), contentAlignment = Alignment.Center) {
                        Icon(tab.icon(), null, tint = c.accent, modifier = Modifier.size(18.dp))
                    }
                    Spacer(Modifier.width(14.dp))
                    Text(tab.label, style = HiveText.rowStrong, color = c.text, modifier = Modifier.weight(1f))
                    Icon(Icons.Rounded.DragHandle, "Drag to move ${tab.label}", tint = c.textDim, modifier = Modifier.size(22.dp))
                }
            } }
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            HiveButton("Reset") {
                order.clear(); order.addAll(HomeTab.entries); HomeTabOrder.set(context, order.toList())
            }
            HiveButton("Done", primary = true) { onDismiss() }
        }
    }
}
