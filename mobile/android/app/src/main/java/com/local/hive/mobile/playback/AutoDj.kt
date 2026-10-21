package com.local.hive.mobile.playback

import com.local.hive.mobile.data.Track
import kotlin.math.abs
import kotlin.math.ln
import kotlin.random.Random

/**
 * Auto DJ: a queue grown from what the user held (songs, an album, an
 * artist, a playlist) out of the phone's own library.
 *
 * The seeds play first (a long seed, like a whole artist, is cut to its
 * best-loved songs). The rest is drawn from the seeds' artists, the artists
 * they appear with ("A feat. B", "A & B"), and artists sharing their genres,
 * leaning towards songs that were played often or are Favorites and towards
 * the seeds' years. No song comes twice, the same artist is spaced out, and
 * no artist takes more than a third of the songs that follow the seeds.
 */
object AutoDj {
    const val SIZE = 50
    /** Seeds longer than this are cut down to their best songs. */
    private const val MAX_SEEDS = 12

    fun build(
        seeds: List<Track>,
        library: List<Track>,
        plays: Map<Long, Int> = emptyMap(),
        loved: Set<Long> = emptySet(),
        size: Int = SIZE,
        random: Random = Random.Default,
    ): List<Track> {
        val distinctSeeds = seeds.distinctBy { it.id }
        if (distinctSeeds.isEmpty()) return emptyList()
        fun weight(t: Track) = ln(1.0 + (plays[t.id] ?: 0)) + if (t.id in loved) 1.5 else 0.0
        val opening = if (distinctSeeds.size <= MAX_SEEDS) distinctSeeds
            else distinctSeeds.sortedByDescending { weight(it) + random.nextDouble() * 0.5 }.take(MAX_SEEDS / 2)

        val seedArtists = distinctSeeds.flatMapTo(HashSet()) { artistsOf(it) }
        // Artists the seeds' artists share songs with.
        val collaborators = library.filter { t -> artistsOf(t).any { it in seedArtists } }.flatMapTo(HashSet()) { artistsOf(it) } - seedArtists
        val seedGenres = distinctSeeds.flatMapTo(HashSet()) { genresOf(it) }
        // Artists with songs in the seeds' genres.
        val genreArtists = library.filter { t -> genresOf(t).any { it in seedGenres } }.flatMapTo(HashSet()) { artistsOf(it) } - seedArtists - collaborators
        val years = distinctSeeds.map { it.year }.filter { it > 0 }.sorted()
        val year = years.getOrNull(years.size / 2) ?: 0

        val taken = opening.mapTo(HashSet()) { it.id }
        val seen = opening.mapTo(HashSet()) { key(it) }
        fun score(t: Track): Double {
            val artists = artistsOf(t)
            var s = when {
                artists.any { it in seedArtists } -> 3.0
                artists.any { it in collaborators } -> 2.0
                artists.any { it in genreArtists } -> 1.0
                else -> return 0.0
            }
            if (genresOf(t).any { it in seedGenres }) s += 1.0
            if (year > 0 && t.year > 0) s += (0.6 - abs(t.year - year) * 0.1).coerceAtLeast(0.0)
            return s + weight(t) * 0.6
        }
        // Each candidate's score, jittered so the same seeds don't always give the same queue.
        val pool = library.asSequence()
            .filter { it.id !in taken && it.durationMs > 30_000 }
            .map { it to score(it) }
            .filter { it.second > 0 }
            .map { (t, s) -> t to s + random.nextDouble() * 1.2 }
            .sortedByDescending { it.second }
            .map { it.first }
            .toMutableList()

        val queue = opening.toMutableList()
        val perArtist = HashMap<String, Int>()
        val cap = ((size - opening.size).coerceAtLeast(1) + 2) / 3
        while (queue.size < size && pool.isNotEmpty()) {
            val recent = queue.takeLast(3).flatMapTo(HashSet()) { artistsOf(it) }
            fun fits(t: Track) = key(t) !in seen && artistsOf(t).none { it in recent } && artistsOf(t).all { (perArtist[it] ?: 0) < cap }
            // The best song that keeps the artists apart; failing that, the best not yet heard.
            val i = pool.indexOfFirst(::fits).takeIf { it >= 0 } ?: pool.indexOfFirst { key(it) !in seen }.takeIf { it >= 0 } ?: break
            val next = pool.removeAt(i)
            queue += next
            seen += key(next)
            artistsOf(next).forEach { perArtist[it] = (perArtist[it] ?: 0) + 1 }
        }
        return queue
    }

    /** "A feat. B", "A & B", "A, B", "A x B" -> its artists, lowercased. */
    fun artistsOf(t: Track): Set<String> =
        (listOf(t.artist, t.albumArtist).flatMap { it.split(SPLIT) })
            .map { it.trim().lowercase() }.filter { it.isNotEmpty() && it != "various artists" && it != "<unknown>" }.toSet()

    private fun genresOf(t: Track): Set<String> = t.genre.split(Regex("[;/,|]+")).map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    /** The same song from two files (an album copy and a single) counts once. */
    private fun key(t: Track) = t.title.lowercase().replace(Regex("\\(.*?\\)|\\[.*?]"), "").replace(Regex("[^\\p{L}\\p{N}]+"), "") + "\u0000" + t.artist.lowercase()

    private val SPLIT = Regex("\\s*(?:,|&|\\bfeat\\.?|\\bft\\.?|\\bfeaturing\\b|\\bx\\b|;)\\s*", RegexOption.IGNORE_CASE)
}
