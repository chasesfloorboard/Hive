package com.local.hive.mobile.stream

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** A playlist or album on Apple Music. */
data class AmCard(val kind: String, val id: String, val name: String, val curator: String, val artwork: String, val url: String)

/** A song on Apple Music; [previewUrl] is its 30-second preview, when Apple has one. */
data class AmSong(
    val appleId: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val artwork: String,
    val url: String,
    val previewUrl: String = "",
    val year: String = "",
    val genre: String = "",
)

/** A Browse shelf: either cards (playlists, albums) or songs. */
data class AmShelf(val title: String, val cards: List<AmCard> = emptyList(), val songs: List<AmSong> = emptyList())

data class AmCollection(
    val kind: String,
    val id: String,
    val storefront: String,
    val name: String,
    val curator: String,
    val description: String,
    val artwork: String,
    val url: String,
    val songs: List<AmSong>,
    val more: List<AmCard>,
)

data class AmSearch(val playlists: List<AmCard>, val albums: List<AmCard>)

/**
 * Hive's Apple Music browser, as on the PC: Apple Music's public web pages
 * (what music.apple.com shows signed-out visitors) for Browse, search,
 * playlists and albums, and 30-second previews from Apple's public iTunes
 * lookup API. No Apple ID is used, so full songs can't be streamed from
 * Apple: Hive plays matching songs from the library and previews for the rest.
 */
class AppleMusic(private val http: OkHttpClient = defaultHttp()) {
    private var browseCache: Triple<String, Long, List<AmShelf>>? = null

    suspend fun browse(storefront: String = "us"): List<AmShelf> {
        val sf = storefrontOf(storefront)
        browseCache?.let { (cachedSf, at, shelves) -> if (cachedSf == sf && System.currentTimeMillis() - at < 30 * 60_000) return shelves }
        val shelves = parseBrowse(getText("https://music.apple.com/$sf/browse"))
        browseCache = Triple(sf, System.currentTimeMillis(), shelves)
        return shelves
    }

    suspend fun search(term: String, storefront: String = "us"): AmSearch {
        val q = term.trim().take(100)
        if (q.isEmpty()) return AmSearch(emptyList(), emptyList())
        return parseSearch(getText("https://music.apple.com/${storefrontOf(storefront)}/search?term=${URLEncoder.encode(q, "UTF-8")}"))
    }

    /** A playlist or album by its music.apple.com link, with previews filled in. */
    suspend fun collection(url: String): AmCollection {
        val ref = parseUrl(url) ?: throw IOException("Enter a music.apple.com playlist or album link.")
        val page = parseCollection(getText("https://music.apple.com/${ref.storefront}/${ref.kind}/x/${ref.id}"), ref)
            ?: throw IOException("Apple Music did not share this ${ref.kind} publicly.")
        return page.copy(songs = withPreviews(page.songs, ref.storefront))
    }

    /** Fills previews, album, year and genre from the iTunes lookup API, up to 150 songs a call. */
    suspend fun withPreviews(songs: List<AmSong>, storefront: String = "us"): List<AmSong> {
        val out = songs.toMutableList()
        for (start in songs.indices step 150) {
            val batch = songs.subList(start, minOf(songs.size, start + 150))
            val found = runCatching {
                val results = Json.parseToJsonElement(getText("https://itunes.apple.com/lookup?id=${batch.joinToString(",") { it.appleId }}&country=${storefrontOf(storefront)}"))
                    .obj?.get("results")?.arr.orEmpty()
                results.mapNotNull { r -> r.obj?.let { o -> o.str("trackId")?.let { it to o } } }.toMap()
            }.getOrDefault(emptyMap())
            batch.forEachIndexed { i, s ->
                val r = found[s.appleId] ?: return@forEachIndexed
                out[start + i] = s.copy(
                    previewUrl = r.str("previewUrl")?.takeIf { it.startsWith("https://") } ?: s.previewUrl,
                    album = s.album.ifBlank { r.str("collectionName").orEmpty() },
                    year = r.str("releaseDate")?.take(4) ?: s.year,
                    genre = r.str("primaryGenreName") ?: s.genre,
                    durationMs = s.durationMs.takeIf { it > 0 } ?: r.str("trackTimeMillis")?.toLongOrNull() ?: 0,
                )
            }
        }
        return out
    }

