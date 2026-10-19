package com.local.hive.mobile.stream

import android.content.Context
import android.net.Uri
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.text.Normalizer
import java.util.concurrent.ConcurrentHashMap

/** A song wanted in full: what Apple Music or Spotify said about it. */
data class WantedSong(val key: String, val title: String, val artist: String, val album: String, val durationMs: Long)

/**
 * Full songs for Apple Music and Spotify tracks without Hive on the PC, as
 * Hive's desktop finds them: the song is searched on YouTube Music ("Songs"
 * results, then music videos), ranked on title, artist and length the same
 * way, and played from YouTube's own audio link (valid for hours). Matches
 * are remembered; links are kept until they expire.
 *
 * Requests are made as YouTube's own visionOS app, which needs no sign-in
 * and gives direct audio links, with the visitor id YouTube Music hands out.
 */
class YouTubeMusic(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val prefs = context.getSharedPreferences("youtube-music", Context.MODE_PRIVATE)
    private val links = ConcurrentHashMap<String, Pair<String, Long>>() // videoId -> (audio url, expires at)
    private val locks = ConcurrentHashMap<String, Any>()
    private val _enabled = kotlinx.coroutines.flow.MutableStateFlow(prefs.getBoolean("enabled", true))
    /** Whether songs the phone doesn't have play in full from YouTube Music (else as previews). */
    val enabled: kotlinx.coroutines.flow.StateFlow<Boolean> = _enabled

    fun setEnabled(on: Boolean) { _enabled.value = on; prefs.edit().putBoolean("enabled", on).apply() }

    /** The playable address for [song]; blocking, so call it off the main thread. */
    fun resolve(song: WantedSong): String = synchronized(locks.getOrPut(song.key) { Any() }) {
        prefs.getString("match:${song.key}", null)?.let { id -> runCatching { return audioUrl(id) } }
        val id = findMatch(song) ?: throw IOException("Couldn't find “${song.title}” on YouTube Music.")
        prefs.edit().putString("match:${song.key}", id).apply()
        audioUrl(id)
    }

    /** Forgets [key]'s audio link (it was refused), so the next resolve fetches a new one. */
    fun invalidate(key: String) {
        prefs.getString("match:$key", null)?.let { links.remove(it) }
    }

    // ---- matching (Hive's desktop rules) ----

    private data class Candidate(val id: String, val title: String, val artists: String, val durationSec: Int)

    private fun findMatch(want: WantedSong): String? {
        val query = "${firstArtist(want.artist)} ${normalise(want.title)}".trim()
        val wantSec = (want.durationMs / 1000).toInt()
        val songs = search(query, SONGS)
        songs.map { it to score(want.title, want.artist, wantSec, it.title, it.artists, it.durationSec) }
            .filter { acceptable(it.second) }.maxByOrNull { it.second.score }?.let { return it.first.id }
        // Some songs are only on YouTube as videos ("Artist - Title (Official Video)"): the length must match.
        return search(query, VIDEOS).asSequence()
            .map { it to score(want.title, want.artist, wantSec, videoTitleWithoutArtist(it.title, want.artist), it.artists + " " + it.title, it.durationSec) }
            .filter { (_, s) -> s.durationOk && s.titleScore >= 0.6 && s.artistScore >= 0.5 }
            .maxByOrNull { it.second.score }?.first?.id
    }

    private fun search(query: String, filter: String): List<Candidate> {
        val body = buildJsonObject {
            putJsonObject("context") { putJsonObject("client") { put("clientName", "WEB_REMIX"); put("clientVersion", MUSIC_VERSION); put("hl", "en") } }
            put("query", query); put("params", filter)
        }
        val o = post("https://music.youtube.com/youtubei/v1/search?prettyPrint=false", body, WEB_UA, origin = "https://music.youtube.com")
        (o["responseContext"] as? JsonObject)?.str("visitorData")?.let { prefs.edit().putString("visitor", it).putLong("visitorAt", System.currentTimeMillis()).apply() }
        return listItems(o).mapNotNull { r ->
            val id = ((r["playlistItemData"] as? JsonObject)?.str("videoId")) ?: return@mapNotNull null
            val cols = (r["flexColumns"] as? JsonArray).orEmpty().map { col ->
                (((col as? JsonObject)?.get("musicResponsiveListItemFlexColumnRenderer") as? JsonObject)?.get("text") as? JsonObject)
                    ?.let { t -> (t["runs"] as? JsonArray).orEmpty().joinToString("") { (it as? JsonObject)?.str("text").orEmpty() } }.orEmpty()
            }
            // "Artist, Artist • Album • 3:45" (songs) or "Artist • 1.2M views • 3:45" (videos).
            val parts = cols.getOrNull(1).orEmpty().split(" • ")
            Candidate(id, cols.firstOrNull().orEmpty(), parts.firstOrNull().orEmpty(), parts.lastOrNull()?.let(::seconds) ?: 0)
        }.take(6)
    }

    private fun listItems(e: JsonElement?): List<JsonObject> = when (e) {
        is JsonObject -> (e["musicResponsiveListItemRenderer"] as? JsonObject)?.let { listOf(it) } ?: e.values.flatMap { listItems(it) }
        is JsonArray -> e.flatMap { listItems(it) }
        else -> emptyList()
    }

    // ---- audio ----

    private fun audioUrl(videoId: String): String {
        links[videoId]?.let { (url, expires) -> if (expires - System.currentTimeMillis() > 5 * 60_000) return url }
        val visitor = visitor()
        val body = buildJsonObject {
            putJsonObject("context") {
                putJsonObject("client") {
                    put("clientName", "VISIONOS"); put("clientVersion", "1.02"); put("deviceMake", "Apple"); put("deviceModel", "RealityDevice17,1")
                    put("userAgent", VISION_UA); put("osName", "visionOS"); put("osVersion", "26.5.23O471"); put("hl", "en")
                    if (visitor != null) put("visitorData", visitor)
                }
            }
            put("videoId", videoId); put("contentCheckOk", true); put("racyCheckOk", true)
        }
        val o = post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", body, VISION_UA, visitor = visitor, clientName = "101", clientVersion = "1.02")
        val status = o["playabilityStatus"] as? JsonObject
        if (status?.str("status") != "OK") {
            // A refused visitor id is dropped, so the next try gets a new one.
            if (status?.str("status") == "LOGIN_REQUIRED") prefs.edit().remove("visitor").apply()
            throw IOException(status?.str("reason") ?: "YouTube wouldn't play this song.")
        }
        val formats = ((o["streamingData"] as? JsonObject)?.get("adaptiveFormats") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .filter { it.str("mimeType")?.startsWith("audio/") == true && it.str("url") != null }
        // Opus first (the best YouTube offers), then AAC; the highest bitrate of the kind.
        val best = formats.maxWithOrNull(compareBy<JsonObject> { if (it.str("mimeType")!!.startsWith("audio/webm")) 1 else 0 }.thenBy { it.str("bitrate")?.toIntOrNull() ?: 0 })
            ?: throw IOException("YouTube didn't give an audio stream.")
        val url = best.str("url")!!
        val expires = Uri.parse(url).getQueryParameter("expire")?.toLongOrNull()?.times(1000) ?: (System.currentTimeMillis() + 3_600_000)
        links[videoId] = url to expires
        return url
    }

    /** YouTube's visitor id, from a YouTube Music page; kept for a day. */
    private fun visitor(): String? {
        prefs.getString("visitor", null)?.takeIf { System.currentTimeMillis() - prefs.getLong("visitorAt", 0) < 86_400_000 }?.let { return it }
        return runCatching { search("music", SONGS) }.let { prefs.getString("visitor", null) }
    }

    private fun post(url: String, body: JsonObject, ua: String, origin: String = "https://www.youtube.com", visitor: String? = null, clientName: String? = null, clientVersion: String? = null): JsonObject {
        val request = Request.Builder().url(url).header("User-Agent", ua).header("Origin", origin)
            .apply { visitor?.let { header("X-Goog-Visitor-Id", it) }; clientName?.let { header("X-YouTube-Client-Name", it) }; clientVersion?.let { header("X-YouTube-Client-Version", it) } }
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        return http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException("YouTube answered ${res.code}")
            Json.parseToJsonElement(res.body.string()) as? JsonObject ?: throw IOException("YouTube gave an unreadable answer.")
        }
    }

    data class Score(val score: Double, val titleScore: Double, val artistScore: Double, val durationOk: Boolean)

    companion object {
        private const val MUSIC_VERSION = "1.20260707.12.00"
        private const val SONGS = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
        private const val VIDEOS = "EgWKAQIQAWoMEA4QChADEAQQCRAF"
        private const val WEB_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
        private const val VISION_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

        private fun seconds(text: String): Int? {
            val p = text.trim().split(':').map { it.toIntOrNull() ?: return null }
            return if (p.size in 2..3) p.fold(0) { acc, x -> acc * 60 + x } else null
        }

        /** A comparable title or artist: no "(feat. …)", "[Mixed]", "- Remastered 2011" or punctuation. */
        fun normalise(text: String): String = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
            .replace(Regex("""[(\[](feat\.?|ft\.?|with|mixed|explicit|clean|official[^)\]]*|audio|lyrics?[^)\]]*)[^)\]]*[)\]]"""), " ")
            .replace(Regex("""\s+-\s+(\d{4}\s+)?remaster(ed)?.*$"""), " ")
            .replace(Regex("""\s+(feat\.?|ft\.?)\s+.*$"""), " ")
            .replace("&", " and ")
            .replace(Regex("[^a-z0-9]+"), " ").trim()

        private fun words(text: String) = normalise(text).split(' ').filter { it.isNotEmpty() }.toSet()

        fun similarity(a: String, b: String): Double {
            val x = words(a); val y = words(b)
            if (x.isEmpty() || y.isEmpty()) return 0.0
            return 2.0 * x.count { it in y } / (x.size + y.size)
        }

        /** Share of the wanted words found in [text] (YouTube lists every featured artist). */
        fun containment(wanted: String, text: String): Double {
            val x = words(wanted); val y = words(text)
            return if (x.isEmpty()) 0.0 else x.count { it in y }.toDouble() / x.size
        }

        fun firstArtist(artist: String) = artist.split(Regex(",|&| x | and | feat\\.? | ft\\.? ", RegexOption.IGNORE_CASE)).first().trim()

        fun score(wantTitle: String, wantArtist: String, wantSec: Int, title: String, artists: String, sec: Int): Score {
            val titleScore = similarity(wantTitle, title)
            val artistScore = if (wantArtist.isNotBlank()) containment(firstArtist(wantArtist), artists)
                else if (titleScore >= 0.99 && wantSec > 0 && sec > 0 && kotlin.math.abs(wantSec - sec) <= 3) 1.0 else 0.0
            val diff = if (wantSec > 0 && sec > 0) kotlin.math.abs(wantSec - sec) else 0
            val durationOk = wantSec == 0 || sec == 0 || diff <= maxOf(8.0, wantSec * 0.05)
            val total = titleScore * 0.55 + artistScore * 0.35 + (if (durationOk) 0.1 else 0.0) - (if (wantSec > 0 && sec > 0) minOf(0.3, diff / 120.0) else 0.0)
            return Score(total, titleScore, artistScore, durationOk)
        }

        fun acceptable(s: Score) = s.artistScore >= 0.5 && ((s.durationOk && s.titleScore >= 0.5) || s.titleScore >= 0.8)

        /** "Bullet For My Valentine - Hand of Blood (Official Video)" → "Hand of Blood (Official Video)". */
        fun videoTitleWithoutArtist(title: String, artist: String): String {
            val dash = Regex("""\s[-–—|]\s""").find(title) ?: return title
            return if (dash.range.first > 0 && containment(firstArtist(artist), title.substring(0, dash.range.first)) >= 0.5) title.substring(dash.range.last + 1) else title
        }

        /** The address a streamed song is played from when it comes from YouTube Music. */
        fun uriFor(s: WantedSong): String = Uri.Builder().scheme("ytm").authority("song")
            .appendQueryParameter("key", s.key).appendQueryParameter("title", s.title).appendQueryParameter("artist", s.artist)
            .appendQueryParameter("album", s.album).appendQueryParameter("duration", s.durationMs.toString()).build().toString()

        fun wantedFrom(uri: Uri): WantedSong? = if (uri.scheme != "ytm") null else WantedSong(
            uri.getQueryParameter("key") ?: return null, uri.getQueryParameter("title").orEmpty(), uri.getQueryParameter("artist").orEmpty(),
            uri.getQueryParameter("album").orEmpty(), uri.getQueryParameter("duration")?.toLongOrNull() ?: 0,
        )
    }
}
