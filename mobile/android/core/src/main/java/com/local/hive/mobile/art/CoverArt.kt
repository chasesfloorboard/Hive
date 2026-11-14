package com.local.hive.mobile.art

import com.local.hive.mobile.data.defaultHttp
import com.local.hive.mobile.data.normalise
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URLEncoder

/**
 * A single, ToS-COMPLIANT framework for album/artist cover art, shared by both editions (Hive Mobile and
 * Hive Clean). Every source here is an official, no-login, no-secret public API — never a scrape of
 * music.apple.com or open.spotify.com. Providers return a URL (Coil fetches+caches the bytes); the registry
 * tries them in order and a provider that `needsSecret` is dropped from the keyless (F-Droid / Hive Clean)
 * build. NOTE: this is new, self-contained, and NOT yet wired into AlbumArtFetcher's live path — wiring it
 * in replaces the Apple-Music scrape fallback and is a separate, reviewed step.
 */

/** An album to look up. [mbid] is a MusicBrainz release id; when known it pins art to the EXACT release
 *  (honouring "a song keeps its release") instead of a fuzzy search that could return a reissue/compilation. */
data class AlbumQuery(val artist: String, val title: String, val mbid: String? = null)

data class ArtistQuery(val name: String)

interface CoverArtProvider {
    val id: String
    /** true => this source needs an API key/secret, so it is excluded from the keyless F-Droid build. */
    val needsSecret: Boolean get() = false
    suspend fun albumArt(q: AlbumQuery): String?
    suspend fun artistImage(q: ArtistQuery): String? = null
}

/** Shared HTTP etiquette: the mandatory MusicBrainz/Cover-Art-Archive User-Agent, a strict 1-request/second
 *  gate for those two hosts, and a small concurrency cap for the faster APIs. Lifted from SpotifyFind.kt. */
internal object ArtNet {
    const val UA = "HiveMusicPlayer/3.0.0 ( https://github.com/chasesfloorboard/Hive )"
    val http: OkHttpClient by lazy { defaultHttp() }

    private val mbGate = Mutex()
    /** MusicBrainz AND coverartarchive.org share a <=1 req/sec rule; serialise and pace them together. */
    suspend fun <T> musicbrainz(block: suspend () -> T): T = mbGate.withLock { val r = block(); delay(1_100); r }

    private val fast = Semaphore(3)
    suspend fun <T> limited(block: suspend () -> T): T = fast.withPermit { block() }

    fun getJson(url: String): JsonElement? =
        http.newCall(Request.Builder().url(url).header("User-Agent", UA).header("Accept", "application/json").build())
            .execute().use { if (!it.isSuccessful) null else runCatching { Json.parseToJsonElement(it.body.string()) }.getOrNull() }

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}

internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.longOf(key: String): Long = (this[key] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong() ?: 0L
/** Loose title/name equality after Hive's normalisation (drops "- Single"/"(Deluxe)"/punctuation/case). */
internal fun sameName(a: String?, b: String): Boolean {
    if (a.isNullOrBlank()) return false
    val x = normalise(a); val y = normalise(b)
    return x == y || x.contains(y) || y.contains(x)
}

/** Deezer public API (no key): album `cover_xl` and artist `picture_xl`, both ~1000px. */
class DeezerCoverProvider(private val base: String = "https://api.deezer.com") : CoverArtProvider {
    override val id = "deezer"
    override suspend fun albumArt(q: AlbumQuery): String? = withContext(Dispatchers.IO) {
        if (q.artist.isBlank() || q.title.isBlank()) return@withContext null
        ArtNet.limited {
            val url = "$base/search/album?limit=5&q=" + ArtNet.enc("artist:\"${q.artist}\" album:\"${q.title}\"")
            val data = ((ArtNet.getJson(url) as? JsonObject)?.get("data") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val hit = data.firstOrNull { sameName(it.string("title"), q.title) } ?: data.firstOrNull()
            hit?.string("cover_xl")?.takeIf { it.isNotBlank() }
        }
    }
    override suspend fun artistImage(q: ArtistQuery): String? = withContext(Dispatchers.IO) {
        if (q.name.isBlank()) return@withContext null
        ArtNet.limited {
            val url = "$base/search/artist?limit=5&q=" + ArtNet.enc(q.name)
            val data = ((ArtNet.getJson(url) as? JsonObject)?.get("data") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val hit = data.filter { sameName(it.string("name"), q.name) }.maxByOrNull { it.longOf("nb_fan") }
            hit?.string("picture_xl")?.takeIf { it.isNotBlank() }
        }
    }
}

/** Cover Art Archive, addressed by the exact MusicBrainz release id — the only source that guarantees the
 *  art belongs to THIS release. Returns null when the query carries no mbid, or when CAA has no front cover. */
class CoverArtArchiveProvider(private val base: String = "https://coverartarchive.org") : CoverArtProvider {
    override val id = "caa"
    override suspend fun albumArt(q: AlbumQuery): String? {
        val mbid = q.mbid?.takeIf { it.isNotBlank() } ?: return null
        val url = "$base/release/$mbid/front-1200"
        return withContext(Dispatchers.IO) {
            ArtNet.musicbrainz {
                runCatching {
                    ArtNet.http.newCall(Request.Builder().url(url).header("User-Agent", ArtNet.UA).head().build())
                        .execute().use { if (it.isSuccessful || it.code == 307) url else null }
                }.getOrNull()
            }
        }
    }
}

/** iTunes Search API (no key, no login): album artwork from `artworkUrl100` upscaled to ~1200px. Mirrors
 *  the match logic the app already trusts in AlbumArt.kt (bare-name equality + artist containment), but
 *  returns the URL for the registry/Coil to fetch rather than the bytes. iTunes has no reliable artist photo,
 *  so artistImage stays null. */
class ITunesCoverProvider(private val base: String = "https://itunes.apple.com") : CoverArtProvider {
    override val id = "itunes"
    override suspend fun albumArt(q: AlbumQuery): String? = withContext(Dispatchers.IO) {
        if (q.artist.isBlank() || q.title.isBlank()) return@withContext null
        ArtNet.limited {
            val term = ArtNet.enc("${q.artist} ${q.title.substringBefore(" - ")}")
            val url = "$base/search?entity=album&limit=15&term=$term"
            val results = ((ArtNet.getJson(url) as? JsonObject)?.get("results") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val hit = results.firstOrNull { r ->
                sameName(r.string("collectionName"), q.title) &&
                    com.local.hive.mobile.data.containment(com.local.hive.mobile.data.firstArtist(q.artist), r.string("artistName").orEmpty()) >= 0.5
            } ?: return@limited null
            hit.string("artworkUrl100")?.replace(Regex("""/\d+x\d+bb\."""), "/1200x1200bb.")?.takeIf { it.isNotBlank() }
        }
    }
}

/** MusicBrainz release search -> Cover Art Archive. When the caller has no mbid, this resolves the release
 *  id for an (artist,title) and returns THAT release's CAA front cover — extending CAA's exact-release
 *  guarantee (honouring "a song keeps its release") to callers that only know names. Both calls pass through
 *  the shared <=1 req/sec MB/CAA gate. */
class MusicBrainzCoverProvider(
    private val mbBase: String = "https://musicbrainz.org",
    private val caaBase: String = "https://coverartarchive.org",
) : CoverArtProvider {
    override val id = "musicbrainz"
    override suspend fun albumArt(q: AlbumQuery): String? {
        if (q.artist.isBlank() || q.title.isBlank()) return null
        return withContext(Dispatchers.IO) {
            val mbid = ArtNet.musicbrainz {
                val query = ArtNet.enc("release:\"${q.title}\" AND artist:\"${q.artist}\"")
                val url = "$mbBase/ws/2/release/?query=$query&fmt=json&limit=5"
                val releases = ((ArtNet.getJson(url) as? JsonObject)?.get("releases") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
                (releases.firstOrNull { sameName(it.string("title"), q.title) } ?: releases.firstOrNull())?.string("id")
            }?.takeIf { it.isNotBlank() } ?: return@withContext null
            val front = "$caaBase/release/$mbid/front-1200"
            ArtNet.musicbrainz {
                runCatching {
                    ArtNet.http.newCall(Request.Builder().url(front).header("User-Agent", ArtNet.UA).head().build())
                        .execute().use { if (it.isSuccessful || it.code == 307) front else null }
                }.getOrNull()
            }
        }
    }
}

/** The compliant cover sources in fallback order. [keyless] is what Hive Mobile (F-Droid) and Hive Clean
 *  ship; a Play-only build could append keyed providers (fanart.tv / TheAudioDB) — those are filtered out
 *  of any keyless registry by [needsSecret]. */
class CoverArtRegistry(providers: List<CoverArtProvider>, keylessOnly: Boolean = true) {
    private val chain = if (keylessOnly) providers.filterNot { it.needsSecret } else providers

    suspend fun albumArt(q: AlbumQuery): String? =
        chain.firstNotNullOfOrNull { runCatching { it.albumArt(q) }.getOrNull()?.takeIf { url -> url.isNotBlank() } }

    suspend fun artistImage(q: ArtistQuery): String? =
        chain.firstNotNullOfOrNull { runCatching { it.artistImage(q) }.getOrNull()?.takeIf { url -> url.isNotBlank() } }

    companion object {
        /** Album art, most-authoritative first: the exact release's CAA front when an mbid is already known;
         *  then MusicBrainz resolves the release and returns its CAA front; then Apple; then Deezer. The two
         *  CAA-backed sources lead because they pin art to the exact release. Artist images come from Deezer
         *  (the others return null for artistImage). All keyless. */
        fun keyless(): CoverArtRegistry =
            CoverArtRegistry(listOf(
                CoverArtArchiveProvider(),
                MusicBrainzCoverProvider(),
                ITunesCoverProvider(),
                DeezerCoverProvider(),
            ))
    }
}
