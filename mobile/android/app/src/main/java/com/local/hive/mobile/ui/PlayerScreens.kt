package com.local.hive.mobile.ui

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
    onOpenQueue: () -> Unit,
    onOpenAlbum: (Track) -> Unit,
    onOpenArtist: (Track) -> Unit,
) {
    val c = Hive.colors
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
                        onOpenQueue = onOpenQueue,
                        onOpenAlbum = onOpenAlbum,
                        onOpenArtist = onOpenArtist,
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
                    .offset { IntOffset(r.left.roundToInt(), r.top.roundToInt()) }
                    .requiredSize(with(density) { r.width.toDp() }, with(density) { r.height.toDp() }),
                RoundedCornerShape(lerpDp(8.dp, 12.dp, eased)),
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

/** Hive's playbar on a phone: art, title over artist, ♥, the accent play button and next; progress along the bottom edge. */
@Composable
private fun Playbar(vm: MainViewModel, now: NowPlaying, showArt: Boolean, modifier: Modifier, onOpen: () -> Unit) {
    val c = Hive.colors
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    val progress = if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f
    val isLoved = now.trackId != null && now.trackId in loved
    Box(modifier.clickable(onClick = onOpen)) {
        Canvas(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 18.dp).height(2.dp)) {
            drawRoundRect(c.text.copy(alpha = 0.08f), cornerRadius = CornerRadius(size.height))
            drawRoundRect(c.accent, size = Size(size.width * progress.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(size.height))
        }
        Row(Modifier.fillMaxSize().padding(start = 11.dp, end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Crossfade(now.artworkUri, animationSpec = Motion.swap(), modifier = Modifier.alpha(if (showArt) 1f else 0f), label = "barArt") { art ->
                Artwork(art, Modifier.size(MiniArt), RoundedCornerShape(8.dp))
            }
            Crossfade(now.title to now.artist, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "barText") { (title, artist) ->
                Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(title.ifBlank { "Nothing playing" }, style = HiveText.rowStrong.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (artist.isNotBlank()) Text(artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            BarIcon(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", { now.trackId?.let { vm.toggleLoved(it) } }, tint = if (isLoved) c.accent else c.textDim)
            Spacer(Modifier.width(2.dp))
            AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 42.dp)
            BarIcon(Icons.Rounded.SkipNext, "Next", { vm.player.next() })
        }
    }
}

/**
 * Now Playing in Hive's voice: the ambient backdrop lit by the cover, the
 * cover itself (drawn by [PlayerSheet] so it can fly in), then the details
 * left-aligned as in Hive's now-playing panel (bold title, artist, album and
 * year, a format chip), the accent seek bar, transport around the accent play
 * button, and what plays next.
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
    val c = Hive.colors
    val loved by vm.lovedIds.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf<Track?>(null) }
    var upNext by remember { mutableStateOf<Track?>(null) }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(now.trackId, now.queueIndex, now.queue.size) {
        current = now.trackId?.let { vm.tracksById(listOf(it)).firstOrNull() }
        upNext = now.queue.getOrNull(now.queueIndex + 1)?.let { vm.tracksById(listOf(it)).firstOrNull() }
    }

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
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.KeyboardArrowDown, "Close player", tint = c.text, modifier = Modifier.size(24.dp))
                    }
                    Column(Modifier.weight(1f).clickable { current?.let(onOpenAlbum) }, horizontalAlignment = Alignment.CenterHorizontally) {
                        HiveLabel("Now playing")
                        Crossfade(now.album, animationSpec = Motion.swap(), label = "album") { album ->
                            Text(album.ifBlank { "Your library" }, style = HiveText.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
                        }
                    }
                    Box {
                        Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.MoreHoriz, "More options", tint = c.text, modifier = Modifier.size(22.dp))
                        }
                        HiveMenu(menu, { menu = false }) {
                            HiveMenuItem("Go to album", Icons.Rounded.KeyboardArrowUp) { menu = false; current?.let(onOpenAlbum) }
                            HiveMenuItem("Go to artist", Icons.Rounded.KeyboardArrowUp) { menu = false; current?.let(onOpenArtist) }
                            HiveMenuItem("Playing tracks", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; onOpenQueue() }
                        }
                    }
                }

                Spacer(Modifier.weight(0.6f))
                Box(
                    Modifier
                        .align(Alignment.CenterHorizontally)
                        .fillMaxWidth(if (compact) 0.72f else 0.86f)
                        .aspectRatio(1f)
                        .onGloballyPositioned { co -> onArtPlaced(Rect(co.localToRoot(Offset.Zero), co.localToRoot(Offset(co.size.width.toFloat(), co.size.height.toFloat())))) },
                )
                Spacer(Modifier.weight(0.6f))

                Row(Modifier.fillMaxWidth().padding(start = 26.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Crossfade(current, animationSpec = Motion.swap(), modifier = Modifier.weight(1f), label = "meta") { t ->
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(now.title.ifBlank { "Nothing playing" }, style = HiveText.npTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(now.artist, style = HiveText.rowStrong, color = c.text.copy(alpha = 0.92f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { t?.let(onOpenArtist) })
                            val sub = listOfNotNull(t?.album?.ifBlank { null }, t?.year?.takeIf { it > 0 }?.toString()).joinToString(" · ")
                            if (sub.isNotBlank()) Text(sub, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (t != null) FormatChips(t)
                        }
                    }
                    val isLoved = now.trackId != null && now.trackId in loved
                    ControlButton(if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (isLoved) "Remove from Favorites" else "Add to Favorites", { now.trackId?.let { vm.toggleLoved(it) } }, size = 46.dp, tint = if (isLoved) c.accent else null)
                }

                SeekBar(now, onSeek = { vm.player.seekTo(it) })

                Row(Modifier.fillMaxWidth().height(96.dp).padding(horizontal = 18.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    TransportButton(Icons.Rounded.Shuffle, "Shuffle", 24.dp, active = now.shuffle) { vm.player.toggleShuffle() }
                    TransportButton(Icons.Rounded.SkipPrevious, "Previous", 36.dp) { vm.player.previous() }
                    AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 74.dp)
                    TransportButton(Icons.Rounded.SkipNext, "Next", 36.dp) { vm.player.next() }
                    TransportButton(if (now.repeatMode == Player.REPEAT_MODE_ONE) Icons.Rounded.RepeatOne else Icons.Rounded.Repeat, "Repeat", 24.dp, active = now.repeatMode != Player.REPEAT_MODE_OFF) { vm.player.cycleRepeat() }
                }

                Row(
                    Modifier.padding(horizontal = 12.dp).padding(bottom = 12.dp).fillMaxWidth().height(58.dp).hiveGlass(HiveShape.menu).clickable(onClick = onOpenQueue).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.AutoMirrored.Rounded.QueueMusic, null, tint = c.accent, modifier = Modifier.size(20.dp))
                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                        HiveLabel("Playing tracks")
                        Text(upNext?.let { "Next: " + listOf(it.title, it.artist).filter { s -> s.isNotBlank() }.joinToString(" · ") } ?: "${now.queueIndex + 1} of ${now.queue.size}", style = HiveText.small, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(Icons.Rounded.KeyboardArrowUp, null, tint = c.textDim)
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
private fun TransportButton(icon: ImageVector, label: String, iconSize: Dp, active: Boolean? = null, onClick: () -> Unit) {
    val c = Hive.colors
    val tint by animateColorAsState(when (active) { null -> c.text; true -> c.accent; false -> c.textDim }, tween(150), label = "tint")
    Box(Modifier.size(56.dp).clip(CircleShape).pressable(onClick, 0.86f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(iconSize))
        if (active == true) Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 6.dp).size(4.dp).clip(CircleShape).background(c.accent))
    }
}

/** Hive's seek row: the control track, accent progress, a thumb that grows under the finger, tabular times. */
@Composable
private fun SeekBar(now: NowPlaying, onSeek: (Long) -> Unit) {
    val c = Hive.colors
    var scrub by remember { mutableStateOf<Float?>(null) }
    val fraction = (scrub ?: if (now.durationMs > 0) now.positionMs.toFloat() / now.durationMs else 0f).coerceIn(0f, 1f)
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

/** Hive's "Playing tracks": the queue over the ambient backdrop; tap to jump, ✕ to remove. */
@Composable
fun QueueScreen(vm: MainViewModel, onClose: () -> Unit) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var tracks by remember { mutableStateOf<List<Track>>(emptyList()) }
    LaunchedEffect(now.queue) { tracks = vm.tracksById(now.queue) }
    val listState = rememberLazyListState()
    LaunchedEffect(now.queueIndex, tracks.size) { if (now.queueIndex in tracks.indices) listState.scrollToItem((now.queueIndex - 2).coerceAtLeast(0)) }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        HiveAmbient(aura?.primary?.copy(alpha = 0.6f) ?: c.ambientA, aura?.secondary?.copy(alpha = 0.5f) ?: c.ambientB, Modifier.fillMaxSize().background(c.bg))
    }, overlay = {
        Column(Modifier.fillMaxSize().statusBarsPadding().padding(top = 16.dp).hiveGlass(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)).navigationBarsPadding()) {
            Box(Modifier.fillMaxWidth().padding(top = 10.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.width(36.dp).height(4.dp).clip(HiveShape.pill).background(c.text.copy(alpha = 0.22f)))
            }
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 10.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Playing tracks", style = HiveText.viewTitle, color = c.text)
                    Text("${now.queueIndex + 1} of ${now.queue.size} · ${formatLength(tracks.drop(now.queueIndex + 1).sumOf { it.durationMs })} left", style = HiveText.small, color = c.textDim)
                }
                Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.KeyboardArrowDown, "Close queue", tint = c.text, modifier = Modifier.size(24.dp))
                }
            }
            LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 20.dp)) {
                itemsIndexed(tracks) { i, t ->
                    val playing = i == now.queueIndex
                    val past = i < now.queueIndex
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(58.dp).clip(HiveShape.row)
                            .background(if (playing) c.accentSoft.copy(alpha = 0.3f) else Color.Transparent)
                            .clickable { vm.player.skipToQueueIndex(i) }.alpha(if (past) 0.5f else 1f).padding(start = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(if (playing) c.accent else Color.Transparent))
                        Spacer(Modifier.width(8.dp))
                        Artwork(t.artworkUri, Modifier.size(40.dp).then(if (playing) Modifier.border(1.dp, c.accentSoft, HiveShape.thumb) else Modifier))
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(t.title, style = HiveText.row, color = if (playing) c.text else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(t.artist, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Text(formatDuration(t.durationMs), style = HiveText.numbers, color = c.textDimmer)
                        if (!playing) Box(Modifier.size(44.dp).clip(CircleShape).clickable { vm.player.removeFromQueue(i) }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.Close, "Remove from queue", tint = c.textDimmer, modifier = Modifier.size(17.dp))
                        } else Spacer(Modifier.width(44.dp))
                    }
                }
            }
        }
    })
}
