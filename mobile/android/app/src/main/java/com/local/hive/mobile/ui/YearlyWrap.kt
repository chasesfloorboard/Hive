package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.local.hive.mobile.data.PlayRow
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveAmbient
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/**
 * A year of listening as Hive's Yearly Wrap counts it: Hive on the PC's own
 * Wrap when paired ([fromPc]: its plays, imports and this phone's, the same
 * numbers the PC shows), otherwise this phone's plays.
 */
data class Wrap(
    val year: Int,
    val listenedMs: Long,
    val plays: Int,
    val artists: Int,
    val albums: Int,
    val longestStreak: Int,
    val topTrack: Ranked?,
    val topArtists: List<Ranked>,
    val topAlbums: List<Ranked>,
    val topGenre: String?,
    val months: List<Long>,
    val biggestDay: Pair<LocalDate, Long>?,
    val biggestMonth: Pair<Int, Long>?,
    val fromPc: Boolean = false,
) {
    /** [cover]: a picture address from the PC, for albums this phone doesn't have. */
    data class Ranked(val name: String, val sub: String, val plays: Int, val albumId: Long, val cover: String? = null)

    /**
     * This Wrap with more plays added: plays Hive on the PC hasn't counted yet, on top of its Wrap.
     * Totals, months and the top lists add up; how many different artists and albums, and the
     * longest streak, stay as counted until Hive counts these plays too.
     */
    operator fun plus(rows: List<PlayRow>): Wrap {
        if (rows.isEmpty()) return this
        if (plays == 0) return from(year, rows).copy(fromPc = fromPc)
        val more = from(year, rows)
        fun fold(s: String) = LibrarySort.fold(s)
        fun merge(mine: List<Ranked>, theirs: List<Ranked>, key: (Ranked) -> String): List<Ranked> {
            val all = LinkedHashMap<String, Ranked>()
            (mine + theirs).forEach { r -> all.merge(key(r), r) { a, b -> a.copy(plays = a.plays + b.plays, albumId = a.albumId.takeIf { it > 0 } ?: b.albumId, cover = a.cover ?: b.cover) } }
            return all.values.sortedByDescending { it.plays }.take(5)
        }
        val monthsNow = months.zip(more.months) { a, b -> a + b }
        // The top song: the PC's top one with these plays added, unless one of these now has more.
        val trackKey = { r: Ranked -> fold(r.name) + "\u0000" + fold(r.sub) }
        val top = topTrack?.let { t -> t.copy(plays = t.plays + rows.count { trackKey(Ranked(it.title, it.artist, 0, 0)) == trackKey(t) }) }
        val newTop = more.topTrack?.takeIf { top == null || (trackKey(it) != trackKey(top) && it.plays > top.plays) }
        val day = more.biggestDay?.let { (d, ms) -> if (biggestDay == null) d to ms else if (biggestDay.first == d) d to biggestDay.second + ms else if (ms > biggestDay.second) d to ms else biggestDay } ?: biggestDay
        return copy(
            listenedMs = listenedMs + more.listenedMs, plays = plays + more.plays,
            topTrack = newTop ?: top,
            topArtists = merge(topArtists, more.topArtists) { fold(it.name) },
            topAlbums = merge(topAlbums, more.topAlbums) { fold(it.name) + "\u0000" + fold(it.sub) },
            months = monthsNow, biggestDay = day,
            biggestMonth = monthsNow.withIndex().maxByOrNull { it.value }?.takeIf { it.value > 0 }?.let { (it.index + 1) to it.value },
        )
    }

    companion object {
        /**
         * Hive's Wrap, as Hive counted it. Covers come from this phone's copy of
         * the album when it has one (they show offline), else from the PC.
         */
        fun fromPc(pc: com.local.hive.mobile.link.PcWrap, phoneAlbums: List<com.local.hive.mobile.data.AlbumSummary>, coverUrl: (String) -> String?): Wrap {
            val byName = phoneAlbums.groupBy { LibrarySort.fold(it.album) }
            fun albumId(album: String, artist: String): Long {
                val same = byName[LibrarySort.fold(album)].orEmpty()
                return (same.firstOrNull { LibrarySort.fold(it.artist) == LibrarySort.fold(artist) } ?: same.firstOrNull())?.albumId ?: 0
            }
            fun cover(name: String?) = name?.takeIf { it.isNotBlank() }?.let { if (it.startsWith("https://")) it else coverUrl(it) }
            fun ms(seconds: Double) = (seconds * 1000).toLong()
            val months = MutableList(12) { 0L }
            pc.monthly.forEach { m -> m.month.substringAfter('-').toIntOrNull()?.takeIf { it in 1..12 }?.let { months[it - 1] = ms(m.seconds) } }
            val top = pc.topTrack?.let { t ->
                val (title, artist) = t.key.split('\u0000').let { it.getOrElse(0) { "" } to it.getOrElse(1) { "" } }
                Ranked(title, artist, t.plays, albumId(t.album, artist), cover(t.cover))
            }
            return Wrap(
                year = pc.year, listenedMs = ms(pc.totalSeconds), plays = pc.totalPlays,
                artists = pc.uniqueArtists, albums = pc.uniqueAlbums, longestStreak = pc.longestStreak,
                topTrack = top,
                topArtists = pc.topArtists.map { Ranked(it.name, "", it.plays, 0, cover(it.cover)) },
                topAlbums = pc.topAlbums.map { Ranked(it.album, it.artist, it.plays, albumId(it.album, it.artist), cover(it.cover)) },
                topGenre = pc.topGenres.firstOrNull()?.name,
                months = months,
                biggestDay = pc.topDay?.let { d -> runCatching { LocalDate.parse(d.date) to ms(d.seconds) }.getOrNull() },
                biggestMonth = pc.topMonth?.let { m -> m.month.substringAfter('-').toIntOrNull()?.let { it to ms(m.seconds) } },
                fromPc = true,
            )
        }

        fun from(year: Int, rows: List<PlayRow>): Wrap {
            val zone = ZoneId.systemDefault()
            fun day(r: PlayRow) = Instant.ofEpochMilli(r.playedAt).atZone(zone).toLocalDate()
            val days = rows.map(::day).toSortedSet()
            var longest = 0; var run = 0; var prev: LocalDate? = null
            for (d in days) { run = if (prev != null && prev.plusDays(1) == d) run + 1 else 1; longest = maxOf(longest, run); prev = d }
            fun albumArtist(r: PlayRow) = r.albumArtist.ifBlank { r.artist }
            val byTrack = rows.groupBy { it.trackId }.values.map { g -> Ranked(g[0].title, g[0].artist, g.size, g[0].albumId) }.sortedByDescending { it.plays }
            val byArtist = rows.groupBy { it.artist.split(Regex("""\s*(,|&|feat\.?|ft\.?)\s*""")).first().trim() }.filterKeys { it.isNotBlank() }
                .map { (name, g) -> Ranked(name, "", g.size, g.groupBy { it.albumId }.maxByOrNull { it.value.size }!!.key) }.sortedByDescending { it.plays }
            val byAlbum = rows.filter { it.album.isNotBlank() }.groupBy { it.albumId }.values.map { g -> Ranked(g[0].album, albumArtist(g[0]), g.size, g[0].albumId) }.sortedByDescending { it.plays }
            val months = (1..12).map { m -> rows.filter { Instant.ofEpochMilli(it.playedAt).atZone(zone).monthValue == m }.sumOf { it.listenedMs } }
            val dayTotals = rows.groupBy(::day).mapValues { (_, g) -> g.sumOf { it.listenedMs } }
            return Wrap(
                year = year, listenedMs = rows.sumOf { it.listenedMs }, plays = rows.size,
                artists = byArtist.size, albums = byAlbum.size, longestStreak = longest,
                topTrack = byTrack.firstOrNull(), topArtists = byArtist.take(5), topAlbums = byAlbum.take(5),
                topGenre = rows.filter { it.genre.isNotBlank() }.groupBy { it.genre }.maxByOrNull { it.value.size }?.key,
                months = months, biggestDay = dayTotals.maxByOrNull { it.value }?.toPair(),
                biggestMonth = months.withIndex().maxByOrNull { it.value }?.takeIf { it.value > 0 }?.let { (it.index + 1) to it.value },
            )
        }
    }
}

