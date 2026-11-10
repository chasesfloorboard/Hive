package com.local.hive.mobile.ui

import coil3.request.allowHardware
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.HiveShape
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * An album's cover over the whole screen, at the size it is in the song file: pinch or double tap
 * to zoom, drag to look around. Save puts the picture in the phone's Pictures/Hive; Edit cover opens
 * the cover editor for the album's songs. A tap outside the picture, Back or ✕ closes it.
 */
@Composable
fun CoverViewer(vm: MainViewModel, tracks: List<Track>, fallback: Any?, name: String, onDismiss: () -> Unit) {
    val editor = LocalEditor.current
    val scope = rememberCoroutineScope()
    val first = tracks.firstOrNull()
    // The song's own picture at full size; the phone's album art meanwhile, or when the file has none.
    val context = androidx.compose.ui.platform.LocalContext.current
    // A local song's picture comes from its file; a streaming one (Apple Music, etc.) has no file, so its
    // cover is fetched from its artwork address instead, so it can still be held, viewed and saved.
    val bytes by produceState<ByteArray?>(null, first?.id, fallback) {
        value = first?.let { vm.fullCover(it) } ?: fallback?.let { fb ->
            withContext(Dispatchers.IO) {
                runCatching {
                    val r = coil3.SingletonImageLoader.get(context).execute(
                        coil3.request.ImageRequest.Builder(context).data(fb).size(coil3.size.Size.ORIGINAL).allowHardware(false).build())
                    (r.image as? coil3.BitmapImage)?.bitmap?.let { bm ->
                        java.io.ByteArrayOutputStream().use { os -> bm.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, os); os.toByteArray() }
                    }
                }.getOrNull()
            }
        }
    }
    val full by produceState<ImageBitmap?>(null, bytes) {
        value = bytes?.let { b -> withContext(Dispatchers.Default) { decode(b)?.asImageBitmap() } }
    }
    // The backdrop's colours: each quarter of the cover's average (top left, top right, bottom left, bottom right)
    // and the whole cover's, so none of the picture's shapes show, only its light.
    val glows by produceState<List<Color>?>(null, full) {
        value = full?.let { b -> withContext(Dispatchers.Default) {
            val q = android.graphics.Bitmap.createScaledBitmap(b.asAndroidBitmap(), 2, 2, true)
            val all = android.graphics.Bitmap.createScaledBitmap(b.asAndroidBitmap(), 1, 1, true)
            listOf(q.getPixel(0, 0), q.getPixel(1, 0), q.getPixel(0, 1), q.getPixel(1, 1), all.getPixel(0, 0)).map { Color(it) }
        } }
    }
    val aura by produceState<AuraColors?>(null, first?.albumId) { value = first?.albumId?.let { vm.albumColors(it) } }
    // Saving shows itself here, over the cover: the button turns to a tick, and a note says where it went.
    var saved by remember { mutableStateOf<String?>(null) }
    var savedOk by remember { mutableStateOf(false) }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    LaunchedEffect(saved) { if (saved != null) { kotlinx.coroutines.delay(2_600); saved = null } }
    // Photo-style zoom: pinch zooms into the point between the fingers and pan drags the picture, kept
    // inside its frame so it can't be flung off; double tap toggles 1x and 2.5x at the tapped point.
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var frame by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    var appear by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) { Animatable(0f).animateTo(1f, tween(220)) { appear = value } }
    // How far the picture may slide at this zoom before an edge would show.
    fun clamp(s: Float, o: Offset): Offset {
        val mx = (frame.width * (s - 1f) / 2f).coerceAtLeast(0f)
        val my = (frame.height * (s - 1f) / 2f).coerceAtLeast(0f)
        return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
    }
    fun onGesture(centroid: Offset, pan: Offset, zoomChange: Float) {
        val s0 = scale
        val s1 = (s0 * zoomChange).coerceIn(1f, 5f)
        val c = Offset(frame.width / 2f, frame.height / 2f)
        // Keep the point under the fingers fixed while zooming, then apply the drag.
        offset = clamp(s1, (centroid - c) - ((centroid - c) - offset) * (s1 / s0) + pan)
        scale = s1
    }
    fun animateTo(targetScale: Float, targetOffset: Offset) {
        scope.launch {
            val s0 = scale; val o0 = offset
            Animatable(0f).animateTo(1f, tween(220)) {
                scale = s0 + (targetScale - s0) * value
                offset = Offset(o0.x + (targetOffset.x - o0.x) * value, o0.y + (targetOffset.y - o0.y) * value)
            }
        }
    }
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = appear }.pointerInput(Unit) { detectTapGestures { onDismiss() } }) {
            // Frosted glass lit by the cover: a deep shade of its colour, with a soft glow of each corner's colour.
            val bg = Hive.colors.bg
            val g = glows ?: listOf(aura?.primary ?: Hive.colors.ambientA, aura?.secondary ?: Hive.colors.ambientB, aura?.secondary ?: Hive.colors.ambientB, aura?.primary ?: Hive.colors.ambientA, aura?.primary ?: bg)
            androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
                drawRect(androidx.compose.ui.graphics.lerp(g[4], bg, 0.72f))
                val r = maxOf(size.width, size.height) * 0.75f
                listOf(Offset(0f, 0f), Offset(size.width, 0f), Offset(0f, size.height), Offset(size.width, size.height)).forEachIndexed { i, at ->
                    drawCircle(androidx.compose.ui.graphics.Brush.radialGradient(listOf(g[i].copy(alpha = 0.55f), g[i].copy(alpha = 0.18f), Color.Transparent), at, r), r, at)
                }
                // Frosted: a dark veil so the cover stands forward, a touch deeper behind the buttons.
                drawRect(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.22f), Color.Black.copy(alpha = 0.12f), Color.Black.copy(alpha = 0.38f))))
            }
            Box(
                Modifier.align(Alignment.Center).fillMaxWidth().aspectRatio(1f).padding(12.dp)
                    .onSizeChanged { frame = it }
                    .graphicsLayer {
                        val s = (0.92f + 0.08f * appear) * scale
                        scaleX = s; scaleY = s; translationX = offset.x; translationY = offset.y; alpha = appear
                    }
                    .pointerInput(Unit) {
                        detectTransformGestures { centroid, pan, zoomChange, _ -> onGesture(centroid, pan, zoomChange) }
                    }
                    .pointerInput(Unit) {
                        detectTapGestures(onDoubleTap = { tap ->
                            if (scale > 1f) animateTo(1f, Offset.Zero)
                            else { val c = Offset(frame.width / 2f, frame.height / 2f); animateTo(2.5f, clamp(2.5f, (tap - c) * (1f - 2.5f))) }
                        })
                    },
            ) {
                val bitmap = full
                if (bitmap != null) Image(bitmap, "Album cover", Modifier.fillMaxSize().softShadow(28.dp, HiveShape.art, aura?.primary ?: Color.Black), contentScale = ContentScale.Fit)
                else Artwork(fallback, Modifier.fillMaxSize(), HiveShape.art, Icons.Rounded.LibraryMusic, glow = aura?.primary, elevation = 28.dp)
            }
            Row(Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp)) {
                ControlButton(Icons.Rounded.Close, "Close", onDismiss, size = 44.dp)
            }
            androidx.compose.foundation.layout.Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
            androidx.compose.animation.AnimatedVisibility(saved != null,
                enter = androidx.compose.animation.fadeIn(tween(160)) + androidx.compose.animation.scaleIn(androidx.compose.animation.core.spring(dampingRatio = 0.6f, stiffness = 600f), initialScale = 0.8f) + androidx.compose.animation.slideInVertically(tween(200)) { it / 2 },
                exit = androidx.compose.animation.fadeOut(tween(220)) + androidx.compose.animation.slideOutVertically(tween(220)) { it / 3 }) {
                var last by remember { mutableStateOf("") }
                saved?.let { last = it }
                Row(Modifier.padding(bottom = 14.dp).hiveGlass(HiveShape.pill, strength = 0.3f).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.material3.Icon(if (savedOk) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline, null, tint = if (savedOk) Hive.colors.accent else Hive.colors.text, modifier = Modifier.size(20.dp))
                    androidx.compose.foundation.layout.Spacer(Modifier.width(8.dp))
                    androidx.compose.material3.Text(last, style = HiveText.rowStrong, color = Hive.colors.text)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(if (saved != null && savedOk) "Saved" else "Save", if (saved != null && savedOk) Icons.Rounded.Check else Icons.Rounded.Download, accent = true, modifier = Modifier.weight(1f)) {
                    val b = bytes
                    if (b == null) { savedOk = false; saved = "This cover isn't in the song files to save" }
                    else vm.savePicture(b, "${first?.displayAlbumArtist.orEmpty()} - $name".trim(' ', '-')) { msg ->
                        savedOk = msg.startsWith("Cover saved"); saved = if (savedOk) "Saved to Pictures › Hive" else msg
                        if (savedOk) haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm)
                    }
                }
                PillButton("Edit cover", Icons.Rounded.Image, accent = false, modifier = Modifier.weight(1f)) {
                    if (tracks.isNotEmpty()) { onDismiss(); editor.changeCover(tracks) }
                }
            }
            }
        }
    }
}

/** The picture, scaled down only when it's larger than a phone screen could show (it can be several thousand pixels). */
private fun decode(bytes: ByteArray): android.graphics.Bitmap? {
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 3000) sample *= 2
    return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
}
