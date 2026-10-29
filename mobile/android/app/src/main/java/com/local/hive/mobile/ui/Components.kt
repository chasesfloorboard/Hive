package com.local.hive.mobile.ui

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
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.MoreVert
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
    /** The picture this one replaces (a cover carousel's last frame): it stays up and fades into this one. */
    replacing: Any? = null,
    /** Shown instead when [model] has no picture (a mosaic's tile takes another of its covers). */
    orElse: Any? = null,
) {
    val generation = CoverGeneration.intValue
    var failed by remember(model, generation) { mutableStateOf(false) }
    if (failed && orElse != null) return Artwork(orElse, modifier, shape, fallback, glow, elevation)
    val c = Hive.colors
    val shadowed = if (elevation > 0.dp) modifier.shadow(elevation, shape, ambientColor = glow ?: Color.Black, spotColor = glow ?: Color.Black) else modifier
    val context = androidx.compose.ui.platform.LocalContext.current
    // A cover already on screen at another size stands in while this size loads, so it never blinks;
    // the sharpest copy drawn so far, never a list row's thumbnail once a bigger one was shown.
    val request = remember(model, generation) {
        val own = model?.toString()?.let { ShownCovers[it]?.first }
        val standIn = own ?: replacing?.toString()?.let { ShownCovers[it]?.first }
        coil3.request.ImageRequest.Builder(context).data(model).placeholderMemoryCacheKey(standIn)
            // After a cover changed, a request that differs, or Coil keeps the picture it has.
            .apply { if (generation > 0) memoryCacheKeyExtra("cover", generation.toString()) }
            // Only a cover that wasn't standing in fades up; a carousel frame fades over the last one.
            .crossfade(when { own != null -> 0; standIn != null -> 600; else -> 260 }).build()
    }
    // AsyncImage, not SubcomposeAsyncImage: a subcomposition per row made every
    // list row costly to compose while scrolling.
    var shown by remember(model, generation) { mutableStateOf(request.placeholderMemoryCacheKey != null) }
    // The panel goes once the picture has faded up over it: left under a cover, it showed as a dark
    // rim around the cover's rounded corners, where both are only partly drawn.
    var covered by remember(model, generation) { mutableStateOf(false) }
    if (shown) androidx.compose.runtime.LaunchedEffect(model) { kotlinx.coroutines.delay(700); covered = true }
    Box(shadowed.clip(shape), contentAlignment = Alignment.Center) {
        // Kept a pixel inside the cover's edge, so its rim never shows at the rounded corners.
        if (!covered) Box(Modifier.fillMaxSize().padding(1.dp).clip(shape).background(mix(c.panelStrong.copy(alpha = 1f), c.bg, 0.6f)))
        if (!shown) ArtPlaceholder(fallback)
        AsyncImage(
            model = request,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            onSuccess = { state ->
                shown = true
                // From memory there's no fade: the panel goes at once.
                if (state.result.dataSource == coil3.decode.DataSource.MEMORY_CACHE) covered = true
                val key = state.result.memoryCacheKey
                val pixels = state.result.image.width.toLong() * state.result.image.height
                if (key != null && model != null) ShownCovers.merge(model.toString(), key to pixels) { old, new -> if (new.second >= old.second) new else old }
            },
            onError = { if (orElse != null) failed = true else { shown = false; covered = false } },
        )
    }
}

/** A cover carousel's frame: what to draw now, and the frame it replaces (to fade from). */
data class CoverFrame(val current: Any?, val previous: Any?)

/** How long each picture of a song shows in the cover carousel, as on the PC. */
const val COVER_ROTATE_MS = 4_000L

/**
 * Hive's cover carousel: a song with several distinct pictures embedded
 * (a back cover, an alternate) cycles through them every 4 seconds, as on
 * the PC. Every surface keys off the same wall-clock tick, so the player,
 * the bar and the album page change together. Other songs show [base].
 */
