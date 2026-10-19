package com.local.hive.mobile.stream

import android.content.Context
import android.util.Xml
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.xmlpull.v1.XmlPullParser
import java.io.IOException
import java.net.URLEncoder
import java.security.MessageDigest

/** A podcast show: from the iTunes directory, or a feed the user pasted. */
@Serializable
data class Podcast(val feedUrl: String, val title: String, val author: String = "", val image: String = "")

data class Episode(
    val id: String,
    val title: String,
    val show: String,
    val description: String,
    val published: String,
    val durationMs: Long,
    val audioUrl: String,
    val image: String,
) {
    val mediaId get() = "pod:" + MessageDigest.getInstance("SHA-1").digest(audioUrl.toByteArray()).take(10).joinToString("") { "%02x".format(it) }

    fun toMediaItem(): MediaItem = MediaItem.Builder()
        .setMediaId(mediaId)
        .setUri(audioUrl)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(show)
                .setAlbumTitle(show)
                .setArtworkUri(image.ifBlank { null }?.let(android.net.Uri::parse))
                .setDurationMs(durationMs.takeIf { it > 0 })
                .setMediaType(MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE)
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .build(),
        )
        .build()
}

data class Feed(val podcast: Podcast, val description: String, val episodes: List<Episode>)

/**
 * Hive's podcasts, as on the PC: shows from Apple's public podcast
 * directory (by title and by any term, merged and ranked as Hive ranks
 * them), or any feed URL, and episodes from the show's RSS feed.
 */
class PodcastDirectory(private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    suspend fun search(query: String): List<Podcast> = coroutineScope {
        val q = query.trim()
        if (q.isEmpty()) return@coroutineScope emptyList()
        if (q.startsWith("http://") || q.startsWith("https://")) return@coroutineScope listOf(feed(q).podcast)
        val term = URLEncoder.encode(q, "UTF-8")
        val pages = listOf(
            "https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&term=$term",
            "https://itunes.apple.com/search?media=podcast&entity=podcast&attribute=titleTerm&limit=25&term=$term",
        ).map { url -> async { runCatching { (Json.parseToJsonElement(get(url)) as JsonObject)["results"] as? JsonArray }.getOrNull().orEmpty() } }.awaitAll()
        val merged = LinkedHashMap<String, Podcast>()
        for (r in pages.flatten().mapNotNull { it as? JsonObject }) {
            val feed = r.str("feedUrl") ?: continue
            val p = Podcast(feed, r.str("collectionName") ?: r.str("trackName") ?: "Podcast", r.str("artistName").orEmpty(), (r.str("artworkUrl600") ?: r.str("artworkUrl100")).orEmpty().replace(Regex("""/\d+x\d+bb\."""), "/1400x1400bb."))
            val prior = merged[feed]
            merged[feed] = if (prior == null) p else prior.copy(image = prior.image.ifBlank { p.image }, author = prior.author.ifBlank { p.author })
        }
        val needle = q.lowercase()
        fun score(p: Podcast): Int { val t = p.title.lowercase(); return (if (t == needle) 100 else 0) + (if (t.startsWith(needle)) 35 else 0) + (if (needle in t) 20 else 0) + (if (needle in p.author.lowercase()) 10 else 0) }
        merged.values.sortedWith(compareByDescending<Podcast> { score(it) }.thenBy { it.title }).take(30)
    }

    suspend fun feed(url: String): Feed = parseFeed(get(url), url)

    private suspend fun get(url: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).header("User-Agent", "HiveMobile/1.0 (podcasts)").build()
        http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException("The podcast answered ${res.code}")
            res.body.string()
        }
    }

    companion object {
        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.ifBlank { null }

        /** An RSS feed's show and its episodes (up to 300, newest first as feeds list them). */
        fun parseFeed(xml: String, feedUrl: String): Feed {
            val parser = Xml.newPullParser().apply {
                setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
                setInput(xml.reader())
            }
            var showTitle = ""; var showAuthor = ""; var showImage = ""; var showDescription = ""
            val episodes = mutableListOf<Episode>()
            var inItem = false; var inImage = false
            var e = mutableMapOf<String, String>()
            while (parser.next() != XmlPullParser.END_DOCUMENT) {
                when (parser.eventType) {
                    XmlPullParser.START_TAG -> when (val name = parser.name) {
                        "item" -> { inItem = true; e = mutableMapOf() }
                        "image" -> if (!inItem) inImage = true
                        "itunes:image" -> parser.getAttributeValue(null, "href")?.let { if (inItem) e["image"] = it else if (showImage.isBlank()) showImage = it }
                        "enclosure" -> if (inItem) parser.getAttributeValue(null, "url")?.let { e["audio"] = it }
                        "url" -> if (inImage && showImage.isBlank()) showImage = parser.nextText().trim()
                        "title", "itunes:author", "author", "description", "content:encoded", "pubDate", "itunes:duration", "guid" -> {
                            val text = runCatching { parser.nextText() }.getOrDefault("").trim()
                            if (inItem) { if (!e.containsKey(name)) e[name] = text }
                            else when (name) {
                                "title" -> if (showTitle.isBlank() && !inImage) showTitle = text
                                "itunes:author", "author" -> if (showAuthor.isBlank()) showAuthor = text
                                "description" -> if (showDescription.isBlank()) showDescription = text
                            }
                        }
                    }
                    XmlPullParser.END_TAG -> when (parser.name) {
                        "image" -> inImage = false
                        "item" -> {
                            inItem = false
                            val audio = e["audio"]
                            if (audio != null && episodes.size < 300) episodes += Episode(
                                id = e["guid"]?.ifBlank { null } ?: audio, title = e["title"]?.ifBlank { null } ?: "Untitled episode",
                                show = showTitle.ifBlank { "Podcast" },
                                description = (e["content:encoded"] ?: e["description"]).orEmpty().stripHtml(),
                                published = e["pubDate"].orEmpty(), durationMs = duration(e["itunes:duration"].orEmpty()),
                                audioUrl = audio, image = e["image"] ?: showImage,
                            )
                        }
                    }
                }
            }
            // Episodes read before the show's title was known get it now.
            val show = showTitle.ifBlank { "Podcast" }
            return Feed(Podcast(feedUrl, show, showAuthor, showImage), showDescription.stripHtml(), episodes.map { it.copy(show = show, image = it.image.ifBlank { showImage }) })
        }

        private fun duration(text: String): Long {
            val parts = text.trim().split(':').map { it.toDoubleOrNull() }
            if (parts.any { it == null }) return 0
            val p = parts.filterNotNull()
            val seconds = when (p.size) { 3 -> p[0] * 3600 + p[1] * 60 + p[2]; 2 -> p[0] * 60 + p[1]; 1 -> p[0]; else -> 0.0 }
            return (seconds * 1000).toLong()
        }

        private fun String.stripHtml() = replace(Regex("<br\\s*/?>|</p>", RegexOption.IGNORE_CASE), "\n").replace(Regex("<[^>]+>"), "")
            .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ")
            .replace(Regex("\n{3,}"), "\n\n").trim()
    }
}

