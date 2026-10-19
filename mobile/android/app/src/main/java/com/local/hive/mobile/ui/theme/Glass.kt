package com.local.hive.mobile.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState

/** What glass surfaces here blur. Null inside scrolling content, where glass is a plain wash. */
val LocalHazeState = staticCompositionLocalOf<HazeState?> { null }

/**
 * Content underneath, glass chrome on top. Glass can only blur what is
 * behind it, never the layer it sits in, so the chrome lives in [overlay]
 * and blurs [content]; glass used inside [content] falls back to a tinted
 * wash.
 */
@Composable
fun GlassLayers(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit, overlay: @Composable BoxScope.() -> Unit) {
    val state = rememberHazeState()
    Box(modifier) {
        Box(Modifier.fillMaxSize().hazeSource(state)) {
            CompositionLocalProvider(LocalHazeState provides null) { content() }
        }
        CompositionLocalProvider(LocalHazeState provides state) { overlay() }
    }
}

enum class GlassWeight(val tintAlpha: Float, val blur: Dp) {
    /** Bars and the mini player: content stays readable underneath. */
    Thin(0.42f, 26.dp),
    /** Sheets, menus and cards. */
    Regular(0.62f, 32.dp),
    /** Over very busy art. */
    Thick(0.78f, 40.dp),
}

/**
 * Hive's frosted glass: the content behind blurred, washed with the theme's
 * panel colour, a whisper of grain, and a hairline edge that is brighter on
 * top, the way light catches glass.
 */
@Composable
fun Modifier.glass(shape: Shape, weight: GlassWeight = GlassWeight.Thin, tint: Color? = null): Modifier {
    val colors = Hive.colors
    val state = LocalHazeState.current
    val wash = (tint ?: colors.panelStrong).copy(alpha = weight.tintAlpha)
    val surface = clip(shape).let { m ->
        if (state != null) {
            m.hazeEffect(
                state,
                HazeStyle(
                    backgroundColor = colors.bg,
                    tint = HazeTint(wash),
                    blurRadius = weight.blur,
                    noiseFactor = 0.035f,
                    fallbackTint = HazeTint(wash.copy(alpha = (weight.tintAlpha + 0.3f).coerceAtMost(0.96f))),
                ),
            )
        } else m.background(wash)
    }
    return surface.glassEdge(shape)
}

/** The hairline rim on its own, for surfaces that are not blurred. */
@Composable
fun Modifier.glassEdge(shape: Shape): Modifier = border(
    width = 0.75.dp,
    brush = Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.16f), Color.White.copy(alpha = 0.04f))),
    shape = shape,
)
