package com.local.hive.mobile.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.material.icons.automirrored.rounded.Sort
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.MoreVert
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.OneUi
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt
import androidx.compose.ui.unit.lerp as lerpDp

private val MiniHeight = 64.dp
private val MiniMargin = 8.dp
private val MiniArt = 40.dp

/** Samsung tints the mini player with a dark version of the cover's colour. */
private fun miniTint(aura: AuraColors?): Color = aura?.let { lerp(Color(0xFF17171A), lerp(it.primary, Color(0xFF6B6B6B), 0.35f), 0.38f) } ?: Color(0xFF2A2A2D)

/**
 * The player as one surface that grows from the mini bar into Now Playing,
 * as Samsung Music's does: the bar widens to the screen, the cover's colours
 * take over the background, and the cover flies from the bar's round
 * thumbnail to the large cover. Drag it up or down by hand; it settles with
 * Samsung's timing (350 ms, quicker for a harder flick).
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
    val tint by animateColorAsState(miniTint(aura), tween(Motion.SWAP_MS * 2), label = "tint")

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
        val miniTop = fullH - with(density) { navBottom.toPx() } - miniH - with(density) { 6.dp.toPx() }
        val travel = fullH - miniH

        // The container's bounds, from the bar to the whole screen.
        val left = margin * (1 - p)
        val top = miniTop * (1 - p)
        val width = fullW - 2 * left
        val height = miniH + travel * p
        val corner = lerpDp(MiniHeight / 2, 0.dp, p)

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
                .clip(RoundedCornerShape(corner))
                .background(lerp(tint, Color.Black, p)),
        ) {
            // One layer pinned to the screen holds both the mini controls and
            // Now Playing. Its coordinates are the screen's, so the drag on it
            // measures the finger truly; the container's clip keeps touches
            // to the bar while closed.
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
                        vm, now, aura,
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
                        onPrevious = { vm.player.previous() },
                        onNext = { vm.player.next() },
                        onQueue = onOpenQueue,
                    )
                }
            }
        }

        // The cover, flying between the bar's thumbnail and the large cover.
        val miniArtSize = with(density) { MiniArt.toPx() }
        val from = Rect(Offset(margin + with(density) { 12.dp.toPx() }, miniTop + (miniH - miniArtSize) / 2), Size(miniArtSize, miniArtSize))
        val to = artTarget
        if (to != null && p > 0f) {
            val eased = Motion.SineInOut80.transform(p)
            val r = androidx.compose.ui.geometry.lerp(from, to, eased)
            Artwork(
                now.artworkUri,
                Modifier
                    .offset { IntOffset(r.left.roundToInt(), r.top.roundToInt()) }
                    .requiredSize(with(density) { r.width.toDp() }, with(density) { r.height.toDp() }),
                RoundedCornerShape(lerpDp(MiniArt / 2, 26.dp, eased)),
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

/** Samsung's mini player: round art, title over artist, then ⏮ ▶ ⏭ and the queue. */
@Composable
private fun MiniContent(
    now: NowPlaying,
    showArt: Boolean,
    modifier: Modifier,
    onOpen: () -> Unit,
    onTogglePlay: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onQueue: () -> Unit,
) {
    Box(modifier.clickable(onClick = onOpen)) {
        Row(Modifier.fillMaxSize().padding(start = 12.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            // The art cross-fades on track change in 250 ms; while the sheet
            // moves, the flying cover stands in for it.
            Crossfade(now.artworkUri, animationSpec = Motion.swap(), modifier = Modifier.alpha(if (showArt) 1f else 0f), label = "miniArt") { art ->
                Artwork(art, Modifier.size(MiniArt), CircleShape)
            }
            Crossfade(now.title to now.artist, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "miniText") { (title, artist) ->
                Column(Modifier.padding(horizontal = 12.dp)) {
                    Text(title.ifBlank { "Nothing playing" }, style = OneUi.MiniTitle, color = OneUi.Text1, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (artist.isNotBlank()) Text(artist, style = OneUi.MiniArtist, color = OneUi.Text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            MiniButton(Icons.Rounded.SkipPrevious, "Previous", onPrevious)
            MiniButton(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", onTogglePlay)
            MiniButton(Icons.Rounded.SkipNext, "Next", onNext)
            MiniButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onQueue)
        }
    }
}

@Composable
private fun MiniButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    Box(Modifier.size(width = 42.dp, height = 48.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = OneUi.Text1, modifier = Modifier.size(26.dp))
    }
}

/**
 * Now Playing, laid out like Samsung Music's: the cover's colours glowing
 * behind, the cover centred, title and artist centred under it, then Queue,
 * ♥ and +, a thin seek bar, and plain transport icons. The large cover itself
 * is drawn by [PlayerSheet] so it can fly in from the bar; this reserves its
 * place and reports where it is.
 */
@Composable
private fun FullPlayerContent(
    vm: MainViewModel,
    now: NowPlaying,
    aura: AuraColors?,
    onClose: () -> Unit,
    onOpenQueue: () -> Unit,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
    onArtPlaced: (Rect) -> Unit,
) {
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf<Track?>(null) }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(now.trackId) { current = now.trackId?.let { vm.tracksById(listOf(it)).firstOrNull() } }
    val songProgress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f

    Box(Modifier.fillMaxSize()) {
        AuraBackground(aura, songProgress, intensity = 1.1f, base = Color.Black, modifier = Modifier.fillMaxSize())
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                BarIcon(Icons.Rounded.KeyboardArrowDown, "Close player", onClose)
                Spacer(Modifier.weight(1f))
                Box {
                    BarIcon(Icons.Rounded.MoreVert, "More options", { menu = true })
                    OneUiMenu(menu, { menu = false }) {
                        OneUiMenuItem("Album") { menu = false; current?.let(onOpenAlbum) }
                        OneUiMenuItem("Artist") { menu = false; current?.let(onOpenArtist) }
                    }
                }
            }

            Spacer(Modifier.weight(0.35f))
            // The cover's place; PlayerSheet draws the cover here.
            Box(
                Modifier
                    .fillMaxWidth(0.47f)
                    .aspectRatio(1f)
                    // Unclipped root coordinates: boundsInRoot would shrink with the sheet.
                    .onGloballyPositioned { c -> onArtPlaced(Rect(c.localToRoot(Offset.Zero), c.localToRoot(Offset(c.size.width.toFloat(), c.size.height.toFloat())))) },
            )
            Crossfade(now.title to now.artist, animationSpec = Motion.swap(), label = "titles") { (title, artist) ->
                Column(Modifier.fillMaxWidth().padding(top = 36.dp, start = 32.dp, end = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(title.ifBlank { "Nothing playing" }, style = OneUi.PlayerTitle, color = OneUi.Text1, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(artist, style = OneUi.PlayerArtist, color = OneUi.Text1, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp).clickable { current?.let(onOpenArtist) })
                }
            }
            Spacer(Modifier.weight(1f))

            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                BarIcon(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onOpenQueue)
                val isLoved = now.trackId != null && now.trackId in loved
                BarIcon(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", { now.trackId?.let { vm.toggleLoved(it) } }, tint = if (isLoved) OneUi.Primary else OneUi.Text1)
                BarIcon(Icons.Rounded.Add, "Add to queue end", { current?.let { vm.addToQueue(listOf(it)) } })
            }
            SeekBar(now, onSeek = { vm.player.seekTo(it) })
            Transport(vm, now, Modifier.padding(bottom = 28.dp))
        }
    }
}

/** Shuffle · ⏮ · ▶ · ⏭ · repeat, plain white icons as in Samsung Music. */
@Composable
private fun Transport(vm: MainViewModel, now: NowPlaying, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(88.dp).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        TransportButton(Icons.Rounded.Shuffle, "Shuffle", 26.dp, active = now.shuffle) { vm.player.toggleShuffle() }
        TransportButton(Icons.Rounded.SkipPrevious, "Previous", 34.dp) { vm.player.previous() }
        TransportButton(if (now.isPlaying) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (now.isPlaying) "Pause" else "Play", 46.dp) { vm.player.togglePlay() }
        TransportButton(Icons.Rounded.SkipNext, "Next", 34.dp) { vm.player.next() }
        TransportButton(if (now.repeatMode == Player.REPEAT_MODE_ONE) Icons.Rounded.RepeatOne else Icons.Rounded.Repeat, "Repeat", 26.dp, active = now.repeatMode != Player.REPEAT_MODE_OFF) { vm.player.cycleRepeat() }
    }
}

@Composable
private fun TransportButton(icon: ImageVector, label: String, iconSize: Dp, active: Boolean? = null, onClick: () -> Unit) {
    val tint by animateColorAsState(when (active) { null, true -> OneUi.Text1; false -> OneUi.Text1.copy(alpha = 0.45f) }, tween(Motion.SWAP_MS), label = "tint")
    Box(Modifier.size(64.dp).clip(CircleShape).pressable(onClick, 0.88f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(iconSize))
    }
}

/** Samsung's seek bar: a 3dp track at 30% white, white progress, a round thumb, times beneath. */
@Composable
private fun SeekBar(now: NowPlaying, onSeek: (Long) -> Unit, modifier: Modifier = Modifier) {
    var scrub by remember { mutableStateOf<Float?>(null) }
    val fraction = (scrub ?: if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f).coerceIn(0f, 1f)
    val thumb by animateDpAsState(if (scrub != null) 18.dp else 14.dp, spring(stiffness = 700f), label = "thumb")
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(top = 16.dp)) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(32.dp)
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
            val h = 3.dp.toPx()
            val cy = size.height / 2
            drawRoundRect(Color.White.copy(alpha = 0.3f), Offset(0f, cy - h / 2), Size(size.width, h), CornerRadius(h / 2))
            drawRoundRect(Color.White, Offset(0f, cy - h / 2), Size(size.width * fraction, h), CornerRadius(h / 2))
            drawCircle(Color.White, thumb.toPx() / 2, Offset(size.width * fraction, cy))
        }
        Row(Modifier.fillMaxWidth()) {
            Text(formatDuration((fraction * now.durationMs).toLong()), style = OneUi.Duration.copy(fontSize = OneUi.MiniArtist.fontSize * 1.1f), color = OneUi.Text1, modifier = Modifier.weight(1f))
            Text(if (now.durationMs > 0) formatDuration(now.durationMs) else "--:--", style = OneUi.Duration.copy(fontSize = OneUi.MiniArtist.fontSize * 1.1f), color = OneUi.Text1)
        }
    }
}

