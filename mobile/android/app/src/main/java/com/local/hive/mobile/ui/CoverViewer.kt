package com.local.hive.mobile.ui

import coil3.request.allowHardware
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.local.hive.mobile.data.EmbeddedPictures
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/** A distinct cover image discovered for the album or track. */
data class ViewerCover(
    val bytes: ByteArray,
    val title: String,
    val caption: String? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ViewerCover) return false
        return bytes.contentEquals(other.bytes) && title == other.title && caption == other.caption
    }

    override fun hashCode(): Int {
        var result = bytes.contentHashCode()
        result = 31 * result + title.hashCode()
        result = 31 * result + (caption?.hashCode() ?: 0)
        return result
    }
}

/**
 * Discovers distinct covers:
 * - When viewing a single song (tracks.size == 1): discovers ONLY that song's covers (e.g. Von dutch's 3 covers),
 *   never pulling in covers from other songs on the album.
 * - When viewing the full album (tracks.size > 1): discovers all distinct covers across the album.
 */
suspend fun discoverCovers(
    context: android.content.Context,
    vm: MainViewModel,
    tracks: List<Track>,
    fallback: Any?,
    defaultName: String
): List<ViewerCover> = withContext(Dispatchers.IO) {
    val results = mutableListOf<ViewerCover>()
    val seenSha1 = mutableSetOf<String>()
    val seenByteArrays = mutableListOf<ByteArray>()

    fun sha1Hex(b: ByteArray): String =
        MessageDigest.getInstance("SHA-1").digest(b).joinToString("") { "%02x".format(it) }

    fun isDuplicate(b: ByteArray): Boolean {
        val h = sha1Hex(b)
        if (h in seenSha1) return true
        for (seen in seenByteArrays) {
            if (EmbeddedPictures.looksAlike(seen, b)) return true
        }
        return false
    }

    fun add(bytes: ByteArray, caption: String?) {
        if (bytes.isEmpty() || isDuplicate(bytes)) return
        seenSha1 += sha1Hex(bytes)
        seenByteArrays += bytes
        val index = results.size + 1
        results += ViewerCover(bytes, "Cover $index", caption)
    }

    // 1. Single track view (e.g. Now Playing player or track info):
    //    Inspect ONLY this song's file. Do NOT merge covers from other songs in the album!
    if (tracks.size == 1) {
        val track = tracks.first()
        val songName = track.title.ifBlank { defaultName }
        val pics = runCatching {
            context.contentResolver.openInputStream(track.uri)?.use { EmbeddedPictures.readTyped(it) }
        }.getOrNull().orEmpty()

        val frontIdx = pics.indexOfFirst { it.type == EmbeddedPictures.FRONT }
        val sortedPics = if (frontIdx > 0) {
            val list = pics.toMutableList()
            val front = list.removeAt(frontIdx)
            list.add(0, front)
            list
        } else pics

        for (pic in sortedPics) {
            add(pic.data, songName)
        }

        if (results.isEmpty()) {
            val fb = runCatching { vm.fullCover(track) }.getOrNull()
            if (fb != null) add(fb, songName)
        }
    } else if (tracks.size > 1) {
        // 2. Full album view: inspect all tracks across the album
        val albumName = defaultName.ifBlank { tracks.firstOrNull()?.album.orEmpty() }

        // Start with the first track
        val firstTrack = tracks.first()
        val firstPics = runCatching {
            context.contentResolver.openInputStream(firstTrack.uri)?.use { EmbeddedPictures.readTyped(it) }
        }.getOrNull().orEmpty()

        val frontIdx = firstPics.indexOfFirst { it.type == EmbeddedPictures.FRONT }
        val sortedFirstPics = if (frontIdx > 0) {
            val list = firstPics.toMutableList()
            val front = list.removeAt(frontIdx)
            list.add(0, front)
            list
        } else firstPics

        for (pic in sortedFirstPics) {
            add(pic.data, albumName)
        }

        // Scan remaining tracks for any songs with distinct single art (e.g. Von dutch on BRAT)
        for (i in 1 until tracks.size) {
            val t = tracks[i]
            val pics = runCatching {
                context.contentResolver.openInputStream(t.uri)?.use { EmbeddedPictures.readTyped(it) }
            }.getOrNull().orEmpty()
            for (pic in pics) {
                add(pic.data, t.title.ifBlank { albumName })
            }
        }

        // Online alternate for the album
        firstTrack.albumId.let { albId ->
            val alt = EmbeddedPictures.onlineAlternate(context, albId)
            if (alt != null && alt.exists() && alt.length() > 0) {
                runCatching { alt.readBytes() }.getOrNull()?.let { altBytes ->
                    add(altBytes, albumName)
                }
            }
        }
    }

    // 3. Fallback (e.g. streaming track/album where no local files exist)
    if (results.isEmpty() && fallback != null) {
        val fbBytes = runCatching {
            val r = coil3.SingletonImageLoader.get(context).execute(
                coil3.request.ImageRequest.Builder(context)
                    .data(fallback)
                    .size(coil3.size.Size.ORIGINAL)
                    .allowHardware(false)
                    .build()
            )
            (r.image as? coil3.BitmapImage)?.bitmap?.let { bm ->
                java.io.ByteArrayOutputStream().use { os ->
                    bm.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, os)
                    os.toByteArray()
                }
            }
        }.getOrNull()
        if (fbBytes != null) {
            add(fbBytes, defaultName)
        }
    }

    results
}

