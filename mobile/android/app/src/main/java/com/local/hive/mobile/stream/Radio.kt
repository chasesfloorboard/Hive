package com.local.hive.mobile.stream

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.URLEncoder

/** An internet radio station, from radio-browser.info or added by its URL. */
@Serializable
data class Station(
    val id: String,
    val name: String,
    val url: String,
    val homepage: String = "",
    val favicon: String = "",
    val tags: List<String> = emptyList(),
    val country: String = "",
    val codec: String = "",
    val bitrate: Int = 0,
) {
    val mediaId get() = "radio:$id"

    fun toMediaItem(): MediaItem = MediaItem.Builder()
        .setMediaId(mediaId)
        .setUri(url)
        .setMediaMetadata(
            // No title here: the item's own fields outrank the stream's, and the station's ICY title should show.
            MediaMetadata.Builder()
                .setStation(name)
                .setAlbumTitle(name)
                .setArtworkUri(favicon.ifBlank { null }?.let(android.net.Uri::parse))
                .setMediaType(MediaMetadata.MEDIA_TYPE_RADIO_STATION)
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .build(),
        )
        .build()
}

@Serializable
private data class DirectoryStation(
    val stationuuid: String = "",
    val name: String = "",
    val url: String = "",
    val url_resolved: String = "",
    val homepage: String = "",
    val favicon: String = "",
    val tags: String = "",
    val country: String = "",
    val codec: String = "",
    val bitrate: Int = 0,
    val hls: Int = 0,
)

/**
 * Hive's internet radio (MusicBee's Web › Radio), as on the PC: stations from
 * the free radio-browser.info directory, or any station URL (a .pls or .m3u
 * link is opened for the stream inside). ExoPlayer reads the station's ICY
 * titles itself, so the playing song shows as it changes.
 */
class RadioDirectory(private val http: OkHttpClient = AppleMusic.defaultHttp()) {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    suspend fun popular(limit: Int = 60): List<Station> = get("/stations/topclick/$limit?hidebroken=true")

    /** Stations named like [query] first, then stations tagged with it (a genre). */
    suspend fun search(query: String, limit: Int = 60): List<Station> = coroutineScope {
        val q = URLEncoder.encode(query.trim().take(100), "UTF-8")
        val common = "limit=$limit&hidebroken=true&order=clickcount&reverse=true"
        val byName = async { get("/stations/search?name=$q&$common") }
        val byTag = async { runCatching { get("/stations/search?tag=${q.lowercase()}&$common") }.getOrDefault(emptyList()) }
        (byName.await() + byTag.await()).distinctBy { it.id }.take(limit)
    }

    /** A station from a URL the user pasted; playlists are opened for their stream. */
    suspend fun fromUrl(url: String, name: String): Station = withContext(Dispatchers.IO) {
        val u = url.trim()
        if (!u.startsWith("http://") && !u.startsWith("https://")) throw IOException("Station URLs start with http:// or https://")
        val stream = if (Regex("""\.(pls|m3u)(\?|$)""", RegexOption.IGNORE_CASE).containsMatchIn(u)) {
            val text = http.newCall(Request.Builder().url(u).header("User-Agent", USER_AGENT).build()).execute().use { it.body.string() }
            parsePlaylist(text) ?: throw IOException("No stream found in that playlist.")
        } else u
        Station(id = "url:" + Integer.toHexString(stream.hashCode()), name = name.trim().ifBlank { stream.substringAfter("://").substringBefore('/') }, url = stream)
    }

    private suspend fun get(path: String): List<Station> = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$DIRECTORY$path").header("User-Agent", USER_AGENT).build()
        val text = http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException("The radio directory answered ${res.code}")
            res.body.string()
        }
        json.decodeFromString<List<DirectoryStation>>(text).mapNotNull(::station)
    }

    companion object {
        private const val DIRECTORY = "https://all.api.radio-browser.info/json"
        private const val USER_AGENT = "HiveMobile/1.0 (music player; internet radio)"

        private fun station(s: DirectoryStation): Station? {
            val url = s.url_resolved.ifBlank { s.url }
            // HLS stations need a separate player module; they are left out, as on the PC.
            if (url.isBlank() || s.hls == 1 || Regex("""\.m3u8(\?|$)""", RegexOption.IGNORE_CASE).containsMatchIn(url)) return null
            return Station(
                id = s.stationuuid.ifBlank { url }, name = s.name.trim().ifBlank { "Unnamed station" }, url = url, homepage = s.homepage,
                favicon = s.favicon.takeIf { it.startsWith("https://") }.orEmpty(),
                tags = s.tags.split(',').map { it.trim() }.filter { it.isNotEmpty() }.take(4), country = s.country, codec = s.codec, bitrate = s.bitrate,
            )
        }

        /** The first stream in a .pls or .m3u playlist. */
        fun parsePlaylist(text: String): String? = text.lineSequence().map { it.trim() }.firstNotNullOfOrNull { line ->
            Regex("""^File\d+\s*=\s*(\S+)""", RegexOption.IGNORE_CASE).find(line)?.groupValues?.get(1)?.takeIf { it.startsWith("http") }
                ?: line.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        }
    }
}

/** The stations the user keeps. */
class RadioStore(context: Context) {
    private val prefs = context.getSharedPreferences("radio", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val _saved = MutableStateFlow(prefs.getString("saved", null)?.let { runCatching { json.decodeFromString<List<Station>>(it) }.getOrNull() }.orEmpty())
    val saved: StateFlow<List<Station>> = _saved.asStateFlow()

    fun toggle(station: Station) = set(if (_saved.value.any { it.id == station.id }) _saved.value.filterNot { it.id == station.id } else listOf(station) + _saved.value)

    private fun set(list: List<Station>) {
        _saved.value = list
        prefs.edit().putString("saved", json.encodeToString(kotlinx.serialization.builtins.ListSerializer(Station.serializer()), list)).apply()
    }
}
