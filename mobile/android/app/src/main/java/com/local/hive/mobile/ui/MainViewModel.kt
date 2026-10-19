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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
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
    val libraryLoaded: StateFlow<Boolean> = dao.tracks().map { true }.state(false)

    val tracks = dao.tracks().map { list -> list.sortedWith(compareBy(LibrarySort.collator) { LibrarySort.key(it.title) }) }.state(emptyList())
    val favorites = dao.lovedTracks().state(emptyList())
    val lovedIds: StateFlow<Set<Long>> = dao.loveStates().map { list -> list.filter { it.loved }.mapTo(HashSet()) { it.trackId } }.state(emptySet())
    val favoriteAlbumKeys: StateFlow<Set<String>> = dao.favoriteAlbums().map { list -> list.mapTo(HashSet()) { it.key } }.state(emptySet())
    val albums: StateFlow<List<AlbumSummary>> = dao.albums().map { list -> list.sortedWith(compareBy(LibrarySort.collator) { LibrarySort.key(it.album) }) }.state(emptyList())
    /** Favorite albums that are on this phone, newest first. */
    val favoriteAlbums: StateFlow<List<AlbumSummary>> = combine(albums, dao.favoriteAlbums()) { all, favs ->
        val byKey = all.associateBy { FavoriteAlbum.keyOf(it.album, it.artist) }
        favs.mapNotNull { byKey[it.key] }
    }.state(emptyList())
    val artists: StateFlow<List<ArtistSummary>> = dao.artists().map { list -> list.sortedWith(compareBy(LibrarySort.collator) { LibrarySort.key(it.artist) }) }.state(emptyList())
    val genres: StateFlow<List<NamedCount>> = dao.genres().state(emptyList())
    val folders: StateFlow<List<NamedCount>> = dao.folders().state(emptyList())
    val recentlyAdded = dao.recentlyAdded(AUTO_PLAYLIST_SIZE).state(emptyList())
    val mostPlayed = dao.mostPlayed(AUTO_PLAYLIST_SIZE).state(emptyList())
    val topMostPlayed = dao.mostPlayed(25).state(emptyList())
    val recentlyPlayed = dao.recentlyPlayed(AUTO_PLAYLIST_SIZE).state(emptyList())

    val nowPlaying = app.player.state

    /** Colours of what is playing now, for the aura and the accent. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val aura: StateFlow<AuraColors?> = nowPlaying
        .map { it.artworkUri }
        .distinctUntilChanged()
        .mapLatest { uri -> ArtColors.extract(app, uri?.let(android.net.Uri::parse)) }
        .state(null)

    suspend fun albumColors(albumId: Long): AuraColors? =
        ArtColors.extract(app, android.net.Uri.parse("content://media/external/audio/albumart/$albumId"))
    val link = app.sync.status
    val colors = app.themes.colors

    val scanning = app.scanning

    fun albumTracks(albumId: Long) = dao.albumTracks(albumId)
    fun artistTracks(artist: String) = dao.artistTracks(artist)
    fun genreTracks(genre: String) = dao.genreTracks(genre)
    fun folderTracks(folder: String) = dao.folderTracks(folder)
    suspend fun search(query: String): List<Track> = if (query.isBlank()) emptyList() else dao.search("%${query.trim()}%")
    suspend fun tracksById(ids: List<Long>): List<Track> = dao.tracks(ids).associateBy { it.id }.let { map -> ids.mapNotNull { map[it] } }

    // ---- playback ----

    fun play(tracks: List<Track>, index: Int = 0) = app.player.play(tracks, index)
    fun shuffle(tracks: List<Track>) = app.player.play(tracks, shuffle = true)
    fun playNext(tracks: List<Track>) = app.player.playNext(tracks)
    fun addToQueue(tracks: List<Track>) = app.player.addToQueue(tracks)
    val player get() = app.player

    // ---- love ----

    fun setLoved(tracks: List<Track>, loved: Boolean) = viewModelScope.launch { app.sync.setLoved(tracks.map { it.id }, loved) }
    /** Album Favorites stay on this phone and never change the songs' Love. */
    fun toggleFavoriteAlbum(album: String, artist: String) = viewModelScope.launch {
        val key = FavoriteAlbum.keyOf(album, artist)
        if (key in favoriteAlbumKeys.value) dao.deleteFavoriteAlbum(key)
        else dao.upsertFavoriteAlbum(FavoriteAlbum(key, album, artist, System.currentTimeMillis()))
    }
    // ---- playlists ----

    val playlists: StateFlow<List<PlaylistSummary>> = dao.playlists().state(emptyList())
    fun playlist(id: Long) = dao.playlist(id)
    fun playlistRows(id: Long) = dao.playlistRows(id)

    /** Creates a playlist (optionally with songs) and reports its id. */
    fun createPlaylist(name: String, tracks: List<Track> = emptyList(), source: String = "", sourceUrl: String = "", imageUrl: String = "", onCreated: (Long) -> Unit = {}) =
        viewModelScope.launch {
            val now = System.currentTimeMillis()
            val id = dao.createPlaylist(Playlist(name = name.trim().ifBlank { "New playlist" }, createdAt = now, updatedAt = now, source = source, sourceUrl = sourceUrl, imageUrl = imageUrl), tracks.map { it.id })
            onCreated(id)
        }
    fun addToPlaylist(id: Long, tracks: List<Track>) = viewModelScope.launch { dao.addToPlaylist(id, tracks.map { it.id }, System.currentTimeMillis()) }
    fun renamePlaylist(id: Long, name: String) = viewModelScope.launch { if (name.isNotBlank()) dao.renamePlaylist(id, name.trim(), System.currentTimeMillis()) }
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
    /** Hive on the PC, while reachable; with it, songs the phone lacks play in full. */
    val pcStreams = app.sync.streams
    val fullSongs = app.sync.streams.map { it?.songs == true }.state(false)

    /** A streamed song plays in full through the PC when it can, else its preview. */
    private fun streamUri(s: StreamTrack): String? = pcStreams.value?.takeIf { it.songs }?.songUrl(s) ?: s.previewUrl.ifBlank { null }
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

    val sleep = app.player.sleep
    fun setSleepTimer(minutes: Int) = app.player.setSleepTimer(minutes)
    fun sleepAtEndOfSong() = app.player.sleepAtEndOfSong()
    fun cancelSleepTimer() = app.player.cancelSleepTimer()
    fun toggleLoved(trackId: Long) = viewModelScope.launch { app.sync.setLoved(listOf(trackId), trackId !in lovedIds.value) }

    // ---- library ----

    fun rescan() = app.requestRescan(delayMs = 0)

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

    fun unpair() = viewModelScope.launch { app.sync.unpair() }
    fun syncNow() = viewModelScope.launch { app.sync.syncNow() }

    // ---- theme ----

    fun applyThemeCss(css: String) = app.themes.apply(css)
    fun resetTheme() = app.themes.reset()

    companion object {
        const val AUTO_PLAYLIST_SIZE = 100
    }
}
