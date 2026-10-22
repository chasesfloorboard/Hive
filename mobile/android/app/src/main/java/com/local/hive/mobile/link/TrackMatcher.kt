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

    // Compiled once: matching runs over tens of thousands of tracks.
    private val featParens = Regex("""\((feat|ft|with)\.?[^)]*\)""")
    private val featTail = Regex("""\s(feat|ft)\.\s.*$""")
    private val marks = Regex("""\p{M}+""")
    private val nonWord = Regex("""[^\p{L}\p{N}]+""")
    private val artistSeparators = Regex("""\s*(/|;|,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*""", RegexOption.IGNORE_CASE)

    data class Candidate(val key: String, val title: String, val artist: String, val albumArtist: String, val durationMs: Long)

    fun normalize(value: String): String {
        val decomposed = Normalizer.normalize(value.lowercase(), Normalizer.Form.NFKD)
        return decomposed
            .replace(featParens, "")
            .replace(featTail, "")
            .replace(marks, "")
            .replace(nonWord, "")
    }

    /** Lower-cased individual artist names, split on the separators taggers use. */
    fun artistParts(value: String): Set<String> =
        value.split(artistSeparators)
            .map { normalize(it) }
            .filter { it.isNotEmpty() }
            .toSet()

    class Index(pcTracks: List<Candidate>) {
        private class Entry(val candidate: Candidate, val artists: Set<String>)

        // Each PC track is normalized once, not once per phone track.
        private val byTitle: Map<String, List<Entry>> = pcTracks.groupBy(
            { normalize(it.title) },
            { Entry(it, artistParts(it.artist) + artistParts(it.albumArtist)) },
        )

        fun match(title: String, artist: String, albumArtist: String, durationMs: Long): Candidate? {
            val entries = byTitle[normalize(title)].orEmpty()
            if (entries.isEmpty()) return null
            val mine = artistParts(artist) + artistParts(albumArtist)
            val sameArtist = entries.filter { e ->
                val theirs = e.artists
                mine.isEmpty() || theirs.isEmpty() || mine.any { it in theirs } ||
                    mine.any { m -> theirs.any { t -> m.contains(t) || t.contains(m) } }
            }.map { it.candidate }
            if (sameArtist.isEmpty()) return null
            if (sameArtist.size == 1) return sameArtist[0].takeIf { durationOk(it.durationMs, durationMs) }
            return sameArtist
                .filter { durationOk(it.durationMs, durationMs) }
                .minByOrNull { abs(it.durationMs - durationMs) }
        }

        /** Every candidate that is this song, closest in length first (a song kept in several versions or copies). */
        fun matches(title: String, artist: String, albumArtist: String, durationMs: Long): List<Candidate> {
            val mine = artistParts(artist) + artistParts(albumArtist)
            return byTitle[normalize(title)].orEmpty().filter { e ->
                val theirs = e.artists
                mine.isEmpty() || theirs.isEmpty() || mine.any { it in theirs } ||
                    mine.any { m -> theirs.any { t -> m.contains(t) || t.contains(m) } }
            }.map { it.candidate }.filter { durationOk(it.durationMs, durationMs) }.sortedBy { abs(it.durationMs - durationMs) }
        }

        private fun durationOk(pc: Long, phone: Long) =
            pc <= 0 || phone <= 0 || abs(pc - phone) <= DURATION_TOLERANCE_MS
    }
}
