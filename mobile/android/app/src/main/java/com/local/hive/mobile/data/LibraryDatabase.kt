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
    /**
     * This song's own picture (see [SongArtFetcher]), for song rows: Android files songs with no album, or a
     * shared one like "(Multiple values) - Single", as one album, and its picture is one song's.
     */
    val songArtUri: Uri get() = Uri.parse("content://media/external/audio/media/$id/albumart")
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
@kotlinx.serialization.Serializable
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

/**
 * A liked artist or playlist (any playlist: the phone's, a smart one, the PC's, Apple Music's or
 * Spotify's), shown on the Favorites page. [route] opens it; [artwork] is its picture when it has one.
 */
@kotlinx.serialization.Serializable
@Entity(tableName = "favorite_items")
data class FavoriteItem(
    @PrimaryKey val key: String,
    /** "artist" or "playlist". */
    val kind: String,
    val title: String,
    val subtitle: String = "",
    val artwork: String? = null,
    val route: String,
    val addedAt: Long,
) {
    companion object {
        fun artistKey(name: String) = "artist:" + name.trim().lowercase()
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

/**
 * Recently played: one row per song, at its latest listen. [key] is the
 * player's media id: a library song's id, or a streamed song's key ("pc:",
 * "am:", "sp:"), whose details are kept in [StreamTrack]. A song goes in after
 * a few seconds of listening, unlike [Play], which needs a real listen.
 */
@Entity(tableName = "history")
data class HistoryEntry(@PrimaryKey val key: String, val playedAt: Long)

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
    /** Else the first streamed song's cover (a playlist of Apple Music or Spotify songs). */
    val streamArt: String? = null,
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
    /** Made on the phone and not yet in Hive on the PC; 0 [stars] is a rating taken off, to send. */
    @androidx.room.ColumnInfo(defaultValue = "0") val pending: Boolean = false,
)

/**
 * Song sync's memory: a song (by [key], see SongSync.keyOf) that has been on
 * both the phone and the PC. When one side later lacks it, it was deleted
 * there on purpose, so it is not copied back. Keys are tag-based, so the
 * ledger survives MediaStore renumbering and files moving on the PC.
 */
@Entity(tableName = "synced_songs")
data class SyncedSong(
    @PrimaryKey val key: String,
    val since: Long,
)

/** A phone song and the Hive (PC) song it is a copy of. */
data class PcCopy(val pcId: String, @androidx.room.Embedded val track: Track)

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
    /** A song streamed from Hive on the PC (not on this phone): its id there. [trackId] is 0. */
    val pcId: String? = null,
)

data class TrackLength(val id: Long, val durationMs: Long)

data class RatingToSend(val trackId: Long, val stars: Float, val changedAt: Long, val pcId: String)

/** See [LibraryDao.relink]: above any number Android gives a song. */
const val RELINK_STAGE = 1L shl 42

/**
 * A song that has things kept for it (plays, Love, a rating, playlist places, Recently played) but
 * isn't on the phone now: a restored backup before the music is copied over, or a song deleted. When
 * a song with its file or tags turns up, its things go to it (see [TrackRelink]). A negative [id] is
 * one whose number now belongs to another song: its things wait under that negative number.
 */
@Entity(tableName = "lost_tracks")
data class LostTrack(
    @PrimaryKey val id: Long,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val folder: String,
    val fileName: String,
    val lostAt: Long,
) {
    fun asTrack() = Track(id, title, artist, album, "", 0, durationMs, 0, 0, 0, "", folder, fileName, 0, 0)
    companion object {
        fun of(t: Track, id: Long = t.id, at: Long = System.currentTimeMillis()) = LostTrack(id, t.title, t.artist, t.album, t.durationMs, t.folder, t.fileName, at)
    }
}

/** A play ready to go to Hive on the PC, with the song's id there. */
data class PlayToSend(val rowId: Long, val playedAt: Long, val listenedMs: Long, val pcId: String)

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

