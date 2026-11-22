package com.local.hive.mobile.discovery

import com.local.hive.mobile.art.ArtNet
import com.local.hive.mobile.art.string
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** One album-cover candidate for the tag editor's "search covers online" grid. */
data class CoverChoice(
    val id: String,
    val title: String,
    val artist: String,
    val thumbUrl: String,
    val fullUrl: String,
    val year: String? = null,
)

/**
 * Album-cover search for the tag editor, powered by the public iTunes Search API.
 * Deciphers artist, album, and track queries, executes tiered album/song searches,
 * filters out karaoke/tributes, and scores results by artist and release relevance.
 */
class ITunesCoverSearch(private val base: String = "https://itunes.apple.com") {

    companion object {
        private val bracketNoise = Regex("""\s*[(\[][^)\]]*(edition|version|bonus|deluxe|remaster|disc|explicit|single|ep|re-issue)[^)\]]*[)\]]""", RegexOption.IGNORE_CASE)
        private val possessive = Regex("""(\p{L}+)'s\b""", RegexOption.IGNORE_CASE)
        private val karaokeJunk = listOf("karaoke", "tribute", "in the style of", "originally performed by", "a tribute to", "instrumental version")

        fun cleanBrackets(text: String): String = text.replace(bracketNoise, "").trim()

        /**
         * Deciphers free text into (artist, album, title).
         * Handles:
         * - "Usher's Hopes and Dreams" -> artist: "Usher", album: "Hopes and Dreams"
         * - "Hopes and Fears by Usher" -> artist: "Usher", album: "Hopes and Fears"
         * - "Usher - Confessions" -> artist: "Usher", album: "Confessions"
         * - "Usher Confessions" -> artist: "Usher", album: "Confessions"
         */
        fun decipher(query: String): Triple<String, String, String> {
            val q = query.trim().replace(possessive, "$1")
            val byMatch = Regex("""^(.*?)\s+by\s+(.*)$""", RegexOption.IGNORE_CASE).find(q)
            if (byMatch != null) {
                return Triple(byMatch.groupValues[2].trim(), cleanBrackets(byMatch.groupValues[1].trim()), "")
            }
            if (" - " in q) {
                val parts = q.split(" - ", limit = 2)
                return Triple(parts[0].trim(), cleanBrackets(parts[1].trim()), "")
            }
            val words = q.split(Regex("""\s+""")).filter { it.isNotEmpty() }
            if (words.size >= 2) {
                return Triple(words.first(), cleanBrackets(words.drop(1).joinToString(" ")), "")
            }
            return Triple(q, "", "")
        }
    }

    suspend fun search(artist: String, album: String, title: String = ""): List<CoverChoice> = withContext(Dispatchers.IO) {
        val tArtist = artist.trim().replace(possessive, "$1")
        val tAlbum = cleanBrackets(album)
        val tTitle = cleanBrackets(title)
        if (tArtist.isBlank() && tAlbum.isBlank() && tTitle.isBlank()) return@withContext emptyList()

        val queries = mutableListOf<Triple<String, String?, String?>>()
        val combined = listOf(tArtist, tAlbum).filter { it.isNotBlank() }.joinToString(" ")
        if (combined.isNotBlank()) queries += Triple(combined, "album", null)
        if (tArtist.isNotBlank() && (tTitle.isNotBlank() || tAlbum.isNotBlank())) {
            queries += Triple("$tArtist ${tTitle.ifBlank { tAlbum }}", "song", null)
            queries += Triple("$tArtist ${tTitle.ifBlank { tAlbum }}", "album", null)
        }
        if (tArtist.isNotBlank()) {
            queries += Triple(tArtist, "album", "artistTerm")
        }

        fetchAndRank(queries, tArtist, tAlbum, tTitle)
    }

    suspend fun search(query: String): List<CoverChoice> = withContext(Dispatchers.IO) {
        val q = query.trim()
        if (q.isBlank()) return@withContext emptyList()

        val (decArtist, decAlbum, decTitle) = decipher(q)
        val queries = mutableListOf<Triple<String, String?, String?>>()
        val cleanedQ = cleanBrackets(q.replace(possessive, "$1"))
        queries += Triple(cleanedQ, "album", null)

        if (decArtist.isNotBlank() && decAlbum.isNotBlank()) {
            queries += Triple("$decArtist $decAlbum", "album", null)
            queries += Triple("$decArtist $decAlbum", "song", null)
            queries += Triple(decArtist, "album", "artistTerm")
        } else if (decArtist.isNotBlank() && decArtist != cleanedQ) {
            queries += Triple(decArtist, "album", "artistTerm")
        }

        fetchAndRank(queries, decArtist, decAlbum, decTitle)
    }

    private suspend fun fetchAndRank(
        queries: List<Triple<String, String?, String?>>,
        targetArtist: String,
        targetAlbum: String,
        targetTitle: String,
    ): List<CoverChoice> {
        val seen = mutableSetOf<String>()
        val raw = mutableListOf<CoverChoice>()

        for ((term, entity, attribute) in queries.distinctBy { "${it.first}|${it.second}|${it.third}" }) {
            val params = mutableListOf("term=${ArtNet.enc(term)}", "limit=20")
            if (entity != null) params += "entity=$entity"
            if (attribute != null) params += "attribute=$attribute"
            val url = "$base/search?" + params.joinToString("&")
            val results = runCatching {
                ((ArtNet.limited { ArtNet.getJson(url) } as? JsonObject)?.get("results") as? JsonArray)
                    .orEmpty().mapNotNull { it as? JsonObject }
            }.getOrDefault(emptyList())

            for (r in results) {
                val art = r.string("artworkUrl100")?.takeIf { it.isNotBlank() } ?: continue
                val cName = r.string("collectionName")?.takeIf { it.isNotBlank() } ?: continue
                val aName = r.string("artistName").orEmpty()
                val cid = r.string("collectionId") ?: art
                val year = r.string("releaseDate")?.take(4)?.takeIf { it.all(Char::isDigit) }
                if (!seen.add(cid)) continue

                raw += CoverChoice(
                    id = cid,
                    title = cName,
                    artist = aName,
                    thumbUrl = art.replace(Regex("""/\d+x\d+bb\."""), "/300x300bb."),
                    fullUrl = art.replace(Regex("""/\d+x\d+bb\."""), "/1200x1200bb."),
                    year = year,
                )
            }

            // Stop early if we already have an exact artist + release match
            if (raw.any { score(it, targetArtist, targetAlbum, targetTitle) >= 200 }) break
        }

        return raw.map { score(it, targetArtist, targetAlbum, targetTitle) to it }
            .filter { it.first > -500 }
            .sortedByDescending { it.first }
            .map { it.second }
    }

    private fun score(c: CoverChoice, targetArtist: String, targetAlbum: String, targetTitle: String): Int {
        val ca = c.artist.lowercase()
        val cal = c.title.lowercase()
        if (karaokeJunk.any { it in ca || it in cal }) return -999

        var s = 0
        if (targetArtist.isNotBlank()) {
            val ta = targetArtist.lowercase()
            when {
                ca == ta -> s += 150
                ta in ca || ca in ta -> s += 100
                else -> s -= 80
            }
        }
        if (targetAlbum.isNotBlank()) {
            val tal = targetAlbum.lowercase()
            val cleanCal = cleanBrackets(c.title).lowercase()
            when {
                cleanCal == tal || cal == tal -> s += 120
                tal in cleanCal || cleanCal in tal -> s += 70
            }
        }
        if (targetTitle.isNotBlank()) {
            val tt = targetTitle.lowercase()
            if (tt in cal) s += 90
        }
        return s
    }
}
