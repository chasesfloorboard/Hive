package com.local.hive.mobile.stream

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.text.Normalizer

/**
 * Artist photos as Hive finds them: Deezer's public artist search, taking
 * only an exact name match (a wrong person's photo is worse than none): the
 * whole name first ("Tyler, The Creator" is one artist, not "Tyler"), and of
 * several artists by that name the best known. One barely anyone follows is
 * likely another person of the same name, so the album cover shows instead.
 * The photo's address is remembered per artist and misses for six hours;
 * Coil keeps the pictures themselves.
 */
class ArtistImages(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    // A new name: photos picked by the older rules (the first of a name, a split name) are looked up again.
    private val prefs = context.getSharedPreferences("artist-images-2", Context.MODE_PRIVATE)
    private val memory = HashMap<String, String?>()
    // Long artist lists scroll fast; a few lookups at a time keeps Deezer happy.
    private val gate = Semaphore(3)

    // Artist photos from the internet (Deezer), or none, so pages show one of the artist's album
    // covers instead. Off unless turned on: looking a photo up sends the artist's name out.
    private val settings = context.getSharedPreferences("artist-images-settings", Context.MODE_PRIVATE)
    private val _online = kotlinx.coroutines.flow.MutableStateFlow(settings.getBoolean("online", false))
    val online: kotlinx.coroutines.flow.StateFlow<Boolean> = _online
    fun setOnline(on: Boolean) { settings.edit().putBoolean("online", on).apply(); _online.value = on }

    suspend fun lookup(artist: String): String? {
        if (!_online.value) return null
        val key = normalize(artist.trim())
        if (key.isEmpty()) return null
        synchronized(memory) { if (memory.containsKey(key)) return memory[key] }
        prefs.getString(key, null)?.let { saved ->
            if (saved.startsWith("https://")) return saved.also { synchronized(memory) { memory[key] = it } }
            if (saved.startsWith("miss:") && System.currentTimeMillis() - (saved.removePrefix("miss:").toLongOrNull() ?: 0) < MISS_TTL_MS) return null
        }
        val names = listOf(artist.trim(), primary(artist)).distinctBy { normalize(it) }
        val found = gate.withPermit { withContext(Dispatchers.IO) { names.firstNotNullOfOrNull { n -> runCatching { search(n, normalize(n)) }.getOrNull() } } }
        synchronized(memory) { memory[key] = found }
        prefs.edit().putString(key, found ?: "miss:${System.currentTimeMillis()}").apply()
        return found
    }

    private fun search(name: String, key: String): String? {
        val url = "https://api.deezer.com/search/artist".toHttpUrl().newBuilder().addQueryParameter("q", name).addQueryParameter("limit", "5").build()
        val body = http.newCall(Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { if (it.isSuccessful) it.body.string() else return null }
        val results = ((Json.parseToJsonElement(body) as? JsonObject)?.get("data") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        // Deezer lists duplicates and namesakes: the best known one with a photo (those without have an empty image hash).
        val best = results.filter { normalize(it.str("name").orEmpty()) == key }
            .mapNotNull { r -> (r.str("picture_xl") ?: r.str("picture_big"))?.takeIf { !it.contains("/artist//") && it.toHttpUrl().host.endsWith("dzcdn.net") }?.let { it to (r.str("nb_fan")?.toLongOrNull() ?: 0L) } }
            .maxByOrNull { it.second } ?: return null
        return best.first.takeIf { best.second >= MIN_FANS }
    }

    companion object {
        private const val MISS_TTL_MS = 6 * 60 * 60 * 1000L
        /** Fewer followers than this, and it's likely a namesake: the album cover shows instead. */
        private const val MIN_FANS = 100L
        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull?.ifBlank { null }
        fun normalize(v: String) = Normalizer.normalize(v.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").replace(Regex("[^a-z0-9]+"), " ").trim()
        /** "A feat. B", "A & B", "A, B" -> "A": the photo is of the main artist. */
        fun primary(v: String) = v.split(Regex("""\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[;,/&]\s*""", RegexOption.IGNORE_CASE)).first().trim()
    }
}
