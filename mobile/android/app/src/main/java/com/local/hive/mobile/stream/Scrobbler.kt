package com.local.hive.mobile.stream

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.MessageDigest

/** A listen to report. */
@Serializable
data class Listen(val title: String, val artist: String, val album: String, val durationMs: Long, val startedAt: Long, val service: String = "")

@Serializable
data class ScrobbleSettings(
    val listenBrainz: Boolean = false,
    val listenBrainzToken: String = "",
    val lastFm: Boolean = false,
    val lastFmKey: String = "",
    val lastFmSecret: String = "",
    val lastFmSession: String = "",
    val lastFmUser: String = "",
    val lastFmPendingToken: String = "",
    val queued: Int = 0,
    val lastError: String? = null,
)

/**
 * Hive's scrobbling, as on the PC: ListenBrainz with the user's token and
 * Last.fm with the user's own API key and secret (signed in once in the
 * browser). "Now playing" is sent when a song starts and the listen when it
 * counts as played; listens that can't be sent wait and go with the next.
 */
class Scrobbler(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val prefs = context.getSharedPreferences("scrobbling", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()
    private val _settings = MutableStateFlow(prefs.getString("settings", null)?.let { runCatching { json.decodeFromString<ScrobbleSettings>(it) }.getOrNull() } ?: ScrobbleSettings())
    val settings: StateFlow<ScrobbleSettings> = _settings.asStateFlow()

    fun update(change: (ScrobbleSettings) -> ScrobbleSettings) {
        val next = change(_settings.value)
        _settings.value = next
        prefs.edit().putString("settings", json.encodeToString(ScrobbleSettings.serializer(), next)).apply()
    }

    private val active get() = _settings.value.let { (it.listenBrainz && it.listenBrainzToken.isNotBlank()) || (it.lastFm && it.lastFmSession.isNotBlank()) }

    suspend fun nowPlaying(l: Listen) = withContext(Dispatchers.IO) {
        if (!active) return@withContext
        val s = _settings.value
        if (s.listenBrainz && s.listenBrainzToken.isNotBlank()) runCatching { listenBrainz("playing_now", listOf(l), s.listenBrainzToken) }
        if (s.lastFm && s.lastFmSession.isNotBlank()) runCatching {
            lastFmPost(mapOf("method" to "track.updateNowPlaying", "artist" to l.artist, "track" to l.title, "album" to l.album, "duration" to (l.durationMs / 1000).toString()), s)
        }
    }

    /** Sends [l] with anything still waiting; what fails waits for the next try. */
    suspend fun scrobble(l: Listen?) = withContext(Dispatchers.IO) {
        lock.withLock {
            if (!active) return@withLock
            val waiting = (queue() + listOfNotNull(l)).takeLast(1_000)
            if (waiting.isEmpty()) return@withLock
            val s = _settings.value
            var error: String? = null
            val sentLb = if (s.listenBrainz && s.listenBrainzToken.isNotBlank()) runCatching { waiting.chunked(100).forEach { listenBrainz("import", it, s.listenBrainzToken) }; true }.getOrElse { error = "ListenBrainz: ${it.message}"; false } else true
            val sentLf = if (s.lastFm && s.lastFmSession.isNotBlank()) runCatching {
                waiting.chunked(50).forEach { batch ->
                    val params = mutableMapOf("method" to "track.scrobble")
                    batch.forEachIndexed { i, x ->
                        params["artist[$i]"] = x.artist; params["track[$i]"] = x.title; params["timestamp[$i]"] = (x.startedAt / 1000).toString()
                        if (x.album.isNotBlank()) params["album[$i]"] = x.album
                        if (x.durationMs > 0) params["duration[$i]"] = (x.durationMs / 1000).toString()
                    }
                    lastFmPost(params, s)
                }
                true
            }.getOrElse { error = "Last.fm: ${it.message}"; false } else true
            // A listen leaves the queue once every enabled service has it.
            setQueue(if (sentLb && sentLf) emptyList() else waiting)
            update { it.copy(queued = if (sentLb && sentLf) 0 else waiting.size, lastError = error) }
        }
    }

    // ---- Last.fm sign-in (desktop flow: a token approved in the browser, then a session) ----

    suspend fun lastFmAuthUrl(): Uri = withContext(Dispatchers.IO) {
        val s = _settings.value
        if (s.lastFmKey.isBlank() || s.lastFmSecret.isBlank()) throw IOException("Enter a Last.fm API key and shared secret first.")
        val o = getJson("https://ws.audioscrobbler.com/2.0/?method=auth.getToken&api_key=${Uri.encode(s.lastFmKey)}&format=json")
        val token = o.str("token") ?: throw IOException(o.str("message") ?: "Last.fm didn't give a sign-in token.")
        update { it.copy(lastFmPendingToken = token, lastError = null) }
        Uri.parse("https://www.last.fm/api/auth/?api_key=${Uri.encode(s.lastFmKey)}&token=${Uri.encode(token)}")
    }

    suspend fun finishLastFm() = withContext(Dispatchers.IO) {
        val s = _settings.value
        val params = mapOf("method" to "auth.getSession", "api_key" to s.lastFmKey, "token" to s.lastFmPendingToken)
        val o = getJson("https://ws.audioscrobbler.com/2.0/?" + (params + ("api_sig" to signature(params, s.lastFmSecret)) + ("format" to "json")).entries.joinToString("&") { "${it.key}=${Uri.encode(it.value)}" })
        val session = (o["session"] as? JsonObject) ?: throw IOException(o.str("message") ?: "Approve Hive on the Last.fm page first.")
        update { it.copy(lastFmSession = session.str("key").orEmpty(), lastFmUser = session.str("name").orEmpty(), lastFmPendingToken = "", lastFm = true, lastError = null) }
    }

    private fun listenBrainz(type: String, listens: List<Listen>, token: String) {
        val body = buildJsonObject {
            put("listen_type", type)
            put("payload", buildJsonArray {
                listens.forEach { l ->
                    add(buildJsonObject {
                        if (type != "playing_now") put("listened_at", l.startedAt / 1000)
                        put("track_metadata", buildJsonObject {
                            put("artist_name", l.artist); put("track_name", l.title)
                            if (l.album.isNotBlank()) put("release_name", l.album)
                            put("additional_info", buildJsonObject {
                                put("media_player", "Hive Mobile"); put("submission_client", "Hive Mobile")
                                if (l.durationMs > 0) put("duration_ms", l.durationMs)
                                if (l.service.isNotBlank()) put("music_service_name", l.service)
                            })
                        })
                    })
                }
            })
        }.toString()
        val request = Request.Builder().url("https://api.listenbrainz.org/1/submit-listens").header("Authorization", "Token $token")
            .post(body.toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use { if (!it.isSuccessful) throw IOException(if (it.code == 401) "the token was refused" else "answered ${it.code}") }
    }

    private fun lastFmPost(params: Map<String, String>, s: ScrobbleSettings) {
        val all = params.filterValues { it.isNotBlank() } + ("api_key" to s.lastFmKey) + ("sk" to s.lastFmSession)
        val form = FormBody.Builder().apply { (all + ("api_sig" to signature(all, s.lastFmSecret)) + ("format" to "json")).forEach { (k, v) -> add(k, v) } }.build()
        http.newCall(Request.Builder().url("https://ws.audioscrobbler.com/2.0/").post(form).build()).execute().use { res ->
            val o = runCatching { Json.parseToJsonElement(res.body.string()) as JsonObject }.getOrNull()
            if (!res.isSuccessful || o?.containsKey("error") == true) {
                if (o?.str("error") == "9") update { it.copy(lastFmSession = "", lastFm = false) } // the session was revoked
                throw IOException(o?.str("message") ?: "answered ${res.code}")
            }
        }
    }

    private fun getJson(url: String): JsonObject = http.newCall(Request.Builder().url(url).build()).execute().use { res ->
        runCatching { Json.parseToJsonElement(res.body.string()) as JsonObject }.getOrNull() ?: throw IOException("Last.fm answered ${res.code}")
    }

    private fun queue(): List<Listen> = prefs.getString("queue", null)?.let { runCatching { json.decodeFromString(ListSerializer(Listen.serializer()), it) }.getOrNull() }.orEmpty()
    private fun setQueue(list: List<Listen>) = prefs.edit().putString("queue", json.encodeToString(ListSerializer(Listen.serializer()), list)).apply()

    companion object {
        /** Last.fm's api_sig: md5 of the sorted name/value pairs and the secret, leaving out format and callback. */
        fun signature(params: Map<String, String>, secret: String): String {
            val base = params.filterKeys { it != "format" && it != "callback" }.toSortedMap().entries.joinToString("") { it.key + it.value } + secret
            return MessageDigest.getInstance("MD5").digest(base.toByteArray()).joinToString("") { "%02x".format(it) }
        }
        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}
