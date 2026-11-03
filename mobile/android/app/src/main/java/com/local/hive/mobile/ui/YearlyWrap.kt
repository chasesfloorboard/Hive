package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
    /** The top genre's most listened album this year: the genre's picture. */
    val topGenreAlbum: Ranked? = null,
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
            topGenreAlbum = topGenreAlbum ?: more.topGenreAlbum?.takeIf { topGenre == null || fold(topGenre) == fold(more.topGenre.orEmpty()) },
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
                topGenreAlbum = pc.topGenres.firstOrNull()?.takeIf { it.album.isNotBlank() }?.let { g -> Ranked(g.album, g.artist, 0, albumId(g.album, g.artist), cover(g.cover)) },
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
            val topGenre = rows.filter { it.genre.isNotBlank() }.groupBy { it.genre }.maxByOrNull { it.value.size }?.key
            // The genre's picture: its album listened to longest this year (then the most played).
            val genreAlbum = rows.filter { it.genre == topGenre && it.album.isNotBlank() }.groupBy { it.albumId }.values
                .maxWithOrNull(compareBy<List<PlayRow>> { g -> g.sumOf { it.listenedMs } }.thenBy { it.size })
                ?.let { g -> Ranked(g[0].album, albumArtist(g[0]), g.size, g[0].albumId) }
            return Wrap(
                year = year, listenedMs = rows.sumOf { it.listenedMs }, plays = rows.size,
                artists = byArtist.size, albums = byAlbum.size, longestStreak = longest,
                topTrack = byTrack.firstOrNull(), topArtists = byArtist.take(5), topAlbums = byAlbum.take(5),
                topGenre = topGenre, topGenreAlbum = genreAlbum,
                months = months, biggestDay = dayTotals.maxByOrNull { it.value }?.toPair(),
                biggestMonth = months.withIndex().maxByOrNull { it.value }?.takeIf { it.value > 0 }?.let { (it.index + 1) to it.value },
            )
        }
    }
}

private fun art(albumId: Long) = android.net.Uri.parse("content://media/external/audio/albumart/$albumId")
/** The phone's copy of the album's cover, else the PC's. */
private fun art(r: Wrap.Ranked): Any = if (r.albumId > 0 || r.cover == null) art(r.albumId) else r.cover

/**
 * An artist's picture in the Wrap. With Settings > Artist pictures on Covers (nothing looked up online)
 * it's one of their album covers: one of the year's top albums by them, else one on this phone;
 * on Photos, the photo or the PC's picture of them.
 */
