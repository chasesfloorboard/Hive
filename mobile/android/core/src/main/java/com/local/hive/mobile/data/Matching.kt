package com.local.hive.mobile.data

import java.text.Normalizer

/** Title/artist text matching, shared by the cover engine and the streaming services. */

/** A comparable title or artist: no "(feat. …)", "[Mixed]", "- Remastered 2011" or punctuation. */
fun normalise(text: String): String = Normalizer.normalize(text.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "")
    .replace(Regex("""[(\[](feat\.?|ft\.?|with|mixed|explicit|clean|official[^)\]]*|audio|lyrics?[^)\]]*)[^)\]]*[)\]]"""), " ")
    .replace(Regex("""\s+-\s+(\d{4}\s+)?remaster(ed)?.*$"""), " ")
    .replace(Regex("""\s+(feat\.?|ft\.?)\s+.*$"""), " ")
    .replace("&", " and ")
    .replace(Regex("[^a-z0-9]+"), " ").trim()

private fun words(text: String) = normalise(text).split(' ').filter { it.isNotEmpty() }.toSet()

fun similarity(a: String, b: String): Double {
    val x = words(a); val y = words(b)
    if (x.isEmpty() || y.isEmpty()) return 0.0
    return 2.0 * x.count { it in y } / (x.size + y.size)
}

/** Share of the wanted words found in [text] (YouTube lists every featured artist). */
fun containment(wanted: String, text: String): Double {
    val x = words(wanted); val y = words(text)
    return if (x.isEmpty()) 0.0 else x.count { it in y }.toDouble() / x.size
}

fun firstArtist(artist: String) = artist.split(Regex(",|&| x | and | feat\\.? | ft\\.? ", RegexOption.IGNORE_CASE)).first().trim()
