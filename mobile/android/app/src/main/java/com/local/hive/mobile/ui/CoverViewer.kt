package com.local.hive.mobile.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
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
    val toast = LocalToast.current
    val editor = LocalEditor.current
    val scope = rememberCoroutineScope()
    val first = tracks.firstOrNull()
    // The song's own picture at full size; the phone's album art meanwhile, or when the file has none.
    val bytes by produceState<ByteArray?>(null, first?.id) { value = first?.let { vm.fullCover(it) } }
    val full by produceState<ImageBitmap?>(null, bytes) {
        value = bytes?.let { b -> withContext(Dispatchers.Default) { decode(b)?.asImageBitmap() } }
    }
    val zoom = remember { Animatable(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var appear by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) { Animatable(0f).animateTo(1f, tween(220)) { appear = value } }
    val transform = rememberTransformableState { change, offset, _ ->
        scope.launch { zoom.snapTo((zoom.value * change).coerceIn(1f, 5f)) }
        pan = if (zoom.value <= 1f) Offset.Zero else pan + offset
    }
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.92f * appear)).pointerInput(Unit) { detectTapGestures { onDismiss() } }) {
            Box(
                Modifier.align(Alignment.Center).fillMaxWidth().aspectRatio(1f).padding(12.dp)
                    .graphicsLayer {
                        val s = (0.92f + 0.08f * appear) * zoom.value
                        scaleX = s; scaleY = s; translationX = pan.x; translationY = pan.y; alpha = appear
                    }
                    .transformable(transform)
                    .pointerInput(Unit) {
                        detectTapGestures(onDoubleTap = {
                            scope.launch { if (zoom.value > 1f) { pan = Offset.Zero; zoom.animateTo(1f, tween(200)) } else zoom.animateTo(2.5f, tween(200)) }
                        })
                    },
            ) {
                val bitmap = full
                if (bitmap != null) Image(bitmap, "Album cover", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                else Artwork(fallback, Modifier.fillMaxSize(), HiveShape.art, Icons.Rounded.LibraryMusic)
            }
            Row(Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp)) {
                ControlButton(Icons.Rounded.Close, "Close", onDismiss, size = 44.dp)
            }
            Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 20.dp).graphicsLayer { alpha = appear },
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton("Save", Icons.Rounded.Download, accent = true, modifier = Modifier.weight(1f)) {
                    val b = bytes
                    if (b == null) toast("This album's songs have no cover of their own to save")
                    else vm.savePicture(b, "${first?.displayAlbumArtist.orEmpty()} - $name".trim(' ', '-'), toast)
                }
                PillButton("Edit cover", Icons.Rounded.Image, accent = false, modifier = Modifier.weight(1f)) {
                    if (tracks.isNotEmpty()) { onDismiss(); editor.changeCover(tracks) }
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
