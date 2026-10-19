package com.local.hive.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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

/** A year of listening on this phone, as Hive's Yearly Wrap counts it. */
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
) {
    data class Ranked(val name: String, val sub: String, val plays: Int, val albumId: Long)

    companion object {
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
    val years by produceState<List<Int>?>(null) { value = vm.wrapYears() }
    var year by remember { mutableIntStateOf(java.time.Year.now().value) }
    val wrap by produceState<Wrap?>(null, year) { value = null; value = vm.wrap(year) }
    val pager = rememberPagerState { 7 }
    val layer = rememberGraphicsLayer()
    val scope = rememberCoroutineScope()

    Box(Modifier.fillMaxSize().background(c.bg)) {
        HiveAmbient(c.accent.copy(alpha = 0.35f), c.accentSoft, Modifier.fillMaxSize(), intensity = 1.4f)
        val w = wrap
        when {
            w == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = c.accent) }
            w.plays == 0 -> Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                EmptyState("Not enough listening yet", "Hive builds your Wrap from the songs you play on this phone. Play some music and come back.")
            }
            else -> HorizontalPager(pager, Modifier.fillMaxSize().drawWithContent { layer.record { this@drawWithContent.drawContent() }; drawLayer(layer) }) { page ->
                Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(start = 28.dp, end = 28.dp, top = 76.dp, bottom = bottomPadding + 70.dp), verticalArrangement = Arrangement.Center) {
                    when (page) {
                        0 -> { Eyebrow("Hive · Yearly Wrap"); Big("${w.year}"); Title("Your year in music."); Sub("A look at what you actually listened to on this phone, kept on this phone.") }
                        1 -> { Eyebrow("Listening time"); Big(hours(w.listenedMs)); Sub("spent with music"); Cards(listOf("Plays" to "%,d".format(w.plays), "Artists" to "%,d".format(w.artists), "Albums" to "%,d".format(w.albums), "Longest streak" to countOf(w.longestStreak, "day"))) }
                        2 -> w.topTrack?.let { t ->
                            Artwork(art(t.albumId), Modifier.size(230.dp), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 30.dp)
                            Spacer(Modifier.height(24.dp)); Eyebrow("Your top track"); Title(t.name); Sub(t.sub); Cards(listOf("Played" to countOf(t.plays, "time")))
                        }
                        3 -> w.topArtists.firstOrNull()?.let { a ->
                            Eyebrow("The artist who shaped your year"); Title(a.name); Sub(countOf(a.plays, "play"))
                            Spacer(Modifier.height(22.dp)); Artwork(art(a.albumId), Modifier.size(200.dp), CircleShape, Icons.Rounded.LibraryMusic, elevation = 30.dp)
                        }
                        4 -> { Eyebrow("The records you returned to"); Title("Your top albums."); Spacer(Modifier.height(14.dp)); w.topAlbums.forEachIndexed { i, a -> Rank(i + 1, a) } }
                        5 -> {
                            Eyebrow("When you listened"); Title("Your year, by month.")
                            Months(w.months)
                            Cards(listOf(
                                "Biggest day" to (w.biggestDay?.first?.format(DateTimeFormatter.ofPattern("MMM d")) ?: "—"),
                                "Biggest month" to (w.biggestMonth?.first?.let { java.time.Month.of(it).getDisplayName(TextStyle.FULL, Locale.getDefault()) } ?: "—"),
                            ))
                        }
                        else -> {
                            Eyebrow("That's your year"); Title("The music stays with you.")
                            Cards(listOf("Top artist" to (w.topArtists.firstOrNull()?.name ?: "—"), "Top track" to (w.topTrack?.name ?: "—"), "Top album" to (w.topAlbums.firstOrNull()?.name ?: "—"), "Top genre" to (w.topGenre ?: "—")))
                            Sub("Hive keeps this on your phone. No account is needed.")
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
        // Where you are in the slides.
        if ((wrap?.plays ?: 0) > 0) Row(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = bottomPadding + 24.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            repeat(7) { i -> Box(Modifier.size(if (i == pager.currentPage) 20.dp else 7.dp, 7.dp).clip(HiveShape.pill).background(if (i == pager.currentPage) c.accent else c.text.copy(alpha = 0.25f))) }
        }
    }
}

@Composable private fun Eyebrow(text: String) = Text(text.uppercase(), style = HiveText.label.copy(letterSpacing = 1.6.sp), color = Hive.colors.accent)
@Composable private fun Big(text: String) = Text(text, style = HiveText.heroTitle.copy(fontSize = 64.sp, lineHeight = 68.sp, fontWeight = FontWeight.Black), color = Hive.colors.text, modifier = Modifier.padding(top = 6.dp))
@Composable private fun Title(text: String) = Text(text, style = HiveText.heroTitle.copy(fontSize = 34.sp, lineHeight = 38.sp), color = Hive.colors.text, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
@Composable private fun Sub(text: String) = Text(text, style = HiveText.body.copy(fontSize = 16.sp), color = Hive.colors.textDim, modifier = Modifier.padding(top = 8.dp))

@Composable
private fun Cards(items: List<Pair<String, String>>) {
    val c = Hive.colors
    Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        items.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { (label, value) ->
                    Column(Modifier.weight(1f).hiveGlass(RoundedCornerShape(16.dp)).padding(14.dp)) {
                        HiveLabel(label)
                        Text(value, style = HiveText.year.copy(fontSize = 19.sp), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Rank(n: Int, a: Wrap.Ranked) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("$n", style = HiveText.year.copy(fontSize = 22.sp), color = c.accent, modifier = Modifier.width(30.dp))
        Artwork(art(a.albumId), Modifier.size(52.dp), HiveShape.thumb)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(a.name, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(a.sub, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(countOf(a.plays, "play"), style = HiveText.small, color = c.textDim)
    }
}

@Composable
private fun Months(totals: List<Long>) {
    val c = Hive.colors
    val max = (totals.maxOrNull() ?: 0).coerceAtLeast(1)
    Row(Modifier.fillMaxWidth().height(150.dp).padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.Bottom) {
        totals.forEachIndexed { i, t ->
            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
                Box(Modifier.fillMaxWidth().fillMaxHeight((t.toFloat() / max).coerceAtLeast(0.02f) * 0.85f).clip(RoundedCornerShape(5.dp)).background(if (t == max) c.accent else c.accent.copy(alpha = 0.45f)).border(1.dp, Color.Transparent, RoundedCornerShape(5.dp)))
                Text(java.time.Month.of(i + 1).getDisplayName(TextStyle.NARROW, Locale.getDefault()), style = HiveText.label, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}