private fun art(albumId: Long) = android.net.Uri.parse("content://media/external/audio/albumart/$albumId")
/** The phone's copy of the album's cover, else the PC's. */
private fun art(r: Wrap.Ranked): Any = if (r.albumId > 0 || r.cover == null) art(r.albumId) else r.cover

private fun hours(ms: Long): String {
    val minutes = ms / 60_000
    return if (minutes < 120) "$minutes minutes" else "%,d hours".format(minutes / 60)
}

/**
 * Hive's Yearly Wrap from this phone's listening: the same slides as on the
 * PC (your year, listening time, top track, top artist, top albums, by
 * month, the summary), swiped through, with Share to send a slide as a picture.
 */
@Composable
fun YearlyWrapScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    val years by produceState<List<Int>?>(null) { vm.wrapYears().collect { value = it } }
    var year by remember { mutableIntStateOf(java.time.Year.now().value) }
    // As last counted straight away, then brought up to date with the PC when it can be reached.
    val wrap by produceState<Wrap?>(null, year) { value = null; vm.wrap(year).collect { value = it } }
    val pager = rememberPagerState { 7 }
    val layer = rememberGraphicsLayer()
    val scope = rememberCoroutineScope()

    Box(Modifier.fillMaxSize().background(c.bg)) {
        HiveAmbient(c.accent.copy(alpha = 0.35f), c.accentSoft, Modifier.fillMaxSize(), intensity = 1.4f)
        val w = wrap
        when {
            w == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.accent) }
            w.plays == 0 -> Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                EmptyState("Not enough listening yet", "Hive builds your Wrap from the songs you play. Play some music and come back.")
            }
            else -> HorizontalPager(pager, Modifier.fillMaxSize().drawWithContent { layer.record { this@drawWithContent.drawContent() }; drawLayer(layer) }) { page ->
                val month = { m: Int -> java.time.Month.of(m).getDisplayName(TextStyle.FULL, Locale.getDefault()) }
                // Each slide sits on its subject's cover, blurred to colour, as a phone story does.
                val backdrop: Any? = when (page) {
                    0, 4, 6 -> w.topAlbums.firstOrNull()?.let { r -> art(r) }
                    2 -> w.topTrack?.let { r -> art(r) }
                    3 -> w.topArtists.firstOrNull()?.let { r -> art(r) }
                    else -> null
                }
                Box(Modifier.fillMaxSize()) {
                    if (backdrop != null) SlideBackdrop(backdrop)
                    // The words sit low, where a thumb holds the phone; taps on the left go back, elsewhere on.
                    Column(
                        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
                            .pointerInput(Unit) {
                                detectTapGestures { at -> scope.launch { pager.animateScrollToPage((pager.currentPage + if (at.x > size.width / 3) 1 else -1).coerceIn(0, 6)) } }
                            }
                            .padding(start = 28.dp, end = 28.dp, top = 92.dp, bottom = bottomPadding + 40.dp),
                    ) {
                        Spacer(Modifier.weight(1f))
                        when (page) {
                            0 -> {
                                Eyebrow("Yearly Wrap")
                                Giant("${w.year}")
                                Title("Your year in music.")
                                Sub(if (w.fromPc) "Everything you played, in Hive on your PC and on this phone." else "What you actually listened to on this phone, kept on this phone.")
                            }
                            1 -> {
                                val h = w.listenedMs / 3_600_000
                                Eyebrow("Listening time")
                                Giant(if (h >= 2) "%,d".format(h) else "${w.listenedMs / 60_000}")
                                Title(if (h >= 2) "hours with music." else "minutes with music.")
                                Stats(listOf("%,d".format(w.plays) to "plays", "%,d".format(w.artists) to "artists", "%,d".format(w.albums) to "albums", countOf(w.longestStreak, "day") to "longest streak"))
                            }
                            2 -> w.topTrack?.let { t ->
                                Artwork(art(t), Modifier.fillMaxWidth(0.78f).aspectRatio(1f).align(Alignment.CenterHorizontally), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 36.dp)
                                Spacer(Modifier.height(32.dp))
                                Eyebrow("Your top track")
                                Title(t.name, big = true)
                                Sub(t.sub)
                                Stats(listOf("%,d".format(t.plays) to "plays"))
                            }
                            3 -> w.topArtists.firstOrNull()?.let { a ->
                                val photo = rememberArtistPhoto(vm, a.name)
                                Artwork(photo ?: art(a), Modifier.fillMaxWidth(0.66f).aspectRatio(1f).align(Alignment.CenterHorizontally), CircleShape, Icons.Rounded.LibraryMusic, elevation = 36.dp)
                                Spacer(Modifier.height(32.dp))
                                Eyebrow("The artist of your year")
                                Title(a.name, big = true)
                                Stats(listOf("%,d".format(a.plays) to "plays", "${(a.plays * 100 / w.plays.coerceAtLeast(1))}%" to "of your listening"))
                            }
                            4 -> {
                                Eyebrow("The records you returned to")
                                Title("Your top albums.")
                                Spacer(Modifier.height(18.dp))
                                w.topAlbums.forEachIndexed { i, a -> Rank(i + 1, a) }
                            }
                            5 -> {
                                Eyebrow("When you listened")
                                Title(w.biggestMonth?.first?.let { "${month(it)} was your month." } ?: "Your year, by month.")
                                Months(w.months)
                                Stats(listOf(
                                    (w.biggestDay?.first?.format(DateTimeFormatter.ofPattern("MMM d")) ?: "—") to "biggest day",
                                    (w.biggestDay?.second?.let { hours(it) } ?: "—") to "that day",
                                ))
                            }
                            else -> {
                                Eyebrow("That's your year")
                                Title("The music stays with you.")
                                Spacer(Modifier.height(18.dp))
                                Summary("Top artist", w.topArtists.firstOrNull()?.name, w.topArtists.firstOrNull()?.let { r -> art(r) }, CircleShape)
                                Summary("Top track", w.topTrack?.name, w.topTrack?.let { r -> art(r) }, HiveShape.thumb)
                                Summary("Top album", w.topAlbums.firstOrNull()?.name, w.topAlbums.firstOrNull()?.let { r -> art(r) }, HiveShape.thumb)
                                Summary("Top genre", w.topGenre, null, HiveShape.thumb)
                                Spacer(Modifier.height(14.dp))
                                Sub(if (w.fromPc) "Counted by Hive on your PC, with this phone's plays in it." else "Kept on your phone. No account needed.")
                            }
                        }
                    }
                }
            }
        }
        // The bar: back, the year, share.
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable(onClick = onBack), contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Navigate up", tint = c.text, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.weight(1f))
            years?.takeIf { it.size > 1 }?.forEach { y -> HivePill("$y", active = y == year) { year = y }; Spacer(Modifier.width(6.dp)) }
            if (wrap?.plays ?: 0 > 0) Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable {
                scope.launch {
                    val bitmap = layer.toImageBitmap().asAndroidBitmap()
                    val file = withContext(Dispatchers.IO) {
                        java.io.File(context.cacheDir, "wrap").apply { mkdirs() }.resolve("hive-wrap-$year.png").also { f -> f.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
                    }
                    val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("image/png").putExtra(android.content.Intent.EXTRA_STREAM, uri).addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    runCatching { context.startActivity(android.content.Intent.createChooser(send, "Your $year in music")) }
                }
            }, contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Share, "Share this slide", tint = c.text, modifier = Modifier.size(19.dp)) }
        }
        // Where you are in the slides, as a story shows it: a segment per slide under the bar.
        if ((wrap?.plays ?: 0) > 0) Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 16.dp, end = 16.dp, top = 60.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            repeat(7) { i -> Box(Modifier.weight(1f).height(3.dp).clip(HiveShape.pill).background(if (i <= pager.currentPage) c.accent else c.text.copy(alpha = 0.18f))) }
        }
    }
}

