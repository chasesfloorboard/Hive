package com.local.hive.mobile.ui

import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Download
import com.local.hive.mobile.ui.theme.HiveIcons
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.togetherWith
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.foundation.gestures.scrollBy
import kotlinx.coroutines.launch
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import coil3.compose.AsyncImage
import coil3.request.crossfade
import com.local.hive.mobile.data.Track
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Search
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.focus.focusRequester
import com.local.hive.mobile.ui.theme.hiveGlass
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material.icons.rounded.CheckCircle
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.mix
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb

// ---- primitives ----

/** Click with a slight press-in, Hive's quick 140 ms feel. */
@Composable
fun Modifier.pressable(onClick: () -> Unit, pressedScale: Float = 0.97f, onLongClick: (() -> Unit)? = null): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) pressedScale else 1f, spring(stiffness = 900f, dampingRatio = 0.7f), label = "press")
    return scale(scale).combinedClickable(interactionSource = source, indication = null, onClick = onClick, onLongClick = onLongClick)
}

/** Three bars that move while a song plays. */
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

/**
 * Hive's `.tab`: a pill that is quiet until active, then filled with a
 * vertical accent-soft gradient, edged, and glowing in the accent
 * (`0 0 18px -6px accent-glow`).
 */
@Composable
fun HiveTab(label: String, active: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null, onLongClick: (() -> Unit)? = null) {
    val c = Hive.colors
    val text by com.local.hive.mobile.ui.theme.animateUiColorAsState(if (active) c.text else c.textDim, tween(150), label = "tabText")
    val fill by animateFloatAsState(if (active) 1f else 0f, tween(150), label = "tabFill")
    Row(
        modifier
            .height(38.dp)
            .drawBehind {
                if (fill > 0f) {
                    val r = CornerRadius(12.dp.toPx())
                    // glow
                    drawRoundRect(c.accentGlow.copy(alpha = c.accentGlow.alpha * fill), cornerRadius = r, topLeft = Offset(-2.dp.toPx(), 2.dp.toPx()), size = Size(size.width + 4.dp.toPx(), size.height))
                    drawRoundRect(Brush.verticalGradient(listOf(c.accentSoft.copy(alpha = c.accentSoft.alpha * fill), Color.Transparent)), cornerRadius = r)
                    drawRoundRect(c.border.copy(alpha = c.border.alpha * fill * 1.4f), cornerRadius = r, style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
                }
            }
            .clip(HiveShape.tab)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        leading?.invoke()
        Text(label, style = HiveText.tab, color = text, maxLines = 1)
    }
}

/** A row of small toggle pills (Hive's `.view-toggle`: Years · Albums · Tracks · Artists). */
@Composable
fun HiveToggle(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        options.forEachIndexed { i, label -> HivePill(label, i == selected) { onSelect(i) } }
    }
}

@Composable
fun HivePill(label: String, active: Boolean, onClick: () -> Unit) {
    val c = Hive.colors
    val bg by com.local.hive.mobile.ui.theme.animateUiColorAsState(if (active) mix(c.accent, Color.Transparent, 0.36f) else mix(c.accent, c.panelStrong, 0.05f), tween(150), label = "pillBg")
    val edge by com.local.hive.mobile.ui.theme.animateUiColorAsState(if (active) mix(c.accent, c.border, 0.6f) else c.border, tween(150), label = "pillEdge")
    Box(
        Modifier.height(32.dp).clip(HiveShape.pill).background(bg).border(1.dp, edge, HiveShape.pill).clickable(onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveText.pill, color = if (active) c.text else c.textDim) }
}

/** A round control (Hive's `--control-bg` buttons). */
@Composable
fun ControlButton(icon: ImageVector, label: String, onClick: () -> Unit, size: Dp = 40.dp, tint: Color? = null) {
    val c = Hive.colors
    Box(Modifier.size(size).clip(CircleShape).background(mix(c.accent, c.panelStrong, 0.05f)).border(1.dp, mix(c.accent, c.border, 0.14f), CircleShape).pressable(onClick, 0.9f), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint ?: c.text, modifier = Modifier.size(size * 0.5f))
    }
}

