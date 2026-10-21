package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
import android.os.Build
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.Download
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveAmbient
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.hiveGlass
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.animation.core.animateFloat
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Lyrics
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.ui.zIndex
import androidx.compose.material.icons.rounded.DragHandle
import androidx.compose.runtime.produceState
import com.local.hive.mobile.playback.SleepTimer
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Timer
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Album
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.hazeEffect
import com.local.hive.mobile.ui.theme.LocalHiveHaze
import com.local.hive.mobile.ui.theme.mix
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt
import androidx.compose.ui.unit.lerp as lerpDp

private val MiniHeight = 68.dp
private val MiniMargin = 8.dp
private val MiniArt = 46.dp

/**
 * The player as one surface that grows from Hive's glass playbar into Now
 * Playing: the bar widens to the screen, the ambient backdrop comes up, and
 * the cover flies from the bar's thumbnail to the large cover. Drag it by
 * hand; it settles in 350 ms, quicker for a harder flick.
 */
@Composable
fun PlayerSheet(
    vm: MainViewModel,
    open: Boolean,
    onOpenChange: (Boolean) -> Unit,
    queueOpen: Boolean,
    onQueueChange: (Boolean) -> Unit,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
    onInfo: (Track) -> Unit,
    onAddToPlaylist: (Track) -> Unit,
    onOpenLyrics: () -> Unit,
    onOpenEqualiser: () -> Unit,
    onToast: (String) -> Unit = {},
) {
    val c = Hive.colors
    // The cover follows a sideways swipe on Now Playing; let go far or fast enough and the song changes.
    val swipe = remember { Animatable(0f) }
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    val density = LocalDensity.current
    val progress = remember { Animatable(if (open) 1f else 0f) }
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    var dragStart by remember { mutableFloatStateOf(0f) }
    var settleMs by remember { mutableStateOf<Int?>(null) }
    var artTarget by remember { mutableStateOf<Rect?>(null) }
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val glass by animateColorAsState(mix(c.accent, c.panelStrong.copy(alpha = 0.78f), 0.09f), tween(900), label = "barGlass")
    // Frosted like Hive's player bar: what scrolls under the bar is blurred, not just tinted.
    val haze = LocalHiveHaze.current
    val edge by animateColorAsState(mix(c.accent, c.border, 0.14f), tween(900), label = "barEdge")

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
        val left = margin * (1 - p)
        val top = miniTop * (1 - p)
        val width = fullW - 2 * left
        val height = miniH + travel * p
        val corner = lerpDp(20.dp, 0.dp, p)

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
                .shadow(lerpDp(18.dp, 0.dp, p), RoundedCornerShape(corner), ambientColor = c.accentGlow, spotColor = Color.Black)
                .clip(RoundedCornerShape(corner))
                .then(if (haze != null) Modifier.hazeEffect(haze, HazeStyle(backgroundColor = c.bg, tint = HazeTint(Color.Transparent), blurRadius = 28.dp, noiseFactor = 0.03f)) else Modifier)
                .background(lerp(glass, c.bg, p))
                .border(1.dp, edge.copy(alpha = edge.alpha * (1 - p)), RoundedCornerShape(corner)),
        ) {
            // One layer pinned to the screen holds the bar's controls and Now
            // Playing; the drag on it reads the finger against the screen.
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
                        queueOpen = queueOpen,
                        onQueueChange = onQueueChange,
                        swipe = swipe,
                        onOpenAlbum = onOpenAlbum,
                        onInfo = onInfo,
                        onAddToPlaylist = onAddToPlaylist,
                        onOpenLyrics = onOpenLyrics,
                        onOpenEqualiser = onOpenEqualiser,
                        onOpenArtist = onOpenArtist,
                        onToast = onToast,
                        onArtPlaced = { artTarget = it },
                    )
                }
                if (p < 0.3f) {
                    Playbar(
                        vm, now,
                        showArt = p == 0f,
                        modifier = Modifier
                            .offset { IntOffset(margin.roundToInt(), miniTop.roundToInt()) }
                            .requiredSize(with(density) { (fullW - 2 * margin).toDp() }, MiniHeight)
                            .alpha((1f - p / 0.25f).coerceIn(0f, 1f)),
                        onOpen = { onOpenChange(true) },
                        onOpenQueue = { onQueueChange(true) },
                    )
                }
            }
        }

        // The cover, flying between the bar's thumbnail and the large cover.
        val miniArtSize = with(density) { MiniArt.toPx() }
        val from = Rect(Offset(margin + with(density) { 11.dp.toPx() }, miniTop + (miniH - miniArtSize) / 2), Size(miniArtSize, miniArtSize))
        val to = artTarget
        if (to != null && p > 0f) {
            val eased = Motion.SineInOut80.transform(p)
            val r = androidx.compose.ui.geometry.lerp(from, to, eased)
            Artwork(
                now.artworkUri,
                Modifier
                    .offset { IntOffset((r.left + swipe.value * p).roundToInt(), r.top.roundToInt()) }
                    .requiredSize(with(density) { r.width.toDp() }, with(density) { r.height.toDp() })
                    .graphicsLayer { val f = (abs(swipe.value) / r.width).coerceIn(0f, 1f); alpha = 1f - f * 0.9f; rotationZ = swipe.value / r.width * 4f },
                RoundedCornerShape(lerpDp(8.dp, 18.dp, eased)),
                if (now.isLive) Icons.Rounded.Radio else Icons.Rounded.MusicNote,
                glow = aura?.primary ?: c.accentGlow,
                elevation = lerpDp(0.dp, 36.dp, eased),
            )
        }
    }
}

