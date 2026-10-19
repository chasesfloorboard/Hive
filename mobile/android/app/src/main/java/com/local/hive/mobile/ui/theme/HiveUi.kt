package com.local.hive.mobile.ui.theme

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.local.hive.mobile.R
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import kotlin.random.Random

/** Hive's typeface (app/renderer/styles.css: "Inter", …). */
val Inter = FontFamily(
    Font(R.font.inter_light, FontWeight.Light),
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

/**
 * Hive's type, scaled for touch. The desktop's dense 12.5–13 px rows become
 * 15 sp; its 600-weight titles stay heavy, its uppercase column labels stay
 * small and tracked.
 */
object HiveText {
    private fun s(size: Int, weight: FontWeight, spacing: Float = 0f, line: Int? = null) = TextStyle(
        fontFamily = Inter, fontSize = size.sp, fontWeight = weight, letterSpacing = spacing.em,
        lineHeight = line?.sp ?: androidx.compose.ui.unit.TextUnit.Unspecified,
    )
    val brand = s(18, FontWeight.SemiBold, 0.02f)
    val viewTitle = s(24, FontWeight.Bold, -0.01f, 29)
    val heroTitle = s(22, FontWeight.Bold, 0.01f, 27)
    val npTitle = s(22, FontWeight.Bold, 0.01f, 27)
    val year = s(16, FontWeight.SemiBold, 0.01f)
    val cardTitle = s(14, FontWeight.SemiBold, 0f, 18)
    val cardSub = s(13, FontWeight.Normal, 0f, 16)
    val row = s(15, FontWeight.Normal, 0f, 19)
    val rowStrong = s(15, FontWeight.Medium, 0f, 19)
    val rowSub = s(13, FontWeight.Normal, 0f, 16)
    val tab = s(14, FontWeight.Medium, 0.03f)
    val pill = s(13, FontWeight.Medium, 0.02f)
    val label = s(11, FontWeight.SemiBold, 0.06f)
    val body = s(14, FontWeight.Normal, 0f, 19)
    val small = s(12, FontWeight.Normal, 0f, 15)
    val numbers = TextStyle(fontFamily = Inter, fontSize = 13.sp, fontWeight = FontWeight.Normal, fontFeatureSettings = "tnum")
}

object HiveShape {
    val art = RoundedCornerShape(10.dp)      // .album-card .art-wrap
    val thumb = RoundedCornerShape(6.dp)     // #queue-list .q-thumb (5px), scaled
    val row = RoundedCornerShape(10.dp)      // .song-row, #queue-list li (8px), scaled
    val tab = RoundedCornerShape(12.dp)      // .tab (10px), scaled
    val panel = RoundedCornerShape(20.dp)    // --radius 16px, scaled
    val menu = RoundedCornerShape(14.dp)     // #context-menu (10px), scaled
    val pill = RoundedCornerShape(percent = 50)
}

/** Glass surfaces blur what sits behind them in this state. */
val LocalHiveHaze = staticCompositionLocalOf<HazeState?> { null }

/** Hive's .glass background: the accent 7% into the panel colour. */
@Composable
fun hiveGlassColor(alphaBoost: Float = 0f): Color {
    val c = Hive.colors
    return mix(c.accent, c.panel, 0.07f).let { it.copy(alpha = (it.alpha + alphaBoost).coerceAtMost(1f)) }
}

/** Hive's .glass border: the accent 14% into --border. */
@Composable
fun hiveGlassBorder(): Color = Hive.colors.let { mix(it.accent, it.border, 0.14f).copy(alpha = (it.border.alpha + 0.06f)) }

/**
 * Hive's `.glass`: blur 28 px of what lies behind, washed with the panel
 * tinted 7% by the accent, edged with a 1 px border tinted 14%. Colours glide
 * over 900 ms when the accent follows a new cover. Inside scrolling content
 * (no haze state) it is the same wash without the blur.
 */
@Composable
fun Modifier.hiveGlass(shape: Shape, strength: Float = 0f): Modifier {
    val wash by animateColorAsState(hiveGlassColor(strength), tween(900), label = "glassWash")
    val edge by animateColorAsState(hiveGlassBorder(), tween(900), label = "glassEdge")
    val state = LocalHiveHaze.current
    val bg = Hive.colors.bg
    return clip(shape)
        .then(
            if (state != null) Modifier.hazeEffect(
                state,
                HazeStyle(backgroundColor = bg, tint = HazeTint(wash), blurRadius = 28.dp, noiseFactor = 0.03f, fallbackTint = HazeTint(wash.copy(alpha = 0.92f))),
            ) else Modifier.background(wash.copy(alpha = (wash.alpha + 0.25f).coerceAtMost(0.95f))),
        )
        .border(1.dp, edge, shape)
}

/** Content below, glass chrome above; glass can't blur the layer it lives in. */
@Composable
fun HiveGlassLayers(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit, overlay: @Composable BoxScope.() -> Unit) {
    val state = rememberHazeState()
    Box(modifier) {
        Box(Modifier.fillMaxSize().hazeSource(state)) {
            CompositionLocalProvider(LocalHiveHaze provides null) { content() }
        }
        CompositionLocalProvider(LocalHiveHaze provides state) { overlay() }
    }
}

/**
 * Hive's ambient backdrop (#ambient-bg): a radial base lighter toward the top
 * left, two very soft blobs in the cover's colours off the top-left and
 * bottom-right corners that glide to new colours over 900 ms, and 3.5% grain.
 */
@Composable
fun HiveAmbient(blobA: Color, blobB: Color, modifier: Modifier = Modifier, intensity: Float = 1f) {
    val c = Hive.colors
    val a by animateColorAsState(blobA, tween(900), label = "blobA")
    val b by animateColorAsState(blobB, tween(900), label = "blobB")
    val grain = remember { grainTexture() }
    Canvas(modifier.fillMaxSize()) {
        val base = c.bg
        drawRect(
            Brush.radialGradient(
                listOf(mix(Color.White, base, 0.08f), mix(Color.Black, base, 0.08f)),
                center = Offset(size.width * 0.2f, size.height * 0.1f),
                radius = maxOf(size.width, size.height) * 0.9f,
            ),
        )
        blob(a.copy(alpha = a.alpha.coerceAtLeast(0.2f) * 0.9f * intensity), Offset(size.width * 0.2f, size.height * -0.05f), size.width * 0.75f)
        blob(b.copy(alpha = b.alpha.coerceAtLeast(0.2f) * 0.9f * intensity), Offset(size.width * 0.8f, size.height * 1.02f), size.width * 0.85f)
        // 3.5% grain, tiled.
        var y = 0f
        while (y < size.height) {
            var x = 0f
            while (x < size.width) { drawImage(grain, Offset(x, y), alpha = 0.035f, blendMode = BlendMode.Overlay); x += grain.width }
            y += grain.height
        }
    }
}

private fun DrawScope.blob(color: Color, center: Offset, radius: Float) {
    drawCircle(Brush.radialGradient(listOf(color, color.copy(alpha = 0f)), center, radius), radius, center)
}

private fun grainTexture(): ImageBitmap {
    val size = 160
    val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
    val rnd = Random(7)
    val px = IntArray(size * size) { val v = rnd.nextInt(256); android.graphics.Color.argb(255, v, v, v) }
    bmp.setPixels(px, 0, size, 0, 0, size, size)
    return bmp.asImageBitmap()
}

/** Linear mix: [amount] of [a] into [b] (CSS color-mix in srgb). */
fun mix(a: Color, b: Color, amount: Float): Color = lerp(b, a, amount)

/** The active Hive colours with the accent (and its soft/glow companions) taken from the cover. */
fun HiveColors.withAccent(accent: Color): HiveColors = copy(
    accent = accent,
    accentSoft = accent.copy(alpha = 0.38f),
    accentGlow = accent.copy(alpha = 0.28f),
)