/** Hive's `#btn-play`: an accent circle with a soft accent glow beneath. */
@Composable
fun AccentPlayButton(playing: Boolean, onClick: () -> Unit, size: Dp = 44.dp) {
    val c = Hive.colors
    Box(
        Modifier
            .size(size)
            // The whole button gives under the finger; the circle and its glow are painted, not a
            // shadowed layer, which dropped the circle for a few frames as play and pause traded places.
            .pressable(onClick, 0.9f)
            .softShadow(size * 0.3f, CircleShape, c.accent)
            .drawBehind { drawCircle(c.accent) },
        contentAlignment = Alignment.Center,
    ) {
        // Play and pause trade places with a small scale, not a flat fade.
        androidx.compose.animation.AnimatedContent(
            playing,
            transitionSpec = {
                (scaleIn(spring(dampingRatio = 0.6f, stiffness = 700f), initialScale = 0.55f) + fadeIn(tween(120)))
                    .togetherWith(scaleOut(tween(110), targetScale = 0.55f) + fadeOut(tween(90)))
            },
            label = "play",
        ) { p ->
            Icon(if (p) HiveIcons.Pause else HiveIcons.Play, if (p) "Pause" else "Play", tint = readableOn(c.accent), modifier = Modifier.size(size * 0.55f))
        }
    }
}

/** Dark text on light accents, light on dark ones. */
fun readableOn(accent: Color): Color {
    val l = 0.2126f * accent.red + 0.7152f * accent.green + 0.0722f * accent.blue
    return if (l > 0.55f) Color(0xFF0A0A0D) else Color(0xFFF5F3FA)
}

@Composable
fun BarIcon(icon: ImageVector, label: String, onClick: () -> Unit, tint: Color? = null) {
    Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = tint ?: Hive.colors.text, modifier = Modifier.size(22.dp))
    }
}

/** Hive's album year heading: the year, then a hairline rule to the edge. */
@Composable
fun YearHeading(text: String, modifier: Modifier = Modifier) {
    val c = Hive.colors
    Row(modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 18.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = HiveText.year, color = c.text)
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f).height(1.dp).background(c.border))
    }
}

/** Small uppercase label, Hive's column-header voice. */
@Composable
fun HiveLabel(text: String, modifier: Modifier = Modifier, color: Color? = null) {
    // Small capitals need the dim colour, not the dimmer one, to stay readable (4.5:1) on Hive's dark panels.
    Text(text.uppercase(), style = HiveText.label, color = color ?: Hive.colors.textDim, modifier = modifier)
}

// ---- tracks ----

data class TrackActions(
    val onPlayNext: (Track) -> Unit,
    val onAddToQueue: (Track) -> Unit,
    val onToggleLove: (Track) -> Unit,
    val onGoToAlbum: (Track) -> Unit,
    val onGoToArtist: (Track) -> Unit,
    val onInfo: (Track) -> Unit = {},
    val onAddToPlaylist: (List<Track>) -> Unit = {},
    val onDelete: (List<Track>) -> Unit = {},
    /** Set only where the song sits in a playlist the user can edit. */
    val onRemoveFromPlaylist: ((Track) -> Unit)? = null,
    /** Auto DJ: a mix grown from these songs. */
    val onAutoDj: (List<Track>) -> Unit = {},
)


/**
 * A song in Hive's style: rounded row, 44dp art (or the track number in an
 * album), title over artist · album, length in tabular figures. The playing
 * row takes the accent: accent title, moving bars, and a soft accent fill
 * with a 2dp accent bar at its leading edge (Hive's selected-row treatment).
 * ⋯ opens the glass menu; long-press starts picking songs (see [Selection]).
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
    val selection = LocalSelection.current
    SongRow(
        track.songArtUri, track.title, subtitle, playing, isPlaying, onClick, number = number, loved = loved,
        trailing = if (number != null) formatDuration(track.durationMs) else null,
        picked = selection != null && track in selection, picking = selection?.active == true,
        onPick = selection?.let { s -> { s.toggle(track) } },
        onHold = selection?.let { s -> { s.startTrackDrag(track) } },
    ) { expanded, dismiss -> TrackMenu(expanded, loved, onDismiss = dismiss, track = track, actions = actions) }
}

/**
 * The one song row, for the library, Hive's PC library and streamed songs
 * alike: rounded row, 44dp art (or the track number in an album, with its
 * length), title over [subtitle], a heart when loved. The playing row takes
 * the accent: accent title, moving bars, and a soft accent fill with a 2dp
 * accent bar at its leading edge. While picking ([picking]), a tap picks;
 * holding picks ([onPick]) or, for songs that can't be picked, opens [menu].
 * [badge] sits before the subtitle (a streamed song's "Preview").
 */
