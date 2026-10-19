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

        val out = ArrayList<Track>()
        resolver.query(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            columns,
            "${MediaStore.Audio.Media.IS_MUSIC} != 0",
            null,
            null,
        )?.use { c ->
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
        return out
    }

    private fun cleanUnknown(value: String) = if (value == "<unknown>") "" else value
}
