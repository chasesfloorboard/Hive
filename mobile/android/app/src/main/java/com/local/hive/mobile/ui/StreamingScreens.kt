package com.local.hive.mobile.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.stream.AmCard
import com.local.hive.mobile.stream.AmCollection
import com.local.hive.mobile.stream.AmSearch
import com.local.hive.mobile.stream.AmShelf
import com.local.hive.mobile.stream.AmSong
import com.local.hive.mobile.stream.AppleMusic
import com.local.hive.mobile.stream.SpCard
import com.local.hive.mobile.stream.SpCollection
import com.local.hive.mobile.stream.Spotify
import com.local.hive.mobile.stream.toStream
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveGlassLayers
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.hiveGlass

/** Loading, a failure, or the page's content. */
private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Failed(val message: String) : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
}

private fun Throwable.friendly(service: String) = when (this) {
    is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException -> "Couldn't reach $service. Check your connection."
    else -> message ?: "Couldn't reach $service."
}

/**
 * Hive's Apple Music page: Apple Music's Browse shelves, then search for
 * playlists and albums, or paste a music.apple.com link.
 */
@Composable
fun AppleMusicScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = Hive.colors
    var query by rememberSaveable { mutableStateOf("") }
    var submitted by rememberSaveable { mutableStateOf("") }
    var browse by remember { mutableStateOf<Load<List<AmShelf>>>(Load.Loading) }
    var results by remember { mutableStateOf<Load<AmSearch>?>(null) }
    var attempt by remember { mutableStateOf(0) }
    vm.tracks.collectAsStateWithLifecycle() // keeps the library index fresh for matching

    LaunchedEffect(attempt) { browse = runCatching { vm.appleMusic.browse() }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Apple Music")) }) }
    LaunchedEffect(submitted, attempt) {
        results = if (submitted.isBlank()) null else {
            results = Load.Loading
            runCatching { vm.appleMusic.search(submitted) }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Apple Music")) })
        }
    }
    fun submit() {
        val q = query.trim()
        if (q.isEmpty()) return
        if (AppleMusic.isAppleMusicLink(q)) onOpen(q) else submitted = q
    }

    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp)) {
                    HiveLabel("Browse")
                    Text("Apple Music", style = HiveText.viewTitle, color = c.text)
                    Text("Songs in your library play from your files; the rest play Apple's 30-second previews.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                }
            }
            item {
                SearchField(query, { query = it }, "Search playlists and albums, or paste a link", onSubmit = ::submit, onClear = { query = ""; submitted = "" })
            }
            when (val r = results) {
                null -> when (val b = browse) {
                    Load.Loading -> item { Busy("Loading Apple Music…") }
                    is Load.Failed -> item { Failed(b.message) { attempt++ } }
                    is Load.Ready -> b.value.forEach { shelf ->
                        item(key = "h" + shelf.title) { YearHeading(shelf.title.ifBlank { "More" }) }
                        if (shelf.cards.isNotEmpty()) item(key = "c" + shelf.title) { CardShelf(shelf.cards.map { it.card() }, onOpen) }
                        else item(key = "s" + shelf.title) { SongShelf(vm, shelf.songs.take(10)) }
                    }
                }
                Load.Loading -> item { Busy("Searching Apple Music…") }
                is Load.Failed -> item { Failed(r.message) { attempt++ } }
                is Load.Ready -> {
                    if (r.value.playlists.isEmpty() && r.value.albums.isEmpty()) item { EmptyState("Nothing found", "Try another search, or paste a music.apple.com link.") }
                    if (r.value.playlists.isNotEmpty()) { item { YearHeading("Playlists") }; item { CardShelf(r.value.playlists.map { it.card() }, onOpen) } }
                    if (r.value.albums.isNotEmpty()) { item { YearHeading("Albums") }; item { CardShelf(r.value.albums.map { it.card() }, onOpen) } }
                }
            }
        }
    }
}