@Composable
fun SongRow(
    art: Any?,
    title: String,
    subtitle: String,
    playing: Boolean,
    isPlaying: Boolean,
    onClick: () -> Unit,
    number: Int? = null,
    loved: Boolean = false,
    picked: Boolean = false,
    picking: Boolean = false,
    onPick: (() -> Unit)? = null,
    /** Holding the row: picks it and starts a hold-and-drag over the songs below or above (see [songDragSelect]). */
    onHold: (() -> Unit)? = null,
    enabled: Boolean = true,
    // Lengths show where the order matters (an album's tracklist), as in Samsung Music.
    trailing: String? = null,
    badge: (@Composable () -> Unit)? = null,
    menu: (@Composable (expanded: Boolean, dismiss: () -> Unit) -> Unit)? = null,
) {
    val c = Hive.colors
    var open by remember { mutableStateOf(false) }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val showArt = number == null
    val fill by com.local.hive.mobile.ui.theme.animateUiColorAsState(when { picked -> c.accentSoft.copy(alpha = 0.38f); playing -> c.accentSoft.copy(alpha = 0.22f); else -> Color.Transparent }, tween(180), label = "rowFill")
    val titleColor by com.local.hive.mobile.ui.theme.animateUiColorAsState(when { playing -> c.accent; enabled -> c.text; else -> c.textDim }, tween(180), label = "rowTitle")
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(if (showArt) 64.dp else 54.dp)
                .clip(HiveShape.row)
                .background(fill)
                .drawBehind { if (playing) drawRect(c.accent, size = Size(2.dp.toPx(), size.height)) }
                .combinedClickable(
                    onClick = { if (picking && onPick != null) onPick() else if (enabled) onClick() },
                    onLongClick = {
                        haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress)
                        when { onHold != null -> onHold(); onPick != null -> onPick(); menu != null -> open = true }
                    },
                )
                .padding(start = 10.dp, end = 0.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showArt) {
                Box {
                    Artwork(art, Modifier.size(44.dp))
                    if (picked) Box(Modifier.size(44.dp).clip(HiveShape.thumb).background(c.accent.copy(alpha = 0.85f)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.Check, "Picked", tint = readableOn(c.accent), modifier = Modifier.size(22.dp))
                    } else if (playing) Box(Modifier.size(44.dp).clip(HiveShape.thumb).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                        NowPlayingBars(isPlaying, Color.White, Modifier.size(15.dp))
                    }
                }
                Spacer(Modifier.width(12.dp))
            } else {
                Box(Modifier.width(28.dp), contentAlignment = Alignment.CenterStart) {
                    if (picked) Icon(Icons.Rounded.Check, "Picked", tint = c.accent, modifier = Modifier.size(18.dp))
                    else if (playing) NowPlayingBars(isPlaying, c.accent, Modifier.size(13.dp))
                    else Text(number?.takeIf { it > 0 }?.toString() ?: "", style = HiveText.numbers, color = c.textDimmer)
                }
                Spacer(Modifier.width(8.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = HiveText.row, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (subtitle.isNotBlank() || badge != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    badge?.invoke()
                    if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (loved) Icon(Icons.Rounded.Favorite, "Loved", tint = c.accent, modifier = Modifier.padding(start = 8.dp).size(13.dp))
            trailing?.let { Text(it, style = HiveText.numbers, color = c.textDimmer, modifier = Modifier.padding(start = 10.dp)) }
            if (menu != null) Box {
                Box(Modifier.size(width = 44.dp, height = 48.dp).clip(CircleShape).clickable { open = true }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.MoreVert, "More options", tint = c.textDim, modifier = Modifier.size(20.dp))
                }
                menu(open) { open = false }
            } else Spacer(Modifier.width(12.dp))
        }
    }
}

/**
 * Hive's `.album-card` for every album and playlist: rounded art with a deep
 * soft shadow, bold title, dim [subtitle]. Picked, it takes an inset 2dp
 * accent ring and a check.
 */
