package com.local.hive.mobile.playback

import com.local.hive.mobile.data.Track
import com.local.hive.mobile.data.TrackMatcher
import kotlin.random.Random

/**
 * "Hey Google, play …" for Hive: what to play for a spoken request, from the
 * phone's library. The assistant hands over the words, and sometimes what they
 * name (an artist, an album, a song). An artist or genre plays shuffled, an
 * album in order, a song followed by the rest of its album. Nothing found is
 * an empty list, so the assistant says so.
 */
object VoiceSearch {
    /** What the assistant says the words name, when it knows. */
    data class Hint(val artist: String = "", val album: String = "", val title: String = "", val genre: String = "")

    private val PREFIX = Regex(
        """^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:i\s+(?:want|would like|'d like|id like)\s+to\s+)?(?:play|listen to|put on|shuffle|start|hear)\s+(?:(?:some|any)\s+)?(?:music\s+by\s+|songs\s+by\s+|tracks\s+by\s+|the\s+album\s+|the\s+song\s+)?""",
        RegexOption.IGNORE_CASE
    )
    private val SUFFIX = Regex(
        """(?:\s+(?:while\s+i(?:'m|\s+am)?\s+driving|in\s+(?:the|my)\s+car|for\s+(?:the|my)\s+drive|during\s+(?:the|my)\s+drive|while\s+driving|on\s+the\s+road|on\s+(?:the|my)\s+drive))*(?:\s+(?:on|in|from|using|with)\s+hive(?:\s+mobile)?)*(?:\s+(?:and\s+)?not\s+(?:an?\s+)?album)*(?:\s+(?:right\s+now|now|please|for\s+me|already))*(?:\s+(?:while\s+i(?:'m|\s+am)?\s+driving|in\s+(?:the|my)\s+car|for\s+(?:the|my)\s+drive|during\s+(?:the|my)\s+drive|while\s+driving|on\s+the\s+road|on\s+(?:the|my)\s+drive))*$""",
        RegexOption.IGNORE_CASE
    )
    private val LEADING_SOME = Regex("""^(?:some|any)\s+""", RegexOption.IGNORE_CASE)
    private val bySplit = Regex("""\s+by\s+""", RegexOption.IGNORE_CASE)

    /** Strips conversational prefixes ("play", "can you play some") and car/driving suffixes ("while I'm driving"). */
    fun clean(query: String): String {
        var w = query.trim()
        w = PREFIX.replace(w, "").trim()
        w = SUFFIX.replace(w, "").trim()
        w = LEADING_SOME.replace(w, "").trim()
        return w
    }

