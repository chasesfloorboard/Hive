package com.local.hive.mobile.ui

import com.local.hive.mobile.ui.theme.HiveIcons
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Shuffle
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
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import kotlinx.coroutines.async
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
 * anything (artists, songs, albums, playlists), or paste a music.apple.com link.
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
                    Text(if (vm.fullSongs.collectAsStateWithLifecycle().value) "Songs in your library play from your files; the rest play in full from YouTube Music." else "Songs in your library play from your files; the rest play Apple's 30-second previews.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                }
            }
            item {
                SearchField(query, { query = it }, "Search artists, songs, albums, playlists", onSubmit = ::submit, onClear = { query = ""; submitted = "" })
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
                    val v = r.value
                    if (v.playlists.isEmpty() && v.albums.isEmpty() && v.songs.isEmpty() && v.artists.isEmpty()) item { EmptyState("Nothing found", "Try another search, or paste a music.apple.com link.") }
                    if (v.artists.isNotEmpty()) { item { YearHeading("Artists") }; item { ArtistShelf(v.artists, onOpen) } }
                    if (v.songs.isNotEmpty()) { item { YearHeading("Songs") }; item { SongShelf(vm, v.songs.take(10)) } }
                    if (v.albums.isNotEmpty()) { item { YearHeading("Albums") }; item { CardShelf(v.albums.map { it.card() }, onOpen) } }
                    if (v.playlists.isNotEmpty()) { item { YearHeading("Playlists") }; item { CardShelf(v.playlists.map { it.card() }, onOpen) } }
                }
            }
        }
    }
}

/** Artists in round pictures, as Apple Music shows them; each opens the artist's page. */
@Composable
private fun ArtistShelf(artists: List<com.local.hive.mobile.stream.AmArtistCard>, onOpen: (String) -> Unit) {
    val c = Hive.colors
    LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(artists, key = { it.id }) { a ->
            Column(Modifier.width(112.dp).pressable({ onOpen(a.url) }), horizontalAlignment = Alignment.CenterHorizontally) {
                Artwork(a.artwork.ifBlank { null }, Modifier.size(112.dp), CircleShape, Icons.Rounded.Person, elevation = 10.dp)
                Text(a.name, style = HiveText.cardTitle, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
}

/** An Apple Music artist: their picture and name, Play and Shuffle, top songs, then their albums and similar artists. */
@Composable
fun AppleArtistScreen(vm: MainViewModel, url: String, bottomPadding: Dp, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = Hive.colors
    var attempt by remember { mutableStateOf(0) }
    val page by androidx.compose.runtime.produceState<Load<com.local.hive.mobile.stream.AmArtist>>(Load.Loading, url, attempt) {
        value = runCatching { vm.appleMusic.artist(url) }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Apple Music")) })
    }
    vm.tracks.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            when (val p = page) {
                Load.Loading -> item { Busy("Loading the artist…") }
                is Load.Failed -> item { Failed(p.message) { attempt++ } }
                is Load.Ready -> {
                    val a = p.value
                    item {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Artwork(a.artwork.ifBlank { null }, Modifier.fillMaxWidth(0.6f).aspectRatio(1f), CircleShape, Icons.Rounded.Person, elevation = 26.dp)
                            Text(a.name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 18.dp))
                            Text("Artist", style = HiveText.small, color = c.textDim)
                            if (a.songs.isNotEmpty()) Row(Modifier.fillMaxWidth().padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                PillButton("Play", HiveIcons.Play, accent = true, modifier = Modifier.weight(1f)) { vm.playStreams(a.songs.map { it.toStream() }) }
                                PillButton("Shuffle", HiveIcons.Shuffle, accent = false, modifier = Modifier.weight(1f)) { vm.playStreams(a.songs.map { it.toStream() }.shuffled()) }
                            }
                        }
                    }
                    if (a.songs.isNotEmpty()) { item { YearHeading("Top songs") }; item { SongShelf(vm, a.songs.take(10)) } }
                    a.shelves.forEach { shelf ->
                        item(key = "h" + shelf.title) { YearHeading(shelf.title.ifBlank { "More" }) }
                        item(key = "c" + shelf.title) { CardShelf(shelf.cards.map { it.card() }, onOpen) }
                    }
                    if (a.similar.isNotEmpty()) { item { YearHeading("Similar artists") }; item { ArtistShelf(a.similar, onOpen) } }
                }
            }
        }
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
        items(cards, key = { it.url }) { card -> CoverCard(card.artwork.ifBlank { null }, card.name, card.subtitle, Modifier.width(150.dp), Icons.AutoMirrored.Rounded.QueueMusic) { onOpen(card.url) } }
    }
}

