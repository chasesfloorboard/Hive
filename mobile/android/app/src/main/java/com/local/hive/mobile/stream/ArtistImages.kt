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
 * only an exact name match (a wrong person's photo is worse than none).
 * The photo's address is remembered per artist and misses for six hours;
 * Coil keeps the pictures themselves.
 */
class ArtistImages(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val prefs = context.getSharedPreferences("artist-images", Context.MODE_PRIVATE)
    private val memory = HashMap<String, String?>()
    // Long artist lists scroll fast; a few lookups at a time keeps Deezer happy.
    private val gate = Semaphore(3)

    suspend fun lookup(artist: String): String? {
        val name = primary(artist)
        val key = normalize(name)
        if (key.isEmpty()) return null
        synchronized(memory) { if (memory.containsKey(key)) return memory[key] }
        prefs.getString(key, null)?.let { saved ->
            if (saved.startsWith("https://")) return saved.also { synchronized(memory) { memory[key] = it } }
            if (saved.startsWith("miss:") && System.currentTimeMillis() - (saved.removePrefix("miss:").toLongOrNull() ?: 0) < MISS_TTL_MS) return null
        }
        val found = gate.withPermit { withContext(Dispatchers.IO) { runCatching { search(name, key) }.getOrNull() } }
        synchronized(memory) { memory[key] = found }
        prefs.edit().putString(key, found ?: "miss:${System.currentTimeMillis()}").apply()
        return found
    }

    private fun search(name: String, key: String): String? {
        val url = "https://api.deezer.com/search/artist".toHttpUrl().newBuilder().addQueryParameter("q", name).addQueryParameter("limit", "5").build()
        val body = http.newCall(Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { if (it.isSuccessful) it.body.string() else return null }
        val results = ((Json.parseToJsonElement(body) as? JsonObject)?.get("data") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        for (r in results) {
            if (normalize(r.str("name").orEmpty()) != key) continue
            val image = r.str("picture_xl") ?: r.str("picture_big") ?: continue
            // Deezer lists duplicates; those without a photo have an empty image hash.
            if (!image.contains("/artist//") && image.toHttpUrl().host.endsWith("dzcdn.net")) return image
        }
        return null
    }

    companion object {
        private const val MISS_TTL_MS = 6 * 60 * 60 * 1000L
        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull?.ifBlank { null }
        fun normalize(v: String) = Normalizer.normalize(v.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").replace(Regex("[^a-z0-9]+"), " ").trim()
        /** "A feat. B", "A & B", "A, B" -> "A": the photo is of the main artist. */
        fun primary(v: String) = v.split(Regex("""\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[;,/&]\s*""", RegexOption.IGNORE_CASE)).first().trim()
    }
}
