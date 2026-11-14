package com.local.hive.mobile.discovery

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.text.Normalizer

/** A song's lyrics; [synced] lyrics are LRC text with [mm:ss.xx] stamps. */
@Serializable
data class Lyrics(val text: String, val synced: Boolean, val source: String) {
    /** Timed lines, for synced lyrics (parsed on each call; callers keep the result). */
    fun lines(): List<LyricLine> = if (synced) parseLrc(text) else emptyList()
}

data class LyricLine(val timeMs: Long, val text: String)

private val stamp = Regex("""\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]""")

fun parseLrc(text: String): List<LyricLine> = text.lineSequence().flatMap { line ->
    val stamps = stamp.findAll(line).toList()
    if (stamps.isEmpty()) return@flatMap emptySequence()
    val words = line.substring(stamps.last().range.last + 1).trim()
    stamps.asSequence().map { m ->
        val fraction = m.groupValues[3].let { f -> if (f.isEmpty()) 0L else f.padEnd(3, '0').take(3).toLong() }
        LyricLine(m.groupValues[1].toLong() * 60_000 + m.groupValues[2].toLong() * 1000 + fraction, words)
    }
}.sortedBy { it.timeMs }.toList()

private val creditBracket = Regex("""^\s*(?:feat\.?|ft\.?|featuring|prod\.?|produced|co-prod\.?|with)\b|remaster|explicit|clean version|album version|single version|radio edit|bonus track""", RegexOption.IGNORE_CASE)
private val brackets = Regex("""\s*[(\[]([^()\[\]]*)[)\]]""")
private val remasterTail = Regex("""\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$""", RegexOption.IGNORE_CASE)

/** The title without credit brackets ("(Prod. By …)", "(Feat. …)"), which lyrics sites leave out. */
fun lyricsSearchTitle(title: String): String {
    val original = title.trim()
    return original.replace(brackets) { m -> if (creditBracket.containsMatchIn(m.groupValues[1])) "" else m.value }
        .replace(remasterTail, "").replace(Regex("""\s{2,}"""), " ").trim().ifBlank { original }
}

fun lyricsNormalize(value: String) = Normalizer.normalize(value.lowercase(), Normalizer.Form.NFKD)
    .replace(Regex("""\p{M}+"""), "").replace(Regex("""[^a-z0-9]+"""), " ").trim()

private fun String.clean() = removePrefix("﻿").trim()
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

/**
 * LRCLIB — a public, CC0 crowd-sourced lyrics database (no login, no scraping): the compliant default
 * lyrics source for BOTH editions. Context-free (so it unit-tests against a MockWebServer) with an
 * injectable [base]; [LyricsStore] wraps it with the user's own lyrics and the on-disk cache.
 */
