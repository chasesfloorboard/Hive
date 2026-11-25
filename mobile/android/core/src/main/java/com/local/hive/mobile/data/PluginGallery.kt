package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Hive's cross-platform Plugin Store (mirrors app/main/plugin-store.js and ThemeGallery.kt):
 *  - Verified store (`plugins/store.json`): audited by maintainers before live publication.
 *  - Community / Untested section (`plugins/community.json`): user-uploaded untested plugins,
 *    clearly warned and still running inside Hive's zero-network sandbox.
 */
object PluginGallery {
    const val VERIFIED_URL = "https://raw.githubusercontent.com/chasesfloorboard/Hive/main/plugins/store.json"
    const val COMMUNITY_URL = "https://raw.githubusercontent.com/chasesfloorboard/Hive/main/plugins/community.json"
    const val SHARE_URL = "https://github.com/chasesfloorboard/Hive/issues/new"
    const val MONSTERCAT_ID = "hive.monstercat-visualizer"

    private const val MAX_STORE_BYTES = 4 * 1024 * 1024
    private const val MAX_JS_BYTES = 256 * 1024
    private const val MAX_CSS_BYTES = 128 * 1024
    private const val MAX_URL_CHARS = 7200

    val ALLOWED_PERMISSIONS = setOf(
        "player.read",
        "player.control",
        "queue.read",
        "library.read",
        "spectrum.read",
        "media.artwork",
        "ui.view",
        "settings",
    )
    private val ALLOWED_PLATFORMS = setOf("desktop", "mobile")
    private val ID_PATTERN = Regex("^[a-z0-9][a-z0-9._-]{1,63}$")
    private val VER_PATTERN = Regex("^\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]{1,24})?$", RegexOption.IGNORE_CASE)
    private val SETTING_ID_PATTERN = Regex("^[a-zA-Z0-9_-]{1,40}$")

    @Serializable
    data class SettingOption(val value: String, val label: String)

    @Serializable
    data class SettingDef(
        val id: String,
        val type: String,
        val label: String,
        val description: String = "",
        val defaultBool: Boolean? = null,
        val defaultNum: Double? = null,
        val defaultStr: String? = null,
        val min: Double? = null,
        val max: Double? = null,
        val step: Double? = null,
        val options: List<SettingOption> = emptyList(),
    )

    @Serializable
    data class StorePlugin(
        val id: String,
        val name: String,
        val version: String,
        val author: String,
        val description: String,
        val icon: String,
        val apiVersion: Int = 2,
        val verified: Boolean = false,
        val builtin: Boolean = false,
        val platforms: List<String> = listOf("desktop", "mobile"),
        val permissions: List<String> = emptyList(),
        val settings: List<SettingDef> = emptyList(),
        val js: String = "",
        val css: String = "",
    )

    data class CatalogResult(
        val verified: List<StorePlugin>,
        val community: List<StorePlugin>,
        val online: Boolean,
    )

    fun permissionLabel(perm: String): String = when (perm) {
        "player.read" -> "Read playing song"
        "player.control" -> "Control playback"
        "queue.read" -> "Read queue"
        "library.read" -> "Read library list"
        "spectrum.read" -> "Audio spectrum"
        "media.artwork" -> "Artist artwork"
        "ui.view" -> "App view / tab"
        "settings" -> "Plugin settings"
        else -> perm
    }

    private fun text(v: String?, max: Int) =
        v.orEmpty().replace(Regex("[\\u0000-\\u001f\\u007f<>]"), "").trim().take(max)

    private fun cleanId(raw: String?): String {
        val s = raw.orEmpty().trim().lowercase().replace(Regex("[^a-z0-9._-]+"), "-").trim('.')
        if (s.length < 2 || s.length > 64 || ".." in s || !ID_PATTERN.matches(s)) return ""
        return s
    }

    private fun cleanIcon(raw: String?): String {
        val s = raw.orEmpty().replace(Regex("[\\u0000-\\u001f\\u007f<>]"), "").trim()
        if (s.isEmpty() || s.contains("svg", ignoreCase = true)) return "◈"
        return s.take(2)
    }

