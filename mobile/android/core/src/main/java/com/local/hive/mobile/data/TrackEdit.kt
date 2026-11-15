package com.local.hive.mobile.data

/**
 * A [Track] with a [TagEdit] applied — the row as it will read once the file is rewritten, without waiting
 * for the MediaStore rescan. Used to update the library DB the instant a tag edit is saved so the open
 * album/list repopulate at once; the full rescan that follows is authoritative and reconciles anything this
 * can't know (above all the MediaStore-assigned albumId, which only changes when the album name/artist does).
 *
 * Field semantics match [TagWriter.apply]: a null edit field leaves the value as it was, a blank one clears it.
 */
fun Track.applying(edit: TagEdit): Track = copy(
    title = edit.title?.trim() ?: title,
    artist = edit.artist?.trim() ?: artist,
    album = edit.album?.trim() ?: album,
    albumArtist = edit.albumArtist?.trim() ?: albumArtist,
    genre = edit.genre?.trim() ?: genre,
    year = edit.year?.let { it.take(4).trim().toIntOrNull() ?: 0 } ?: year,
    trackNumber = edit.track?.let { it.trim().toIntOrNull() ?: 0 } ?: trackNumber,
    discNumber = edit.disc?.let { it.trim().toIntOrNull() ?: 0 } ?: discNumber,
)