@Composable
fun CoverCard(
    art: Any?,
    title: String,
    subtitle: String,
    modifier: Modifier,
    fallback: ImageVector = Icons.Rounded.LibraryMusic,
    artModifier: Modifier = Modifier,
    picked: Boolean = false,
    /** A "perfect" album (every track loved): shows the loved-album badge in the corner. */
    perfect: Boolean = false,
    /** Reserve this many title lines so every card in a row is the same height — the Browse "Explore" heading
     *  below the popular row must not shift up/down when one card's title wraps to two lines. */
    minTitleLines: Int = 1,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val c = Hive.colors
    Column(modifier.pressable(onClick = onClick, onLongClick = onLongClick)) {
        Box {
            Artwork(art, artModifier.fillMaxWidth().aspectRatio(1f), HiveShape.art, fallback, elevation = 14.dp)
            if (perfect && !picked) PerfectBadge(Modifier.align(Alignment.TopEnd).padding(8.dp))
            if (picked) {
                Box(Modifier.matchParentSize().clip(HiveShape.art).background(c.accentSoft.copy(alpha = 0.32f)))
                Box(Modifier.matchParentSize().padding(1.dp).border(2.dp, c.accent, HiveShape.art))
                Box(Modifier.align(Alignment.TopEnd).padding(8.dp).size(24.dp).clip(CircleShape).background(c.accent), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Check, "Picked", tint = readableOn(c.accent), modifier = Modifier.size(16.dp))
                }
            }
        }
        Text(title, style = HiveText.cardTitle, color = c.text, maxLines = 2, minLines = minTitleLines, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * The "Perfect" album badge: a glass chip in Hive's theme with an accent heart, shown on an album whose
 * every track is loved (a 10/10). A frosted square that sits in a cover's corner.
 */
@Composable
fun PerfectBadge(modifier: Modifier = Modifier) {
    val c = Hive.colors
    Box(modifier.size(28.dp).hiveGlass(RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
        Icon(Icons.Rounded.Favorite, "Every track loved", tint = c.accent, modifier = Modifier.size(15.dp))
    }
}

/** One row of a two-across cover grid, spaced as the Albums page is. */
@Composable
fun <T> CoverRow(row: List<T>, card: @Composable (item: T, modifier: Modifier) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        row.forEach { card(it, Modifier.weight(1f)) }
        if (row.size == 1) Spacer(Modifier.weight(1f))
    }
}

/** A song Hive's old YouTube downloads saved (Music/Hive/<Artist - Title>.m4a), which a Soulseek copy can replace. */
val Track.isYouTubeDownload: Boolean get() = folder.trim('/').equals("Music/Hive", ignoreCase = true) && fileName.endsWith(".m4a", ignoreCase = true)

// isLossySoulseekDownload / replaceableFromSoulseek / replaceFromSoulseek moved to the StreamingSeam
// (mobile) / its Clean no-op, so Soulseek is absent from the Play build.

/** A small cover card for a service's playlist/album in the Browse tab (shared by both editions). */
data class ServiceCard(val name: String, val subtitle: String, val artwork: String, val url: String)

/** A–Z index for long lists: touch or drag along it to jump. */
@Composable
fun IndexBar(letters: List<Char>, onLetter: (Char) -> Unit, modifier: Modifier = Modifier) {
    val c = Hive.colors
    var active by remember { mutableStateOf<Char?>(null) }
    fun pick(y: Float, height: Int) {
        if (letters.isEmpty() || height <= 0) return
        val i = ((y / height) * letters.size).toInt().coerceIn(letters.indices)
        if (letters[i] != active) { active = letters[i]; onLetter(letters[i]) }
    }
    Column(
        modifier
            .width(18.dp)
            .fillMaxHeight()
            .padding(vertical = 10.dp)
            .pointerInput(letters) { detectTapGestures(onPress = { pick(it.y, size.height); tryAwaitRelease(); active = null }) }
            .pointerInput(letters) { detectVerticalDragGestures(onDragEnd = { active = null }, onDragCancel = { active = null }) { ch, _ -> pick(ch.position.y, size.height) } },
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        letters.forEach { ch -> Text("$ch", style = HiveText.label.copy(letterSpacing = androidx.compose.ui.unit.TextUnit.Unspecified), color = if (ch == active) c.accent else c.textDimmer, textAlign = TextAlign.Center) }
    }
}

/** The index letter a sort key files under; numbers and symbols go under A. */
fun indexLetter(sortKey: String): Char {
    val ch = sortKey.firstOrNull()?.uppercaseChar() ?: return 'A'
    return if (ch in 'A'..'Z') ch else 'A'
}

val IndexLetters: List<Char> = ('A'..'Z').toList()

@Composable
fun EmptyState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    action: Pair<String, () -> Unit>? = null,
) {
    val c = Hive.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 40.dp, vertical = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (icon != null) androidx.compose.material3.Icon(icon, null, tint = c.textDim, modifier = Modifier.size(44.dp))
        Text(title, style = HiveText.cardTitle.copy(fontSize = HiveText.row.fontSize), color = c.text, textAlign = TextAlign.Center)
        if (body.isNotBlank()) Text(body, style = HiveText.rowSub, color = c.textDim, textAlign = TextAlign.Center)
        if (action != null) HiveButton(action.first, primary = true) { action.second() }
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

/**
 * [compute] off the main thread whenever [keys] change: library-sized sorts
 * and indexes. Until the new result is ready the previous one stays on
 * screen ([initial] only before the first).
 */
@Composable
fun <T> rememberComputed(initial: T, vararg keys: Any?, compute: () -> T): androidx.compose.runtime.State<T> =
    androidx.compose.runtime.produceState(initial, *keys) {
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { compute() }
    }

/**
 * Hive's mark as the app icon draws it (a hexagon with the H cut from it),
 * in the theme's colours: the hexagon in the accent, the H readable on it.
 */
@Composable
fun HiveMark(modifier: Modifier = Modifier) {
    val c = Hive.colors
    // The accent as picked (a bright neon stays neon), not the darker one text uses on light themes.
    val hex = c.logo
    val letter = readableOn(hex)
    androidx.compose.foundation.Canvas(modifier) {
        // The icon's paths are drawn about the origin in a ±700 box.
        val k = size.minDimension / 1400f
        fun path(vararg points: Float) = androidx.compose.ui.graphics.Path().apply {
            moveTo(size.width / 2 + points[0] * k, size.height / 2 + points[1] * k)
            var i = 2
            while (i < points.size) { lineTo(size.width / 2 + points[i] * k, size.height / 2 + points[i + 1] * k); i += 2 }
            close()
        }
        val hexagon = path(0f, -640f, 554.3f, -320f, 554.3f, 320f, 0f, 640f, -554.3f, 320f, -554.3f, -320f)
        drawPath(hexagon, hex)
        drawPath(hexagon, hex, style = androidx.compose.ui.graphics.drawscope.Stroke(70f * k, join = androidx.compose.ui.graphics.StrokeJoin.Round))
        val h = path(-170f, -420f, -170f, -98f, 0f, -190f, 170f, -98f, 170f, -420f, 449f, -259f, 449f, 259f, 170f, 420f, 170f, 98f, 0f, 190f, -170f, 98f, -170f, 420f, -449f, 259f, -449f, -259f)
        drawPath(h, letter)
        drawPath(h, letter, style = androidx.compose.ui.graphics.drawscope.Stroke(40f * k, join = androidx.compose.ui.graphics.StrokeJoin.Round))
    }
}

// ---- One dialog, field, button and toast for the whole app ----

/** Hive's dialog: glass panel with a soft accent glow. [wide] uses the screen's width (less a margin). */
@Composable
fun HiveDialog(
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    padding: androidx.compose.foundation.layout.PaddingValues = androidx.compose.foundation.layout.PaddingValues(20.dp),
    spacing: Dp = 12.dp,
    wide: Boolean = false,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    val c = Hive.colors
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = !wide)) {
        Column(
            (if (wide) Modifier.padding(16.dp) else Modifier).fillMaxWidth().then(modifier).shadow(30.dp, HiveShape.panel, ambientColor = c.accentGlow).clip(HiveShape.panel)
                .background(c.control).border(1.dp, com.local.hive.mobile.ui.theme.hiveGlassBorder(), HiveShape.panel).padding(padding),
            verticalArrangement = Arrangement.spacedBy(spacing),
            content = content,
        )
    }
}

