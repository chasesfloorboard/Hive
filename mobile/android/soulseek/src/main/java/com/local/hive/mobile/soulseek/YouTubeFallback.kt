package com.local.hive.mobile.soulseek

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import com.local.hive.mobile.stream.WantedSong
import okhttp3.OkHttpClient
import okhttp3.Request
import org.jaudiotagger.audio.AudioFileIO
import org.jaudiotagger.tag.FieldKey
import org.jaudiotagger.tag.TagOptionSingleton
import org.jaudiotagger.tag.images.AndroidArtwork
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer

/**
 * A song nobody on Soulseek has: from YouTube instead, as Hive on the PC does
 * it. YouTube's AAC comes as fragmented MP4, which tags can't safely be written
 * into, so its audio is repacked (not re-encoded) into a plain M4A, then
 * tagged with what the streaming service said: title, artist, album, year and
 * the cover.
 */
object YouTubeFallback {
    init { TagOptionSingleton.getInstance().isAndroid = true }

    /** Saves [track] into [dir] as a tagged .m4a and returns it. Blocking. */
    fun fetch(context: Context, artist: String, album: String, track: SoulseekRequest.Track, dir: File, progress: (Long, Long) -> Unit = { _, _ -> }): File {
        val app = context.applicationContext as SoulseekHost
        val who = track.artist.ifBlank { artist }
        val from = track.album.ifBlank { album }
        val key = "dl:${AlbumPicker.norm(who)}|${AlbumPicker.norm(track.title)}"
        val stem = key.hashCode().toUInt().toString(16)
        dir.mkdirs()
        val raw = File(dir, "yt-$stem.dash")
        val out = File(dir, "yt-$stem.m4a")
        try {
            app.youTubeMusic.saveAudio(WantedSong(key, track.title, who, from, track.durationMs), raw, progress)
            remux(raw, out)
            val cover = track.artworkUrl.takeIf { it.startsWith("https://") }?.let { runCatching { image(it) }.getOrNull() }
            tag(out, track.title, who, from, track.year, cover)
        } catch (e: Exception) {
            out.delete()
            throw e
        } finally {
            raw.delete()
        }
        return out
    }

    /** The audio of [input] (any container Android reads) into a plain, unfragmented MP4 at [output]: the same samples, not re-encoded. */
    fun remux(input: File, output: File) {
        val extractor = MediaExtractor()
        var muxer: MediaMuxer? = null
        try {
            extractor.setDataSource(input.path)
            val index = (0 until extractor.trackCount).firstOrNull { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                ?: throw IOException("No audio in the download")
            extractor.selectTrack(index)
            val format = extractor.getTrackFormat(index)
            val m = MediaMuxer(output.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4).also { muxer = it }
            val track = m.addTrack(format)
            m.start()
            val buffer = ByteBuffer.allocate(maxOf(format.takeIf { it.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) }?.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) ?: 0, 256 * 1024))
            val info = MediaCodec.BufferInfo()
            var samples = 0
            while (true) {
                val size = extractor.readSampleData(buffer, 0)
                if (size < 0) break
                val flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                info.set(0, size, extractor.sampleTime, flags)
                m.writeSampleData(track, buffer, info)
                samples++
                extractor.advance()
            }
            if (samples == 0) throw IOException("The download had no audio in it")
            m.stop()
        } finally {
            runCatching { muxer?.release() }
            extractor.release()
        }
    }

    private fun tag(file: File, title: String, artist: String, album: String, year: String, cover: ByteArray?) {
        val audio = AudioFileIO.read(file)
        val tag = audio.tagOrCreateAndSetDefault
        fun set(key: FieldKey, value: String) { if (value.isNotBlank()) tag.setField(key, value.trim()) }
        set(FieldKey.TITLE, title); set(FieldKey.ARTIST, artist); set(FieldKey.ALBUM, album); set(FieldKey.YEAR, year)
        if (cover != null) tag.setField(AndroidArtwork().apply {
            binaryData = cover
            mimeType = if (cover.size > 3 && cover[0] == 0x89.toByte()) "image/png" else "image/jpeg"
            pictureType = 3
        })
        audio.commit()
        val back = AudioFileIO.read(file)
        if (back.tag?.getFirst(FieldKey.TITLE).orEmpty() != title.trim()) throw IOException("The tags didn't stick in the download")
    }

    private val http by lazy { OkHttpClient.Builder().connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS).readTimeout(20, java.util.concurrent.TimeUnit.SECONDS).build() }

    private fun image(url: String): ByteArray = http.newCall(Request.Builder().url(url).build()).execute().use { res ->
        if (!res.isSuccessful) throw IOException("Cover: ${res.code}")
        res.body.bytes().also { if (it.size > 20 * 1024 * 1024) throw IOException("Cover too large") }
    }
}