    private suspend fun getText(url: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url.toHttpUrl()).header("User-Agent", USER_AGENT).header("Accept-Language", "en-US,en;q=0.9").build()
        http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException("Apple Music answered ${res.code}")
            res.body.string()
        }
    }

    data class Ref(val storefront: String, val kind: String, val id: String)

    companion object {
        private const val USER_AGENT = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
        private val serverData = Regex("""<script[^>]+id="serialized-server-data"[^>]*>([\s\S]*?)</script>""")
        private val linkPattern = Regex("""^https://(?:embed\.)?music\.apple\.com/([a-z]{2})/(playlist|album)/(?:[^/?#]+/)?((?:pl\.[A-Za-z0-9.-]+)|\d+)""", RegexOption.IGNORE_CASE)
        private val tags = Regex("<[^>]+>")
        private val spaces = Regex("""\s+""")

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()

        fun isAppleMusicLink(text: String) = text.trim().startsWith("https://music.apple.com/") || text.trim().startsWith("https://embed.music.apple.com/")

        /** https://music.apple.com/<storefront>/<playlist|album>/<slug>/<id> */
        fun parseUrl(input: String): Ref? = linkPattern.find(input.trim())?.let { m ->
            Ref(m.groupValues[1].lowercase(), m.groupValues[2].lowercase(), m.groupValues[3])
        }

        private fun storefrontOf(sf: String) = sf.lowercase().takeIf { Regex("^[a-z]{2}$").matches(it) } ?: "us"

        private fun sections(html: String): List<JsonObject> {
            val data = serverData.find(html)?.groupValues?.get(1)?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() } ?: return emptyList()
            val root = data.obj?.get("data")
            val page = (root as? JsonArray)?.firstOrNull() ?: root
            return page?.obj?.get("data")?.obj?.get("sections")?.arr.orEmpty().mapNotNull { it.obj }
        }

        /** Apple artwork URLs are templates: .../{w}x{h}bb.{f} */
        private fun artworkUrl(artwork: JsonElement?, size: Int): String {
            val a = artwork?.obj ?: return ""
            val url = a["dictionary"]?.obj?.str("url") ?: a.str("url") ?: return ""
            if (!url.startsWith("https://")) return ""
            return url.replace("{w}", "$size").replace("{h}", "$size").replace("{f}", "jpg").replace("{c}", "bb")
        }

        private fun linkTitles(links: JsonElement?): List<String> = links?.arr.orEmpty().mapNotNull { it.obj?.str("title")?.trim()?.ifBlank { null } }

        private fun card(item: JsonObject): AmCard? {
            val cd = item["contentDescriptor"]?.obj ?: return null
            val id = cd["identifiers"]?.obj?.str("storeAdamID").orEmpty()
            val kind = cd.str("kind").orEmpty()
            if (id.isEmpty() || kind !in setOf("playlist", "album")) return null
            val name = linkTitles(item["titleLinks"]).firstOrNull() ?: item.str("title") ?: item.str("headline").orEmpty()
            val curator = linkTitles(item["subtitleLinks"]).joinToString(", ").ifBlank { item.str("subtitle").orEmpty() }
            return AmCard(kind, id, name, curator, artworkUrl(item["artwork"], 400), cd.str("url").orEmpty())
        }

        private fun song(item: JsonObject, requireSongKind: Boolean): AmSong? {
            val cd = item["contentDescriptor"]?.obj ?: return null
            val id = cd["identifiers"]?.obj?.str("storeAdamID").orEmpty()
            val title = item.str("title").orEmpty()
            if (id.isEmpty() || title.isEmpty() || (requireSongKind && cd.str("kind") != "song")) return null
            return AmSong(
                appleId = id, title = title,
                artist = linkTitles(item["subtitleLinks"]).joinToString(", "),
                album = linkTitles(item["tertiaryLinks"]).firstOrNull().orEmpty(),
                durationMs = item.str("duration")?.toDoubleOrNull()?.toLong() ?: 0,
                artwork = artworkUrl(item["artwork"], 600),
                url = cd.str("url").orEmpty(),
            )
        }

        fun parseSearch(html: String): AmSearch {
            val playlists = mutableListOf<AmCard>()
            val albums = mutableListOf<AmCard>()
            for (section in sections(html)) for (item in section["items"]?.arr.orEmpty()) {
                val c = item.obj?.let(::card) ?: continue
                val list = if (c.kind == "playlist") playlists else albums
                val seen = list.indexOfFirst { it.id == c.id }
                if (seen < 0) list += c else if (list[seen].curator.isBlank() && c.curator.isNotBlank()) list[seen] = c
            }
            return AmSearch(playlists, albums)
        }

        fun parseBrowse(html: String): List<AmShelf> = sections(html).mapNotNull { section ->
            val title = section["header"]?.obj?.get("item")?.obj?.get("titleLink")?.obj?.str("title")
                ?: if (section.str("itemKind") == "flowcaseLockup") "Featured" else ""
            val items = section["items"]?.arr.orEmpty().mapNotNull { it.obj }
            if (section.str("itemKind") == "trackLockup") {
                items.mapNotNull { song(it, requireSongKind = true) }.take(20).takeIf { it.isNotEmpty() }?.let { AmShelf(title, songs = it) }
            } else {
                items.mapNotNull(::card).filter { it.name.isNotBlank() }.distinctBy { it.id }.take(20).takeIf { it.isNotEmpty() }?.let { AmShelf(title, cards = it) }
            }
        }

        fun parseCollection(html: String, ref: Ref): AmCollection? {
            val sections = sections(html)
            val header = sections.firstOrNull { it.str("id").orEmpty().contains("detail-header") }?.get("items")?.arr?.firstOrNull()?.obj
            val songs = sections.filter { it.str("itemKind") == "trackLockup" }
                .flatMap { s -> s["items"]?.arr.orEmpty().mapNotNull { it.obj?.let { o -> song(o, requireSongKind = false) } } }
            // Album pages list songs without their own artist or artwork; the header carries them.
            val headerArtist = linkTitles(header?.get("subtitleLinks")).joinToString(", ")
            val headerArt = artworkUrl(header?.get("artwork"), 600)
            val isAlbum = ref.kind == "album"
            val filled = songs.map { s ->
                s.copy(
                    artist = s.artist.ifBlank { headerArtist },
                    artwork = s.artwork.ifBlank { headerArt },
                    album = s.album.ifBlank { if (isAlbum) header?.str("title").orEmpty() else "" },
                )
            }
            val more = sections.filter { it.str("itemKind") == "squareLockup" }
                .flatMap { s -> s["items"]?.arr.orEmpty().mapNotNull { it.obj?.let(::card) } }.distinctBy { it.id }.take(16)
            if (header == null && filled.isEmpty()) return null
            val description = header?.get("description")?.let { d -> d.obj?.str("standard") ?: d.obj?.str("short") ?: (d as? JsonPrimitive)?.contentOrNull }.orEmpty()
            return AmCollection(
                kind = ref.kind, id = ref.id, storefront = ref.storefront,
                name = header?.str("title").orEmpty(),
                curator = headerArtist,
                description = description.replace(tags, " ").replace(spaces, " ").trim(),
                artwork = artworkUrl(header?.get("artwork"), 1000),
                url = "https://music.apple.com/${ref.storefront}/${ref.kind}/${ref.id}",
                songs = filled, more = more,
            )
        }

        private val JsonElement.obj: JsonObject? get() = this as? JsonObject
        private val JsonElement.arr: JsonArray? get() = this as? JsonArray
        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}

/** How Hive keeps an Apple Music song that isn't in the library. */
fun AmSong.toStream() = com.local.hive.mobile.data.StreamTrack(
    key = "am:$appleId", source = "Apple Music", title = title, artist = artist, album = album,
    durationMs = durationMs, artworkUrl = artwork, previewUrl = previewUrl, url = url,
)