/** Hive's text field: its label above what's typed. */
@Composable
fun HiveField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier.fillMaxWidth(),
    type: androidx.compose.ui.text.input.KeyboardType = androidx.compose.ui.text.input.KeyboardType.Text,
    capitalization: androidx.compose.ui.text.input.KeyboardCapitalization = androidx.compose.ui.text.input.KeyboardCapitalization.None,
    focus: androidx.compose.ui.focus.FocusRequester? = null,
    onDone: (() -> Unit)? = null,
) {
    val c = Hive.colors
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(mix(c.accent, c.panelStrong, 0.05f)).border(1.dp, c.border, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 9.dp)) {
        HiveLabel(label)
        androidx.compose.foundation.text.BasicTextField(
            value, onChange, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = androidx.compose.ui.graphics.SolidColor(c.accent),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = type, capitalization = capitalization,
                imeAction = if (onDone != null) androidx.compose.ui.text.input.ImeAction.Done else androidx.compose.ui.text.input.ImeAction.Default),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { onDone?.invoke() }),
            visualTransformation = if (type == androidx.compose.ui.text.input.KeyboardType.Password) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp).then(if (focus != null) Modifier.focusRequester(focus) else Modifier),
        )
    }
}

/** Hive's small button (`.sidebar-add`): the accent for the main action, tinted glass for the rest. */
@Composable
fun HiveButton(label: String, primary: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Hive.colors
    Box(
        Modifier.minimumInteractiveComponentSize().height(36.dp).clip(RoundedCornerShape(10.dp))
            .alpha(if (enabled) 1f else 0.45f)
            .background(if (primary) c.accent else mix(c.accent, c.panelStrong, 0.05f))
            .border(1.dp, mix(c.accent, c.border, 0.14f), RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, style = HiveText.pill, color = if (primary) readableOn(c.accent) else c.text) }
}

