package com.local.hive.mobile.data

import kotlinx.serialization.Serializable
import java.text.Normalizer

/** The player mediaId prefix for a song played from the paired PC's library (e.g. "pc:1234"). */
const val PC_MEDIA_PREFIX = "pc:"

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

/** Streamed songs a heart applies to; podcasts and radio have none. */
fun lovableStream(mediaId: String?) =
    mediaId != null && (mediaId.startsWith("am:") || mediaId.startsWith("sp:") || mediaId.startsWith(PC_MEDIA_PREFIX))

/** Where Hive on the PC plays the song from (YouTube Music, by the Apple or Spotify id), or "" for a PC library song. */
fun streamPathFor(mediaId: String): String = when {
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
fun streamLoveKey(artist: String, title: String) = norm(artist.split(artistSplit).first()) + "|" + norm(title)

/**
 * The heart for a playing item: a library song's Love, else its streamed like (for a PC song not liked
 * or unliked on the phone, Hive's own Love), or null for what takes none (radio, podcasts, nothing).
 */
fun heartFor(mediaId: String?, title: String, artist: String, loved: Set<Long>, likes: Map<String, StreamLove>, pcLoved: Set<String>): Boolean? {
    mediaId?.substringAfterLast('|')?.toLongOrNull()?.let { return it in loved }
    if (!lovableStream(mediaId) || title.isBlank()) return null
    likes[streamLoveKey(artist, title)]?.let { return it.loved }
    return mediaId!!.startsWith(PC_MEDIA_PREFIX) && mediaId.removePrefix(PC_MEDIA_PREFIX) in pcLoved
}
