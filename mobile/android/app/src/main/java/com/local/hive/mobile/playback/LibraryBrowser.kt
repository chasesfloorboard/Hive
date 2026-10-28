package com.local.hive.mobile.playback

import android.content.Context
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.Track
import kotlinx.coroutines.flow.first
import kotlin.random.Random

/**
 * Hive's library for Android Auto and other media browsers, laid out for a
 * car: four tabs (Home, Albums, Artists, Playlists), covers on everything,
 * albums and playlists as a grid of covers, songs as lists.
 *
 * Home has Shuffle all, Recently played, Favorites, Most played, Recently
 * added and Auto DJ mixes grown from the most-played artists. A song is
 * listed as "<list>|<track id>" so choosing it plays the whole list from there.
 */
class LibraryBrowser(private val context: Context, private val dao: LibraryDao) {
    fun root(): MediaItem = folder(ROOT, "Hive")

    /** The root's defaults: folders as grids of covers, songs as lists. */
    fun rootExtras(): Bundle = Bundle().apply {
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }

    suspend fun children(parent: String): List<MediaItem> = when {
        // The car shows the root's folders as tabs (up to four).
        parent == ROOT -> listOf(
            folder(HOME, "Home", children = LIST),
            folder(ALBUMS, "Albums", children = GRID),
            folder(ARTISTS, "Artists", children = LIST),
            folder(PLAYLISTS, "Playlists", children = GRID),
        )
        parent == HOME -> home()
        parent == PLAYLISTS -> dao.playlists().first().map { folder("playlist:${it.id}", it.name, "${it.trackCount} songs", art = it.coverAlbumId, single = GRID) }
        parent == ALBUMS -> dao.albums().first().sortedBy { it.album.lowercase() }.map {
            folder("album:${it.albumId}", it.album.ifBlank { "Unknown album" }, it.artist, MediaMetadata.MEDIA_TYPE_ALBUM, art = it.albumId, single = GRID, group = letter(it.album))
        }
        parent == ARTISTS -> dao.artists().first().sortedBy { it.artist.lowercase() }.map {
            folder("artist:${it.artist}", it.artist, "${it.albumCount} albums · ${it.trackCount} songs", MediaMetadata.MEDIA_TYPE_ARTIST, art = it.albumId, children = GRID, group = letter(it.artist))
        }
        // An artist: all their songs first, then each album.
        parent.startsWith("artist:") -> {
            val artist = parent.removePrefix("artist:")
            val albums = dao.albums().first().filter { it.artist.equals(artist, ignoreCase = true) }.sortedByDescending { it.year }
            listOf(folder("artistsongs:$artist", "All songs", artist, art = albums.firstOrNull()?.albumId, single = GRID)) +
                albums.map { folder("album:${it.albumId}", it.album.ifBlank { "Unknown album" }, if (it.year > 0) "${it.year}" else it.artist, MediaMetadata.MEDIA_TYPE_ALBUM, art = it.albumId, single = GRID) }
        }
        else -> songs(parent).map { song(parent, it) }
    }

    /** Home: one tap to music, then the lists people come back to. */
    private suspend fun home(): List<MediaItem> {
        val firstAlbum = { tracks: List<Track> -> tracks.firstOrNull()?.albumId }
        val lists = listOf(
            Triple(RECENTLY_PLAYED, "Recently played", firstAlbum(songs(RECENTLY_PLAYED))),
            Triple(FAVORITES, "Favorites", firstAlbum(dao.lovedTracks().first())),
            Triple(MOST_PLAYED, "Most played", firstAlbum(dao.mostPlayed(1).first())),
            Triple(RECENT, "Recently added", firstAlbum(dao.recentlyAdded(1).first())),
        ).map { (id, title, art) -> folder(id, title, art = art, single = GRID, group = "Your music") }
        val mixes = topArtists(3).map { (artist, albumId) -> folder("mix:$artist", "$artist mix", "Auto DJ", art = albumId, single = GRID, group = "Auto DJ") }
        return listOf(playable(SHUFFLE_ALL, "Shuffle all", "Your whole library")) + lists + mixes
    }

    /** The most-played artists, each with one of their albums for a picture. */
    private suspend fun topArtists(n: Int): List<Pair<String, Long>> {
        val plays = dao.playCounts().associate { it.trackId to it.plays }
        val tracks = dao.tracks(plays.keys.toList())
        return tracks.groupBy { it.displayAlbumArtist }
            .filterKeys { it.isNotBlank() && it != "<unknown>" }
            .map { (artist, ts) -> Triple(artist, ts.sumOf { plays[it.id] ?: 0 }, ts.maxBy { plays[it.id] ?: 0 }.albumId) }
            .sortedByDescending { it.second }.take(n).map { it.first to it.third }
    }

