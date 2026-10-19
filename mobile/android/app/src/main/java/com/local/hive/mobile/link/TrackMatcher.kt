package com.local.hive.mobile.link

import java.text.Normalizer
import kotlin.math.abs

/**
 * Matches phone tracks to Hive (PC) tracks. The phone and PC hold separate
 * copies of the same files, so there is no shared id: a song is the same when
 * its normalized title matches and its artists overlap, with duration used
 * to choose between duplicates (live versions, remasters, re-rips).
 */
object TrackMatcher {
    // Re-rips and different encoders shift a track's length by a few seconds;
    // anything further apart is a different recording.
    private const val DURATION_TOLERANCE_MS = 12_000L

    data class Candidate(val key: String, val title: String, val artist: String, val albumArtist: String, val durationMs: Long)

    fun normalize(value: String): String {
        val decomposed = Normalizer.normalize(value.lowercase(), Normalizer.Form.NFKD)
        return decomposed
            .replace(Regex("""\((feat|ft|with)\.?[^)]*\)"""), "")
            .replace(Regex("""\s(feat|ft)\.\s.*$"""), "")
            .replace(Regex("""\p{M}+"""), "")
            .replace(Regex("""[^\p{L}\p{N}]+"""), "")
    }

    /** Lower-cased individual artist names, split on the separators taggers use. */
    fun artistParts(value: String): Set<String> =
        value.split(Regex("""\s*(/|;|,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*""", RegexOption.IGNORE_CASE))
            .map { normalize(it) }
            .filter { it.isNotEmpty() }
            .toSet()

    class Index(pcTracks: List<Candidate>) {
        private val byTitle: Map<String, List<Candidate>> = pcTracks.groupBy { normalize(it.title) }

        fun match(title: String, artist: String, albumArtist: String, durationMs: Long): Candidate? {
            val candidates = byTitle[normalize(title)].orEmpty()
            if (candidates.isEmpty()) return null
            val mine = artistParts(artist) + artistParts(albumArtist)
            val sameArtist = candidates.filter { c ->
                val theirs = artistParts(c.artist) + artistParts(c.albumArtist)
                mine.isEmpty() || theirs.isEmpty() || mine.any { it in theirs } ||
                    mine.any { m -> theirs.any { t -> m.contains(t) || t.contains(m) } }
            }
            if (sameArtist.isEmpty()) return null
            if (sameArtist.size == 1) return sameArtist[0].takeIf { durationOk(it.durationMs, durationMs) }
            return sameArtist
                .filter { durationOk(it.durationMs, durationMs) }
                .minByOrNull { abs(it.durationMs - durationMs) }
        }

        private fun durationOk(pc: Long, phone: Long) =
            pc <= 0 || phone <= 0 || abs(pc - phone) <= DURATION_TOLERANCE_MS
    }
}
