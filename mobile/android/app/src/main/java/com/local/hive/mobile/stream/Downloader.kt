package com.local.hive.mobile.stream

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.provider.MediaStore
import com.local.hive.mobile.data.Mp4Tags
import com.local.hive.mobile.data.SongTags
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer

/**
 * Saves a streamed song to the phone, as Hive's desktop does: the song as
 * YouTube Music has it (its AAC audio), repacked into an ordinary .m4a,
 * tagged with what Apple Music or Spotify said about it and its cover, in
 * Music/Hive. Android files it like any other song, and the library picks
 * it up.
 */
class Downloader(private val context: Context, private val youTube: YouTubeMusic, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val _active = MutableStateFlow<Set<String>>(emptySet())
    /** Keys of the songs being saved right now. */
    val active: StateFlow<Set<String>> = _active.asStateFlow()

    suspend fun save(song: WantedSong, artworkUrl: String?, year: String = ""): Uri = withContext(Dispatchers.IO) {
        if (song.key in _active.value) throw IOException("“${song.title}” is already being saved.")
        _active.update { it + song.key }
        val work = File(context.cacheDir, "downloads").apply { mkdirs() }
        val raw = File(work, "${song.key.hashCode()}.raw.m4a")
        val plain = File(work, "${song.key.hashCode()}.m4a")
        try {
            fetch(song, raw)
            remux(raw, plain)
            // The biggest cover the service has: Apple's art at 1400 px, Spotify's at 640.
            val best = artworkUrl?.replace(Regex("""/\d+x\d+bb\."""), "/1400x1400bb.")?.let(Spotify::largest)
            val cover = best?.takeIf { it.startsWith("http") }?.let { url ->
                runCatching { http.newCall(Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null } }.getOrNull()
            }
            val tagged = Mp4Tags.write(plain.readBytes(), SongTags(song.title, song.artist, song.album, song.artist.substringBefore(", "), year, cover = cover))
            publish(song, tagged)
        } finally {
            raw.delete(); plain.delete()
            _active.update { it - song.key }
        }
    }

    /** The whole file, asked for with a range so YouTube sends it at full speed; a refused link is fetched again once. */
    private fun fetch(song: WantedSong, into: File) {
        for (attempt in 0..1) {
            if (attempt == 1) youTube.invalidate(song.key)
            val request = Request.Builder().url(youTube.downloadUrl(song)).header("Range", "bytes=0-").build()
            http.newCall(request).execute().use { res ->
                if (res.code == 403 || res.code == 410) return@use
                if (!res.isSuccessful) throw IOException("YouTube answered ${res.code}")
                into.outputStream().use { out -> res.body.byteStream().copyTo(out) }
                if (into.length() > 0) return
            }
        }
        throw IOException("YouTube wouldn't send “${song.title}”.")
    }

    /** YouTube's audio comes in fragments; an ordinary MP4 holds the song's length where every player looks for it. */
    private fun remux(from: File, to: File) {
        val extractor = MediaExtractor()
        var muxer: MediaMuxer? = null
        try {
            extractor.setDataSource(from.path)
            val track = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: throw IOException("The download has no audio in it.")
            extractor.selectTrack(track)
            muxer = MediaMuxer(to.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val out = muxer.addTrack(extractor.getTrackFormat(track))
            muxer.start()
            val buffer = ByteBuffer.allocate(1 shl 20)
            val info = MediaCodec.BufferInfo()
            while (true) {
                val size = extractor.readSampleData(buffer, 0)
                if (size < 0) break
                info.set(0, size, extractor.sampleTime, if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                muxer.writeSampleData(out, buffer, info)
                extractor.advance()
            }
            muxer.stop()
        } finally {
            runCatching { muxer?.release() }
            extractor.release()
        }
    }

    private fun publish(song: WantedSong, bytes: ByteArray): Uri {
        val resolver = context.contentResolver
        val name = "${song.artist.substringBefore(", ")} - ${song.title}".replace(Regex("""[\\/:*?"<>|]+"""), "_").take(120).trim() + ".m4a"
        val values = ContentValues().apply {
            put(MediaStore.Audio.Media.DISPLAY_NAME, name)
            put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4")
            put(MediaStore.Audio.Media.RELATIVE_PATH, "Music/Hive")
            put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values) ?: throw IOException("Android wouldn't make room for the song.")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IOException("Couldn't write the song.")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return uri
    }
}