@Composable
fun rotatingCover(base: Any?, trackId: Long?): CoverFrame {
    val context = androidx.compose.ui.platform.LocalContext.current
    val pictures by androidx.compose.runtime.produceState(emptyList<java.io.File>(), trackId) {
        value = trackId?.let { com.local.hive.mobile.data.EmbeddedPictures.forTrack(context, it) }.orEmpty()
    }
    if (pictures.size < 2) return CoverFrame(base, null)
    val tick by androidx.compose.runtime.produceState(System.currentTimeMillis() / COVER_ROTATE_MS, pictures) {
        while (true) {
            kotlinx.coroutines.delay(COVER_ROTATE_MS - System.currentTimeMillis() % COVER_ROTATE_MS)
            value = System.currentTimeMillis() / COVER_ROTATE_MS
        }
    }
    val n = pictures.size
    return CoverFrame(pictures[(tick % n).toInt()], pictures[((tick - 1) % n + n).toInt() % n])
}

/** The sharpest memory-cache entry each cover has been drawn from, with its size in pixels. */
private val ShownCovers = java.util.concurrent.ConcurrentHashMap<String, Pair<coil3.memory.MemoryCache.Key, Long>>()

/**
 * Notes a cover loaded ahead of time (the playing song's, the next one's) as
 * the sharpest copy there is, so the big player and Now Playing show it at once
 * rather than a list row's thumbnail stretched up while the full one loads.
 */
fun noteLoadedCover(model: Any?, key: coil3.memory.MemoryCache.Key?, pixels: Long) {
    if (model == null || key == null) return
    ShownCovers.merge(model.toString(), key to pixels) { old, new -> if (new.second >= old.second) new else old }
}

/** Forgets which covers were shown, once a cover changed (the stand-ins would be the old picture). */
fun forgetShownCovers() { ShownCovers.clear(); CoverGeneration.intValue++ }

/** Bumped when a cover changed, so covers on screen load again. */
val CoverGeneration = androidx.compose.runtime.mutableIntStateOf(0)

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
    val bg by animateColorAsState(if (active) mix(c.accent, Color.Transparent, 0.36f) else mix(c.accent, c.panelStrong, 0.05f), tween(150), label = "pillBg")
    val edge by animateColorAsState(if (active) mix(c.accent, c.border, 0.6f) else c.border, tween(150), label = "pillEdge")
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
 * Songs and albums picked for a group action; long-press a song or an album
 * to start, tap to add or remove while picking. Holding one and dragging over
 * others picks every one between them, or, begun on one already picked,
 * un-picks them (see [albumDragSelect], [songDragSelect]).
 */
class Selection {
    val tracks = androidx.compose.runtime.mutableStateListOf<Track>()
    val albums = androidx.compose.runtime.mutableStateListOf<Long>()
    /** Apple Music and Spotify songs, picked on their pages and in the online search. */
    val streams = androidx.compose.runtime.mutableStateListOf<StreamTrack>()
    val active: Boolean get() = tracks.isNotEmpty() || albums.isNotEmpty() || streams.isNotEmpty()
    // Ids beside the lists, so "is it picked" stays quick with thousands picked (Select all on Songs).
    // Reading the list's size first makes a check recompose when picks change.
    private val trackIds = HashSet<Long>()
    private val streamKeys = HashSet<String>()
    operator fun contains(t: Track) = tracks.size >= 0 && t.id in trackIds
    operator fun contains(s: StreamTrack) = streams.size >= 0 && s.key in streamKeys
    private fun add(t: Track) { if (trackIds.add(t.id)) tracks += t }
    private fun add(s: StreamTrack) { if (streamKeys.add(s.key)) streams += s }
    fun toggle(t: Track) { if (trackIds.remove(t.id)) tracks.removeAll { it.id == t.id } else add(t) }
    fun toggle(s: StreamTrack) { if (streamKeys.remove(s.key)) streams.removeAll { it.key == s.key } else add(s) }
    fun hasAlbum(id: Long) = id in albums
    fun toggleAlbum(id: Long) { if (!albums.remove(id)) albums += id }
    fun clear() { tracks.clear(); albums.clear(); streams.clear(); trackIds.clear(); streamKeys.clear(); dragAnchor = null; trackDragAnchor = null }

    // ---- select all ----

    /** What a list on screen holds, for Select all (see [PickableList]). */
    class Scope(val tracks: List<Track> = emptyList(), val albums: List<Long> = emptyList(), val streams: List<StreamTrack> = emptyList())
    private val scopes = androidx.compose.runtime.mutableStateListOf<Scope>()
    fun register(scope: Scope) { scopes += scope }
    fun unregister(scope: Scope) { scopes.remove(scope) }

