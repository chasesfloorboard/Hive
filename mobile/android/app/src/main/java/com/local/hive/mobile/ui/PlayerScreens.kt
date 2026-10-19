package com.local.hive.mobile.ui

import android.os.Build
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Repeat
import androidx.compose.material.icons.rounded.RepeatOne
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.Hive
import kotlin.math.roundToInt

/**
 * The floating pill above every screen, sized as Samsung Music's: 60dp tall,
 * fully rounded, 38dp round art, title over artist, then previous, play,
 * next and the queue.
 */
@Composable
fun MiniPlayer(now: NowPlaying, onOpen: () -> Unit, onTogglePlay: () -> Unit, onPrevious: () -> Unit, onNext: () -> Unit, onQueue: () -> Unit, modifier: Modifier = Modifier) {
    val colors = Hive.colors
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 5.dp)
            .height(60.dp)
            .clip(RoundedCornerShape(30.dp))
            .background(colors.control)
            .border(1.dp, colors.border, RoundedCornerShape(30.dp))
            .clickable(onClick = onOpen),
    ) {
        // A hairline of progress along the bottom edge, in Hive's accent.
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(progress).height(2.dp).background(colors.accent.copy(alpha = 0.7f)))
        Row(Modifier.fillMaxSize().padding(start = 11.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(now.artworkUri, Modifier.size(38.dp), CircleShape)
            Column(Modifier.weight(1f).padding(start = 10.dp, end = 3.dp)) {
                Text(now.title.ifBlank { "Nothing playing" }, color = colors.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (now.artist.isNotBlank()) Text(now.artist, color = colors.textDim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            MiniButton(Icons.Rounded.SkipPrevious, "Previous", onPrevious)
            MiniButton(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", onTogglePlay)
            MiniButton(Icons.Rounded.SkipNext, "Next", onNext)
            MiniButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onQueue)
        }
    }
}

@Composable
private fun MiniButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(42.dp)) { Icon(icon, label, tint = Hive.colors.text, modifier = Modifier.size(24.dp)) }
}

/**
 * Now Playing, laid out like Samsung Music's full player: the cover at 85%
 * of the width with 26dp corners, title and artist with the heart beside
 * them, a slim seek bar, then shuffle · previous · play · next · repeat.
 * Swipe down or tap the chevron to close.
 */