/** Shows a brief Hive note above the playbar (HiveRoot's toast); a no-op outside it. */
val LocalToast = androidx.compose.runtime.staticCompositionLocalOf<(String) -> Unit> { {} }

/** Hive's search pill. */
@Composable
fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String, onSubmit: () -> Unit, onClear: () -> Unit, modifier: Modifier = Modifier.padding(horizontal = 14.dp), focus: androidx.compose.ui.focus.FocusRequester? = null) {
    val c = Hive.colors
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    Row(modifier.fillMaxWidth().height(48.dp).hiveGlass(HiveShape.pill).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Search, null, tint = c.textDim, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, style = HiveText.row, color = c.textDimmer, maxLines = 1, overflow = TextOverflow.Ellipsis)
            androidx.compose.foundation.text.BasicTextField(value, onChange, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = androidx.compose.ui.graphics.SolidColor(c.accent),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search), keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { keyboard?.hide(); onSubmit() }), modifier = Modifier.fillMaxWidth().then(if (focus != null) Modifier.focusRequester(focus) else Modifier))
        }
        if (value.isNotEmpty()) Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onClear), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Close, "Clear search", tint = c.textDim, modifier = Modifier.size(18.dp))
        }
    }
}

/** Loading, with what's happening ("Searching Spotify…"). */
@Composable
fun Busy(label: String) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.accent)
        Spacer(Modifier.width(12.dp))
        Text(label, style = HiveText.small, color = c.textDim)
    }
}

/**
 * A search bar kept out of sight until wanted: pull the list down past its
 * top and [shown] turns on; scrolling back into the list with nothing typed
 * ([keepShown] false) puts it away. Give [connection] to the list's parent
 * (Modifier.nestedScroll) and show the bar while [shown].
 */
class PullToReveal(private val revealPx: Float, private val keepShown: () -> Boolean) {
    var shown by mutableStateOf(keepShown())
        private set
    private var pulled = 0f
    val connection = object : androidx.compose.ui.input.nestedscroll.NestedScrollConnection {
        override fun onPreScroll(available: androidx.compose.ui.geometry.Offset, source: androidx.compose.ui.input.nestedscroll.NestedScrollSource): androidx.compose.ui.geometry.Offset {
            if (available.y < -4f && shown && !keepShown()) shown = false
            return androidx.compose.ui.geometry.Offset.Zero
        }
        override fun onPostScroll(consumed: androidx.compose.ui.geometry.Offset, available: androidx.compose.ui.geometry.Offset, source: androidx.compose.ui.input.nestedscroll.NestedScrollSource): androidx.compose.ui.geometry.Offset {
            // Pulling down with the list already at its top: what the list couldn't use.
            if (available.y > 0f && source == androidx.compose.ui.input.nestedscroll.NestedScrollSource.UserInput) { pulled += available.y; if (pulled > revealPx) shown = true }
            else pulled = 0f
            return androidx.compose.ui.geometry.Offset.Zero
        }
    }
}

