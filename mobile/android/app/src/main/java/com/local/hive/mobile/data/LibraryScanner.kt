package com.local.hive.mobile.data

import android.content.ContentResolver
import android.os.Build
import android.provider.MediaStore

/** Reads the phone's music from MediaStore, the same index Samsung Music uses. */
class LibraryScanner(private val resolver: ContentResolver) {

    fun scan(): List<Track> {
        val columns = buildList {
            add(MediaStore.Audio.Media._ID)
            add(MediaStore.Audio.Media.TITLE)
            add(MediaStore.Audio.Media.ARTIST)
            add(MediaStore.Audio.Media.ALBUM)
            add(MediaStore.Audio.Media.ALBUM_ID)
            add(MediaStore.Audio.Media.DURATION)
            add(MediaStore.Audio.Media.TRACK)
            add(MediaStore.Audio.Media.YEAR)
            add(MediaStore.Audio.Media.DISPLAY_NAME)
            add(MediaStore.Audio.Media.RELATIVE_PATH)
            add(MediaStore.Audio.Media.DATE_ADDED)
            add(MediaStore.Audio.Media.SIZE)
            add(MediaStore.Audio.Media.ALBUM_ARTIST)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                add(MediaStore.Audio.Media.GENRE)
                add(MediaStore.Audio.Media.DISC_NUMBER)
            }
        }.toTypedArray()

        var scanned = false
        val out = ArrayList<Track>()
        resolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            columns,
            "${MediaStore.Audio.Media.IS_MUSIC} != 0",
            null,
            null,
        )?.use { c ->
            scanned = true
            fun idx(name: String) = c.getColumnIndex(name)
            val iId = idx(MediaStore.Audio.Media._ID)
            val iTitle = idx(MediaStore.Audio.Media.TITLE)
            val iArtist = idx(MediaStore.Audio.Media.ARTIST)
            val iAlbum = idx(MediaStore.Audio.Media.ALBUM)
            val iAlbumId = idx(MediaStore.Audio.Media.ALBUM_ID)
            val iDuration = idx(MediaStore.Audio.Media.DURATION)
            val iTrack = idx(MediaStore.Audio.Media.TRACK)
            val iYear = idx(MediaStore.Audio.Media.YEAR)
            val iName = idx(MediaStore.Audio.Media.DISPLAY_NAME)
            val iPath = idx(MediaStore.Audio.Media.RELATIVE_PATH)
            val iAdded = idx(MediaStore.Audio.Media.DATE_ADDED)
            val iSize = idx(MediaStore.Audio.Media.SIZE)
            val iAlbumArtist = idx(MediaStore.Audio.Media.ALBUM_ARTIST)
            val iGenre = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) idx(MediaStore.Audio.Media.GENRE) else -1
            val iDisc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) idx(MediaStore.Audio.Media.DISC_NUMBER) else -1

            // Tags often carry stray spaces (" Access Denied"), which would sort ahead of everything.
            fun str(i: Int) = if (i < 0 || c.isNull(i)) "" else c.getString(i).orEmpty().trim()
            fun long(i: Int) = if (i < 0 || c.isNull(i)) 0L else c.getLong(i)

            while (c.moveToNext()) {
                val rawTrack = long(iTrack).toInt()
                val fileName = str(iName)
                out += Track(
                    id = long(iId),
                    title = str(iTitle).ifBlank { fileName.substringBeforeLast('.') },
                    artist = cleanUnknown(str(iArtist)),
                    album = cleanUnknown(str(iAlbum)),
                    albumArtist = cleanUnknown(str(iAlbumArtist)),
                    albumId = long(iAlbumId),
                    durationMs = long(iDuration),
                    // MediaStore packs the disc into the thousands of TRACK.
                    trackNumber = rawTrack % 1000,
                    discNumber = str(iDisc).substringBefore('/').toIntOrNull() ?: (rawTrack / 1000).coerceAtLeast(1),
                    year = long(iYear).toInt(),
                    genre = str(iGenre),
                    folder = str(iPath).trimEnd('/'),
                    fileName = fileName,
                    dateAdded = long(iAdded) * 1000,
                    sizeBytes = long(iSize),
                )
            }
        }
        // No answer at all is "MediaStore can't be asked right now", never "no music":
        // returning nothing would empty the library.
        if (!scanned) throw java.io.IOException("MediaStore didn't answer")
        return AlbumMerge.apply(withWavTags(out.map(::repaired)))
    }

    /** Tags saved as UTF-8 but read as Latin-1 ("Shouldnâ€™t") read as written. */
    private fun repaired(t: Track): Track {
        val title = TextRepair.mojibake(t.title); val artist = TextRepair.mojibake(t.artist)
        val album = TextRepair.mojibake(t.album); val albumArtist = TextRepair.mojibake(t.albumArtist)
        return if (title == t.title && artist == t.artist && album == t.album && albumArtist == t.albumArtist) t
        else t.copy(title = title, artist = artist, album = album, albumArtist = albumArtist)
    }

    /**
     * WAV songs as their tags say. Android reads no tags from WAV files: it
     * shows them by file name, with no artist, filed under one "album" named
     * after their folder. Each tagged album gets its own id (minus its first
     * song's id), so it lists and shows its cover on its own.
     */
    private fun withWavTags(tracks: List<Track>): List<Track> {
        val tagged = tracks.map { t ->
            if (!t.fileName.endsWith(".wav", ignoreCase = true) || t.artist.isNotBlank()) return@map t
            val info = runCatching { resolver.openInputStream(t.uri)?.use(WavTags::read) }.getOrNull() ?: return@map t
            t.copy(
                title = info.title.ifBlank { t.title }, artist = info.artist, album = info.album.ifBlank { t.album }, albumArtist = info.albumArtist,
                year = info.year.takeIf { it > 0 } ?: t.year, genre = info.genre.ifBlank { t.genre },
                trackNumber = info.track.takeIf { it > 0 } ?: t.trackNumber, discNumber = info.disc.takeIf { it > 0 } ?: t.discNumber,
            ).let { if (info.album.isNotBlank()) it.copy(albumId = WAV_ALBUM) else it }
        }
        val ids = tagged.filter { it.albumId == WAV_ALBUM }
            .groupBy { it.album.lowercase() to it.displayAlbumArtist.lowercase() }
            .flatMap { (_, songs) -> val id = -songs.minOf { it.id }; songs.map { it.id to id } }.toMap()
        return tagged.map { t -> ids[t.id]?.let { t.copy(albumId = it) } ?: t }
    }

    private companion object {
        /** Placeholder while WAV albums are being given their ids. */
        const val WAV_ALBUM = Long.MIN_VALUE
    }

    private fun cleanUnknown(value: String) = if (value == "<unknown>") "" else value
}
