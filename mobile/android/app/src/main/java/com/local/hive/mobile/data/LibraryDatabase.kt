package com.local.hive.mobile.data

import android.content.Context
import android.net.Uri
import androidx.room.AutoMigration
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/** One audio file on the phone, as MediaStore describes it. */
@Entity(tableName = "tracks", indices = [Index("albumId"), Index("artist")])
data class Track(
    @PrimaryKey val id: Long,
    val title: String,
    val artist: String,
    val album: String,
    val albumArtist: String,
    val albumId: Long,
    val durationMs: Long,
    val trackNumber: Int,
    val discNumber: Int,
    val year: Int,
    val genre: String,
    val folder: String,
    val fileName: String,
    val dateAdded: Long,
    val sizeBytes: Long,
) {
    val uri: Uri get() = Uri.parse("content://media/external/audio/media/$id")
    val artworkUri: Uri get() = Uri.parse("content://media/external/audio/albumart/$albumId")
    val displayAlbumArtist: String get() = albumArtist.ifBlank { artist }
}

/**
 * Love for a phone track. Kept apart from [Track] so a library rescan never
 * loses it. [changedAt] is when the user made the change on whichever device;
 * [pending] means the PC has not confirmed it yet.
 */
@Entity(tableName = "love")
data class LoveState(
    @PrimaryKey val trackId: Long,
    val loved: Boolean,
    val changedAt: Long,
    val pending: Boolean,
)

/**
 * An album in Favorites, as in Samsung Music: separate from loving its songs.
 * Keyed by name rather than MediaStore's album id so it survives a rescan.
 */
@Entity(tableName = "favorite_albums")
data class FavoriteAlbum(
    @PrimaryKey val key: String,
    val album: String,
    val artist: String,
    val addedAt: Long,
) {
    companion object {
        fun keyOf(album: String, artist: String) = "${artist.trim().lowercase()}\u0000${album.trim().lowercase()}"
    }
}

/** A playlist made on the phone. [source] notes where an imported one came from (Apple Music, Spotify, M3U). */
@Entity(tableName = "playlists")
data class Playlist(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val createdAt: Long,
    val updatedAt: Long,
    val source: String = "",
    val sourceUrl: String = "",
    val imageUrl: String = "",
)

/** One slot in a playlist; a song may appear more than once. */
@Entity(tableName = "playlist_entries", indices = [Index("playlistId"), Index("trackId")])
data class PlaylistEntry(
    @PrimaryKey(autoGenerate = true) val rowId: Long = 0,
    val playlistId: Long,
    val trackId: Long,
    val position: Int,
)

data class PlaylistSummary(
    val id: Long,
    val name: String,
    val updatedAt: Long,
    val source: String,
    val imageUrl: String,
    val trackCount: Int,
    /** The first song's album, for a cover when the playlist has no image. */
    val coverAlbumId: Long?,
)

/** Which Hive (PC) track a phone track is the same song as. */
@Entity(tableName = "pc_match", indices = [Index("pcId")])
data class PcMatch(
    @PrimaryKey val trackId: Long,
    val pcId: String,
)

/** A play counted on the phone, kept for Wrapped and play-count sync. */
@Entity(tableName = "plays", indices = [Index("trackId")])
data class Play(
    @PrimaryKey(autoGenerate = true) val rowId: Long = 0,
    val trackId: Long,
    val playedAt: Long,
    val listenedMs: Long,
    val synced: Boolean = false,
)

data class AlbumSummary(
    val albumId: Long,
    val album: String,
    val artist: String,
    val year: Int,
    val trackCount: Int,
)

data class ArtistSummary(
    val artist: String,
    /** One of the artist's albums, for a picture. */
    val albumId: Long,
    val albumCount: Int,
    val trackCount: Int,
)

data class NamedCount(val name: String, val trackCount: Int)

@Dao
interface LibraryDao {
    @Query("SELECT * FROM tracks ORDER BY title COLLATE NOCASE")
    fun tracks(): Flow<List<Track>>

    @Query("SELECT * FROM tracks")
    suspend fun allTracks(): List<Track>

    @Query("SELECT * FROM tracks WHERE id = :id")
    suspend fun track(id: Long): Track?

    @Query("SELECT * FROM tracks WHERE id IN (:ids)")
    suspend fun tracks(ids: List<Long>): List<Track>

    @Query("SELECT * FROM tracks WHERE albumId = :albumId ORDER BY discNumber, trackNumber, title COLLATE NOCASE")
    fun albumTracks(albumId: Long): Flow<List<Track>>

    @Query(
        "SELECT * FROM tracks WHERE artist = :artist OR albumArtist = :artist " +
            "ORDER BY year DESC, album COLLATE NOCASE, discNumber, trackNumber"
    )
    fun artistTracks(artist: String): Flow<List<Track>>

