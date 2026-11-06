package com.local.hive.mobile.stream

import android.content.Context
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
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

/** Whether someone is signed in to Apple Music on this phone. */
data class AppleUser(val signedIn: Boolean = false, val storefront: String = "us", val error: String? = null)

/**
 * The user's own Apple Music library (playlists and songs), unofficially:
 * the user signs in on Apple's own web player page (Hive never sees the
 * password), which leaves a "media-user-token" behind, and Hive reads the
 * library through the same API that web player uses, with the web player's
 * public key. Apple doesn't offer this to other apps, so it can stop working
 * whenever Apple changes its web player. Songs play the way Hive plays any
 * streamed song; nothing here streams from Apple.
 */
class AppleAccount(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val prefs = context.getSharedPreferences("apple-music", Context.MODE_PRIVATE)
    private val keyLock = Mutex()
    private val _user = MutableStateFlow(AppleUser(prefs.getString(KEY_USER, null) != null, prefs.getString(KEY_STOREFRONT, "us") ?: "us"))
    val user: StateFlow<AppleUser> = _user.asStateFlow()

    /** Finishes sign-in with the token Apple's page left behind. */
    suspend fun complete(userToken: String) {
        prefs.edit().putString(KEY_USER, userToken.trim()).apply()
        runCatching {
            val sf = ((api("me/storefront")["data"] as? JsonArray)?.firstOrNull() as? JsonObject)?.str("id")?.lowercase() ?: "us"
            prefs.edit().putString(KEY_STOREFRONT, sf).apply()
            _user.value = AppleUser(true, sf)
        }.onFailure {
            prefs.edit().remove(KEY_USER).apply()
            _user.value = AppleUser(error = it.message ?: "Couldn't sign in to Apple Music.")
        }
    }

    fun failed(message: String) { _user.value = _user.value.copy(error = message) }

    fun signOut() {
        prefs.edit().remove(KEY_USER).remove(KEY_STOREFRONT).apply()
        _user.value = AppleUser()
    }

    /** The user's playlists, as cards that open with [libraryUrl]. */
    suspend fun playlists(): List<AmCard> = pages("me/library/playlists?limit=100", max = 1_000).mapNotNull { p ->
        val id = p.str("id") ?: return@mapNotNull null
        val a = p["attributes"] as? JsonObject ?: return@mapNotNull null
        AmCard("playlist", id, a.str("name").orEmpty(), "Your library", artwork(a["artwork"]), libraryUrl(id))
    }

    /** A library playlist's songs (or every song in the library for [SONGS_ID]). */
    suspend fun collection(url: String): AmCollection {
        val id = libraryId(url) ?: throw IOException("Not an Apple Music library link")
        if (id == SONGS_ID) {
            val songs = pages("me/library/songs?limit=100", max = 5_000).mapNotNull(::song)
            return AmCollection("playlist", id, storefront(), "Songs", "Your library", "", "", url, songs, emptyList())
        }
        val meta = ((api("me/library/playlists/$id")["data"] as? JsonArray)?.firstOrNull() as? JsonObject)?.get("attributes") as? JsonObject
        val songs = runCatching { pages("me/library/playlists/$id/tracks?limit=100", max = 5_000) }
            .getOrElse { if (it is NotFound) emptyList() else throw it } // an empty playlist answers 404
            .mapNotNull(::song)
        val description = (meta?.get("description") as? JsonObject)?.str("standard").orEmpty()
        return AmCollection("playlist", id, storefront(), meta?.str("name").orEmpty(), "Your library", description, artwork(meta?.get("artwork")), url, songs, emptyList())
    }

    private fun storefront() = _user.value.storefront

    private fun song(item: JsonObject): AmSong? {
        val a = item["attributes"] as? JsonObject ?: return null
        val title = a.str("name") ?: return null
        val catalogId = (a["playParams"] as? JsonObject)?.str("catalogId") ?: (a["playParams"] as? JsonObject)?.str("purchasedId")
        val id = catalogId ?: item.str("id") ?: return null
        return AmSong(
            appleId = id, title = title, artist = a.str("artistName").orEmpty(), album = a.str("albumName").orEmpty(),
            durationMs = a.long("durationInMillis"), artwork = artwork(a["artwork"]),
            url = if (catalogId != null) "https://music.apple.com/${storefront()}/song/$catalogId" else "",
            year = a.str("releaseDate")?.take(4).orEmpty(), genre = (a["genreNames"] as? JsonArray)?.firstOrNull()?.let { (it as? JsonPrimitive)?.contentOrNull }.orEmpty(),
        )
    }

    private suspend fun pages(first: String, max: Int): List<JsonObject> {
        val out = mutableListOf<JsonObject>()
        var next: String? = first
        while (next != null && out.size < max) {
            val page = api(next)
            out += (page["data"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            next = page.str("next")?.removePrefix("/v1/")
        }
        return out
    }

    private class NotFound : IOException("Not found")

    private suspend fun api(path: String): JsonObject = withContext(Dispatchers.IO) {
        val userToken = prefs.getString(KEY_USER, null) ?: throw IOException("Sign in to Apple Music in Settings first.")
        repeat(2) { attempt ->
            val request = Request.Builder().url("$API$path")
                .header("Authorization", "Bearer ${webPlayerKey(fresh = attempt > 0)}")
                .header("Media-User-Token", userToken)
                .header("Origin", "https://music.apple.com").header("Referer", "https://music.apple.com/")
                .header("User-Agent", AGENT).build()
            http.newCall(request).execute().use { res ->
                when {
                    res.code == 401 && attempt == 0 -> return@use // the web player's key changed: fetch it again
                    res.code == 401 || res.code == 403 -> {
                        signOut(); throw IOException("Apple Music sign-in expired. Sign in again in Settings.")
                    }
                    res.code == 404 -> throw NotFound()
                    !res.isSuccessful -> throw IOException("Apple Music answered ${res.code}")
                    else -> return@withContext Json.parseToJsonElement(res.body.string()) as JsonObject
                }
            }
        }
        throw IOException("Apple Music isn't letting Hive in right now. Apple may have changed its web player.")
    }

    /** The key Apple's own web player uses, read from its script and kept until it expires. */
    private suspend fun webPlayerKey(fresh: Boolean): String = keyLock.withLock {
        val kept = prefs.getString(KEY_DEV, null)
        if (!fresh && kept != null && System.currentTimeMillis() / 1000 < prefs.getLong(KEY_DEV_EXP, 0) - 3_600) return kept
        withContext(Dispatchers.IO) {
            val page = get("https://music.apple.com/us/browse")
            val script = Regex("""src="(/assets/index[^"]*\.js)"""").find(page)?.groupValues?.get(1)
                ?: throw IOException("Couldn't find Apple Music's web player")
            val key = findWebPlayerKey(get("https://music.apple.com$script")) ?: throw IOException("Apple Music's web player has changed; this sign-in no longer works.")
            prefs.edit().putString(KEY_DEV, key.first).putLong(KEY_DEV_EXP, key.second).apply()
            key.first
        }
    }

    private fun get(url: String): String = http.newCall(Request.Builder().url(url).header("User-Agent", AGENT).build()).execute().use { res ->
        if (!res.isSuccessful) throw IOException("Apple Music answered ${res.code}")
        res.body.string()
    }

    companion object {
        const val SONGS_ID = "songs"
        private const val API = "https://amp-api.music.apple.com/v1/"
        private const val AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
        private const val KEY_USER = "mediaUserToken"
        private const val KEY_STOREFRONT = "storefront"
        private const val KEY_DEV = "webPlayerKey"
        private const val KEY_DEV_EXP = "webPlayerKeyExpires"

        fun libraryUrl(id: String) = "apple-library:$id"
        fun libraryId(url: String) = url.takeIf { it.startsWith("apple-library:") }?.removePrefix("apple-library:")?.ifBlank { null }
        fun isLibrary(url: String) = libraryId(url) != null
        /** Where a library link opens on Apple's web player (any other link as it is). */
        fun webUrl(url: String) = when (val id = libraryId(url)) {
            null -> url
            SONGS_ID -> "https://music.apple.com/library/songs"
            else -> "https://music.apple.com/library/playlist/$id"
        }

        /** The web player's key in its script: the JWT whose issuer is "AMPWebPlay", with its expiry (seconds). */
        fun findWebPlayerKey(script: String): Pair<String, Long>? =
            Regex("""eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+""").findAll(script).firstNotNullOfOrNull { m ->
                val claims = runCatching { Json.parseToJsonElement(String(java.util.Base64.getUrlDecoder().decode(m.groupValues[1]))) as JsonObject }.getOrNull()
                if (claims?.str("iss") == "AMPWebPlay") m.value to claims.long("exp") else null
            }

        private fun artwork(art: JsonElement?, size: Int = 600): String =
            (art as? JsonObject)?.str("url")?.replace("{w}", "$size")?.replace("{h}", "$size")?.replace("{f}", "jpg").orEmpty()

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
        private fun JsonObject.long(key: String): Long = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong() ?: 0
    }
}
