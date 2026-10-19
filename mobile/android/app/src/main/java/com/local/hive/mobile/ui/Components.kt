package com.local.hive.mobile.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Sort
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.OneUi

// ---- primitives ----

/** Click with a slight press-in, like One UI's list and button feedback. */
@Composable
fun Modifier.pressable(onClick: () -> Unit, pressedScale: Float = 0.97f): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) pressedScale else 1f, spring(stiffness = 900f, dampingRatio = 0.7f), label = "press")
    return scale(scale).clickable(interactionSource = source, indication = null, onClick = onClick)
}

/** Album art; songs without art get Samsung's grey tile with a white note. */
@Composable
fun Artwork(
    model: Any?,
    modifier: Modifier = Modifier,
    shape: Shape = OneUi.Thumb,
    fallback: ImageVector = Icons.Rounded.MusicNote,
    glow: Color? = null,
    elevation: Dp = 0.dp,
) {
    val shadowed = if (elevation > 0.dp) modifier.shadow(elevation, shape, ambientColor = glow ?: Color.Black, spotColor = glow ?: Color.Black) else modifier
    Box(shadowed.clip(shape).background(OneUi.Placeholder), contentAlignment = Alignment.Center) {
        SubcomposeAsyncImage(
            model = model,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            loading = { ArtPlaceholder(fallback) },
            error = { ArtPlaceholder(fallback) },
        )
    }
}

@Composable
private fun ArtPlaceholder(icon: ImageVector) {
    Box(Modifier.fillMaxSize().background(OneUi.Placeholder), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.fillMaxSize(0.42f))
    }
}

/** Samsung's playing indicator: three small bars that move while playing. */
@Composable
fun NowPlayingBars(playing: Boolean, color: Color, modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "bars")
    val heights = listOf(0, 1, 2).map { i ->
        transition.animateFloat(0.25f, 1f, infiniteRepeatable(tween(420 + i * 130), RepeatMode.Reverse), label = "bar$i")
    }
    Canvas(modifier) {
        val gap = size.width * 0.18f
        val barW = (size.width - gap * 2) / 3
        heights.forEachIndexed { i, h ->
            val barH = size.height * (if (playing) h.value else 0.3f)
            drawRoundRect(color, Offset(i * (barW + gap), size.height - barH), Size(barW, barH), CornerRadius(barW / 2))
        }
    }
}

/** A round button on the panel, as beside "Name" in every Samsung list. */
@Composable
fun CircleButton(icon: ImageVector, label: String, onClick: () -> Unit, size: Dp = 36.dp, background: Color = OneUi.Raised) {
    Box(Modifier.size(size).clip(CircleShape).background(background).pressable(onClick, 0.9f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = OneUi.Text1, modifier = Modifier.size(size * 0.56f))
    }
}

/** A plain icon button in a toolbar. */
@Composable
fun BarIcon(icon: ImageVector, label: String, onClick: () -> Unit, tint: Color = OneUi.Text1) {
    Box(Modifier.size(48.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(24.dp))
    }
}

/** "≡ Name" on the left, Shuffle and Play on the right: the top of every list. */
@Composable
fun SortBar(label: String, onShuffle: (() -> Unit)? = null, onPlay: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().height(56.dp).padding(start = 20.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Rounded.Sort, null, tint = OneUi.Text1, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(label, style = OneUi.SortLabel, color = OneUi.Text1, modifier = Modifier.weight(1f))
        trailing?.invoke()
        if (onShuffle != null) CircleButton(Icons.Rounded.Shuffle, "Shuffle", onShuffle)
        if (onPlay != null) { Spacer(Modifier.width(10.dp)); CircleButton(Icons.Rounded.PlayArrow, "Play all", onPlay) }
    }
}

// ---- tracks ----

data class TrackActions(
    val onPlayNext: (Track) -> Unit,
    val onAddToQueue: (Track) -> Unit,
    val onToggleLove: (Track) -> Unit,
    val onGoToAlbum: (Track) -> Unit,
    val onGoToArtist: (Track) -> Unit,
)

/**
 * A song as Samsung Music lists it: 48dp art with 11dp corners (or the track
 * number on album pages), title over artist, the duration on numbered rows,
 * and ⋮. A hairline divider starts under the text. The playing song turns
 * One UI blue.
 */
