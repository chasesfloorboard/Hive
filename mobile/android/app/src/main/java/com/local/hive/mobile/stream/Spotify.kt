package com.local.hive.mobile.stream

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URLEncoder

/** A Spotify song; [previewUrl] is its 30-second preview, when Spotify shares one. */
data class SpSong(val id: String, val title: String, val artist: String, val album: String, val durationMs: Long, val artwork: String, val previewUrl: String) {
    val url get() = "https://open.spotify.com/track/$id"
}

/** A Spotify playlist or album card. */
data class SpCard(val kind: String, val id: String, val name: String, val subtitle: String, val artwork: String) {
    val url get() = "https://open.spotify.com/$kind/$id"
}

data class SpCollection(val kind: String, val id: String, val name: String, val owner: String, val artwork: String, val songs: List<SpSong>) {
    val url get() = "https://open.spotify.com/$kind/$id"
}

/**
 * Spotify without an account: the public embed pages Spotify serves for any
 * shared playlist, album or song (names, artists, lengths and 30-second
 * previews), and oEmbed for covers. Hive plays library matches in full and
 * previews for the rest, as with Apple Music.
 */
class Spotify(private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private var picksCache: Pair<Long, List<SpCard>>? = null

    /** Spotify's editorial playlists, for a Browse shelf without signing in. */
    suspend fun picks(): List<SpCard> {
        picksCache?.let { (at, cards) -> if (System.currentTimeMillis() - at < 6 * 60 * 60_000) return cards }
        val cards = coroutineScope {
            EDITORIAL.map { id ->
                async {
                    runCatching {
                        val o = Json.parseToJsonElement(get("https://open.spotify.com/oembed?url=${URLEncoder.encode("https://open.spotify.com/playlist/$id", "UTF-8")}")) as JsonObject
                        SpCard("playlist", id, o.str("title").orEmpty(), "Spotify", largest(o.str("thumbnail_url").orEmpty()))
                    }.getOrNull()
                }
            }.awaitAll().filterNotNull().filter { it.name.isNotBlank() }
        }
        if (cards.isNotEmpty()) picksCache = System.currentTimeMillis() to cards
        return cards
    }

    /** A playlist, album or song by its Spotify link. */
    suspend fun collection(link: String): SpCollection {
        val ref = parseLink(link) ?: throw IOException("Enter an open.spotify.com playlist, album or song link.")
        val html = get("https://open.spotify.com/embed/${ref.first}/${ref.second}")
        val found = parseEmbed(html, ref.first, ref.second) ?: throw IOException("Spotify did not share this ${ref.first} publicly.")
        // A playlist's page leaves out its songs' covers; each song's own link preview has its album's.
        val covers = covers(found.songs.filter { it.artwork.isBlank() }.map { it.id })
        return if (covers.isEmpty()) found else found.copy(songs = found.songs.map { s -> covers[s.id]?.let { s.copy(artwork = it) } ?: s })
    }

    private val coverCache = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val coverLookups = kotlinx.coroutines.sync.Semaphore(8)

    /** Album covers (640 px) for Spotify song ids, eight lookups at a time; songs without one are left out. */
    suspend fun covers(ids: List<String>): Map<String, String> = coroutineScope {
        ids.distinct().map { id ->
            async {
                coverCache[id]?.let { return@async id to it }
                val url = coverLookups.withPermit {
                    runCatching {
                        val o = Json.parseToJsonElement(get("https://open.spotify.com/oembed?url=${URLEncoder.encode("spotify:track:$id", "UTF-8")}")) as JsonObject
                        largest(o.str("thumbnail_url").orEmpty())
                    }.getOrNull()
                }
                url?.takeIf { it.startsWith("https://") }?.let { coverCache[id] = it; id to it }
            }
        }.awaitAll().filterNotNull().toMap()
    }

    private suspend fun get(url: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url.toHttpUrl()).header("User-Agent", USER_AGENT).header("Accept-Language", "en-US,en;q=0.9").build()
        http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException(if (res.code == 404) "Spotify couldn't find that." else "Spotify answered ${res.code}")
            res.body.string()
        }
    }

    companion object {
        private const val USER_AGENT = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
        private val nextData = Regex("""<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>""")
        private val webLink = Regex("""^https://open\.spotify\.com/(?:intl-[a-z-]+/)?(playlist|album|track)/([A-Za-z0-9]{10,})""", RegexOption.IGNORE_CASE)
        private val uriLink = Regex("""^spotify:(playlist|album|track):([A-Za-z0-9]{10,})$""")

        // Spotify's own playlists that stay put; covers and names come from oEmbed.
        private val EDITORIAL = listOf(
            "37i9dQZF1DXcBWIGoYBM5M", "37i9dQZF1DX4JAvHpjipBk", "37i9dQZEVXbMDoHDwVN2tF", "37i9dQZEVXbLRQDuF5jeBp",
            "37i9dQZF1DX0XUsuxWHRQd", "37i9dQZF1DX10zKzsJ2jva", "37i9dQZF1DX1lVhptIYRda", "37i9dQZF1DX4dyzvuaRJ0n",
            "37i9dQZF1DWXRqgorJj26U", "37i9dQZF1DX5Ejj0EkURtP", "37i9dQZF1DWWMOmoXKqHTD", "37i9dQZF1DX4sWSpwq3LiO",
        )

        fun isSpotifyLink(text: String) = parseLink(text) != null

        /** (kind, id) from an open.spotify.com link or a spotify: URI. */
        fun parseLink(text: String): Pair<String, String>? {
            val t = text.trim()
            return (webLink.find(t) ?: uriLink.find(t))?.let { it.groupValues[1].lowercase() to it.groupValues[2] }
        }

        fun parseEmbed(html: String, kind: String, id: String): SpCollection? {
            val data = nextData.find(html)?.groupValues?.get(1)?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() } ?: return null
            val entity = data.path("props", "pageProps", "state", "data", "entity") as? JsonObject ?: return null
            val cover = biggestImage(entity)
            val name = entity.str("name") ?: entity.str("title").orEmpty()
            val owner = entity.str("subtitle").orEmpty().ifBlank { (entity["artists"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.str("name") }?.joinToString(", ").orEmpty() }
            val songs = if (kind == "track") {
                listOf(SpSong(id, name, owner, "", entity.long("duration"), cover, (entity["audioPreview"] as? JsonObject)?.str("url").orEmpty()))
            } else (entity["trackList"] as? JsonArray).orEmpty().mapNotNull { e ->
                val t = e as? JsonObject ?: return@mapNotNull null
                val trackId = t.str("uri")?.substringAfterLast(':') ?: return@mapNotNull null
                SpSong(
                    id = trackId, title = t.str("title").orEmpty(),
                    // Spotify separates artists with ", " and a no-break space.
                    artist = t.str("subtitle").orEmpty().replace(' ', ' '),
                    album = if (kind == "album") name else "",
                    durationMs = t.long("duration"),
                    // Album songs share the album's cover; playlist songs come without one.
                    artwork = if (kind == "album") cover else "",
                    previewUrl = (t["audioPreview"] as? JsonObject)?.str("url").orEmpty(),
                )
            }
            if (name.isBlank() && songs.isEmpty()) return null
            return SpCollection(kind, id, name, owner, cover, songs)
        }

        /** Spotify's 300 px album and playlist images as their 640 px versions. */
        fun largest(url: String): String = url
            .replace(Regex("""^https://image-cdn-[a-z]+\.spotifycdn\.com/image/"""), "https://i.scdn.co/image/")
            .replace("ab67616d00001e02", "ab67616d0000b273").replace("ab67616d00004851", "ab67616d0000b273")
            .replace("ab67706f00000002", "ab67706f00000003")

        private fun biggestImage(entity: JsonObject): String {
            val visual = ((entity["visualIdentity"] as? JsonObject)?.get("image") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            visual.maxByOrNull { it.long("maxWidth") }?.str("url")?.let { return it }
            return (((entity["coverArt"] as? JsonObject)?.get("sources") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                .maxByOrNull { it.long("width") }?.str("url")).orEmpty()
        }

        private fun JsonElement.path(vararg keys: String): JsonElement? = keys.fold(this as JsonElement?) { e, k -> (e as? JsonObject)?.get(k) }
        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
        private fun JsonObject.long(key: String): Long = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong() ?: 0
    }
}

/** How Hive keeps a Spotify song that isn't in the library. */
fun SpSong.toStream() = com.local.hive.mobile.data.StreamTrack(
    key = "sp:$id", source = "Spotify", title = title, artist = artist, album = album,
    durationMs = durationMs, artworkUrl = artwork, previewUrl = previewUrl, url = url,
)
