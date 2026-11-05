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
    /** Love, kept in the file as Hive on the PC keeps it (see [LoveTag]); not one of the PC's tag-editor fields. */
    val loved: Boolean? = null,
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
 * A change to a song's pictures, as Hive's artwork editor on the PC makes
 * them: a new [front] cover, and [backs] by their place among the song's back
 * covers (0 its first): a new picture, or null to take that one off. A place
 * past the last back cover adds one. Every other picture stays as it was.
 */
class CoverEdit(val front: ByteArray? = null, val backs: Map<Int, ByteArray?> = emptyMap()) {
    val isEmpty get() = front == null && backs.isEmpty()

    /** The song's pictures after this change, as (data, ID3 type), in file order. */
    fun applyTo(pictures: List<EmbeddedPictures.Picture>): List<Pair<ByteArray, Int>> {
        val list = pictures.map { it.data to it.type }.toMutableList<Pair<ByteArray, Int>?>()
        front?.let { f ->
            // As on the PC: the front cover, or else the first picture, is replaced; a song with none gets one first.
            val i = list.indexOfFirst { it?.second == EmbeddedPictures.FRONT }.takeIf { it >= 0 } ?: if (list.isEmpty()) -1 else 0
            if (i < 0) list.add(0, f to EmbeddedPictures.FRONT) else list[i] = f to EmbeddedPictures.FRONT
        }
        val places = list.indices.filter { list[it]?.second == EmbeddedPictures.BACK }
        for ((k, picture) in backs.toSortedMap()) {
            when {
                k < places.size -> list[places[k]] = picture?.let { it to EmbeddedPictures.BACK }
                picture != null -> list.add(picture to EmbeddedPictures.BACK)
            }
        }
        return list.filterNotNull()
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

    /** Writes [edit] (and [covers], JPEGs or PNGs) into [track]'s file. */
    suspend fun write(context: Context, track: Track, edit: TagEdit, covers: CoverEdit? = null) = withContext(Dispatchers.IO) {
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
            if (covers != null && !covers.isEmpty) {
                // Hive's own reader knows MP3, FLAC, M4A and WAV; for the rest, the tag library's.
                val now = work.inputStream().use { EmbeddedPictures.readTyped(it) }.ifEmpty { tag.artworkList.map { EmbeddedPictures.Picture(it.binaryData, it.pictureType) } }
                setPictures(tag, covers.applyTo(now))
            }
            file.commit()
            // Read back: the copy must still be a song of the same length, with the new tags.
            val check = AudioFileIO.read(work)
            if (kotlin.math.abs(check.audioHeader.trackLength - file.audioHeader.trackLength) > 1) throw IOException("The edited copy of ${track.fileName} didn't read back")
            edit.title?.let { if (check.tag?.getFirst(FieldKey.TITLE).orEmpty() != it) throw IOException("The new title didn't stick in ${track.fileName}") }
            edit.loved?.let { if (LoveTag.read(check.tag) != it) throw IOException("Love didn't stick in ${track.fileName}") }
            // With All files access, the edited copy is put next to the song and renamed over it in one
            // step: the song is never half written, even if the app is stopped mid-way (an
            // unfinished write went to the PC with song sync, over its good copy).
            if (replaceAtomically(context, track, work)) { rescan(context, track); return@withContext }
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

    /** Puts [work] in place of the song's file by a rename in its own folder. False when that can't be done here. */
    private fun replaceAtomically(context: Context, track: Track, work: File): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 30 || !android.os.Environment.isExternalStorageManager()) return false
        val path = runCatching {
            context.contentResolver.query(track.uri, arrayOf(android.provider.MediaStore.MediaColumns.DATA), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull() ?: return false
        val target = File(path).takeIf { it.isFile } ?: return false
        val staged = File(target.parentFile, ".${target.name}.hive-edit")
        return try {
            java.io.FileOutputStream(staged).use { out -> work.inputStream().use { it.copyTo(out) }; out.fd.sync() }
            if (staged.length() != work.length() || !staged.renameTo(target)) { staged.delete(); false } else true
        } catch (e: Exception) { staged.delete(); false }
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
        e.loved?.let { LoveTag.set(tag, it) }
    }

    /** The song's pictures become exactly these, in order. FLAC and Ogg pictures are built here, as the library's own way needs desktop Java. */
    private fun setPictures(tag: Tag, pictures: List<Pair<ByteArray, Int>>) {
        tag.deleteArtworkField()
        for ((bytes, type) in pictures) {
            val mime = when {
                bytes.size > 3 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() -> "image/png"
                bytes.size > 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() -> "image/jpeg"
                bytes.size > 3 && String(bytes, 0, 3, Charsets.ISO_8859_1) == "GIF" -> "image/gif"
                bytes.size > 11 && String(bytes, 8, 4, Charsets.ISO_8859_1) == "WEBP" -> "image/webp"
                else -> throw IOException("That picture isn't a JPEG or PNG")
            }
            val size = BitmapFactory.Options().apply { inJustDecodeBounds = true }.also { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it) }
            val picture = { MetadataBlockDataPicture(bytes, type, mime, "", size.outWidth.coerceAtLeast(0), size.outHeight.coerceAtLeast(0), 24, 0) }
            when (tag) {
                is FlacTag -> tag.addField(picture())
                is VorbisCommentTag -> tag.addField(tag.createField(VorbisCommentFieldKey.METADATA_BLOCK_PICTURE, String(org.jaudiotagger.tag.vorbiscomment.util.Base64Coder.encode(picture().rawContent))))
                else -> tag.addField(AndroidArtwork().apply { binaryData = bytes; mimeType = mime; pictureType = type })
            }
        }
    }

    /** The song's pictures with their types, front and back covers alike. */
    suspend fun pictures(context: Context, track: Track): List<EmbeddedPictures.Picture> = withContext(Dispatchers.IO) {
        runCatching { context.contentResolver.openInputStream(track.uri)?.use { EmbeddedPictures.readTyped(it) } }.getOrNull().orEmpty()
    }

    /** Has Android read the file again, so the library shows the new tags. */
    private suspend fun rescan(context: Context, track: Track) {
        val path = context.contentResolver.query(track.uri, arrayOf(MediaStore.Audio.Media.DATA), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: return
        suspendCancellableCoroutine { done -> MediaScannerConnection.scanFile(context, arrayOf(path), null) { _, _ -> if (done.isActive) done.resume(Unit) } }
    }

    /** The song's own front cover at full size, or null. */
    suspend fun cover(context: Context, track: Track): ByteArray? = withContext(Dispatchers.IO) {
        runCatching { context.contentResolver.openInputStream(track.uri)?.use { EmbeddedPictures.readTyped(it) }?.let { p -> (p.firstOrNull { it.type == EmbeddedPictures.FRONT } ?: p.firstOrNull())?.data } }.getOrNull()
            ?: runCatching { android.media.MediaMetadataRetriever().use { r -> r.setDataSource(context, track.uri); r.embeddedPicture } }.getOrNull()
    }
}