@Composable
fun TrackRow(
    track: Track,
    loved: Boolean,
    playing: Boolean,
    isPlaying: Boolean,
    actions: TrackActions,
    onClick: () -> Unit,
    subtitle: String = track.artist.ifBlank { "Unknown" },
    number: Int? = null,
    showDivider: Boolean = true,
    endPadding: Dp = 4.dp,
) {
    var menu by remember { mutableStateOf(false) }
    val titleColor = if (playing) OneUi.Primary else OneUi.Text1
    Box(Modifier.fillMaxWidth().height(if (number != null) 58.dp else OneUi.RowHeight).clickable(onClick = onClick)) {
        Row(Modifier.fillMaxSize().padding(start = OneUi.Gutter, end = endPadding), verticalAlignment = Alignment.CenterVertically) {
            if (number != null) {
                Box(Modifier.width(30.dp), contentAlignment = Alignment.CenterStart) {
                    if (playing) NowPlayingBars(isPlaying, OneUi.Primary, Modifier.size(14.dp))
                    else Text(if (number > 0) "$number" else "", style = OneUi.Number, color = OneUi.Text1)
                }
                Spacer(Modifier.width(12.dp))
            } else {
                Box {
                    Artwork(track.artworkUri, Modifier.size(OneUi.ThumbSize))
                    if (playing) Box(Modifier.size(OneUi.ThumbSize).clip(OneUi.Thumb).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                        NowPlayingBars(isPlaying, Color.White, Modifier.size(16.dp))
                    }
                }
                Spacer(Modifier.width(OneUi.ThumbGap))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(track.title, style = OneUi.Title, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (number == null && subtitle.isNotBlank()) Text(subtitle, style = OneUi.Sub, color = OneUi.TextSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (number != null) Text(formatDuration(track.durationMs), style = OneUi.Duration, color = OneUi.TextSub, modifier = Modifier.padding(horizontal = 8.dp))
            Box {
                Box(Modifier.size(width = 40.dp, height = 48.dp).clip(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.MoreVert, "More options", tint = OneUi.TextSub, modifier = Modifier.size(22.dp))
                }
                TrackMenu(menu, loved, onDismiss = { menu = false }, track = track, actions = actions)
            }
        }
        if (showDivider) {
            Box(
                Modifier.align(Alignment.BottomStart)
                    .padding(start = if (number != null) OneUi.Gutter + 42.dp else OneUi.DividerInset, end = OneUi.Gutter)
                    .fillMaxWidth().height(0.5.dp).background(OneUi.Divider),
            )
        }
    }
}

/** Samsung's song menu: a rounded grey popup of plain text items. */
@Composable
fun TrackMenu(expanded: Boolean, loved: Boolean, onDismiss: () -> Unit, track: Track, actions: TrackActions) {
    OneUiMenu(expanded, onDismiss) {
        OneUiMenuItem("Play next") { onDismiss(); actions.onPlayNext(track) }
        OneUiMenuItem("Add to queue") { onDismiss(); actions.onAddToQueue(track) }
        OneUiMenuItem(if (loved) "Remove from Favorites" else "Add to Favorites") { onDismiss(); actions.onToggleLove(track) }
        OneUiMenuItem("Album") { onDismiss(); actions.onGoToAlbum(track) }
        OneUiMenuItem("Artist") { onDismiss(); actions.onGoToArtist(track) }
    }
}

@Composable
fun OneUiMenu(expanded: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        shape = OneUi.Menu,
        containerColor = OneUi.Raised,
        tonalElevation = 0.dp,
        shadowElevation = 12.dp,
    ) { Column(Modifier.padding(vertical = 8.dp)) { content() } }
}

@Composable
fun OneUiMenuItem(label: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, style = OneUi.MenuItem) },
        onClick = onClick,
        colors = MenuDefaults.itemColors(textColor = OneUi.Text1),
        contentPadding = PaddingValues(horizontal = 28.dp),
        modifier = Modifier.height(52.dp),
    )
}

/**
 * The A–Z index down the right edge of Samsung Music's lists. Touch or drag
 * along it to jump to the first item filed under that letter.
 */
@Composable
fun IndexBar(letters: List<Char>, onLetter: (Char) -> Unit, modifier: Modifier = Modifier) {
    var active by remember { mutableStateOf<Char?>(null) }
    fun pick(y: Float, height: Int) {
        if (letters.isEmpty() || height <= 0) return
        val i = ((y / height) * letters.size).toInt().coerceIn(letters.indices)
        if (letters[i] != active) { active = letters[i]; onLetter(letters[i]) }
    }
    Column(
        modifier
            .width(20.dp)
            .fillMaxHeight()
            .padding(vertical = 8.dp)
            .clip(OneUi.Pill)
            .background(OneUi.Raised.copy(alpha = 0.55f))
            .pointerInput(letters) {
                detectTapGestures(onPress = { pick(it.y, size.height); tryAwaitRelease(); active = null })
            }
            .pointerInput(letters) {
                detectVerticalDragGestures(onDragEnd = { active = null }, onDragCancel = { active = null }) { change, _ -> pick(change.position.y, size.height) }
            },
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        letters.forEach { c ->
            Text("$c", style = OneUi.Index, color = if (c == active) OneUi.Primary else OneUi.TextSub, textAlign = TextAlign.Center)
        }
    }
}

/** The index letter a sort key files under; numbers and symbols file under A, as in Samsung Music. */
fun indexLetter(sortKey: String): Char {
    val c = sortKey.firstOrNull()?.uppercaseChar() ?: return 'A'
    return if (c in 'A'..'Z') c else 'A'
}

val IndexLetters: List<Char> = ('A'..'Z').toList()

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 40.dp, vertical = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = OneUi.Title, color = OneUi.Text1, textAlign = TextAlign.Center)
        if (body.isNotBlank()) Text(body, style = OneUi.Sub, color = OneUi.TextSub, textAlign = TextAlign.Center)
    }
}

/** "1 track", "2 tracks", "1,204 tracks". */
fun countOf(n: Int, noun: String) = "%,d %s".format(n, if (n == 1) noun else noun + "s")

fun formatDuration(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

fun formatLength(ms: Long): String {
    val minutes = ms / 60_000
    return if (minutes >= 60) "${minutes / 60} hr ${minutes % 60} min" else "$minutes min"
}
