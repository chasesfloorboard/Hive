package com.local.hive.mobile.data

import java.text.Normalizer

/**
 * One album, one listing. Android files an album's songs under separate
 * albums when their tags differ in small ways: one song without an album
 * artist, "BONES" against "Bones", "Earl Sweatshirt" against "Earl
 * Sweatshirt & The Alchemist", a song in another folder. Here, albums with
 * the same name that share an artist become one, under the id of the
 * largest part. Albums that only share a name ("Utopia" by Björk and by
 * Travis Scott) stay apart. Nothing is written to the files.
 */
object AlbumMerge {
    fun apply(tracks: List<Track>): List<Track> {
        val groups = tracks.groupBy { it.albumId }
        val canonical = HashMap<Long, Long>()
        groups.entries
            .mapNotNull { (id, songs) -> nameOf(songs)?.let { Triple(it, id, songs) } }
            .groupBy({ it.first }, { it.second to it.third })
            .values.filter { it.size > 1 }
            .forEach { parts -> merge(parts, canonical) }
        if (canonical.isEmpty()) return tracks
        return tracks.map { t -> canonical[t.albumId]?.let { t.copy(albumId = it) } ?: t }
    }

    /** Joins the parts of one album name that share an artist; the biggest part names the whole. */
    private fun merge(parts: List<Pair<Long, List<Track>>>, canonical: MutableMap<Long, Long>) {
        val keys = parts.map { (_, songs) -> artistKeys(songs) }
        val parent = IntArray(parts.size) { it }
        fun find(i: Int): Int { var x = i; while (parent[x] != x) x = parent[x]; return x }
        for (i in parts.indices) for (j in i + 1 until parts.size) {
            if (keys[i].any { it in keys[j] }) parent[find(j)] = find(i)
        }
        parts.indices.groupBy(::find).values.filter { it.size > 1 }.forEach { members ->
            val main = members.maxWith(compareBy<Int> { parts[it].second.size }.thenBy { -parts[it].first }).let { parts[it].first }
            members.forEach { if (parts[it].first != main) canonical[parts[it].first] = main }
        }
    }

    /** The comparable album name, or null when there is none worth trusting. */
    private fun nameOf(songs: List<Track>): String? {
        val album = songs.firstOrNull { it.album.isNotBlank() }?.album ?: return null
        return plain(album).ifBlank { null }
    }

    private fun artistKeys(songs: List<Track>): Set<String> = buildSet {
        songs.forEach { s -> listOf(s.albumArtist, s.artist).forEach { a -> artistKey(a)?.let(::add) } }
    }

    /** The lead artist, compared loosely: "The Alchemist & Earl" → "alchemist", "BONES" = "Bones". */
    fun artistKey(artist: String): String? {
        val lead = artist.split(Regex("""\s*(,|&|/|;|\+|\s[xX×]\s|\s(and|feat\.?|ft\.?|with|vs\.?)\s)\s*""", RegexOption.IGNORE_CASE)).first()
        return plain(lead).removePrefix("the ").replace(" ", "").ifBlank { null }
    }

    private fun plain(text: String) = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFKD)
        .replace(Regex("\\p{M}+"), "").replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()
}
