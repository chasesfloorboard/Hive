package com.local.hive.mobile.ui

import androidx.compose.animation.animateColorAsState
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
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Person
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.GlassWeight
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveType
import com.local.hive.mobile.ui.theme.Radius
import com.local.hive.mobile.ui.theme.Space
import com.local.hive.mobile.ui.theme.glass
import com.local.hive.mobile.ui.theme.glassEdge

// ---- primitives ----

/** Click with a gentle press-in, instead of a ripple flooding the row. */
@Composable
fun Modifier.pressable(onClick: () -> Unit, pressedScale: Float = 0.97f): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) pressedScale else 1f, spring(stiffness = 900f, dampingRatio = 0.7f), label = "press")
    return scale(scale).clickable(interactionSource = source, indication = null, onClick = onClick)
}

/**
 * Album art. With [glow], it casts a soft shadow in its own colour, the way
 * a lit cover would on glass.
 */
@Composable
fun Artwork(
    model: Any?,
    modifier: Modifier = Modifier,
    shape: Shape = Radius.art,
    fallback: ImageVector = Icons.Rounded.MusicNote,
    glow: Color? = null,
    elevation: Dp = 0.dp,
) {
    val colors = Hive.colors
    val shadowed = if (elevation > 0.dp) modifier.shadow(elevation, shape, ambientColor = glow ?: Color.Black, spotColor = glow ?: Color.Black) else modifier
    Box(shadowed.clip(shape).background(colors.panelStrong.copy(alpha = 1f)), contentAlignment = Alignment.Center) {
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
    val colors = Hive.colors
    Box(
        Modifier.fillMaxSize().background(
            androidx.compose.ui.graphics.Brush.linearGradient(listOf(colors.accentSoft.copy(alpha = 0.18f), colors.panelStrong.copy(alpha = 1f))),
        ),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = colors.textDimmer, modifier = Modifier.fillMaxSize(0.36f)) }
}

/** Three bars that dance while a song plays and rest when it is paused. */
@Composable
fun NowPlayingBars(playing: Boolean, color: Color, modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "bars")
    val heights = listOf(0, 1, 2).map { i ->
        transition.animateFloat(
            initialValue = 0.25f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(420 + i * 130), RepeatMode.Reverse), label = "bar$i",
        )
    }
    Canvas(modifier) {
        val gap = size.width * 0.18f
        val barW = (size.width - gap * 2) / 3
        heights.forEachIndexed { i, h ->
            val frac = if (playing) h.value else 0.3f
            val barH = size.height * frac
            drawRoundRect(color, Offset(i * (barW + gap), size.height - barH), Size(barW, barH), CornerRadius(barW / 2))
        }
    }
}

/** Small spaced capitals that introduce a section, as on Hive's desktop. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    val colors = Hive.colors
    Row(modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.xs), verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), style = HiveType.label, color = colors.textDimmer, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/** A round glass button for secondary actions. */
@Composable
fun GlassIconButton(icon: ImageVector, label: String, onClick: () -> Unit, size: Dp = 44.dp, tint: Color? = null) {
    Box(Modifier.size(size).glass(CircleShape, GlassWeight.Regular).pressable(onClick, 0.9f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint ?: Hive.colors.text, modifier = Modifier.size(size * 0.46f))
    }
}

/** The primary action: a solid light pill, the one bright shape on screen. */
@Composable
fun PrimaryPill(text: String, icon: ImageVector?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = Hive.colors
    Row(
        modifier.height(44.dp).clip(Radius.pill).background(colors.text).pressable(onClick, 0.95f).padding(start = if (icon != null) 16.dp else 22.dp, end = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = colors.bg, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(6.dp)) }
        Text(text, style = HiveType.tab.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = colors.bg)
    }
}

