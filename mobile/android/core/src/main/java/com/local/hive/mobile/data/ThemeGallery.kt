package com.local.hive.mobile.data

import android.content.Context
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
 * Hive's theme gallery ("Browse themes"), as on the PC (app/main/theme-store.js): themes people shared,
 * listed in themes/store.json in the public Hive repository. A gallery theme is only colours and sizes,
 * each checked against the same short list of variables and value shapes the PC uses.
 */
object ThemeGallery {
    const val STORE_URL = "https://raw.githubusercontent.com/chasesfloorboard/Hive/main/themes/store.json"
    const val SHARE_URL = "https://github.com/chasesfloorboard/Hive/issues/new"
    private const val MAX_BYTES = 1024 * 1024

    val VARS = listOf("--bg", "--panel", "--panel-strong", "--border", "--text", "--text-dim", "--text-dimmer",
        "--accent", "--accent-soft", "--accent-glow", "--ambient-a", "--ambient-b", "--radius", "--blur")
    private val REQUIRED = listOf("--bg", "--text", "--accent")
    private const val BYTE = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|\\d?\\d)"
    private const val ALPHA = "(?:0|1|0?\\.\\d{1,3}|1\\.0{1,3})"
    private val COLOUR = Regex("^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\\(\\s*$BYTE\\s*,\\s*$BYTE\\s*,\\s*$BYTE\\s*(?:,\\s*$ALPHA\\s*)?\\))$", RegexOption.IGNORE_CASE)
    private val LENGTH = Regex("^(?:\\d|[1-4]\\d)px$")

    // ---- a basic profanity and slur filter for names shared to the gallery (themes/blocked-words.json) ----
    // Only for the gallery: names on this phone, songs, artists and everything else are never filtered.
    @Volatile private var anywhere: List<String> = emptyList()
    @Volatile private var words: Set<String> = emptySet()

    /** Loads the word lists (from the app's assets; tests pass the JSON directly). */
    fun loadBlocked(json: String) {
        val o = Json.parseToJsonElement(json) as? JsonObject ?: return
        fun list(k: String) = (o[k] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.lowercase() }
        anywhere = list("anywhere"); words = list("words").toSet()
    }
    fun loadBlocked(context: Context) { if (anywhere.isEmpty()) runCatching { loadBlocked(context.assets.open("theme-blocked-words.json").bufferedReader().readText()) } }

    private val LOOKALIKE = mapOf('0' to 'o', '1' to 'i', '!' to 'i', '|' to 'i', '3' to 'e', '4' to 'a', '@' to 'a', '5' to 's', '$' to 's', '7' to 't', '+' to 't', '8' to 'b', '9' to 'g', '6' to 'g')
    private fun squeeze(s: String) = s.replace(Regex("(.)\\1+"), "$1")

    /** Whether a shared name has a slur or profanity in it, as the PC decides (theme-store.js isOffensive). */
    fun isOffensive(value: String?): Boolean {
        val raw = java.text.Normalizer.normalize(value.orEmpty().lowercase(), java.text.Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
        val undone = raw.map { LOOKALIKE[it] ?: it }.joinToString("")
        val joined = undone.replace(Regex("[^a-z]"), "")
        val squeezed = squeeze(joined)
        if (anywhere.any { w -> val sq = squeeze(w); joined.contains(w) || (sq.length >= 4 && squeezed.contains(sq)) }) return true
        val tokens = (raw.split(Regex("[^a-z0-9]+")) + undone.split(Regex("[^a-z0-9]+"))).filter { it.isNotEmpty() }.toSet()
        return words.any { it in tokens }
    }

    data class Theme(val id: String, val name: String, val author: String, val description: String, val vars: Map<String, String>) {
        val css: String get() = ":root {\n" + VARS.filter { vars[it] != null }.joinToString("") { "  $it: ${vars[it]};\n" } + "}\n"
    }

    fun safeValue(name: String, value: String?): String? {
        val v = value?.trim() ?: return null
        return if (name == "--radius" || name == "--blur") v.takeIf { LENGTH.matches(it) } else v.takeIf { COLOUR.matches(it) }
    }

    private fun text(v: String?, max: Int) = v.orEmpty().replace(Regex("[\\u0000-\\u001f\\u007f<>]"), "").trim().take(max)

    fun clean(o: JsonObject?): Theme? {
        if (o == null) return null
        fun s(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        val raw = o["vars"] as? JsonObject ?: return null
        val vars = LinkedHashMap<String, String>()
        for (n in VARS) safeValue(n, (raw[n] as? JsonPrimitive)?.contentOrNull)?.let { vars[n] = it }
        if (!REQUIRED.all { vars[it] != null }) return null
        val name = text(s("name"), 40)
        val id = text(s("id"), 48).lowercase().replace(Regex("[^a-z0-9-]+"), "-").trim('-')
        if (name.isEmpty() || id.isEmpty()) return null
        val author = text(s("author"), 40); val description = text(s("description"), 140)
        if (listOf(name, id, author, description).any(::isOffensive)) return null
        return Theme(id, name, author, description, vars)
    }

    fun parse(json: String): List<Theme> {
        val list = (Json.parseToJsonElement(json) as? JsonObject)?.get("themes") as? JsonArray ?: return emptyList()
        val seen = HashSet<String>()
        return list.take(500).mapNotNull { clean(it as? JsonObject) }.filter { seen.add(it.id) }
    }

    /** The variables of a theme's CSS (to share it), or null without the ones every theme needs. */
    fun varsFromCss(css: String): Map<String, String>? {
        val vars = LinkedHashMap<String, String>()
        for (m in Regex("(--[a-z-]+)\\s*:\\s*([^;}{]+)", RegexOption.IGNORE_CASE).findAll(css)) {
            val n = m.groupValues[1].lowercase()
            if (n !in VARS || n in vars) continue
            safeValue(n, m.groupValues[2])?.let { vars[n] = it }
        }
        return vars.takeIf { REQUIRED.all { k -> it[k] != null } }
    }

    /** The link to a pre-filled GitHub issue sharing a theme, as the PC makes it. */
    fun shareUrl(name: String, vars: Map<String, String>): String {
        require(!isOffensive(name)) { "That name can't go in the theme gallery. Pick another one (you can still call it anything on your phone)." }
        val id = name.lowercase().replace(Regex("[^a-z0-9-]+"), "-").trim('-').ifEmpty { "theme" }.take(48)
        val obj = buildString {
            append("{\n  \"id\": \"$id\",\n  \"name\": ${Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(text(name, 40)))},\n  \"vars\": {\n")
            append(vars.entries.joinToString(",\n") { "    \"${it.key}\": \"${it.value}\"" })
            append("\n  }\n}")
        }
        val body = "A theme for the Hive theme gallery.\n\n```json\n$obj\n```"
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        return "$SHARE_URL?labels=theme&title=${enc("Theme: ${text(name, 40)}")}&body=${enc(body)}"
    }

    /** The gallery: from GitHub, or (offline) as it came with this version of Hive. Second: whether it's live. */
    suspend fun load(context: Context, http: OkHttpClient): Pair<List<Theme>, Boolean> = withContext(Dispatchers.IO) {
        loadBlocked(context)
        val live = runCatching {
            http.newCall(Request.Builder().url(STORE_URL).header("Cache-Control", "no-cache").build()).execute().use { res ->
                if (!res.isSuccessful) error("The gallery answered ${res.code}")
                val bytes = res.body.bytes()
                if (bytes.size > MAX_BYTES) error("Too big")
                parse(bytes.decodeToString())
            }
        }.getOrNull()
        if (!live.isNullOrEmpty()) return@withContext live to true
        (runCatching { parse(context.assets.open("theme-gallery.json").bufferedReader().readText()) }.getOrDefault(emptyList())) to false
    }
}