    /** The songs in a list, in its order. */
    suspend fun songs(list: String): List<Track> = when {
        list == FAVORITES -> dao.lovedTracks().first()
        list == RECENT -> dao.recentlyAdded(100).first()
        list == MOST_PLAYED -> dao.mostPlayed(100).first()
        list == RECENTLY_PLAYED -> dao.history(100).first().mapNotNull { it.track }
        list == SHUFFLE -> dao.allTracks().shuffled()
        list.startsWith("album:") -> list.removePrefix("album:").toLongOrNull()?.let { dao.albumTracks(it).first() }.orEmpty()
        list.startsWith("artist:") -> dao.artistTracks(list.removePrefix("artist:")).first()
        list.startsWith("artistsongs:") -> dao.artistTracks(list.removePrefix("artistsongs:")).first()
        list.startsWith("playlist:") -> list.removePrefix("playlist:").toLongOrNull()?.let { id -> dao.playlistRows(id).first().mapNotNull { it.track } }.orEmpty()
        list.startsWith("mix:") -> mix(list.removePrefix("mix:"))
        else -> emptyList()
    }

    /** An Auto DJ mix from an artist's most-played songs; the same all day, so what's listed is what plays. */
    private suspend fun mix(artist: String): List<Track> {
        val plays = dao.playCounts().associate { it.trackId to it.plays }
        val seeds = dao.artistTracks(artist).first().sortedByDescending { plays[it.id] ?: 0 }.take(6)
        val loved = dao.loveStates().first().filter { it.loved }.mapTo(HashSet()) { it.trackId }
        val day = System.currentTimeMillis() / 86_400_000L
        return AutoDj.build(seeds, dao.allTracks(), plays, loved, random = Random(artist.hashCode() * 31L + day))
    }

    /** What a browser asked to play, as a queue and where to start. */
    suspend fun resolve(items: List<MediaItem>): Pair<List<MediaItem>, Int> {
        // "Hey Google, play …": a search, not an item.
        items.singleOrNull()?.requestMetadata?.searchQuery?.takeIf { items[0].mediaId.isEmpty() }?.let { query ->
            return voice(query, items[0].requestMetadata.extras).map { it.toMediaItem() } to 0
        }
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

    /** What to play for a spoken request (see [VoiceSearch]); [extras] may name the artist, album, song or genre. */
    suspend fun voice(query: String, extras: Bundle?): List<Track> = VoiceSearch.pick(
        dao.allTracks(), query,
        VoiceSearch.Hint(
            artist = extras?.getString(android.provider.MediaStore.EXTRA_MEDIA_ARTIST).orEmpty(),
            album = extras?.getString(android.provider.MediaStore.EXTRA_MEDIA_ALBUM).orEmpty(),
            title = extras?.getString(android.provider.MediaStore.EXTRA_MEDIA_TITLE).orEmpty(),
            genre = extras?.getString("android.intent.extra.genre").orEmpty(),
        ),
    )

    /** Songs matching a voice or typed search. */
    suspend fun search(query: String): List<MediaItem> = if (query.isBlank()) emptyList() else dao.search("%${query.trim()}%").take(50).map { song(SEARCH, it) }

    private fun song(list: String, t: Track): MediaItem {
        val item = t.toMediaItem()
        return item.buildUpon().setMediaId("$list|${t.id}")
            .setMediaMetadata(item.mediaMetadata.buildUpon().setArtworkUri(CoverProvider.uriFor(context, t.albumId)).build())
            .build()
    }

    /** One tap plays it (Shuffle all). */
    private fun playable(id: String, title: String, subtitle: String) = MediaItem.Builder()
        .setMediaId(id)
        .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setSubtitle(subtitle).setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST).build())
        .build()

    private fun folder(
        id: String, title: String, subtitle: String = "", type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED,
        art: Long? = null, children: Int? = null, single: Int? = null, group: String? = null,
    ) = MediaItem.Builder()
        .setMediaId(id)
        .setMediaMetadata(
            MediaMetadata.Builder().setTitle(title).setSubtitle(subtitle.ifBlank { null }).setIsBrowsable(true).setIsPlayable(false).setMediaType(type)
                .setArtworkUri(art?.let { CoverProvider.uriFor(context, it) })
                .setExtras(Bundle().apply {
                    // How this folder's contents are shown, how it shows itself, and the heading it sits under.
                    children?.let { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, it) }
                    single?.let { putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_SINGLE_ITEM, it) }
                    group?.let { putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, it) }
                })
                .build(),
        )
        .build()

    private fun letter(name: String): String = name.trim().firstOrNull()?.uppercaseChar()?.takeIf { it.isLetter() }?.toString() ?: "#"

    companion object {
        const val ROOT = "root"
        const val HOME = "home"
        const val FAVORITES = "favorites"
        const val PLAYLISTS = "playlists"
        const val ALBUMS = "albums"
        const val ARTISTS = "artists"
        const val RECENT = "recent"
        const val MOST_PLAYED = "mostplayed"
        const val RECENTLY_PLAYED = "recentlyplayed"
        const val SHUFFLE = "shuffle"
        const val SEARCH = "search"
        /** Shuffle all, as one playable item: a song id the shuffle list never matches, so it starts at the top. */
        const val SHUFFLE_ALL = "$SHUFFLE|all"
        private const val GRID = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM
        private const val LIST = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM
    }
}