/** Hive's search pill. */
@Composable
fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String, onSubmit: () -> Unit, onClear: () -> Unit) {
    val c = Hive.colors
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    Row(Modifier.padding(horizontal = 14.dp).fillMaxWidth().height(48.dp).hiveGlass(HiveShape.pill).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Search, null, tint = c.textDim, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, style = HiveText.row, color = c.textDimmer, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(value, onChange, singleLine = true, textStyle = HiveText.row.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); onSubmit() }), modifier = Modifier.fillMaxWidth())
        }
        if (value.isNotEmpty()) Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onClear), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Close, "Clear search", tint = c.textDim, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun Busy(label: String) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().padding(28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.accent)
        Spacer(Modifier.width(12.dp))
        Text(label, style = HiveText.small, color = c.textDim)
    }
}

@Composable
private fun Failed(message: String, onRetry: () -> Unit) {
    val c = Hive.colors
    Column(Modifier.fillMaxWidth().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(message, style = HiveText.body, color = c.textDim, textAlign = TextAlign.Center)
        HivePill("Try again", active = false, onClick = onRetry)
    }
}

@Composable
private fun CardShelf(cards: List<ServiceCard>, onOpen: (String) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(cards, key = { it.url }) { card -> StreamCard(card.artwork, card.name, card.subtitle, Modifier.width(150.dp)) { onOpen(card.url) } }
    }
}

/** A playlist or album card from any service. */
data class ServiceCard(val name: String, val subtitle: String, val artwork: String, val url: String)

private fun AmCard.card() = ServiceCard(name, curator, artwork, url.ifBlank { "https://music.apple.com/us/$kind/x/$id" })
private fun SpCard.card() = ServiceCard(name, subtitle, artwork, url)