class Lrclib(
    private val http: OkHttpClient = com.local.hive.mobile.data.defaultHttp(),
    private val base: String = "https://lrclib.net",
) {
    /** The exact get endpoint: track + artist (+ album + duration when known). */
    fun exact(artist: String, title: String, album: String, durationMs: Long): Lyrics? = runCatching {
        val url = "$base/api/get".toHttpUrl().newBuilder()
            .addQueryParameter("track_name", title).addQueryParameter("artist_name", artist)
            .apply { if (album.isNotBlank()) addQueryParameter("album_name", album) }
            .apply { if (durationMs > 0) addQueryParameter("duration", (durationMs / 1000).toString()) }
            .build()
        val o = get(url.toString())?.let { Json.parseToJsonElement(it) as? JsonObject } ?: return null
        o.str("syncedLyrics")?.clean()?.ifBlank { null }?.let { return Lyrics(it, true, "LRCLIB") }
        o.str("plainLyrics")?.clean()?.ifBlank { null }?.let { Lyrics(it, false, "LRCLIB") }
    }.getOrNull()

    /** The search endpoint, kept only when title (ignoring credits) and artist match and the length is close. */
    fun search(artist: String, title: String, durationMs: Long): Lyrics? = runCatching {
        val url = "$base/api/search".toHttpUrl().newBuilder().addQueryParameter("track_name", title).addQueryParameter("artist_name", artist).build()
        val results = (get(url.toString())?.let { Json.parseToJsonElement(it) } as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val wantedTitle = lyricsNormalize(title)
        val wantedArtist = lyricsNormalize(artist)
        val fits = results.filter { r ->
            val seconds = r.str("duration")?.toDoubleOrNull() ?: 0.0
            lyricsNormalize(lyricsSearchTitle(r.str("trackName").orEmpty())) == wantedTitle &&
                lyricsNormalize(r.str("artistName").orEmpty()).let { it.contains(wantedArtist) || wantedArtist.contains(it) } &&
                (durationMs <= 0 || seconds <= 0 || kotlin.math.abs(seconds * 1000 - durationMs) <= 4_000)
        }
        val synced = fits.firstNotNullOfOrNull { r -> r.str("syncedLyrics")?.clean()?.ifBlank { null } }
        synced?.let { Lyrics(it, true, "LRCLIB") } ?: fits.firstNotNullOfOrNull { r -> r.str("plainLyrics")?.clean()?.ifBlank { null } }?.let { Lyrics(it, false, "LRCLIB") }
    }.getOrNull()

    private fun get(url: String): String? {
        val request = Request.Builder().url(url).header("User-Agent", "Hive Mobile (https://github.com/)").header("Accept-Language", "en-US,en;q=0.9").build()
        return http.newCall(request).execute().use { if (it.isSuccessful) it.body.string() else null }
    }
}

/**
 * Hive's lyrics, as on the PC, but COMPLIANT and keyless: LRCLIB first (see [Lrclib]). This lives in :core
 * so BOTH editions get lyrics. A [fallback] can be supplied by the full edition (Hive Mobile) to try another
 * source — e.g. Genius — when LRCLIB has nothing synced; the Google Play edition (Hive Clean) passes none, so
 * it stays LRCLIB-only. The user's own typed/fixed lyrics come first, and found lyrics are cached on the phone.
 */
class LyricsStore(
    context: Context,
    http: OkHttpClient = com.local.hive.mobile.data.defaultHttp(),
    private val fallback: suspend (artist: String, title: String) -> Lyrics? = { _, _ -> null },
    private val lrclib: Lrclib = Lrclib(http),
) {
    private val cacheDir = File(context.cacheDir, "lyrics").apply { mkdirs() }
    /** Lyrics typed or fixed on the phone: they come before any found online. */
    private val ownDir = File(context.filesDir, "lyrics-own").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }

    /** Keeps the user's own lyrics for a song (blank removes them); LRC stamps make them synced. */
    suspend fun saveOwn(artist: String, title: String, text: String) = withContext(Dispatchers.IO) {
        val file = File(ownDir, hash("$artist\u0000$title") + ".json")
        File(cacheDir, hash("$artist\u0000$title") + ".json").delete()
        if (text.isBlank()) { file.delete(); return@withContext }
        val synced = parseLrc(text).isNotEmpty()
        file.writeText(json.encodeToString(Lyrics.serializer(), Lyrics(text.trim(), synced, "you")))
    }

    suspend fun find(artist: String, title: String, album: String, durationMs: Long): Lyrics? = withContext(Dispatchers.IO) {
        if (artist.isBlank() || title.isBlank()) return@withContext null
        File(ownDir, hash("$artist\u0000$title") + ".json").takeIf { it.exists() }?.let { own -> runCatching { json.decodeFromString<Lyrics>(own.readText()) }.getOrNull()?.let { return@withContext it } }
        val file = File(cacheDir, hash("$artist\u0000$title") + ".json")
        if (file.exists()) runCatching { json.decodeFromString<Lyrics>(file.readText()) }.getOrNull()?.let { return@withContext it }
        val exact = lrclib.exact(artist, title, album, durationMs) ?: lyricsSearchTitle(title).takeIf { it != title }?.let { lrclib.exact(artist, it, album, durationMs) }
        // The exact lookup misses when the album name or length differ a little (deluxe editions, re-rips).
        val best = if (exact?.synced == true) exact else lrclib.search(artist, lyricsSearchTitle(title), durationMs) ?: exact
        // The full edition can try a fallback (e.g. Genius) when LRCLIB has nothing synced; Clean has none.
        val found = if (best?.synced == true) best else fallback(artist, title) ?: best
        found?.let { runCatching { file.writeText(json.encodeToString(Lyrics.serializer(), it)) } }
        found
    }

    companion object {
        private fun hash(s: String) = MessageDigest.getInstance("SHA-1").digest(s.lowercase().toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
