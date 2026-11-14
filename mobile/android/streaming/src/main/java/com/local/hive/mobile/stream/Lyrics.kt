package com.local.hive.mobile.stream

import com.local.hive.mobile.discovery.Lyrics
import com.local.hive.mobile.discovery.lyricsNormalize
import com.local.hive.mobile.discovery.lyricsSearchTitle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Genius lyrics — the Mobile-only FALLBACK, used only when LRCLIB (the compliant default, in :core's
 * [LyricsStore]) has nothing synced. Genius has no sanctioned lyrics API, so this scrapes the public page;
 * it therefore lives in :streaming and is absent from the Google Play edition (Hive Clean), which stays
 * LRCLIB-only. Wired as `LyricsStore(context, fallback = { a, t -> GeniusLyrics().find(a, t) })` in Hive Mobile.
 */
class GeniusLyrics(private val http: OkHttpClient = com.local.hive.mobile.data.defaultHttp()) {

    suspend fun find(artist: String, rawTitle: String): Lyrics? = withContext(Dispatchers.IO) {
        runCatching {
            val title = lyricsSearchTitle(rawTitle)
            val wantedArtist = lyricsNormalize(artist)
            val wantedTitle = lyricsNormalize(title)
            val api = get("https://genius.com/api/search/multi?per_page=5&q=" + java.net.URLEncoder.encode("$artist $title", "UTF-8"), BROWSER) ?: return@runCatching null
            val sections = ((Json.parseToJsonElement(api) as? JsonObject)?.get("response") as? JsonObject)?.get("sections") as? JsonArray
            data class Hit(val url: String, val score: Int)
            val hits = sections.orEmpty().flatMap { s -> ((s as? JsonObject)?.get("hits") as? JsonArray).orEmpty() }
                .mapNotNull { h -> (h as? JsonObject)?.get("result") as? JsonObject }
                .mapNotNull { r ->
                    val url = r.str("url")?.takeIf { Regex("""^https?://genius\.com/\S+-lyrics$""").matches(it) } ?: return@mapNotNull null
                    val hay = lyricsNormalize("${r.str("title").orEmpty()} ${(r["primary_artist"] as? JsonObject)?.str("name").orEmpty()} $url")
                    Hit(url, (if (wantedTitle.isNotEmpty() && wantedTitle in hay) 4 else 0) + (if (wantedArtist.isNotEmpty() && wantedArtist in hay) 4 else 0))
                }
                .distinctBy { it.url }
            // Both artist and title must match: a broad search must never show another song's words.
            for (hit in hits.filter { it.score >= 8 }.sortedByDescending { it.score }.take(4)) {
                val html = get(hit.url, BROWSER) ?: continue
                val words = geniusLyrics(html)
                if (words.isNotBlank()) return@runCatching Lyrics(words, false, "Genius")
            }
            null
        }.getOrNull()
    }

    private fun get(url: String, agent: String): String? {
        val request = Request.Builder().url(url).header("User-Agent", agent).header("Accept-Language", "en-US,en;q=0.9").build()
        return http.newCall(request).execute().use { if (it.isSuccessful) it.body.string() else null }
    }

    companion object {
        private const val BROWSER = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
        private val container = Regex("""<div\b[^>]*\bdata-lyrics-container=["']true["'][^>]*>""", RegexOption.IGNORE_CASE)
        private val excluded = Regex("""<div\b[^>]*\bdata-exclude-from-selection=["']true["'][^>]*>""", RegexOption.IGNORE_CASE)
        private val divTag = Regex("""<div\b[^>]*>|</div>""", RegexOption.IGNORE_CASE)

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
        ).replace(' ', ' ').replace("\r", "").replace(Regex("""\n[ \t]+"""), "\n").replace(Regex("""[ \t]+\n"""), "\n").replace(Regex("""\n{3,}"""), "\n\n").trim()

        private fun decode(s: String) = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
            .replace("&lt;", "<").replace("&gt;", ">")
            .replace(Regex("""&#(\d+);""")) { m -> m.groupValues[1].toIntOrNull()?.let { String(Character.toChars(it)) }.orEmpty() }
            .replace(Regex("""&#x([0-9a-fA-F]+);""")) { m -> m.groupValues[1].toIntOrNull(16)?.let { String(Character.toChars(it)) }.orEmpty() }

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}