@Composable
fun FullPlayer(vm: MainViewModel, onClose: () -> Unit, onOpenQueue: () -> Unit, onOpenAlbum: (Track) -> Unit, onOpenArtist: (Track) -> Unit) {
    val colors = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf<Track?>(null) }
    LaunchedEffect(now.trackId) { current = now.trackId?.let { vm.tracksById(listOf(it)).firstOrNull() } }
    var drag by remember { mutableFloatStateOf(0f) }
    val dragOffset by animateFloatAsState(drag, label = "drag")

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .offset { IntOffset(0, dragOffset.roundToInt()) }
            .background(colors.bg)
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = { if (drag > size.height * 0.18f) onClose() else drag = 0f },
                    onDragCancel = { drag = 0f },
                ) { _, dy -> drag = (drag + dy).coerceAtLeast(0f) }
            },
    ) {
        val shortScreen = maxHeight < 640.dp
        // Blurred cover behind everything, fading into Hive's background.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Artwork(now.artworkUri, Modifier.fillMaxSize().blur(60.dp).alpha(0.45f), RoundedCornerShape(0.dp))
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(colors.bg.copy(alpha = 0.35f), colors.bg.copy(alpha = 0.85f), colors.bg))))

        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.Rounded.KeyboardArrowDown, "Close player", tint = colors.text, modifier = Modifier.size(30.dp)) }
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Now playing", color = colors.textDim, fontSize = 12.sp)
                    if (now.album.isNotBlank()) Text(now.album, color = colors.text, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { current?.let(onOpenAlbum) })
                }
                IconButton(onClick = onOpenQueue) { Icon(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", tint = colors.text) }
            }

            Spacer(Modifier.weight(0.5f))
            Artwork(
                now.artworkUri,
                Modifier.fillMaxWidth(0.85f).aspectRatio(1f, matchHeightConstraintsFirst = shortScreen).weight(4f, fill = false),
                RoundedCornerShape(26.dp),
                Icons.Rounded.MusicNote,
            )
            Spacer(Modifier.weight(0.5f))

            Row(Modifier.fillMaxWidth().padding(start = 30.dp, end = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(now.title.ifBlank { "Nothing playing" }, color = colors.text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(now.artist, color = colors.textDim, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { current?.let(onOpenArtist) })
                }
                val isLoved = now.trackId != null && now.trackId in loved
                IconButton(onClick = { now.trackId?.let { vm.toggleLoved(it) } }) {
                    Icon(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", tint = if (isLoved) colors.accent else colors.text, modifier = Modifier.size(28.dp))
                }
            }

            SeekBar(now, onSeek = { vm.player.seekTo(it) })

            Row(
                Modifier.fillMaxWidth().height(84.dp).padding(horizontal = 18.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ControlButton(Icons.Rounded.Shuffle, "Shuffle", active = now.shuffle) { vm.player.toggleShuffle() }
                ControlButton(Icons.Rounded.SkipPrevious, "Previous") { vm.player.previous() }
                Box(
                    Modifier.size(64.dp).clip(CircleShape).background(colors.text).clickable { vm.player.togglePlay() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", tint = colors.bg, modifier = Modifier.size(40.dp))
                }
                ControlButton(Icons.Rounded.SkipNext, "Next") { vm.player.next() }
                ControlButton(
                    if (now.repeatMode == Player.REPEAT_MODE_ONE) Icons.Rounded.RepeatOne else Icons.Rounded.Repeat,
                    "Repeat",
                    active = now.repeatMode != Player.REPEAT_MODE_OFF,
                ) { vm.player.cycleRepeat() }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun ControlButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, active: Boolean? = null, onClick: () -> Unit) {
    val colors = Hive.colors
    IconButton(onClick = onClick, modifier = Modifier.size(52.dp)) {
        Icon(icon, label, tint = when (active) { null -> colors.text; true -> colors.accent; false -> colors.textDimmer }, modifier = Modifier.size(32.dp))
    }
}

@Composable
private fun SeekBar(now: NowPlaying, onSeek: (Long) -> Unit) {
    val colors = Hive.colors
    var scrub by remember { mutableStateOf<Float?>(null) }
    val fraction = scrub ?: if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp)) {
        Slider(
            value = fraction.coerceIn(0f, 1f),
            onValueChange = { scrub = it },
            onValueChangeFinished = { scrub?.let { onSeek((it * now.durationMs).toLong()) }; scrub = null },
            colors = SliderDefaults.colors(thumbColor = colors.text, activeTrackColor = colors.text, inactiveTrackColor = colors.text.copy(alpha = 0.18f)),
            modifier = Modifier.height(32.dp),
        )
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
            Text(formatDuration((fraction * now.durationMs).toLong()), color = colors.textDim, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text(formatDuration(now.durationMs), color = colors.textDim, fontSize = 12.sp)
        }
    }
}

/** The current queue: tap to jump, ✕ to remove. */
@Composable
fun QueueScreen(vm: MainViewModel, onClose: () -> Unit) {
    val colors = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    LaunchedEffect(now.queue) { tracks = vm.tracksById(now.queue) }
    val listState = rememberLazyListState()
    LaunchedEffect(now.queueIndex, tracks.size) { if (now.queueIndex in tracks.indices) listState.scrollToItem((now.queueIndex - 2).coerceAtLeast(0)) }
    Column(Modifier.fillMaxSize().background(colors.bg).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.Rounded.KeyboardArrowDown, "Close queue", tint = colors.text) }
            Text("Queue", color = colors.text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${now.queueIndex + 1} / ${now.queue.size}", color = colors.textDim, fontSize = 13.sp, modifier = Modifier.padding(end = 16.dp))
        }
        LazyColumn(state = listState) {
            itemsIndexed(tracks) { i, t ->
                val playing = i == now.queueIndex
                Row(
                    Modifier.fillMaxWidth().clickable { vm.player.skipToQueueIndex(i) }.background(if (playing) colors.control else Color.Transparent).padding(start = 20.dp, end = 4.dp).height(60.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Artwork(t.artworkUri, Modifier.size(42.dp))
                    Column(Modifier.weight(1f).padding(start = 14.dp)) {
                        Text(t.title, color = if (playing) colors.accent else colors.text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(t.artist, color = colors.textDim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (!playing) IconButton(onClick = { vm.player.removeFromQueue(i) }) { Icon(Icons.Rounded.Close, "Remove from queue", tint = colors.textDim) }
                    else Spacer(Modifier.width(48.dp))
                }
            }
        }
    }
}
