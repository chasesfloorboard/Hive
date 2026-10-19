package com.local.hive.mobile.ui

import android.os.Build
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
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
import androidx.compose.material.icons.rounded.KeyboardArrowUp
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.GlassLayers
import com.local.hive.mobile.ui.theme.GlassWeight
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveType
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.Radius
import com.local.hive.mobile.ui.theme.Space
import com.local.hive.mobile.ui.theme.glass
import kotlinx.coroutines.launch
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.composed
import androidx.compose.ui.input.pointer.util.VelocityTracker
import kotlin.math.abs
import kotlin.math.roundToInt

private val MiniHeight = 64.dp
private val MiniMargin = 12.dp
private val MiniArt = 44.dp

/**
 * The player as one surface that grows from the mini pill into Now Playing,
 * the way Samsung Music's does: the pill widens to the screen, its corners
 * relax, the aura fades in, and the cover flies from the pill's round
 * thumbnail to the large cover. Drag it up or down by hand; release past
 * halfway, or flick, and it settles with One UI's open (450 ms) or close
 * (400 ms) curve.
 */
@Composable
fun PlayerSheet(
    vm: MainViewModel,
    open: Boolean,
    onOpenChange: (Boolean) -> Unit,
    onOpenQueue: () -> Unit,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
) {
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    val density = LocalDensity.current
    val progress = remember { Animatable(if (open) 1f else 0f) }
    // While a finger is down the sheet follows it directly; the settle
    // animation starts only on release, so nothing can fight the drag.
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    var dragStart by remember { mutableFloatStateOf(0f) }
    var settleMs by remember { mutableStateOf<Int?>(null) }
    var artTarget by remember { mutableStateOf<Rect?>(null) }
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()

    // The open state leads and the animation follows it.
    LaunchedEffect(open) {
        val spec = settleMs?.let { tween<Float>(it, easing = Motion.Open) } ?: if (open) Motion.open() else Motion.close()
        settleMs = null
        progress.animateTo(if (open) 1f else 0f, spec)
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val fullW = constraints.maxWidth
        val fullH = constraints.maxHeight
        val p = if (dragging) dragValue else progress.value
        val margin = with(density) { MiniMargin.toPx() }
        val miniH = with(density) { MiniHeight.toPx() }
        val miniTop = fullH - with(density) { navBottom.toPx() } - miniH - with(density) { Space.xs.toPx() }
        val travel = fullH - miniH

        // The container's bounds, from the pill to the whole screen.
        val left = margin * (1 - p)
        val top = miniTop * (1 - p)
        val width = fullW - 2 * left
        val height = miniH + travel * p
        val corner = lerp(MiniHeight / 2, 28.dp, p)

        val scope = rememberCoroutineScope()
        val dragModifier = Modifier.screenVerticalDrag(
            onStart = {
                dragStart = progress.value
                dragValue = progress.value
                dragging = true
                scope.launch { progress.stop() }
            },
            onDelta = { dy -> dragValue = (dragValue - dy / travel).coerceIn(0f, 1f) },
            onStop = { velocity ->
                // A clear flick wins; otherwise the direction of travel decides
                // once the sheet has moved 15% of the way.
                val moved = dragValue - dragStart
                val target = when {
                    velocity < -900f -> true
                    velocity > 900f -> false
                    moved > 0.15f -> true
                    moved < -0.15f -> false
                    else -> dragStart > 0.5f
                }
                scope.launch {
                    progress.snapTo(dragValue)
                    dragging = false
                    if (target != open) {
                        settleMs = Motion.settleMs(velocity)
                        onOpenChange(target)
                    } else {
                        progress.animateTo(if (target) 1f else 0f, tween(Motion.settleMs(velocity), easing = Motion.Open))
                    }
                }
            },
        )

        Box(
            Modifier
                .offset { IntOffset(left.roundToInt(), top.roundToInt()) }
                .requiredSize(with(density) { width.toDp() }, with(density) { height.toDp() })
                .then(if (p < 0.98f) Modifier.shadow(lerp(14.dp, 0.dp, p), RoundedCornerShape(corner), ambientColor = Color.Black, spotColor = Color.Black) else Modifier)
                .glass(RoundedCornerShape(corner), GlassWeight.Thin),
        ) {
            // One layer pinned to the screen holds both the mini controls and
            // Now Playing. Its coordinates are the screen's, so the drag on it
            // measures the finger truly; the container's clip keeps touches
            // to the pill while closed.
            Box(
                Modifier
                    .layout { measurable, constraints ->
                        val placeable = measurable.measure(Constraints.fixed(fullW, fullH))
                        layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-left.roundToInt(), -top.roundToInt()) }
                    }
                    .then(dragModifier),
            ) {
                Box(Modifier.fillMaxSize().graphicsLayer { alpha = Motion.SineInOut60.transform(((p - 0.15f) / 0.85f).coerceIn(0f, 1f)) }) {
                    FullPlayerContent(
                        vm, now, aura, p,
                        onClose = { onOpenChange(false) },
                        onOpenQueue = onOpenQueue,
                        onOpenAlbum = onOpenAlbum,
                        onOpenArtist = onOpenArtist,
                        onArtPlaced = { artTarget = it },
                    )
                }
                if (p < 0.3f) {
                    MiniContent(
                        now,
                        showArt = p == 0f,
                        modifier = Modifier
                            .offset { IntOffset(margin.roundToInt(), miniTop.roundToInt()) }
                            .requiredSize(with(density) { (fullW - 2 * margin).toDp() }, MiniHeight)
                            .alpha((1f - p / 0.25f).coerceIn(0f, 1f)),
                        onOpen = { onOpenChange(true) },
                        onTogglePlay = { vm.player.togglePlay() },
                        onNext = { vm.player.next() },
                        onQueue = onOpenQueue,
                    )
                }
            }
        }

        // The cover, flying between the pill's thumbnail and the large cover.
        val miniArtSize = with(density) { MiniArt.toPx() }
        val from = Rect(Offset(margin + with(density) { 10.dp.toPx() }, miniTop + (miniH - miniArtSize) / 2), Size(miniArtSize, miniArtSize))
        val to = artTarget
        if (to != null && p > 0f) {
            val eased = Motion.SineInOut80.transform(p)
            val r = androidx.compose.ui.geometry.lerp(from, to, eased)
            Artwork(
                now.artworkUri,
                Modifier
                    .offset { IntOffset(r.left.roundToInt(), r.top.roundToInt()) }
                    .requiredSize(with(density) { r.width.toDp() }, with(density) { r.height.toDp() }),
                RoundedCornerShape(lerp(MiniArt / 2, 24.dp, eased)),
                glow = aura?.primary,
                elevation = lerp(0.dp, 40.dp, eased),
            )
        }
    }
}

