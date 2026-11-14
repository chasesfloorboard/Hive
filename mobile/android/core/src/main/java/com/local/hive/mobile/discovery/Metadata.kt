package com.local.hive.mobile.discovery

import com.local.hive.mobile.art.ArtNet
import com.local.hive.mobile.art.longOf
import com.local.hive.mobile.art.string
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Compliant, keyless album metadata for the tag editor's "find album" and Auto-tag — powered by
 * MusicBrainz, the canonical open music database, instead of scraping Apple Music or Spotify. It lives in
 * :core so BOTH editions use it (Hive Clean has nothing else; Hive Mobile uses it first and only falls back
 * to Apple Music where that genuinely adds something). Covers come from the Cover Art Archive by the exact
 * release id, so a tagged album keeps ITS release's artwork (honouring "a song keeps its release").
 *
 * MusicBrainz asks for a <=1 req/sec rate and a descriptive User-Agent; both go through [ArtNet].
 */

/** An album found in a metadata search — enough to show a pick list. [id] is a MusicBrainz release id. */
data class AlbumHit(
    val id: String,
    val title: String,
    val artist: String,
    val year: String,
    val trackCount: Int,
    val coverUrl: String,
)

/** One track of an album's canonical tracklist. */
data class TrackMeta(
    val title: String,
    val artist: String,
    val trackNumber: Int,
    val discNumber: Int,
    val durationMs: Long,
)

/** An album's full details, for writing tags across its songs. */
data class AlbumMeta(
    val id: String,
    val title: String,
    val artist: String,
    val year: String,
    val coverUrl: String,
    val tracks: List<TrackMeta>,
)

/** The metadata operations the tag editor needs, named in :core types so both editions can use them. */
interface MetadataProvider {
    /** Albums matching [query] (free text, e.g. "artist album"), best matches first. */
    suspend fun searchAlbums(query: String): List<AlbumHit>
    /** One release's full details and tracklist by its MusicBrainz id, or null. */
    suspend fun album(id: String): AlbumMeta?
}

/** MusicBrainz-backed [MetadataProvider]. Keyless, no login — the compliant default for both editions. */
class MusicBrainzMetadata(private val base: String = "https://musicbrainz.org/ws/2") : MetadataProvider {

    override suspend fun searchAlbums(query: String): List<AlbumHit> = withContext(Dispatchers.IO) {
        val q = query.trim()
        if (q.isBlank()) return@withContext emptyList()
        val url = "$base/release/?fmt=json&limit=15&query=" + ArtNet.enc(q)
        val root = ArtNet.musicbrainz { ArtNet.getJson(url) } as? JsonObject ?: return@withContext emptyList()
        (root["releases"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map { r ->
            val id = r.string("id").orEmpty()
            AlbumHit(
                id = id,
                title = r.string("title").orEmpty(),
                artist = artistCreditName(r),
                year = r.string("date").orEmpty().take(4),
                trackCount = r.intOf("track-count").takeIf { it > 0 }
                    ?: (r["media"] as? JsonArray).orEmpty().sumOf { m -> (m as? JsonObject)?.intOf("track-count") ?: 0 },
                coverUrl = if (hasFrontCover(r) && id.isNotBlank()) "https://coverartarchive.org/release/$id/front-500" else "",
            )
        }.filter { it.id.isNotBlank() && it.title.isNotBlank() }
    }

    override suspend fun album(id: String): AlbumMeta? = withContext(Dispatchers.IO) {
        if (id.isBlank()) return@withContext null
        val url = "$base/release/$id?fmt=json&inc=recordings+artist-credits"
        val r = ArtNet.musicbrainz { ArtNet.getJson(url) } as? JsonObject ?: return@withContext null
        val media = (r["media"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val albumArtist = artistCreditName(r)
        val tracks = media.flatMapIndexed { discIndex, m ->
            (m["tracks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map { t ->
                val rec = t["recording"] as? JsonObject
                TrackMeta(
                    title = (t.string("title") ?: rec?.string("title")).orEmpty(),
                    artist = artistCreditName(t).ifBlank { rec?.let { artistCreditName(it) }.orEmpty() }.ifBlank { albumArtist },
                    trackNumber = t.string("number")?.toIntOrNull() ?: t.intOf("position"),
                    discNumber = discIndex + 1,
                    durationMs = t.longOf("length").takeIf { it > 0 } ?: (rec?.longOf("length") ?: 0L),
                )
            }
        }
        AlbumMeta(
            id = id,
            title = r.string("title").orEmpty(),
            artist = albumArtist,
            year = r.string("date").orEmpty().take(4),
            coverUrl = if (hasFrontCover(r)) "https://coverartarchive.org/release/$id/front-1200" else "",
            tracks = tracks,
        )
    }

    /** MusicBrainz artist-credit → a single display string (e.g. "A feat. B"), from `name` + `joinphrase`. */
    private fun artistCreditName(o: JsonObject): String =
        (o["artist-credit"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.joinToString("") { c ->
            (c.string("name") ?: (c["artist"] as? JsonObject)?.string("name")).orEmpty() + c.string("joinphrase").orEmpty()
        }.trim()

    private fun hasFrontCover(r: JsonObject): Boolean =
        ((r["cover-art-archive"] as? JsonObject)?.get("front") as? JsonPrimitive)?.contentOrNull == "true"

    private fun JsonObject.intOf(key: String): Int = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toInt() ?: 0
}