/**
 * A vertical drag on a layer pinned to the screen, so its local positions are
 * screen positions even while the sheet moves. Only an unconsumed, mostly
 * vertical drag past touch slop starts it, so taps, buttons and the seek bar
 * keep working.
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

/**
 * The mini player: Hive's frosted bar holding Samsung Music's controls (cover,
 * song over artist, then Previous, Play, Next and Queue), the progress along
 * its lower edge. Swipe the song sideways to change it.
 */
@Composable
private fun Playbar(vm: MainViewModel, now: NowPlaying, showArt: Boolean, modifier: Modifier, onOpen: () -> Unit, onOpenQueue: () -> Unit) {
    val c = Hive.colors
    // Read while drawing only: the ticking position redraws the line, nothing else.
    val position = vm.position.collectAsStateWithLifecycle()
    val shift = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    Box(modifier.clickable(onClick = onOpen)) {
        Canvas(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 18.dp).height(2.dp)) {
            drawRoundRect(c.text.copy(alpha = 0.08f), cornerRadius = CornerRadius(size.height))
            val progress = if (now.durationMs > 0) position.value.toFloat() / now.durationMs else 0f
            drawRoundRect(c.accent, size = Size(size.width * progress.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(size.height))
        }
        Row(Modifier.fillMaxSize().padding(start = 11.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).fillMaxHeight()
                    .songSwipe(shift, scope, onNext = { vm.player.next() }, onPrevious = { vm.player.previous() })
                    .graphicsLayer { translationX = shift.value; alpha = 1f - (abs(shift.value) / size.width).coerceIn(0f, 1f) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Crossfade(now.artworkUri, animationSpec = Motion.swap(), modifier = Modifier.alpha(if (showArt) 1f else 0f), label = "barArt") { art ->
                    Artwork(art, Modifier.size(MiniArt), RoundedCornerShape(8.dp), if (now.isLive) Icons.Rounded.Radio else Icons.Rounded.MusicNote)
                }
                Crossfade(now.title to now.artist, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "barText") { (title, artist) ->
                    Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(title.ifBlank { "Nothing playing" }, style = HiveText.rowStrong.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (artist.isNotBlank()) Text(artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            BarIcon(HiveIcons.Previous, "Previous", { vm.player.previous() })
            AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 42.dp)
            BarIcon(HiveIcons.Next, "Next", { vm.player.next() })
            BarIcon(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", onOpenQueue, tint = c.textDim)
        }
    }
}

/**
 * A sideways swipe that changes the song: what's under the finger follows it
 * one-to-one, and on release it either flies off (a third of the way, or a
 * flick) and comes back in from the other side with the new song, or springs
 * back.
 */
internal fun Modifier.songSwipe(shift: Animatable<Float, *>, scope: kotlinx.coroutines.CoroutineScope, onNext: () -> Unit, onPrevious: () -> Unit): Modifier = composed {
    val next by rememberUpdatedState(onNext)
    val previous by rememberUpdatedState(onPrevious)
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    pointerInput(Unit) {
        val tracker = VelocityTracker()
        detectHorizontalDragGestures(
            onDragStart = { tracker.resetTracking(); scope.launch { shift.stop() } },
            onDragEnd = {
                val v = tracker.calculateVelocity().x
                val w = size.width.toFloat()
                val go = when {
                    shift.value < -w / 3 || v < -1_200f -> -1
                    shift.value > w / 3 || v > 1_200f -> 1
                    else -> 0
                }
                scope.launch {
                    if (go == 0) { shift.animateTo(0f, spring(dampingRatio = 0.8f, stiffness = 500f), v); return@launch }
                    haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.SegmentTick)
                    shift.animateTo(go * w * 0.6f, tween(140, easing = Motion.SineOut90), v)
                    if (go < 0) next() else previous()
                    shift.snapTo(-go * w * 0.35f)
                    shift.animateTo(0f, tween(Motion.SWAP_MS, easing = Motion.Open))
                }
            },
            onDragCancel = { scope.launch { shift.animateTo(0f) } },
        ) { change, dx ->
            change.consume()
            tracker.addPosition(change.uptimeMillis, change.position)
            scope.launch { shift.snapTo(shift.value + dx) }
        }
    }
}

/**
 * Now Playing, arranged as Samsung Music arranges it and lit as Hive lights
 * it: the cover-coloured ambient backdrop; the cover (drawn by [PlayerSheet]
 * so it can fly in, and swiped sideways to change songs); the song on the
 * left with ♥ on the right; a thin seek bar; the transport; and Lyrics and
 * the queue beneath. The queue opens right here: the cover shrinks to a
 * thumbnail beside the song and the queue fills the space it left.
 */
@Composable
private fun FullPlayerContent(
    vm: MainViewModel,
    now: NowPlaying,
    aura: AuraColors?,
    onClose: () -> Unit,
    queueOpen: Boolean,
    onQueueChange: (Boolean) -> Unit,
    swipe: Animatable<Float, *>,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
    onInfo: (Track) -> Unit,
    onAddToPlaylist: (Track) -> Unit,
    onOpenLyrics: () -> Unit,
    onOpenEqualiser: () -> Unit,
    onToast: (String) -> Unit,
    onArtPlaced: (Rect) -> Unit,
) {
    val c = Hive.colors
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf<Track?>(null) }
    val upNext = now.queue.getOrNull(now.queueIndex + 1)
    var menu by remember { mutableStateOf(false) }
    var sleepMenu by remember { mutableStateOf(false) }
    var speedMenu by remember { mutableStateOf(false) }
    val sleep by vm.sleep.collectAsStateWithLifecycle()
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val queueShown by androidx.compose.animation.core.animateFloatAsState(if (queueOpen) 1f else 0f, if (queueOpen) Motion.open() else Motion.close(), label = "queue")
    LaunchedEffect(now.trackId, now.queueIndex, now.queue.size) {
        current = now.trackId?.let { vm.tracksById(listOf(it)).firstOrNull() }
    }
    val isLoved = now.trackId != null && now.trackId in loved

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        HiveAmbient(aura?.primary?.copy(alpha = 0.7f) ?: c.ambientA, aura?.secondary?.copy(alpha = 0.6f) ?: c.ambientB, Modifier.fillMaxSize(), intensity = 1.25f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Artwork(now.artworkUri, Modifier.fillMaxSize().blur(110.dp).alpha(0.22f), RectangleShape)
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Transparent, 0.6f to c.bg.copy(alpha = 0.2f), 1f to c.bg.copy(alpha = 0.75f))))
    }, overlay = {
        BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            val compact = maxHeight < 700.dp
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    BarIcon(Icons.Rounded.KeyboardArrowDown, "Close player", onClose)
                    Column(Modifier.weight(1f).clickable { current?.let(onOpenAlbum) }, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (queueOpen) "Playing tracks" else "Now playing", style = HiveText.small, color = c.textDim)
                        Crossfade(now.album, animationSpec = Motion.swap(), label = "album") { album ->
                            Text(album.ifBlank { "Your library" }, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
                        }
                    }
                    Box {
                        BarIcon(Icons.Rounded.MoreVert, "More options", { menu = true })
                        HiveMenu(menu, { menu = false }) {
                            if (current != null) {
                                HiveMenuItem("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { menu = false; current?.let(onAddToPlaylist) }
                                HiveMenuItem("Share", Icons.Rounded.Share) { menu = false; current?.let { Share.tracks(context, listOf(it)) } }
                                HiveMenuItem("Go to album", Icons.Rounded.Album) { menu = false; current?.let(onOpenAlbum) }
                                HiveMenuItem("Go to artist", Icons.Rounded.Person) { menu = false; current?.let(onOpenArtist) }
                                HiveMenuItem("Track details", Icons.Rounded.Info) { menu = false; current?.let(onInfo) }
                                HiveMenuDivider()
                            }
                            // A song from Apple Music or Spotify that isn't on the phone can be saved to it.
                            val streamed = now.trackId == null && (now.mediaId?.startsWith("am:") == true || now.mediaId?.startsWith("sp:") == true)
                            if (streamed) {
                                val saving = now.mediaId in vm.downloading.collectAsStateWithLifecycle().value
                                HiveMenuItem(if (saving) "Downloading…" else "Download", Icons.Rounded.Download) {
                                    menu = false
                                    if (!saving) { onToast("Downloading “${now.title}”…"); vm.download(now, onToast) }
                                }
                                HiveMenuDivider()
                            }
                            if (now.mediaId?.startsWith("pod:") == true) HiveMenuItem("Speed · ${"%.2g".format(now.speed)}×", Icons.Rounded.Speed) { menu = false; speedMenu = true }
                            HiveMenuItem("Equaliser", Icons.Rounded.GraphicEq) { menu = false; onOpenEqualiser() }
                            HiveMenuItem(sleepLabel(sleep), Icons.Rounded.Bedtime) { menu = false; sleepMenu = true }
                        }
                        HiveMenu(speedMenu, { speedMenu = false }) {
                            listOf(0.8f, 1f, 1.2f, 1.5f, 1.75f, 2f).forEach { x -> HiveMenuItem("${"%.2g".format(x)}×", if (now.speed == x) Icons.Rounded.Check else null) { speedMenu = false; vm.player.setSpeed(x) } }
                        }
                        HiveMenu(sleepMenu, { sleepMenu = false }) {
                            listOf(15, 30, 45, 60, 90).forEach { m -> HiveMenuItem("$m minutes", Icons.Rounded.Timer) { sleepMenu = false; vm.setSleepTimer(m) } }
                            HiveMenuItem("End of song", Icons.Rounded.MusicNote) { sleepMenu = false; vm.sleepAtEndOfSong() }
                            if (sleep != null) { HiveMenuDivider(); HiveMenuItem("Turn off", Icons.Rounded.Close, destructive = true) { sleepMenu = false; vm.cancelSleepTimer() } }
                        }
                    }
                }

                // The stage: the cover at full size, or as a thumbnail over the queue.
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    val full = minOf(maxWidth * (if (compact) 0.74f else 0.86f), maxHeight - 12.dp)
                    val small = 60.dp
                    val q = queueShown
                    val size = lerpDp(full, small, q)
                    val x = lerpDp((maxWidth - full) / 2, 20.dp, q)
                    val y = lerpDp((maxHeight - full) / 2, 4.dp, q)
                    Box(
                        Modifier
                            .offset(x, y)
                            .size(size)
                            .onGloballyPositioned { co -> onArtPlaced(Rect(co.localToRoot(Offset.Zero), co.localToRoot(Offset(co.size.width.toFloat(), co.size.height.toFloat())))) }
                            .then(if (!queueOpen) Modifier.songSwipe(swipe, scope, onNext = { vm.player.next() }, onPrevious = { vm.player.previous() }) else Modifier.clickable { onQueueChange(false) }),
                    )
                    if (q > 0f) {
                        Column(Modifier.offset(20.dp + small + 14.dp, 4.dp).height(small).padding(end = 96.dp).alpha(q), verticalArrangement = Arrangement.Center) {
                            Text(now.title.ifBlank { "Nothing playing" }, style = HiveText.rowStrong.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(now.artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (now.trackId != null) Box(Modifier.align(Alignment.TopEnd).padding(top = 10.dp, end = 12.dp).alpha(q)) {
                            BarIcon(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", { now.trackId?.let { vm.toggleLoved(it) } }, tint = if (isLoved) c.accent else c.textDim)
                        }
                        QueueList(vm, Modifier.fillMaxSize().padding(top = small + 16.dp).graphicsLayer { alpha = q; translationY = (1f - q) * 48.dp.toPx() })
                    }
                }

                androidx.compose.animation.AnimatedVisibility(!queueOpen, enter = androidx.compose.animation.expandVertically(Motion.close()) + androidx.compose.animation.fadeIn(Motion.close()), exit = androidx.compose.animation.shrinkVertically(Motion.open()) + androidx.compose.animation.fadeOut(Motion.underFade())) {
                    Row(Modifier.fillMaxWidth().padding(start = 26.dp, end = 14.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Crossfade(current, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "meta") { t ->
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(now.title.ifBlank { "Nothing playing" }, style = HiveText.npTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(now.artist, style = HiveText.rowStrong, color = c.text.copy(alpha = 0.86f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { t?.let(onOpenArtist) })
                                if (t != null) FormatChips(t)
                            }
                        }
                        if (now.trackId != null) TransportButton(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", 26.dp, tint = if (isLoved) c.accent else c.text) { now.trackId?.let { vm.toggleLoved(it) } }
                    }
                }

                SeekBar(now, vm.position, onSeek = { vm.player.seekTo(it) })

                Row(Modifier.fillMaxWidth().height(if (compact) 80.dp else 92.dp).padding(horizontal = 18.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    // Shuffle and repeat mean nothing to a live station; their places stay so the row doesn't jump.
                    if (now.isLive) Spacer(Modifier.size(48.dp)) else ShuffleButton(now.shuffle) { vm.player.toggleShuffle() }
                    TransportButton(HiveIcons.Previous, "Previous", 36.dp) { vm.player.previous() }
                    AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 72.dp)
                    TransportButton(HiveIcons.Next, "Next", 36.dp) { vm.player.next() }
                    if (now.isLive) Spacer(Modifier.size(48.dp)) else RepeatButton(now.repeatMode) { vm.player.cycleRepeat() }
                }

                // Lyrics on the left, what's next in the middle, the queue on the right.
                Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 8.dp).height(52.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (!now.isLive) TransportButton(Icons.Rounded.Lyrics, "Lyrics", 22.dp) { onOpenLyrics() } else Spacer(Modifier.size(56.dp))
                    Text(
                        if (queueOpen) "${now.queueIndex + 1} of ${now.queue.size} · ${formatLength(now.queue.drop(now.queueIndex + 1).sumOf { it.durationMs })} left"
                        else upNext?.let { "Next: " + listOf(it.title, it.artist).filter { s -> s.isNotBlank() }.joinToString(" · ") } ?: "",
                        style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.weight(1f).clip(HiveShape.pill).clickable { onQueueChange(!queueOpen) }.padding(horizontal = 8.dp, vertical = 10.dp),
                    )
                    TransportButton(Icons.AutoMirrored.Rounded.QueueMusic, if (queueOpen) "Close queue" else "Queue", 24.dp, active = if (queueOpen) true else null) { onQueueChange(!queueOpen) }
                }
            }
        }
    })
}

/** Small chips under the title (Hive shows format and bitrate there). */
@Composable
private fun FormatChips(t: Track) {
    val c = Hive.colors
    val ext = t.fileName.substringAfterLast('.', "").uppercase().takeIf { it.isNotBlank() && it.length <= 5 }
    val kbps = if (t.durationMs > 0 && t.sizeBytes > 0) (t.sizeBytes * 8 / (t.durationMs / 1000.0) / 1000).roundToInt() else null
    Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        listOfNotNull(ext, kbps?.let { "~$it kbps" }).forEach { label ->
            Box(Modifier.clip(RoundedCornerShape(6.dp)).background(mix(c.accent, c.panelStrong, 0.10f)).border(1.dp, c.border, RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 2.dp)) {
                Text(label, style = HiveText.label, color = c.textDim)
            }
        }
    }
}

