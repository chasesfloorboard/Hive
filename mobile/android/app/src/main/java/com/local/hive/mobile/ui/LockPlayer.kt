package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
import android.os.Build
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveAmbient
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.abs

/**
 * Hive over the lock screen while music plays, as Samsung Music's lock
 * player: the time and date, the cover lit and blurred behind (swipe it to
 * change songs, tap it for the lyrics, tap the lyrics for the cover again),
 * the song, the seek bar, and the controls with shuffle and repeat. Swiping
 * up hands over to the phone's own unlock.
 */
@Composable
fun LockPlayer(vm: MainViewModel, onUnlock: () -> Unit) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val aura by vm.aura.collectAsStateWithLifecycle()
    val clock by produceState(LocalDateTime.now()) { while (true) { value = LocalDateTime.now(); kotlinx.coroutines.delay(1_000) } }
    val swipe = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var lift by remember { mutableFloatStateOf(0f) }
    var showLyrics by remember { mutableStateOf(false) }

    Box(
        Modifier.fillMaxSize().background(c.bg).pointerInput(Unit) {
            // A swipe up from anywhere below the cover opens the phone's unlock.
            detectVerticalDragGestures(onDragEnd = { if (lift < -size.height * 0.12f) onUnlock(); lift = 0f }, onDragCancel = { lift = 0f }) { change, dy ->
                change.consume(); lift = (lift + dy).coerceAtMost(0f)
            }
        },
    ) {
        HiveAmbient(aura?.primary?.copy(alpha = 0.7f) ?: c.ambientA, aura?.secondary?.copy(alpha = 0.6f) ?: c.ambientB, Modifier.fillMaxSize(), intensity = 1.25f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Artwork(now.artworkUri, Modifier.fillMaxSize().blur(110.dp).alpha(0.3f), RectangleShape)
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to c.bg.copy(alpha = 0.35f), 0.5f to Color.Transparent, 1f to c.bg.copy(alpha = 0.8f))))

        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
                .graphicsLayer { translationY = lift * 0.35f; alpha = 1f - (abs(lift) / 900f).coerceIn(0f, 0.5f) },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // The phone's own choice of 12- or 24-hour time, as its lock screen shows it.
            val context = androidx.compose.ui.platform.LocalContext.current
            val pattern = if (android.text.format.DateFormat.is24HourFormat(context)) "H:mm" else "h:mm"
            Text(clock.format(DateTimeFormatter.ofPattern(pattern)), style = HiveText.heroTitle.copy(fontSize = 76.sp, lineHeight = 80.sp, fontWeight = FontWeight.Light), color = c.text, modifier = Modifier.padding(top = 28.dp))
            Text(clock.format(DateTimeFormatter.ofPattern("EEEE, MMMM d")), style = HiveText.rowStrong, color = c.text.copy(alpha = 0.85f))
            Spacer(Modifier.weight(1f))
            // The cover and the lyrics share one place; a tap on either shows the other.
            Crossfade(showLyrics, label = "lockCoverLyrics", modifier = Modifier.fillMaxWidth(0.82f).aspectRatio(1f)) { lyrics ->
                if (lyrics) {
                    LyricsBody(vm, Modifier.fillMaxSize().clip(HiveShape.art).background(c.bg.copy(alpha = 0.35f)), onTap = { showLyrics = false }, compact = true)
                } else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    val frame = rotatingCover(now.artworkUri, now.trackId)
                    Artwork(
                        frame.current,
                        Modifier.fillMaxWidth(0.95f).aspectRatio(1f)
                            .songSwipe(swipe, scope, onNext = { vm.player.next() }, onPrevious = { vm.player.previous() })
                            .pointerInput(Unit) { detectTapGestures { showLyrics = true } }
                            .graphicsLayer { translationX = swipe.value; alpha = 1f - (abs(swipe.value) / size.width).coerceIn(0f, 0.9f) },
                        HiveShape.art, Icons.Rounded.MusicNote, glow = aura?.primary ?: c.accentGlow, elevation = 34.dp,
                        replacing = frame.previous,
                    )
                }
            }
            Crossfade(now.title to now.artist, label = "lockText", modifier = Modifier.padding(top = 26.dp)) { (title, artist) ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(title.ifBlank { "Nothing playing" }, style = HiveText.npTitle, color = c.text, maxLines = 1, modifier = Modifier.padding(horizontal = 26.dp), overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    Text(artist, style = HiveText.rowStrong, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
            SeekBar(now, vm.position, onSeek = { vm.player.seekTo(it) })
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp).height(96.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                // As in the player: shuffle and repeat mean nothing to a live station, but keep their places.
                if (now.isLive) Spacer(Modifier.size(48.dp)) else ShuffleButton(now.shuffle) { vm.player.toggleShuffle() }
                TransportButton(HiveIcons.Previous, "Previous", 38.dp) { vm.player.previous() }
                AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 74.dp)
                TransportButton(HiveIcons.Next, "Next", 38.dp) { vm.player.next() }
                if (now.isLive) Spacer(Modifier.size(48.dp)) else RepeatButton(now.repeatMode) { vm.player.cycleRepeat() }
            }
            Spacer(Modifier.weight(0.5f))
            Icon(Icons.Rounded.KeyboardArrowUp, null, tint = c.textDim, modifier = Modifier.size(22.dp))
            Text("Swipe up to unlock", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(bottom = 18.dp))
        }
    }
}
