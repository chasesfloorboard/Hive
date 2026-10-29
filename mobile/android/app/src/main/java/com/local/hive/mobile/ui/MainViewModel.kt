package com.local.hive.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.FavoriteAlbum
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Playlist
import com.local.hive.mobile.data.PlaylistEntry
import com.local.hive.mobile.data.PlaylistRow
import com.local.hive.mobile.data.PlaylistSummary
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.link.DiscoveredHive
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.link.TrackMatcher
import com.local.hive.mobile.playback.toMediaItem
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.shareIn
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as HiveApp
    private val dao = app.database.dao()

    private fun <T> Flow<T>.state(initial: T): StateFlow<T> = stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), initial)

    /**
     * Sorted the way people read titles: leading punctuation and "The" are
     * ignored, numbers sort naturally, case and accents don't matter.
     */
    /** False until the library has been read once, so empty states don't flash during loading. */
    // One read of the 30,000-row table, shared; sorting runs off the main thread.
    private val trackRows = dao.tracks().shareIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), replay = 1)
    val libraryLoaded: StateFlow<Boolean> = trackRows.map { true }.state(false)

    val tracks = trackRows.map { list -> LibrarySort.sorted(list) { it.title } }.flowOn(Dispatchers.Default).state(emptyList())
    val favorites = dao.lovedTracks().state(emptyList())
    /** When each favorite was favorited, for ordering Favorites with liked streamed songs among them. */
    val favoritedAt: StateFlow<Map<Long, Long>> = dao.loveStates().map { l -> l.filter { it.loved }.associate { it.trackId to it.changedAt } }.state(emptyMap())
    /**
     * Liked Apple Music and Spotify songs (shared with Hive on the PC) that aren't favorite files on this phone,
     * each with when it was liked: Favorites lists them with the rest, and they stream as any streamed song does.
     */
    val streamFavorites: StateFlow<List<Pair<StreamTrack, Long>>> = combine(app.streamLoves.loves, favorites) { likes, files ->
        val have = files.mapTo(HashSet()) { com.local.hive.mobile.link.StreamLoves.key(it.artist, it.title) }
        likes.filter { (k, e) -> e.loved && k !in have }.mapNotNull { (_, e) ->
            val key = when {
                e.path.startsWith("ytm:apple:") -> "am:" + e.path.removePrefix("ytm:apple:")
                e.path.startsWith("ytm:spotify:") -> "sp:" + e.path.removePrefix("ytm:spotify:")
                else -> return@mapNotNull null
            }
            StreamTrack(key, if (key.startsWith("am:")) "Apple Music" else "Spotify", e.title, e.artist, e.album, (e.duration * 1000).toLong(), e.artworkUrl, "", "") to e.at
        }
    }.state(emptyList())
    val lovedIds: StateFlow<Set<Long>> = dao.loveStates().map { list -> list.filter { it.loved }.mapTo(HashSet()) { it.trackId } }.state(emptySet())
    val favoriteAlbumKeys: StateFlow<Set<String>> = dao.favoriteAlbums().map { list -> list.mapTo(HashSet()) { it.key } }.state(emptySet())
    val albums: StateFlow<List<AlbumSummary>> = dao.albums().map { list -> LibrarySort.sorted(list) { it.album } }.flowOn(Dispatchers.Default).state(emptyList())
    /**
     * Favorite albums that are on this phone: the most recently hearted first
     * (hearting one again brings it to the top); albums hearted together, as
     * when they were filled in from liked songs, newest to the library first.
     */
    val favoriteAlbums: StateFlow<List<AlbumSummary>> = combine(albums, dao.favoriteAlbums()) { all, favs ->
        val byKey = all.associateBy { FavoriteAlbum.keyOf(it.album, it.artist) }
        favs.mapNotNull { f -> byKey[f.key]?.let { f.addedAt to it } }
            .sortedWith(compareByDescending<Pair<Long, AlbumSummary>> { it.first }.thenByDescending { it.second.added })
            .map { it.second }.distinctBy { it.albumId }
    }.state(emptyList())
    val artists: StateFlow<List<ArtistSummary>> = dao.artists().map { list -> LibrarySort.sorted(list) { it.artist } }.flowOn(Dispatchers.Default).state(emptyList())
    val genres: StateFlow<List<NamedCount>> = dao.genres().state(emptyList())
    val folders: StateFlow<List<NamedCount>> = dao.folders().state(emptyList())
    val recentlyAdded = dao.recentlyAdded(AUTO_PLAYLIST_SIZE).state(emptyList())
    val mostPlayed = dao.mostPlayed(AUTO_PLAYLIST_SIZE).state(emptyList())
    val topMostPlayed = dao.mostPlayed(25).state(emptyList())
    /** Recently played, library and streamed songs alike (see [com.local.hive.mobile.data.HistoryEntry]). */
    val recentlyPlayed = dao.history(AUTO_PLAYLIST_SIZE).state(emptyList())

    val nowPlaying = app.player.state
    /** The live playing position (see PlayerConnection.position). */
    val position = app.player.position

    /** Colours of what is playing now, for the aura and the accent. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val aura: StateFlow<AuraColors?> = nowPlaying
        .map { it.artworkUri }
        .distinctUntilChanged()
        .mapLatest { uri -> ArtColors.extract(app, uri?.let(android.net.Uri::parse)) }
        .state(null)

    init {
        // The playing cover and those either side of it, decoded at the player's size before a
        // skip, so the big cover is sharp at once instead of a stretched thumbnail first.
        val loader = coil3.SingletonImageLoader.get(app)
        val px = app.resources.displayMetrics.widthPixels.coerceIn(480, 1440)
        viewModelScope.launch {
            nowPlaying.map { s -> listOf(s.queueIndex, s.queueIndex + 1, s.queueIndex - 1).mapNotNull { i -> if (i == s.queueIndex) s.artworkUri else s.queue.getOrNull(i)?.artworkUri } }
                .distinctUntilChanged()
                .collect { uris -> uris.forEach { loader.enqueue(coil3.request.ImageRequest.Builder(app).data(it).size(px, px).listener(onSuccess = { r, ok -> noteLoadedCover(r.data, ok.memoryCacheKey, ok.image.width.toLong() * ok.image.height) }).build()) } }
        }
    }

    /** Colours of a cover by its address (a streamed album's). */
    suspend fun coverColors(url: String): AuraColors? = ArtColors.extract(app, android.net.Uri.parse(url))

    suspend fun albumColors(albumId: Long): AuraColors? =
        ArtColors.extract(app, android.net.Uri.parse("content://media/external/audio/albumart/$albumId"))
    val link = app.sync.status
    val colors = app.themes.colors

    val scanning = app.scanning

    fun albumTracks(albumId: Long) = dao.albumTracks(albumId)
    fun artistTracks(artist: String) = dao.artistTracks(artist)
    fun genreTracks(genre: String) = dao.genreTracks(genre)
    fun folderTracks(folder: String) = dao.folderTracks(folder)
    /** Songs whose title, artist or album hold every word of [query], in any order, ignoring case, accents and punctuation. */
    suspend fun search(query: String): List<Track> {
        val q = LibrarySort.words(query)
        if (q.isEmpty()) return emptyList()
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            val library = tracks.value
            val index = searchIndex?.takeIf { it.first === library }?.second
                ?: library.map { LibrarySort.fold("${it.title}\u0000${it.artist}\u0000${it.album}") }.also { searchIndex = library to it }
            library.indices.filter { LibrarySort.has(index[it], q) }.take(300).map { library[it] }
        }
    }
    private var searchIndex: Pair<List<Track>, List<String>>? = null
    suspend fun playStats(trackId: Long) = dao.playStats(trackId)

    // ---- ratings ----
    val ratings: StateFlow<Map<Long, Float>> = dao.ratings().map { list -> list.associate { it.trackId to it.stars } }.state(emptyMap())
    val topRated = dao.ratedAtLeast(4f).state(emptyList())
    /** Sets a song's stars; 0 clears it. */
    fun rate(trackId: Long, stars: Float) = viewModelScope.launch {
        if (stars <= 0f) dao.clearRating(trackId) else dao.upsertRatings(listOf(com.local.hive.mobile.data.Rating(trackId, stars, System.currentTimeMillis())))
    }
    suspend fun artistImage(name: String) = app.artistImages.lookup(name)

    // ---- Yearly Wrap: Hive's own when paired, so phone and PC show the same ----

    private val wrapCache get() = java.io.File(app.filesDir, "pc-wrap").apply { mkdirs() }

    /** The paired Hive's Wrap for [year]: fresh (after sending this phone's plays) or as last fetched. */
    private suspend fun pcWrapJson(year: Int): String? {
        if (app.linkStore.pairing == null) return null
        val cached = java.io.File(wrapCache, "$year.json")
        val conn = app.sync.pcConnection()
        if (conn != null) {
            app.sync.syncNow() // this phone's newest plays first, so they're in the numbers
            runCatching { linkClient.wrapJson(conn, year) }.getOrNull()?.let { fresh ->
                runCatching { cached.writeText(fresh) }
                return fresh
            }
        }
        return cached.takeIf { it.exists() }?.readText()
    }

    /** Years with a Wrap, newest first: Hive's when paired, else this phone's. */
    suspend fun wrapYears(): List<Int> {
        if (app.linkStore.pairing != null) {
            val cached = java.io.File(wrapCache, "years.txt")
            val pc = app.sync.pcConnection()?.let { conn -> runCatching { linkClient.wrapYears(conn) }.getOrNull() }
                ?.also { runCatching { cached.writeText(it.joinToString(",")) } }
                ?: cached.takeIf { it.exists() }?.readText()?.split(',')?.mapNotNull { it.trim().toIntOrNull() }
            if (!pc.isNullOrEmpty()) return pc
        }
        val first = dao.firstPlay() ?: return listOf(java.time.Year.now().value)
        val from = java.time.Instant.ofEpochMilli(first).atZone(java.time.ZoneId.systemDefault()).year
        return (java.time.Year.now().value downTo from).toList()
    }
    suspend fun wrap(year: Int): Wrap {
        pcWrapJson(year)?.let { text ->
            runCatching { linkClient.parseWrap(text) }.getOrNull()?.let { pc ->
                return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                    Wrap.fromPc(pc, dao.albums().first()) { name -> pcLibrary.coverFor(name) }
                }
            }
        }
        val zone = java.time.ZoneId.systemDefault()
        val from = java.time.LocalDate.of(year, 1, 1).atStartOfDay(zone).toInstant().toEpochMilli()
        val to = java.time.LocalDate.of(year + 1, 1, 1).atStartOfDay(zone).toInstant().toEpochMilli()
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { Wrap.from(year, dao.playsBetween(from, to)) }
    }
    suspend fun lyrics(now: com.local.hive.mobile.playback.NowPlaying) = app.lyrics.find(now.artist, now.title, now.album, now.durationMs)
    suspend fun tracksById(ids: List<Long>): List<Track> = dao.tracks(ids).associateBy { it.id }.let { map -> ids.mapNotNull { map[it] } }

    // ---- playback ----

    fun play(tracks: List<Track>, index: Int = 0) = app.player.play(tracks, index)
    fun shuffle(tracks: List<Track>) = app.player.play(tracks, shuffle = true)
    fun playNext(tracks: List<Track>) = app.player.playNext(tracks)
    fun addToQueue(tracks: List<Track>) = app.player.addToQueue(tracks)
    val player get() = app.player

    /** Auto DJ's queue grown from [seeds] (see [com.local.hive.mobile.playback.AutoDj]). */
    suspend fun autoDj(seeds: List<Track>): List<Track> {
        val plays = dao.playCounts().associate { it.trackId to it.plays }
        val library = tracks.value.ifEmpty { dao.allTracks() }
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { com.local.hive.mobile.playback.AutoDj.build(seeds, library, plays, lovedIds.value) }
    }

    // ---- love ----

    fun setLoved(tracks: List<Track>, loved: Boolean) = viewModelScope.launch { app.sync.setLoved(tracks.map { it.id }, loved) }
    /** Album Favorites stay on this phone and never change the songs' Love. */
    fun toggleFavoriteAlbum(album: String, artist: String) = viewModelScope.launch {
        val key = FavoriteAlbum.keyOf(album, artist)
        // Taken out by hand, an album stays out even though it has liked songs.
        if (key in favoriteAlbumKeys.value) { dao.deleteFavoriteAlbum(key); app.likedAlbums.setDismissed(key, true) }
        else { dao.upsertFavoriteAlbum(FavoriteAlbum(key, album, artist, System.currentTimeMillis())); app.likedAlbums.setDismissed(key, false) }
    }
    // ---- playlists ----

    val playlists: StateFlow<List<PlaylistSummary>> = dao.playlists().state(emptyList())
    fun playlist(id: Long) = dao.playlist(id)
    fun playlistRows(id: Long) = dao.playlistRows(id)


    /** Spotify songs saved without a cover (playlist pages leave them out) get their album's cover, once. */
    fun fillSpotifyCovers(rows: List<com.local.hive.mobile.data.PlaylistRow>) = viewModelScope.launch {
        val bare = rows.mapNotNull { it.stream }.filter { it.key.startsWith("sp:") && it.artworkUrl.isBlank() }
        if (bare.isEmpty()) return@launch
        val covers = runCatching { app.spotify.covers(bare.map { it.key.removePrefix("sp:") }) }.getOrDefault(emptyMap())
        val filled = bare.mapNotNull { s -> covers[s.key.removePrefix("sp:")]?.let { s.copy(artworkUrl = it) } }
        if (filled.isNotEmpty()) dao.upsertStreamTracks(filled)
    }

    /** Creates a playlist (optionally with songs) and reports its id. */
    fun createPlaylist(name: String, tracks: List<Track> = emptyList(), source: String = "", sourceUrl: String = "", imageUrl: String = "", onCreated: (Long) -> Unit = {}) =
        viewModelScope.launch {
            val now = System.currentTimeMillis()
            val id = dao.createPlaylist(Playlist(name = name.trim().ifBlank { "New playlist" }, createdAt = now, updatedAt = now, source = source, sourceUrl = sourceUrl, imageUrl = imageUrl), tracks.map { it.id })
            onCreated(id)
        }
    fun addToPlaylist(id: Long, tracks: List<Track>) = viewModelScope.launch { dao.addToPlaylist(id, tracks.map { it.id }, System.currentTimeMillis()) }
    fun renamePlaylist(id: Long, name: String) = viewModelScope.launch { if (name.isNotBlank()) dao.renamePlaylist(id, name.trim(), System.currentTimeMillis()) }
    /** Imports an M3U as a playlist; reports how many of its songs the phone has. */
    fun importM3u(name: String, text: String, onDone: (Long?, String) -> Unit) = viewModelScope.launch {
        val entries = com.local.hive.mobile.data.M3u.parse(text)
        if (entries.isEmpty()) { onDone(null, "That file has no songs in it."); return@launch }
        val library = dao.allTracks()
        // Built only if some entry has to be matched by its tags.
        val index by lazy { TrackMatcher.Index(library.map { TrackMatcher.Candidate(it.id.toString(), it.title, it.artist, it.albumArtist, it.durationMs) }) }
        val byId by lazy { library.associateBy { it.id.toString() } }
        val found = com.local.hive.mobile.data.M3u.match(entries, library) { e ->
            if (e.title.isBlank()) null else index.match(e.title, e.artist, "", if (e.seconds > 0) e.seconds * 1000L else 0)?.let { byId[it.key] }
        }.filterNotNull()
        if (found.isEmpty()) { onDone(null, "None of its songs are on this phone."); return@launch }
        val now = System.currentTimeMillis()
        val id = dao.createPlaylist(Playlist(name = name.ifBlank { "Imported playlist" }, createdAt = now, updatedAt = now, source = "M3U"), found.map { it.id })
        onDone(id, "Imported ${found.size} of ${entries.size} songs")
    }
    suspend fun m3uFor(id: Long): String = com.local.hive.mobile.data.M3u.write(dao.playlistRows(id).first().mapNotNull { it.track })

    fun deletePlaylist(id: Long) = viewModelScope.launch { dao.deletePlaylist(id) }
    /** Saves a playlist in a new order, or without a song; [entries] is the whole playlist as it should be. */
    fun setPlaylistEntries(id: Long, entries: List<PlaylistEntry>) = viewModelScope.launch { dao.setPlaylistEntries(id, entries, System.currentTimeMillis()) }

    /** Library songs play from the phone; a streamed song plays through the PC or as a preview. Songs with neither are skipped. */
    private fun mediaFor(row: PlaylistRow): MediaItem? =
        row.track?.toMediaItem() ?: row.stream?.let { s -> streamUri(s)?.let { s.toMediaItem(it) } }
    fun playRows(rows: List<PlaylistRow>, index: Int = 0, shuffle: Boolean = false) {
        val items = rows.map(::mediaFor)
        app.player.playMedia(items.filterNotNull(), items.take(index).count { it != null }, shuffle)
    }
    fun playNextRows(rows: List<PlaylistRow>) = app.player.playNextMedia(rows.mapNotNull(::mediaFor))
    fun addToQueueRows(rows: List<PlaylistRow>) = app.player.addToQueueMedia(rows.mapNotNull(::mediaFor))

    // ---- Apple Music and Spotify ----

    val appleMusic get() = app.appleMusic
    val spotify get() = app.spotify
    val spotifyAccount get() = app.spotifyAccount
    val spotifyUser = app.spotifyAccount.user

    /** Spotify search, with this phone's own sign-in (Hive on the PC no longer starts its Spotify app to search). */
    suspend fun searchSpotify(q: String): com.local.hive.mobile.stream.SpotifyAccount.Results {
        if (spotifyUser.value.signedIn) return app.spotifyAccount.search(q)
        throw java.io.IOException("Searching Spotify needs a Spotify sign-in (Settings › Spotify). Spotify links work without one, and Apple Music search finds the same songs.")
    }
    /** Hive on the PC, while reachable; with it, songs the phone lacks play in full. */
    val pcStreams = app.sync.streams
    val youTubeMusic get() = app.youTubeMusic
    /** Whether songs the phone lacks play in full: through the PC, or from YouTube Music directly. */
    val fullSongs = combine(app.sync.streams, app.youTubeMusic.enabled) { pc, yt -> pc?.songs == true || yt }.state(false)

    /** A streamed song plays in full through the PC when it can, else from YouTube Music, else its preview. */
    private fun streamUri(s: StreamTrack): String? = when {
        // A library song of Hive's own, kept in a copied playlist, streams as itself.
        s.key.startsWith("pc:") -> app.pcLibrary.trackUrl(s.key.removePrefix("pc:"))
        pcStreams.value?.songs == true -> pcStreams.value!!.songUrl(s)
        app.youTubeMusic.enabled.value -> com.local.hive.mobile.stream.YouTubeMusic.uriFor(com.local.hive.mobile.stream.WantedSong(s.key, s.title, s.artist, s.album, s.durationMs))
        else -> s.previewUrl.ifBlank { null }
    }
    private var matchIndex: Triple<List<Track>, TrackMatcher.Index, Map<String, Track>>? = null

    /** The library song a streamed song is, when the phone has it. */
    fun localMatch(title: String, artist: String, durationMs: Long): Track? {
        val library = tracks.value
        val index = matchIndex?.takeIf { it.first === library } ?: Triple(
            library,
            TrackMatcher.Index(library.map { TrackMatcher.Candidate(it.id.toString(), it.title, it.artist, it.albumArtist, it.durationMs) }),
            library.associateBy { it.id.toString() },
        ).also { matchIndex = it }
        return index.second.match(title, artist, "", durationMs)?.let { index.third[it.key] }
    }
    fun localMatch(song: StreamTrack) = localMatch(song.title, song.artist, song.durationMs)

    /** Library songs play in full from the phone; the rest play the service's preview, and songs with neither are skipped. */
    private suspend fun streamMedia(songs: List<StreamTrack>): List<MediaItem?> {
        val matched = songs.map { localMatch(it) to it }
        dao.upsertStreamTracks(matched.filter { it.first == null }.map { it.second })
        return matched.map { (local, song) -> local?.toMediaItem() ?: streamUri(song)?.let { song.toMediaItem(it) } }
    }
    fun playStreams(songs: List<StreamTrack>, index: Int = 0, shuffle: Boolean = false) = viewModelScope.launch {
        val items = streamMedia(songs)
        app.player.playMedia(items.filterNotNull(), items.take(index).count { it != null }, shuffle)
    }
    fun playNextStreams(songs: List<StreamTrack>) = viewModelScope.launch { app.player.playNextMedia(streamMedia(songs).filterNotNull()) }
    fun addToQueueStreams(songs: List<StreamTrack>) = viewModelScope.launch { app.player.addToQueueMedia(streamMedia(songs).filterNotNull()) }

    /** Imports a service's playlist or album as a Hive playlist, with library songs where the phone has them. */
    fun importStreams(name: String, source: String, url: String, artwork: String, songs: List<StreamTrack>, onDone: (Long, String) -> Unit) = viewModelScope.launch {
        val matched = songs.map { localMatch(it) to it }
        val streams = matched.filter { it.first == null }.map { it.second }
        val slots = matched.map { (local, song) -> PlaylistEntry(playlistId = 0, trackId = local?.id ?: 0, position = 0, streamKey = if (local == null) song.key else "") }
        val now = System.currentTimeMillis()
        val id = dao.createImportedPlaylist(
            Playlist(name = name.ifBlank { "$source playlist" }, createdAt = now, updatedAt = now, source = source, sourceUrl = url, imageUrl = artwork),
            slots, streams,
        )
        val inLibrary = matched.count { it.first != null }
        val previews = streams.count { it.previewUrl.isNotBlank() }
        onDone(id, listOfNotNull("$inLibrary from your library", previews.takeIf { it > 0 }?.let { "$it previews" }, (streams.size - previews).takeIf { it > 0 }?.let { "$it $source only" }).joinToString(", "))
    }

    val equaliser get() = app.equaliser
    val scrobbler get() = app.scrobbler
    /** The playing song's genre, for the equaliser's "Auto-Select by Genre". */
    val currentGenre = combine(nowPlaying.map { it.trackId }.distinctUntilChanged(), tracks) { id, list -> list.firstOrNull { it.id == id }?.genre.orEmpty() }.distinctUntilChanged().state("")

    // ---- radio ----
    val radio get() = app.radio
    val savedStations = app.radioStore.saved
    fun toggleStation(s: com.local.hive.mobile.stream.Station) = app.radioStore.toggle(s)
    fun playStation(s: com.local.hive.mobile.stream.Station) = app.player.playMedia(listOf(s.toMediaItem()))

    // ---- podcasts ----
    val podcasts get() = app.podcasts
    val podcastSubscriptions = app.podcastStore.subscriptions
    val podcastProgress = app.podcastStore.progress
    fun togglePodcast(p: com.local.hive.mobile.stream.Podcast) = app.podcastStore.toggle(p)
    fun markEpisode(e: com.local.hive.mobile.stream.Episode, played: Boolean) = app.podcastStore.setProgress(e.mediaId, if (played) com.local.hive.mobile.stream.PodcastStore.FINISHED else 0)
    /** Plays an episode, then the older ones after it, as a podcast app does. */
    fun playEpisodes(episodes: List<com.local.hive.mobile.stream.Episode>, index: Int) = app.player.playMedia(episodes.drop(index).map { it.toMediaItem() })

    // ---- Hive on the PC: its library, streamed ----
    val pcLibrary get() = app.pcLibrary
    val pcTracks = app.pcLibrary.tracks
    fun playPc(tracks: List<com.local.hive.mobile.link.PcTrack>, index: Int = 0, shuffle: Boolean = false) {
        val items = tracks.map { app.pcLibrary.mediaItem(it) }
        app.player.playMedia(items.filterNotNull(), items.take(index).count { it != null }, shuffle)
    }
    fun playNextPc(tracks: List<com.local.hive.mobile.link.PcTrack>) = app.player.playNextMedia(tracks.mapNotNull { app.pcLibrary.mediaItem(it) })
    fun addToQueuePc(tracks: List<com.local.hive.mobile.link.PcTrack>) = app.player.addToQueueMedia(tracks.mapNotNull { app.pcLibrary.mediaItem(it) })

    // ---- remote control of Hive on the PC ----
    suspend fun pcRemoteState(): com.local.hive.mobile.link.RemoteState? = app.sync.pcConnection()?.let { linkClient.remoteState(it) }
    fun pcRemote(command: String, positionMs: Long? = null, volume: Double? = null) = viewModelScope.launch {
        runCatching { app.sync.pcConnection()?.let { linkClient.remote(it, command, positionMs, volume) } }
    }

    /** Takes over what the PC is playing: the phone's copy if it has one, else streamed from Hive; then the PC pauses. */
    fun playPcHere(state: com.local.hive.mobile.link.RemoteState, onDone: (String) -> Unit) = viewModelScope.launch {
        val local = dao.trackForPc(state.id)
        // The PC says enough about the song to stream it, even before the PC library has been fetched.
        val item = local?.toMediaItem() ?: app.pcLibrary.mediaItem(
            com.local.hive.mobile.link.PcTrack(id = state.id, title = state.title, artist = state.artist, album = state.album, duration = state.duration, cover = state.cover),
        )
        if (item == null) { onDone("This song can't play on the phone"); return@launch }
        app.player.playMedia(listOf(item), startPositionMs = state.position)
        pcRemote("pause")
        onDone(if (local != null) "Playing your copy here" else "Playing here, streamed from your PC")
    }

    // ---- Hive's playlists from the PC ----
    val pcPlaylists = app.pcLibrary.playlists

    /** A streamed song from a PC playlist, as the phone keeps such songs. */
    fun pcStream(s: com.local.hive.mobile.link.PcPlaylistSong) = StreamTrack(
        key = s.key, source = if (s.key.startsWith("am:")) "Apple Music" else "Spotify", title = s.title, artist = s.artist, album = s.album,
        durationMs = s.duration, artworkUrl = app.pcLibrary.coverFor(s.cover).orEmpty(), previewUrl = "", url = "",
    )

    /** The phone's own copy of a PC playlist song, if it has one. */
    suspend fun localFor(s: com.local.hive.mobile.link.PcPlaylistSong): Track? =
        if (s.kind == "track") dao.trackForPc(s.id) else localMatch(s.title, s.artist, s.duration)

    private suspend fun pcPlaylistMedia(songs: List<com.local.hive.mobile.link.PcPlaylistSong>): List<MediaItem?> {
        val byId = app.pcLibrary.tracks.value.associateBy { it.id }
        return songs.map { s ->
            localFor(s)?.toMediaItem() ?: if (s.kind == "track") byId[s.id]?.let { app.pcLibrary.mediaItem(it) }
            else pcStream(s).let { st -> streamUri(st)?.let { st.toMediaItem(it) } }
        }
    }
    fun playPcPlaylist(songs: List<com.local.hive.mobile.link.PcPlaylistSong>, index: Int = 0, shuffle: Boolean = false) = viewModelScope.launch {
        val items = pcPlaylistMedia(songs)
        app.player.playMedia(items.filterNotNull(), items.take(index).count { it != null }, shuffle)
    }

    /** Copies a PC playlist to the phone: the phone's own copies where it has them, the rest kept as streamed songs. */
    fun copyPcPlaylist(p: com.local.hive.mobile.link.PcPlaylist, onDone: (Long, String) -> Unit) = viewModelScope.launch {
        val byId = app.pcLibrary.tracks.value.associateBy { it.id }
        val slots = mutableListOf<PlaylistEntry>(); val streams = mutableListOf<StreamTrack>(); var local = 0
        for (s in p.songs) {
            val mine = localFor(s)
            when {
                mine != null -> { slots += PlaylistEntry(playlistId = 0, trackId = mine.id, position = 0); local++ }
                s.kind == "stream" -> { val st = pcStream(s); streams += st; slots += PlaylistEntry(playlistId = 0, trackId = 0, position = 0, streamKey = st.key) }
                else -> byId[s.id]?.let { t -> val st = StreamTrack("pc:${t.id}", "Hive", t.title, t.artist, t.album, t.duration, app.pcLibrary.coverUrl(t).orEmpty(), "", ""); streams += st; slots += PlaylistEntry(playlistId = 0, trackId = 0, position = 0, streamKey = st.key) }
            }
        }
        val now = System.currentTimeMillis()
        val id = dao.createImportedPlaylist(Playlist(name = p.name, createdAt = now, updatedAt = now, source = "Hive on your PC"), slots, streams)
        onDone(id, "$local of ${p.songs.size} songs are on this phone; the rest play through Hive on your PC")
    }

    val sleep = app.player.sleep
    fun setSleepTimer(minutes: Int) = app.player.setSleepTimer(minutes)
    fun sleepAtEndOfSong() = app.player.sleepAtEndOfSong()
    fun cancelSleepTimer() = app.player.cancelSleepTimer()
    fun toggleLoved(trackId: Long) = viewModelScope.launch { app.sync.setLoved(listOf(trackId), trackId !in lovedIds.value) }

    /** Likes for streamed songs, by StreamLoves key. */
    val streamLikes = app.streamLoves.loves

    /**
     * The heart for what's playing, the same on the player, the lock screen and
     * the notification: a library song's Love, a streamed song's like (shared
     * with Hive on the PC), or null for radio and podcasts.
     */
    val nowLoved: StateFlow<Boolean?> = combine(app.player.state, lovedIds, streamLikes, app.pcLibrary.lovedIds) { now, loved, likes, pc ->
        if (now.mediaId?.startsWith(com.local.hive.mobile.link.PcLibrary.MEDIA_PREFIX) == true) viewModelScope.launch { app.pcLibrary.load() }
        com.local.hive.mobile.link.heartFor(now.mediaId, now.title, now.artist, loved, likes, pc)
    }.state(null)

    /** Likes a streamed song (shared with Hive on the PC). */
    fun likeStream(s: StreamTrack) = app.sync.setStreamLoved(s.title, s.artist, s.album, s.durationMs, s.artworkUrl, s.key, true)
    fun setStreamLiked(s: StreamTrack, liked: Boolean) = app.sync.setStreamLoved(s.title, s.artist, s.album, s.durationMs, s.artworkUrl, s.key, liked)

    fun toggleNowLoved() {
        val now = player.state.value
        val loved = nowLoved.value ?: return
        val id = now.mediaId?.substringAfterLast('|')?.toLongOrNull()
        if (id != null) toggleLoved(id)
        else app.sync.setStreamLoved(now.title, now.artist, now.album, now.durationMs, now.artworkUri.orEmpty(), now.mediaId ?: return, !loved)
    }

    // ---- library ----

    fun rescan() = app.requestRescan(delayMs = 0)

    /** The whole library in numbers, for Settings › Library. */
    data class LibraryInfo(val songs: Int, val albums: Int, val artists: Int, val lengthMs: Long, val bytes: Long, val formats: List<Pair<String, Int>>, val lossless: Int)
    val libraryInfo: StateFlow<LibraryInfo?> = tracks.map { list ->
        LibraryInfo(
            songs = list.size, albums = list.distinctBy { it.albumId }.size, artists = list.mapTo(HashSet()) { it.displayAlbumArtist.lowercase() }.size,
            lengthMs = list.sumOf { it.durationMs }, bytes = list.sumOf { it.sizeBytes },
            formats = list.groupingBy { it.fileName.substringAfterLast('.', "?").uppercase() }.eachCount().entries.sortedByDescending { it.value }.map { it.key to it.value },
            lossless = list.count { it.fileName.substringAfterLast('.', "").lowercase() in com.local.hive.mobile.data.SmartPlaylist.LOSSLESS },
        )
    }.flowOn(Dispatchers.Default).state(null)

    // ---- editing tags and covers (the caller has Android's permission to change the files) ----

    /**
     * Writes each song's edit (and [cover], for all of them) into its file, then
     * hands the same changes to Hive on the PC (see [com.local.hive.mobile.link.PcEdits]).
     * Reports a line for the toast.
     */
    fun saveEdits(edits: Map<Track, com.local.hive.mobile.data.TagEdit>, cover: ByteArray? = null, onDone: (String) -> Unit) = viewModelScope.launch {
        val wanted = edits.filter { !it.value.isEmpty || cover != null }
        if (wanted.isEmpty()) { onDone("Nothing changed"); return@launch }
        // The playing song is reloaded at its place once its file is rewritten.
        val playing = nowPlaying.value.trackId
        val saved = mutableListOf<Track>()
        var problem: String? = null
        for ((track, edit) in wanted) {
            runCatching { com.local.hive.mobile.data.TagWriter.write(app, track, edit, cover) }
                .onSuccess { saved += track }
                .onFailure { problem = it.message ?: "A song couldn't be changed" }
            edit.lyrics?.let { app.lyrics.saveOwn(track.artist, track.title, it) }
        }
        if (saved.any { it.id == playing }) app.player.reloadCurrent()
        app.pcEdits.addTags(saved.associate { it.id to wanted.getValue(it) }.filterValues { !it.isEmpty })
        if (cover != null) {
            app.pcEdits.addCover(saved.map { it.id }, cover)
            // The old cover is cached (Hive's own copy, Coil's, Android's thumbnails); the new one is
            // read afresh now, and again once Android has re-read the files and remade its thumbnails.
            val albums = saved.map { it.albumId }.distinct()
            refreshCovers(albums, cover)
            viewModelScope.launch { kotlinx.coroutines.delay(4_000); refreshCovers(albums, cover) }
        }
        app.requestRescan(delayMs = 500)
        app.sync.matchAgainNextSync()
        if (app.linkStore.pairing != null) viewModelScope.launch { kotlinx.coroutines.delay(3_000); app.sync.syncNow() }
        onDone(when {
            saved.isEmpty() -> problem ?: "Nothing was changed"
            saved.size < wanted.size -> "Changed ${saved.size} of ${countOf(wanted.size, "song")}. $problem"
            else -> "Saved " + if (saved.size == 1) "“${saved[0].title}”" else countOf(saved.size, "song")
        })
    }

    /** Hive's kept copy of each album's cover becomes [cover] at once (Android's own readers lag behind the file). */
    private fun refreshCovers(albumIds: List<Long>, cover: ByteArray) {
        val dir = java.io.File(app.cacheDir, "embedded-art").apply { mkdirs() }
        albumIds.forEach { runCatching { java.io.File(dir, "$it.img").writeBytes(cover) } }
        // Only pictures in memory: the disk cache holds online covers, which didn't change.
        coil3.SingletonImageLoader.get(app).memoryCache?.clear()
        forgetShownCovers()
    }

    suspend fun track(id: Long) = dao.track(id)
    suspend fun saveOwnLyrics(artist: String, title: String, text: String) = app.lyrics.saveOwn(artist, title, text)

    /** A song's own cover at full size, for saving it to the phone. */
    suspend fun fullCover(track: Track): ByteArray? = com.local.hive.mobile.data.TagWriter.cover(app, track)

    /** Saves a picture into the phone's Pictures/Hive, where the gallery shows it. */
    fun savePicture(bytes: ByteArray, name: String, onDone: (String) -> Unit) = viewModelScope.launch {
        val ok = kotlinx.coroutines.withContext(Dispatchers.IO) {
            runCatching {
                val png = bytes.size > 3 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte()
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name.replace(Regex("""[\\/:*?"<>|]"""), "_").take(80) + if (png) ".png" else ".jpg")
                    put(android.provider.MediaStore.Images.Media.MIME_TYPE, if (png) "image/png" else "image/jpeg")
                    put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Hive")
                }
                val uri = app.contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
                app.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
            }.isSuccess
        }
        onDone(if (ok) "Cover saved to Pictures/Hive" else "Couldn't save the cover")
    }

    /** Downloads a picture (a cover found online). */
    suspend fun download(url: String): ByteArray? = kotlinx.coroutines.withContext(Dispatchers.IO) {
        runCatching { okhttp3.OkHttpClient().newCall(okhttp3.Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null } }.getOrNull()
    }

    /** Albums on Apple Music matching [query], for a cover or Auto-tag. */
    suspend fun findAlbums(query: String): List<com.local.hive.mobile.stream.AmCard> =
        runCatching { app.appleMusic.search(query.trim()).albums }.getOrDefault(emptyList())

    /** An Apple Music album's songs and details, for Auto-tag. */
    suspend fun appleAlbum(url: String) = app.appleMusic.collection(url)

    // ---- smart playlists ----

    val smartPlaylists = app.smartPlaylists.list
    fun saveSmartPlaylist(p: com.local.hive.mobile.data.SmartPlaylist) = app.smartPlaylists.save(p)
    fun deleteSmartPlaylist(id: Long) = app.smartPlaylists.delete(id)

    /** What a smart playlist holds now, kept up to date with the library, ratings, plays and Favorites. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun smartTracks(id: Long): Flow<List<Track>> = combine(smartPlaylists, tracks, ratings, lovedIds) { list, library, stars, loved -> SmartInput(list.firstOrNull { it.id == id }, library, stars, loved) }
        .mapLatest { input ->
            val p = input.playlist ?: return@mapLatest emptyList()
            val plays = dao.playCounts().associate { it.trackId to it.plays }
            kotlinx.coroutines.withContext(Dispatchers.Default) { p.select(input.library, plays, input.ratings, input.loved) }
        }
    private data class SmartInput(val playlist: com.local.hive.mobile.data.SmartPlaylist?, val library: List<Track>, val ratings: Map<Long, Float>, val loved: Set<Long>)

    // ---- playlist extras ----

    /** A copy of a playlist, every slot in order, named "… copy". */
    fun duplicatePlaylist(id: Long, onCreated: (Long) -> Unit) = viewModelScope.launch {
        val p = dao.playlist(id).first() ?: return@launch
        val rows = dao.playlistRows(id).first()
        val now = System.currentTimeMillis()
        val copy = dao.createImportedPlaylist(p.copy(id = 0, name = "${p.name} copy", createdAt = now, updatedAt = now), rows.map { it.entry }, emptyList())
        onCreated(copy)
    }

    /** A photo from the phone as the playlist's picture (copied into Hive's files), or none. */
    fun setPlaylistPhoto(id: Long, photo: android.net.Uri?) = viewModelScope.launch {
        val dir = java.io.File(app.filesDir, "playlist-photos").apply { mkdirs() }
        dir.listFiles { f -> f.name.startsWith("$id-") }?.forEach { it.delete() }
        val url = photo?.let { uri ->
            kotlinx.coroutines.withContext(Dispatchers.IO) {
                runCatching {
                    val f = java.io.File(dir, "$id-${System.currentTimeMillis()}.jpg")
                    app.contentResolver.openInputStream(uri)!!.use { input -> f.outputStream().use { input.copyTo(it) } }
                    android.net.Uri.fromFile(f).toString()
                }.getOrNull()
            }
        }.orEmpty()
        dao.setPlaylistImage(id, url, System.currentTimeMillis())
    }

    // ---- Hive Link ----

    private val _discovered = MutableStateFlow<List<DiscoveredHive>>(emptyList())
    val discovered = _discovered.asStateFlow()
    private val _discovering = MutableStateFlow(false)
    val discovering = _discovering.asStateFlow()
    private val linkClient = HiveLinkClient()

    fun discover() = viewModelScope.launch {
        _discovering.value = true
        try { _discovered.value = linkClient.discover() } finally { _discovering.value = false }
    }

    private val _pairing = MutableStateFlow(false)
    val pairing = _pairing.asStateFlow()
    private val _pairError = MutableStateFlow<String?>(null)
    val pairError = _pairError.asStateFlow()

    /** Pairs in the ViewModel's scope, so the request outlives the pairing card it came from. */
    fun pair(host: String, port: Int, code: String) = viewModelScope.launch {
        _pairing.value = true
        _pairError.value = null
        try {
            _pairError.value = app.sync.pair(host.trim(), port, code).exceptionOrNull()?.let { it.message ?: "Pairing failed." }
        } finally {
            _pairing.value = false
        }
    }

    fun unpair() = viewModelScope.launch { setSongSync(false); app.sync.unpair() }
    fun syncNow() = viewModelScope.launch { app.sync.syncNow() }

    // ---- connect automatically ----

    private val _autoConnect = MutableStateFlow(app.linkStore.autoConnect)
    val autoConnect: StateFlow<Boolean> = _autoConnect.asStateFlow()
    fun setAutoConnect(on: Boolean) {
        app.linkStore.autoConnect = on
        _autoConnect.value = on
        if (on) viewModelScope.launch { app.sync.autoConnect() }
    }

    // ---- song sync ----

    val songSync = app.songSync.state
    /** Songs deleted on one side, waiting for the user's decision (see [DeletionsSheet]). */
    val deletions = app.songSync.deletions
    val songSyncOps get() = app.songSync
    /** Set when the deleted-songs notification is tapped. */
    val openDeletions = MutableStateFlow(false)
    private val _songSyncOn = MutableStateFlow(app.linkStore.songSync)
    val songSyncOn: StateFlow<Boolean> = _songSyncOn.asStateFlow()
    fun checkSongs() = viewModelScope.launch { app.songSync.check() }
    fun setSongSync(on: Boolean) {
        app.linkStore.songSync = on
        _songSyncOn.value = on
        if (on) com.local.hive.mobile.link.SongSync.schedule(app) else com.local.hive.mobile.link.SongSync.cancel(app)
    }

    // ---- theme ----

    val themeName = app.themes.name
    val themes get() = app.themes
    val themePacks get() = app.themes.packs
    fun applyTheme(p: com.local.hive.mobile.ui.theme.ThemePack) = if (p.name == com.local.hive.mobile.ui.theme.ThemeStore.YOUR_THEME) app.themes.reset() else app.themes.apply(p.css, p.name)

    companion object {
        const val AUTO_PLAYLIST_SIZE = 100
    }
}