/**
 * An album or song cover over the whole screen, at the size it is in the song file:
 * pinch or double tap to zoom, drag to look around.
 *
 * When an album or song has multiple covers:
 * - Desktop-style navigation arrows on the sides and discrete indicator dots allow moving between covers.
 * - Captions show the song title (e.g. "Von dutch") or album title.
 * - Save puts the active picture in Pictures/Hive; Edit cover opens the cover editor.
 */
@Composable
fun CoverViewer(vm: MainViewModel, tracks: List<Track>, fallback: Any?, name: String, onDismiss: () -> Unit) {
    val editor = LocalEditor.current
    val scope = rememberCoroutineScope()
    val first = tracks.firstOrNull()
    val context = androidx.compose.ui.platform.LocalContext.current

    val covers by produceState<List<ViewerCover>>(emptyList(), tracks, fallback, name) {
        val quick = withContext(Dispatchers.IO) {
            tracks.firstOrNull()?.let { vm.fullCover(it) }
        }
        if (quick != null) {
            val initialCaption = if (tracks.size == 1) first?.title?.ifBlank { name } else name
            value = listOf(ViewerCover(quick, "Cover 1", initialCaption))
        }
        val all = discoverCovers(context, vm, tracks, fallback, name)
        if (all.isNotEmpty()) {
            value = all
        }
    }

    val pageCount = covers.size.coerceAtLeast(1)
    val pagerState = rememberPagerState(initialPage = 0) { pageCount }

    // Photo-style zoom: pinch zooms into the point between the fingers and pan drags the picture, kept
    // inside its frame so it can't be flung off; double tap toggles 1x and 2.5x at the tapped point.
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var frame by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }

    LaunchedEffect(pagerState.currentPage) {
        scale = 1f
        offset = Offset.Zero
    }

    val bitmaps = remember { mutableStateMapOf<Int, ImageBitmap>() }
    val coverKeys = remember(covers) { covers.map { it.bytes.size to it.title } }
    LaunchedEffect(coverKeys) {
        bitmaps.clear()
    }
    LaunchedEffect(covers, pagerState.currentPage) {
        if (covers.isEmpty()) return@LaunchedEffect
        val cur = pagerState.currentPage.coerceIn(0, covers.size - 1)
        val toLoad = listOf(cur, cur - 1, cur + 1).filter { it in covers.indices }
        for (i in toLoad) {
            if (!bitmaps.containsKey(i)) {
                withContext(Dispatchers.Default) {
                    decode(covers[i].bytes)?.asImageBitmap()?.let { bitmaps[i] = it }
                }
            }
        }
    }

    val currentCover = covers.getOrNull(pagerState.currentPage) ?: covers.firstOrNull()
    val activeBitmap = bitmaps[pagerState.currentPage]
    val glows by produceState<List<Color>?>(null, activeBitmap) {
        value = activeBitmap?.let { b ->
            withContext(Dispatchers.Default) {
                val q = android.graphics.Bitmap.createScaledBitmap(b.asAndroidBitmap(), 2, 2, true)
                val all = android.graphics.Bitmap.createScaledBitmap(b.asAndroidBitmap(), 1, 1, true)
                listOf(q.getPixel(0, 0), q.getPixel(1, 0), q.getPixel(0, 1), q.getPixel(1, 1), all.getPixel(0, 0)).map { Color(it) }
            }
        }
    }
    val aura by produceState<AuraColors?>(null, first?.albumId) { value = first?.albumId?.let { vm.albumColors(it) } }

    var saved by remember { mutableStateOf<String?>(null) }
    var savedOk by remember { mutableStateOf(false) }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    LaunchedEffect(saved) { if (saved != null) { kotlinx.coroutines.delay(2_600); saved = null } }

    var appear by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) { Animatable(0f).animateTo(1f, tween(220)) { appear = value } }

    fun clamp(s: Float, o: Offset): Offset {
        val mx = (frame.width * (s - 1f) / 2f).coerceAtLeast(0f)
        val my = (frame.height * (s - 1f) / 2f).coerceAtLeast(0f)
        return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
    }
    fun onGesture(centroid: Offset, pan: Offset, zoomChange: Float) {
        val s0 = scale
        val s1 = (s0 * zoomChange).coerceIn(1f, 5f)
        val c = Offset(frame.width / 2f, frame.height / 2f)
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
            val bg = Hive.colors.bg
            val g = glows ?: listOf(aura?.primary ?: Hive.colors.ambientA, aura?.secondary ?: Hive.colors.ambientB, aura?.secondary ?: Hive.colors.ambientB, aura?.primary ?: Hive.colors.ambientA, aura?.primary ?: bg)
            androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
                drawRect(androidx.compose.ui.graphics.lerp(g[4], bg, 0.72f))
                val r = maxOf(size.width, size.height) * 0.75f
                listOf(Offset(0f, 0f), Offset(size.width, 0f), Offset(0f, size.height), Offset(size.width, size.height)).forEachIndexed { i, at ->
                    drawCircle(androidx.compose.ui.graphics.Brush.radialGradient(listOf(g[i].copy(alpha = 0.55f), g[i].copy(alpha = 0.18f), Color.Transparent), at, r), r, at)
                }
                drawRect(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.22f), Color.Black.copy(alpha = 0.12f), Color.Black.copy(alpha = 0.38f))))
            }

            HorizontalPager(
                state = pagerState,
                modifier = Modifier.fillMaxSize(),
                userScrollEnabled = scale <= 1.05f
            ) { page ->
                val isCurrent = page == pagerState.currentPage
                val bmp = bitmaps[page]
                Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .aspectRatio(1f)
                            .padding(horizontal = 48.dp, vertical = 12.dp)
                            .onSizeChanged { if (isCurrent) frame = it }
                            .graphicsLayer {
                                if (isCurrent) {
                                    val s = (0.92f + 0.08f * appear) * scale
                                    scaleX = s; scaleY = s; translationX = offset.x; translationY = offset.y
                                }
                                alpha = appear
                            }
                            .then(
                                if (isCurrent) {
                                    Modifier.pointerInput(Unit) {
                                        detectTransformGestures { centroid, pan, zoomChange, _ -> onGesture(centroid, pan, zoomChange) }
                                    }
                                } else Modifier
                            )
                            .pointerInput(Unit) {
                                detectTapGestures(onDoubleTap = { tap ->
                                    if (scale > 1f) animateTo(1f, Offset.Zero)
                                    else { val c = Offset(frame.width / 2f, frame.height / 2f); animateTo(2.5f, clamp(2.5f, (tap - c) * (1f - 2.5f))) }
                                })
                            }
                    ) {
                        if (bmp != null) {
                            Image(
                                bmp,
                                contentDescription = covers.getOrNull(page)?.caption ?: covers.getOrNull(page)?.title ?: "Cover",
                                modifier = Modifier.fillMaxSize().softShadow(28.dp, HiveShape.art, aura?.primary ?: Color.Black),
                                contentScale = ContentScale.Fit
                            )
                        } else {
                            Artwork(
                                covers.getOrNull(page)?.bytes ?: fallback,
                                Modifier.fillMaxSize(),
                                HiveShape.art,
                                Icons.Rounded.LibraryMusic,
                                glow = aura?.primary,
                                elevation = 28.dp,
                                highQuality = true
                            )
                        }
                    }
                }
            }

            // Desktop-style side navigation arrows (Chevron left and right)
            if (covers.size > 1) {
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .padding(start = 12.dp)
                ) {
                    ControlButton(
                        Icons.AutoMirrored.Rounded.KeyboardArrowLeft,
                        "Previous cover",
                        {
                            haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                            scope.launch {
                                val prev = (pagerState.currentPage - 1 + pageCount) % pageCount
                                pagerState.animateScrollToPage(prev)
                            }
                        },
                        size = 44.dp
                    )
                }

                Box(
                    Modifier
                        .align(Alignment.CenterEnd)
                        .padding(end = 12.dp)
                ) {
                    ControlButton(
                        Icons.AutoMirrored.Rounded.KeyboardArrowRight,
                        "Next cover",
                        {
                            haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                            scope.launch {
                                val next = (pagerState.currentPage + 1) % pageCount
                                pagerState.animateScrollToPage(next)
                            }
                        },
                        size = 44.dp
                    )
                }
            }

            // Top Bar: page indicator on left if multiple covers, Close on right
            Row(
                Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (covers.size > 1) {
                    Box(
                        Modifier
                            .hiveGlass(HiveShape.pill, strength = 0.3f)
                            .padding(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Text(
                            "${pagerState.currentPage + 1} / ${covers.size}",
                            style = HiveText.rowStrong,
                            color = Hive.colors.text
                        )
                    }
                } else {
                    Spacer(Modifier.size(44.dp))
                }
                ControlButton(Icons.Rounded.Close, "Close", onDismiss, size = 44.dp)
            }

            // Bottom controls
            Column(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 24.dp, vertical = 20.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                androidx.compose.animation.AnimatedVisibility(
                    saved != null,
                    enter = androidx.compose.animation.fadeIn(tween(160)) + androidx.compose.animation.scaleIn(androidx.compose.animation.core.spring(dampingRatio = 0.6f, stiffness = 600f), initialScale = 0.8f) + androidx.compose.animation.slideInVertically(tween(200)) { it / 2 },
                    exit = androidx.compose.animation.fadeOut(tween(220)) + androidx.compose.animation.slideOutVertically(tween(220)) { it / 3 }
                ) {
                    var last by remember { mutableStateOf("") }
                    saved?.let { last = it }
                    Row(Modifier.padding(bottom = 14.dp).hiveGlass(HiveShape.pill, strength = 0.3f).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (savedOk) Icons.Rounded.CheckCircle else Icons.Rounded.ErrorOutline, null, tint = if (savedOk) Hive.colors.accent else Hive.colors.text, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(last, style = HiveText.rowStrong, color = Hive.colors.text)
                    }
                }

                // Caption (e.g. "Von dutch" or "The Life of Pablo"):
                currentCover?.caption?.takeIf { it.isNotBlank() }?.let { cap ->
                    Text(
                        text = cap,
                        style = HiveText.rowStrong,
                        color = Hive.colors.text,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                }

                // Desktop-style discrete dots for multiple covers
                if (covers.size > 1) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(bottom = 14.dp)
                    ) {
                        covers.forEachIndexed { i, _ ->
                            val active = pagerState.currentPage == i
                            Box(
                                Modifier
                                    .size(if (active) 8.dp else 6.dp)
                                    .clip(androidx.compose.foundation.shape.CircleShape)
                                    .background(if (active) Hive.colors.accent else Hive.colors.textDimmer.copy(alpha = 0.45f))
                                    .clickable {
                                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                                        scope.launch { pagerState.animateScrollToPage(i) }
                                    }
                            )
                        }
                    }
                }

                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PillButton(if (saved != null && savedOk) "Saved" else "Save", if (saved != null && savedOk) Icons.Rounded.Check else Icons.Rounded.Download, accent = true, modifier = Modifier.weight(1f)) {
                        val b = currentCover?.bytes
                        if (b == null) {
                            savedOk = false
                            saved = "This cover isn't available to save"
                        } else {
                            val suffix = if (covers.size > 1) " - ${pagerState.currentPage + 1}" else ""
                            vm.savePicture(b, "${first?.displayAlbumArtist.orEmpty()} - $name$suffix".trim(' ', '-')) { msg ->
                                savedOk = msg.startsWith("Cover saved")
                                saved = if (savedOk) "Saved to Pictures › Hive" else msg
                                if (savedOk) haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.Confirm)
                            }
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
