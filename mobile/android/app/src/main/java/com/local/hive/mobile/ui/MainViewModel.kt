package com.local.hive.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.link.DiscoveredHive
import com.local.hive.mobile.link.HiveLinkClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
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
    val albums: StateFlow<List<AlbumSummary>> = dao.albums().map { list -> list.sortedWith(compareBy(LibrarySort.collator) { LibrarySort.key(it.album) }) }.state(emptyList())
    val artists: StateFlow<List<ArtistSummary>> = dao.artists().map { list -> list.sortedWith(compareBy(LibrarySort.collator) { LibrarySort.key(it.artist) }) }.state(emptyList())
    val genres: StateFlow<List<NamedCount>> = dao.genres().state(emptyList())
    val folders: StateFlow<List<NamedCount>> = dao.folders().state(emptyList())
    val recentlyAdded = dao.recentlyAdded(AUTO_PLAYLIST_SIZE).state(emptyList())
    val mostPlayed = dao.mostPlayed(AUTO_PLAYLIST_SIZE).state(emptyList())
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

    suspend fun pair(host: String, port: Int, code: String): String? =
        app.sync.pair(host.trim(), port, code).exceptionOrNull()?.let { it.message ?: "Pairing failed." }

    fun unpair() = viewModelScope.launch { app.sync.unpair() }
    fun syncNow() = viewModelScope.launch { app.sync.syncNow() }

    // ---- theme ----

    fun applyThemeCss(css: String) = app.themes.apply(css)
    fun resetTheme() = app.themes.reset()

    companion object {
        const val AUTO_PLAYLIST_SIZE = 100
    }
}
