package com.local.hive.mobile.ui

import android.os.Build
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Repeat
import androidx.compose.material.icons.rounded.RepeatOne
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.GlassLayers
import com.local.hive.mobile.ui.theme.GlassWeight
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveType
import com.local.hive.mobile.ui.theme.Radius
import com.local.hive.mobile.ui.theme.Space
import com.local.hive.mobile.ui.theme.glass
import kotlin.math.roundToInt

/**
 * The floating glass pill above every screen (60dp, fully round, as in
 * Samsung Music): round art, title over artist, play/pause and next, and a
 * hairline of progress in the accent along its lower edge.
 */
@Composable
fun MiniPlayer(now: NowPlaying, onOpen: () -> Unit, onTogglePlay: () -> Unit, onNext: () -> Unit, onQueue: () -> Unit, modifier: Modifier = Modifier) {
    val colors = Hive.colors
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = Space.xs)
            .height(64.dp)
            .glass(Radius.pill, GlassWeight.Thin)
            .pressable(onOpen, 0.98f),
    ) {
        Canvas(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 28.dp).height(2.dp)) {
            drawRoundRect(colors.text.copy(alpha = 0.08f), cornerRadius = CornerRadius(size.height))
            drawRoundRect(colors.accent, size = Size(size.width * progress.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(size.height))
        }
        Row(Modifier.fillMaxSize().padding(start = 10.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(now.artworkUri, Modifier.size(44.dp), CircleShape)
            Column(Modifier.weight(1f).padding(horizontal = Space.sm), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(now.title.ifBlank { "Nothing playing" }, style = HiveType.body, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (now.artist.isNotBlank()) Text(now.artist, style = HiveType.caption, color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            MiniButton(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", onTogglePlay, 28.dp)
            MiniButton(Icons.Rounded.SkipNext, "Next", onNext, 26.dp)
            MiniButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onQueue, 22.dp)
        }
    }
}

@Composable
private fun MiniButton(icon: ImageVector, label: String, onClick: () -> Unit, iconSize: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(42.dp).clip(CircleShape).pressable(onClick, 0.85f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = Hive.colors.text, modifier = Modifier.size(iconSize))
    }
}

/**
 * Now Playing. The screen is lit by the cover's colours (Hive's aura, drifting
 * with the song); the cover floats at 85% width with a glow of its own and
 * settles back a little while paused. Title and artist sit beside the heart,
 * over a slim seek bar and the transport, with what plays next at the bottom.
 * Swipe down to close.
 */
@Composable
fun FullPlayer(vm: MainViewModel, onClose: () -> Unit, onOpenQueue: () -> Unit, onOpenAlbum: (Track) -> Unit, onOpenArtist: (Track) -> Unit) {
    val colors = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf<Track?>(null) }
    var upNext by remember { mutableStateOf<Track?>(null) }
    LaunchedEffect(now.trackId, now.queueIndex, now.queue.size) {
        current = now.trackId?.let { vm.tracksById(listOf(it)).firstOrNull() }
        upNext = now.queue.getOrNull(now.queueIndex + 1)?.let { vm.tracksById(listOf(it)).firstOrNull() }
    }
    var drag by remember { mutableFloatStateOf(0f) }
    val dragOffset by animateFloatAsState(drag, spring(stiffness = 600f), label = "drag")
    val coverScale by animateFloatAsState(if (now.isPlaying) 1f else 0.9f, spring(dampingRatio = 0.6f, stiffness = 260f), label = "cover")
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f

    GlassLayers(
        Modifier
            .fillMaxSize()
            .offset { IntOffset(0, dragOffset.roundToInt()) }
            .clip(Radius.hero)
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = { if (drag > size.height * 0.16f) onClose() else drag = 0f },
                    onDragCancel = { drag = 0f },
                ) { _, dy -> drag = (drag + dy).coerceAtLeast(0f) }
            },
        content = {
            AuraBackground(aura, progress, intensity = 1.25f, base = colors.bg, modifier = Modifier.fillMaxSize())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Artwork(now.artworkUri, Modifier.fillMaxSize().blur(90.dp).alpha(0.28f), RectangleShape)
            }
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.55f to colors.bg.copy(alpha = 0.25f), 1f to colors.bg.copy(alpha = 0.85f))))
        },
        overlay = {
            BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                val compact = maxHeight < 700.dp
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = Space.sm, vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
                        GlassIconButton(Icons.Rounded.KeyboardArrowDown, "Close player", onClose)
                        Column(Modifier.weight(1f).pressable({ current?.let(onOpenAlbum) }), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("PLAYING FROM", style = HiveType.label, color = colors.textDimmer)
                            Text(now.album.ifBlank { "Your library" }, style = HiveType.tab, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = Space.md))
                        }
                        GlassIconButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onOpenQueue)
                    }

                    Spacer(Modifier.weight(1f))
                    Artwork(
                        now.artworkUri,
                        Modifier.fillMaxWidth(if (compact) 0.72f else 0.85f).aspectRatio(1f).scale(coverScale),
                        Radius.hero,
                        Icons.Rounded.MusicNote,
                        glow = aura?.primary,
                        elevation = 44.dp,
                    )
                    Spacer(Modifier.weight(1f))

                    Row(Modifier.fillMaxWidth().padding(start = 30.dp, end = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(now.title.ifBlank { "Nothing playing" }, style = HiveType.headline.copy(fontSize = HiveType.headline.fontSize * 1.1f), color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(now.artist, style = HiveType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Normal), color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.pressable({ current?.let(onOpenArtist) }))
                        }
                        val isLoved = now.trackId != null && now.trackId in loved
                        val heartScale by animateFloatAsState(if (isLoved) 1f else 0.92f, spring(dampingRatio = 0.4f, stiffness = 500f), label = "heart")
                        Box(Modifier.size(48.dp).scale(heartScale).glass(CircleShape, GlassWeight.Regular).pressable({ now.trackId?.let { vm.toggleLoved(it) } }, 0.85f), contentAlignment = Alignment.Center) {
                            Icon(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", tint = if (isLoved) colors.accent else colors.text, modifier = Modifier.size(24.dp))
                        }
                    }

                    SeekBar(now, onSeek = { vm.player.seekTo(it) })

                    Row(Modifier.fillMaxWidth().height(96.dp).padding(horizontal = Space.lg), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        TransportButton(Icons.Rounded.Shuffle, "Shuffle", 24.dp, active = now.shuffle) { vm.player.toggleShuffle() }
                        TransportButton(Icons.Rounded.SkipPrevious, "Previous", 40.dp) { vm.player.previous() }
                        Box(Modifier.size(76.dp).clip(CircleShape).background(colors.text).pressable({ vm.player.togglePlay() }, 0.9f), contentAlignment = Alignment.Center) {
                            Icon(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", tint = colors.bg, modifier = Modifier.size(40.dp))
                        }
                        TransportButton(Icons.Rounded.SkipNext, "Next", 40.dp) { vm.player.next() }
                        TransportButton(if (now.repeatMode == Player.REPEAT_MODE_ONE) Icons.Rounded.RepeatOne else Icons.Rounded.Repeat, "Repeat", 24.dp, active = now.repeatMode != Player.REPEAT_MODE_OFF) { vm.player.cycleRepeat() }
                    }

                    upNext?.let { next ->
                        Row(
                            Modifier.padding(horizontal = Space.md).padding(bottom = Space.md).fillMaxWidth().height(56.dp).glass(Radius.pill, GlassWeight.Thin).pressable(onOpenQueue, 0.98f).padding(horizontal = Space.sm),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Artwork(next.artworkUri, Modifier.size(36.dp), CircleShape)
                            Column(Modifier.weight(1f).padding(horizontal = Space.sm)) {
                                Text("UP NEXT", style = HiveType.label.copy(fontSize = HiveType.label.fontSize * 0.9f), color = colors.textDimmer)
                                Text(listOf(next.title, next.artist).filter { it.isNotBlank() }.joinToString(" · "), style = HiveType.secondary, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Icon(Icons.Rounded.KeyboardArrowUp, null, tint = colors.textDim, modifier = Modifier.padding(end = Space.xs))
                        }
                    } ?: Spacer(Modifier.height(72.dp))
                }
            }
        },
    )
}

