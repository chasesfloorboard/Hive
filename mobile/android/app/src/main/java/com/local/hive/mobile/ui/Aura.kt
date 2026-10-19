package com.local.hive.mobile.ui

import android.content.Context
import android.net.Uri
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.core.graphics.ColorUtils
import androidx.palette.graphics.Palette
import coil3.BitmapImage
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.size.Size
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.cos
import kotlin.math.sin

/** Colours taken from album art: two glows for the aura and an accent for highlights. */
@Immutable
data class AuraColors(val primary: Color, val secondary: Color, val accent: Color)

/**
 * Picks an album's colours with Palette. Glows favour deep, saturated
 * swatches so they read as light behind dark glass; the accent is lifted
 * until it stands out against Hive's background.
 */
object ArtColors {
    private val cache = object : LinkedHashMap<String, AuraColors?>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, AuraColors?>) = size > 200
    }

    suspend fun extract(context: Context, artwork: Uri?): AuraColors? {
        if (artwork == null) return null
        val key = artwork.toString()
        synchronized(cache) { if (cache.containsKey(key)) return cache[key] }
        val colors = withContext(Dispatchers.IO) {
            val result = SingletonImageLoader.get(context).execute(
                ImageRequest.Builder(context).data(artwork).size(Size(96, 96)).allowHardware(false).build(),
            )
            val bitmap = (result.image as? BitmapImage)?.bitmap ?: return@withContext null
            val palette = Palette.from(bitmap).maximumColorCount(16).generate()
            val swatches = listOfNotNull(
                palette.vibrantSwatch, palette.darkVibrantSwatch, palette.mutedSwatch,
                palette.darkMutedSwatch, palette.lightVibrantSwatch, palette.dominantSwatch,
            )
            if (swatches.isEmpty()) return@withContext null
            val primary = swatches.first().rgb
            val secondary = (listOfNotNull(palette.darkVibrantSwatch, palette.mutedSwatch, palette.darkMutedSwatch, palette.dominantSwatch)
                .firstOrNull { it.rgb != primary } ?: swatches.last()).rgb
            AuraColors(
                primary = Color(glow(primary)),
                secondary = Color(glow(secondary)),
                accent = Color(readableAccent(palette.lightVibrantSwatch?.rgb ?: palette.vibrantSwatch?.rgb ?: primary)),
            )
        }
        synchronized(cache) { cache[key] = colors }
        return colors
    }

    private fun glow(rgb: Int): Int {
        val hsl = FloatArray(3)
        ColorUtils.colorToHSL(rgb, hsl)
        hsl[1] = (hsl[1] * 1.1f).coerceIn(0.25f, 0.9f)
        hsl[2] = hsl[2].coerceIn(0.28f, 0.5f)
        return ColorUtils.HSLToColor(hsl)
    }

    private fun readableAccent(rgb: Int): Int {
        val hsl = FloatArray(3)
        ColorUtils.colorToHSL(rgb, hsl)
        hsl[1] = hsl[1].coerceIn(0.35f, 0.85f)
        hsl[2] = hsl[2].coerceIn(0.68f, 0.8f)
        return ColorUtils.HSLToColor(hsl)
    }
}

/**
 * Hive's aura: the theme background lit by two large, soft glows in the
 * album's colours. The glows drift on slow, offset orbits and follow the
 * song as it plays, and cross-fade when the track changes.
 */
@Composable
fun AuraBackground(colors: AuraColors?, progress: Float, intensity: Float, base: Color, modifier: Modifier = Modifier) {
    // Before the cover's colours are known, a quiet One UI grey.
    val a by animateColorAsState(colors?.primary ?: Color(0xFF3A3A3D), tween(900), label = "auraA")
    val b by animateColorAsState(colors?.secondary ?: Color(0xFF2D2D30), tween(900), label = "auraB")
    val drift = rememberInfiniteTransition(label = "aura")
    val t by drift.animateFloat(0f, (2 * Math.PI).toFloat(), infiniteRepeatable(tween(48_000, easing = LinearEasing), RepeatMode.Restart), label = "t")
    val strength = if (colors == null) intensity * 0.6f else intensity

    Canvas(modifier) {
        drawRect(base)
        val w = size.width
        val h = size.height
        val phase = t + progress * 2.2f
        val c1 = Offset(w * (0.28f + 0.16f * cos(phase)), h * (0.22f + 0.1f * sin(phase * 1.3f)))
        val c2 = Offset(w * (0.78f + 0.14f * cos(phase * 0.8f + 2f)), h * (0.62f + 0.12f * sin(phase + 1f)))
        val r1 = w * 0.95f
        val r2 = w * 1.05f
        drawCircle(Brush.radialGradient(listOf(a.copy(alpha = 0.55f * strength), Color.Transparent), c1, r1), r1, c1)
        drawCircle(Brush.radialGradient(listOf(b.copy(alpha = 0.45f * strength), Color.Transparent), c2, r2), r2, c2)
        // A soft vignette keeps text at the edges calm.
        drawRect(Brush.verticalGradient(0f to Color.Transparent, 0.7f to Color.Transparent, 1f to base.copy(alpha = 0.55f)))
    }
}

/** Hive's accent, replaced by the art's while something plays. */
fun accentFor(aura: AuraColors?, themeAccent: Color): Color = aura?.accent ?: themeAccent
