package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import coil3.compose.SubcomposeAsyncImage
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.mix

// ---- primitives ----

/** Click with a slight press-in, Hive's quick 140 ms feel. */
@Composable
fun Modifier.pressable(onClick: () -> Unit, pressedScale: Float = 0.97f, onLongClick: (() -> Unit)? = null): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) pressedScale else 1f, spring(stiffness = 900f, dampingRatio = 0.7f), label = "press")
    return scale(scale).combinedClickable(interactionSource = source, indication = null, onClick = onClick, onLongClick = onLongClick)
}

/**
 * Album art the way Hive draws it: the panel colour underneath, the image
 * fading in over 260 ms, and an optional soft drop shadow
 * (`0 12px 28px -16px rgba(0,0,0,.62)`), or a glow in the accent.
 */
@Composable
fun Artwork(
    model: Any?,
    modifier: Modifier = Modifier,
    shape: Shape = HiveShape.thumb,
    fallback: ImageVector = Icons.Rounded.MusicNote,
    glow: Color? = null,
    elevation: Dp = 0.dp,
) {
    val c = Hive.colors
    val shadowed = if (elevation > 0.dp) modifier.shadow(elevation, shape, ambientColor = glow ?: Color.Black, spotColor = glow ?: Color.Black) else modifier
    Box(shadowed.clip(shape).background(mix(c.panelStrong.copy(alpha = 1f), c.bg, 0.6f)), contentAlignment = Alignment.Center) {
        SubcomposeAsyncImage(
            model = model,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            loading = { ArtPlaceholder(fallback) },
            error = { ArtPlaceholder(fallback) },
            success = { state ->
                val alpha by animateFloatAsState(1f, tween(260), label = "artIn")
                androidx.compose.foundation.Image(state.painter, null, Modifier.fillMaxSize().alpha(alpha), contentScale = ContentScale.Crop)
            },
        )
    }
}

