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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
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
        // An album Hive filed itself (WAV songs, which Android doesn't read tags from): its id is
        // minus its first song's, and the cover is read from that song's own tags.
        if (albumId < 0) return@withContext ownAlbum(-albumId)
        val hidden = runCatching { AlbumCovers(context).hidden.value }.getOrDefault(emptySet())
        if (albumId in hidden) throw IllegalStateException("Album cover $albumId is cleared")
        val songs = albumSongs(context, albumId)
        val song = songs.firstOrNull()
        if (isLooseCollection(song?.album)) {
            throw IllegalStateException("Songs in loose collections have no album cover")
        }
        val kept = File(File(context.cacheDir, "embedded-art-v2").apply { mkdirs() }, "$albumId.img")
        val smallKept = File(File(context.cacheDir, "embedded-art-v2"), "$albumId.small.img")
        val hq = File(File(context.cacheDir, "hq-art").apply { mkdirs() }, "$albumId.jpg")
        val maxModifiedMs = songs.maxOfOrNull { it.modifiedMs } ?: 0L
        // If any underlying audio file was rewritten (e.g. a new HQ cover synced from PC), invalidate stale cache.
        if (maxModifiedMs > 0L && kept.length() > 0 && maxModifiedMs > kept.lastModified()) {
            kept.delete()
            smallKept.delete()
            hq.delete()
            File(File(context.cacheDir, "hq-art"), "$albumId.differs").delete()
        }
        // Hive's own extracted copy of the album's embedded cover, kept once per album.
        if (kept.length() > 0) return@withContext result(kept.readBytes())
        // The cover is read from the album's own embedded pictures — never a stray image sitting in
        // the song's folder. On Bandcamp-style albums where some tracks have individual single art,
        // pick the majority album-wide cover so every song wears the album cover.
        val embedded = extractAlbumCover(context, songs)
        val side = embedded?.let { longestSide(it) } ?: 0
        if (embedded != null && side >= SMALL) {
            runCatching { writeAtomically(kept, embedded); smallKept.delete() }
        } else if (embedded != null && side > 0) {
            runCatching { writeAtomically(smallKept, embedded) }
        }
        // Thumbnails never fire an online lookup (a grid would start hundreds): they show the embedded
        // cover, or one already found online for this album, or nothing — never a folder image.
        if (isThumbnail()) return@withContext when {
            side > 0 -> result(embedded!!)
            hq.length() > 0 -> result(hq.readBytes())
            else -> throw IllegalStateException("No thumbnail for album $albumId")
        }
        if (side >= SMALL) return@withContext result(embedded!!)
        // Coverless or low-res: the cover is looked up on Apple Music (same album, same artist) and kept.
        // This is the only non-embedded source, and it's matched to the record, not to the folder.
        if (song != null) upgraded(song)?.let { online ->
            // A sharper copy of the same cover replaces a small one; a different picture never does.
            // The embedded cover is the one shown, and the online one is kept as the album's second
            // cover (the player turns to it; Covers offers it as a back cover).
            val differs = File(File(context.cacheDir, "hq-art"), "$albumId.differs")
            if (embedded != null && !EmbeddedPictures.looksAlike(embedded, online)) {
                runCatching { differs.writeText("") }
                return@withContext result(embedded)
            }
            differs.delete()
            return@withContext result(online)
        }
        // No embedded cover and none found online → no cover (a placeholder shows), never a folder image.
        embedded?.let { result(it) } ?: throw IllegalStateException("This album has no cover")
    }

    private fun ownAlbum(songId: Long): FetchResult? {
        val kept = File(File(context.cacheDir, "embedded-art-v2").apply { mkdirs() }, "$albumId.img")
        if (kept.length() > 0) return result(kept.readBytes())
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, songId)
        val picture = ownPicture(context, uri) ?: throw IllegalStateException("This song has no picture")
        runCatching { writeAtomically(kept, picture) }
        return result(picture)
    }

    private fun isThumbnail(): Boolean {
        fun px(d: coil3.size.Dimension) = (d as? coil3.size.Dimension.Pixels)?.px ?: Int.MAX_VALUE
        return maxOf(px(options.size.width), px(options.size.height)) <= THUMBNAIL_PX
    }

    internal data class Song(val uri: android.net.Uri, val album: String, val artist: String, val modifiedMs: Long = 0L)

    /** The album's cover from Apple Music, kept on the phone; a miss is remembered for a week. */
    private suspend fun upgraded(song: Song): ByteArray? {
        if (song.album.isBlank() || song.artist.isBlank() || song.artist == "<unknown>") return null
        val dir = File(context.cacheDir, "hq-art").apply { mkdirs() }
        val file = File(dir, "$albumId.jpg")
        val miss = File(dir, "$albumId.none")
        if (file.length() > 0) return file.readBytes()
        val albumMutex = albumLocks.computeIfAbsent(albumId) { kotlinx.coroutines.sync.Mutex() }
        return albumMutex.withLock {
            if (file.length() > 0) return@withLock file.readBytes()
            if (miss.exists() && System.currentTimeMillis() - miss.lastModified() < 7 * 86_400_000L) return@withLock null
            // Apple allows a few lookups a second; a screen of covers waits its turn.
            val bytes = lookups.withPermit { runCatching { find(song.album, song.artist) }.getOrNull() }
            if (bytes == null) { miss.writeText(""); return@withLock null }
            writeAtomically(file, bytes)
            miss.delete()
            _onlineCoverVersion.value += 1
            bytes
        }
    }

    private fun find(album: String, artist: String): ByteArray? {
        val term = URLEncoder.encode("$artist ${album.substringBefore(" - ")}", "UTF-8")
        val body = http.newCall(Request.Builder().url("https://itunes.apple.com/search?entity=album&limit=15&term=$term").build()).execute().use { it.body.string() }
        val results = ((Json.parseToJsonElement(body) as? JsonObject)?.get("results") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val wanted = bare(album)
        val hit = results.firstOrNull { r ->
            bare(r.str("collectionName").orEmpty()) == wanted && com.local.hive.mobile.data.containment(com.local.hive.mobile.data.firstArtist(artist), r.str("artistName").orEmpty()) >= 0.5
        } ?: return null
        val url = hit.str("artworkUrl100")?.replace(Regex("""/\d+x\d+bb\."""), "/1400x1400bb.") ?: return null
        return http.newCall(Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null }
    }

    private fun result(bytes: ByteArray) = SourceFetchResult(
        ImageSource(Buffer().write(bytes), options.fileSystem), null, DataSource.DISK,
    )

    class Factory(private val context: Context) : Fetcher.Factory<coil3.Uri> {
        override fun create(data: coil3.Uri, options: Options, imageLoader: ImageLoader): Fetcher? {
            if (data.scheme != "content" || data.authority != "media") return null
            SongArtFetcher.songId(data.path)?.let { return SongArtFetcher(context, it, options) }
            // Hive's own album ids (for WAV songs) are negative.
            val id = data.path?.removePrefix("/external/audio/albumart/")?.takeIf { it != data.path }?.toLongOrNull() ?: return null
            return AlbumArtFetcher(context, id, options)
        }
    }

    companion object {
        /** Pictures smaller than this (longest side) are looked up in better quality. */
        private const val SMALL = 600
        /** Requests up to this size (a 44 dp row is ~130 px) take the thumbnail path. */
        private const val THUMBNAIL_PX = 256
        private val http by lazy { com.local.hive.mobile.data.defaultHttp() }
        private val lookups = Semaphore(2)
        private val albumLocks = java.util.concurrent.ConcurrentHashMap<Long, kotlinx.coroutines.sync.Mutex>()
        private val _onlineCoverVersion = kotlinx.coroutines.flow.MutableStateFlow(0)
        /** Incremented whenever a new online album cover is cached, so previously failed thumbnails retry. */
        val onlineCoverVersion: kotlinx.coroutines.flow.StateFlow<Int> = _onlineCoverVersion

        /** Covers past this size (longest side) are shrunk to it before they're kept and shown. */
        private const val LARGEST = 1600

        internal fun writeAtomically(target: File, bytes: ByteArray) {
            val parent = target.parentFile ?: return
            parent.mkdirs()
            val tmp = File(parent, "${target.name}.${Thread.currentThread().id}.${System.nanoTime()}.tmp")
            try {
                tmp.writeBytes(bytes)
                if (!tmp.renameTo(target)) {
                    target.writeBytes(bytes)
                    tmp.delete()
                }
            } catch (t: Throwable) {
                tmp.delete()
                throw t
            }
        }

        internal fun isLooseCollection(album: String?): Boolean =
            album.equals("beautiful sounds pc", ignoreCase = true) || album.isNullOrBlank() || album.equals("<unknown>", ignoreCase = true)

        /**
         * Picks the album-wide cover from a list of track covers: when tracks share a majority cover
         * (e.g. a Bandcamp album where 6 of 9 songs share the album art and 3 carry track-specific
         * single art), returns the majority cover — even if track 1 has its own single cover.
         * Ties break by earliest track order.
         */
        fun pickMajorityCover(
            covers: List<ByteArray>,
            same: (ByteArray, ByteArray) -> Boolean = EmbeddedPictures::looksAlike,
        ): ByteArray? {
            if (covers.isEmpty()) return null
            if (covers.size <= 2) return covers.first()
            // Fast path (normal albums): if tracks 1 and 2 agree, that is the album cover.
            if (same(covers[0], covers[1])) return covers[0]
            val groups = mutableListOf<MutableList<ByteArray>>()
            for (c in covers) {
                val match = groups.firstOrNull { g -> same(g.first(), c) }
                if (match != null) match += c else groups += mutableListOf(c)
            }
            return groups.maxByOrNull { it.size }?.first()
        }

        internal fun albumSongs(context: Context, albumId: Long, limit: Int = 10): List<Song> {
            val out = mutableListOf<Song>()
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.ALBUM, MediaStore.Audio.Media.ARTIST, "album_artist", MediaStore.Audio.Media.DATE_MODIFIED),
                android.os.Bundle().apply {
                    putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.Audio.Media.ALBUM_ID} = ?")
                    putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(albumId.toString()))
                    putStringArray(android.content.ContentResolver.QUERY_ARG_SORT_COLUMNS, arrayOf(MediaStore.Audio.Media.TRACK))
                    putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
                },
                null,
            )?.use { c ->
                while (c.moveToNext()) {
                    out += Song(
                        ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, c.getLong(0)),
                        c.getString(1).orEmpty(),
                        c.getString(3)?.ifBlank { null } ?: c.getString(2).orEmpty(),
                        modifiedMs = c.getLong(4) * 1000L,
                    )
                }
            }
            return out
        }

        internal fun ownPicture(context: Context, uri: android.net.Uri): ByteArray? =
            runCatching { context.contentResolver.openInputStream(uri)?.use { EmbeddedPictures.readTyped(it) } }.getOrNull()
                ?.let(EmbeddedPictures::bestBytes)?.let(::fitted)

        private fun readSongCover(context: Context, song: Song): ByteArray? =
            ownPicture(context, song.uri)
                ?: runCatching { MediaMetadataRetriever().use { r -> r.setDataSource(context, song.uri); r.embeddedPicture } }.getOrNull()?.let(::fitted)

        internal fun extractAlbumCover(context: Context, songs: List<Song>): ByteArray? {
            if (songs.isEmpty()) return null
            val first = readSongCover(context, songs[0])
            if (songs.size <= 2) return first ?: songs.getOrNull(1)?.let { readSongCover(context, it) }
            val second = readSongCover(context, songs[1])
            if (first != null && second != null && EmbeddedPictures.looksAlike(first, second)) return first
            val collected = mutableListOf<ByteArray>()
            if (first != null) collected += first
            if (second != null) collected += second
            for (i in 2 until songs.size) {
                readSongCover(context, songs[i])?.let { collected += it }
            }
            return pickMajorityCover(collected)
        }

        /**
         * Returns the cached file holding the album's displayed cover (extracting it once if not yet
         * cached), or null when the album is a loose collection, hidden, or has no embedded/HQ cover.
         */
        fun albumCoverFile(context: Context, albumId: Long): File? {
            if (albumId <= 0L) return null
            val hidden = runCatching { AlbumCovers(context).hidden.value }.getOrDefault(emptySet())
            if (albumId in hidden) return null
            val dir = File(context.cacheDir, "embedded-art-v2").apply { mkdirs() }
            val kept = File(dir, "$albumId.img")
            val smallKept = File(dir, "$albumId.small.img")
            val hqDir = File(context.cacheDir, "hq-art")
            val hq = File(hqDir, "$albumId.jpg")
            if (kept.length() > 0) return kept
            if (hq.length() > 0 && !File(hqDir, "$albumId.differs").exists()) return hq
            if (smallKept.length() > 0) return smallKept
            val songs = albumSongs(context, albumId)
            val first = songs.firstOrNull() ?: return null
            if (isLooseCollection(first.album)) return null
            val embedded = extractAlbumCover(context, songs) ?: return null
            val side = longestSide(embedded)
            if (side <= 0) return null
            return if (side >= SMALL) {
                runCatching { kept.writeBytes(embedded); kept }.getOrNull()
            } else {
                runCatching { smallKept.writeBytes(embedded); smallKept }.getOrNull()
            }
        }

        /**
         * A picture at a size worth keeping: as it is up to [LARGEST] px, shrunk past it (a poster-sized
         * cover would otherwise cost tens of megabytes to show), or null when it isn't a picture.
         */
        internal fun fitted(bytes: ByteArray): ByteArray? {
            val side = longestSide(bytes)
            if (side <= 0) return null
            if (side <= LARGEST) return bytes
            var sample = 1
            while (side / (sample * 2) >= LARGEST) sample *= 2
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            val scale = LARGEST.toFloat() / maxOf(decoded.width, decoded.height)
            val sized = if (scale < 1f) android.graphics.Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true) else decoded
            return java.io.ByteArrayOutputStream().use { out -> sized.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, out); out.toByteArray() }
        }

        private fun longestSide(bytes: ByteArray): Int {
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            return maxOf(o.outWidth, o.outHeight)
        }

        /** An album name to compare: no " - Single"/" - EP", "(Deluxe)" or punctuation. */
        private fun bare(name: String) = com.local.hive.mobile.data.normalise(name.replace(Regex("""\s+-\s+(single|ep)$""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""[(\[](deluxe|expanded|remaster(ed)?|special|anniversary)[^)\]]*[)\]]""", RegexOption.IGNORE_CASE), ""))

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}

