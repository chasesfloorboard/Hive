package com.local.hive.mobile.discovery

import com.local.hive.mobile.art.ArtNet
import com.local.hive.mobile.art.string
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** One album-cover candidate for the tag editor's "search covers online" grid. */
data class CoverChoice(
    val id: String,
    val title: String,
    val artist: String,
    val thumbUrl: String,
    val fullUrl: String,
)

/**
 * Compliant album-cover search for the tag editor, powered by the public iTunes Search API — keyless, no
 * login, the SAME API Hive already uses for live album art (so this is not an Apple Music / open.spotify.com
 * scrape). It returns many candidates for the user to pick from, with far broader coverage than the Cover Art
 * Archive alone, so it's the default cover search in both editions. Metadata/Auto-tag still comes from
 * MusicBrainz ([MetadataProvider]); this is only the cover grid.
 */
class ITunesCoverSearch(private val base: String = "https://itunes.apple.com") {
    suspend fun search(query: String): List<CoverChoice> = withContext(Dispatchers.IO) {
        val q = query.trim()
        if (q.isBlank()) return@withContext emptyList()
        val url = "$base/search?entity=album&limit=24&term=" + ArtNet.enc(q)
        val results = ((ArtNet.limited { ArtNet.getJson(url) } as? JsonObject)?.get("results") as? JsonArray)
            .orEmpty().mapNotNull { it as? JsonObject }
        results.mapNotNull { r ->
            val art = r.string("artworkUrl100")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            CoverChoice(
                id = r.string("collectionId") ?: art,
                title = r.string("collectionName").orEmpty(),
                artist = r.string("artistName").orEmpty(),
                thumbUrl = art.replace(Regex("""/\d+x\d+bb\."""), "/300x300bb."),
                fullUrl = art.replace(Regex("""/\d+x\d+bb\."""), "/1200x1200bb."),
            )
        }.filter { it.title.isNotBlank() }
    }
}
