package com.local.hive.mobile.playback

import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.Track
import kotlinx.coroutines.flow.first

/**
 * Hive's library for Android Auto and other media browsers: Favorites,
 * Playlists, Albums, Artists and Recently Added, down to songs. A song is
 * listed as "<list>|<track id>" so choosing it plays the whole list from there.
 */
class LibraryBrowser(private val dao: LibraryDao) {
    fun root(): MediaItem = folder(ROOT, "Hive")

    suspend fun children(parent: String): List<MediaItem> = when {
        parent == ROOT -> listOf(
            folder(FAVORITES, "Favorites"), folder(PLAYLISTS, "Playlists"), folder(ALBUMS, "Albums"),
            folder(ARTISTS, "Artists"), folder(RECENT, "Recently Added"),
        )
        parent == PLAYLISTS -> dao.playlists().first().map { folder("playlist:${it.id}", it.name, "${it.trackCount} songs") }
        parent == ALBUMS -> dao.albums().first().sortedBy { it.album.lowercase() }.map { folder("album:${it.albumId}", it.album.ifBlank { "Unknown album" }, it.artist, MediaMetadata.MEDIA_TYPE_ALBUM) }
        parent == ARTISTS -> dao.artists().first().sortedBy { it.artist.lowercase() }.map { folder("artist:${it.artist}", it.artist, "${it.trackCount} songs", MediaMetadata.MEDIA_TYPE_ARTIST) }
        else -> songs(parent).map { song(parent, it) }
    }

    /** The songs in a list, in its order. */
    suspend fun songs(list: String): List<Track> = when {
        list == FAVORITES -> dao.lovedTracks().first()
        list == RECENT -> dao.recentlyAdded(100).first()
        list.startsWith("album:") -> list.removePrefix("album:").toLongOrNull()?.let { dao.albumTracks(it).first() }.orEmpty()
        list.startsWith("artist:") -> dao.artistTracks(list.removePrefix("artist:")).first()
        list.startsWith("playlist:") -> list.removePrefix("playlist:").toLongOrNull()?.let { id -> dao.playlistRows(id).first().mapNotNull { it.track } }.orEmpty()
        else -> emptyList()
    }

    /** What a browser asked to play, as a queue and where to start. */
    suspend fun resolve(items: List<MediaItem>): Pair<List<MediaItem>, Int> {
        if (items.size == 1 && '|' in items[0].mediaId) {
            val (list, id) = items[0].mediaId.split('|', limit = 2)
            val tracks = songs(list)
            return tracks.map { it.toMediaItem() } to tracks.indexOfFirst { it.id.toString() == id }.coerceAtLeast(0)
        }
        // Items without an address (from a browser or the assistant) are looked up by id.
        val ids = items.filter { it.localConfiguration == null }.mapNotNull { it.mediaId.substringAfter('|').toLongOrNull() }
        val byId = if (ids.isEmpty()) emptyMap() else dao.tracks(ids).associateBy { it.id }
        return items.mapNotNull { item -> if (item.localConfiguration != null) item else item.mediaId.substringAfter('|').toLongOrNull()?.let { byId[it] }?.toMediaItem() } to 0
    }

    /** Songs matching a voice or typed search. */
    suspend fun search(query: String): List<MediaItem> = if (query.isBlank()) emptyList() else dao.search("%${query.trim()}%").take(50).map { it.toMediaItem() }

    private fun song(list: String, t: Track): MediaItem = t.toMediaItem().buildUpon().setMediaId("$list|${t.id}").build()

    private fun folder(id: String, title: String, subtitle: String = "", type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED) = MediaItem.Builder()
        .setMediaId(id)
        .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setSubtitle(subtitle.ifBlank { null }).setIsBrowsable(true).setIsPlayable(false).setMediaType(type).build())
        .build()

    companion object {
        const val ROOT = "root"
        const val FAVORITES = "favorites"
        const val PLAYLISTS = "playlists"
        const val ALBUMS = "albums"
        const val ARTISTS = "artists"
        const val RECENT = "recent"
    }
}
