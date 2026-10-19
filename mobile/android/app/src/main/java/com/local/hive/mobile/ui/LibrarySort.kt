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
}
