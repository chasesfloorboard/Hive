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

/**
 * One slot in a playlist; a song may appear more than once. A slot holds a
 * song on the phone ([trackId]) or, for imports, a song that isn't
 * ([streamKey], with [trackId] 0).
 */
@Entity(tableName = "playlist_entries", indices = [Index("playlistId"), Index("trackId"), Index("streamKey")])
data class PlaylistEntry(
    @PrimaryKey(autoGenerate = true) val rowId: Long = 0,
    val playlistId: Long,
    val trackId: Long,
    val position: Int,
    val streamKey: String = "",
)

/**
 * A song from Apple Music or Spotify that isn't in the library: what Hive
 * knows about it, and its 30-second preview when the service offers one.
 * [key] is "am:<Apple id>" or "sp:<Spotify id>".
 */
@Entity(tableName = "stream_tracks")
data class StreamTrack(
    @PrimaryKey val key: String,
    val source: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val artworkUrl: String,
    val previewUrl: String,
    val url: String,
)

/** A playlist slot with the song it holds; one of [track] and [stream] is set. */
data class PlaylistRow(
    @androidx.room.Embedded val entry: PlaylistEntry,
    @androidx.room.Relation(parentColumn = "trackId", entityColumn = "id") val track: Track?,
    @androidx.room.Relation(parentColumn = "streamKey", entityColumn = "key") val stream: StreamTrack?,
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

/**
 * A song's star rating (0.5 to 5). [fromPc] marks a rating taken from Hive on
 * the PC, which the PC may update; the user's own ratings on the phone stay.
 */
@Entity(tableName = "ratings")
data class Rating(
    @PrimaryKey val trackId: Long,
    val stars: Float,
    val changedAt: Long,
    val fromPc: Boolean = false,
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
    /** A play made in Hive on the PC, brought here so both count the same listening; never sent back. */
    @androidx.room.ColumnInfo(defaultValue = "0") val fromPc: Boolean = false,
)

data class AlbumSummary(
    val albumId: Long,
    val album: String,
    val artist: String,
    val year: Int,
    val trackCount: Int,
    /** When the album's newest song arrived on the phone. */
    val added: Long = 0,
)

data class ArtistSummary(
    val artist: String,
    /** One of the artist's albums, for a picture. */
    val albumId: Long,
    val albumCount: Int,
    val trackCount: Int,
)

data class NamedCount(val name: String, val trackCount: Int)

data class PlayStats(val plays: Int, val lastPlayed: Long?)

/** A play with the song it was, for Yearly Wrap. */
data class PlayRow(val trackId: Long, val playedAt: Long, val listenedMs: Long, val title: String, val artist: String, val album: String, val albumArtist: String, val albumId: Long, val genre: String)

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

    @Query("SELECT * FROM tracks WHERE genre = :genre COLLATE NOCASE ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, trackNumber")
    fun genreTracks(genre: String): Flow<List<Track>>

    @Query("SELECT * FROM tracks WHERE folder = :folder ORDER BY fileName COLLATE NOCASE")
    fun folderTracks(folder: String): Flow<List<Track>>

    @Query("SELECT * FROM tracks ORDER BY dateAdded DESC LIMIT :limit")
    fun recentlyAdded(limit: Int): Flow<List<Track>>

    @Query(
        "SELECT albumId, album, " +
            "CASE WHEN MAX(albumArtist) != '' THEN MAX(albumArtist) ELSE MAX(artist) END AS artist, " +
            "MAX(year) AS year, COUNT(*) AS trackCount, MAX(dateAdded) AS added " +
            "FROM tracks GROUP BY albumId ORDER BY album COLLATE NOCASE"
    )
    fun albums(): Flow<List<AlbumSummary>>

    @Query(
        "SELECT artist, MAX(albumId) AS albumId, COUNT(DISTINCT albumId) AS albumCount, COUNT(*) AS trackCount " +
            "FROM tracks WHERE artist != '' GROUP BY artist ORDER BY artist COLLATE NOCASE"
    )
    fun artists(): Flow<List<ArtistSummary>>

    // "Alternative Dance" and "alternative dance" are one genre; the most used spelling names it.
    @Query("SELECT (SELECT g.genre FROM tracks g WHERE g.genre = t.genre COLLATE NOCASE GROUP BY g.genre ORDER BY COUNT(*) DESC LIMIT 1) AS name, COUNT(*) AS trackCount FROM tracks t WHERE t.genre != '' GROUP BY t.genre COLLATE NOCASE ORDER BY t.genre COLLATE NOCASE")
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
        "SELECT p.id, p.name, p.updatedAt, p.source, p.imageUrl, COUNT(CASE WHEN t.id IS NOT NULL OR e.streamKey != '' THEN 1 END) AS trackCount, " +
            "(SELECT t2.albumId FROM playlist_entries e2 JOIN tracks t2 ON t2.id = e2.trackId WHERE e2.playlistId = p.id ORDER BY e2.position LIMIT 1) AS coverAlbumId " +
            "FROM playlists p LEFT JOIN playlist_entries e ON e.playlistId = p.id LEFT JOIN tracks t ON t.id = e.trackId " +
            "GROUP BY p.id ORDER BY p.updatedAt DESC"
    )
    fun playlists(): Flow<List<PlaylistSummary>>

    @Query("SELECT * FROM playlists WHERE id = :id")
    fun playlist(id: Long): Flow<Playlist?>

    /** Every slot, local and streamed, in order. */
    @Transaction
    @Query("SELECT * FROM playlist_entries WHERE playlistId = :id ORDER BY position")
    fun playlistRows(id: Long): Flow<List<PlaylistRow>>

    @Upsert
    suspend fun upsertStreamTracks(tracks: List<StreamTrack>)

    @Query("SELECT * FROM stream_tracks WHERE `key` IN (:keys)")
    suspend fun streamTracks(keys: List<String>): List<StreamTrack>

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

    /** Rewrites the playlist with these slots, in this order (moves and removals). */
    @Transaction
    suspend fun setPlaylistEntries(id: Long, slots: List<PlaylistEntry>, at: Long) {
        clearPlaylist(id)
        upsertEntries(slots.mapIndexed { i, e -> PlaylistEntry(playlistId = id, trackId = e.trackId, position = i, streamKey = e.streamKey) })
        touchPlaylist(id, at)
    }

    @Transaction
    suspend fun createPlaylist(playlist: Playlist, trackIds: List<Long>): Long {
        val id = insertPlaylist(playlist)
        upsertEntries(trackIds.mapIndexed { i, t -> PlaylistEntry(playlistId = id, trackId = t, position = i) })
        return id
    }

    /** An import: library songs where they match, the service's songs where they don't. */
    @Transaction
    suspend fun createImportedPlaylist(playlist: Playlist, slots: List<PlaylistEntry>, streams: List<StreamTrack>): Long {
        upsertStreamTracks(streams)
        val id = insertPlaylist(playlist)
        upsertEntries(slots.mapIndexed { i, e -> PlaylistEntry(playlistId = id, trackId = e.trackId, position = i, streamKey = e.streamKey) })
        return id
    }

    // ---- ratings ----

    @Query("SELECT * FROM ratings")
    fun ratings(): Flow<List<Rating>>

    @Query("SELECT * FROM ratings")
    suspend fun allRatings(): List<Rating>

    @Upsert
    suspend fun upsertRatings(ratings: List<Rating>)

    @Query("DELETE FROM ratings WHERE trackId = :trackId")
    suspend fun clearRating(trackId: Long)

    @Query("SELECT t.* FROM tracks t JOIN ratings r ON r.trackId = t.id WHERE r.stars >= :min ORDER BY r.stars DESC, t.title COLLATE NOCASE")
    fun ratedAtLeast(min: Float): Flow<List<Track>>

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

    /** The phone's copy of a Hive (PC) song, if it has one. */
    @Query("SELECT t.* FROM pc_match m JOIN tracks t ON t.id = m.trackId WHERE m.pcId = :pcId LIMIT 1")
    suspend fun trackForPc(pcId: String): Track?

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

    /** Plays made here that Hive on the PC hasn't been given yet. */
    @Query("SELECT * FROM plays WHERE synced = 0 AND fromPc = 0 ORDER BY playedAt LIMIT 2000")
    suspend fun unsentPlays(): List<Play>

    @Query("UPDATE plays SET synced = 1 WHERE rowId IN (:ids)")
    suspend fun markPlaysSent(ids: List<Long>)

    @androidx.room.Insert
    suspend fun insertPlays(plays: List<Play>)

    /** Whether a play of this song at this moment is already here (a PC play fetched twice). */
    @Query("SELECT COUNT(*) FROM plays WHERE trackId = :trackId AND playedAt = :playedAt")
    suspend fun playCountAt(trackId: Long, playedAt: Long): Int

    @Query(
        "SELECT p.trackId, p.playedAt, p.listenedMs, t.title, t.artist, t.album, t.albumArtist, t.albumId, t.genre " +
            "FROM plays p JOIN tracks t ON t.id = p.trackId WHERE p.playedAt >= :from AND p.playedAt < :to"
    )
    suspend fun playsBetween(from: Long, to: Long): List<PlayRow>

    @Query("SELECT MIN(playedAt) FROM plays")
    suspend fun firstPlay(): Long?

    @Query("SELECT COUNT(*) AS plays, MAX(playedAt) AS lastPlayed FROM plays WHERE trackId = :trackId")
    suspend fun playStats(trackId: Long): PlayStats

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
    entities = [Track::class, LoveState::class, PcMatch::class, Play::class, FavoriteAlbum::class, Playlist::class, PlaylistEntry::class, StreamTrack::class, Rating::class],
    version = 5,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2), AutoMigration(from = 2, to = 3), AutoMigration(from = 3, to = 4), AutoMigration(from = 4, to = 5)],
)
abstract class LibraryDatabase : RoomDatabase() {
    abstract fun dao(): LibraryDao

    companion object {
        fun open(context: Context): LibraryDatabase =
            Room.databaseBuilder(context, LibraryDatabase::class.java, "hive-library.db").build()
    }
}
