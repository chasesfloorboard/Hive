package com.local.hive.mobile.link

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.text.Normalizer

/** A liked (or unliked) streamed song, as Hive on the PC keeps it. [duration] is in seconds. */
@Serializable data class StreamLove(
    val loved: Boolean = true,
    val at: Long = 0,
    val path: String = "",
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val duration: Double = 0.0,
    val artworkUrl: String = "",
    /** When the PC last gave this like to a file of the same song there. */
    val appliedAt: Long = 0,
)
@Serializable data class StreamLoveChange(
    val title: String, val artist: String, val album: String, val loved: Boolean, val at: Long,
    val path: String, val duration: Double, val artworkUrl: String,
)
@Serializable private data class SavedStreamLoves(
    val loves: Map<String, StreamLove> = emptyMap(),
    /** Changed here, not yet taken by the PC. */
    val pending: Set<String> = emptySet(),
    /** When each like last reached this phone's own copy of the song. */
    val appliedHere: Map<String, Long> = emptyMap(),
)

/**
 * Likes for streamed songs (Apple Music, Spotify, and Hive's songs played
 * from the PC), shared with Hive on the PC, which keeps them in its settings
 * (app/main/stream-loves.js there). They go by artist + title, so a song
 * liked while streaming stays liked wherever it plays, and the copy that
 * later lands in either library (a download, song sync) gets the like.
 * Unliking keeps the song as loved = false so the other side hears of it;
 * the newest change wins.
 */
class StreamLoves(context: Context) {
    private val file = File(context.filesDir, "stream-loves.json")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private var saved = runCatching { json.decodeFromString(SavedStreamLoves.serializer(), file.readText()) }.getOrDefault(SavedStreamLoves())
    private val _loves = MutableStateFlow(saved.loves)
    val loves: StateFlow<Map<String, StreamLove>> = _loves.asStateFlow()

    fun isLoved(artist: String, title: String): Boolean = _loves.value[key(artist, title)]?.loved == true

    /** A heart tapped on a streamed song ([mediaId] is the player's: "am:", "sp:", "pc:"). */
    fun set(title: String, artist: String, album: String, durationMs: Long, artworkUrl: String, mediaId: String, loved: Boolean) = synchronized(this) {
        val k = key(artist, title)
        if (k.endsWith("|") || k.startsWith("|")) return
        val old = saved.loves[k]
        val entry = (old ?: StreamLove()).copy(
            loved = loved, at = System.currentTimeMillis(),
            path = old?.path?.ifBlank { null } ?: pathFor(mediaId),
            title = old?.title?.ifBlank { null } ?: title,
            artist = old?.artist?.ifBlank { null } ?: artist,
            album = old?.album?.ifBlank { null } ?: album,
            duration = old?.duration?.takeIf { it > 0 } ?: durationMs / 1000.0,
            artworkUrl = old?.artworkUrl?.ifBlank { null } ?: artworkUrl.takeIf { it.startsWith("http") }.orEmpty(),
        )
        save(saved.copy(loves = saved.loves + (k to entry), pending = saved.pending + k))
    }

    fun pendingChanges(): List<StreamLoveChange> = synchronized(this) {
        saved.pending.mapNotNull { k -> saved.loves[k]?.let { StreamLoveChange(it.title, it.artist, it.album, it.loved, it.at, it.path, it.duration, it.artworkUrl) } }
    }

    /** The PC's likes after a sync: each song takes the newer side; a change the PC now holds is no longer pending. */
    fun mergeFromPc(pc: Map<String, StreamLove>) = synchronized(this) {
        val loves = saved.loves.toMutableMap()
        val pending = saved.pending.toMutableSet()
        for ((k, theirs) in pc) {
            val mine = loves[k]
            if (mine != null && k in pending && mine.at > theirs.at) continue
            loves[k] = theirs
            pending -= k
        }
        if (loves != saved.loves || pending != saved.pending) save(saved.copy(loves = loves, pending = pending))
    }

    /** Likes (and unlikes) not yet given to this phone's own copy of the song. */
    fun waitingForFiles(): Map<String, StreamLove> = synchronized(this) {
        saved.loves.filter { (k, e) -> (saved.appliedHere[k] ?: 0) < e.at }
    }

    fun markApplied(keys: Map<String, Long>) = synchronized(this) {
        if (keys.isNotEmpty()) save(saved.copy(appliedHere = saved.appliedHere + keys))
    }

    private fun save(next: SavedStreamLoves) {
        saved = next
        _loves.value = next.loves
        runCatching { file.writeText(json.encodeToString(SavedStreamLoves.serializer(), next)) }
    }

    companion object {
        /** Streamed songs a heart applies to; podcasts and radio have none. */
        fun lovable(mediaId: String?) = mediaId != null && (mediaId.startsWith("am:") || mediaId.startsWith("sp:") || mediaId.startsWith(PcLibrary.MEDIA_PREFIX))

        /** Where Hive on the PC plays the song from (YouTube Music, found by the Apple or Spotify id), or "" for a PC library song. */
        fun pathFor(mediaId: String): String = when {
            mediaId.startsWith("am:") -> "ytm:apple:" + mediaId.removePrefix("am:")
            mediaId.startsWith("sp:") -> "ytm:spotify:" + mediaId.removePrefix("sp:")
            else -> ""
        }

        private val marks = Regex("[̀-ͯ]")
        private val featuring = Regex("""[(\[](feat\.?|ft\.?|with)[^)\]]*[)\]]""")
        // Letters of any script count (a Korean or Japanese title has a key); other Latin letters (ø, ß) are dropped as before, so older keys still match.
        private val notAlnum = Regex("""[^a-z0-9\p{L}\p{N}]+|(?![a-z])\p{IsLatin}""")
        private val artistSplit = Regex(""",|&| feat\.? | ft\.? """, RegexOption.IGNORE_CASE)

        private fun norm(v: String) = Normalizer.normalize(v.lowercase(), Normalizer.Form.NFKD)
            .replace(marks, "").replace(featuring, " ").replace(notAlnum, "")

        /** The PC's streamLoveKey: first artist and title, lower case, letters and digits only, "(feat. …)" dropped. */
        fun key(artist: String, title: String) = norm(artist.split(artistSplit).first()) + "|" + norm(title)
    }
}

/**
 * The heart for a playing item: a library song's Love, else its streamed
 * like (for a PC song not liked or unliked on the phone, Hive's own Love),
 * or null for what takes none (radio, podcasts, nothing playing).
 */
fun heartFor(mediaId: String?, title: String, artist: String, loved: Set<Long>, likes: Map<String, StreamLove>, pcLoved: Set<String>): Boolean? {
    mediaId?.substringAfterLast('|')?.toLongOrNull()?.let { return it in loved }
    if (!StreamLoves.lovable(mediaId) || title.isBlank()) return null
    likes[StreamLoves.key(artist, title)]?.let { return it.loved }
    return mediaId!!.startsWith(PcLibrary.MEDIA_PREFIX) && mediaId.removePrefix(PcLibrary.MEDIA_PREFIX) in pcLoved
}