    /** The list being picked from: the one holding something picked (a pager keeps its neighbour pages composed too). */
    private val scope: Scope? get() = scopes.lastOrNull { sc -> val a = albums.toHashSet(); sc.tracks.any { it in this } || sc.albums.any { it in a } || sc.streams.any { it in this } } ?: scopes.lastOrNull()

    /** Everything in that list is picked. */
    val allPicked: Boolean get() = scope?.let { sc -> val a = albums.toHashSet(); sc.tracks.all { it in this } && sc.albums.all { it in a } && sc.streams.all { it in this } } ?: false

    /** Select all, or (all picked already) deselect all. */
    fun toggleAll() {
        val sc = scope ?: return
        if (allPicked) { clear(); return }
        // One list change each, not one per song.
        tracks.addAll(sc.tracks.filter { trackIds.add(it.id) })
        val albumSet = albums.toHashSet()
        albums.addAll(sc.albums.filter { albumSet.add(it) })
        streams.addAll(sc.streams.filter { streamKeys.add(it.key) })
    }

    /** The picked songs, then every song of the picked albums in album order. */
    fun picked(library: List<Track>): List<Track> {
        if (albums.isEmpty()) return tracks.toList()
        val byAlbum = library.filter { it.albumId in albums }.groupBy { it.albumId }
        val fromAlbums = albums.flatMap { id -> byAlbum[id].orEmpty().sortedWith(compareBy<Track> { it.discNumber }.thenBy { it.trackNumber }) }
        return (tracks + fromAlbums).distinctBy { it.id }
    }

    // ---- hold and drag over albums ----

    /** The album the finger went down on, while a hold-and-drag is picking. */
    var dragAnchor: Long? = null
        private set
    private var dragBase: List<Long> = emptyList()
    private var dragOver: Long? = null
    /** The albums of the grid on screen, in order, so a drag picks the ones between. */
    var albumOrder: List<Long> = emptyList()

    /** Whether the drag un-picks: it began on an album already picked. */
    private var dragRemoves = false

    fun startAlbumDrag(id: Long) {
        dragRemoves = id in albums
        dragBase = if (dragRemoves) albums.toList() else albums.filter { it != id }
        dragAnchor = id
        dragOver = null
        dragTo(id)
    }

    fun dragTo(id: Long) {
        val anchor = dragAnchor ?: return
        if (id == dragOver) return
        dragOver = id
        val from = albumOrder.indexOf(anchor)
        val to = albumOrder.indexOf(id)
        val range = if (from < 0 || to < 0) listOf(id) else albumOrder.subList(minOf(from, to), maxOf(from, to) + 1)
        val next = if (dragRemoves) dragBase - range.toSet() else (dragBase + range).distinct()
        albums.retainAll(next.toSet())
        next.forEach { if (it !in albums) albums += it }
    }

    fun endAlbumDrag() { dragAnchor = null; dragOver = null }

    // ---- hold and drag over songs (library songs and streamed ones alike) ----

    /** A song's id for a drag: a library song by its id, a streamed song by its key. */
    private fun dragId(x: Any): String = when (x) { is Track -> "t${x.id}"; is StreamTrack -> "s${x.key}"; else -> "" }
    private fun picked(x: Any) = when (x) { is Track -> x in this; is StreamTrack -> x in this; else -> false }

    /** The song the finger went down on, while a hold-and-drag is picking songs. */
    var trackDragAnchor: String? = null
        private set
    private var trackDragBase: List<Any> = emptyList()
    private var trackDragOver: String? = null
    /** The songs of the list on screen (Track or StreamTrack), in order, so a drag picks the ones between. */
    var trackOrder: List<Any> = emptyList()

    /** Whether the drag un-picks: it began on a song already picked. */
    private var trackDragRemoves = false

    fun startTrackDrag(song: Any) {
        val id = dragId(song)
        trackDragRemoves = picked(song)
        val all: List<Any> = tracks.toList() + streams.toList()
        trackDragBase = if (trackDragRemoves) all else all.filter { dragId(it) != id }
        trackDragAnchor = id
        trackDragOver = null
        dragToTrack(song)
    }