/** A quieter companion to [PrimaryPill]. */
@Composable
fun GlassPill(text: String, icon: ImageVector?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = Hive.colors
    Row(
        modifier.height(44.dp).glass(Radius.pill, GlassWeight.Regular).pressable(onClick, 0.95f).padding(start = if (icon != null) 16.dp else 22.dp, end = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = colors.text, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(6.dp)) }
        Text(text, style = HiveType.tab, color = colors.text)
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
 * One song: art (or its number on an album page), title over artist · album,
 * a small heart when Loved, and a quiet "…" for everything else. The playing
 * song takes the accent and shows dancing bars over its art.
 */
@Composable
fun TrackRow(
    track: Track,
    loved: Boolean,
    playing: Boolean,
    isPlaying: Boolean,
    actions: TrackActions,
    onClick: () -> Unit,
    subtitle: String = listOf(track.artist, track.album).filter { it.isNotBlank() }.joinToString(" · "),
    number: Int? = null,
) {
    val colors = Hive.colors
    var menu by remember { mutableStateOf(false) }
    val titleColor by animateColorAsState(if (playing) colors.accent else colors.text, tween(400), label = "title")
    Row(
        Modifier
            .fillMaxWidth()
            .pressable(onClick, 0.985f)
            .padding(start = Space.gutter, end = Space.xs)
            .height(62.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(46.dp), contentAlignment = Alignment.Center) {
            if (number != null) {
                if (playing) NowPlayingBars(isPlaying, colors.accent, Modifier.size(16.dp))
                else Text(if (number > 0) "$number" else "·", style = HiveType.numbers.copy(fontSize = HiveType.secondary.fontSize), color = colors.textDimmer, textAlign = TextAlign.Center)
            } else {
                Artwork(track.artworkUri, Modifier.size(46.dp))
                if (playing) {
                    Box(Modifier.size(46.dp).clip(Radius.art).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                        NowPlayingBars(isPlaying, Color.White, Modifier.size(16.dp))
                    }
                }
            }
        }
        Spacer(Modifier.width(Space.md))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(track.title, style = HiveType.body, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = HiveType.secondary, color = colors.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (loved) Icon(Icons.Rounded.Favorite, "Loved", tint = colors.accent.copy(alpha = 0.9f), modifier = Modifier.padding(start = Space.xs).size(14.dp))
        Box {
            Box(Modifier.size(44.dp).clip(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.MoreHoriz, "More options", tint = colors.textDimmer, modifier = Modifier.size(20.dp))
            }
            HiveMenu(menu, onDismiss = { menu = false }) {
                HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistAdd) { menu = false; actions.onPlayNext(track) }
                HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; actions.onAddToQueue(track) }
                HiveMenuItem(if (loved) "Remove from Favorites" else "Add to Favorites", if (loved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder) {
                    menu = false; actions.onToggleLove(track)
                }
                HiveMenuItem("Go to album", Icons.Rounded.Album) { menu = false; actions.onGoToAlbum(track) }
                HiveMenuItem("Go to artist", Icons.Rounded.Person) { menu = false; actions.onGoToArtist(track) }
            }
        }
    }
}

/** A menu in Hive's glass: dark panel, soft corners, hairline rim. */
@Composable
fun HiveMenu(expanded: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val colors = Hive.colors
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        shape = Radius.card,
        containerColor = colors.panelStrong.copy(alpha = 0.97f),
        tonalElevation = 0.dp,
        shadowElevation = 18.dp,
        modifier = Modifier.glassEdge(Radius.card),
    ) { content() }
}

@Composable
fun HiveMenuItem(label: String, icon: ImageVector, onClick: () -> Unit) {
    val colors = Hive.colors
    DropdownMenuItem(
        text = { Text(label, style = HiveType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Normal)) },
        leadingIcon = { Icon(icon, null, modifier = Modifier.size(20.dp)) },
        onClick = onClick,
        colors = MenuDefaults.itemColors(textColor = colors.text, leadingIconColor = colors.textDim),
        contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.xxs),
    )
}

/** Count on the left, Shuffle and Play on the right: the start of every song list. */
@Composable
fun PlayBar(count: Int, noun: String, onShuffle: () -> Unit, onPlay: () -> Unit) {
    val colors = Hive.colors
    Row(
        Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, top = Space.xs, bottom = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(countOf(count, noun).uppercase(), style = HiveType.label, color = colors.textDimmer, modifier = Modifier.weight(1f))
        GlassIconButton(Icons.Rounded.Shuffle, "Shuffle play", onShuffle, size = 40.dp)
        Spacer(Modifier.width(Space.xs))
        Box(Modifier.size(40.dp).clip(CircleShape).background(colors.text).pressable(onPlay, 0.9f), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.PlayArrow, "Play all", tint = colors.bg, modifier = Modifier.size(24.dp))
        }
    }
}

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    val colors = Hive.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 40.dp, vertical = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Text(title, style = HiveType.headline, color = colors.text, textAlign = TextAlign.Center)
        if (body.isNotBlank()) Text(body, style = HiveType.secondary, color = colors.textDim, textAlign = TextAlign.Center)
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(horizontal = Space.gutter).height(0.5.dp).background(Hive.colors.border))
}

/** "1 song", "2 songs", "1,204 songs". */
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
