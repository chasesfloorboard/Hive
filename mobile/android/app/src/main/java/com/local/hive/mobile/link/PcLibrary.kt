package com.local.hive.mobile.link

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Hive's library on the PC, as the phone sees it: kept on the phone so it
 * opens at once, refreshed when Hive can be reached (an unchanged library
 * costs a 304). Songs play by streaming from Hive.
 */
class PcLibrary(context: Context, private val client: HiveLinkClient, private val store: LinkStore, private val sync: SyncEngine) {
    private val file = File(context.filesDir, "pc-library.json")
    private val prefs = context.getSharedPreferences("pc-library", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val playlistsFile = File(context.filesDir, "pc-playlists.json")
    private val _playlists = MutableStateFlow<List<PcPlaylist>>(emptyList())
    /** Hive's own playlists, read only. */
    val playlists: StateFlow<List<PcPlaylist>> = _playlists.asStateFlow()
    private val _tracks = MutableStateFlow<List<PcTrack>>(emptyList())
    val tracks: StateFlow<List<PcTrack>> = _tracks.asStateFlow()
    private var loaded = false

    /** The kept copy, read once. */
    suspend fun load() = withContext(Dispatchers.IO) {
        if (loaded) return@withContext
        loaded = true
        if (file.exists()) runCatching { _tracks.value = json.decodeFromString(LibraryResponse.serializer(), file.readText()).tracks }
        if (playlistsFile.exists()) runCatching { _playlists.value = json.decodeFromString(PlaylistsResponse.serializer(), playlistsFile.readText()).playlists }
    }

    /** Asks Hive for its library if it changed; true when Hive was reached. */
    suspend fun refresh(): Boolean = withContext(Dispatchers.IO) {
        load()
        val conn = sync.pcConnection() ?: return@withContext false
        runCatching { client.playlists(conn) }.onSuccess { lists ->
            _playlists.value = lists
            playlistsFile.writeText(json.encodeToString(PlaylistsResponse.serializer(), PlaylistsResponse(lists)))
        }
        val fresh = client.libraryIfChanged(conn, prefs.getString("etag", null).takeIf { file.exists() }) ?: return@withContext true
        file.writeText(json.encodeToString(LibraryResponse.serializer(), fresh.second))
        prefs.edit().putString("etag", fresh.first).apply()
        _tracks.value = fresh.second.tracks
        true
    }

    private fun base(): Pair<String, Int>? {
        val p = store.pairing ?: return null
        return (sync.streams.value?.host ?: p.hosts.firstOrNull() ?: return null) to p.port
    }

    fun coverUrl(t: PcTrack): String? = coverFor(t.cover)

    /** A cover from Hive's covers folder, by its file name. */
    fun coverFor(name: String): String? {
        val (host, port) = base() ?: return null
        if (name.isBlank()) return null
        return "http://$host:$port/api/cover?name=$name&t=${android.net.Uri.encode(store.pairing?.token.orEmpty())}"
    }

    /** Where a library song streams from Hive on the PC. */
    fun trackUrl(id: String): String? = base()?.let { (host, port) -> "http://$host:$port/api/stream/track?id=${android.net.Uri.encode(id)}" }

    fun mediaItem(t: PcTrack): MediaItem? {
        val (host, port) = base() ?: return null
        return MediaItem.Builder()
            .setMediaId(MEDIA_PREFIX + t.id)
            .setUri("http://$host:$port/api/stream/track?id=${android.net.Uri.encode(t.id)}")
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.title.ifBlank { t.file })
                    .setArtist(t.artist)
                    .setAlbumTitle(t.album.ifBlank { null })
                    .setAlbumArtist(t.albumArtist.ifBlank { null })
                    .setTrackNumber(t.track.takeIf { it > 0 })
                    .setGenre(t.genre.ifBlank { null })
                    .setArtworkUri(coverUrl(t)?.let(android.net.Uri::parse))
                    .setDurationMs(t.duration.takeIf { it > 0 })
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .build(),
            )
            .build()
    }

    /** Player items for saved queue ids ("pc:<id>"), for playback restore. */
    suspend fun mediaItems(ids: List<String>): Map<String, MediaItem> {
        load()
        val byId = _tracks.value.associateBy { MEDIA_PREFIX + it.id }
        return ids.mapNotNull { id -> byId[id]?.let(::mediaItem)?.let { id to it } }.toMap()
    }

    companion object { const val MEDIA_PREFIX = "pc:" }
}
