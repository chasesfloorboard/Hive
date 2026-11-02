package com.local.hive.mobile.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.ThemePack
import com.local.hive.mobile.ui.theme.ThemeStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.hypot

/** How long a theme shows in the bubble before the next opens inside it, while the logo is held. */
private const val DWELL_MS = 1_300L
/** The bubble, held: this share of the way from the logo to the screen's far corner. */
private const val BUBBLE = 0.45f
/** Fast out of the logo, settling as it fills the bubble. */
private val Spread = CubicBezierEasing(0.3f, 0f, 0f, 1f)

/**
 * Themes opening out of Hive's logo. The screen as it was is kept as a
 * picture over the app, and the new theme shows through a bubble cut in it:
 * held, the bubble bounces open around the logo; each further theme opens
 * inside it with a little pop. The finger's distance from the logo closes it
 * softly; let go on the logo and it fills the screen, let go away and it
 * snaps shut on the old theme. Its edge catches the new accent and casts a
 * soft shadow on the old theme.
 */
class ThemeReveal internal constructor(internal val layer: GraphicsLayer, private val scope: CoroutineScope) {
    internal class Ring(val image: ImageBitmap, val radius: Animatable<Float, AnimationVector1D>)

    /** The first is the bubble over the theme to come back to; any others are themes being covered inside it. */
    internal val rings = mutableStateListOf<Ring>()
    /** How open the bubble is: the finger's distance from the logo closes it. */
    internal val pull = Animatable(1f)
    internal var origin by mutableStateOf(Offset.Zero)
    internal var width = 0f
    internal var height = 0f
    private var ending: Job? = null

    /** A theme is open or settling: a new hold waits until it's done. */
    val busy get() = rings.isNotEmpty() || ending?.isActive == true

    /** From the logo to the screen's farthest corner. */
    private fun reach() = maxOf(hypot(origin.x, origin.y), hypot(width - origin.x, origin.y), hypot(origin.x, height - origin.y), hypot(width - origin.x, height - origin.y))

    /** Keeps the screen as it is, shows [apply]'s theme, and opens it out of the logo. */
    internal suspend fun spread(apply: () -> Unit) {
        val ring = Ring(layer.toImageBitmap(), Animatable(0f))
        rings += ring
        apply()
        val bubble = rings.first().radius
        val size = reach() * BUBBLE
        if (ring.radius === bubble) {
            // Cheerfully: past its size and back, twice over.
            scope.launch { bubble.animateTo(size, spring(dampingRatio = 0.42f, stiffness = 240f)) }
        } else {
            // A pop of the bubble as the next theme fills it from the logo.
            scope.launch { bubble.animateTo(size * 1.07f, spring(dampingRatio = 0.6f, stiffness = 900f)); bubble.animateTo(size, spring(dampingRatio = 0.42f, stiffness = 300f)) }
            scope.launch {
                ring.radius.animateTo(size * 1.15f, tween(480, easing = Spread))
                // Covered now: the themes it covered go.
                val at = rings.indexOf(ring)
                if (at > 1) rings.removeRange(1, at)
            }
        }
    }

    /** A theme switching by itself (the schedule): it bounces open out of the logo, then fills the screen. */
    internal val present: (() -> Unit) -> Unit = { apply ->
        scope.launch {
            if (busy) { apply(); return@launch }
            spread(apply)
            delay(900)
            end(keep = true) {}
        }
    }

    /** Toward [open] softly, so a slow finger closes the bubble slowly. */
    internal fun follow(open: Float) { scope.launch { pull.animateTo(open, spring(dampingRatio = 1f, stiffness = 170f)) } }

    /** Let go on the logo: the theme fills the screen and stays. Away: it snaps shut on [restore]'s theme. */
    internal fun end(keep: Boolean, restore: () -> Unit) {
        ending = scope.launch {
            if (keep) {
                val reach = reach()
                val fills = rings.map { r -> launch { r.radius.animateTo(reach, spring(dampingRatio = 0.9f, stiffness = 200f)) } }
                pull.animateTo(1f, spring(dampingRatio = 0.8f, stiffness = 400f))
                fills.forEach { it.join() }
            } else {
                pull.animateTo(0f, spring(dampingRatio = 0.75f, stiffness = 900f))
                restore()
                // The old theme is drawn underneath before its picture goes, so nothing blinks.
                androidx.compose.runtime.withFrameNanos { }
                androidx.compose.runtime.withFrameNanos { }
            }
            rings.clear()
            pull.snapTo(1f)
        }
    }

    internal fun draw(scope: DrawScope, rim: Color) = with(scope) {
        val open = pull.value.coerceAtLeast(0f)
        val reach = reach()
        // Newest first: each older picture covers everything outside its own, larger circle.
        for (i in rings.indices.reversed()) {
            val r = rings[i].radius.value * open
            val hole = Path().apply { addOval(Rect(origin, r)) }
            clipPath(hole, ClipOp.Difference) { drawImage(rings[i].image) }
        }
        val strength = { r: Float -> (1f - r / reach).coerceIn(0f, 1f) }
        // A theme filling the bubble: light on its edge.
        rings.getOrNull(1)?.let { inner ->
            val r = minOf(inner.radius.value, rings[0].radius.value) * open
            if (r > 0.5f) drawCircle(rim.copy(alpha = 0.6f * strength(r)), r, origin, style = Stroke(1.2.dp.toPx()))
        }
        // The bubble: light on its edge and a shadow beyond it, fading as it leaves the screen.
        val r = rings.firstOrNull()?.radius?.value?.times(open) ?: return@with
        if (r <= 0.5f) return@with
        val fall = 28.dp.toPx()
        val edge = Path().apply { addOval(Rect(origin, r)) }
        clipPath(edge, ClipOp.Difference) {
            drawCircle(
                Brush.radialGradient(0f to Color.Transparent, r / (r + fall) to Color.Black.copy(alpha = 0.3f * strength(r)), 1f to Color.Transparent, center = origin, radius = r + fall),
                r + fall, origin,
            )
        }
        drawCircle(rim.copy(alpha = 0.22f * strength(r)), r - 2.dp.toPx(), origin, style = Stroke(4.dp.toPx()))
        drawCircle(rim.copy(alpha = 0.8f * strength(r)), r, origin, style = Stroke(1.2.dp.toPx()))
    }
}