/** A playlist or album card from any service. */
data class ServiceCard(val name: String, val subtitle: String, val artwork: String, val url: String)

private fun AmCard.card() = ServiceCard(name, curator, artwork, url.ifBlank { "https://music.apple.com/us/$kind/x/$id" })
private fun SpCard.card() = ServiceCard(name, subtitle, artwork, url)


@Composable
private fun SongShelf(vm: MainViewModel, songs: List<AmSong>) {
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val library by vm.tracks.collectAsStateWithLifecycle()
    var list by remember(songs) { mutableStateOf(songs.map { it.toStream() }) }
    LaunchedEffect(songs) { list = runCatching { vm.appleMusic.withPreviews(songs) }.getOrDefault(songs).map { it.toStream() } }
    val matches = remember(list, library) { list.map { vm.localMatch(it) } }
    PickableList(streams = list)
    Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
        list.forEachIndexed { i, s -> ServiceSongRow(vm, s, matches[i], now.mediaId, now.isPlaying, null) { vm.playStreams(listOf(s)) } }
    }
}

/** A song from Apple Music or Spotify, as any song row, with a badge saying how Hive plays it; picking it offers what streamed songs can do. */
@Composable
private fun ServiceSongRow(vm: MainViewModel, s: StreamTrack, local: Track?, nowMediaId: String?, isPlaying: Boolean, number: Int?, onClick: () -> Unit) {
    val context = LocalContext.current
    val selection = LocalSelection.current
    val toast = LocalToast.current
    var signIn by remember { mutableStateOf(false) }
    val full by vm.fullSongs.collectAsStateWithLifecycle()
    val loved by vm.streamLikes.collectAsStateWithLifecycle()
    if (signIn) SoulseekSignInDialog(onDismiss = { signIn = false }, onSignedIn = { signIn = false; downloadStreams(context, listOf(s), toast) })
    val playable = local != null || full || s.previewUrl.isNotBlank()
    SongRow(
        s.artworkUrl.ifBlank { null } ?: local?.artworkUri, s.title, listOf(s.artist, s.album).filter { it.isNotBlank() }.joinToString(" · "),
        playing = nowMediaId != null && nowMediaId == (local?.id?.toString() ?: s.key), isPlaying = isPlaying, onClick = onClick,
        number = number, trailing = if (number != null && s.durationMs > 0) formatDuration(s.durationMs) else null,
        loved = loved[com.local.hive.mobile.link.StreamLoves.key(s.artist, s.title)]?.loved == true,
        picked = selection != null && s in selection, picking = selection?.active == true, onPick = selection?.let { sel -> { sel.toggle(s) } },
        enabled = playable,
        badge = when {
            local != null -> { { StreamBadge("In library", accent = true) } }
            full -> null
            s.previewUrl.isNotBlank() -> { { StreamBadge("Preview") } }
            else -> { { StreamBadge("${s.source} only") } }
        },
    ) { expanded, dismiss ->
        HiveMenu(expanded, dismiss) {
            HiveMenuItem("Play next", Icons.AutoMirrored.Rounded.PlaylistPlay) { dismiss(); vm.playNextStreams(listOf(s)) }
            HiveMenuItem("Add to queue", Icons.AutoMirrored.Rounded.QueueMusic) { dismiss(); vm.addToQueueStreams(listOf(s)) }
            val liked = loved[com.local.hive.mobile.link.StreamLoves.key(s.artist, s.title)]?.loved == true
            if (local == null) HiveMenuItem(if (liked) "Remove from Favorites" else "Add to Favorites", if (liked) Icons.Rounded.FavoriteBorder else Icons.Rounded.Favorite) { dismiss(); vm.setStreamLiked(s, !liked) }
            if (local == null) HiveMenuItem("Download", Icons.Rounded.Download) {
                dismiss()
                if (com.local.hive.mobile.soulseek.SoulseekSettings(context).configured) downloadStreams(context, listOf(s), toast) else signIn = true
            }
            if (local?.replaceableFromSoulseek(context) == true) HiveMenuItem("Replace with Soulseek copy", Icons.Rounded.Download) { dismiss(); replaceFromSoulseek(context, local, toast) }
            if (local == null) HiveMenuItem("Find in Seeker", Icons.Rounded.Search) {
                dismiss()
                if (!com.local.hive.mobile.stream.Seeker.search(context, com.local.hive.mobile.stream.Seeker.albumQuery(s.artist, s.title))) toast("Seeker isn't installed")
            }
        }
    }
}

