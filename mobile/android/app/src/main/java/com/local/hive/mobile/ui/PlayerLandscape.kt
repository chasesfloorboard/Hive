package com.local.hive.mobile.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveIcons
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.Motion

/**
 * Sideways (landscape) Now Playing layout: square cover art on the left,
 * playback controls (or the live Playing tracks queue) on the right.
 * Kept in its own focused file so PlayerScreens.kt stays clean and modular.
 */
@Composable
internal fun FullPlayerLandscapeContent(
    vm: MainViewModel,
    now: NowPlaying,
    current: Track?,
    upNext: com.local.hive.mobile.playback.QueueItem?,
    queueOpen: Boolean,
    onQueueChange: (Boolean) -> Unit,
    swipe: Animatable<Float, *>,
    topBar: @Composable () -> Unit,
    onOpenArtist: (Track) -> Unit,
    onOpenAlbum: (Track) -> Unit,
    onAddToPlaylist: (Track) -> Unit,
    onOpenLyrics: () -> Unit,
    onOpenCoverViewer: () -> Unit,
    onArtPlaced: (Rect) -> Unit,
) {
    val c = Hive.colors
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val nowLoved by vm.nowLoved.collectAsStateWithLifecycle()
    val isLoved = nowLoved == true

    Column(Modifier.fillMaxSize()) {
        topBar()
        Row(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Left pane: full-height square cover stage (flying Artwork lands here via onArtPlaced).
            BoxWithConstraints(
                Modifier
                    .weight(0.44f)
                    .fillMaxHeight(),
                contentAlignment = Alignment.Center,
            ) {
                val side = minOf(maxWidth, maxHeight - 8.dp).coerceAtLeast(120.dp)
                Box(
                    Modifier
                        .size(side)
                        .onGloballyPositioned { co ->
                            onArtPlaced(
                                Rect(
                                    co.localToRoot(Offset.Zero),
                                    co.localToRoot(Offset(co.size.width.toFloat(), co.size.height.toFloat())),
                                )
                            )
                        }
                        .songSwipe(swipe, scope, onNext = { vm.player.next() }, onPrevious = { vm.player.previous() })
                        .pointerInput(now.isLive, now.artworkUri) {
                            detectTapGestures(
                                onTap = { if (!now.isLive) onOpenLyrics() },
                                onLongPress = {
                                    if (now.artworkUri != null) {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        onOpenCoverViewer()
                                    }
                                },
                            )
                        }
                )
            }

            // Right pane: either the song metadata + seek + transport, or the scrollable queue beside the art.
            Box(
                Modifier
                    .weight(0.56f)
                    .fillMaxHeight(),
            ) {
                Crossfade(queueOpen, animationSpec = tween(220), label = "landscapeRightPane") { showQueue ->
                    if (showQueue) {
                        Column(Modifier.fillMaxSize()) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(bottom = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        now.title.ifBlank { "Nothing playing" },
                                        style = HiveText.rowStrong.copy(fontWeight = FontWeight.SemiBold),
                                        color = c.text,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        "${now.queueIndex + 1} of ${now.queue.size} · ${formatLength(now.queue.drop(now.queueIndex + 1).sumOf { it.durationMs })} left",
                                        style = HiveText.small,
                                        color = c.textDim,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                BarIcon(Icons.Rounded.Close, "Close queue", { onQueueChange(false) })
                            }
                            QueueList(
                                vm,
                                Modifier.weight(1f).fillMaxWidth(),
                                onOpenAlbum = onOpenAlbum,
                                onOpenArtist = onOpenArtist,
                                onAddToPlaylist = onAddToPlaylist,
                            )
                        }
                    } else {
                        Column(
                            Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.SpaceEvenly,
                        ) {
                            // Title + artist + heart row
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                TrackMetaTransition(
                                    now = now,
                                    wentBack = { vm.player.wentBack() },
                                    centered = false,
                                    onArtistClick = { current?.let(onOpenArtist) },
                                    modifier = Modifier.weight(1f),
                                )
                                if (nowLoved != null) {
                                    Spacer(Modifier.width(4.dp))
                                    TransportButton(
                                        if (isLoved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder,
                                        if (isLoved) "Remove from Favorites" else "Add to Favorites",
                                        24.dp,
                                        tint = if (isLoved) c.accent else c.text,
                                    ) { vm.toggleNowLoved() }
                                }
                            }

                            SeekBar(now, vm.position, onSeek = { vm.player.seekTo(it) })

                            Row(
                                Modifier.fillMaxWidth().height(72.dp).padding(horizontal = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (now.isLive) Spacer(Modifier.size(48.dp)) else ShuffleButton(now.shuffle) { vm.player.toggleShuffle() }
                                SkipButton(HiveIcons.Previous, "Previous", forward = false, vm = vm, iconSize = 32.dp)
                                AccentPlayButton(now.isPlaying, { vm.player.togglePlay() }, size = 62.dp)
                                SkipButton(HiveIcons.Next, "Next", forward = true, vm = vm, iconSize = 32.dp)
                                if (now.isLive) Spacer(Modifier.size(48.dp)) else RepeatButton(now.repeatMode) { vm.player.cycleRepeat() }
                            }

                            Row(
                                Modifier.fillMaxWidth().height(48.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                current?.let { t -> TransportButton(Icons.Rounded.Add, "Add to playlist", 24.dp) { onAddToPlaylist(t) } } ?: Spacer(Modifier.size(56.dp))
                                Text(
                                    upNext?.let { "Next: " + listOf(it.title, it.artist).filter { s -> s.isNotBlank() }.joinToString(" · ") } ?: "",
                                    style = HiveText.small,
                                    color = c.textDim,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f).clip(HiveShape.pill).clickable { onQueueChange(true) }.padding(horizontal = 8.dp, vertical = 8.dp),
                                )
                                TransportButton(Icons.AutoMirrored.Rounded.QueueMusic, "Queue", 22.dp, active = null) { onQueueChange(true) }
                            }
                        }
                    }
                }
            }
        }
    }
}