/**
 * A vertical drag on a layer pinned to the screen, so its local positions are
 * screen positions even while the sheet moves. Only an unconsumed, mostly
 * vertical drag past touch slop starts it, so taps, buttons and the
 * horizontal seek bar keep working.
 */
private fun Modifier.screenVerticalDrag(onStart: () -> Unit, onDelta: (Float) -> Unit, onStop: (Float) -> Unit): Modifier = composed {
    val latestStart by rememberUpdatedState(onStart)
    val latestDelta by rememberUpdatedState(onDelta)
    val latestStop by rememberUpdatedState(onStop)
    pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            var last = down.position
            var lastTime = down.uptimeMillis
            var started = false
            val tracker = VelocityTracker()
            tracker.addPosition(down.uptimeMillis, down.position)
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (!change.pressed) break
                tracker.addPosition(change.uptimeMillis, change.position)
                if (!started) {
                    if (change.isConsumed) break
                    val d = change.position - down.position
                    if (abs(d.y) > viewConfiguration.touchSlop && abs(d.y) > abs(d.x)) {
                        started = true
                        last = change.position
                        latestStart()
                    }
                    continue
                }
                change.consume()
                latestDelta(change.position.y - last.y)
                last = change.position
                lastTime = change.uptimeMillis
            }
            if (started) {
                // Some input sources end without a usable last sample; fall back
                // to the drag's average speed so a quick swipe still reads as one.
                val tracked = tracker.calculateVelocity().y
                val elapsed = (lastTime - down.uptimeMillis).coerceAtLeast(1L)
                latestStop(if (tracked != 0f) tracked else (last.y - down.position.y) / elapsed * 1000f)
            }
        }
    }
}