/** A playlist or album from a streaming service: cover, name, curator. */
@Composable
fun StreamCard(art: String, name: String, subtitle: String, modifier: Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    Column(modifier.pressable(onClick)) {
        Artwork(art.ifBlank { null }, Modifier.fillMaxWidth().aspectRatio(1f), HiveShape.art, Icons.AutoMirrored.Rounded.QueueMusic, elevation = 10.dp)
        Text(name, style = HiveText.cardTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SongShelf(vm: MainViewModel, songs: List<AmSong>) {
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val library by vm.tracks.collectAsStateWithLifecycle()
    var list by remember(songs) { mutableStateOf(songs.map { it.toStream() }) }
    LaunchedEffect(songs) { list = runCatching { vm.appleMusic.withPreviews(songs) }.getOrDefault(songs).map { it.toStream() } }
    val matches = remember(list, library) { list.map { vm.localMatch(it) } }
    Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
        list.forEachIndexed { i, s -> ServiceSongRow(vm, s, matches[i], now.mediaId, now.isPlaying, null) { vm.playStreams(listOf(s)) } }
    }
}

/** A song from Apple Music or Spotify, with a badge saying how Hive plays it. */
@Composable
private fun ServiceSongRow(vm: MainViewModel, s: StreamTrack, local: Track?, nowMediaId: String?, isPlaying: Boolean, number: Int?, onClick: () -> Unit) {
    val c = Hive.colors
    var menu by remember { mutableStateOf(false) }
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    val playable = local != null || full || s.previewUrl.isNotBlank()
    val playing = nowMediaId != null && nowMediaId == (local?.id?.toString() ?: s.key)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 6.dp).height(62.dp).clip(HiveShape.row)
            .background(if (playing) c.accentSoft.copy(alpha = 0.22f) else Color.Transparent)
            .clickable(enabled = playable, onClick = onClick).padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (number != null) Text("$number", style = HiveText.numbers, color = c.textDimmer, textAlign = TextAlign.Center, modifier = Modifier.width(26.dp).padding(end = 4.dp))
        Box(Modifier.size(42.dp)) {
            Artwork(s.artworkUrl.ifBlank { null } ?: local?.artworkUri, Modifier.size(42.dp))
            if (playing) Box(Modifier.size(42.dp).clip(HiveShape.thumb).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) { NowPlayingBars(isPlaying, c.accent) }
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(s.title, style = HiveText.row, color = if (playing) c.accent else if (playable) c.text else c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                when {
                    local != null -> StreamBadge("In library", accent = true)
                    full -> StreamBadge("Via Hive")
                    s.previewUrl.isNotBlank() -> StreamBadge("Preview")
                    else -> StreamBadge("${s.source} only")
                }
                Text(listOf(s.artist, s.album).filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.rowSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (s.durationMs > 0) Text(formatDuration(s.durationMs), style = HiveText.numbers, color = c.textDimmer)
        Box {
            Box(Modifier.size(44.dp).clip(CircleShape).clickable(enabled = playable) { menu = true }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.MoreHoriz, "More options", tint = c.textDim, modifier = Modifier.size(18.dp))
            }
            HiveMenu(menu, { menu = false }) {
                HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { menu = false; vm.playNextStreams(listOf(s)) }
                HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { menu = false; vm.addToQueueStreams(listOf(s)) }
            }
        }
    }
}

/** What a service's playlist or album page shows. */
data class ServicePage(
    val source: String,
    val kind: String,
    val name: String,
    val curator: String,
    val description: String,
    val artwork: String,
    val url: String,
    val songs: List<StreamTrack>,
    val more: List<ServiceCard> = emptyList(),
)

private fun AmCollection.page() = ServicePage("Apple Music", kind, name, curator, description, artwork, url, songs.map { it.toStream() }, more.map { it.card() })
private fun SpCollection.page() = ServicePage("Spotify", kind, name, owner, "", artwork, url, songs.map { it.toStream() })

@Composable
fun AppleCollectionScreen(vm: MainViewModel, url: String, bottomPadding: Dp, onBack: () -> Unit, onOpen: (String) -> Unit, onOpenPlaylist: (Long) -> Unit, onToast: (String) -> Unit) =
    ServiceCollectionScreen(vm, url, "Apple Music", { vm.appleMusic.collection(url).page() }, bottomPadding, onBack, onOpen, onOpenPlaylist, onToast)

const val LIKED_SONGS_URL = "https://open.spotify.com/collection/tracks"

@Composable
fun SpotifyCollectionScreen(vm: MainViewModel, url: String, bottomPadding: Dp, onBack: () -> Unit, onOpenPlaylist: (Long) -> Unit, onToast: (String) -> Unit) =
    ServiceCollectionScreen(vm, url, "Spotify", {
        val signedIn = vm.spotifyUser.value.signedIn
        if (url == LIKED_SONGS_URL) {
            ServicePage("Spotify", "playlist", "Liked Songs", vm.spotifyUser.value.name, "", "", url, vm.spotifyAccount.likedSongs().map { it.toStream() })
        } else runCatching { vm.spotify.collection(url).page() }.getOrElse { failure ->
            // Private playlists aren't on Spotify's public pages; the signed-in API has them (without previews).
            val ref = Spotify.parseLink(url)
            if (signedIn && ref?.first == "playlist") vm.spotifyAccount.playlist(ref.second).page() else throw failure
        }
    }, bottomPadding, onBack, {}, onOpenPlaylist, onToast)

/**
 * A service's playlist or album: its cover over Play / Shuffle / Import, how
 * many of its songs are in the library, then its songs (and "More like this").
 */
@Composable
private fun ServiceCollectionScreen(
    vm: MainViewModel, key: String, service: String, load: suspend () -> ServicePage, bottomPadding: Dp,
    onBack: () -> Unit, onOpen: (String) -> Unit, onOpenPlaylist: (Long) -> Unit, onToast: (String) -> Unit,
) {
    val c = Hive.colors
    val context = LocalContext.current
    var page by remember(key) { mutableStateOf<Load<ServicePage>>(Load.Loading) }
    var attempt by remember { mutableStateOf(0) }
    val library by vm.tracks.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    val titleAlpha by animateFloatAsState(if (list.firstVisibleItemIndex > 0) 1f else 0f, tween(180), label = "title")
    var importing by remember { mutableStateOf(false) }
    var showAll by remember { mutableStateOf(false) }
    LaunchedEffect(key, attempt) { page = Load.Loading; page = runCatching { load() }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly(service)) }) }
    val collection = (page as? Load.Ready)?.value
    val matches = remember(collection, library) { collection?.songs?.map { vm.localMatch(it) }.orEmpty() }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(null)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            when (val p = page) {
                Load.Loading -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Busy("Loading…") } }
                is Load.Failed -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Failed(p.message) { attempt++ } } }
                is Load.Ready -> {
                    val col = p.value
                    val inLibrary = matches.count { it != null }
                    item {
                        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 64.dp, start = 24.dp, end = 24.dp, bottom = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Artwork(col.artwork.ifBlank { null }, Modifier.size(220.dp), HiveShape.art, Icons.Rounded.LibraryMusic, elevation = 30.dp)
                            HiveLabel("${col.source} ${if (col.kind == "album") "album" else if (col.kind == "track") "song" else "playlist"}", Modifier.padding(top = 20.dp))
                            Text(col.name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                            Text(listOf(col.curator, countOf(col.songs.size, "song"), "$inLibrary in your library").filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
                            if (col.description.isNotBlank()) Text(col.description, style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, maxLines = if (showAll) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(top = 10.dp).clickable { showAll = !showAll })
                            Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                ControlButton(Icons.Rounded.Shuffle, "Shuffle", { vm.playStreams(col.songs, shuffle = true) }, size = 46.dp)
                                AccentPlayButton(false, { vm.playStreams(col.songs) }, size = 58.dp)
                                ControlButton(Icons.AutoMirrored.Rounded.PlaylistAdd, "Import as playlist", {
                                    if (!importing) {
                                        importing = true
                                        vm.importStreams(col.name, col.source, col.url, col.artwork, col.songs) { id, summary -> importing = false; onToast("Imported “${col.name}”: $summary"); onOpenPlaylist(id) }
                                    }
                                }, size = 46.dp)
                            }
                            val full by vm.fullSongs.collectAsStateWithLifecycle()
                            Text(if (full) "Songs you don't own play in full from YouTube Music, through Hive on your PC." else "Songs you don't own play as 30-second previews. With Hive on your PC reachable, they play in full.",
                                style = HiveText.small, color = c.textDimmer, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp))
                        }
                    }
                    item { PanelTop() }
                    itemsIndexed(col.songs, key = { i, s -> "$i:${s.key}" }) { i, s ->
                        PanelSlice { ServiceSongRow(vm, s, matches.getOrNull(i), now.mediaId, now.isPlaying, i + 1) { vm.playStreams(col.songs, i) } }
                    }
                    item { PanelBottom() }
                    if (col.more.isNotEmpty()) {
                        item { YearHeading("More like this") }
                        item { CardShelf(col.more, onOpen) }
                    }
                }
            }
        }
    }, overlay = {
        PageBar(collection?.name.orEmpty(), titleAlpha, onBack) {
            if (collection != null) Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(collection.url))) }
            }, contentAlignment = Alignment.Center) {
                Icon(Icons.AutoMirrored.Rounded.OpenInNew, "Open in ${collection.source}", tint = c.text, modifier = Modifier.size(19.dp))
            }
        }
    })
}

