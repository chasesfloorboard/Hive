package com.local.hive.mobile.soulseek

import java.text.Normalizer
import kotlin.math.abs
import kotlin.math.ln

/** A song to find: its title and length (0 when unknown). */
data class WantedTrack(val title: String, val durationMs: Long = 0)

/** Which files to prefer when an album is shared in several formats. */
enum class Quality { Lossless, Mp3 }

/** One peer's folder that holds the album (or song): which of its files is which wanted track. */
data class Pick(val user: String, val folder: String, val files: Map<Int, SharedFile>, val score: Double, val freeSlot: Boolean, val format: String)

/**
 * Picks where to download an album from, out of everyone's search results:
 * each peer's album folder (CD1/CD2 subfolders counted together, one format
 * at a time), matched against the album's tracklist by title and length.
 * Folders missing much of the album are left out; the rest are ranked by how
 * much of it they have, the format, and how soon the peer can send.
 */
object AlbumPicker {
    private val audio = setOf("flac", "mp3", "m4a", "aac", "ogg", "opus", "wav", "aiff", "aif", "alac")
    private val disc = Regex("""^(cd|disc|disk)\s*\d+.*$""", RegexOption.IGNORE_CASE)
    private val leadingNumber = Regex("""^\s*(\d{1,3}[\s._-]+|\d-\d{1,2}[\s._-]+|[a-d]\d{1,2}[\s._-]+)""", RegexOption.IGNORE_CASE)
    private val featuring = Regex("""[(\[](feat\.?|ft\.?|with)[^)\]]*[)\]]""", RegexOption.IGNORE_CASE)

    fun norm(v: String) = Normalizer.normalize(v.lowercase(), Normalizer.Form.NFKD)
        .replace(Regex("[̀-ͯ]"), "").replace(featuring, " ").replace(Regex("[^a-z0-9]+"), "")

    /** A file's song title as its name gives it: no extension, track number or artist prefix. */
    fun titleOf(fileName: String, artist: String): String {
        var t = fileName.substringBeforeLast('.')
        t = t.replace(leadingNumber, "")
        val a = norm(artist)
        val dash = Regex("""\s[-–]\s""").find(t)
        if (dash != null && a.isNotEmpty() && norm(t.substring(0, dash.range.first)).let { it.contains(a) || a.contains(it) && it.length >= 3 }) t = t.substring(dash.range.last + 1)
        return t.replace(leadingNumber, "")
    }

    fun candidates(artist: String, wanted: List<WantedTrack>, results: List<SearchResult>, quality: Quality = Quality.Lossless): List<Pick> {
        if (wanted.isEmpty()) return emptyList()
        val single = wanted.size == 1
        val picks = mutableListOf<Pick>()
        for (r in results) {
            val groups = r.files.filter { it.extension in audio }.groupBy { f ->
                val folder = f.folder
                val album = if (disc.matches(folder.substringAfterLast('\\'))) folder.substringBeforeLast('\\', folder) else folder
                album to formatOf(f)
            }
            for ((key, files) in groups) {
                val matched = match(artist, wanted, files)
                val coverage = matched.size.toDouble() / wanted.size
                if (single && matched.isEmpty()) continue
                if (!single && (coverage < 0.75 || matched.size < minOf(wanted.size, 2))) continue
                val score = coverage * 100 + formatScore(key.second, quality) +
                    (if (r.freeSlot) 25 else 0) + (ln(1.0 + r.speed / 1024.0) * 1.2).coerceAtMost(12.0) - (r.queue.coerceAtMost(50) / 5.0) -
                    // A whole discography shared as one folder is slower to sift and often mislabelled.
                    (if (!single && files.size > wanted.size * 3) 10 else 0)
                picks += Pick(r.user, key.first, matched, score, r.freeSlot, key.second)
            }
        }
        return picks.sortedByDescending { it.score }
    }

    private fun formatOf(f: SharedFile): String = when (f.extension) {
        "flac", "alac", "wav", "aiff", "aif" -> if (f.bitDepth > 16) "lossless-hi" else "lossless"
        "mp3" -> when { f.bitrate >= 315 && !f.vbr -> "mp3-320"; f.bitrate >= 220 -> "mp3-v0"; f.bitrate >= 190 -> "mp3-256"; f.bitrate == 0 -> "mp3"; else -> "mp3-low" }
        "m4a", "aac" -> if (f.bitrate in 1..200) "aac-low" else "aac"
        else -> "other"
    }

    private fun formatScore(format: String, quality: Quality) = when (quality) {
        Quality.Lossless -> when (format) { "lossless" -> 30; "lossless-hi" -> 27; "mp3-320" -> 22; "mp3-v0" -> 20; "aac" -> 16; "mp3-256" -> 15; "mp3" -> 10; else -> 0 }
        Quality.Mp3 -> when (format) { "mp3-320" -> 30; "mp3-v0" -> 28; "mp3-256" -> 22; "lossless" -> 18; "aac" -> 18; "lossless-hi" -> 15; "mp3" -> 12; else -> 0 }
    }

    /** Which file is which wanted track: by title (and length when both are known), else, for a folder of exactly the album, in order by length. */
    fun match(artist: String, wanted: List<WantedTrack>, files: List<SharedFile>): Map<Int, SharedFile> {
        val names = files.map { norm(titleOf(it.name, artist)) }
        val used = BooleanArray(files.size)
        val out = HashMap<Int, SharedFile>()
        fun lengthOk(w: WantedTrack, f: SharedFile) = w.durationMs <= 0 || f.lengthSec <= 0 || abs(w.durationMs / 1000.0 - f.lengthSec) <= 4.0
        wanted.forEachIndexed { i, w ->
            val t = norm(w.title)
            if (t.isEmpty()) return@forEachIndexed
            val best = files.indices.filter { j -> !used[j] && lengthOk(w, files[j]) && names[j].isNotEmpty() && (names[j] == t || names[j].contains(t) || (t.contains(names[j]) && names[j].length >= 4)) }
                .minByOrNull { j -> (if (names[j] == t) 0 else 1000) + abs(names[j].length - t.length) + (if (w.durationMs > 0 && files[j].lengthSec > 0) abs(w.durationMs / 1000 - files[j].lengthSec).toInt() else 0) }
            if (best != null) { used[best] = true; out[i] = files[best] }
        }
        if (out.size < wanted.size && files.size == wanted.size && wanted.all { it.durationMs > 0 }) {
            val ordered = files.sortedBy { it.path.lowercase() }
            if (ordered.indices.all { i -> ordered[i].lengthSec > 0 && abs(wanted[i].durationMs / 1000.0 - ordered[i].lengthSec) <= 2.0 }) return wanted.indices.associateWith { ordered[it] }
        }
        return out
    }
}