/** The pill's contents: art, title over artist, play/pause, next, queue. */
@Composable
private fun MiniContent(now: NowPlaying, showArt: Boolean, modifier: Modifier, onOpen: () -> Unit, onTogglePlay: () -> Unit, onNext: () -> Unit, onQueue: () -> Unit) {
    val colors = Hive.colors
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    Box(modifier.pressable(onOpen, 0.985f)) {
        Canvas(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 28.dp).height(2.dp)) {
            drawRoundRect(colors.text.copy(alpha = 0.08f), cornerRadius = CornerRadius(size.height))
            drawRoundRect(colors.accent, size = Size(size.width * progress.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(size.height))
        }
        Row(Modifier.fillMaxSize().padding(start = 10.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            // Samsung's mini player cross-fades the art on track change in 250 ms.
            // While the sheet moves, the flying cover stands in for it.
            Crossfade(now.artworkUri, animationSpec = Motion.swap(), modifier = Modifier.alpha(if (showArt) 1f else 0f), label = "miniArt") { art ->
                Artwork(art, Modifier.size(MiniArt), CircleShape)
            }
            Crossfade(now.title to now.artist, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "miniText") { (title, artist) ->
                Column(Modifier.padding(horizontal = Space.sm), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(title.ifBlank { "Nothing playing" }, style = HiveType.body, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (artist.isNotBlank()) Text(artist, style = HiveType.caption, color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            MiniButton(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", onTogglePlay, 28.dp)
            MiniButton(Icons.Rounded.SkipNext, "Next", onNext, 26.dp)
            MiniButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onQueue, 22.dp)
        }
    }
}

@Composable
private fun MiniButton(icon: ImageVector, label: String, onClick: () -> Unit, iconSize: Dp) {
    Box(Modifier.size(42.dp).clip(CircleShape).pressable(onClick, 0.85f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = Hive.colors.text, modifier = Modifier.size(iconSize))
    }
}

/**
 * Now Playing's layout. The large cover itself is drawn by [PlayerSheet] so it
 * can fly in from the pill; this reserves its place and reports where it is.
 */
@Composable
private fun FullPlayerContent(
    vm: MainViewModel,
    now: NowPlaying,
    aura: AuraColors?,
    sheetProgress: Float,
    onClose: () -> Unit,
    onOpenQueue: () -> Unit,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
    onArtPlaced: (Rect) -> Unit,
) {
    val colors = Hive.colors
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf<Track?>(null) }
    var upNext by remember { mutableStateOf<Track?>(null) }
    LaunchedEffect(now.trackId, now.queueIndex, now.queue.size) {
        current = now.trackId?.let { vm.tracksById(listOf(it)).firstOrNull() }
        upNext = now.queue.getOrNull(now.queueIndex + 1)?.let { vm.tracksById(listOf(it)).firstOrNull() }
    }
    val coverScale by animateFloatAsState(if (now.isPlaying) 1f else 0.9f, spring(dampingRatio = 0.6f, stiffness = 260f), label = "cover")
    val songProgress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    // Controls rise a little as the sheet opens.
    val rise = with(LocalDensity.current) { (48.dp * (1f - sheetProgress)).toPx() }

    GlassLayers(Modifier.fillMaxSize(), content = {
        AuraBackground(aura, songProgress, intensity = 1.25f, base = colors.bg, modifier = Modifier.fillMaxSize())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Artwork(now.artworkUri, Modifier.fillMaxSize().blur(90.dp).alpha(0.28f), RectangleShape)
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.55f to colors.bg.copy(alpha = 0.25f), 1f to colors.bg.copy(alpha = 0.85f))))
    }, overlay = {
        BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            val compact = maxHeight < 700.dp
            Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                Row(Modifier.fillMaxWidth().padding(horizontal = Space.sm, vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
                    GlassIconButton(Icons.Rounded.KeyboardArrowDown, "Close player", onClose)
                    Column(Modifier.weight(1f).pressable({ current?.let(onOpenAlbum) }), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("PLAYING FROM", style = HiveType.label, color = colors.textDimmer)
                        Crossfade(now.album, animationSpec = Motion.swap(), label = "album") { album ->
                            Text(album.ifBlank { "Your library" }, style = HiveType.tab, color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = Space.md))
                        }
                    }
                    GlassIconButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onOpenQueue)
                }

                Spacer(Modifier.weight(1f))
                // The cover's place; PlayerSheet draws the cover here.
                Box(
                    Modifier
                        .fillMaxWidth(if (compact) 0.72f else 0.85f)
                        .aspectRatio(1f)
                        .scale(coverScale)
                        // Unclipped root coordinates: boundsInRoot would shrink with the sheet.
                        .onGloballyPositioned { c -> onArtPlaced(Rect(c.localToRoot(Offset.Zero), c.localToRoot(Offset(c.size.width.toFloat(), c.size.height.toFloat())))) },
                )
                Spacer(Modifier.weight(1f))

                Column(Modifier.graphicsLayer { translationY = rise }) {
                    Row(Modifier.fillMaxWidth().padding(start = 30.dp, end = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Crossfade(now.title to now.artist, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "titles") { (title, artist) ->
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(title.ifBlank { "Nothing playing" }, style = HiveType.headline.copy(fontSize = HiveType.headline.fontSize * 1.1f), color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(artist, style = HiveType.body.copy(fontWeight = FontWeight.Normal), color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.pressable({ current?.let(onOpenArtist) }))
                            }
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
                            Crossfade(now.isPlaying, animationSpec = tween(180), label = "playIcon") { playing ->
                                Icon(if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (playing) "Pause" else "Play", tint = colors.bg, modifier = Modifier.size(40.dp))
                            }
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
        }
    })
}

@Composable
private fun TransportButton(icon: ImageVector, label: String, iconSize: Dp, active: Boolean? = null, onClick: () -> Unit) {
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