@Composable
private fun TransportButton(icon: ImageVector, label: String, iconSize: androidx.compose.ui.unit.Dp, active: Boolean? = null, onClick: () -> Unit) {
    val colors = Hive.colors
    val tint by animateColorAsState(when (active) { null -> colors.text; true -> colors.accent; false -> colors.textDimmer }, tween(250), label = "tint")
    Box(Modifier.size(56.dp).clip(CircleShape).pressable(onClick, 0.85f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(iconSize))
        if (active == true) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp).size(4.dp).clip(CircleShape).background(colors.accent))
    }
}

/** A slim bar that thickens under the finger; times sit quietly beneath. */
@Composable
private fun SeekBar(now: NowPlaying, onSeek: (Long) -> Unit) {
    val colors = Hive.colors
    var scrub by remember { mutableStateOf<Float?>(null) }
    val fraction = (scrub ?: if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f).coerceIn(0f, 1f)
    val thickness by animateDpAsState(if (scrub != null) 8.dp else 4.dp, spring(stiffness = 700f), label = "thick")
    Column(Modifier.fillMaxWidth().padding(horizontal = 30.dp).padding(top = Space.lg)) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(24.dp)
                .pointerInput(now.durationMs) {
                    detectTapGestures { onSeek(((it.x / size.width).coerceIn(0f, 1f) * now.durationMs).toLong()) }
                }
                .pointerInput(now.durationMs) {
                    detectHorizontalDragGestures(
                        onDragStart = { scrub = (it.x / size.width).coerceIn(0f, 1f) },
                        onDragEnd = { scrub?.let { onSeek((it * now.durationMs).toLong()) }; scrub = null },
                        onDragCancel = { scrub = null },
                    ) { change, _ -> scrub = (change.position.x / size.width).coerceIn(0f, 1f) }
                },
        ) {
            val h = thickness.toPx()
            val top = (size.height - h) / 2
            drawRoundRect(colors.text.copy(alpha = 0.16f), Offset(0f, top), Size(size.width, h), CornerRadius(h / 2))
            drawRoundRect(colors.text, Offset(0f, top), Size(size.width * fraction, h), CornerRadius(h / 2))
        }
        Row(Modifier.fillMaxWidth()) {
            Text(formatDuration((fraction * now.durationMs).toLong()), style = HiveType.numbers, color = colors.textDim, modifier = Modifier.weight(1f))
            Text("-" + formatDuration((now.durationMs - fraction * now.durationMs).toLong()), style = HiveType.numbers, color = colors.textDim)
        }
    }
}

