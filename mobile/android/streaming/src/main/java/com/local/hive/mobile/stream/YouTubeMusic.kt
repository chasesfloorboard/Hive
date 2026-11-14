package com.local.hive.mobile.stream
import com.local.hive.mobile.data.normalise
import com.local.hive.mobile.data.similarity
import com.local.hive.mobile.data.containment
import com.local.hive.mobile.data.firstArtist

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
import java.io.File
import java.io.IOException
import java.text.Normalizer
import java.util.concurrent.ConcurrentHashMap

/** A song wanted in full: what Apple Music or Spotify said about it. */
/** Moved to :core so :playback can name it without depending on :streaming; kept here under its old name. */
typealias WantedSong = com.local.hive.mobile.data.WantedSong

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
class YouTubeMusic(context: Context, private val http: OkHttpClient = com.local.hive.mobile.data.defaultHttp()) : com.local.hive.mobile.data.YouTubeMusicPort {
    private val prefs = context.getSharedPreferences("youtube-music", Context.MODE_PRIVATE)
    private val links = ConcurrentHashMap<String, Pair<String, Long>>() // videoId -> (audio url, expires at)
    private val locks = ConcurrentHashMap<String, Any>()
    /** Songs the phone doesn't have always play in full this way (there's no setting for it). */
    override val enabled: kotlinx.coroutines.flow.StateFlow<Boolean> = kotlinx.coroutines.flow.MutableStateFlow(true)

    /** The playable address for [song]; blocking, so call it off the main thread. */
    override fun resolve(song: WantedSong): String = synchronized(locks.getOrPut(song.key) { Any() }) {
        prefs.getString("match:${song.key}", null)?.let { id -> runCatching { return audioUrl(id) } }
        val id = findMatch(song) ?: throw IOException("Couldn't find “${song.title}” to play in full.")
        prefs.edit().putString("match:${song.key}", id).apply()
        audioUrl(id)
    }


    /**
     * Auto DJ for streamed songs: YouTube Music's radio from [song] (similar
     * songs, as its app plays after one), up to [max], without [song] itself.
     * Each comes already matched, so it starts without a search. Blocking.
     */
    override fun radio(song: WantedSong, max: Int): List<com.local.hive.mobile.data.StreamTrack> {
        val seed = prefs.getString("match:${song.key}", null) ?: findMatch(song)?.also { prefs.edit().putString("match:${song.key}", it).apply() } ?: return emptyList()
        val body = buildJsonObject {
            putJsonObject("context") { putJsonObject("client") { put("clientName", "WEB_REMIX"); put("clientVersion", MUSIC_VERSION); put("hl", "en") } }
            put("videoId", seed); put("playlistId", "RDAMVM$seed"); put("isAudioOnly", true)
        }
        val o = post("https://music.youtube.com/youtubei/v1/next?prettyPrint=false", body, WEB_UA, origin = "https://music.youtube.com")
        val edit = prefs.edit()
        val out = radioItems(o).filter { it.second != seed }.distinctBy { it.second }.take(max).map { (track, id) -> edit.putString("match:${track.key}", id); track }
        edit.apply()
        return out
    }