/**
 * One song's own picture, never its album's: a song without one shows none. Read straight from the file's
 * embedded art, because Android's own audio thumbnail is the album's art, which a coverless song must not
 * borrow (MediaStore even scrapes a stray image in the song's folder as that invented album's cover).
 */
class SongArtFetcher(private val context: Context, private val songId: Long, private val options: Options) : Fetcher {
    override suspend fun fetch(): FetchResult? = withContext(Dispatchers.IO) {
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, songId)
        // The song's OWN embedded picture only. Not loadThumbnail(): for audio that returns the song's
        // *album* art, and for a tag-less song MediaStore invents an album from the folder name and
        // scrapes any stray image sitting in that folder as its cover — so a coverless song would wear a
        // neighbour's picture (e.g. a lone bjork.jpg in the folder). No embedded picture → no picture.
        val bytes = runCatching { context.contentResolver.openInputStream(uri)?.use { EmbeddedPictures.readTyped(it) } }.getOrNull()
                ?.let(EmbeddedPictures::bestBytes)?.let(AlbumArtFetcher::fitted)
            ?: runCatching { MediaMetadataRetriever().use { r -> r.setDataSource(context, uri); r.embeddedPicture } }.getOrNull()?.let(AlbumArtFetcher::fitted)
            ?: throw IllegalStateException("This song has no picture")
        SourceFetchResult(ImageSource(Buffer().write(bytes), options.fileSystem), null, DataSource.DISK)
    }

    companion object {
        private val path = Regex("""^/external/audio/media/(\d+)/albumart$""")
        fun songId(p: String?): Long? = p?.let { path.matchEntire(it) }?.groupValues?.get(1)?.toLongOrNull()
    }
}
