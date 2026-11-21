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

    private val marks = Regex("\\p{M}+")
    private val notWord = Regex("[^\\p{L}\\p{N}]+")
    private val acronymDots = Regex("""(?<=\p{L})\.(?=\p{L}|\.|\s|$)""")
    private val currencyS = Regex("""(?<=\p{L})\$(?=\p{L}|\$)|\$(?=\p{L})|(?<=\p{L})\$(?=\s|$)""")

    /** Text as search compares it: no case, accents, ligatures, acronym dots or stylized symbols. */
    fun fold(value: String): String {
        val noAcronymDots = value.replace(acronymDots, "").replace(currencyS, "s")
        val decomposed = java.text.Normalizer.normalize(
            noAcronymDots.lowercase()
                .replace("æ", "ae").replace("œ", "oe").replace("ø", "o")
                .replace("ß", "ss").replace("ł", "l").replace("đ", "d"),
            java.text.Normalizer.Form.NFKD,
        )
        return decomposed.replace(marks, "")
    }

    /**
     * A search's words, folded as [fold] does and without punctuation: a song matches when each
     * word is somewhere in its title, artist or album, in any order ("nanana edit" finds
     * "(It Goes Like) Nanana (Edit)"). Acronyms like "n.e.r.d" fold to "nerd".
     */
    fun words(query: String): List<String> = fold(query).split(notWord).filter { it.isNotEmpty() }

    /**
     * Checks if [w] matches within [text] (which should already be folded).
     * Short words (< 4 chars) match at word boundaries (e.g. "red" matches "Red Alert", not "Filtered").
     * Longer words (>= 4 chars) match at word boundaries or within compound words ("head" in "Radiohead").
     */
    fun matchesWord(text: String, w: String): Boolean {
        if (w.isEmpty()) return true
        if (w.length >= 4) return text.contains(w)
        var idx = text.indexOf(w)
        while (idx >= 0) {
            if (idx == 0 || !text[idx - 1].isLetterOrDigit()) return true
            idx = text.indexOf(w, idx + 1)
        }
        return false
    }

    /** [text] (already folded) holds every one of [words]. */
    fun has(text: String, words: List<String>) = words.all { matchesWord(text, it) }

    /** [text] (not folded yet) holds every one of [words]. */
    fun matches(text: String, words: List<String>) = words.isEmpty() || has(fold(text), words)
}