@Composable private fun Eyebrow(text: String) = Text(text, style = HiveText.rowStrong.copy(fontSize = 15.sp), color = Hive.colors.accent)
/** The slide's one number, as big as the phone allows. */
@Composable private fun Giant(text: String) = Text(text, style = HiveText.heroTitle.copy(fontSize = if (text.length <= 4) 112.sp else 84.sp, lineHeight = if (text.length <= 4) 112.sp else 88.sp, fontWeight = FontWeight.Black, letterSpacing = (-3).sp), color = Hive.colors.text, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
@Composable private fun Title(text: String, big: Boolean = false) = Text(text, style = HiveText.heroTitle.copy(fontSize = if (big) 40.sp else 32.sp, lineHeight = if (big) 44.sp else 36.sp, fontWeight = if (big) FontWeight.Black else FontWeight.Bold), color = Hive.colors.text, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
@Composable private fun Sub(text: String) = Text(text, style = HiveText.body.copy(fontSize = 17.sp, lineHeight = 23.sp), color = Hive.colors.textDim, modifier = Modifier.padding(top = 10.dp))

/** The slide's subject cover, blurred to its colours and darkened toward the words. */
@Composable
private fun SlideBackdrop(model: Any) {
    val c = Hive.colors
    Box(Modifier.fillMaxSize()) {
        Artwork(model, Modifier.fillMaxSize().graphicsLayer { scaleX = 1.4f; scaleY = 1.4f; alpha = 0.7f }.blur(70.dp), androidx.compose.ui.graphics.RectangleShape, Icons.Rounded.LibraryMusic)
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(0f to c.bg.copy(alpha = 0.35f), 0.55f to c.bg.copy(alpha = 0.6f), 1f to c.bg.copy(alpha = 0.92f))))
    }
}

