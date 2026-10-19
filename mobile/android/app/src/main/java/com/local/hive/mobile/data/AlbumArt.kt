package com.local.hive.mobile.data

import android.content.ContentUris
import android.content.Context
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.provider.MediaStore
import coil3.ImageLoader
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.SourceFetchResult
import coil3.request.Options
import com.local.hive.mobile.stream.AppleMusic
import com.local.hive.mobile.stream.YouTubeMusic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Request
import okio.Buffer
import java.io.File
import java.net.URLEncoder

/**
 * Album art at full quality. Android's album-art address gives a thumbnail
 * of about 512 px; this reads the picture embedded in the album's first song
 * instead. When a song has no picture, or only a small one, the album's
 * cover is found on Apple Music (same album, same artist) and kept on the
 * phone; the song files are never changed.
 */
class AlbumArtFetcher(private val context: Context, private val albumId: Long, private val options: Options) : Fetcher {
    override suspend fun fetch(): FetchResult? = withContext(Dispatchers.IO) {
        val song = firstSong() ?: return@withContext fallback()
        val embedded = runCatching {
            MediaMetadataRetriever().use { r -> r.setDataSource(context, song.uri); r.embeddedPicture }
        }.getOrNull()
        val side = embedded?.let { longestSide(it) } ?: 0
        if (side >= SMALL) return@withContext result(embedded!!)
        upgraded(song)?.let { return@withContext result(it) }
        embedded?.let { result(it) } ?: fallback()
    }

    private data class Song(val uri: android.net.Uri, val album: String, val artist: String)

    private fun firstSong(): Song? = context.contentResolver.query(
        MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
        arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.ARTIST, "album_artist"),
        android.os.Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.Audio.Media.ALBUM_ID} = ?")
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(albumId.toString()))
            putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.Audio.Media.TRACK))
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, 1)
        },
        null,
    )?.use { c ->
        if (!c.moveToFirst()) null
        else Song(ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, c.getLong(0)), c.getString(1).orEmpty(), c.getString(3)?.ifBlank { null } ?: c.getString(2).orEmpty())
    }

    /** The album's cover from Apple Music, kept on the phone; a miss is remembered for a week. */
    private suspend fun upgraded(song: Song): ByteArray? {
        if (song.album.isBlank() || song.artist.isBlank() || song.artist == "<unknown>") return null
        val dir = File(context.cacheDir, "hq-art").apply { mkdirs() }
        val file = File(dir, "$albumId.jpg")
        val miss = File(dir, "$albumId.none")
        if (file.length() > 0) return file.readBytes()
        if (miss.exists() && System.currentTimeMillis() - miss.lastModified() < 7 * 86_400_000L) return null
        // Apple allows a few lookups a second; a screen of covers waits its turn.
        val bytes = lookups.withPermit { runCatching { find(song.album, song.artist) }.getOrNull() }
        if (bytes == null) { miss.writeText(""); return null }
        file.writeBytes(bytes); miss.delete()
        return bytes
    }

    private fun find(album: String, artist: String): ByteArray? {
        val term = URLEncoder.encode("$artist ${album.substringBefore(" - ")}", "UTF-8")
        val body = http.newCall(Request.Builder().url("https://itunes.apple.com/search?entity=album&limit=15&term=$term").build()).execute().use { it.body.string() }
        val results = ((Json.parseToJsonElement(body) as? JsonObject)?.get("results") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val wanted = bare(album)
        val hit = results.firstOrNull { r ->
            bare(r.str("collectionName").orEmpty()) == wanted && YouTubeMusic.containment(YouTubeMusic.firstArtist(artist), r.str("artistName").orEmpty()) >= 0.5
        } ?: return null
        val url = hit.str("artworkUrl100")?.replace(Regex("""/\d+x\d+bb\."""), "/1400x1400bb.") ?: return null
        return http.newCall(Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null }
    }

    private fun fallback(): FetchResult? {
        val uri = ContentUris.withAppendedId(android.net.Uri.parse("content://media/external/audio/albumart"), albumId)
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull() ?: return null
        return result(bytes)
    }

    private fun result(bytes: ByteArray) = SourceFetchResult(
        ImageSource(Buffer().write(bytes), options.fileSystem), null, DataSource.DISK,
    )

    class Factory(private val context: Context) : Fetcher.Factory<coil3.Uri> {
        override fun create(data: coil3.Uri, options: Options, imageLoader: ImageLoader): Fetcher? {
            if (data.scheme != "content" || data.authority != "media") return null
            val id = data.path?.removePrefix("/external/audio/albumart/")?.takeIf { it != data.path }?.toLongOrNull() ?: return null
            return AlbumArtFetcher(context, id, options)
        }
    }

    companion object {
        /** Pictures smaller than this (longest side) are looked up in better quality. */
        private const val SMALL = 600
        private val http by lazy { AppleMusic.defaultHttp() }
        private val lookups = Semaphore(2)

        private fun longestSide(bytes: ByteArray): Int {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            return maxOf(o.outWidth, o.outHeight)
        }

        /** An album name to compare: no " - Single"/" - EP", "(Deluxe)" or punctuation. */
        private fun bare(name: String) = YouTubeMusic.normalise(name.replace(Regex("""\s+-\s+(single|ep)$""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""[(\[](deluxe|expanded|remaster(ed)?|special|anniversary)[^)\]]*[)\]]""", RegexOption.IGNORE_CASE), ""))

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}