private fun artistArt(w: Wrap, a: Wrap.Ranked, photos: Boolean, phoneAlbumId: Long?): Any? {
    if (photos) return art(a)
    w.topAlbums.firstOrNull { LibrarySort.fold(it.sub) == LibrarySort.fold(a.name) }?.let { return art(it) }
    w.topTrack?.takeIf { LibrarySort.fold(it.sub) == LibrarySort.fold(a.name) }?.let { return art(it) }
    return (phoneAlbumId ?: a.albumId.takeIf { it > 0 })?.let { art(it) }
}

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
fun YearlyWrapScreen(vm: MainViewModel, bottomPadding: Dp, onOpenAlbum: (Long) -> Unit = {}, onOpenArtist: (String) -> Unit = {}, onBack: () -> Unit) {
    val c = Hive.colors
    val context = LocalContext.current
    // Animations off in Android's settings: slides show at once, no springs or counting.
    val reduceMotion = remember { android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
    val years by produceState<List<Int>?>(null) { vm.wrapYears().collect { value = it } }
    var year by remember { mutableIntStateOf(java.time.Year.now().value) }
    // As last counted straight away, then brought up to date with the PC when it can be reached.
    val wrap by produceState<Wrap?>(null, year) { value = null; vm.wrap(year).collect { value = it } }
    val pager = rememberPagerState { 7 }
    val layer = rememberGraphicsLayer()
    val scope = rememberCoroutineScope()
    var openMonth by remember(year) { mutableIntStateOf(0) }

    Box(Modifier.fillMaxSize().background(c.bg)) {
        HiveAmbient(c.accent.copy(alpha = 0.35f), c.accentSoft, Modifier.fillMaxSize(), intensity = 1.4f)
        val w = wrap
        when {
            w == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.accent) }
            w.plays == 0 -> Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                EmptyState("Not enough listening yet", "Hive builds your Wrap from the songs you play. Play some music and come back.")
            }
            else -> Box(Modifier.fillMaxSize().drawWithContent { layer.record { this@drawWithContent.drawContent() }; drawLayer(layer) }.background(c.bg)) {
            // One backdrop behind every slide: the slide's subject's cover, blurred to colour, fading into
            // the next cover as you swipe (each slide drawing its own left hard seams mid-swipe).
            val album = w.topAlbums.firstOrNull()?.let { r -> art(r) }
            val photos by vm.artistPhotos.collectAsStateWithLifecycle()
            val genreCovers by vm.genreCovers.collectAsStateWithLifecycle()
            val phoneArtists by vm.artists.collectAsStateWithLifecycle()
            fun artistPic(a: Wrap.Ranked) = artistArt(w, a, photos, phoneArtists.firstOrNull { it.artist.equals(a.name, true) }?.albumId)
            val arts = remember(w, photos, phoneArtists) { (0 until 7).map { page -> when (page) { 2 -> w.topTrack?.let { r -> art(r) } ?: album; 3 -> w.topArtists.firstOrNull()?.let { r -> artistPic(r) } ?: album; else -> album } } }
            WrapBackdrop(pager, arts)
            HorizontalPager(pager, Modifier.fillMaxSize()) { page ->
                val month = { m: Int -> java.time.Month.of(m).getDisplayName(TextStyle.FULL, Locale.getDefault()) }
                // Each slide springs in once it settles: numbers count up, covers land, bars grow.
                val enter by androidx.compose.animation.core.animateFloatAsState(
                    if (pager.settledPage == page || pager.targetPage == page) 1f else 0f,
                    if (reduceMotion) androidx.compose.animation.core.snap() else androidx.compose.animation.core.spring(dampingRatio = 0.72f, stiffness = 140f),
                    label = "enter",
                )
                // Counting up stops at the real number (the spring's overshoot is for movement only).
                val count = enter.coerceIn(0f, 1f)
                Box(Modifier.fillMaxSize()) {
                    // Taps on the left third go back a slide, elsewhere on (buttons and covers take their own taps).
                    Column(
                        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()
                            .pointerInput(Unit) {
                                detectTapGestures { at -> scope.launch { pager.animateScrollToPage((pager.currentPage + if (at.x > size.width / 3) 1 else -1).coerceIn(0, 6)) } }
                            }
                            .padding(start = 28.dp, end = 28.dp, top = 96.dp, bottom = bottomPadding + 28.dp),
                    ) {
                        // A little above the middle, where the eye lands, not piled at the foot.
                        Spacer(Modifier.weight(0.75f))
                        when (page) {
                            0 -> {
                                CoverFan(w.topAlbums.take(3).map { r -> art(r) }, enter, Modifier.align(Alignment.CenterHorizontally))
                                Spacer(Modifier.height(30.dp))
                                Eyebrow("Yearly Wrap")
                                Giant("${w.year}", Modifier.rise(enter, 0))
                                Title("Your year in music.", modifier = Modifier.rise(enter, 1))
                                Sub(if (w.fromPc) "Everything you played, in Hive on your PC and on this phone." else "What you listened to on this phone, kept on this phone.", Modifier.rise(enter, 2))
                            }
                            1 -> {
                                val h = w.listenedMs / 3_600_000
                                val big = if (h >= 2) h else w.listenedMs / 60_000
                                Eyebrow("Listening time")
                                Giant("%,d".format((big * count).toLong()))
                                Title(if (h >= 2) "hours with music." else "minutes with music.", modifier = Modifier.rise(enter, 1))
                                Sub(dayLine(w.listenedMs), Modifier.rise(enter, 2))
                                Stats(listOf("%,d".format((w.plays * count).toInt()) to "plays", "%,d".format((w.artists * count).toInt()) to "artists", "%,d".format((w.albums * count).toInt()) to "albums", countOf((w.longestStreak * count).toInt(), "day") to "longest streak"), Modifier.rise(enter, 3))
                            }
                            2 -> w.topTrack?.let { t ->
                                Artwork(art(t), Modifier.fillMaxWidth(0.74f).aspectRatio(1f).align(Alignment.CenterHorizontally).land(enter, -4f)
                                    .then(if (t.albumId > 0) Modifier.clip(HiveShape.art).clickable(onClickLabel = "Open the album") { onOpenAlbum(t.albumId) } else Modifier),
                                    HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 36.dp)
                                Spacer(Modifier.height(30.dp))
                                Eyebrow("Your top track")
                                Title(t.name, big = true, modifier = Modifier.rise(enter, 1))
                                Sub(t.sub, Modifier.rise(enter, 2))
                                Stats(listOf("%,d".format((t.plays * count).toInt()) to "plays", daysBetween(w, t.plays) to "between plays, on average"), Modifier.rise(enter, 3))
                            }
                            3 -> w.topArtists.firstOrNull()?.let { a ->
                                val photo = rememberArtistPhoto(vm, a.name)
                                Box(Modifier.align(Alignment.CenterHorizontally).fillMaxWidth(0.66f).aspectRatio(1f), contentAlignment = Alignment.Center) {
                                    // A ring that opens out once from the picture as it lands.
                                    Box(Modifier.fillMaxSize().graphicsLayer { val k = 1f + 0.16f * enter; scaleX = k; scaleY = k; alpha = (1f - enter).coerceIn(0f, 1f) * 0.9f }.border(3.dp, c.accent, CircleShape))
                                    Artwork(photo ?: artistPic(a), Modifier.fillMaxSize().land(enter, 0f).clip(CircleShape).clickable(onClickLabel = "Open the artist") { onOpenArtist(a.name) }, CircleShape, Icons.Rounded.LibraryMusic, elevation = 36.dp)
                                }
                                Spacer(Modifier.height(30.dp))
                                Eyebrow("The artist of your year")
                                Title(a.name, big = true, modifier = Modifier.rise(enter, 1))
                                Stats(listOf("%,d".format((a.plays * count).toInt()) to "plays", "${((a.plays * 100 / w.plays.coerceAtLeast(1)) * count).toInt()}%" to "of your listening"), Modifier.rise(enter, 2))
                            }
                            4 -> {
                                Eyebrow("The records you returned to")
                                Title("Your top albums.", modifier = Modifier.rise(enter, 0))
                                Spacer(Modifier.height(16.dp))
                                w.topAlbums.forEachIndexed { i, r -> Rank(i + 1, r, Modifier.rise(enter, i + 1), onClick = r.albumId.takeIf { it > 0 }?.let { id -> { onOpenAlbum(id) } }) }
                            }
                            5 -> {
                                Eyebrow("When you listened")
                                Title(w.biggestMonth?.first?.let { "${month(it)} was your month." } ?: "Your year, by month.", modifier = Modifier.rise(enter, 0))
                                Months(w.months, enter) { m -> openMonth = m }
                                Text("Tap a month to look inside it.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 10.dp).rise(enter, 3))
                                Stats(listOf(
                                    (w.biggestDay?.first?.format(DateTimeFormatter.ofPattern("MMM d")) ?: "—") to "biggest day",
                                    (w.biggestDay?.second?.let { hours(it) } ?: "—") to "that day",
                                ), Modifier.rise(enter, 4))
                            }
                            else -> {
                                Eyebrow("That's your year")
                                Title("The music stays with you.", modifier = Modifier.rise(enter, 0))
                                Spacer(Modifier.height(18.dp))
                                // A poster of the year: four tiles, two to a row.
                                // Never a letter for the genre: its most listened album this year, else its most played one on this phone.
                                val genreAlbum = w.topGenreAlbum?.takeIf { it.albumId != 0L || it.cover != null }
                                val genreCover = w.topGenre?.let { g -> genreCovers[g.lowercase()]?.firstOrNull() }
                                val tiles = listOf(
                                    Tile("Top artist", w.topArtists.firstOrNull()?.name, w.topArtists.firstOrNull()?.let { r -> artistPic(r) }, true) { w.topArtists.firstOrNull()?.let { onOpenArtist(it.name) } },
                                    Tile("Top track", w.topTrack?.name, w.topTrack?.let { r -> art(r) }, false) { w.topTrack?.albumId?.takeIf { it > 0 }?.let(onOpenAlbum) },
                                    Tile("Top album", w.topAlbums.firstOrNull()?.name, w.topAlbums.firstOrNull()?.let { r -> art(r) }, false) { w.topAlbums.firstOrNull()?.albumId?.takeIf { it > 0 }?.let(onOpenAlbum) },
                                    Tile("Top genre", w.topGenre, genreAlbum?.let { r -> art(r) } ?: genreCover, false) {
                                        (genreAlbum?.albumId?.takeIf { it != 0L } ?: genreCover?.toString()?.substringAfterLast('/')?.toLongOrNull())?.let(onOpenAlbum)
                                    },
                                )
                                tiles.chunked(2).forEachIndexed { row, pair ->
                                    Row(Modifier.fillMaxWidth().padding(bottom = 12.dp).rise(enter, row + 1), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                        pair.forEach { tile -> PosterTile(tile, Modifier.weight(1f)) }
                                    }
                                }
                                Sub(if (w.fromPc) "Counted by Hive on your PC, with this phone's plays in it." else "Kept on your phone. No account needed.", Modifier.rise(enter, 3))
                            }
                        }
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
            }
        }
        wrap?.let { w ->
            if (openMonth in 1..12) MonthSheet(vm, w, openMonth,
                // The month closes as its album or artist opens; back comes to the Wrap.
                onOpenAlbum = { openMonth = 0; onOpenAlbum(it) }, onOpenArtist = { openMonth = 0; onOpenArtist(it) }) { openMonth = 0 }
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
@Composable private fun Giant(text: String, modifier: Modifier = Modifier) = Text(text, style = HiveText.heroTitle.copy(fontSize = if (text.length <= 4) 112.sp else 84.sp, lineHeight = if (text.length <= 4) 112.sp else 88.sp, fontWeight = FontWeight.Black, letterSpacing = (-3).sp), color = Hive.colors.text, maxLines = 1, modifier = modifier.padding(top = 2.dp))
@Composable private fun Title(text: String, big: Boolean = false, modifier: Modifier = Modifier) = Text(text, style = HiveText.heroTitle.copy(fontSize = if (big) 40.sp else 32.sp, lineHeight = if (big) 44.sp else 36.sp, fontWeight = if (big) FontWeight.Black else FontWeight.Bold), color = Hive.colors.text, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = modifier.padding(top = 6.dp))
@Composable private fun Sub(text: String, modifier: Modifier = Modifier) = Text(text, style = HiveText.body.copy(fontSize = 17.sp, lineHeight = 23.sp), color = Hive.colors.textDim, modifier = modifier.padding(top = 10.dp))

/** A line rising into place as its slide arrives, [step] lines after the first (a light stagger). */
private fun Modifier.rise(enter: Float, step: Int): Modifier = graphicsLayer {
    val t = ((enter - step * 0.08f) / (1f - step * 0.08f)).coerceIn(0f, 1.2f)
    alpha = t.coerceIn(0f, 1f)
    translationY = (1f - t) * 28.dp.toPx()
}

/** A cover landing: from a little smaller and tilted, settling with the spring's overshoot. */
private fun Modifier.land(enter: Float, tilt: Float): Modifier = graphicsLayer {
    val k = 0.82f + 0.18f * enter
    scaleX = k; scaleY = k
    rotationZ = tilt * (1f - enter)
    alpha = enter.coerceIn(0f, 1f)
}

/** "That's 1 day, 4 hours" for a year's listening, or nothing under a day. */
private fun dayLine(ms: Long): String {
    val h = ms / 3_600_000
    return if (h < 24) "Song after song, all year." else "That's ${countOf((h / 24).toInt(), "day")} and ${countOf((h % 24).toInt(), "hour")} of nonstop music."
}

/** How often the top track came round: "every 8 days" over the year so far. */
private fun daysBetween(w: Wrap, plays: Int): String {
    val now = LocalDate.now()
    val days = if (w.year == now.year) now.dayOfYear else java.time.Year.of(w.year).length()
    val every = (days / plays.coerceAtLeast(1)).coerceAtLeast(1)
    return if (every == 1) "Daily" else "$every days"
}

/** The year's top albums fanned out like records on a table, landing one after another. */
@Composable
private fun CoverFan(covers: List<Any>, enter: Float, modifier: Modifier = Modifier) {
    if (covers.isEmpty()) return
    // The top album in the middle, the next two tucked behind it to the left and right.
    val angles = listOf(-3f, -13f, 12f).take(covers.size)
    val shifts = listOf(0, -66, 66).take(covers.size)
    Box(modifier.size(220.dp, 190.dp), contentAlignment = Alignment.Center) {
        // Back ones first, the top album last and on top.
        covers.indices.reversed().forEach { i ->
            val step = covers.size - 1 - i
            val t = ((enter - step * 0.12f) / (1f - step * 0.12f)).coerceIn(0f, 1.15f)
            Artwork(covers[i], Modifier.size(if (i == 0) 168.dp else 140.dp).graphicsLayer {
                translationX = shifts[i].dp.toPx() * t
                translationY = (1f - t) * 40.dp.toPx()
                rotationZ = angles[i] * t
                alpha = t.coerceIn(0f, 1f)
            }, HiveShape.art, Icons.Rounded.LibraryMusic, elevation = if (i == 0) 30.dp else 16.dp)
        }
    }
}

private class Tile(val label: String, val name: String?, val art: Any?, val round: Boolean, val onClick: () -> Unit)

/** A tile of the closing poster: the picture, then what it is and its name. */
@Composable
private fun PosterTile(t: Tile, modifier: Modifier) {
    val c = Hive.colors
    Column(modifier.clip(RoundedCornerShape(20.dp)).background(c.text.copy(alpha = 0.07f)).clickable(onClick = t.onClick).padding(12.dp)) {
        if (t.art != null) Artwork(t.art, Modifier.fillMaxWidth().aspectRatio(1f), if (t.round) CircleShape else HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 10.dp)
        else Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(HiveShape.art).background(androidx.compose.ui.graphics.Brush.linearGradient(listOf(c.accent, c.accent.copy(alpha = 0.35f)))), contentAlignment = Alignment.Center) {
            Text(t.name?.take(1)?.uppercase() ?: "♪", style = HiveText.heroTitle.copy(fontSize = 54.sp, fontWeight = FontWeight.Black), color = readableOn(c.accent))
        }
        Text(t.label, style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 10.dp))
        Text(t.name ?: "—", style = HiveText.rowStrong.copy(fontSize = 16.sp, fontWeight = FontWeight.Bold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * The Wrap's backdrop: each slide's cover, blurred to its colours, at full strength on its slide and
 * fading into its neighbour's with the swipe (read while drawing, so a swipe doesn't recompose).
 */
@Composable
private fun WrapBackdrop(pager: androidx.compose.foundation.pager.PagerState, arts: List<Any?>) {
    val c = Hive.colors
    Box(Modifier.fillMaxSize()) {
        arts.filterNotNull().distinct().forEach { model ->
            val pages = arts.indices.filter { arts[it] == model }
            Artwork(model, Modifier.fillMaxSize().graphicsLayer {
                val at = pager.currentPage + pager.currentPageOffsetFraction
                val d = pages.minOf { kotlin.math.abs(it - at) }
                alpha = 0.7f * (1f - d).coerceIn(0f, 1f)
                scaleX = 1.4f; scaleY = 1.4f
            }.blur(70.dp), androidx.compose.ui.graphics.RectangleShape, Icons.Rounded.LibraryMusic)
        }
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(0f to c.bg.copy(alpha = 0.35f), 0.55f to c.bg.copy(alpha = 0.6f), 1f to c.bg.copy(alpha = 0.92f))))
    }
}

/** Numbers without boxes: each large, its word under it, two to a row. */
@Composable
private fun Stats(items: List<Pair<String, String>>, modifier: Modifier = Modifier) {
    val c = Hive.colors
    Column(modifier.fillMaxWidth().padding(top = 26.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
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
private fun Summary(label: String, name: String?, art: Any?, shape: androidx.compose.ui.graphics.Shape, onClick: (() -> Unit)? = null) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().clip(HiveShape.thumb).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        if (art != null) Artwork(art, Modifier.size(52.dp), shape, Icons.Rounded.LibraryMusic)
        else Box(Modifier.size(52.dp).clip(HiveShape.thumb).background(c.accent.copy(alpha = 0.22f)), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.LibraryMusic, null, tint = c.accent, modifier = Modifier.size(22.dp)) }
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Text(label, style = HiveText.small, color = c.textDim)
            Text(name ?: "—", style = HiveText.rowStrong.copy(fontSize = 18.sp, lineHeight = 22.sp, fontWeight = FontWeight.Bold), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun Rank(n: Int, a: Wrap.Ranked, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val c = Hive.colors
    val first = n == 1
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("$n", style = HiveText.heroTitle.copy(fontSize = 26.sp, fontWeight = FontWeight.Black), color = if (first) c.accent else c.textDim, modifier = Modifier.width(34.dp))
        Artwork(art(a), Modifier.size(if (first) 76.dp else 60.dp), HiveShape.thumb, Icons.Rounded.LibraryMusic, elevation = if (first) 16.dp else 0.dp)
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(a.name, style = HiveText.rowStrong.copy(fontSize = if (first) 19.sp else 16.sp, fontWeight = FontWeight.Bold), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(listOf(a.sub, countOf(a.plays, "play")).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun Months(totals: List<Long>, enter: Float = 1f, onMonth: (Int) -> Unit) {
    val c = Hive.colors
    val max = (totals.maxOrNull() ?: 0).coerceAtLeast(1)
    Row(Modifier.fillMaxWidth().height(220.dp).padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Bottom) {
        totals.forEachIndexed { i, t ->
            // Each month opens what you played in it.
            Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(6.dp)).clickable(enabled = t > 0, onClickLabel = "See this month") { onMonth(i + 1) }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
                val grow = ((enter - i * 0.04f) / (1f - i * 0.04f)).coerceIn(0f, 1.1f)
                Box(Modifier.fillMaxWidth().fillMaxHeight(((t.toFloat() / max).coerceAtLeast(0.015f) * 0.86f * grow).coerceIn(0.001f, 0.95f)).clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp, bottomStart = 2.dp, bottomEnd = 2.dp)).background(if (t == max) c.accent else c.text.copy(alpha = 0.22f)))
                Text(java.time.Month.of(i + 1).getDisplayName(TextStyle.NARROW, Locale.getDefault()), style = HiveText.small, color = if (t == max) c.accent else c.textDim, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

/**
 * One month of the Wrap: its listening time (as the Wrap counts it), what you played most that month,
 * then every song you played, day by day or most played first, from the plays on this phone (the
 * PC's included, for songs the phone has). Everything scrolls; a song, album or artist opens its page.
 */
@Composable
private fun MonthSheet(vm: MainViewModel, w: Wrap, month: Int, onOpenAlbum: (Long) -> Unit, onOpenArtist: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Hive.colors
    val loaded by produceState<Pair<Wrap, List<PlayRow>>?>(null, w.year, month) { value = vm.wrapMonth(w.year, month) }
    val photos by vm.artistPhotos.collectAsStateWithLifecycle()
    var byDay by rememberSaveable { mutableStateOf(true) }
    val name = java.time.Month.of(month).getDisplayName(TextStyle.FULL, Locale.getDefault())
    val zone = remember { ZoneId.systemDefault() }
    val x = loaded?.first
    val rows = loaded?.second.orEmpty()
    val days = remember(rows) { rows.groupBy { Instant.ofEpochMilli(it.playedAt).atZone(zone).toLocalDate() }.toSortedMap().toList() }
    val mostPlayed = remember(rows) { rows.groupBy { it.trackId }.values.map { g -> g[0] to g.size }.sortedWith(compareByDescending<Pair<PlayRow, Int>> { it.second }.thenBy { it.first.title.lowercase() }) }
    val open = { r: PlayRow -> r.albumId.takeIf { it > 0 }?.let(onOpenAlbum); Unit }
    val time = remember { DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT) }
    val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.86f).dp
    HiveDialog(onDismiss, Modifier.heightIn(max = maxHeight), wide = true, spacing = 6.dp) {
        LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("$name ${w.year}", style = HiveText.heroTitle.copy(fontSize = 30.sp, lineHeight = 34.sp, fontWeight = FontWeight.Black), color = c.text)
                    val listened = w.months.getOrNull(month - 1) ?: 0
                    Text(listOfNotNull(hours(listened).takeIf { listened > 0 }, x?.plays?.takeIf { it > 0 }?.let { countOf(it, "play") }).joinToString(" · ").ifBlank { "No listening counted" },
                        style = HiveText.body, color = c.textDim)
                    when {
                        x == null -> Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.accent) }
                        x.plays == 0 -> Text("None of this month's songs are on this phone, so there's nothing more to show.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 8.dp))
                        else -> {
                            x.topTrack?.let { t ->
                                Spacer(Modifier.height(8.dp))
                                Summary("Top track · ${countOf(t.plays, "play")}", t.name, art(t), HiveShape.thumb, onClick = t.albumId.takeIf { it > 0 }?.let { id -> { onOpenAlbum(id) } })
                            }
                            x.topArtists.firstOrNull()?.let { a -> Summary("Top artist · ${countOf(a.plays, "play")}", a.name, artistArt(x, a, photos, null), CircleShape, onClick = { onOpenArtist(a.name) }) }
                            if (x.topAlbums.isNotEmpty()) {
                                Text("Top albums", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 10.dp))
                                x.topAlbums.take(3).forEachIndexed { i, a -> Rank(i + 1, a, onClick = a.albumId.takeIf { it > 0 }?.let { id -> { onOpenAlbum(id) } }) }
                            }
                            x.biggestDay?.let { (d, ms) -> Text("Biggest day: ${d.format(DateTimeFormatter.ofPattern("EEEE, MMM d"))}, ${hours(ms)}", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 8.dp)) }
                        }
                    }
                }
            }
            if (rows.isNotEmpty()) {
                item {
                    Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Everything you played", style = HiveText.rowStrong.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = c.text)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            HivePill("By day", active = byDay) { byDay = true }
                            HivePill("Most played", active = !byDay) { byDay = false }
                        }
                    }
                }
                if (byDay) for ((day, plays) in days) {
                    item {
                        Text("${day.format(DateTimeFormatter.ofPattern("EEEE, MMM d"))} · ${hours(plays.sumOf { it.listenedMs })}", style = HiveText.small.copy(fontWeight = FontWeight.Bold), color = c.accent, modifier = Modifier.padding(top = 10.dp))
                    }
                    items(plays) { r ->
                        PlayedSong(r, Instant.ofEpochMilli(r.playedAt).atZone(zone).format(time)) { open(r) }
                    }
                } else items(mostPlayed, key = { "t${it.first.trackId}" }) { (r, n) ->
                    PlayedSong(r, countOf(n, "play")) { open(r) }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) { HiveButton("Done", primary = true) { onDismiss() } }
    }
}

/** A song in a Wrap month's list: its cover, title and artist, and when (or how often) it played. */
@Composable
private fun PlayedSong(r: PlayRow, note: String, onClick: () -> Unit) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().clip(HiveShape.thumb).clickable(enabled = r.albumId > 0, onClick = onClick).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Artwork(art(r.albumId), Modifier.size(44.dp), HiveShape.thumb, Icons.Rounded.LibraryMusic)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(r.title, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(r.artist, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(note, style = HiveText.small, color = c.textDim)
    }
}
