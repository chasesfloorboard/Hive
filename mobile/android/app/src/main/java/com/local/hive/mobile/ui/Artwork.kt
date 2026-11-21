package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.request.crossfade
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.mix

/**
 * Album art the way Hive draws it: the panel colour underneath, the image
 * fading in over 260 ms, and an optional soft drop shadow
 * (`0 12px 28px -16px rgba(0,0,0,.62)`), or a glow in the accent.
 */
@Composable
fun Artwork(
    model: Any?,
    modifier: Modifier = Modifier,
    shape: Shape = HiveShape.thumb,
    fallback: ImageVector = Icons.Rounded.MusicNote,
    glow: Color? = null,
    elevation: Dp = 0.dp,
    /** The picture this one replaces (a cover carousel's last frame): it stays up and fades into this one. */
    replacing: Any? = null,
    /** Shown instead when [model] has no picture (a mosaic's tile takes another of its covers). */
    orElse: Any? = null,
    /** When true (e.g. now playing cover), always decodes full-resolution art with exact precision and isolated cache key. */
    highQuality: Boolean = false,
) {
    val generation = CoverGeneration.intValue
    var failed by remember(model, generation) { mutableStateOf(false) }
    if (failed && orElse != null) return Artwork(orElse, modifier, shape, fallback, glow, elevation, highQuality = highQuality)
    val c = Hive.colors
    val shadowed = if (elevation > 0.dp) modifier.softShadow(elevation, shape, glow ?: Color.Black) else modifier
    val context = androidx.compose.ui.platform.LocalContext.current
    // A cover already on screen at another size stands in while this size loads, so it never blinks;
    // the sharpest copy drawn so far, never a list row's thumbnail once a bigger one was shown.
    val request = remember(model, generation, highQuality) {
        val own = model?.toString()?.let { ShownCovers[it]?.first }
        val standIn = own ?: replacing?.toString()?.let { ShownCovers[it]?.first }
        coil3.request.ImageRequest.Builder(context).data(model).placeholderMemoryCacheKey(standIn)
            .precision(if (highQuality) coil3.size.Precision.EXACT else coil3.size.Precision.INEXACT)
            .apply {
                if (highQuality) {
                    memoryCacheKeyExtra("quality", "hq")
                    size(coil3.size.Size.ORIGINAL)
                }
                if (generation > 0) memoryCacheKeyExtra("cover", generation.toString())
            }
            // Only a cover that wasn't standing in fades up; a carousel frame fades over the last one.
            .crossfade(when { own != null -> 0; standIn != null -> 600; else -> 0 }).build()
    }
    // AsyncImage, not SubcomposeAsyncImage: a subcomposition per row made every
    // list row costly to compose while scrolling.
    var shown by remember(model, generation) { mutableStateOf(request.placeholderMemoryCacheKey != null) }
    // The panel goes once the picture has faded up over it: left under a cover, it showed as a dark
    // rim around the cover's rounded corners, where both are only partly drawn.
    var covered by remember(model, generation) { mutableStateOf(false) }
    if (shown) androidx.compose.runtime.LaunchedEffect(model) { kotlinx.coroutines.delay(700); covered = true }
    Box(shadowed.clip(shape), contentAlignment = Alignment.Center) {
        // Kept a pixel inside the cover's edge, so its rim never shows at the rounded corners.
        if (!covered) Box(Modifier.fillMaxSize().padding(1.dp).clip(shape).background(mix(c.panelStrong.copy(alpha = 1f), c.bg, 0.6f)))
        if (!shown) ArtPlaceholder(fallback)
        AsyncImage(
            model = request,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            onSuccess = { state ->
                shown = true
                // From memory there's no fade: the panel goes at once.
                if (state.result.dataSource == coil3.decode.DataSource.MEMORY_CACHE) covered = true
                val key = state.result.memoryCacheKey
                val pixels = state.result.image.width.toLong() * state.result.image.height
                if (key != null && model != null) ShownCovers.merge(model.toString(), key to pixels) { old, new -> if (new.second >= old.second) new else old }
            },
            onError = { state ->
                android.util.Log.d("HiveArtwork", "Cover failed for $model: ${state.result.throwable.message}")
                if (orElse != null) failed = true else { shown = false; covered = false }
            },
        )
    }
}

/**
 * A fast, downsampled backdrop cover for background blur effects.
 * Reads existing memory cache if present, but uses CachePolicy.READ_ONLY so it never
 * writes or pollutes the memory cache with a downsampled copy that could degrade Now Playing.
 */