/**
 * The queue as Samsung shows it: over the cover's colours, "Custom order"
 * with the position counter, the songs, and the seek bar and transport at the
 * bottom.
 */
@Composable
fun QueueScreen(vm: MainViewModel, onClose: () -> Unit) {
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    LaunchedEffect(now.queue) { tracks = vm.tracksById(now.queue) }
    val listState = rememberLazyListState()
    LaunchedEffect(now.queueIndex, tracks.size) { if (now.queueIndex in tracks.indices) listState.scrollToItem((now.queueIndex - 2).coerceAtLeast(0)) }
    val songProgress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    val queueActions = TrackActions(
        onPlayNext = { vm.playNext(listOf(it)) }, onAddToQueue = { vm.addToQueue(listOf(it)) },
        onToggleLove = { vm.toggleLoved(it.id) }, onGoToAlbum = {}, onGoToArtist = {},
    )

    Box(Modifier.fillMaxSize()) {
        AuraBackground(aura, songProgress, intensity = 1f, base = Color.Black, modifier = Modifier.fillMaxSize())
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                BarIcon(Icons.Rounded.KeyboardArrowDown, "Close queue", onClose)
            }
            Row(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Rounded.Sort, null, tint = OneUi.Text2, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
                Text("Custom order", style = OneUi.Sub.copy(fontSize = OneUi.SortLabel.fontSize), color = OneUi.Text2, modifier = Modifier.weight(1f))
                Text("${now.queueIndex + 1}/${now.queue.size}", style = OneUi.SortLabel, color = OneUi.Text1)
            }
            LazyColumn(Modifier.weight(1f), state = listState, contentPadding = PaddingValues(vertical = 4.dp)) {
                itemsIndexed(tracks) { i, t ->
                    TrackRow(t, t.id in loved, i == now.queueIndex, now.isPlaying, queueActions, onClick = { vm.player.skipToQueueIndex(i) }, showDivider = false)
                }
            }
            SeekBar(now, onSeek = { vm.player.seekTo(it) })
            Transport(vm, now, Modifier.padding(bottom = 12.dp))
        }
    }
}