/** Numbers without boxes: each large, its word under it, two to a row. */
@Composable
private fun Stats(items: List<Pair<String, String>>) {
    val c = Hive.colors
    Column(Modifier.fillMaxWidth().padding(top = 26.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        items.chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth()) {
                row.forEach { (value, label) ->
                    Column(Modifier.weight(1f)) {
                        Text(value, style = HiveText.heroTitle.copy(fontSize = 30.sp, lineHeight = 34.sp, fontWeight = FontWeight.Black), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(label, style = HiveText.body, color = c.textDim)
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** A line of the closing slide: the picture, what it is, and its name. */
@Composable
private fun Summary(label: String, name: String?, art: Any?, shape: androidx.compose.ui.graphics.Shape) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        if (art != null) Artwork(art, Modifier.size(52.dp), shape, Icons.Rounded.LibraryMusic)
        else Box(Modifier.size(52.dp).clip(HiveShape.thumb).background(c.accent.copy(alpha = 0.22f)), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.LibraryMusic, null, tint = c.accent, modifier = Modifier.size(22.dp)) }
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Text(label, style = HiveText.small, color = c.textDim)
            Text(name ?: "—", style = HiveText.rowStrong.copy(fontSize = 18.sp, lineHeight = 22.sp, fontWeight = FontWeight.Bold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun Rank(n: Int, a: Wrap.Ranked) {
    val c = Hive.colors
    val first = n == 1
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("$n", style = HiveText.heroTitle.copy(fontSize = 26.sp, fontWeight = FontWeight.Black), color = if (first) c.accent else c.textDim, modifier = Modifier.width(34.dp))
        Artwork(art(a), Modifier.size(if (first) 76.dp else 60.dp), HiveShape.thumb, Icons.Rounded.LibraryMusic, elevation = if (first) 16.dp else 0.dp)
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(a.name, style = HiveText.rowStrong.copy(fontSize = if (first) 19.sp else 16.sp, fontWeight = FontWeight.Bold), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOf(a.sub, countOf(a.plays, "play")).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun Months(totals: List<Long>) {
    val c = Hive.colors
    val max = (totals.maxOrNull() ?: 0).coerceAtLeast(1)
    Row(Modifier.fillMaxWidth().height(220.dp).padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Bottom) {
        totals.forEachIndexed { i, t ->
            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
                Box(Modifier.fillMaxWidth().fillMaxHeight((t.toFloat() / max).coerceAtLeast(0.015f) * 0.86f).clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp, bottomStart = 2.dp, bottomEnd = 2.dp)).background(if (t == max) c.accent else c.text.copy(alpha = 0.22f)))
                Text(java.time.Month.of(i + 1).getDisplayName(TextStyle.NARROW, Locale.getDefault()), style = HiveText.small, color = if (t == max) c.accent else c.textDim, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}