@Composable
internal fun TransportButton(icon: ImageVector, label: String, iconSize: Dp, active: Boolean? = null, tint: Color? = null, onClick: () -> Unit) {
    val c = Hive.colors
    val shown by animateColorAsState(tint ?: when (active) { null -> c.text; true -> c.accent; false -> c.textDim }, tween(150), label = "tint")
    Box(Modifier.size(56.dp).clip(CircleShape).pressable(onClick, 0.86f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = shown, modifier = Modifier.size(iconSize))
        if (active == true) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp).size(4.dp).clip(CircleShape).background(c.accent))
    }
}

/** Hive's shuffle button, as on the PC: straight arrows when off, crossed (and lit) when on. */
@Composable
internal fun ShuffleButton(on: Boolean, onClick: () -> Unit) =
    TransportButton(if (on) HiveIcons.Shuffle else HiveIcons.ShuffleOff, if (on) "Shuffle on" else "Shuffle off", 26.dp, active = on, onClick = onClick)

/** Hive's repeat button, as on the PC: off (struck through), the whole queue, or one song. */
@Composable
internal fun RepeatButton(mode: Int, onClick: () -> Unit) = when (mode) {
    Player.REPEAT_MODE_ONE -> TransportButton(HiveIcons.RepeatOne, "Repeat single song", 26.dp, active = true, onClick = onClick)
    Player.REPEAT_MODE_ALL -> TransportButton(HiveIcons.RepeatAll, "Repeat queue", 26.dp, active = true, onClick = onClick)
    else -> TransportButton(HiveIcons.RepeatOff, "Play through and stop", 26.dp, active = false, onClick = onClick)
}

