package com.local.hive.mobile.ui

import java.text.Collator
import java.util.Locale

/** Library ordering: "!" , "\"Excuse Me\"" and "The Avalanches" file under E and A, not at the top. */
object LibrarySort {
    val collator: Collator = Collator.getInstance(Locale.getDefault()).apply { strength = Collator.PRIMARY }

    private val leading = Regex("""^[\p{P}\p{S}\s]+""")
    private val article = Regex("""^(the|a|an)\s+""", RegexOption.IGNORE_CASE)

    /**
     * [items] in library order by [text], then [then]. Each item's key is
     * worked out once and compared as a precomputed collation key; sorting
     * 30,000 songs by comparing key(text) pairs ran two regexes per
     * comparison (~450,000 times) and froze the app. Uses its own Collator, so
     * it is safe off the main thread, where it belongs.
     */
    fun <T> sorted(items: List<T>, then: Comparator<T>? = null, text: (T) -> String): List<T> {
        val c = collator.clone() as Collator
        val keys = Array(items.size) { c.getCollationKey(key(text(items[it]))) }
        val order = items.indices.sortedWith { a, b ->
            val r = keys[a].compareTo(keys[b])
            if (r != 0 || then == null) r else then.compare(items[a], items[b])
        }
        return order.map { items[it] }
    }

    fun key(value: String): String {
        val trimmed = value.replace(leading, "")
        val withoutArticle = trimmed.replace(article, "")
        // Titles that are only symbols ("!") keep their text so they still sort somewhere sensible.
        return withoutArticle.ifBlank { trimmed.ifBlank { value } }
    }

    /** Text as search compares it: no case, accents or ligatures, so "aenima" finds "Ænima" and "bjork" finds "Björk". */
    fun fold(value: String): String = java.text.Normalizer.normalize(
        value.lowercase().replace("æ", "ae").replace("œ", "oe").replace("ø", "o").replace("ß", "ss").replace("ł", "l").replace("đ", "d"),
        java.text.Normalizer.Form.NFKD,
    ).replace(marks, "")

    private val marks = Regex("\\p{M}+")
}