/**
 * Downloads streamed songs with Hive's Soulseek client: the songs of one
 * album as one download (one folder to find them in), a song on its own as a
 * song.
 */
fun downloadStreams(context: android.content.Context, songs: List<StreamTrack>, onToast: (String) -> Unit) {
    songs.groupBy { it.artist.substringBefore(",").trim() to it.album }.forEach { (key, group) ->
        val (artist, album) = key
        val tracks = group.map { com.local.hive.mobile.soulseek.SoulseekRequest.Track(it.title, it.durationMs) }
        com.local.hive.mobile.soulseek.SoulseekWorker.enqueue(context,
            com.local.hive.mobile.soulseek.SoulseekRequest(artist, album, tracks, if (group.size == 1 || album.isBlank()) "track" else "album"))
    }
    val where = com.local.hive.mobile.soulseek.SoulseekSettings(context).where(context)
    onToast(if (songs.size == 1) "Downloading ${songs.first().title} to $where" else "Downloading ${songs.size} songs to $where")
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
    val veil by list.pageVeil()
    var importing by remember { mutableStateOf(false) }
    var showAll by remember { mutableStateOf(false) }
    LaunchedEffect(key, attempt) { page = Load.Loading; page = runCatching { load() }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly(service)) }) }
    val collection = (page as? Load.Ready)?.value
    val matches = remember(collection, library) { collection?.songs?.map { vm.localMatch(it) }.orEmpty() }
    PickableList(streams = collection?.songs.orEmpty())

    // Lit by its own cover, as a library album's page is.
    val colors by androidx.compose.runtime.produceState<AuraColors?>(null, collection?.artwork) { value = collection?.artwork?.ifBlank { null }?.let { vm.coverColors(it) } }

    HiveGlassLayers(Modifier.fillMaxSize(), content = {
        AlbumBackdrop(colors)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = bottomPadding + 16.dp)) {
            when (val p = page) {
                Load.Loading -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Busy("Loading…") } }
                is Load.Failed -> item { Box(Modifier.statusBarsPadding().padding(top = 80.dp)) { Failed(p.message) { attempt++ } } }
                is Load.Ready -> {
                    val col = p.value
                    val album = col.kind != "playlist"
                    val inLibrary = matches.count { it != null }
                    item {
                        // Laid out as a library album's page: cover, name, artist, details, Play and Shuffle.
                        Column(Modifier.fillMaxWidth().statusBarsPadding().padding(top = 60.dp, start = 24.dp, end = 24.dp, bottom = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            // A large cover that doesn't arrive (a slow connection) is tried again at a smaller size.
                            Artwork(col.artwork.ifBlank { null }, Modifier.fillMaxWidth(0.72f).aspectRatio(1f), HiveShape.art, Icons.Rounded.LibraryMusic, glow = colors?.primary, elevation = 30.dp,
                                orElse = col.artwork.replace(Regex("""/\d+x\d+bb\.jpg$"""), "/600x600bb.jpg").takeIf { it != col.artwork })
                            Text(col.name, style = HiveText.heroTitle, color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 22.dp))
                            if (col.curator.isNotBlank()) Text(col.curator, style = HiveText.rowStrong, color = c.accent, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                            Text(listOf("${col.source} ${if (album) "album" else "playlist"}", countOf(col.songs.size, "track"), formatLength(col.songs.sumOf { it.durationMs }), if (inLibrary > 0) "$inLibrary in your library" else "")
                                .filter { it.isNotBlank() }.joinToString(" · "), style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                            if (col.description.isNotBlank()) Text(col.description, style = HiveText.small, color = c.textDim, textAlign = TextAlign.Center, maxLines = if (showAll) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(top = 10.dp).clickable { showAll = !showAll })
                            Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                PillButton("Play", HiveIcons.Play, accent = true, modifier = Modifier.weight(1f)) { vm.playStreams(col.songs) }
                                PillButton("Shuffle", HiveIcons.Shuffle, accent = false, modifier = Modifier.weight(1f)) { vm.playStreams(col.songs, shuffle = true) }
                                ControlButton(Icons.AutoMirrored.Rounded.PlaylistAdd, "Import as playlist", {
                                    if (!importing) {
                                        importing = true
                                        vm.importStreams(col.name, col.source, col.url, col.artwork, col.songs) { id, summary -> importing = false; onToast("Imported “${col.name}”: $summary"); onOpenPlaylist(id) }
                                    }
                                }, size = 46.dp)
                                // An album or song: download it with Soulseek.
                                if (album) {
                                    val artist = col.curator.ifBlank { col.songs.firstOrNull()?.artist.orEmpty() }
                                    DownloadButton(artist, col.name, {
                                        com.local.hive.mobile.soulseek.SoulseekRequest(artist, col.name, col.songs.map { com.local.hive.mobile.soulseek.SoulseekRequest.Track(it.title, it.durationMs) }, if (col.kind == "track") "track" else "album")
                                    }, onToast)
                                }
                            }
                            val full by vm.fullSongs.collectAsStateWithLifecycle()
                            Text(if (full) "Songs you don't own play in full from YouTube Music." else "Songs you don't own play as 30-second previews. Turn on full songs in Settings › Streaming.",
                                style = HiveText.small, color = c.textDimmer, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp))
                        }
                    }
                    // An album's tracklist numbered, as in the library; a playlist's songs with their covers.
                    itemsIndexed(col.songs, key = { i, s -> "$i:${s.key}" }) { i, s ->
                        ServiceSongRow(vm, s, matches.getOrNull(i), now.mediaId, now.isPlaying, if (album) i + 1 else null) { vm.playStreams(col.songs, i) }
                    }
                    if (col.more.isNotEmpty()) {
                        item { YearHeading("More like this") }
                        item { CardShelf(col.more, onOpen) }
                    }
                }
            }
        }
    }, overlay = {
        PageBar(collection?.name.orEmpty(), titleAlpha, onBack, veil) {
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
        results = if (submitted.isBlank()) null else { results = Load.Loading; runCatching { vm.searchSpotify(submitted) }.fold({ Load.Ready(it) }, { Load.Failed(it.friendly("Spotify")) }) }
    }
    fun submit() {
        val q = query.trim()
        when {
            q.isEmpty() -> Unit
            Spotify.isSpotifyLink(q) -> { hint = null; onOpen(q) }
            else -> { hint = null; submitted = q }
        }
    }
    Column(Modifier.fillMaxSize()) {
        PageBar("", 0f, onBack)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottomPadding + 24.dp)) {
            item {
                Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 12.dp)) {
                    HiveLabel(if (user.signedIn) "Signed in as ${user.name}" else "Browse")
                    Text("Spotify", style = HiveText.viewTitle, color = c.text)
                    Text(if (vm.fullSongs.collectAsStateWithLifecycle().value) "Songs in your library play from your files; the rest play in full from YouTube Music." else "Songs in your library play from your files; the rest play Spotify's 30-second previews where Spotify shares them.", style = HiveText.small, color = c.textDim, modifier = Modifier.padding(top = 4.dp))
                }
            }
            item { SearchField(query, { query = it; hint = null }, "Search Spotify, or paste a link", onSubmit = ::submit, onClear = { query = ""; submitted = ""; hint = null }) }
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
                            PickableList(streams = streams)
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
    Column {
        cards.chunked(2).forEach { row ->
            CoverRow(row) { card, m -> CoverCard(card.artwork.ifBlank { null }, card.name, card.subtitle, m, Icons.AutoMirrored.Rounded.QueueMusic) { onOpen(card.url) } }
        }
    }
}