    @Query("SELECT * FROM tracks WHERE genre = :genre ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, trackNumber")
    fun genreTracks(genre: String): Flow<List<Track>>

    @Query("SELECT * FROM tracks WHERE folder = :folder ORDER BY fileName COLLATE NOCASE")
    fun folderTracks(folder: String): Flow<List<Track>>

    @Query("SELECT * FROM tracks ORDER BY dateAdded DESC LIMIT :limit")
    fun recentlyAdded(limit: Int): Flow<List<Track>>

    @Query(
        "SELECT albumId, album, " +
            "CASE WHEN MAX(albumArtist) != '' THEN MAX(albumArtist) ELSE MAX(artist) END AS artist, " +
            "MAX(year) AS year, COUNT(*) AS trackCount " +
            "FROM tracks GROUP BY albumId ORDER BY album COLLATE NOCASE"
    )
    fun albums(): Flow<List<AlbumSummary>>

    @Query(
        "SELECT artist, MAX(albumId) AS albumId, COUNT(DISTINCT albumId) AS albumCount, COUNT(*) AS trackCount " +
            "FROM tracks WHERE artist != '' GROUP BY artist ORDER BY artist COLLATE NOCASE"
    )
    fun artists(): Flow<List<ArtistSummary>>

    @Query("SELECT genre AS name, COUNT(*) AS trackCount FROM tracks WHERE genre != '' GROUP BY genre ORDER BY genre COLLATE NOCASE")
    fun genres(): Flow<List<NamedCount>>

    @Query("SELECT folder AS name, COUNT(*) AS trackCount FROM tracks GROUP BY folder ORDER BY folder COLLATE NOCASE")
    fun folders(): Flow<List<NamedCount>>

    @Query(
        "SELECT * FROM tracks WHERE title LIKE :q OR artist LIKE :q OR album LIKE :q " +
            "ORDER BY title COLLATE NOCASE LIMIT 300"
    )
    suspend fun search(q: String): List<Track>

    @Upsert
    suspend fun upsertTracks(tracks: List<Track>)

    @Query("DELETE FROM tracks WHERE id NOT IN (:keep)")
    suspend fun deleteTracksNotIn(keep: List<Long>)

    @Query("DELETE FROM tracks")
    suspend fun deleteAllTracks()

    /**
     * Makes the table match a fresh MediaStore scan, writing only rows that
     * changed: a rescan of an unchanged 30,000-track library writes nothing.
     */
    @Transaction
    suspend fun replaceLibrary(tracks: List<Track>) {
        if (tracks.isEmpty()) { deleteAllTracks(); return }
        val existing = allTracks().associateBy { it.id }
        // SQLite caps bound parameters, so writes and deletes go in chunks.
        tracks.filter { existing[it.id] != it }.chunked(500).forEach { upsertTracks(it) }
        val keep = tracks.mapTo(HashSet()) { it.id }
        existing.keys.filterNot { it in keep }.chunked(500).forEach { deleteTracks(it) }
    }

    @Query("DELETE FROM tracks WHERE id IN (:ids)")
    suspend fun deleteTracks(ids: List<Long>)

    // ---- love ----

    @Query("SELECT * FROM love")
    fun loveStates(): Flow<List<LoveState>>

    @Query("SELECT * FROM love")
    suspend fun allLove(): List<LoveState>

    @Query("SELECT * FROM love WHERE trackId = :trackId")
    suspend fun love(trackId: Long): LoveState?

    @Query("SELECT * FROM love WHERE pending = 1")
    suspend fun pendingLove(): List<LoveState>

    @Query(
        "SELECT tracks.* FROM tracks JOIN love ON love.trackId = tracks.id " +
            "WHERE love.loved = 1 ORDER BY love.changedAt DESC, tracks.title COLLATE NOCASE"
    )
    fun lovedTracks(): Flow<List<Track>>

    @Upsert
    suspend fun upsertLove(states: List<LoveState>)

    // ---- playlists ----

    @Query(
        "SELECT p.id, p.name, p.updatedAt, p.source, p.imageUrl, COUNT(t.id) AS trackCount, " +
            "(SELECT t2.albumId FROM playlist_entries e2 JOIN tracks t2 ON t2.id = e2.trackId WHERE e2.playlistId = p.id ORDER BY e2.position LIMIT 1) AS coverAlbumId " +
            "FROM playlists p LEFT JOIN playlist_entries e ON e.playlistId = p.id LEFT JOIN tracks t ON t.id = e.trackId " +
            "GROUP BY p.id ORDER BY p.updatedAt DESC"
    )
    fun playlists(): Flow<List<PlaylistSummary>>

    @Query("SELECT * FROM playlists WHERE id = :id")
    fun playlist(id: Long): Flow<Playlist?>