    fun pick(
        tracks: List<Track>,
        query: String,
        hint: Hint = Hint(),
        random: Random = Random.Default,
        favorites: Set<Long> = emptySet(),
    ): List<Track> {
        if (tracks.isEmpty()) return emptyList()
        val n = TrackMatcher::normalize
        fun artistIs(t: Track, a: String) = TrackMatcher.artistParts(t.displayAlbumArtist).contains(a) || TrackMatcher.artistParts(t.artist).contains(a)
        fun byArtist(a: String) = tracks.filter { artistIs(it, a) }
        fun byAlbum(a: String, artist: String = "") = tracks.filter { n(it.album) == a && (artist.isEmpty() || artistIs(it, artist)) }.inAlbumOrder()
        fun byGenre(g: String) = tracks.filter { n(it.genre) == g }
        fun withAlbum(songs: List<Track>): List<Track> {
            val first = songs.first()
            return listOf(first) + tracks.filter { it.albumId == first.albumId && it.id != first.id }.inAlbumOrder()
        }

        // What the assistant already named.
        val (ha, hal, ht, hg) = listOf(hint.artist, hint.album, hint.title, hint.genre).map(n)
        if (ht.isNotEmpty()) tracks.filter { n(it.title) == ht && (ha.isEmpty() || artistIs(it, ha)) }.takeIf { it.isNotEmpty() }?.let { return withAlbum(it) }
        if (hal.isNotEmpty()) (byAlbum(hal, ha).ifEmpty { byAlbum(hal) }).takeIf { it.isNotEmpty() }?.let { return it }
        if (ha.isNotEmpty()) byArtist(ha).takeIf { it.isNotEmpty() }?.let { return it.shuffled(random) }
        if (hg.isNotEmpty()) byGenre(hg).takeIf { it.isNotEmpty() }?.let { return it.shuffled(random) }

        // The words alone: "play music" shuffles everything.
        val words = clean(query)
        val q = n(words)
        if (q.isEmpty() || q in setOf("music", "somemusic", "mymusic", "hive", "songs", "anything", "allmusic", "something")) return tracks.shuffled(random)
        if (favorites.isNotEmpty() && q in setOf("favorites", "myfavorites", "likedsongs", "mylikedsongs", "lovedsongs", "mylovedsongs")) {
            tracks.filter { it.id in favorites }.takeIf { it.isNotEmpty() }?.let { return it.shuffled(random) }
        }
        // "<song> by <artist>" / "<album> by <artist>".
        bySplit.split(words, 2).takeIf { it.size == 2 }?.let { (what, who) ->
            val w = n(what); val a = n(who)
            tracks.filter { n(it.title) == w && artistIs(it, a) }.takeIf { it.isNotEmpty() }?.let { return withAlbum(it) }
            byAlbum(w, a).takeIf { it.isNotEmpty() }?.let { return it }
            // The artist misheard ("Fontaine DC"): the song or album name alone, when only one artist has it.
            tracks.filter { n(it.title) == w }.takeIf { songs -> songs.isNotEmpty() && songs.distinctBy { n(it.displayAlbumArtist) }.size == 1 }?.let { return withAlbum(it) }
            byAlbum(w).takeIf { album -> album.isNotEmpty() && album.distinctBy { it.albumId }.size == 1 }?.let { return it }
        }
        // If the user explicitly asked for "the album ...", check albums before artists.
        val explicitlyAlbum = Regex("""\b(?:the\s+album|album)\b""", RegexOption.IGNORE_CASE).containsMatchIn(query)
        if (explicitlyAlbum) {
            byAlbum(q).takeIf { it.isNotEmpty() }?.let { return it }
        }
        // Exact names first, then names that contain the words.
        byArtist(q).takeIf { it.isNotEmpty() }?.let { return it.shuffled(random) }
        byAlbum(q).takeIf { it.isNotEmpty() }?.let { return it }
        // "<artist> <album>" or "<album> <artist>" without "by" (e.g. "play Outkast Stankonia", "play Sade Love Deluxe").
        tracks.groupBy { it.albumId }.values.firstOrNull { albumTracks ->
            val first = albumTracks.first()
            val a = n(first.displayAlbumArtist)
            val al = n(first.album)
            (a.isNotEmpty() && al.isNotEmpty()) && (a + al == q || al + a == q)
        }?.let { return it.inAlbumOrder() }
        tracks.filter { n(it.title) == q }.takeIf { it.isNotEmpty() }?.let { return withAlbum(it) }
        byGenre(q).takeIf { it.isNotEmpty() }?.let { return it.shuffled(random) }
        tracks.filter { t -> TrackMatcher.artistParts(t.displayAlbumArtist).any { q in it } }.takeIf { it.isNotEmpty() }?.let { return it.shuffled(random) }
        tracks.filter { q in n(it.album) }.takeIf { it.isNotEmpty() }?.let { found -> return found.groupBy { it.albumId }.values.first().inAlbumOrder() }
        tracks.filter { q in n(it.title) }.takeIf { it.isNotEmpty() }?.let { return withAlbum(it) }
        return emptyList()
    }

    private fun List<Track>.inAlbumOrder() = sortedWith(compareBy({ it.discNumber }, { it.trackNumber }, { it.title.lowercase() }))
}