/** An album in a genre (or by an artist: [genre] is then the artist), with how often its songs were played and how many it has. */
data class GenreAlbum(val genre: String, val albumId: Long, val plays: Int, val tracks: Int)

data class PlayStats(val plays: Int, val lastPlayed: Long?)

data class TrackPlays(val trackId: Long, val plays: Int)

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

    /** Each genre's albums, the most played first (then the biggest), for the genre's picture. */
    @Query("SELECT t.genre AS genre, t.albumId AS albumId, COUNT(p.trackId) AS plays, COUNT(DISTINCT t.id) AS tracks FROM tracks t LEFT JOIN plays p ON p.trackId = t.id WHERE t.genre != '' AND t.albumId > 0 GROUP BY t.genre COLLATE NOCASE, t.albumId ORDER BY plays DESC, tracks DESC")
    fun genreAlbums(): Flow<List<GenreAlbum>>

    /** Each artist's albums, the most played first (then the biggest), for the artist's picture. */
    @Query("SELECT t.artist AS genre, t.albumId AS albumId, COUNT(p.trackId) AS plays, COUNT(DISTINCT t.id) AS tracks FROM tracks t LEFT JOIN plays p ON p.trackId = t.id WHERE t.artist != '' AND t.albumId > 0 GROUP BY t.artist, t.albumId ORDER BY plays DESC, tracks DESC")
    fun artistAlbums(): Flow<List<GenreAlbum>>

    @Query("SELECT folder AS name, COUNT(*) AS trackCount FROM tracks GROUP BY folder ORDER BY folder COLLATE NOCASE")
    fun folders(): Flow<List<NamedCount>>

    @Query(
        "SELECT * FROM tracks WHERE title LIKE :q OR artist LIKE :q OR album LIKE :q " +
            "ORDER BY title COLLATE NOCASE LIMIT 300"
    )
    suspend fun search(q: String): List<Track>

    @Upsert
    suspend fun upsertTracks(tracks: List<Track>)

    @Query("DELETE FROM tracks")
    suspend fun deleteAllTracks()

    /**
     * Makes the table match a fresh MediaStore scan, writing only rows that
     * changed: a rescan of an unchanged 30,000-track library writes nothing.
     */
    /** Returns how many rows were written or deleted (0: the library didn't change). */
    @Transaction
    suspend fun replaceLibrary(tracks: List<Track>): Int {
        val existing = allTracks().associateBy { it.id }
        // Songs under new numbers (a new phone, a restore, a rebuilt music index) keep their things,
        // and so do songs gone for now, until their files come back.
        val lost = allLostTracks()
        val r = TrackRelink.find(existing.values + lost.filter { it.id !in existing }.map { it.asTrack() }, tracks)
        relink(r)
        val scanned = tracks.mapTo(HashSet()) { it.id }
        val lostById = lost.associateBy { it.id }
        r.moved.keys.chunked(500).forEach { deleteLostTracks(it) }
        r.aside.forEach { id -> (existing[id]?.let { LostTrack.of(it) } ?: lostById[id])?.let { upsertLostTrack(it.copy(id = -id)) }; deleteLostTracks(listOf(id)) }
        upsertLostTracks(existing.values.filter { it.id !in scanned && it.id !in r.moved && it.id !in r.aside }.map { LostTrack.of(it) })
        forgetLostWithoutThings()
        if (tracks.isEmpty()) { deleteAllTracks(); return existing.size }
        // SQLite caps bound parameters, so writes and deletes go in chunks.
        val changed = tracks.filter { existing[it.id] != it }
        changed.chunked(500).forEach { upsertTracks(it) }
        val keep = tracks.mapTo(HashSet()) { it.id }
        val gone = existing.keys.filterNot { it in keep }
        gone.chunked(500).forEach { deleteTracks(it) }
        return changed.size + gone.size
    }

    /**
     * Moves what is kept for each song in [r] to its new number. Every row goes through a negative
     * number first, so numbers that trade places never clash: moved ones end up at their new number,
     * those set aside stay negative (no song has a negative number).
     */
    @Transaction
    suspend fun relink(r: TrackRelink.Result) {
        if (r.isEmpty) return
        suspend fun move(from: Long, to: Long) { relinkLove(from, to); relinkRatings(from, to); relinkPlays(from, to); relinkPlaylistEntries(from, to); relinkPcMatch(from, to) }
        for ((old, new) in r.moved) move(old, -new - RELINK_STAGE)
        for (old in r.aside) move(old, -old)
        relinkSettleLove(); relinkSettleRatings(); relinkSettlePlays(); relinkSettlePlaylistEntries(); relinkSettlePcMatch()
        // A PC match is worked out again at the next sync; a song set aside has none.
        deleteAsideMatches()
        // Recently played is kept by text.
        for ((old, new) in r.moved) relinkHistory(old.toString(), "~$new")
        for (old in r.aside) deleteHistory(old.toString())
        relinkSettleHistory()
    }

    @Query("UPDATE OR REPLACE love SET trackId = :to WHERE trackId = :from")
    suspend fun relinkLove(from: Long, to: Long)
    @Query("UPDATE OR REPLACE love SET trackId = -trackId - 4398046511104 WHERE trackId <= -4398046511104")
    suspend fun relinkSettleLove()
    @Query("UPDATE OR REPLACE ratings SET trackId = :to WHERE trackId = :from")
    suspend fun relinkRatings(from: Long, to: Long)
    @Query("UPDATE OR REPLACE ratings SET trackId = -trackId - 4398046511104 WHERE trackId <= -4398046511104")
    suspend fun relinkSettleRatings()
    @Query("UPDATE OR REPLACE plays SET trackId = :to WHERE trackId = :from")
    suspend fun relinkPlays(from: Long, to: Long)
    @Query("UPDATE OR REPLACE plays SET trackId = -trackId - 4398046511104 WHERE trackId <= -4398046511104")
    suspend fun relinkSettlePlays()
    @Query("UPDATE OR REPLACE playlist_entries SET trackId = :to WHERE trackId = :from")
    suspend fun relinkPlaylistEntries(from: Long, to: Long)
    @Query("UPDATE OR REPLACE playlist_entries SET trackId = -trackId - 4398046511104 WHERE trackId <= -4398046511104")
    suspend fun relinkSettlePlaylistEntries()
    @Query("UPDATE OR REPLACE pc_match SET trackId = :to WHERE trackId = :from")
    suspend fun relinkPcMatch(from: Long, to: Long)
    @Query("UPDATE OR REPLACE pc_match SET trackId = -trackId - 4398046511104 WHERE trackId <= -4398046511104")
    suspend fun relinkSettlePcMatch()
    @Query("DELETE FROM pc_match WHERE trackId < 0")
    suspend fun deleteAsideMatches()
    @Query("UPDATE OR REPLACE history SET `key` = :to WHERE `key` = :from")
    suspend fun relinkHistory(from: String, to: String)
    @Query("DELETE FROM history WHERE `key` = :key")
    suspend fun deleteHistory(key: String)
    @Query("UPDATE OR REPLACE history SET `key` = substr(`key`, 2) WHERE `key` LIKE '~%'")
    suspend fun relinkSettleHistory()

    @Query("UPDATE tracks SET year = :year WHERE id = :id")
    suspend fun setYear(id: Long, year: Int)
    @Transaction
    suspend fun setYears(years: Map<Long, Int>) { for ((id, y) in years) setYear(id, y) }

    @Query("SELECT * FROM lost_tracks")
    suspend fun allLostTracks(): List<LostTrack>
    @Upsert
    suspend fun upsertLostTrack(t: LostTrack)
    @Upsert
    suspend fun upsertLostTracks(t: List<LostTrack>)
    @Query("DELETE FROM lost_tracks WHERE id IN (:ids)")
    suspend fun deleteLostTracks(ids: List<Long>)
    /** A lost song with nothing kept for it is nothing to wait for. */
    @Query("DELETE FROM lost_tracks WHERE id NOT IN (SELECT trackId FROM love UNION SELECT trackId FROM ratings UNION SELECT trackId FROM plays UNION SELECT trackId FROM playlist_entries) AND CAST(id AS TEXT) NOT IN (SELECT `key` FROM history)")
    suspend fun forgetLostWithoutThings()

    @Query("DELETE FROM tracks WHERE id IN (:ids)")
    suspend fun deleteTracks(ids: List<Long>)

    // ---- song sync ----

    @Query("SELECT key FROM synced_songs")
    suspend fun syncedSongKeys(): List<String>

    @androidx.room.Insert(onConflict = androidx.room.OnConflictStrategy.IGNORE)
    suspend fun addSyncedSongs(songs: List<SyncedSong>)

    @Query("DELETE FROM synced_songs")
    suspend fun clearSyncedSongs()

    /** Forgets that these songs were on both sides, so song sync copies them again. */
    @Query("DELETE FROM synced_songs WHERE `key` IN (:keys)")
    suspend fun forgetSyncedSongs(keys: List<String>)

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

    /** A new copy of a song takes the old one's slots in every playlist. */
    @Query("UPDATE playlist_entries SET trackId = :to WHERE trackId = :from")
    suspend fun moveTrackInPlaylists(from: Long, to: Long)

    @Query(
        "SELECT p.id, p.name, p.updatedAt, p.source, p.imageUrl, COUNT(CASE WHEN t.id IS NOT NULL OR e.streamKey != '' THEN 1 END) AS trackCount, " +
            "(SELECT t2.albumId FROM playlist_entries e2 JOIN tracks t2 ON t2.id = e2.trackId WHERE e2.playlistId = p.id ORDER BY e2.position LIMIT 1) AS coverAlbumId, " +
            "(SELECT s3.artworkUrl FROM playlist_entries e3 JOIN stream_tracks s3 ON s3.key = e3.streamKey WHERE e3.playlistId = p.id AND s3.artworkUrl != '' ORDER BY e3.position LIMIT 1) AS streamArt " +
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

    @Query("UPDATE playlists SET imageUrl = :url, updatedAt = :at WHERE id = :id")
    suspend fun setPlaylistImage(id: Long, url: String, at: Long)

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

    @Query("SELECT * FROM ratings WHERE stars > 0")
    fun ratings(): Flow<List<Rating>>

    /** Ratings made here for Hive on the PC, with the song's id there. */
    @Query("SELECT r.trackId, r.stars, r.changedAt, m.pcId FROM ratings r JOIN pc_match m ON m.trackId = r.trackId WHERE r.pending = 1")
    suspend fun ratingsToSend(): List<RatingToSend>

    /** Sent: in step with the PC (which may change it from now on); one taken off is gone. */
    @Query("UPDATE ratings SET pending = 0, fromPc = 1 WHERE trackId = :trackId AND changedAt = :changedAt")
    suspend fun ratingSent(trackId: Long, changedAt: Long)
    @Query("DELETE FROM ratings WHERE stars <= 0 AND pending = 0")
    suspend fun forgetClearedRatings()

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

    @Query("DELETE FROM favorite_albums")
    suspend fun clearFavoriteAlbums()

    // ---- liked artists and playlists ----

    @Query("SELECT * FROM favorite_items ORDER BY addedAt DESC")
    fun favoriteItems(): Flow<List<FavoriteItem>>

    @Upsert
    suspend fun upsertFavoriteItem(item: FavoriteItem)

    @Query("DELETE FROM favorite_items WHERE `key` = :key")
    suspend fun deleteFavoriteItem(key: String)

    // ---- PC matching ----

    @Query("SELECT * FROM pc_match")
    suspend fun allMatches(): List<PcMatch>

    /** The phone's copy of a Hive (PC) song, if it has one. */
    @Query("SELECT t.* FROM pc_match m JOIN tracks t ON t.id = m.trackId WHERE m.pcId = :pcId LIMIT 1")
    suspend fun trackForPc(pcId: String): Track?

    @Query("SELECT * FROM playlists")
    suspend fun allPlaylistsOnce(): List<Playlist>

    @Query("SELECT * FROM playlist_entries WHERE playlistId = :id ORDER BY position")
    suspend fun entriesOnce(id: Long): List<PlaylistEntry>

    /** The phone's copies of many Hive songs at once (a whole PC playlist), with the PC id each is for. */
    @Query("SELECT m.pcId AS pcId, t.* FROM pc_match m JOIN tracks t ON t.id = m.trackId WHERE m.pcId IN (:pcIds)")
    suspend fun tracksForPc(pcIds: List<String>): List<PcCopy>

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

    /** Recently played, oldest first (for [PlayRepair]). */
    @Query("SELECT * FROM history ORDER BY playedAt")
    suspend fun allHistory(): List<HistoryEntry>

    /** The phone's own plays since [since] (for [PlayRepair]). */
    @Query("SELECT * FROM plays WHERE fromPc = 0 AND playedAt >= :since")
    suspend fun phonePlaysSince(since: Long): List<Play>

    @Query("SELECT id, durationMs FROM tracks")
    suspend fun trackLengths(): List<TrackLength>

    @Upsert
    suspend fun insertPlay(play: Play)

    /**
     * Plays made here that Hive on the PC hasn't been given yet and can count:
     * songs matched to one of Hive's, or streamed from it. Plays of songs only
     * on this phone wait (song sync may copy the song over) without holding
     * back the rest.
     */
    @Query(
        "SELECT p.rowId, p.playedAt, p.listenedMs, COALESCE(p.pcId, m.pcId) AS pcId FROM plays p LEFT JOIN pc_match m ON m.trackId = p.trackId " +
            "WHERE p.synced = 0 AND p.fromPc = 0 AND COALESCE(p.pcId, m.pcId) IS NOT NULL ORDER BY p.playedAt LIMIT 2000"
    )
    suspend fun playsToSend(): List<PlayToSend>

    @Query("UPDATE plays SET synced = 1 WHERE rowId IN (:ids)")
    suspend fun markPlaysSent(ids: List<Long>)

    /**
     * Plays an older Hive Mobile marked sent without sending: songs Hive
     * didn't have. Run once, right after a full match, when every play whose
     * song still has no match can only have been one of those.
     */
    @Query("UPDATE plays SET synced = 0 WHERE synced = 1 AND fromPc = 0 AND pcId IS NULL AND trackId NOT IN (SELECT trackId FROM pc_match)")
    suspend fun unsendUnmatchedPlays(): Int

    @androidx.room.Insert
    suspend fun insertPlays(plays: List<Play>)

    /** Whether a play of this song at this moment is already here (a PC play fetched twice). */
    /** Plays at this moment, of any song: a play coming back from the PC that's already here. */
    @Query("SELECT COUNT(*) FROM plays WHERE playedAt = :playedAt")
    suspend fun playsAtTime(playedAt: Long): Int

    /** The phone's own plays not yet sent to the PC (for the backup). */
    @Query("SELECT * FROM plays WHERE synced = 0 AND fromPc = 0")
    suspend fun unsentPlays(): List<Play>

    @Query("SELECT * FROM favorite_albums")
    suspend fun favoriteAlbumsOnce(): List<FavoriteAlbum>

    @Query("SELECT * FROM favorite_items")
    suspend fun favoriteItemsOnce(): List<FavoriteItem>

    @Query("SELECT COUNT(*) FROM plays WHERE trackId = :trackId AND playedAt = :playedAt")
    suspend fun playCountAt(trackId: Long, playedAt: Long): Int

    @Query(
        "SELECT p.trackId, p.playedAt, p.listenedMs, t.title, t.artist, t.album, t.albumArtist, t.albumId, t.genre " +
            "FROM plays p JOIN tracks t ON t.id = p.trackId WHERE p.playedAt >= :from AND p.playedAt < :to"
    )
    suspend fun playsBetween(from: Long, to: Long): List<PlayRow>

    /** This phone's plays Hive on the PC hasn't counted yet (not sent, or of songs it doesn't have). */
    @Query(
        "SELECT p.trackId, p.playedAt, p.listenedMs, t.title, t.artist, t.album, t.albumArtist, t.albumId, t.genre " +
            "FROM plays p JOIN tracks t ON t.id = p.trackId WHERE p.synced = 0 AND p.fromPc = 0 AND p.playedAt >= :from AND p.playedAt < :to"
    )
    suspend fun unsentPlaysBetween(from: Long, to: Long): List<PlayRow>

    @Query("SELECT MIN(playedAt) FROM plays")
    suspend fun firstPlay(): Long?

    /** Every song's play count, for Auto DJ. */
    @Query("SELECT trackId, COUNT(*) AS plays FROM plays GROUP BY trackId")
    suspend fun playCounts(): List<TrackPlays>

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

    @Upsert
    suspend fun upsertHistory(entry: HistoryEntry)

    /** Keeps a streamed song's details for history without replacing a fuller copy kept for a playlist. */
    @androidx.room.Insert(onConflict = androidx.room.OnConflictStrategy.IGNORE)
    suspend fun insertStreamTrackIfAbsent(track: StreamTrack)

    /** Recently played, newest first: library songs and streamed ones. */
    @Transaction
    @Query("SELECT 0 AS rowId, 0 AS playlistId, CASE WHEN h.`key` GLOB '[0-9]*' THEN CAST(h.`key` AS INTEGER) ELSE 0 END AS trackId, 0 AS position, CASE WHEN h.`key` GLOB '[0-9]*' THEN '' ELSE h.`key` END AS streamKey FROM history h ORDER BY h.playedAt DESC LIMIT :limit")
    fun history(limit: Int): Flow<List<PlaylistRow>>
}

