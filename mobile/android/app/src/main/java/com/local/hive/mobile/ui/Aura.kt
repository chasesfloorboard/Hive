package com.local.hive.mobile.ui

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.Immutable
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
                // Reads a sharp cover already in memory, but never puts this 96-pixel copy there in its
                // place: the player would draw it stretched (blurry) until the full size decoded again.
                ImageRequest.Builder(context).data(artwork).size(Size(96, 96)).allowHardware(false)
                    .memoryCachePolicy(coil3.request.CachePolicy.READ_ONLY).build(),
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

/** Hive's accent, replaced by the art's while something plays. */
fun accentFor(aura: AuraColors?, themeAccent: Color): Color = aura?.accent ?: themeAccent
