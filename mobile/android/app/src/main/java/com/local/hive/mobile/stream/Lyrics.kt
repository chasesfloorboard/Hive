package com.local.hive.mobile.stream

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

/**
 * Hive's lyrics search, as on the PC: synced lyrics from LRCLIB first (by
 * the tagged title, then without credit brackets), else plain lyrics from
 * Genius, accepted only when both artist and title match. Found lyrics are
 * cached on the phone.
 */
class LyricsProvider(context: Context, private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val cacheDir = File(context.cacheDir, "lyrics").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun find(artist: String, title: String, album: String, durationMs: Long): Lyrics? = withContext(Dispatchers.IO) {
        if (artist.isBlank() || title.isBlank()) return@withContext null
        val file = File(cacheDir, hash("$artist\u0000$title") + ".json")
        if (file.exists()) runCatching { json.decodeFromString<Lyrics>(file.readText()) }.getOrNull()?.let { return@withContext it }
        val exact = lrclib(artist, title, album, durationMs) ?: searchTitle(title).takeIf { it != title }?.let { lrclib(artist, it, album, durationMs) }
        // The exact lookup misses when the album name or length differ a little (deluxe editions, re-rips).
        val lrclib = if (exact?.synced == true) exact else lrclibSearch(artist, searchTitle(title), durationMs) ?: exact
        val found = if (lrclib?.synced == true) lrclib else genius(artist, title) ?: lrclib
        found?.let { runCatching { file.writeText(json.encodeToString(Lyrics.serializer(), it)) } }
        found
    }

    private fun lrclib(artist: String, title: String, album: String, durationMs: Long): Lyrics? = runCatching {
        val url = "https://lrclib.net/api/get".toHttpUrl().newBuilder()
            .addQueryParameter("track_name", title).addQueryParameter("artist_name", artist)
            .apply { if (album.isNotBlank()) addQueryParameter("album_name", album) }
            .apply { if (durationMs > 0) addQueryParameter("duration", (durationMs / 1000).toString()) }
            .build()
        val o = get(url.toString(), "Hive Mobile (https://github.com/)")?.let { Json.parseToJsonElement(it) as? JsonObject } ?: return null
        o.str("syncedLyrics")?.clean()?.ifBlank { null }?.let { return Lyrics(it, true, "LRCLIB") }
        o.str("plainLyrics")?.clean()?.ifBlank { null }?.let { Lyrics(it, false, "LRCLIB") }
    }.getOrNull()

    private fun lrclibSearch(artist: String, title: String, durationMs: Long): Lyrics? = runCatching {
        val url = "https://lrclib.net/api/search".toHttpUrl().newBuilder().addQueryParameter("track_name", title).addQueryParameter("artist_name", artist).build()
        val results = (get(url.toString(), "Hive Mobile (https://github.com/)")?.let { Json.parseToJsonElement(it) } as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val wantedTitle = normalize(title)
        val wantedArtist = normalize(artist)
        val fits = results.filter { r ->
            val seconds = r.str("duration")?.toDoubleOrNull() ?: 0.0
            normalize(searchTitle(r.str("trackName").orEmpty())) == wantedTitle &&
                normalize(r.str("artistName").orEmpty()).let { it.contains(wantedArtist) || wantedArtist.contains(it) } &&
                (durationMs <= 0 || seconds <= 0 || kotlin.math.abs(seconds * 1000 - durationMs) <= 4_000)
        }
        val synced = fits.firstNotNullOfOrNull { r -> r.str("syncedLyrics")?.clean()?.ifBlank { null } }
        synced?.let { Lyrics(it, true, "LRCLIB") } ?: fits.firstNotNullOfOrNull { r -> r.str("plainLyrics")?.clean()?.ifBlank { null } }?.let { Lyrics(it, false, "LRCLIB") }
    }.getOrNull()

    private fun genius(artist: String, rawTitle: String): Lyrics? = runCatching {
        val title = searchTitle(rawTitle)
        val wantedArtist = normalize(artist)
        val wantedTitle = normalize(title)
        val api = get("https://genius.com/api/search/multi?per_page=5&q=" + java.net.URLEncoder.encode("$artist $title", "UTF-8"), BROWSER) ?: return null
        val sections = ((Json.parseToJsonElement(api) as? JsonObject)?.get("response") as? JsonObject)?.get("sections") as? JsonArray
        data class Hit(val url: String, val score: Int)
        val hits = sections.orEmpty().flatMap { s -> ((s as? JsonObject)?.get("hits") as? JsonArray).orEmpty() }
            .mapNotNull { h -> (h as? JsonObject)?.get("result") as? JsonObject }
            .mapNotNull { r ->
                val url = r.str("url")?.takeIf { Regex("""^https?://genius\.com/\S+-lyrics$""").matches(it) } ?: return@mapNotNull null
                val hay = normalize("${r.str("title").orEmpty()} ${(r["primary_artist"] as? JsonObject)?.str("name").orEmpty()} $url")
                Hit(url, (if (wantedTitle.isNotEmpty() && wantedTitle in hay) 4 else 0) + (if (wantedArtist.isNotEmpty() && wantedArtist in hay) 4 else 0))
            }
            .distinctBy { it.url }
        // Both artist and title must match: a broad search must never show another song's words.
        for (hit in hits.filter { it.score >= 8 }.sortedByDescending { it.score }.take(4)) {
            val html = get(hit.url, BROWSER) ?: continue
            val words = geniusLyrics(html)
            if (words.isNotBlank()) return Lyrics(words, false, "Genius")
        }
        null
    }.getOrNull()

    private fun get(url: String, agent: String): String? {
        val request = Request.Builder().url(url).header("User-Agent", agent).header("Accept-Language", "en-US,en;q=0.9").build()
        return http.newCall(request).execute().use { if (it.isSuccessful) it.body.string() else null }
    }

    companion object {
        private const val BROWSER = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
        private val creditBracket = Regex("""^\s*(?:feat\.?|ft\.?|featuring|prod\.?|produced|co-prod\.?|with)\b|remaster|explicit|clean version|album version|single version|radio edit|bonus track""", RegexOption.IGNORE_CASE)
        private val brackets = Regex("""\s*[(\[]([^()\[\]]*)[)\]]""")
        private val remasterTail = Regex("""\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$""", RegexOption.IGNORE_CASE)
        private val container = Regex("""<div\b[^>]*\bdata-lyrics-container=["']true["'][^>]*>""", RegexOption.IGNORE_CASE)
        private val excluded = Regex("""<div\b[^>]*\bdata-exclude-from-selection=["']true["'][^>]*>""", RegexOption.IGNORE_CASE)
        private val divTag = Regex("""<div\b[^>]*>|</div>""", RegexOption.IGNORE_CASE)

        /** The title without credit brackets ("(Prod. By …)", "(Feat. …)"), which lyrics sites leave out. */
        fun searchTitle(title: String): String {
            val original = title.trim()
            return original.replace(brackets) { m -> if (creditBracket.containsMatchIn(m.groupValues[1])) "" else m.value }
                .replace(remasterTail, "").replace(Regex("""\s{2,}"""), " ").trim().ifBlank { original }
        }

        private fun normalize(value: String) = Normalizer.normalize(value.lowercase(), Normalizer.Form.NFKD)
            .replace(Regex("""\p{M}+"""), "").replace(Regex("""[^a-z0-9]+"""), " ").trim()

        private fun String.clean() = removePrefix("﻿").trim()

        /** The content of the <div> opened just before [start], with nested divs balanced. */
        private fun balancedDiv(html: String, start: Int): Pair<String, Int> {
            var depth = 1
            for (m in divTag.findAll(html, start)) {
                depth += if (m.value.startsWith("</")) -1 else 1
                if (depth == 0) return html.substring(start, m.range.first) to m.range.last + 1
            }
            return html.substring(start) to html.length
        }

        fun geniusLyrics(html: String): String {
            val blocks = mutableListOf<String>()
            var from = 0
            while (true) {
                val open = container.find(html, from) ?: break
                val (content, end) = balancedDiv(html, open.range.last + 1)
                stripHtml(dropExcluded(content)).takeIf { it.isNotBlank() }?.let(blocks::add)
                from = end
            }
            return blocks.joinToString("\n\n").trim()
        }

        private fun dropExcluded(html: String): String {
            val out = StringBuilder()
            var cursor = 0
            while (true) {
                val m = excluded.find(html, cursor) ?: break
                out.append(html, cursor, m.range.first)
                cursor = balancedDiv(html, m.range.last + 1).second
            }
            return out.append(html.substring(cursor)).toString()
        }

        private fun stripHtml(html: String): String = decode(
            html.replace(Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE), "\n")
                .replace(Regex("""</(?:div|p|li|h[1-6])>""", RegexOption.IGNORE_CASE), "\n")
                .replace(Regex("""<script[\s\S]*?</script>""", RegexOption.IGNORE_CASE), "")
                .replace(Regex("""<style[\s\S]*?</style>""", RegexOption.IGNORE_CASE), "")
                .replace(Regex("<[^>]+>"), ""),
        ).replace(' ', ' ').replace("\r", "").replace(Regex("""\n[ \t]+"""), "\n").replace(Regex("""[ \t]+\n"""), "\n").replace(Regex("""\n{3,}"""), "\n\n").trim()

        private fun decode(s: String) = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
            .replace("&lt;", "<").replace("&gt;", ">")
            .replace(Regex("""&#(\d+);""")) { m -> m.groupValues[1].toIntOrNull()?.let { String(Character.toChars(it)) }.orEmpty() }
            .replace(Regex("""&#x([0-9a-fA-F]+);""")) { m -> m.groupValues[1].toIntOrNull(16)?.let { String(Character.toChars(it)) }.orEmpty() }

        private fun hash(s: String) = MessageDigest.getInstance("SHA-1").digest(s.lowercase().toByteArray()).joinToString("") { "%02x".format(it) }
        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}