val LocalThemeReveal = staticCompositionLocalOf<ThemeReveal?> { null }

/** Draws [content] through a layer, so a theme can spread out of the logo over it (see [ThemeReveal]). */
@Composable
fun ThemeRevealHost(themes: ThemeStore, content: @Composable () -> Unit) {
    val layer = rememberGraphicsLayer()
    val scope = rememberCoroutineScope()
    val reveal = remember(layer) { ThemeReveal(layer, scope) }
    // On screen, the scheduled theme opens out of the logo; away, it just switches.
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(reveal, lifecycle) {
        val watch = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_RESUME -> { themes.presenter = reveal.present; runCatching { themes.checkSchedule() } }
                androidx.lifecycle.Lifecycle.Event.ON_PAUSE -> if (themes.presenter === reveal.present) themes.presenter = null
                else -> {}
            }
        }
        lifecycle.addObserver(watch)
        onDispose { lifecycle.removeObserver(watch); if (themes.presenter === reveal.present) themes.presenter = null }
    }
    val rim = Hive.colors.accent
    Box(
        Modifier.fillMaxSize().onSizeChanged { reveal.width = it.width.toFloat(); reveal.height = it.height.toFloat() }.drawWithContent {
            layer.record { this@drawWithContent.drawContent() }
            drawLayer(layer)
            if (reveal.rings.isNotEmpty()) reveal.draw(this, rim)
        },
    ) { CompositionLocalProvider(LocalThemeReveal provides reveal, content = content) }
}

/**
 * Hive's logo, and the theme shuffle: hold it and a theme at random (from
 * the phone's own themes, as in Settings → Theme) bounces open in a bubble around
 * it, then another every moment while it's held. Let go on the logo to keep
 * the one showing; drag away and the bubble closes after the finger, and
 * letting go there brings the old theme back.
 */
@Composable
fun ShufflingHiveMark(themes: ThemeStore, modifier: Modifier = Modifier) {
    val reveal = LocalThemeReveal.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var pressed by remember { mutableStateOf(false) }
    var holding by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        when { holding -> 1.18f; pressed -> 0.88f; else -> 1f },
        spring(dampingRatio = if (holding) 0.5f else 0.7f, stiffness = 600f), label = "logo",
    )
    val c = Hive.colors
    fun show(pack: ThemePack) = if (pack.name == ThemeStore.YOUR_THEME) themes.reset() else themes.apply(pack.css, pack.name)
    Box(
        modifier
            .size(48.dp)
            .onGloballyPositioned { reveal?.origin = it.positionInRoot() + Offset(it.size.width / 2f, it.size.height / 2f) }
            .semantics { onLongClick("Shuffle themes") { themes.shufflePool().randomOrNull()?.let(::show); true } }
            .pointerInput(reveal) {
                if (reveal == null) return@pointerInput
                val slop = 18.dp.toPx()
                val range = 170.dp.toPx()
                val center = Offset(size.width / 2f, size.height / 2f)
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    pressed = true
                    // Lifted or moved off before the hold: an ordinary touch.
                    val notHeld = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed || (change.position - down.position).getDistance() > viewConfiguration.touchSlop) break
                        }
                        true
                    }
                    pressed = false
                    val pool = themes.shufflePool().shuffled()
                    if (notHeld != null || reveal.busy || pool.isEmpty()) return@awaitEachGesture
                    holding = true
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    val restore = themes.restorer()
                    val shuffler = scope.launch {
                        var i = 0
                        while (true) {
                            reveal.spread { show(pool[i % pool.size]) }
                            if (i > 0) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                            i++
                            if (pool.size < 2) break
                            delay(DWELL_MS)
                            // Paused while the finger pulls the bubble closed.
                            while (reveal.pull.targetValue < 0.95f) delay(40)
                        }
                    }
                    var open = 1f
                    try {
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            change.consume()
                            if (!change.pressed) break
                            val t = (((change.position - center).getDistance() - slop) / range).coerceIn(0f, 1f)
                            open = 1f - t * t * (3f - 2f * t)
                            reveal.follow(open)
                        }
                    } finally {
                        shuffler.cancel()
                        holding = false
                        val keep = open >= 0.5f
                        haptics.performHapticFeedback(if (keep) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
                        reveal.end(keep, restore)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        // Hive's mark in the theme's accent, glowing with it.
        HiveMark(Modifier.size(30.dp).graphicsLayer { scaleX = scale; scaleY = scale }.shadow(10.dp, androidx.compose.foundation.shape.CircleShape, ambientColor = c.accentGlow, spotColor = c.accentGlow))
    }
}