    private fun cleanSetting(o: JsonObject?): SettingDef? {
        if (o == null) return null
        fun s(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        val id = s("id").orEmpty().trim()
        if (!SETTING_ID_PATTERN.matches(id)) return null
        val type = s("type").orEmpty().trim().lowercase()
        if (type !in setOf("boolean", "number", "string", "select")) return null
        val label = text(s("label").takeUnless { it.isNullOrBlank() } ?: id, 60)
        val desc = text(s("description"), 160)
        val defPrim = o["default"] as? JsonPrimitive
        return when (type) {
            "boolean" -> SettingDef(id, type, label, desc, defaultBool = defPrim?.booleanOrNull ?: false)
            "number" -> {
                val min = (o["min"] as? JsonPrimitive)?.doubleOrNull
                val max = (o["max"] as? JsonPrimitive)?.doubleOrNull
                val step = (o["step"] as? JsonPrimitive)?.doubleOrNull?.takeIf { it > 0 }
                val def = defPrim?.doubleOrNull ?: min ?: 0.0
                SettingDef(id, type, label, desc, defaultNum = def, min = min, max = max, step = step)
            }
            "string" -> SettingDef(id, type, label, desc, defaultStr = text(defPrim?.contentOrNull, 120))
            "select" -> {
                val opts = (o["options"] as? JsonArray).orEmpty().take(20).mapNotNull { item ->
                    when (item) {
                        is JsonPrimitive -> text(item.contentOrNull, 40).takeIf { it.isNotEmpty() }?.let { SettingOption(it, it) }
                        is JsonObject -> {
                            val v = text((item["value"] as? JsonPrimitive)?.contentOrNull, 40)
                            val l = text((item["label"] as? JsonPrimitive)?.contentOrNull ?: v, 60)
                            if (v.isNotEmpty()) SettingOption(v, l) else null
                        }
                        else -> null
                    }
                }
                if (opts.isEmpty()) return null
                val def = defPrim?.contentOrNull?.takeIf { d -> opts.any { it.value == d } } ?: opts.first().value
                SettingDef(id, type, label, desc, defaultStr = def, options = opts)
            }
            else -> null
        }
    }

    /** Validates one catalog plugin; [verified] is dictated by the catalog tier, never raw JSON. */
    fun clean(o: JsonObject?, verified: Boolean): StorePlugin? {
        if (o == null) return null
        fun s(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        val id = cleanId(s("id"))
        val name = text(s("name"), 50)
        if (id.isEmpty() || name.isEmpty()) return null
        val author = text(s("author"), 64)
        val description = text(s("description"), 220)
        if (listOf(id, name, author, description).any(ThemeGallery::isOffensive)) return null

        val apiVersion = (o["apiVersion"] as? JsonPrimitive)?.intOrNull ?: 0
        if (apiVersion != 2) return null

        val version = s("version").orEmpty().trim().takeIf { VER_PATTERN.matches(it) } ?: "1.0.0"
        val permissions = (o["permissions"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim() }
            .filter { it in ALLOWED_PERMISSIONS }
            .distinct()
        val platforms = (o["platforms"] as? JsonArray).orEmpty()
            .mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.lowercase() }
            .filter { it in ALLOWED_PLATFORMS }
            .distinct()
            .ifEmpty { listOf("desktop") }
        val js = s("js").orEmpty()
        val css = s("css").orEmpty()
        val builtin = verified && ((o["builtin"] as? JsonPrimitive)?.booleanOrNull == true)
        if (!builtin && js.isBlank()) return null
        if (js.toByteArray(Charsets.UTF_8).size > MAX_JS_BYTES) return null
        if (css.toByteArray(Charsets.UTF_8).size > MAX_CSS_BYTES) return null

        val settings = (o["settings"] as? JsonArray).orEmpty().take(24).mapNotNull { cleanSetting(it as? JsonObject) }
        return StorePlugin(
            id = id,
            name = name,
            version = version,
            author = author,
            description = description,
            icon = cleanIcon(s("icon")),
            apiVersion = 2,
            verified = verified,
            builtin = builtin,
            platforms = platforms,
            permissions = permissions,
            settings = settings,
            js = js,
            css = css,
        )
    }

    fun parse(json: String, verified: Boolean): List<StorePlugin> {
        val list = (Json.parseToJsonElement(json) as? JsonObject)?.get("plugins") as? JsonArray ?: return emptyList()
        val seen = HashSet<String>()
        return list.take(200).mapNotNull { clean(it as? JsonObject, verified) }.filter { seen.add(it.id) }
    }

    /** Builds a pre-filled GitHub submission URL targeting either `"verified"` (maintainer review) or `"community"` (untested). */
    fun submitUrl(
        id: String,
        name: String,
        author: String,
        description: String,
        permissions: List<String>,
        js: String,
        css: String,
        target: String = "verified",
    ): Pair<String, String> {
        require(!listOf(id, name, author, description).any(ThemeGallery::isOffensive)) {
            "That plugin name or description can't go in the plugin store."
        }
        val safeId = cleanId(id).ifEmpty { cleanId(name).ifEmpty { "community.plugin" } }
        val safeName = text(name, 50).ifEmpty { "My Plugin" }
        val safeAuthor = text(author, 64)
        val safeDesc = text(description, 220)
        val safePerms = permissions.filter { it in ALLOWED_PERMISSIONS }.distinct()
        val j = Json { prettyPrint = true }
        fun q(s: String) = j.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(s))
        val payload = buildString {
            append("{\n")
            append("  \"id\": ${q(safeId)},\n")
            append("  \"name\": ${q(safeName)},\n")
            append("  \"version\": \"1.0.0\",\n")
            append("  \"author\": ${q(safeAuthor)},\n")
            append("  \"description\": ${q(safeDesc)},\n")
            append("  \"icon\": \"◈\",\n")
            append("  \"apiVersion\": 2,\n")
            append("  \"platforms\": [\"desktop\", \"mobile\"],\n")
            append("  \"permissions\": [${safePerms.joinToString(", ") { q(it) }}],\n")
            append("  \"css\": ${q(css)},\n")
            append("  \"js\": ${q(js)}\n")
            append("}")
        }
        val isCommunity = target == "community"
        val labels = if (isCommunity) "plugin-community" else "plugin"
        val title = if (isCommunity) "Plugin (Community/Untested): $safeName" else "Plugin (Review): $safeName"
        val intro = if (isCommunity) {
            "Submitting a plugin to the **Community / Untested (Unsafe)** section of the Hive Plugin Store."
        } else {
            "Submitting a plugin for **Verification** in the Hive Plugin Store (apply `approved` label after review)."
        }
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        val fullBody = "$intro\n\n```json\n$payload\n```"
        val fullUrl = "$SHARE_URL?labels=${enc(labels)}&title=${enc(title)}&body=${enc(fullBody)}"
        val finalUrl = if (fullUrl.length <= MAX_URL_CHARS) fullUrl else {
            val stub = "$intro\n\n<!-- Paste the copied plugin JSON bundle below -->\n\n```json\n\n```"
            "$SHARE_URL?labels=${enc(labels)}&title=${enc(title)}&body=${enc(stub)}"
        }
        return finalUrl to payload
    }

    /** Loads both Verified and Community catalogs from GitHub, falling back to bundled assets offline. */
    suspend fun load(context: Context, http: OkHttpClient): CatalogResult = withContext(Dispatchers.IO) {
        ThemeGallery.loadBlocked(context)
        fun fetch(url: String, verified: Boolean): List<StorePlugin>? = runCatching {
            http.newCall(Request.Builder().url(url).header("Cache-Control", "no-cache").build()).execute().use { res ->
                if (!res.isSuccessful) error("HTTP ${res.code}")
                val bytes = res.body.bytes()
                if (bytes.size > MAX_STORE_BYTES) error("Too large")
                parse(bytes.decodeToString(), verified)
            }
        }.getOrNull()

        fun asset(name: String, verified: Boolean): List<StorePlugin> = runCatching {
            parse(context.assets.open(name).bufferedReader().readText(), verified)
        }.getOrDefault(emptyList())

        val liveVerified = fetch(VERIFIED_URL, verified = true)
        val liveCommunity = fetch(COMMUNITY_URL, verified = false)
        val online = liveVerified != null || liveCommunity != null
        CatalogResult(
            verified = liveVerified ?: asset("plugin-store.json", verified = true),
            community = liveCommunity ?: asset("plugin-community.json", verified = false),
            online = online,
        )
    }
}
