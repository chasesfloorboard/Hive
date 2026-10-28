package com.local.hive.mobile.data

import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaScannerConnection
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.jaudiotagger.audio.AudioFileIO
import org.jaudiotagger.audio.flac.metadatablock.MetadataBlockDataPicture
import org.jaudiotagger.tag.FieldKey
import org.jaudiotagger.tag.Tag
import org.jaudiotagger.tag.TagOptionSingleton
import org.jaudiotagger.tag.flac.FlacTag
import org.jaudiotagger.tag.images.AndroidArtwork
import org.jaudiotagger.tag.reference.PictureTypes
import org.jaudiotagger.tag.vorbiscomment.VorbisCommentFieldKey
import org.jaudiotagger.tag.vorbiscomment.VorbisCommentTag
import java.io.File
import java.io.IOException
import kotlin.coroutines.resume

/**
 * Changes to a song's tags; null leaves a field as it is, blank clears it.
 * The same names as Hive's tag editor on the PC (see hive-link.js EDITABLE_TAGS).
 */
data class TagEdit(
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val albumArtist: String? = null,
    val genre: String? = null,
    val year: String? = null,
    val track: String? = null,
    val disc: String? = null,
    val lyrics: String? = null,
) {
    val isEmpty get() = pcTags().isEmpty()

    /** As Hive on the PC names them. */
    fun pcTags(): Map<String, String> = buildMap {
        title?.let { put("title", it) }; artist?.let { put("artist", it) }; album?.let { put("album", it) }
        albumArtist?.let { put("albumArtist", it) }; genre?.let { put("genre", it) }; year?.let { put("year", it) }
        track?.let { put("track", it) }; disc?.let { put("disk", it) }; lyrics?.let { put("lyrics", it) }
    }
}

/**
 * Writes tags and covers into the song files, as Hive's tag editor does on the
 * PC. Each file is edited as a copy, which is read back before it replaces the
 * original; the original is kept aside until the new one is safely in place.
 * The caller first gets Android's permission to change the files
 * (MediaStore.createWriteRequest).
 */
object TagWriter {
    /** The formats Hive can write; others (Opus, for one) are left alone. */
    private val WRITABLE = setOf("mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "wav", "aif", "aiff", "wma")

    fun canWrite(track: Track) = track.fileName.substringAfterLast('.', "").lowercase() in WRITABLE

    init { TagOptionSingleton.getInstance().isAndroid = true }

    /** Writes [edit] (and [cover], a JPEG or PNG) into [track]'s file. */
    suspend fun write(context: Context, track: Track, edit: TagEdit, cover: ByteArray? = null) = withContext(Dispatchers.IO) {
        val ext = track.fileName.substringAfterLast('.', "").lowercase()
        if (ext !in WRITABLE) throw IOException("Hive can't write tags into .$ext files")
        val dir = File(context.cacheDir, "tag-edit").apply { mkdirs() }
        val work = File(dir, "${track.id}.$ext")
        val backup = File(dir, "${track.id}.original")
        val resolver = context.contentResolver
        try {
            resolver.openInputStream(track.uri)?.use { input -> work.outputStream().use { input.copyTo(it) } } ?: throw IOException("Can't read ${track.fileName}")
            work.copyTo(backup, overwrite = true)
            val file = AudioFileIO.read(work)
            val tag = file.tagOrCreateAndSetDefault
            apply(tag, edit)
            cover?.let { setCover(tag, it) }
            file.commit()
            // Read back: the copy must still be a song of the same length, with the new tags.
            val check = AudioFileIO.read(work)
            if (kotlin.math.abs(check.audioHeader.trackLength - file.audioHeader.trackLength) > 1) throw IOException("The edited copy of ${track.fileName} didn't read back")
            edit.title?.let { if (check.tag?.getFirst(FieldKey.TITLE).orEmpty() != it) throw IOException("The new title didn't stick in ${track.fileName}") }
            try {
                resolver.openOutputStream(track.uri, "wt")?.use { out -> work.inputStream().use { it.copyTo(out) } } ?: throw IOException("Can't write ${track.fileName}")
            } catch (e: Exception) {
                // Half written: the original goes back.
                runCatching { resolver.openOutputStream(track.uri, "wt")?.use { out -> backup.inputStream().use { it.copyTo(out) } } }
                throw e
            }
            rescan(context, track)
        } finally {
            work.delete(); backup.delete()
        }
    }

    private fun apply(tag: Tag, e: TagEdit) {
        fun set(key: FieldKey, value: String?) {
            if (value == null) return
            if (value.isBlank()) runCatching { tag.deleteField(key) } else tag.setField(key, value.trim())
        }
        set(FieldKey.TITLE, e.title); set(FieldKey.ARTIST, e.artist); set(FieldKey.ALBUM, e.album)
        set(FieldKey.ALBUM_ARTIST, e.albumArtist); set(FieldKey.GENRE, e.genre); set(FieldKey.YEAR, e.year)
        set(FieldKey.TRACK, e.track?.takeIf { it.isBlank() || it.trim().toIntOrNull() != null })
        set(FieldKey.DISC_NO, e.disc?.takeIf { it.isBlank() || it.trim().toIntOrNull() != null })
        e.lyrics?.let { if (it.isBlank()) runCatching { tag.deleteField(FieldKey.LYRICS) } else tag.setField(FieldKey.LYRICS, it) }
    }

    /** The front cover, replacing any other. FLAC and Ogg pictures are built here, as the library's own way needs desktop Java. */
    private fun setCover(tag: Tag, bytes: ByteArray) {
        val mime = when {
            bytes.size > 3 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() -> "image/png"
            bytes.size > 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() -> "image/jpeg"
            else -> throw IOException("That picture isn't a JPEG or PNG")
        }
        tag.deleteArtworkField()
        val size = BitmapFactory.Options().apply { inJustDecodeBounds = true }.also { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it) }
        val picture = { MetadataBlockDataPicture(bytes, PictureTypes.DEFAULT_ID, mime, "", size.outWidth.coerceAtLeast(0), size.outHeight.coerceAtLeast(0), 24, 0) }
        when (tag) {
            is FlacTag -> tag.setField(picture())
            is VorbisCommentTag -> tag.setField(tag.createField(VorbisCommentFieldKey.METADATA_BLOCK_PICTURE, String(org.jaudiotagger.tag.vorbiscomment.util.Base64Coder.encode(picture().rawContent))))
            else -> tag.setField(AndroidArtwork().apply { binaryData = bytes; mimeType = mime; pictureType = PictureTypes.DEFAULT_ID })
        }
    }

    /** Has Android read the file again, so the library shows the new tags. */
    private suspend fun rescan(context: Context, track: Track) {
        val path = context.contentResolver.query(track.uri, arrayOf(MediaStore.Audio.Media.DATA), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: return
        suspendCancellableCoroutine { done -> MediaScannerConnection.scanFile(context, arrayOf(path), null) { _, _ -> if (done.isActive) done.resume(Unit) } }
    }

    /** The song's own front cover at full size, or null. */
    suspend fun cover(context: Context, track: Track): ByteArray? = withContext(Dispatchers.IO) {
        runCatching { context.contentResolver.openInputStream(track.uri)?.use { EmbeddedPictures.read(it) }?.firstOrNull() }.getOrNull()
            ?: runCatching { android.media.MediaMetadataRetriever().use { r -> r.setDataSource(context, track.uri); r.embeddedPicture } }.getOrNull()
    }
}