    /** A playlist's songs in order; entries for songs no longer on the phone are skipped. */
    @Query("SELECT t.* FROM playlist_entries e JOIN tracks t ON t.id = e.trackId WHERE e.playlistId = :id ORDER BY e.position")
    fun playlistTracks(id: Long): Flow<List<Track>>

    @Query("SELECT e.* FROM playlist_entries e JOIN tracks t ON t.id = e.trackId WHERE e.playlistId = :id ORDER BY e.position")
    suspend fun playlistEntries(id: Long): List<PlaylistEntry>

    @Query("SELECT COALESCE(MAX(position), -1) FROM playlist_entries WHERE playlistId = :id")
    suspend fun lastPosition(id: Long): Int

    @androidx.room.Insert
    suspend fun insertPlaylist(playlist: Playlist): Long

    @Upsert
    suspend fun upsertEntries(entries: List<PlaylistEntry>)

    @Query("UPDATE playlists SET name = :name, updatedAt = :at WHERE id = :id")
    suspend fun renamePlaylist(id: Long, name: String, at: Long)

    @Query("UPDATE playlists SET updatedAt = :at WHERE id = :id")
    suspend fun touchPlaylist(id: Long, at: Long)

    @Query("DELETE FROM playlists WHERE id = :id")
    suspend fun deletePlaylistRow(id: Long)

    @Query("DELETE FROM playlist_entries WHERE playlistId = :id")
    suspend fun clearPlaylist(id: Long)

    @Transaction
    suspend fun deletePlaylist(id: Long) { clearPlaylist(id); deletePlaylistRow(id) }

    @Transaction
    suspend fun addToPlaylist(id: Long, trackIds: List<Long>, at: Long) {
        val start = lastPosition(id) + 1
        upsertEntries(trackIds.mapIndexed { i, t -> PlaylistEntry(playlistId = id, trackId = t, position = start + i) })
        touchPlaylist(id, at)
    }

    /** Rewrites the playlist in the given order (moves and removals). */
    @Transaction
    suspend fun setPlaylistOrder(id: Long, trackIds: List<Long>, at: Long) {
        clearPlaylist(id)
        upsertEntries(trackIds.mapIndexed { i, t -> PlaylistEntry(playlistId = id, trackId = t, position = i) })
        touchPlaylist(id, at)
    }

    @Transaction
    suspend fun createPlaylist(playlist: Playlist, trackIds: List<Long>): Long {
        val id = insertPlaylist(playlist)
        upsertEntries(trackIds.mapIndexed { i, t -> PlaylistEntry(playlistId = id, trackId = t, position = i) })
        return id
    }

    // ---- favorite albums ----

    @Query("SELECT * FROM favorite_albums ORDER BY addedAt DESC")
    fun favoriteAlbums(): Flow<List<FavoriteAlbum>>

    @Upsert
    suspend fun upsertFavoriteAlbum(album: FavoriteAlbum)

    @Query("DELETE FROM favorite_albums WHERE `key` = :key")
    suspend fun deleteFavoriteAlbum(key: String)

    // ---- PC matching ----

    @Query("SELECT * FROM pc_match")
    suspend fun allMatches(): List<PcMatch>

    @Query("DELETE FROM pc_match")
    suspend fun clearMatches()

    @Upsert
    suspend fun upsertMatches(matches: List<PcMatch>)

    @Transaction
    suspend fun replaceMatches(matches: List<PcMatch>) {
        clearMatches()
        matches.chunked(500).forEach { upsertMatches(it) }
    }

    // ---- plays ----

    @Upsert
    suspend fun insertPlay(play: Play)

    @Query(
        "SELECT tracks.* FROM tracks JOIN (SELECT trackId, COUNT(*) AS c, MAX(playedAt) AS lastPlayed FROM plays GROUP BY trackId) p " +
            "ON p.trackId = tracks.id ORDER BY p.c DESC, p.lastPlayed DESC LIMIT :limit"
    )
    fun mostPlayed(limit: Int): Flow<List<Track>>

    @Query(
        "SELECT tracks.* FROM tracks JOIN (SELECT trackId, MAX(playedAt) AS lastPlayed FROM plays GROUP BY trackId) p " +
            "ON p.trackId = tracks.id ORDER BY p.lastPlayed DESC LIMIT :limit"
    )
    fun recentlyPlayed(limit: Int): Flow<List<Track>>
}

@Database(
    entities = [Track::class, LoveState::class, PcMatch::class, Play::class, FavoriteAlbum::class, Playlist::class, PlaylistEntry::class],
    version = 3,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2), AutoMigration(from = 2, to = 3)],
)
abstract class LibraryDatabase : RoomDatabase() {
    abstract fun dao(): LibraryDao

    companion object {
        fun open(context: Context): LibraryDatabase =
            Room.databaseBuilder(context, LibraryDatabase::class.java, "hive-library.db").build()
    }
}