    /** Forgets [key]'s audio link (it was refused), so the next resolve fetches a new one. */
    override fun invalidate(key: String) {
        prefs.getString("match:$key", null)?.let { links.remove(it); prefs.edit().remove("link:$it").apply() }
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

    /**
     * Saves [song]'s audio to [out] for keeping: YouTube's best AAC (M4A, which
     * tags can be written to; its Opus comes as WebM, which they can't), fetched
     * in parts as YouTube's servers want. Blocking. Returns the video's id.
     */
    fun saveAudio(song: WantedSong, out: File, progress: (Long, Long) -> Unit = { _, _ -> }): String {
        val id = prefs.getString("match:${song.key}", null) ?: findMatch(song)?.also { prefs.edit().putString("match:${song.key}", it).apply() }
            ?: throw IOException("Couldn't find “${song.title}” on YouTube.")
        val aac = playerFormats(id).filter { it.str("mimeType")?.startsWith("audio/mp4") == true }
            .maxByOrNull { it.str("bitrate")?.toIntOrNull() ?: 0 } ?: throw IOException("YouTube has no AAC audio for “${song.title}”.")
        val url = aac.str("url")!!
        val total = aac.str("contentLength")?.toLongOrNull() ?: 0L
        out.outputStream().use { sink ->
            var at = 0L
            while (total == 0L || at < total) {
                val end = if (total > 0) minOf(total - 1, at + PART - 1) else at + PART - 1
                val req = Request.Builder().url(url).header("User-Agent", VISION_UA).header("Range", "bytes=$at-$end").build()
                val got = http.newCall(req).execute().use { res ->
                    if (res.code == 416) 0L
                    else if (!res.isSuccessful) throw IOException("YouTube answered ${res.code}")
                    else res.body.byteStream().use { it.copyTo(sink) }
                }
                if (got <= 0L) break
                at += got
                progress(at, total)
                if (total == 0L && got < PART) break
            }
            if (total > 0 && at < total) throw IOException("The download stopped at $at of $total bytes.")
        }
        return id
    }

    private fun playerFormats(videoId: String): List<JsonObject> {
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
            throw IOException(status?.str("reason") ?: "This song can't be played in full right now.")
        }
        return ((o["streamingData"] as? JsonObject)?.get("adaptiveFormats") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .filter { it.str("mimeType")?.startsWith("audio/") == true && it.str("url") != null }
    }

    private fun audioUrl(videoId: String): String {
        val cacheKey = videoId
        // Links last hours: kept across restarts, so a song played earlier today starts without asking YouTube.
        (links[cacheKey] ?: prefs.getString("link:$cacheKey", null)?.split('|', limit = 2)?.takeIf { it.size == 2 }?.let { (at, url) -> url to (at.toLongOrNull() ?: 0L) })
            ?.let { (url, expires) -> if (expires - System.currentTimeMillis() > 5 * 60_000) { links[cacheKey] = url to expires; return url } }
        val formats = playerFormats(videoId)
        // Opus first (the best YouTube offers), then AAC; the highest bitrate of the kind.
        val preferred = "audio/webm"
        val best = formats.maxWithOrNull(compareBy<JsonObject> { if (it.str("mimeType")!!.startsWith(preferred)) 1 else 0 }.thenBy { it.str("bitrate")?.toIntOrNull() ?: 0 })
            ?: throw IOException("No audio came for this song.")
        val url = best.str("url")!!
        val expires = Uri.parse(url).getQueryParameter("expire")?.toLongOrNull()?.times(1000) ?: (System.currentTimeMillis() + 3_600_000)
        links[cacheKey] = url to expires
        prefs.edit().apply {
            putString("link:$cacheKey", "$expires|$url")
            // Now and then, expired links go.
            if (Math.random() < 0.05) prefs.all.forEach { (k, v) -> if (k.startsWith("link:") && ((v as? String)?.substringBefore('|')?.toLongOrNull() ?: 0L) < System.currentTimeMillis()) remove(k) }
        }.apply()
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
            if (!res.isSuccessful) throw IOException("The song server answered ${res.code}")
            Json.parseToJsonElement(res.body.string()) as? JsonObject ?: throw IOException("The song server gave an unreadable answer.")
        }
    }

    data class Score(val score: Double, val titleScore: Double, val artistScore: Double, val durationOk: Boolean)

    companion object {
        private const val MUSIC_VERSION = "1.20260707.12.00"
        private const val SONGS = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
        private const val VIDEOS = "EgWKAQIQAWoMEA4QChADEAQQCRAF"
        private const val WEB_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
        /** How much of a song one request fetches when saving it. */
        private const val PART = 4L * 1024 * 1024
        private const val VISION_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

        private fun seconds(text: String): Int? {
            val p = text.trim().split(':').map { it.toIntOrNull() ?: return null }
            return if (p.size in 2..3) p.fold(0) { acc, x -> acc * 60 + x } else null
        }

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

        /** The address a streamed song is played from when it comes from YouTube Music. Impl in :core. */
        fun uriFor(s: WantedSong): String = com.local.hive.mobile.data.ytmUriFor(s)

        /** The songs in a YouTube Music "next" answer (its radio), each with its video id. */
        fun radioItems(o: JsonElement): List<Pair<com.local.hive.mobile.data.StreamTrack, String>> {
            val found = mutableListOf<JsonObject>()
            fun walk(e: JsonElement?) {
                when (e) {
                    is JsonObject -> (e["playlistPanelVideoRenderer"] as? JsonObject)?.let { found += it } ?: e.values.forEach(::walk)
                    is JsonArray -> e.forEach(::walk)
                    else -> Unit
                }
            }
            walk(o)
            fun runs(e: JsonElement?) = ((e as? JsonObject)?.get("runs") as? JsonArray).orEmpty().joinToString("") { (it as? JsonObject)?.str("text").orEmpty() }
            return found.mapNotNull { p ->
                val id = p.str("videoId") ?: return@mapNotNull null
                val title = runs(p["title"]).ifBlank { return@mapNotNull null }
                // "Artist • Album • 2002" (or "Artist • 1.2M views • 2019" for a video).
                val byline = runs(p["longBylineText"]).split(" • ")
                val album = byline.getOrNull(1)?.takeUnless { Regex("""views?$|^\d{4}$""").containsMatchIn(it) }.orEmpty()
                val art = (((p["thumbnail"] as? JsonObject)?.get("thumbnails") as? JsonArray)?.lastOrNull() as? JsonObject)?.str("url").orEmpty()
                    .replace(Regex("""=w\d+-h\d+.*$"""), "=w600-h600-l90-rj")
                com.local.hive.mobile.data.StreamTrack(
                    key = "yt:$id", source = "Auto DJ", title = title, artist = byline.firstOrNull().orEmpty(), album = album,
                    durationMs = (seconds(runs(p["lengthText"])) ?: 0) * 1000L, artworkUrl = art, previewUrl = "", url = "https://music.youtube.com/watch?v=$id",
                ) to id
            }
        }

        fun wantedFrom(uri: Uri): WantedSong? = com.local.hive.mobile.data.wantedFrom(uri)
    }
}