/** The queue as a glass sheet over the aura: tap to jump, ✕ to remove. */
@Composable
fun QueueScreen(vm: MainViewModel, onClose: () -> Unit) {
    val colors = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    LaunchedEffect(now.queue) { tracks = vm.tracksById(now.queue) }
    val listState = rememberLazyListState()
    LaunchedEffect(now.queueIndex, tracks.size) { if (now.queueIndex in tracks.indices) listState.scrollToItem((now.queueIndex - 1).coerceAtLeast(0)) }
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f

    GlassLayers(Modifier.fillMaxSize(), content = {
        AuraBackground(aura, progress, intensity = 1f, base = colors.bg, modifier = Modifier.fillMaxSize())
    }, overlay = {
        Column(Modifier.fillMaxSize().statusBarsPadding().padding(top = Space.xl).glass(Radius.sheet, GlassWeight.Regular).navigationBarsPadding()) {
            Box(Modifier.fillMaxWidth().padding(top = Space.sm), contentAlignment = Alignment.Center) {
                Box(Modifier.width(36.dp).height(4.dp).clip(Radius.pill).background(colors.text.copy(alpha = 0.25f)))
            }
            Row(Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.sm, top = Space.md, bottom = Space.xs), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Queue", style = HiveType.title, color = colors.text)
                    Text("%d of %d · %s left".format(now.queueIndex + 1, now.queue.size, formatLength(tracks.drop(now.queueIndex + 1).sumOf { it.durationMs })), style = HiveType.secondary, color = colors.textDim)
                }
                GlassIconButton(Icons.Rounded.KeyboardArrowDown, "Close queue", onClose)
            }
            LazyColumn(state = listState, contentPadding = PaddingValues(bottom = Space.xl)) {
                itemsIndexed(tracks) { i, t ->
                    val playing = i == now.queueIndex
                    val past = i < now.queueIndex
                    Row(
                        Modifier.fillMaxWidth().pressable({ vm.player.skipToQueueIndex(i) }, 0.985f).alpha(if (past) 0.45f else 1f)
                            .padding(start = Space.gutter, end = Space.xs).height(62.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box {
                            Artwork(t.artworkUri, Modifier.size(46.dp))
                            if (playing) Box(Modifier.size(46.dp).clip(Radius.art).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                                NowPlayingBars(now.isPlaying, Color.White, Modifier.size(16.dp))
                            }
                        }
                        Column(Modifier.weight(1f).padding(start = Space.md), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(t.title, style = HiveType.body, color = if (playing) colors.accent else colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(t.artist, style = HiveType.secondary, color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (!playing) Box(Modifier.size(44.dp).clip(CircleShape).pressable({ vm.player.removeFromQueue(i) }, 0.85f), contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.Close, "Remove from queue", tint = colors.textDimmer, modifier = Modifier.size(18.dp))
                        } else Spacer(Modifier.width(44.dp))
                    }
                }
            }
        }
    })
}