    fun dragToTrack(song: Any) {
        val anchor = trackDragAnchor ?: return
        val id = dragId(song)
        if (id == trackDragOver) return
        trackDragOver = id
        val from = trackOrder.indexOfFirst { dragId(it) == anchor }
        val to = trackOrder.indexOfFirst { dragId(it) == id }
        val range = if (from < 0 || to < 0) listOf(song) else trackOrder.subList(minOf(from, to), maxOf(from, to) + 1)
        val next = if (trackDragRemoves) range.mapTo(HashSet(), ::dragId).let { gone -> trackDragBase.filter { dragId(it) !in gone } }
            else (trackDragBase + range).distinctBy(::dragId)
        val keep = next.mapTo(HashSet(), ::dragId)
        tracks.removeAll { "t${it.id}" !in keep }
        trackIds.retainAll { "t$it" in keep }
        streams.removeAll { "s${it.key}" !in keep }
        streamKeys.retainAll { "s$it" in keep }
        next.forEach { when (it) { is Track -> add(it); is StreamTrack -> add(it) } }
    }

    fun endTrackDrag() { trackDragAnchor = null; trackDragOver = null }
}

val LocalSelection = androidx.compose.runtime.staticCompositionLocalOf<Selection?> { null }

/** Tells Select all what this list holds, while it's on screen. */
@Composable
fun PickableList(tracks: List<Track> = emptyList(), albums: List<Long> = emptyList(), streams: List<StreamTrack> = emptyList()) {
    val selection = LocalSelection.current ?: return
    androidx.compose.runtime.DisposableEffect(selection, tracks, albums, streams) {
        val scope = Selection.Scope(tracks, albums, streams)
        selection.register(scope)
        onDispose { selection.unregister(scope) }
    }
}

/** While picking, in the page's top-left corner (over its back button): Select all, then Deselect all. */
@Composable
fun SelectAllButton(selection: Selection, modifier: Modifier = Modifier) {
    val c = Hive.colors
    AnimatedVisibility(selection.active, modifier, enter = fadeIn(tween(160)) + scaleIn(tween(160), initialScale = 0.9f), exit = fadeOut(tween(120))) {
        val all = selection.allPicked
        Row(
            Modifier.minimumInteractiveComponentSize().height(42.dp).hiveGlass(HiveShape.pill).clip(HiveShape.pill).clickable { selection.toggleAll() }.padding(start = 12.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (all) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, null, tint = c.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (all) "Deselect all" else "Select all", style = HiveText.rowStrong, color = c.text)
        }
    }
}

/**
 * Hold an album, then drag: every album between it and the one under the
 * finger is picked, and the list scrolls when the finger nears its top or
 * bottom edge. [rows] maps each list item's key to its albums, left to right;
 * the finger is placed by the list's own layout, so nothing extra runs per card.
 */
@Composable
fun Modifier.albumDragSelect(list: androidx.compose.foundation.lazy.LazyListState, rows: Map<Any, List<Long>>, order: List<Long>): Modifier {
    val selection = LocalSelection.current ?: return this
    androidx.compose.runtime.SideEffect { selection.albumOrder = order }
    val currentRows by androidx.compose.runtime.rememberUpdatedState(rows)
    return pickDrag(list, selection, active = { selection.dragAnchor != null }, end = selection::endAlbumDrag) { key, x, width ->
        val albums = currentRows[key] ?: return@pickDrag
        (albums.getOrNull(if (x < width / 2f) 0 else 1) ?: albums.lastOrNull())?.let(selection::dragTo)
    }
}

/**
 * Hold a song, then drag: every song between it and the one under the finger
 * is picked, down to the end of a long album or playlist, as the list scrolls
 * when the finger nears its top or bottom edge. [rows] maps list keys to songs.
 */
@Composable
fun Modifier.songDragSelect(list: androidx.compose.foundation.lazy.LazyListState, rows: Map<Any, Any>, order: List<Any>): Modifier {
    val selection = LocalSelection.current ?: return this
    androidx.compose.runtime.SideEffect { selection.trackOrder = order }
    val currentRows by androidx.compose.runtime.rememberUpdatedState(rows)
    return pickDrag(list, selection, active = { selection.trackDragAnchor != null }, end = selection::endTrackDrag) { key, _, _ ->
        currentRows[key]?.let(selection::dragToTrack)
    }
}

