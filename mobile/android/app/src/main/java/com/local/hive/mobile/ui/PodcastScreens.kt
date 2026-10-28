package com.local.hive.mobile.ui

import android.text.format.DateUtils
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Podcasts
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.stream.Episode
import com.local.hive.mobile.stream.Feed
import com.local.hive.mobile.stream.Podcast
import com.local.hive.mobile.stream.PodcastStore
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import java.text.SimpleDateFormat
import java.util.Locale

/** Hive's podcasts: the shows you follow, and search (or a pasted feed URL). */
@Composable
fun PodcastsScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = Hive.colors
    val subs by vm.podcastSubscriptions.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var submitted by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Podcast>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(submitted) {
        results = null; error = null
        if (submitted.isNotBlank()) runCatching { vm.podcasts.search(submitted) }.onSuccess { results = it }.onFailure { error = it.message ?: "Couldn't search podcasts." }
    }
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp)) {
                    HiveLabel("Browse")
                    Text("Podcasts", style = HiveText.viewTitle, color = c.text)
                    Text("Search Apple's podcast directory, or paste a show's RSS feed.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                }
            }
            item { SearchField(query, { query = it }, "Search podcasts, or paste a feed URL", onSubmit = { submitted = query.trim() }, onClear = { query = ""; submitted = "" }) }
            if (submitted.isBlank()) {
                item { YearHeading("Your podcasts") }
                if (subs.isEmpty()) item { EmptyState("No podcasts yet", "Search for a show and follow it to keep it here.") }
                else item { PodcastGrid(subs, onOpen) }
            } else when {
                error != null -> item { Text(error.orEmpty(), style = HiveText.body, color = c.textDim, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(28.dp)) }
                results == null -> item { Busy("Searching podcasts…") }
                results!!.isEmpty() -> item { EmptyState("No shows found", "Try another name, or paste the show's feed URL.") }
                else -> { item { YearHeading("Shows") }; item { PodcastGrid(results!!, onOpen) } }
            }
        }
    }
}

@Composable
private fun PodcastGrid(shows: List<Podcast>, onOpen: (String) -> Unit) {
    Column {
        shows.chunked(2).forEach { row ->
            CoverRow(row) { p, m -> CoverCard(p.image.ifBlank { null }, p.title, p.author, m, androidx.compose.material.icons.Icons.AutoMirrored.Rounded.QueueMusic) { onOpen(p.feedUrl) } }
        }
    }
}

/** A show: its art over Follow and Play latest, then its episodes with how far you got. */
@Composable
fun PodcastShowScreen(vm: MainViewModel, feedUrl: String, bottomPadding: Dp, onBack: () -> Unit) {
    val c = Hive.colors
    val subs by vm.podcastSubscriptions.collectAsStateWithLifecycle()
    val progress by vm.podcastProgress.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    var feed by remember(feedUrl) { mutableStateOf<Feed?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    var showAll by remember { mutableStateOf(false) }
    LaunchedEffect(feedUrl, attempt) { error = null; runCatching { vm.podcasts.feed(feedUrl) }.onSuccess { feed = it }.onFailure { error = it.message ?: "Couldn't open this podcast." } }
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    val veil by list.pageVeil()
    val f = feed
    val following = subs.any { it.feedUrl == feedUrl }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(null)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            when {
                error != null -> item {
                    Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 90.dp, start = 28.dp, end = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(error.orEmpty(), style = HiveText.body, color = c.textDim, textAlign = TextAlign.Center)
                        HivePill("Try again", active = false) { attempt++ }
                    }
                }
                f == null -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Busy("Loading the show…") } }
                else -> {
                    item {
                        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Artwork(f.podcast.image.ifBlank { null }, Modifier.size(200.dp), HiveShape.art, Icons.Rounded.Podcasts, elevation = 30.dp)
                            HiveLabel("Podcast", Modifier.padding(top = 20.dp))
                            Text(f.podcast.title, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                            Text(listOf(f.podcast.author, countOf(f.episodes.size, "episode")).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 6.dp))
                            if (f.description.isNotBlank()) Text(f.description, style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, maxLines = if (showAll) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(top = 10.dp).clickable { showAll = !showAll })
                            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                HivePill(if (following) "Following" else "Follow", active = following) { vm.togglePodcast(f.podcast) }
                                if (f.episodes.isNotEmpty()) AccentPlayButton(false, { vm.playEpisodes(f.episodes, 0) }, size = 52.dp)
                            }
                        }
                    }
                    item { PanelTop() }
                    itemsIndexed(f.episodes, key = { i, e -> "$i:${e.id}" }) { i, e ->
                        PanelSlice { EpisodeRow(e, progress[e.mediaId], now.mediaId == e.mediaId, now.isPlaying, { vm.markEpisode(e, it) }) { vm.playEpisodes(f.episodes, i) } }
                    }
                    item { PanelBottom() }
                }
            }
        }
    }, overlay = { PageBar(f?.podcast?.title.orEmpty(), titleAlpha, onBack, veil) })
}

private val rssDate = listOf("EEE, dd MMM yyyy HH:mm:ss Z", "EEE, dd MMM yyyy HH:mm:ss zzz", "EEE, d MMM yyyy HH:mm:ss Z")
private fun published(text: String): String? = rssDate.firstNotNullOfOrNull { p -> runCatching { SimpleDateFormat(p, Locale.US).parse(text.trim())?.time }.getOrNull() }
    ?.let { DateUtils.getRelativeTimeSpanString(it, System.currentTimeMillis(), DateUtils.DAY_IN_MILLIS).toString() }

@Composable
private fun EpisodeRow(e: Episode, progress: Long?, playing: Boolean, isPlaying: Boolean, onMark: (Boolean) -> Unit, onClick: () -> Unit) {
    val c = Hive.colors
    val finished = progress == PodcastStore.FINISHED
    var menu by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 6.dp).clip(HiveShape.row).background(if (playing) c.accentSoft.copy(alpha = 0.22f) else Color.Transparent)
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                HiveLabel(listOfNotNull(published(e.published), e.durationMs.takeIf { it > 0 }?.let { formatLength(it) }).joinToString(" · "))
                Text(e.title, style = HiveText.rowStrong, color = if (playing) c.accent else if (finished) c.textDim else c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
                if (e.description.isNotBlank()) Text(e.description, style = HiveText.small, color = c.textDim, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
            }
            Box {
                Box(Modifier.size(40.dp).clip(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                    if (finished) Icon(Icons.Rounded.CheckCircle, "Played", tint = c.accent, modifier = Modifier.size(20.dp))
                    else if (playing) NowPlayingBars(isPlaying, c.accent)
                    else Icon(Icons.Rounded.MoreHoriz, "More options", tint = c.textDim, modifier = Modifier.size(18.dp))
                }
                HiveMenu(menu, { menu = false }) {
                    HiveMenuItem(if (finished) "Mark as unplayed" else "Mark as played", Icons.Rounded.CheckCircle) { menu = false; onMark(!finished) }
                }
            }
        }
        // How far you got.
        if (progress != null && progress > 0 && e.durationMs > 0) {
            Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(3.dp).clip(HiveShape.pill).background(c.text.copy(alpha = 0.12f))) {
                Box(Modifier.fillMaxWidth((progress.toFloat() / e.durationMs).coerceIn(0f, 1f)).height(3.dp).clip(HiveShape.pill).background(c.accent))
            }
        }
    }
}