/** What the online search found on Apple Music and Spotify; [spotifyNote] says why Spotify isn't in it, when it isn't. */
private data class OnlineResults(val albums: List<ServiceCard>, val songs: List<com.local.hive.mobile.data.StreamTrack>, val spotifyNote: String?)

/**
 * The library search's online side (the button by the search bar): Apple
 * Music and Spotify at once, as albums or tracks. The same album or song on
 * both shows once (Apple Music's); albums open their page, with Download.
 */
@Composable
fun OnlineSearchResults(vm: MainViewModel, query: String, showAlbums: Boolean, onOpen: (String) -> Unit) {
    val c = Hive.colors
    val now by vm.nowPlaying.collectAsStateWithLifecycle()
    val library by vm.tracks.collectAsStateWithLifecycle()
    var found by remember { mutableStateOf<Load<OnlineResults>?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(query, attempt) {
        val q = query.trim()
        if (q.length < 2) { found = null; return@LaunchedEffect }
        kotlinx.coroutines.delay(450) // typing: wait for a pause before asking the services
        found = Load.Loading
        found = kotlinx.coroutines.coroutineScope {
            val apple = async { runCatching { vm.appleMusic.search(q) } }
            val spotify = async { runCatching { vm.searchSpotify(q) } }
            val am = apple.await()
            val sp = spotify.await()
            if (am.isFailure && sp.isFailure) return@coroutineScope Load.Failed(am.exceptionOrNull()!!.friendly("Apple Music"))
            val a = am.getOrNull(); val s = sp.getOrNull()
            val appleSongs = a?.songs?.take(25)?.let { runCatching { vm.appleMusic.withPreviews(it) }.getOrDefault(it) }.orEmpty()
            fun key(artist: String, title: String) = com.local.hive.mobile.link.StreamLoves.key(artist, title)
            // Apple's subtitles start with what the item is ("Album · Artist"): the artist is what's wanted.
            fun artistOf(curator: String) = curator.replace(Regex("""^(Album|Single|EP|Playlist|Song|Music Video|Compilation)\s*·\s*"""), "")
            val albums = (a?.albums.orEmpty().map { ServiceCard(it.name, listOf(artistOf(it.curator), "Apple Music").filter(String::isNotBlank).joinToString(" · "), it.artwork, it.url.ifBlank { "https://music.apple.com/us/${it.kind}/x/${it.id}" }) to key(artistOf(it.curator), it.name) } +
                s?.albums.orEmpty().map { ServiceCard(it.name, listOf(it.subtitle, "Spotify").filter(String::isNotBlank).joinToString(" · "), it.artwork, it.url) to key(it.subtitle, it.name) })
                .distinctBy { it.second }.map { it.first }
            val songs = (appleSongs.map { it.toStream() } + s?.songs.orEmpty().take(25).map { it.toStream() }).distinctBy { key(it.artist, it.title) }
            Load.Ready(OnlineResults(albums, songs, sp.exceptionOrNull()?.let { it.friendly("Spotify") }))
        }
    }
    when (val f = found) {
        null -> EmptyState("Search Apple Music and Spotify", "Albums and songs from both, to play or download.")
        Load.Loading -> Busy("Searching Apple Music and Spotify…")
        is Load.Failed -> Failed(f.message) { attempt++ }
        is Load.Ready -> Column {
            val r = f.value
            if (showAlbums) {
                if (r.albums.isEmpty()) EmptyState("No albums", "Nothing matches “${query.trim()}”.") else CardGrid(r.albums, onOpen)
            } else {
                if (r.songs.isEmpty()) EmptyState("No songs", "Nothing matches “${query.trim()}”.")
                else {
                    val matches = remember(r.songs, library) { r.songs.map { vm.localMatch(it) } }
                    PickableList(streams = r.songs)
                    Column(Modifier.padding(horizontal = 8.dp).hiveGlass(HiveShape.panel).padding(vertical = 6.dp)) {
                        r.songs.forEachIndexed { i, s -> ServiceSongRow(vm, s, matches[i], now.mediaId, now.isPlaying, null) { vm.playStreams(r.songs, i) } }
                    }
                }
            }
            r.spotifyNote?.let { Text("Spotify isn't included: $it", style = HiveText.small, color = c.textDimmer, modifier = Modifier.padding(horizontal = 22.dp, vertical = 12.dp)) }
        }
    }
}

/** Apple's and Spotify's logos (Simple Icons, CC0), in a 24-unit box: they stand for the services searched. */
private const val APPLE_LOGO = "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
private const val SPOTIFY_LOGO = "M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"

/**
 * The online search button's picture, moving: Apple's and Spotify's logos
 * ride an unseen six-chamber revolver whose axis is off the icon past its
 * bottom-left corner, so each turn swings one logo out past the icon's edge
 * and the other in, to rest in that corner. Then the magnifying glass lifts
 * and the logo and the glass meet in the middle, where it grows in the lens;
 * then both go back.
 * Loops; still when the phone's animations are off.
 */
@Composable
fun OnlineSearchIcon(tint: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier, artFraction: Float = 22f / 42f) {
    val context = LocalContext.current
    val logos = remember {
        listOf(APPLE_LOGO, SPOTIFY_LOGO).map { androidx.compose.ui.graphics.vector.PathParser().parsePathString(it).toPath().apply { fillType = androidx.compose.ui.graphics.PathFillType.EvenOdd } }
    }
    var cycle by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    val clock = remember { androidx.compose.animation.core.Animatable(0f) }
    LaunchedEffect(Unit) {
        val still = android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        if (still) return@LaunchedEffect
        while (true) {
            clock.snapTo(0f)
            clock.animateTo(1f, androidx.compose.animation.core.tween(3600, easing = androidx.compose.animation.core.LinearEasing))
            cycle++
        }
    }
    // Fills its round button: the picture sits in the middle ([artFraction] of it) and the
    // logos swing in and out at the button's rim, so no square edge ever shows.
    androidx.compose.foundation.Canvas(modifier) {
        val t = clock.value
        val box = size.minDimension * artFraction
        val u = box / 24f
        val inset = (size.minDimension - box) / 2
        fun o(x: Float, y: Float) = androidx.compose.ui.geometry.Offset(x * u, y * u)
        fun ease(x: Float) = 0.5f - 0.5f * kotlin.math.cos(Math.PI.toFloat() * x.coerceIn(0f, 1f))
        fun seg(a: Float, b: Float) = ease((t - a) / (b - a))
        fun mix(a: Float, b: Float, k: Float) = a + (b - a) * k
        // Lens poses (centre x, y, radius), in the 24-unit box.
        val rest = floatArrayOf(14.6f, 9.0f, 5.0f); val lift = floatArrayOf(15.4f, 6.8f, 5.5f); val focus = floatArrayOf(11.4f, 11.4f, 6.2f)
        fun pose(a: FloatArray, b: FloatArray, k: Float) = FloatArray(3) { mix(a[it], b[it], k) }
        val lens = when {
            t < 0.30f -> rest
            t < 0.42f -> pose(rest, lift, seg(0.30f, 0.42f))
            t < 0.58f -> pose(lift, focus, seg(0.42f, 0.58f))
            t < 0.82f -> focus
            else -> pose(focus, rest, seg(0.82f, 1f))
        }
        val grow = when { t < 0.42f -> 1f; t < 0.58f -> mix(1f, 1.3f, seg(0.42f, 0.58f)); t < 0.82f -> 1.3f; else -> mix(1.3f, 1f, seg(0.82f, 0.94f)) }
        val m = (grow - 1f) / 0.3f

        // The logos on the cylinder: the one in the corner, the rest off the icon. The one in the
        // corner meets the glass in the middle (it travels as it grows), and goes back with it.
        val spotX = 6.6f; val spotY = 17.4f; val axisX = -14f; val axisY = 38f
        val step = 2 * Math.PI.toFloat() / 6
        val turn = (cycle + seg(0f, 0.30f)) * step
        val base = kotlin.math.atan2(spotY - axisY, spotX - axisX)
        val radius = kotlin.math.hypot(spotX - axisX, spotY - axisY)
        clipPath(androidx.compose.ui.graphics.Path().apply { addOval(androidx.compose.ui.geometry.Rect(androidx.compose.ui.geometry.Offset.Zero, size)) }) { translate(inset, inset) {
            for (k in 0 until 6) {
                val ang = base + turn - k * step
                var x = axisX + radius * kotlin.math.cos(ang); var y = axisY + radius * kotlin.math.sin(ang)
                if (kotlin.math.hypot(x - 12f, y - 12f) > 24f / artFraction / 2f + 5f) continue // past the rim
                val looked = k == (cycle + 1) % 6 && t >= 0.30f
                if (looked) { x = mix(x, focus[0], m); y = mix(y, focus[1], m) }
                val s = 7f * (if (looked) grow else 1f) / 24f
                withTransform({ translate((x - 12f * s) * u, (y - 12f * s) * u); scale(s * u, s * u, androidx.compose.ui.geometry.Offset.Zero) }) { drawPath(logos[k % 2], tint) }
            }
            // The magnifying glass.
            drawCircle(tint, lens[2] * u, o(lens[0], lens[1]), style = androidx.compose.ui.graphics.drawscope.Stroke(1.9f * u))
            val hx = lens[0] + lens[2] * 0.72f; val hy = lens[1] + lens[2] * 0.72f
            drawLine(tint, o(hx, hy), o(hx + 4.2f, hy + 4.2f), strokeWidth = 2.5f * u, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        } }
    }
}