/** The finger after a hold: what's under it is picked ([pick]), and the list scrolls near its edges. */
@Composable
private fun Modifier.pickDrag(
    list: androidx.compose.foundation.lazy.LazyListState,
    selection: Selection,
    active: () -> Boolean,
    end: () -> Unit,
    pick: (key: Any, x: Float, width: Int) -> Unit,
): Modifier {
    val scope = rememberCoroutineScope()
    val currentPick by androidx.compose.runtime.rememberUpdatedState(pick)
    val edge = with(androidx.compose.ui.platform.LocalDensity.current) { 72.dp.toPx() }
    fun at(x: Float, y: Float, width: Int) {
        val info = list.layoutInfo
        val p = y + info.viewportStartOffset
        val item = info.visibleItemsInfo.firstOrNull { p >= it.offset && p < it.offset + it.size } ?: return
        currentPick(item.key, x, width)
    }
    return pointerInput(selection, list) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = androidx.compose.ui.input.pointer.PointerEventPass.Initial)
            // A new touch: a drag left over from a hold in a list without hold-and-drag ends here.
            end()
            var speed = 0f
            var finger = androidx.compose.ui.geometry.Offset.Zero
            var scroller: kotlinx.coroutines.Job? = null
            try {
                while (true) {
                    val change = awaitPointerEvent(androidx.compose.ui.input.pointer.PointerEventPass.Initial).changes.firstOrNull() ?: break
                    if (!change.pressed) break
                    if (!active()) continue
                    // Picking, not scrolling: the list doesn't get this drag.
                    change.consume()
                    finger = change.position
                    at(finger.x, finger.y, size.width)
                    // Faster the nearer the edge, so a long album or playlist is crossed quickly.
                    speed = when {
                        finger.y < edge -> -(edge - finger.y) / edge * 34f
                        finger.y > size.height - edge -> (finger.y - (size.height - edge)) / edge * 34f
                        else -> 0f
                    }
                    if (speed != 0f && scroller?.isActive != true) scroller = scope.launch {
                        while (speed != 0f) {
                            list.scrollBy(speed)
                            at(finger.x, finger.y, size.width)
                            androidx.compose.runtime.withFrameNanos { }
                        }
                    }
                }
            } finally {
                speed = 0f
                scroller?.cancel()
                end()
            }
        }
    }
}

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
        track.artworkUri, track.title, subtitle, playing, isPlaying, onClick, number = number, loved = loved,
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
    val fill by animateColorAsState(when { picked -> c.accentSoft.copy(alpha = 0.38f); playing -> c.accentSoft.copy(alpha = 0.22f); else -> Color.Transparent }, tween(180), label = "rowFill")
    val titleColor by animateColorAsState(when { playing -> c.accent; enabled -> c.text; else -> c.textDim }, tween(180), label = "rowTitle")
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
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val c = Hive.colors
    Column(modifier.pressable(onClick = onClick, onLongClick = onLongClick)) {
        Box {
            Artwork(art, artModifier.fillMaxWidth().aspectRatio(1f), HiveShape.art, fallback, elevation = 14.dp)
            if (picked) {
                Box(Modifier.matchParentSize().clip(HiveShape.art).background(c.accentSoft.copy(alpha = 0.32f)))
                Box(Modifier.matchParentSize().padding(1.dp).border(2.dp, c.accent, HiveShape.art))
                Box(Modifier.align(Alignment.TopEnd).padding(8.dp).size(24.dp).clip(CircleShape).background(c.accent), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Check, "Picked", tint = readableOn(c.accent), modifier = Modifier.size(16.dp))
                }
            }
        }
        Text(title, style = HiveText.cardTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
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

/**
 * A lossy song Hive downloaded itself from Soulseek (a lossless copy wasn't found then): a
 * lossless copy can still replace it. Only Hive's own files, which Android lets Hive delete.
 */
fun Track.isLossySoulseekDownload(context: android.content.Context): Boolean {
    val home = com.local.hive.mobile.soulseek.SoulseekSettings(context).folder.trim('/')
    return home.isNotEmpty() && folder.trim('/').startsWith("Music/$home/", ignoreCase = true) &&
        fileName.substringAfterLast('.').lowercase() !in setOf("flac", "wav", "alac", "aiff", "ape", "wv")
}

/** Whether a Soulseek copy can take this song's place: a YouTube download, or a lossy Soulseek one. */
fun Track.replaceableFromSoulseek(context: android.content.Context) = isYouTubeDownload || isLossySoulseekDownload(context)

/** Downloads [track] from Soulseek; the new copy takes the old one's place (see SoulseekWorker.takeOver). */
fun replaceFromSoulseek(context: android.content.Context, track: Track, onToast: (String) -> Unit) {
    if (!com.local.hive.mobile.soulseek.SoulseekSettings(context).configured) { onToast("Sign in to Soulseek in Settings first"); return }
    val lossless = !track.isYouTubeDownload
    com.local.hive.mobile.soulseek.SoulseekWorker.enqueue(context, com.local.hive.mobile.soulseek.SoulseekRequest(
        track.displayAlbumArtist.substringBefore(",").trim(), track.album,
        listOf(com.local.hive.mobile.soulseek.SoulseekRequest.Track(track.title, track.durationMs, replaces = track.id)), "track", losslessOnly = lossless))
    onToast(if (lossless) "Looking for a lossless copy of ${track.title} on Soulseek" else "Getting ${track.title} from Soulseek; it replaces the old copy")
}

@Composable
fun TrackMenu(expanded: Boolean, loved: Boolean, onDismiss: () -> Unit, track: Track, actions: TrackActions) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val toast = LocalToast.current
    HiveMenu(expanded, onDismiss) {
        HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { onDismiss(); actions.onPlayNext(track) }
        HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { onDismiss(); actions.onAddToQueue(track) }
        HiveMenuItem("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { onDismiss(); actions.onAddToPlaylist(listOf(track)) }
        HiveMenuItem("Auto DJ", Icons.Rounded.Radio) { onDismiss(); actions.onAutoDj(listOf(track)) }
        HiveMenuItem(if (loved) "Remove from Favorites" else "Add to Favorites", if (loved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder) { onDismiss(); actions.onToggleLove(track) }
        HiveMenuItem("Share", Icons.Rounded.Share) { onDismiss(); Share.tracks(context, listOf(track)) }
        if (track.replaceableFromSoulseek(context)) HiveMenuItem("Replace with Soulseek copy", Icons.Rounded.Download) { onDismiss(); replaceFromSoulseek(context, track, toast) }
        HiveMenuDivider()
        HiveMenuItem("Go to album", Icons.Rounded.Album) { onDismiss(); actions.onGoToAlbum(track) }
        HiveMenuItem("Go to artist", Icons.Rounded.Person) { onDismiss(); actions.onGoToArtist(track) }
        HiveMenuItem("Track details", Icons.Rounded.Info) { onDismiss(); actions.onInfo(track) }
        val editor = LocalEditor.current
        HiveMenuItem("Edit tags", Icons.Rounded.Edit) { onDismiss(); editor.editTags(listOf(track)) }
        HiveMenuDivider()
        actions.onRemoveFromPlaylist?.let { remove ->
            HiveMenuItem("Remove from playlist", Icons.Rounded.RemoveCircleOutline, destructive = true) { onDismiss(); remove(track) }
        }
        HiveMenuItem("Delete from phone", Icons.Rounded.Delete, destructive = true) { onDismiss(); actions.onDelete(listOf(track)) }
    }
}

/**
 * Hive's context menu: glass tinted 7% by the accent, a soft accent glow, and
 * the `inlineDropIn` entrance (fade, a 5 px rise, scale .985 → 1).
 */
@Composable
fun HiveMenu(expanded: Boolean, onDismiss: () -> Unit, above: Dp? = null, content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(false) }
    state.targetState = expanded
    if (!state.currentState && !state.targetState) return
    val c = Hive.colors
    // Below its button, or ([above], the button's height) rising from it, for buttons at the screen's foot.
    val rise = above?.let { with(androidx.compose.ui.platform.LocalDensity.current) { (it + 8.dp).roundToPx() } }
    Popup(alignment = if (rise != null) Alignment.BottomEnd else Alignment.TopEnd, offset = IntOffset(0, if (rise != null) -rise else 8), onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
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
    val hex = c.accent
    val letter = readableOn(c.accent)
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
