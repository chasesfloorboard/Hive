package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Pure recent-search history rules (shared semantics with desktop's `app/renderer/search-history.js`).
 */
object SearchHistoryRules {
    const val DEFAULT_MAX = 20
    const val MIN_LENGTH = 2

    fun normalize(raw: String): String = raw.trim().replace(Regex("\\s+"), " ")

    /** Adds [rawQuery] to the top of [existing], deduplicating case-insensitively and capping at [max]. */
    fun record(existing: List<String>, rawQuery: String, max: Int = DEFAULT_MAX): List<String> {
        val clean = normalize(rawQuery)
        if (clean.length < MIN_LENGTH) return existing
        val key = clean.lowercase()
        val deduped = existing.filterNot { normalize(it).lowercase() == key }
        return (listOf(clean) + deduped).take(max.coerceAtLeast(1))
    }

    /** Removes a single query from [existing] case-insensitively. */
    fun remove(existing: List<String>, query: String): List<String> {
        val key = normalize(query).lowercase()
        if (key.isEmpty()) return existing
        val next = existing.filterNot { normalize(it).lowercase() == key }
        return if (next.size == existing.size) existing else next
    }

    /**
     * Returns suggestions for [input]:
     * - Blank input: up to [limit] most recent searches.
     * - Non-blank input: matching past searches (prefix matches first, then substring matches),
     *   omitting an exact identical match to what's already typed.
     */
    fun suggest(existing: List<String>, input: String, limit: Int = 8): List<String> {
        val q = normalize(input).lowercase()
        if (q.isEmpty()) return existing.take(limit)
        val prefix = ArrayList<String>()
        val contains = ArrayList<String>()
        for (item in existing) {
            val lower = item.lowercase()
            if (lower == q) continue
            when {
                lower.startsWith(q) -> prefix += item
                q in lower -> contains += item
            }
        }
        return (prefix + contains).take(limit)
    }
}

/**
 * SharedPreferences-backed recent search history store (`shared_prefs/search-history.xml`,
 * automatically included in Hive Mobile backups).
 */
class SearchHistoryStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val _history = MutableStateFlow(read())
    val history: StateFlow<List<String>> = _history.asStateFlow()

    private fun read(): List<String> =
        prefs.getString(KEY, "").orEmpty().split('\n').map { it.trim() }.filter { it.isNotEmpty() }

    private fun save(list: List<String>) {
        _history.value = list
        prefs.edit().putString(KEY, list.joinToString("\n")).apply()
    }

    fun record(query: String) {
        val next = SearchHistoryRules.record(_history.value, query)
        if (next != _history.value) save(next)
    }

    fun remove(query: String) {
        val next = SearchHistoryRules.remove(_history.value, query)
        if (next !== _history.value) save(next)
    }

    fun clear() {
        if (_history.value.isNotEmpty()) save(emptyList())
    }

    companion object {
        private const val PREFS = "search-history"
        private const val KEY = "queries"
    }
}