/** Hive's seek row: the control track, accent progress, a thumb that grows under the finger, tabular times. */
@Composable
internal fun SeekBar(now: NowPlaying, position: kotlinx.coroutines.flow.StateFlow<Long>, onSeek: (Long) -> Unit) {
    val c = Hive.colors
    if (now.isLive) { LiveBar(now); return }
    val positionMs by position.collectAsStateWithLifecycle()
    var scrub by remember { mutableStateOf<Float?>(null) }
    val fraction = (scrub ?: if (now.durationMs > 0) positionMs.toFloat() / now.durationMs else 0f).coerceIn(0f, 1f)
    val thumb by animateDpAsState(if (scrub != null) 18.dp else 12.dp, spring(stiffness = 700f), label = "thumb")
    val track by animateDpAsState(if (scrub != null) 6.dp else 4.dp, spring(stiffness = 700f), label = "track")
    Column(Modifier.fillMaxWidth().padding(horizontal = 26.dp).padding(top = 18.dp)) {
        Canvas(
            Modifier.fillMaxWidth().height(28.dp)
                .pointerInput(now.durationMs) { detectTapGestures { onSeek(((it.x / size.width).coerceIn(0f, 1f) * now.durationMs).toLong()) } }
                .pointerInput(now.durationMs) {
                    detectHorizontalDragGestures(
                        onDragStart = { scrub = (it.x / size.width).coerceIn(0f, 1f) },
                        onDragEnd = { scrub?.let { onSeek((it * now.durationMs).toLong()) }; scrub = null },
                        onDragCancel = { scrub = null },
                    ) { change, _ -> scrub = (change.position.x / size.width).coerceIn(0f, 1f) }
                },
        ) {
            val h = track.toPx()
            val cy = size.height / 2
            drawRoundRect(c.text.copy(alpha = 0.12f), Offset(0f, cy - h / 2), Size(size.width, h), CornerRadius(h / 2))
            drawRoundRect(c.accent, Offset(0f, cy - h / 2), Size(size.width * fraction, h), CornerRadius(h / 2))
            drawCircle(c.accentGlow, thumb.toPx(), Offset(size.width * fraction, cy))
            drawCircle(c.text, thumb.toPx() / 2, Offset(size.width * fraction, cy))
        }
        Row(Modifier.fillMaxWidth()) {
            Text(formatDuration((fraction * now.durationMs).toLong()), style = HiveText.numbers, color = c.textDim, modifier = Modifier.weight(1f))
            Text(if (now.durationMs > 0) "-" + formatDuration(now.durationMs - (fraction * now.durationMs).toLong()) else "--:--", style = HiveText.numbers, color = c.textDim)
        }
    }
}

