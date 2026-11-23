package com.local.hive.mobile.ui

import coil3.request.allowHardware
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/** A distinct cover image discovered for the album or track. */
data class ViewerCover(
    val bytes: ByteArray,
    val title: String,
    val subtitle: String? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ViewerCover) return false
        return bytes.contentEquals(other.bytes) && title == other.title && subtitle == other.subtitle
    }

    override fun hashCode(): Int {
        var result = bytes.contentHashCode()
        result = 31 * result + title.hashCode()
        result = 31 * result + (subtitle?.hashCode() ?: 0)
        return result
    }
}

/**
 * Discovers all distinct covers for an album or track:
 * - Multiple embedded pictures in a song's file (front cover, back cover, alternates)
 * - Distinct covers across different songs of the same album (e.g. Von dutch on BRAT)
 * - Album online alternate cover if available
 * - Fallback / streaming artwork if distinct
 */
suspend fun discoverCovers(
    context: android.content.Context,
    vm: MainViewModel,
    tracks: List<Track>,
    fallback: Any?
): List<ViewerCover> = withContext(Dispatchers.IO) {
    val allTracks = if (tracks.size == 1) {
        val single = tracks.first()
        val albumTracks = runCatching { vm.albumTracks(single.albumId).first() }.getOrNull().orEmpty()
        if (albumTracks.isNotEmpty()) {
            listOf(single) + albumTracks.filter { it.id != single.id }
        } else tracks
    } else tracks

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

    fun add(bytes: ByteArray, type: Int? = null, trackTitle: String? = null, subtitle: String? = null) {
        if (bytes.isEmpty() || isDuplicate(bytes)) return
        seenSha1 += sha1Hex(bytes)
        seenByteArrays += bytes
        val index = results.size + 1
        val isFirstTrack = trackTitle == allTracks.firstOrNull()?.title
        val sub = subtitle ?: when {
            trackTitle != null && allTracks.size > 1 && !isFirstTrack -> trackTitle
            type == EmbeddedPictures.FRONT -> "Front cover"
            type == EmbeddedPictures.BACK -> "Back cover"
            else -> null
        }
        results += ViewerCover(bytes, "Cover $index", sub)
    }

    if (allTracks.isNotEmpty()) {
        val firstTrack = allTracks.first()
        val firstPics = runCatching {
            context.contentResolver.openInputStream(firstTrack.uri)?.use { EmbeddedPictures.readTyped(it) }
        }.getOrNull().orEmpty()

        // Place FRONT cover first if marked
        val frontIdx = firstPics.indexOfFirst { it.type == EmbeddedPictures.FRONT }
        val sortedFirstPics = if (frontIdx > 0) {
            val list = firstPics.toMutableList()
            val front = list.removeAt(frontIdx)
            list.add(0, front)
            list
        } else firstPics

        for (pic in sortedFirstPics) {
            add(pic.data, type = pic.type, trackTitle = firstTrack.title)
        }

        // Remaining tracks (if any)
        for (i in 1 until allTracks.size) {
            val t = allTracks[i]
            val pics = runCatching {
                context.contentResolver.openInputStream(t.uri)?.use { EmbeddedPictures.readTyped(it) }
            }.getOrNull().orEmpty()
            for (pic in pics) {
                add(pic.data, type = pic.type, trackTitle = t.title)
            }
        }

        // Check online alternate
        firstTrack.albumId.let { albId ->
            val alt = EmbeddedPictures.onlineAlternate(context, albId)
            if (alt != null && alt.exists() && alt.length() > 0) {
                runCatching { alt.readBytes() }.getOrNull()?.let { altBytes ->
                    add(altBytes, subtitle = "Alternate cover")
                }
            }
        }

        if (results.isEmpty()) {
            val fallbackTrackCover = runCatching { vm.fullCover(firstTrack) }.getOrNull()
            if (fallbackTrackCover != null) {
                add(fallbackTrackCover, subtitle = "Cover 1")
            }
        }
    }

    // Fallback cover (e.g. coil load from URL or content URI)
    if (fallback != null) {
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
            add(fbBytes, subtitle = if (results.isEmpty()) null else "Album cover")
        }
    }

    results
}

/**
 * An album or song cover over the whole screen, at the size it is in the song file:
 * pinch or double tap to zoom, drag to look around.
 *
 * When an album or song has multiple covers (e.g. The Life of Pablo's 3 covers, or Von dutch
 * carrying distinct single art from the rest of the album), Cover 1, Cover 2, Cover 3 chips
 * and a swipeable pager allow viewing each cover in full resolution.
 *
 * Save puts the active picture in Pictures/Hive; Edit cover opens the cover editor.
 */
@Composable
fun CoverViewer(vm: MainViewModel, tracks: List<Track>, fallback: Any?, name: String, onDismiss: () -> Unit) {
    val editor = LocalEditor.current
    val scope = rememberCoroutineScope()
    val first = tracks.firstOrNull()
    val context = androidx.compose.ui.platform.LocalContext.current

    val covers by produceState<List<ViewerCover>>(emptyList(), tracks, fallback) {
        val quick = withContext(Dispatchers.IO) {
            tracks.firstOrNull()?.let { vm.fullCover(it) }
        }
        if (quick != null) {
            value = listOf(ViewerCover(quick, "Cover 1", if (tracks.size > 1) "Front cover" else null))
        }
        val all = discoverCovers(context, vm, tracks, fallback)
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
                            .padding(12.dp)
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
                                contentDescription = covers.getOrNull(page)?.title ?: "Album cover",
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

                // Multi-cover selector chips (Cover 1, Cover 2, Cover 3...)
                if (covers.size > 1) {
                    currentCover?.subtitle?.let { sub ->
                        Text(
                            sub,
                            style = HiveText.small,
                            color = Hive.colors.textDim,
                            modifier = Modifier.padding(bottom = 6.dp)
                        )
                    }
                    Row(
                        Modifier
                            .padding(bottom = 12.dp)
                            .hiveGlass(HiveShape.pill, strength = 0.28f)
                            .then(
                                if (covers.size > 4) Modifier.horizontalScroll(rememberScrollState())
                                else Modifier
                            )
                            .padding(horizontal = 6.dp, vertical = 5.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        covers.forEachIndexed { i, c ->
                            val active = pagerState.currentPage == i
                            Box(
                                Modifier
                                    .clip(HiveShape.pill)
                                    .background(if (active) Hive.colors.accent else Color.Transparent)
                                    .clickable {
                                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove)
                                        scope.launch { pagerState.animateScrollToPage(i) }
                                    }
                                    .padding(horizontal = 14.dp, vertical = 7.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = c.title,
                                    style = HiveText.rowStrong.copy(fontWeight = if (active) androidx.compose.ui.text.font.FontWeight.Bold else androidx.compose.ui.text.font.FontWeight.Normal),
                                    color = if (active) readableOn(Hive.colors.accent) else Hive.colors.text
                                )
                            }
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
                            val suffix = if (covers.size > 1) " - ${currentCover.title}" else ""
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
