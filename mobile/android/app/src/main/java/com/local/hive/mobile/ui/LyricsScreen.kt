package com.local.hive.mobile.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.stream.Lyrics
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveAmbient
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.delay

/**
 * Lyrics for the playing song, as Hive's highlighted lyrics: synced lines
 * light up with the song and keep the current line in view, and a tap on a
 * line jumps there. Plain lyrics simply scroll.
 */
@Composable
fun LyricsScreen(vm: MainViewModel, onClose: () -> Unit) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    var lyrics by remember { mutableStateOf<Lyrics?>(null) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(now.mediaId, now.title) {
        loading = true
        lyrics = runCatching { vm.lyrics(now) }.getOrNull()
        loading = false
    }
    // A 30-second preview is a clip from inside the song, so its clock can't drive synced lines.
    val fullLength = now.queue.getOrNull(now.queueIndex)?.durationMs ?: 0
    val preview = now.trackId == null && now.durationMs in 1..40_000 && fullLength > 60_000
    val lines = remember(lyrics, preview) { if (preview) emptyList() else lyrics?.lines().orEmpty() }

    // The player reports its position twice a second; between reports the position is projected forward.
    val reported by vm.position.collectAsStateWithLifecycle()
    var position by remember { mutableLongStateOf(reported) }
    LaunchedEffect(reported, now.isPlaying) {
        val base = reported
        val at = System.currentTimeMillis()
        position = base
        while (now.isPlaying) { delay(80); position = base + (System.currentTimeMillis() - at) }
    }
    val active = remember(lines, position) { lines.indexOfLast { it.timeMs <= position + 150 } }
    val list = rememberLazyListState()
    val density = LocalDensity.current
    LaunchedEffect(active) {
        // Keep the current line a third of the way down the page.
        if (active >= 0) list.animateScrollToItem(active, scrollOffset = -with(density) { 220.dp.roundToPx() })
    }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        HiveAmbient(aura?.primary?.copy(alpha = 0.75f) ?: c.ambientA, aura?.secondary?.copy(alpha = 0.6f) ?: c.ambientB, Modifier.fillMaxSize().background(c.bg), intensity = 1.3f)
    }, overlay = {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Artwork(now.artworkUri, Modifier.size(46.dp), RoundedCornerShape(8.dp))
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(now.title, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(now.artist, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 42.dp)
                Box(Modifier.padding(start = 8.dp).size(42.dp).hiveGlass(CircleShape).clickable(onClick = onClose), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.KeyboardArrowDown, "Close lyrics", tint = c.text, modifier = Modifier.size(24.dp))
                }
            }
            val l = lyrics
            when {
                loading -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.accent) }
                l == null -> Box(Modifier.weight(1f).fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    EmptyState("No lyrics found", "LRCLIB and Genius don't have words for this song.")
                }
                lines.isNotEmpty() -> LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(top = 120.dp, bottom = 320.dp)) {
                    itemsIndexed(lines) { i, line -> LyricLineRow(line.text, i == active, i < active) { vm.player.seekTo(line.timeMs) } }
                }
                else -> Text(
                    if (l.synced) l.lines().joinToString("\n") { it.text } else l.text, style = HiveText.body.copy(fontSize = 19.sp, lineHeight = 30.sp, fontWeight = FontWeight.Medium), color = c.text,
                    modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 26.dp, vertical = 24.dp),
                )
            }
            if (l != null) Text(if (preview && l.synced) "Lyrics from ${l.source} · they follow along when the full song plays" else "Lyrics from ${l.source}", style = HiveText.small, color = c.textDimmer, modifier = Modifier.padding(start = 26.dp, bottom = 10.dp, top = 6.dp))
        }
    })
}

@Composable
private fun LyricLineRow(text: String, current: Boolean, past: Boolean, onClick: () -> Unit) {
    val c = Hive.colors
    val color by animateColorAsState(when { current -> c.text; past -> c.text.copy(alpha = 0.42f); else -> c.text.copy(alpha = 0.30f) }, tween(260), label = "line")
    val scale by animateFloatAsState(if (current) 1f else 0.94f, tween(260), label = "lineScale")
    if (text.isBlank()) {
        // An instrumental gap: a short accent bar rather than an empty row.
        Box(Modifier.padding(horizontal = 26.dp, vertical = 14.dp).width(if (current) 46.dp else 22.dp).height(4.dp).clip(HiveShape.pill).background(if (current) c.accent else c.text.copy(alpha = 0.2f)))
        return
    }
    Text(
        text, color = color,
        style = HiveText.body.copy(fontSize = 25.sp, lineHeight = 33.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 26.dp, vertical = 9.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale; transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0.5f) },
    )
}