/** The queue inside Now Playing: tap to jump, ✕ to remove, drag the handle to move. */
@Composable
private fun QueueList(vm: MainViewModel, modifier: Modifier) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val tracks = now.queue
    // Stable row keys (song and occurrence), so a reordered queue coming back from the player doesn't flicker.
    val keys = remember(tracks) { val seen = HashMap<String, Int>(); tracks.map { t -> val n = seen.merge(t.mediaId, 1, Int::plus)!!; "${t.mediaId}#$n" } }
    var order by remember(keys) { mutableStateOf(keys) }
    var dragKey by remember { mutableStateOf<String?>(null) }
    var dragFrom by remember { mutableIntStateOf(-1) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    val rowPx = with(LocalDensity.current) { QueueRow.toPx() }
    val listState = rememberLazyListState()
    LaunchedEffect(now.queueIndex, tracks.size) { if (now.queueIndex in tracks.indices) listState.scrollToItem((now.queueIndex - 2).coerceAtLeast(0)) }

    Box(modifier) {
            LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 20.dp)) {
                itemsIndexed(order, key = { _, k -> k }) { _, k ->
                    val i = keys.indexOf(k)
                    val t = tracks[i]
                    val playing = i == now.queueIndex
                    val past = i < now.queueIndex
                    val lifted = dragKey == k
                    Row(
                        Modifier.then(if (lifted) Modifier.zIndex(1f).graphicsLayer { translationY = dragOffset; scaleX = 1.02f; scaleY = 1.02f } else Modifier.animateItem())
                            .fillMaxWidth().padding(horizontal = 8.dp).height(QueueRow)
                            .then(if (lifted) Modifier.shadow(16.dp, HiveShape.row, ambientColor = c.accentGlow) else Modifier)
                            .clip(HiveShape.row)
                            .background(when { lifted -> c.control; playing -> c.accentSoft.copy(alpha = 0.3f); else -> Color.Transparent })
                            .clickable { vm.player.skipToQueueIndex(i) }.alpha(if (past && !lifted) 0.5f else 1f).padding(start = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(if (playing) c.accent else Color.Transparent))
                        Spacer(Modifier.width(8.dp))
                        Artwork(t.artworkUri, Modifier.size(40.dp).then(if (playing) Modifier.border(1.dp, c.accentSoft, HiveShape.thumb) else Modifier))
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(t.title, style = HiveText.row, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(t.artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Text(formatDuration(t.durationMs), style = HiveText.numbers, color = c.textDimmer)
                        if (!playing) Box(Modifier.size(40.dp).clip(CircleShape).clickable { vm.player.removeFromQueue(i) }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.Close, "Remove from queue", tint = c.textDimmer, modifier = Modifier.size(17.dp))
                        } else Spacer(Modifier.width(40.dp))
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
                    }
                }
            }
    }
}