@Composable
fun BlurredBackdropArt(
    model: Any?,
    modifier: Modifier = Modifier,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val request = remember(model) {
        coil3.request.ImageRequest.Builder(context)
            .data(model)
            .memoryCachePolicy(coil3.request.CachePolicy.READ_ONLY)
            .precision(coil3.size.Precision.INEXACT)
            .build()
    }
    AsyncImage(
        model = request,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = modifier,
    )
}

/**
 * A soft drop shadow under [shape], blurred out to nothing: Hive's `0 12px 28px -16px rgba(0,0,0,.62)`
 * scaled to [elevation]. Android's own elevation shadow (Modifier.shadow) drew hard edges around
 * rounded covers, worst with a coloured glow or on a cover that's tilted or fading.
 */
fun Modifier.softShadow(elevation: Dp, shape: Shape, color: Color = Color.Black): Modifier = drawBehind {
    val e = elevation.toPx()
    if (e <= 0f) return@drawBehind
    val blur = e * 0.8f
    val inset = e * 0.4f
    val dy = e * 0.35f
    val outline = shape.createOutline(androidx.compose.ui.geometry.Size((size.width - 2 * inset).coerceAtLeast(1f), (size.height - 2 * inset).coerceAtLeast(1f)), layoutDirection, this)
    val path = androidx.compose.ui.graphics.Path().apply { addOutline(outline); translate(androidx.compose.ui.geometry.Offset(inset, inset + dy)) }
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color.copy(alpha = if (color == Color.Black) 0.62f else 0.5f).toArgb()
        maskFilter = android.graphics.BlurMaskFilter(blur, android.graphics.BlurMaskFilter.Blur.NORMAL)
    }
    drawContext.canvas.nativeCanvas.drawPath(path.asAndroidPath(), paint)
}

/** A cover carousel's frame: what to draw now, and the frame it replaces (to fade from). */
data class CoverFrame(val current: Any?, val previous: Any?)

/** How long each picture of a song shows in the cover carousel, as on the PC. */
const val COVER_ROTATE_MS = 4_000L

/**
 * Hive's cover carousel: a song with several distinct pictures embedded
 * (a back cover, an alternate) cycles through them every 4 seconds, as on
 * the PC. Every surface keys off the same wall-clock tick, so the player,
 * the bar and the album page change together. Other songs show [base].
 */
@Composable
fun rotatingCover(base: Any?, trackId: Long?): CoverFrame {
    val context = androidx.compose.ui.platform.LocalContext.current
    // The album (from the base cover's address) brings its online cover when that one differs.
    val albumId = (base as? android.net.Uri ?: base as? String)?.toString()?.substringAfter("/audio/albumart/", "")?.toLongOrNull()
    val pictures by androidx.compose.runtime.produceState(emptyList<java.io.File>(), trackId, albumId) {
        value = trackId?.let { com.local.hive.mobile.data.EmbeddedPictures.forTrack(context, it, albumId) }.orEmpty()
    }
    if (pictures.size < 2) return CoverFrame(base, null)
    val tick by androidx.compose.runtime.produceState(System.currentTimeMillis() / COVER_ROTATE_MS, pictures) {
        while (true) {
            kotlinx.coroutines.delay(COVER_ROTATE_MS - System.currentTimeMillis() % COVER_ROTATE_MS)
            value = System.currentTimeMillis() / COVER_ROTATE_MS
        }
    }
    val n = pictures.size
    return CoverFrame(pictures[(tick % n).toInt()], pictures[((tick - 1) % n + n).toInt() % n])
}

/** The sharpest memory-cache entry each cover has been drawn from, with its size in pixels. */
private val ShownCovers = java.util.concurrent.ConcurrentHashMap<String, Pair<coil3.memory.MemoryCache.Key, Long>>()

/**
 * Notes a cover loaded ahead of time (the playing song's, the next one's) as
 * the sharpest copy there is, so the big player and Now Playing show it at once
 * rather than a list row's thumbnail stretched up while the full one loads.
 */
fun noteLoadedCover(model: Any?, key: coil3.memory.MemoryCache.Key?, pixels: Long) {
    if (model == null || key == null) return
    ShownCovers.merge(model.toString(), key to pixels) { old, new -> if (new.second >= old.second) new else old }
}

/** Forgets which covers were shown, once a cover changed (the stand-ins would be the old picture). */
fun forgetShownCovers() { ShownCovers.clear(); CoverGeneration.intValue++ }

/** Bumped when a cover changed, so covers on screen load again. */
val CoverGeneration = androidx.compose.runtime.mutableIntStateOf(0)

@Composable
private fun ArtPlaceholder(icon: ImageVector) {
    val c = Hive.colors
    Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(mix(c.accent, c.panelStrong.copy(alpha = 1f), 0.10f), c.bg))), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = c.textDimmer, modifier = Modifier.fillMaxSize(0.38f))
    }
}