@Composable
fun rememberPullToReveal(keepShown: Boolean): PullToReveal {
    val keep by androidx.compose.runtime.rememberUpdatedState(keepShown)
    val px = with(androidx.compose.ui.platform.LocalDensity.current) { 56.dp.toPx() }
    return remember { PullToReveal(px) { keep } }
}


/**
 * A choice that stays chosen (a sort, a view): kept in the phone's settings,
 * so leaving the page or closing Hive doesn't put it back to the default.
 */
@Composable
fun <T : Enum<T>> rememberSetting(key: String, default: T): androidx.compose.runtime.MutableState<T> {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE) }
    val state = remember(key) {
        val saved = prefs.getString(key, null)?.let { name -> default.javaClass.enumConstants?.firstOrNull { it.name == name } }
        mutableStateOf(saved ?: default)
    }
    androidx.compose.runtime.LaunchedEffect(state.value) { prefs.edit().putString(key, state.value.name).apply() }
    return state
}

/** A number that stays chosen (a menu's pick), as [rememberSetting]. */
@Composable
fun rememberIntSetting(key: String, default: Int): androidx.compose.runtime.MutableState<Int> {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE) }
    val state = remember(key) { mutableStateOf(prefs.getInt(key, default)) }
    androidx.compose.runtime.LaunchedEffect(state.value) { prefs.edit().putInt(key, state.value).apply() }
    return state
}

/** A yes/no choice that stays chosen, as [rememberSetting]. */
@Composable
fun rememberSetting(key: String, default: Boolean): androidx.compose.runtime.MutableState<Boolean> {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE) }
    val state = remember(key) { mutableStateOf(prefs.getBoolean(key, default)) }
    androidx.compose.runtime.LaunchedEffect(state.value) { prefs.edit().putBoolean(key, state.value).apply() }
    return state
}

/** A numbered choice (a tab of a page) that stays chosen, as [rememberSetting]. */
@Composable
fun rememberSetting(key: String, default: Int): androidx.compose.runtime.MutableState<Int> {
    val context = androidx.compose.ui.platform.LocalContext.current
    val prefs = remember { context.getSharedPreferences("ui", android.content.Context.MODE_PRIVATE) }
    val state = remember(key) { mutableStateOf(prefs.getInt(key, default)) }
    androidx.compose.runtime.LaunchedEffect(state.value) { prefs.edit().putInt(key, state.value).apply() }
    return state
}

/** An artist's photo when Settings › Appearance › Artist pictures is on Photos; null shows their album cover. */
@Composable
fun rememberArtistPhoto(vm: MainViewModel, name: String): String? {
    val online by vm.artistPhotos.collectAsStateWithLifecycle()
    return androidx.compose.runtime.produceState<String?>(null, name, online) { value = if (online) vm.artistImage(name) else null }.value
}

/**
 * A theme as a little window: its background, a panel, its accent and a line of dim text. Settings'
 * theme tiles and the theme gallery draw the same picture; at any size it keeps the 96 x 70 tile's
 * proportions (the parts scale with the width).
 */
@Composable
fun ThemePreview(t: com.local.hive.mobile.ui.theme.HiveColors, modifier: Modifier, selected: Boolean = false, extra: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit = {}) {
    val c = Hive.colors
    androidx.compose.foundation.layout.BoxWithConstraints(modifier) {
        val k = maxWidth / 96.dp
        val shape = RoundedCornerShape(14.dp * k)
        Box(
            Modifier.fillMaxSize().clip(shape).background(t.bg)
                .border(if (selected) 2.dp else 1.dp, if (selected) c.accent else c.border, shape).padding(10.dp * k),
        ) {
            Box(Modifier.fillMaxWidth().height(22.dp * k).clip(RoundedCornerShape(6.dp * k)).background(t.panelStrong.copy(alpha = 1f)).border(1.dp, t.border, RoundedCornerShape(6.dp * k)))
            Box(Modifier.align(Alignment.BottomStart).size(22.dp * k).clip(CircleShape).background(t.accent))
            Box(Modifier.align(Alignment.BottomEnd).width(36.dp * k).height(6.dp * k).clip(RoundedCornerShape(3.dp * k)).background(t.textDim))
            extra()
        }
    }
}