/** "Sleep timer", or what is left of it; the minutes tick down while the menu is shown. */
@Composable
private fun sleepLabel(sleep: SleepTimer?): String {
    val now by produceState(System.currentTimeMillis(), sleep) { while (true) { value = System.currentTimeMillis(); kotlinx.coroutines.delay(15_000) } }
    return when {
        sleep == null -> "Sleep timer"
        sleep.endOfSong -> "Sleep timer · end of song"
        else -> "Sleep timer · ${((sleep.endsAt!! - now + 59_999) / 60_000).coerceAtLeast(1)} min left"
    }
}

private val QueueRow = 58.dp

/** In place of the seek bar for a radio station: a pulsing LIVE mark and the station. */
@Composable
private fun LiveBar(now: NowPlaying) {
    val c = Hive.colors
    val pulse = androidx.compose.animation.core.rememberInfiniteTransition(label = "live")
    val a by pulse.animateFloat(1f, 0.25f, androidx.compose.animation.core.infiniteRepeatable(tween(900), androidx.compose.animation.core.RepeatMode.Reverse), label = "liveDot")
    Row(Modifier.fillMaxWidth().padding(horizontal = 26.dp).padding(top = 18.dp).height(46.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).alpha(if (now.isPlaying) a else 0.4f).clip(CircleShape).background(Color(0xFFFF5A5A)))
        Spacer(Modifier.width(8.dp))
        Text("LIVE", style = HiveText.label, color = c.text)
        Spacer(Modifier.width(10.dp))
        Text(now.station, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
