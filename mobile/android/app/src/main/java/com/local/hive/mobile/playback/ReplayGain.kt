package com.local.hive.mobile.playback

import androidx.media3.common.Metadata
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.extractor.metadata.id3.InternalFrame
import androidx.media3.extractor.metadata.id3.TextInformationFrame
import androidx.media3.extractor.metadata.vorbis.VorbisComment
import kotlin.math.pow

/**
 * ReplayGain as Hive applies it: the song's (or album's) gain from its tags,
 * held under 1/peak by the clipping guard and never more than 8x, as on the PC.
 */
@UnstableApi
object ReplayGain {
    /** REPLAYGAIN_* values from the playing song's tags (ID3 TXXX, Vorbis comments, MP4 freeform). */
    fun tagsOf(tracks: Tracks): Map<String, String> {
        val out = mutableMapOf<String, String>()
        for (group in tracks.groups) {
            if (group.type != androidx.media3.common.C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until group.length) {
                val metadata: Metadata = group.getTrackFormat(i).metadata ?: continue
                for (k in 0 until metadata.length()) {
                    when (val e = metadata.get(k)) {
                        is TextInformationFrame -> if (e.id == "TXXX") e.description?.let { d -> e.values.firstOrNull()?.let { out[d.uppercase()] = it } }
                        is VorbisComment -> out[e.key.uppercase()] = e.value
                        is InternalFrame -> out[e.description.uppercase()] = e.text
                    }
                }
            }
        }
        return out.filterKeys { it.startsWith("REPLAYGAIN_") }
    }

    /** The linear gain for the song under [mode], or 1 for none. */
    fun linear(tags: Map<String, String>, mode: String, clippingGuard: Boolean): Float {
        if (mode == "off" || tags.isEmpty()) return 1f
        fun db(key: String) = tags[key]?.replace(Regex("(?i)db"), "")?.trim()?.toFloatOrNull()
        fun peak(key: String) = tags[key]?.trim()?.toFloatOrNull()?.takeIf { it > 0 }
        val album = mode == "album"
        val gainDb = (if (album) db("REPLAYGAIN_ALBUM_GAIN") else null) ?: db("REPLAYGAIN_TRACK_GAIN") ?: return 1f
        val peakValue = (if (album) peak("REPLAYGAIN_ALBUM_PEAK") else null) ?: peak("REPLAYGAIN_TRACK_PEAK")
        var gain = 10f.pow(gainDb / 20f).coerceAtMost(8f)
        if (clippingGuard && peakValue != null) gain = minOf(gain, 1f / peakValue)
        return gain.coerceIn(0f, 8f)
    }

    /** MusicBee's "Smart": album gain while an album plays in order (a neighbour is from the same album, shuffle off). */
    fun smartUsesAlbum(player: Player): Boolean {
        if (player.shuffleModeEnabled) return false
        fun key(i: Int) = player.getMediaItemAt(i).mediaMetadata.let { m -> m.albumTitle?.toString().orEmpty().lowercase() + "\u0000" + (m.albumArtist ?: m.artist)?.toString().orEmpty().lowercase() }
        val i = player.currentMediaItemIndex
        if (i !in 0 until player.mediaItemCount || player.getMediaItemAt(i).mediaMetadata.albumTitle.isNullOrBlank()) return false
        val own = key(i)
        return listOf(i - 1, i + 1).any { it in 0 until player.mediaItemCount && key(it) == own }
    }
}