@Composable
private fun ArtPlaceholder(icon: ImageVector) {
    val c = Hive.colors
    Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(mix(c.accent, c.panelStrong.copy(alpha = 1f), 0.10f), c.bg))), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = c.textDimmer, modifier = Modifier.fillMaxSize(0.38f))
    }
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
fun HiveTab(label: String, active: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null) {
    val c = Hive.colors
    val text by animateColorAsState(if (active) c.text else c.textDim, tween(150), label = "tabText")
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
            .clickable(onClick = onClick)
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
    val bg by animateColorAsState(if (active) mix(c.accent, Color.Transparent, 0.28f) else mix(c.accent, c.panelStrong, 0.05f), tween(150), label = "pillBg")
    val edge by animateColorAsState(if (active) mix(c.accent, c.border, 0.35f) else c.border, tween(150), label = "pillEdge")
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
            .shadow(size * 0.3f, CircleShape, ambientColor = c.accentGlow, spotColor = c.accent)
            .clip(CircleShape)
            .background(c.accent)
            .pressable(onClick, 0.9f),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.animation.Crossfade(playing, animationSpec = tween(160), label = "play") { p ->
            Icon(if (p) Icons.Rounded.Pause else Icons.Rounded.PlayArrow, if (p) "Pause" else "Play", tint = readableOn(c.accent), modifier = Modifier.size(size * 0.55f))
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
    Text(text.uppercase(), style = HiveText.label, color = color ?: Hive.colors.textDimmer, modifier = modifier)
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
    /** Set only where the song sits in a playlist the user can edit. */
    val onRemoveFromPlaylist: ((Track) -> Unit)? = null,
)

/** Songs picked for a group action; long-press a song to start, tap to add or remove while picking. */
class Selection {
    val tracks = androidx.compose.runtime.mutableStateListOf<Track>()
    val active: Boolean get() = tracks.isNotEmpty()
    operator fun contains(t: Track) = tracks.any { it.id == t.id }
    fun toggle(t: Track) { if (t in this) tracks.removeAll { it.id == t.id } else tracks += t }
    fun clear() = tracks.clear()
}

val LocalSelection = androidx.compose.runtime.staticCompositionLocalOf<Selection?> { null }

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
    trailing: String? = formatDuration(track.durationMs),
    showArt: Boolean = number == null,
) {
    val c = Hive.colors
    var menu by remember { mutableStateOf(false) }
    val selection = LocalSelection.current
    val picked = selection != null && track in selection
    val fill by animateColorAsState(when { picked -> c.accentSoft.copy(alpha = 0.38f); playing -> c.accentSoft.copy(alpha = 0.22f); else -> Color.Transparent }, tween(180), label = "rowFill")
    val titleColor by animateColorAsState(if (playing) c.accent else c.text, tween(180), label = "rowTitle")
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(if (showArt) 64.dp else 54.dp)
                .clip(HiveShape.row)
                .background(fill)
                .drawBehind { if (playing) drawRect(c.accent, size = Size(2.dp.toPx(), size.height)) }
                .combinedClickable(
                    onClick = { if (selection?.active == true) selection.toggle(track) else onClick() },
                    onLongClick = { if (selection != null) selection.toggle(track) else menu = true },
                )
                .padding(start = 10.dp, end = 0.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showArt) {
                Box {
                    Artwork(track.artworkUri, Modifier.size(44.dp))
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
                Text(track.title, style = HiveText.row, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (loved) Icon(Icons.Rounded.Favorite, "Loved", tint = c.accent, modifier = Modifier.padding(start = 8.dp).size(13.dp))
            if (trailing != null) Text(trailing, style = HiveText.numbers, color = c.textDimmer, modifier = Modifier.padding(start = 10.dp))
            Box {
                Box(Modifier.size(width = 40.dp, height = 48.dp).clip(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.MoreHoriz, "More options", tint = c.textDim, modifier = Modifier.size(20.dp))
                }
                TrackMenu(menu, loved, onDismiss = { menu = false }, track = track, actions = actions)
            }
        }
    }
}

@Composable
fun TrackMenu(expanded: Boolean, loved: Boolean, onDismiss: () -> Unit, track: Track, actions: TrackActions) {
    HiveMenu(expanded, onDismiss) {
        HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { onDismiss(); actions.onPlayNext(track) }
        HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { onDismiss(); actions.onAddToQueue(track) }
        HiveMenuItem("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { onDismiss(); actions.onAddToPlaylist(listOf(track)) }
        HiveMenuItem(if (loved) "Remove from Favorites" else "Add to Favorites", if (loved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder) { onDismiss(); actions.onToggleLove(track) }
        HiveMenuDivider()
        HiveMenuItem("Go to album", Icons.Rounded.Album) { onDismiss(); actions.onGoToAlbum(track) }
        HiveMenuItem("Go to artist", Icons.Rounded.Person) { onDismiss(); actions.onGoToArtist(track) }
        HiveMenuItem("Track info", Icons.Rounded.Info) { onDismiss(); actions.onInfo(track) }
        actions.onRemoveFromPlaylist?.let { remove ->
            HiveMenuDivider()
            HiveMenuItem("Remove from playlist", Icons.Rounded.RemoveCircleOutline, destructive = true) { onDismiss(); remove(track) }
        }
    }
}

/**
 * Hive's context menu: glass tinted 7% by the accent, a soft accent glow, and
 * the `inlineDropIn` entrance (fade, a 5 px rise, scale .985 → 1).
 */
@Composable
fun HiveMenu(expanded: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(false) }
    state.targetState = expanded
    if (!state.currentState && !state.targetState) return
    val c = Hive.colors
    Popup(alignment = Alignment.TopEnd, offset = IntOffset(0, 8), onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        AnimatedVisibility(
            state,
            enter = fadeIn(tween(140)) + slideInVertically(tween(160)) { -it / 40 } + scaleIn(tween(160), initialScale = 0.985f),
            exit = fadeOut(tween(110)) + scaleOut(tween(110), targetScale = 0.985f),
        ) {
            Column(
                Modifier
                    .widthIn(min = 232.dp)
                    .width(IntrinsicSize.Max)
                    .shadow(22.dp, HiveShape.menu, ambientColor = c.accentGlow, spotColor = Color.Black)
                    .clip(HiveShape.menu)
                    .background(mix(c.accent, c.panelStrong.copy(alpha = 0.97f), 0.07f))
                    .border(1.dp, c.border, HiveShape.menu)
                    .padding(6.dp),
            ) { content() }
        }
    }
}

@Composable
fun HiveMenuItem(label: String, icon: ImageVector?, destructive: Boolean = false, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().height(46.dp).clip(RoundedCorner10).clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = if (destructive) Color(0xFFFF7A7A) else c.textDim, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(12.dp)) }
        Text(label, style = HiveText.body, color = if (destructive) Color(0xFFFF7A7A) else c.text)
    }
}

private val RoundedCorner10 = androidx.compose.foundation.shape.RoundedCornerShape(10.dp)

@Composable
fun HiveMenuDivider() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).height(1.dp).background(Hive.colors.border))
}

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
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    val c = Hive.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 40.dp, vertical = 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = HiveText.cardTitle.copy(fontSize = HiveText.row.fontSize), color = c.text, textAlign = TextAlign.Center)
        if (body.isNotBlank()) Text(body, style = HiveText.rowSub, color = c.textDim, textAlign = TextAlign.Center)
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
