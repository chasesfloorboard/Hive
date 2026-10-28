package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.link.RemoteState
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.delay

/**
 * What Hive on the PC is playing, with its controls: play/pause, skip,
 * seek, volume, and "Play on this phone" to take the song over.
 */
@Composable
fun RemoteScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onToast: (String) -> Unit) {
    val c = Hive.colors
    val link by vm.link.collectAsStateWithLifecycle()
    var state by remember { mutableStateOf<RemoteState?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    // Hive reports a few times a second; once a second is plenty for a remote.
    LaunchedEffect(Unit) {
        while (true) {
            runCatching { vm.pcRemoteState() }
                .onSuccess { s -> state = s; problem = if (s == null) "Hive on your PC isn't reachable right now." else null }
                .onFailure { e -> problem = if ((e as? com.local.hive.mobile.link.HiveLinkException)?.status == 403) "In Hive on your PC, tick Settings › Connections › Hive Mobile › “Let paired phones control playback”." else e.message }
            delay(1_000)
        }
    }
    val s = state
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        Column(Modifier.fillMaxSize().padding(horizontal = 24.dp).padding(bottom = bottomPadding + 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            HiveLabel(link.serverName.ifBlank { "Hive on your PC" })
            Text("Playing on your PC", style = HiveText.viewTitle, color = c.text, modifier = Modifier.padding(top = 2.dp))
            Spacer(Modifier.height(26.dp))
            if (problem != null || s == null) {
                Icon(Icons.Rounded.Computer, null, tint = c.textDim, modifier = Modifier.size(64.dp))
                Text(problem ?: "Connecting…", style = HiveText.body, color = c.textDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 16.dp))
                return@Column
            }
            val cover = remember(s.cover) { vm.pcLibrary.coverFor(s.cover) }
            Artwork(cover, Modifier.fillMaxWidth(0.72f).aspectRatio(1f), HiveShape.art, Icons.Rounded.Computer, elevation = 30.dp)
            Text(s.title.ifBlank { "Nothing playing" }, style = HiveText.npTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 24.dp))
            Text(listOf(s.artist, s.album).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            RemoteBar(s.position, s.duration) { vm.pcRemote("seek", positionMs = it); state = s.copy(position = it) }
            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(22.dp), verticalAlignment = Alignment.CenterVertically) {
                ControlButton(HiveIcons.Previous, "Previous on the PC", { vm.pcRemote("previous") }, size = 52.dp)
                AccentPlayButton(s.playing, { vm.pcRemote("toggle"); state = s.copy(playing = !s.playing) }, size = 72.dp)
                ControlButton(HiveIcons.Next, "Next on the PC", { vm.pcRemote("next") }, size = 52.dp)
            }
            Row(Modifier.fillMaxWidth().padding(top = 22.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Rounded.VolumeUp, "Volume on the PC", tint = c.textDim, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                RemoteBar((s.volume * 1000).toLong(), 1000, showTimes = false, modifier = Modifier.weight(1f)) { v -> vm.pcRemote("volume", volume = v / 1000.0); state = s.copy(volume = v / 1000.0) }
            }
            Spacer(Modifier.weight(1f))
            if (s.id.isNotBlank()) Row(
                Modifier.fillMaxWidth().height(54.dp).hiveGlass(HiveShape.menu).pressable({ vm.playPcHere(s, onToast) }).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
            ) {
                Icon(Icons.Rounded.PhoneAndroid, null, tint = c.accent, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("Play on this phone", style = HiveText.rowStrong, color = c.text)
            }
        }
    }
}

/** A Hive bar for the PC's position or volume: tap or drag to set. */
@Composable
private fun RemoteBar(value: Long, max: Long, showTimes: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth().padding(top = 22.dp), onSet: (Long) -> Unit) {
    val c = Hive.colors
    var scrub by remember { mutableStateOf<Float?>(null) }
    val fraction = (scrub ?: if (max > 0) value.toFloat() / max else 0f).coerceIn(0f, 1f)
    Column(modifier) {
        Canvas(
            Modifier.fillMaxWidth().height(28.dp)
                .pointerInput(max) { detectTapGestures { onSet(((it.x / size.width).coerceIn(0f, 1f) * max).toLong()) } }
                .pointerInput(max) {
                    detectHorizontalDragGestures(
                        onDragStart = { scrub = (it.x / size.width).coerceIn(0f, 1f) },
                        onDragEnd = { scrub?.let { onSet((it * max).toLong()) }; scrub = null },
                        onDragCancel = { scrub = null },
                    ) { change, _ -> scrub = (change.position.x / size.width).coerceIn(0f, 1f) }
                },
        ) {
            val h = 4.dp.toPx(); val cy = size.height / 2
            drawRoundRect(c.text.copy(alpha = 0.12f), Offset(0f, cy - h / 2), Size(size.width, h), CornerRadius(h / 2))
            drawRoundRect(c.accent, Offset(0f, cy - h / 2), Size(size.width * fraction, h), CornerRadius(h / 2))
            drawCircle(c.text, 6.dp.toPx(), Offset(size.width * fraction, cy))
        }
        if (showTimes) Row(Modifier.fillMaxWidth()) {
            Text(formatDuration((fraction * max).toLong()), style = HiveText.numbers, color = c.textDim, modifier = Modifier.weight(1f))
            Text(if (max > 0) formatDuration(max) else "--:--", style = HiveText.numbers, color = c.textDim)
        }
    }
}
