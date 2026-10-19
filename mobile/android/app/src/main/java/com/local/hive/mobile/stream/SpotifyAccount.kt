package com.local.hive.mobile.stream

import android.content.Context
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom

/** Who is signed in to Spotify, if anyone. */
data class SpotifyUser(val signedIn: Boolean = false, val name: String = "", val clientId: String = "", val error: String? = null)

/**
 * Signing in to Spotify for the user's own playlists, Liked Songs and search.
 * Spotify's PKCE flow: the user's own developer app (its Client ID, entered
 * once in Settings) and the browser; no secret is stored. Tokens stay in the
 * app's private storage and refresh themselves.
 */
class SpotifyAccount(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val prefs = context.getSharedPreferences("spotify", Context.MODE_PRIVATE)
    private val tokenLock = Mutex()
    private val _user = MutableStateFlow(SpotifyUser(prefs.getString(KEY_REFRESH, null) != null, prefs.getString(KEY_NAME, "").orEmpty(), prefs.getString(KEY_CLIENT, "").orEmpty()))
    val user: StateFlow<SpotifyUser> = _user.asStateFlow()

    fun setClientId(id: String) {
        prefs.edit().putString(KEY_CLIENT, id.trim()).apply()
        _user.value = _user.value.copy(clientId = id.trim(), error = null)
    }

    /** The browser page that asks the user to let Hive read their library. */
    fun authorizeUrl(): Uri {
        val verifier = randomString(64)
        val state = randomString(16)
        prefs.edit().putString(KEY_VERIFIER, verifier).putString(KEY_STATE, state).apply()
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        return Uri.parse("https://accounts.spotify.com/authorize").buildUpon()
            .appendQueryParameter("client_id", _user.value.clientId)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("redirect_uri", REDIRECT)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("state", state)
            .appendQueryParameter("scope", "playlist-read-private playlist-read-collaborative user-library-read user-read-private")
            .build()
    }

    /** Finishes sign-in from the browser's return to hive-mobile://spotify-auth. */
    suspend fun complete(callback: Uri) {
        val error = callback.getQueryParameter("error")
        if (error != null) { _user.value = _user.value.copy(error = if (error == "access_denied") "Spotify sign-in was cancelled." else "Spotify said: $error"); return }
        val code = callback.getQueryParameter("code") ?: return
        if (callback.getQueryParameter("state") != prefs.getString(KEY_STATE, null)) { _user.value = _user.value.copy(error = "Spotify sign-in didn't match; try again."); return }
        runCatching {
            token(FormBody.Builder().add("grant_type", "authorization_code").add("code", code).add("redirect_uri", REDIRECT)
                .add("client_id", _user.value.clientId).add("code_verifier", prefs.getString(KEY_VERIFIER, "").orEmpty()).build())
            val me = api("me")
            val name = me.str("display_name") ?: me.str("id").orEmpty()
            prefs.edit().putString(KEY_NAME, name).remove(KEY_VERIFIER).remove(KEY_STATE).apply()
            _user.value = _user.value.copy(signedIn = true, name = name, error = null)
        }.onFailure { _user.value = _user.value.copy(error = it.message ?: "Couldn't sign in to Spotify.") }
    }

    fun signOut() {
        prefs.edit().remove(KEY_ACCESS).remove(KEY_REFRESH).remove(KEY_EXPIRES).remove(KEY_NAME).apply()
        _user.value = SpotifyUser(clientId = _user.value.clientId)
    }

    /** The user's playlists (theirs and followed). */
    suspend fun playlists(): List<SpCard> = pages("me/playlists?limit=50", max = 500).mapNotNull { p ->
        val id = p.str("id") ?: return@mapNotNull null
        SpCard("playlist", id, p.str("name").orEmpty(), (p["owner"] as? JsonObject)?.str("display_name").orEmpty(), image(p["images"]))
    }

    /** Liked Songs, newest first. */
    suspend fun likedSongs(max: Int = 2_000): List<SpSong> = pages("me/tracks?limit=50", max).mapNotNull { (it["track"] as? JsonObject)?.let(::song) }

    /** A playlist's songs through the API, for private playlists the public page can't show. */
    suspend fun playlistSongs(id: String): List<SpSong> = pages("playlists/$id/tracks?limit=100", max = 2_000).mapNotNull { (it["track"] as? JsonObject)?.let(::song) }

    /** A playlist through the API: for private ones Spotify's public page won't show. */
    suspend fun playlist(id: String): SpCollection {
        val meta = api("playlists/$id?fields=name,owner(display_name),images")
        return SpCollection("playlist", id, meta.str("name").orEmpty(), (meta["owner"] as? JsonObject)?.str("display_name").orEmpty(), image(meta["images"]), playlistSongs(id))
    }

    data class Results(val playlists: List<SpCard>, val albums: List<SpCard>, val songs: List<SpSong>)

    suspend fun search(q: String): Results {
        val o = api("search?type=playlist,album,track&limit=20&q=${Uri.encode(q.trim())}")
        fun items(key: String) = ((o[key] as? JsonObject)?.get("items") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        return Results(
            playlists = items("playlists").mapNotNull { p -> p.str("id")?.let { SpCard("playlist", it, p.str("name").orEmpty(), (p["owner"] as? JsonObject)?.str("display_name").orEmpty(), image(p["images"])) } },
            albums = items("albums").mapNotNull { a -> a.str("id")?.let { SpCard("album", it, a.str("name").orEmpty(), artists(a), image(a["images"])) } },
            songs = items("tracks").mapNotNull(::song),
        )
    }

    private fun song(t: JsonObject): SpSong? {
        val id = t.str("id") ?: return null
        val album = t["album"] as? JsonObject
        return SpSong(id, t.str("name").orEmpty(), artists(t), album?.str("name").orEmpty(), t.long("duration_ms"), image(album?.get("images")), t.str("preview_url").orEmpty())
    }

    private fun artists(o: JsonObject) = (o["artists"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.str("name") }.joinToString(", ")
    private fun image(images: JsonElement?) = (images as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.maxByOrNull { it.long("width") }?.str("url").orEmpty()

    private suspend fun pages(first: String, max: Int): List<JsonObject> {
        val out = mutableListOf<JsonObject>()
        var next: String? = "$API$first"
        while (next != null && out.size < max) {
            val page = api(next)
            out += (page["items"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            next = page.str("next")
        }
        return out
    }

    private suspend fun api(path: String): JsonObject = withContext(Dispatchers.IO) {
        val url = if (path.startsWith("https://")) path else "$API$path"
        repeat(2) { attempt ->
            val request = Request.Builder().url(url.toHttpUrl()).header("Authorization", "Bearer ${accessToken()}").build()
            http.newCall(request).execute().use { res ->
                if (res.code == 401 && attempt == 0) { prefs.edit().putLong(KEY_EXPIRES, 0).apply(); return@use }
                if (res.code == 403) throw IOException("Spotify refused: is your Spotify account added under User Management in your developer app?")
                if (!res.isSuccessful) throw IOException("Spotify answered ${res.code}")
                return@withContext Json.parseToJsonElement(res.body.string()) as JsonObject
            }
        }
        throw IOException("Spotify sign-in expired. Sign in again in Settings.")
    }

    private suspend fun accessToken(): String = tokenLock.withLock {
        val access = prefs.getString(KEY_ACCESS, null)
        if (access != null && System.currentTimeMillis() < prefs.getLong(KEY_EXPIRES, 0) - 60_000) return access
        val refresh = prefs.getString(KEY_REFRESH, null) ?: throw IOException("Sign in to Spotify in Settings first.")
        token(FormBody.Builder().add("grant_type", "refresh_token").add("refresh_token", refresh).add("client_id", _user.value.clientId).build())
        return prefs.getString(KEY_ACCESS, null) ?: throw IOException("Couldn't refresh Spotify sign-in.")
    }

    private suspend fun token(body: FormBody) = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("https://accounts.spotify.com/api/token").post(body).build()
        http.newCall(request).execute().use { res ->
            val text = res.body.string()
            val o = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull()
            if (!res.isSuccessful || o == null) {
                if (o?.str("error") == "invalid_grant") { signOut(); throw IOException("Spotify sign-in expired. Sign in again in Settings.") }
                throw IOException(o?.str("error_description") ?: "Spotify answered ${res.code}")
            }
            prefs.edit()
                .putString(KEY_ACCESS, o.str("access_token"))
                .putLong(KEY_EXPIRES, System.currentTimeMillis() + o.long("expires_in") * 1000)
                .apply { o.str("refresh_token")?.let { putString(KEY_REFRESH, it) } }
                .apply()
        }
    }

    private fun randomString(length: Int): String {
        val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        val random = SecureRandom()
        return String(CharArray(length) { chars[random.nextInt(chars.length)] })
    }

    companion object {
        const val REDIRECT = "hive-mobile://spotify-auth"
        private const val API = "https://api.spotify.com/v1/"
        private const val KEY_CLIENT = "clientId"
        private const val KEY_ACCESS = "access"
        private const val KEY_REFRESH = "refresh"
        private const val KEY_EXPIRES = "expiresAt"
        private const val KEY_NAME = "name"
        private const val KEY_VERIFIER = "verifier"
        private const val KEY_STATE = "state"

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
        private fun JsonObject.long(key: String): Long = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong() ?: 0
    }
}
