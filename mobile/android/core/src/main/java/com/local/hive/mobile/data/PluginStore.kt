package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Local persistence for installed Hive Mobile plugins and their per-plugin settings.
 * Seeds the bundled Monstercat Visualizer plugin (enabled by default) from core assets so
 * the Visualizer tab works out of the box and can be configured or toggled like any plugin.
 */
class PluginStore(private val context: Context) {
    @Serializable
    data class InstalledPlugin(
        val plugin: PluginGallery.StorePlugin,
        val enabled: Boolean = true,
        val settings: Map<String, String> = emptyMap(),
    )

    @Serializable
    private data class SavedState(
        val seededBuiltin: Boolean = false,
        val items: List<InstalledPlugin> = emptyList(),
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val file = File(context.filesDir, "hive-plugins.json")
    private val _installed = MutableStateFlow<List<InstalledPlugin>>(emptyList())
    val installed: StateFlow<List<InstalledPlugin>> = _installed.asStateFlow()

    init {
        loadOrSeed()
    }

    private fun loadOrSeed() {
        val loaded = runCatching { json.decodeFromString(SavedState.serializer(), file.readText()) }.getOrNull()
        val bundled = runCatching {
            ThemeGallery.loadBlocked(context)
            PluginGallery.parse(context.assets.open("plugin-store.json").bufferedReader().readText(), verified = true)
        }.getOrDefault(emptyList())

        if (loaded == null || !loaded.seededBuiltin) {
            val existing = loaded?.items.orEmpty().associateBy { it.plugin.id }.toMutableMap()
            for (p in bundled.filter { it.builtin }) {
                if (p.id !in existing) {
                    existing[p.id] = InstalledPlugin(plugin = p, enabled = true, settings = defaultSettings(p))
                }
            }
            val next = existing.values.toList()
            _installed.value = next
            persist(SavedState(seededBuiltin = true, items = next))
        } else {
            // Keep bundled plugins updated to latest bundled version while preserving user enabled & settings.
            val bundledById = bundled.associateBy { it.id }
            var changed = false
            val updated = loaded.items.map { item ->
                val fresh = bundledById[item.plugin.id]
                if (fresh != null && fresh.builtin && fresh.version != item.plugin.version) {
                    changed = true
                    item.copy(plugin = fresh)
                } else item
            }
            _installed.value = updated
            if (changed) persist(loaded.copy(items = updated))
        }
    }

    private fun defaultSettings(p: PluginGallery.StorePlugin): Map<String, String> = buildMap {
        for (s in p.settings) {
            when (s.type) {
                "boolean" -> put(s.id, (s.defaultBool ?: false).toString())
                "number" -> put(s.id, (s.defaultNum ?: 0.0).toString())
                else -> put(s.id, s.defaultStr.orEmpty())
            }
        }
    }

    private fun persist(state: SavedState) {
        runCatching { file.writeTextAtomic(json.encodeToString(SavedState.serializer(), state)) }
    }

    private fun commit(next: List<InstalledPlugin>) {
        _installed.value = next
        persist(SavedState(seededBuiltin = true, items = next))
    }

    fun isEnabled(id: String): Boolean = _installed.value.any { it.plugin.id == id && it.enabled }

    fun find(id: String): InstalledPlugin? = _installed.value.firstOrNull { it.plugin.id == id }

    fun install(plugin: PluginGallery.StorePlugin) {
        val current = _installed.value.toMutableList()
        val idx = current.indexOfFirst { it.plugin.id == plugin.id }
        if (idx >= 0) {
            val prev = current[idx]
            current[idx] = prev.copy(plugin = plugin, enabled = true, settings = defaultSettings(plugin) + prev.settings)
        } else {
            current += InstalledPlugin(plugin = plugin, enabled = true, settings = defaultSettings(plugin))
        }
        commit(current)
    }

    fun setEnabled(id: String, enabled: Boolean) {
        val next = _installed.value.map { if (it.plugin.id == id) it.copy(enabled = enabled) else it }
        commit(next)
    }

    fun remove(id: String) {
        val next = _installed.value.filterNot { it.plugin.id == id }
        commit(next)
    }

    fun updateSettings(id: String, patch: Map<String, String>) {
        val next = _installed.value.map { item ->
            if (item.plugin.id == id) item.copy(settings = item.settings + patch) else item
        }
        commit(next)
    }

    fun boolSetting(id: String, key: String, fallback: Boolean): Boolean =
        find(id)?.settings?.get(key)?.toBooleanStrictOrNull() ?: fallback

    fun floatSetting(id: String, key: String, fallback: Float): Float =
        find(id)?.settings?.get(key)?.toFloatOrNull() ?: fallback

    fun intSetting(id: String, key: String, fallback: Int): Int =
        find(id)?.settings?.get(key)?.toDoubleOrNull()?.toInt() ?: fallback
}
