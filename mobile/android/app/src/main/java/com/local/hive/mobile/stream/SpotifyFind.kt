package com.local.hive.mobile.stream

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

/**
 * Finds the Spotify album link for an album by name, without a Spotify account or key: MusicBrainz
 * (open, no sign-in) holds the album, and either Wikidata's "Spotify album ID" or MusicBrainz's own
 * release streaming links point to it. Only the album's public title and artist leave the phone — the
 * same words a search already sends. Resolved on demand (when the user shares), cached, and one request
 * at a time (MusicBrainz asks for no more than one a second).
 */
object SpotifyFind {
    private val http: OkHttpClient = AppleMusic.defaultHttp()
    private val cache = ConcurrentHashMap<String, String>()
    private val gate = Mutex()
    private const val UA = "HiveMusicPlayer/2.26 ( https://github.com/chasesfloorboard/Hive )"
    private val spotifyAlbum = Regex("""open\.spotify\.com/(?:intl-[a-z-]+/)?album/([A-Za-z0-9]{22})""")

    /** The open.spotify.com/album link for an album, or null when it can't be placed on Spotify. */
    suspend fun albumLink(artist: String, title: String): String? {
        if (artist.isBlank() || title.isBlank()) return null
        val key = "${artist.trim().lowercase()}|${title.trim().lowercase()}"
        cache[key]?.let { return it.ifBlank { null } }
        val url = gate.withLock { runCatching { resolve(artist.trim(), title.trim()) }.getOrNull() }
        cache[key] = url.orEmpty()
        return url
    }

    private suspend fun resolve(artist: String, title: String): String? = withContext(Dispatchers.IO) {
        val groupId = searchReleaseGroup(artist, title) ?: return@withContext null
        // The release group's own links: a direct Spotify link, else Wikidata's Spotify album id.
        delay(1_100)
        val rels = relations("https://musicbrainz.org/ws/2/release-group/$groupId?inc=url-rels&fmt=json")
        rels.firstNotNullOfOrNull { spotifyAlbum.find(it.first)?.let { m -> "https://open.spotify.com/album/${m.groupValues[1]}" } }
            ?.let { return@withContext it }
        rels.firstOrNull { "wikidata.org" in it.first }?.first?.let { wd ->
            fromWikidata(wd.trimEnd('/').substringAfterLast('/'))?.let { return@withContext it }
        }
        // Failing that, a Spotify link on one of the group's releases.
        delay(1_100)
        releaseSpotifyLink(groupId)
    }

    private fun searchReleaseGroup(artist: String, title: String): String? {
        val q = URLEncoder.encode("artist:\"$artist\" AND releasegroup:\"$title\"", "UTF-8")
        val o = getJson("https://musicbrainz.org/ws/2/release-group/?query=$q&fmt=json&limit=5") as? JsonObject ?: return null
        val groups = (o["release-groups"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val match = groups.firstOrNull { g ->
            val credited = (g["artist-credit"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.str("name") }.joinToString(" ")
            credited.contains(artist, ignoreCase = true) || artist.contains(credited, ignoreCase = true)
        } ?: groups.firstOrNull()
        return match?.str("id")
    }

    /** (resource, type) url relations of a MusicBrainz entity. */
    private fun relations(url: String): List<Pair<String, String>> {
        val o = getJson(url) as? JsonObject ?: return emptyList()
        return (o["relations"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { r ->
            (r["url"] as? JsonObject)?.str("resource")?.let { it to (r.str("type") ?: "") }
        }
    }

    private fun releaseSpotifyLink(groupId: String): String? {
        val o = getJson("https://musicbrainz.org/ws/2/release?release-group=$groupId&inc=url-rels&fmt=json&limit=25") as? JsonObject ?: return null
        (o["releases"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.forEach { rel ->
            (rel["relations"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.forEach { r ->
                (r["url"] as? JsonObject)?.str("resource")?.let { res ->
                    spotifyAlbum.find(res)?.let { return "https://open.spotify.com/album/${it.groupValues[1]}" }
                }
            }
        }
        return null
    }

    private fun fromWikidata(entity: String): String? {
        if (!entity.matches(Regex("Q\\d+"))) return null
        val o = getJson("https://www.wikidata.org/wiki/Special:EntityData/$entity.json") as? JsonObject ?: return null
        val ent = (o["entities"] as? JsonObject)?.values?.firstOrNull() as? JsonObject ?: return null
        val claim = ((ent["claims"] as? JsonObject)?.get("P2205") as? JsonArray)?.firstOrNull() as? JsonObject ?: return null
        val id = (((claim["mainsnak"] as? JsonObject)?.get("datavalue") as? JsonObject)?.str("value")) ?: return null
        return "https://open.spotify.com/album/$id"
    }

    private fun getJson(url: String): kotlinx.serialization.json.JsonElement? {
        val request = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "application/json").build()
        return http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException("Lookup answered ${res.code}")
            runCatching { Json.parseToJsonElement(res.body.string()) }.getOrNull()
        }
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
}
