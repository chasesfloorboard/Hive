package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText

/**
 * Resolves the horizontal slide direction for a track change:
 * `+1` = forward (new song slides in right -> left, old slides out center -> left),
 * `-1` = backward (new song slides in left -> right, old slides out center -> right).
 */
internal fun resolveTrackSkipDirection(
    wentBack: Boolean,
    shuffle: Boolean,
    fromIndex: Int,
    toIndex: Int,
    queueSize: Int,
): Int {
    if (wentBack) return -1
    if (!shuffle && fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex) {
        val wrappedForward = queueSize > 1 && fromIndex == queueSize - 1 && toIndex == 0
        if (!wrappedForward) return -1
    }
    return 1
}

private data class TrackMetaSnapshot(
    val key: String,
    val title: String,
    val artist: String,
    val dir: Int,
)

/**
 * Smooth directional slide for Now Playing's title and artist.
 * Captures each track's title/artist immutably in AnimatedContent state (keyed directly on
 * [NowPlaying], never an asynchronously loaded Room Track) and disables SizeTransform with an
 * explicit full-width alignment so text never pins to the left edge before centering.
 */
@Composable
internal fun TrackMetaTransition(
    now: NowPlaying,
    wentBack: () -> Boolean,
    centered: Boolean,
    onArtistClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Hive.colors
    val metaKey = buildString {
        append(now.mediaId.orEmpty())
        append('#')
        append(now.queueIndex)
        if (now.isLive) {
            append('|')
            append(now.title)
        }
    }
    var lastKey by remember { mutableStateOf(metaKey) }
    var lastIndex by remember { mutableIntStateOf(now.queueIndex) }
    var lastDir by remember { mutableIntStateOf(1) }
    if (metaKey != lastKey) {
        lastDir = resolveTrackSkipDirection(
            wentBack = wentBack(),
            shuffle = now.shuffle,
            fromIndex = lastIndex,
            toIndex = now.queueIndex,
            queueSize = now.queue.size,
        )
        lastKey = metaKey
        lastIndex = now.queueIndex
    }
    val snapshot = TrackMetaSnapshot(
        key = metaKey,
        title = now.title.ifBlank { "Nothing playing" },
        artist = now.artist,
        dir = lastDir,
    )
    AnimatedContent(
        targetState = snapshot,
        modifier = modifier.fillMaxWidth().clipToBounds(),
        contentAlignment = if (centered) Alignment.Center else Alignment.CenterStart,
        transitionSpec = {
            val dir = targetState.dir
            val slide = tween<IntOffset>(durationMillis = 300, easing = FastOutSlowInEasing)
            (slideInHorizontally(slide) { dir * it } + fadeIn(tween(240)))
                .togetherWith(slideOutHorizontally(slide) { -dir * it } + fadeOut(tween(180)))
                .using(null)
        },
        contentKey = { it.key },
        label = "trackMeta",
    ) { snap ->
        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = if (centered) Alignment.CenterHorizontally else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(if (centered) 3.dp else 2.dp),
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
                    .drawWithContent {
                        drawContent()
                        val w = size.width.coerceAtLeast(1f)
                        if (centered) {
                            val fade = (18.dp.toPx() / w).coerceIn(0f, 0.25f)
                            drawRect(
                                Brush.horizontalGradient(
                                    0f to Color.Transparent,
                                    fade to Color.Black,
                                    1f - fade to Color.Black,
                                    1f to Color.Transparent,
                                ),
                                blendMode = BlendMode.DstIn,
                            )
                        } else {
                            val fade = (14.dp.toPx() / w).coerceIn(0f, 0.25f)
                            drawRect(
                                Brush.horizontalGradient(
                                    0f to Color.Black,
                                    1f - fade to Color.Black,
                                    1f to Color.Transparent,
                                ),
                                blendMode = BlendMode.DstIn,
                            )
                        }
                    },
                contentAlignment = if (centered) Alignment.Center else Alignment.CenterStart,
            ) {
                Text(
                    snap.title,
                    style = HiveText.npTitle,
                    color = c.text,
                    maxLines = 1,
                    textAlign = if (centered) TextAlign.Center else TextAlign.Start,
                    modifier = Modifier
                        .basicMarquee(
                            iterations = Int.MAX_VALUE,
                            initialDelayMillis = 1_500,
                            repeatDelayMillis = 2_000,
                            velocity = 36.dp,
                        )
                        .padding(
                            start = if (centered) 18.dp else 0.dp,
                            end = if (centered) 18.dp else 14.dp,
                        ),
                )
            }
            Text(
                snap.artist,
                style = HiveText.rowStrong,
                color = c.text.copy(alpha = 0.86f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = if (centered) TextAlign.Center else TextAlign.Start,
                modifier = Modifier
                    .then(if (centered) Modifier.fillMaxWidth() else Modifier)
                    .clickable(onClick = onArtistClick),
            )
        }
    }
}