/** The shows the user follows, and how far into each episode they got. */
class PodcastStore(context: Context) {
    private val prefs = context.getSharedPreferences("podcasts", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val progressSerializer = MapSerializer(String.serializer(), Long.serializer())
    private val _subscriptions = MutableStateFlow(prefs.getString("subscriptions", null)?.let { runCatching { json.decodeFromString(ListSerializer(Podcast.serializer()), it) }.getOrNull() }.orEmpty())
    val subscriptions: StateFlow<List<Podcast>> = _subscriptions.asStateFlow()
    private val _progress = MutableStateFlow(prefs.getString("progress", null)?.let { runCatching { json.decodeFromString(progressSerializer, it) }.getOrNull() }.orEmpty())
    /** Episode media id to milliseconds listened; [FINISHED] once played to the end. */
    val progress: StateFlow<Map<String, Long>> = _progress.asStateFlow()

    fun toggle(p: Podcast) {
        val next = if (_subscriptions.value.any { it.feedUrl == p.feedUrl }) _subscriptions.value.filterNot { it.feedUrl == p.feedUrl } else listOf(p) + _subscriptions.value
        _subscriptions.value = next
        prefs.edit().putString("subscriptions", json.encodeToString(ListSerializer(Podcast.serializer()), next)).apply()
    }

    fun setProgress(mediaId: String, positionMs: Long) {
        val next = (_progress.value + (mediaId to positionMs)).entries.toList().takeLast(500).associate { it.key to it.value }
        _progress.value = next
        prefs.edit().putString("progress", json.encodeToString(progressSerializer, next)).apply()
    }

    companion object { const val FINISHED = -1L }
}
