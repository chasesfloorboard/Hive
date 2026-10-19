package com.local.hive.mobile.ui

import java.text.Collator
import java.util.Locale

/** Library ordering: "!" , "\"Excuse Me\"" and "The Avalanches" file under E and A, not at the top. */
object LibrarySort {
    val collator: Collator = Collator.getInstance(Locale.getDefault()).apply { strength = Collator.PRIMARY }

    private val leading = Regex("""^[\p{P}\p{S}\s]+""")
    private val article = Regex("""^(the|a|an)\s+""", RegexOption.IGNORE_CASE)

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