@Database(
    entities = [Track::class, LoveState::class, PcMatch::class, Play::class, FavoriteAlbum::class, Playlist::class, PlaylistEntry::class, StreamTrack::class, Rating::class, SyncedSong::class, HistoryEntry::class, FavoriteItem::class, LostTrack::class],
    version = 11,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2), AutoMigration(from = 2, to = 3), AutoMigration(from = 3, to = 4), AutoMigration(from = 4, to = 5), AutoMigration(from = 5, to = 6), AutoMigration(from = 6, to = 7), AutoMigration(from = 7, to = 8, spec = LibraryDatabase.SeedHistory::class), AutoMigration(from = 8, to = 9), AutoMigration(from = 9, to = 10), AutoMigration(from = 10, to = 11, spec = LibraryDatabase.SendOwnRatings::class)],
)
abstract class LibraryDatabase : RoomDatabase() {
    abstract fun dao(): LibraryDao

    /** Ratings made on the phone before they went to the PC go there once. */
    class SendOwnRatings : androidx.room.migration.AutoMigrationSpec {
        override fun onPostMigrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("UPDATE ratings SET pending = 1 WHERE fromPc = 0")
        }
    }

    /** History starts from the library songs already played on this phone. */
    class SeedHistory : androidx.room.migration.AutoMigrationSpec {
        override fun onPostMigrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
            db.execSQL("INSERT OR IGNORE INTO history (`key`, playedAt) SELECT CAST(trackId AS TEXT), MAX(playedAt) FROM plays WHERE trackId > 0 AND fromPc = 0 GROUP BY trackId")
        }
    }

    companion object {
        fun open(context: Context): LibraryDatabase =
            Room.databaseBuilder(context, LibraryDatabase::class.java, "hive-library.db").build()
    }
}