/**
 * Hive's Spotify page without an account: Spotify's editorial playlists, and
 * any shared playlist, album or song by its link.
 */
@Composable
fun SpotifyScreen(vm: MainViewModel, bottomPadding: Dp, onBack: () -> Unit, onOpenSettings: () -> Unit, onOpen: (String) -> Unit) {
    val c = Hive.colors
    val user by vm.spotifyUser.collectAsStateWithLifecycle()
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val library by vm.tracks.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    var submitted by rememberSaveable { mutableStateOf("") }
    var hint by remember { mutableStateOf<String?>(null) }
    var picks by remember { mutableStateOf<Load<List<SpCard>>>(Load.Loading) }
    var mine by remember { mutableStateOf<Load<List<SpCard>>?>(null) }
    var results by remember { mutableStateOf<Load<com.local.hive.mobile.stream.SpotifyAccount.Results>?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) { picks = runCatching { vm.spotify.picks() }.fold({ if (it.isEmpty()) Load.Failed("Couldn't load Spotify's playlists.") else Load.Ready(it) }, { Load.Failed(it.friendly("Spotify")) }) }
    LaunchedEffect(user.signedIn, attempt) {
        mine = if (!user.signedIn) null else { mine = Load.Loading; runCatching { vm.spotifyAccount.playlists() }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Spotify")) }) }
    }
    LaunchedEffect(submitted, attempt) {
        results = if (submitted.isBlank() || !user.signedIn) null else { results = Load.Loading; runCatching { vm.spotifyAccount.search(submitted) }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Spotify")) }) }
    }
    fun submit() {
        val q = query.trim()
        when {
            q.isEmpty() -> Unit
            Spotify.isSpotifyLink(q) -> { hint = null; onOpen(q) }
            user.signedIn -> { hint = null; submitted = q }
            else -> hint = "Paste a Spotify link (Share › Copy link), or sign in to Spotify in Settings to search."
        }
    }
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp)) {
                    HiveLabel(if (user.signedIn) "Signed in as ${user.name}" else "Browse")
                    Text("Spotify", style = HiveText.viewTitle, color = c.text)
                    Text("Songs in your library play from your files; the rest play Spotify's 30-second previews where Spotify shares them.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                }
            }
            item { SearchField(query, { query = it; hint = null }, if (user.signedIn) "Search Spotify, or paste a link" else "Paste a Spotify link", onSubmit = ::submit, onClear = { query = ""; submitted = ""; hint = null }) }
            hint?.let { item { Text(it, style = HiveText.small, color = c.textDim, modifier = Modifier.padding(horizontal = 22.dp, vertical = 8.dp)) } }
            when (val r = results) {
                null -> {
                    if (user.signedIn) {
                        item { YearHeading("Your library") }
                        when (val m = mine) {
                            null, Load.Loading -> item { Busy("Loading your playlists…") }
                            is Load.Failed -> item { Failed(m.message) { attempt++ } }
                            is Load.Ready -> item { CardGrid(listOf(ServiceCard("Liked Songs", user.name, "", LIKED_SONGS_URL)) + m.value.map { it.card() }, onOpen) }
                        }
                    } else item {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp).fillMaxWidth().hiveGlass(HiveShape.panel).clickable(onClick = onOpenSettings).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Your Spotify library", style = HiveText.rowStrong, color = c.text)
                                Text("Sign in in Settings to see your playlists and Liked Songs.", style = HiveText.small, color = c.textDim)
                            }
                            Icon(Icons.AutoMirrored.Rounded.OpenInNew, null, tint = c.textDim, modifier = Modifier.size(18.dp))
                        }
                    }
                    item { YearHeading("Spotify playlists") }
                    when (val p = picks) {
                        Load.Loading -> item { Busy("Loading Spotify…") }
                        is Load.Failed -> item { Failed(p.message) { attempt++ } }
                        is Load.Ready -> item { CardGrid(p.value.map { it.card() }, onOpen) }
                    }
                }
                Load.Loading -> item { Busy("Searching Spotify…") }
                is Load.Failed -> item { Failed(r.message) { attempt++ } }
                is Load.Ready -> {
                    val res = r.value
                    if (res.songs.isEmpty() && res.playlists.isEmpty() && res.albums.isEmpty()) item { EmptyState("Nothing found", "Try another search, or paste a Spotify link.") }
                    if (res.songs.isNotEmpty()) {
                        item { YearHeading("Songs") }
                        item {
                            val streams = remember(res) { res.songs.take(10).map { it.toStream() } }
                            val matches = remember(streams, library) { streams.map { vm.localMatch(it) } }
                            Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
                                streams.forEachIndexed { i, s -> ServiceSongRow(vm, s, matches[i], now.mediaId, now.isPlaying, null) { vm.playStreams(streams, i) } }
                            }
                        }
                    }
                    if (res.playlists.isNotEmpty()) { item { YearHeading("Playlists") }; item { CardShelf(res.playlists.map { it.card() }, onOpen) } }
                    if (res.albums.isNotEmpty()) { item { YearHeading("Albums") }; item { CardShelf(res.albums.map { it.card() }, onOpen) } }
                }
            }
        }
    }
}

/** Cards two to a row, as Hive's album grid. */
@Composable
private fun CardGrid(cards: List<ServiceCard>, onOpen: (String) -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        cards.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                row.forEach { card -> StreamCard(card.artwork, card.name, card.subtitle, Modifier.weight(1f)) { onOpen(card.url) } }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}
