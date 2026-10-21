package com.local.hive.mobile.link

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

// Wire models for Hive Link; see app/main/hive-link.js on the PC.

@Serializable data class DiscoveredHive(val serverId: String, val name: String, val host: String, val port: Int)
@Serializable data class PairResponse(val token: String, val deviceId: String, val serverId: String, val name: String, val seq: Long)
@Serializable data class PcTrack(
    val id: String,
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val albumArtist: String = "",
    val duration: Long = 0,
    val loved: Boolean = false,
    val rating: Double = 0.0,
    val playCount: Long = 0,
    val track: Int = 0,
    val disc: Int = 0,
    val year: String = "",
    val genre: String = "",
    val file: String = "",
    val cover: String = "",
    /** File size in bytes (0 from an older Hive). */
    val size: Long = 0,
)
@Serializable data class LibraryResponse(val seq: Long, val tracks: List<PcTrack>)
@Serializable data class LoveEvent(val seq: Long, val id: String, val loved: Boolean, val at: Long, val origin: String = "")
@Serializable data class ChangesResponse(val reset: Boolean, val seq: Long, val changes: List<LoveEvent>)
@Serializable data class LoveChange(val clientChangeId: Long, val id: String, val loved: Boolean, val at: Long)
@Serializable data class LoveRequest(val changes: List<LoveChange>)
@Serializable data class LoveResult(val clientChangeId: Long? = null, val id: String? = null, val status: String, val loved: Boolean? = null, val at: Long? = null, val error: String? = null)
@Serializable data class LoveResponse(val seq: Long, val results: List<LoveResult>)
@Serializable data class HiveAddress(val name: String = "", val address: String, val tailscale: Boolean = false)
@Serializable data class StreamCaps(val track: Boolean = false, val song: Boolean = false)
/** Phone changes waiting in Hive on the PC for the user to apply. */
@Serializable data class InboxSummary(val loves: Int = 0, val plays: Int = 0)
/** Song sync on the PC: whether Hive takes song files from the phone. */
@Serializable data class SongCaps(val receive: Boolean = false)
@Serializable data class InfoResponse(val serverId: String, val name: String, val port: Int, val seq: Long, val addresses: List<HiveAddress> = emptyList(), val streams: StreamCaps = StreamCaps(), val remote: Boolean = false, val plays: Boolean = false, val inbox: InboxSummary = InboxSummary(), val songs: SongCaps = SongCaps(), val wrap: Boolean = false)
/** One year's Yearly Wrap as Hive on the PC counts it (its plays, imports and this phone's). */
@Serializable data class PcWrap(
    val year: Int,
    val totalSeconds: Double = 0.0,
    val totalPlays: Int = 0,
    val uniqueArtists: Int = 0,
    val uniqueAlbums: Int = 0,
    val longestStreak: Int = 0,
    val topTrack: PcWrapTrack? = null,
    val topArtists: List<PcWrapArtist> = emptyList(),
    val topAlbums: List<PcWrapAlbum> = emptyList(),
    val topGenres: List<PcWrapGenre> = emptyList(),
    val topDay: PcWrapDay? = null,
    val monthly: List<PcWrapMonth> = emptyList(),
    val topMonth: PcWrapMonth? = null,
)
/** [key] is "title\u0000artist". Covers are names for /api/cover, or https addresses. */
@Serializable data class PcWrapTrack(val key: String, val plays: Int, val album: String = "", val cover: String? = null)
@Serializable data class PcWrapArtist(val name: String, val plays: Int, val cover: String? = null)
@Serializable data class PcWrapAlbum(val album: String, val artist: String = "", val plays: Int, val cover: String? = null)
@Serializable data class PcWrapGenre(val name: String, val seconds: Double = 0.0)
@Serializable data class PcWrapDay(val date: String, val seconds: Double = 0.0)
@Serializable data class PcWrapMonth(val month: String, val seconds: Double = 0.0)
@Serializable data class WrapYears(val years: List<Int> = emptyList())

/** Hive's answer to a song sent from the phone: "saved", or "exists" (it already had it). */
@Serializable data class SongUpload(val status: String, val id: String = "")
/** A play, as sent to Hive ([clientId] is this phone's own id for it) or fetched from it. */
@Serializable data class PlayOut(val clientId: String, val id: String, val playedAt: Long, val listenedMs: Long)
@Serializable data class PlaysRequest(val plays: List<PlayOut>)
/** Hive's answer to phone plays: [counted] at once, or [staged] for review; [unknown] songs it doesn't have (by clientId). */
@Serializable data class PlaysStaged(val staged: Int = 0, val counted: Int = 0, val unknown: List<String> = emptyList())
@Serializable data class PlayIn(val id: String, val playedAt: Long, val listenedMs: Long = 0, val eventId: String = "")
@Serializable data class PlaysResponse(val plays: List<PlayIn> = emptyList())
/** A song in one of Hive's playlists: a library song ([id]) or a streamed one ([key] with its details). */
@Serializable data class PcPlaylistSong(val kind: String, val id: String = "", val key: String = "", val title: String = "", val artist: String = "", val album: String = "", val duration: Long = 0, val cover: String = "")
@Serializable data class PcPlaylist(val id: String, val name: String, val source: String = "", val cover: String = "", val artworkUrl: String = "", val updatedAt: Double = 0.0, val songs: List<PcPlaylistSong> = emptyList())
@Serializable data class PlaylistsResponse(val playlists: List<PcPlaylist> = emptyList())

/** What Hive on the PC is playing. */
@Serializable data class RemoteState(
    val playing: Boolean = false,
    val id: String = "",
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val cover: String = "",
    val position: Long = 0,
    val duration: Long = 0,
    val volume: Double = 1.0,
)
@Serializable private data class RemoteCommand(val command: String, val positionMs: Long? = null, val volume: Double? = null)
@Serializable private data class PairRequest(val code: String, val deviceName: String)
@Serializable private data class DiscoveryReply(val hivelink: Int, val serverId: String, val name: String, val port: Int)

class HiveLinkException(message: String, val status: Int = 0) : IOException(message)

class HiveLinkClient(private val http: OkHttpClient = defaultHttp()) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** Asks every Hive on the local network to answer, for [timeoutMs]. */
    suspend fun discover(timeoutMs: Int = 1500): List<DiscoveredHive> = withContext(Dispatchers.IO) {
        val found = LinkedHashMap<String, DiscoveredHive>()
        // Plugged in by USB, Hive on the PC answers on this phone's own address (Hive sets up "adb reverse").
        serverAt(USB_HOST, DEFAULT_PORT)?.let { found[it] = DiscoveredHive(it, "Hive on your PC (USB)", USB_HOST, DEFAULT_PORT) }
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val payload = "$DISCOVERY_REQUEST 1".toByteArray()
            for (target in broadcastTargets()) {
                runCatching { socket.send(DatagramPacket(payload, payload.size, target, DISCOVERY_PORT)) }
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                    val reply = json.decodeFromString<DiscoveryReply>(String(packet.data, 0, packet.length))
                    found[reply.serverId] = DiscoveredHive(reply.serverId, reply.name, packet.address.hostAddress.orEmpty(), reply.port)
                } catch (_: SocketTimeoutException) {
                } catch (_: Exception) {
                }
            }
        }
        found.values.toList()
    }

    private fun broadcastTargets(): List<InetAddress> {
        val out = mutableListOf(InetAddress.getByName("255.255.255.255"))
        runCatching {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                nif.interfaceAddresses.mapNotNullTo(out) { it.broadcast }
            }
        }
        return out.distinct()
    }

    /** The id of the Hive answering at [host], or null when none does. */
    suspend fun serverAt(host: String, port: Int): String? = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url(base(host, port) + "/api/ping").build()).execute().use { res ->
                if (!res.isSuccessful) null
                else (Json.parseToJsonElement(res.body.string()) as? kotlinx.serialization.json.JsonObject)?.get("serverId")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
            }
        }.getOrNull()
    }

    suspend fun ping(host: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url(base(host, port) + "/api/ping").build()).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun pair(host: String, port: Int, code: String, deviceName: String): PairResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code.trim(), deviceName)).toRequestBody(jsonType)
        http.newCall(Request.Builder().url(base(host, port) + "/api/pair").post(body).build()).execute().use {
            json.decodeFromString(PairResponse.serializer(), read(it))
        }
    }

    suspend fun info(conn: Connection): InfoResponse = get(conn, "/api/info", InfoResponse.serializer())

    suspend fun library(conn: Connection): LibraryResponse = get(conn, "/api/library", LibraryResponse.serializer())

    /** The library as sent, with its ETag, or null when it hasn't changed since [etag]. */
    suspend fun libraryIfChanged(conn: Connection, etag: String?): Pair<String, LibraryResponse>? = withContext(Dispatchers.IO) {
        val request = authed(conn, "/api/library").apply { if (etag != null) header("If-None-Match", etag) }.build()
        http.newCall(request).execute().use { res ->
            if (res.code == 304) return@use null
            val text = read(res)
            (res.header("ETag").orEmpty()) to json.decodeFromString(LibraryResponse.serializer(), text)
        }
    }

    suspend fun loveChanges(conn: Connection, since: Long): ChangesResponse =
        get(conn, "/api/love/changes?since=$since", ChangesResponse.serializer())

    suspend fun sendLove(conn: Connection, changes: List<LoveChange>): LoveResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(LoveRequest.serializer(), LoveRequest(changes)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/love").post(body).build()).execute().use {
            json.decodeFromString(LoveResponse.serializer(), read(it))
        }
    }

    suspend fun sendPlays(conn: Connection, plays: List<PlayOut>): PlaysStaged = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PlaysRequest.serializer(), PlaysRequest(plays)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/plays").post(body).build()).execute().use { json.decodeFromString(PlaysStaged.serializer(), read(it)) }
    }

    suspend fun plays(conn: Connection, since: Long): List<PlayIn> = get(conn, "/api/plays?since=$since", PlaysResponse.serializer()).plays

    /** Spotify search through the PC's signed-in Spotify app: songs, albums and playlists. */
    suspend fun spotifySearch(conn: Connection, query: String): com.local.hive.mobile.stream.SpotifyAccount.Results = withContext(Dispatchers.IO) {
        val q = java.net.URLEncoder.encode(query.take(200), "UTF-8")
        // The PC may first have to start Spotify in the background.
        http.newBuilder().readTimeout(60, java.util.concurrent.TimeUnit.SECONDS).callTimeout(70, java.util.concurrent.TimeUnit.SECONDS).build()
            .newCall(authed(conn, "/api/spotify/search?q=$q").build()).execute().use { res ->
            val o = Json.parseToJsonElement(read(res)) as kotlinx.serialization.json.JsonObject
            fun list(key: String) = (o[key] as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { it as? kotlinx.serialization.json.JsonObject }
            fun kotlinx.serialization.json.JsonObject.s(key: String) = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()
            fun idOf(uri: String) = uri.substringAfterLast(':')
            val big = com.local.hive.mobile.stream.Spotify::largest
            com.local.hive.mobile.stream.SpotifyAccount.Results(
                playlists = list("playlists").map { com.local.hive.mobile.stream.SpCard("playlist", idOf(it.s("uri")), it.s("name"), it.s("subtitle"), big(it.s("image"))) },
                albums = list("albums").map { com.local.hive.mobile.stream.SpCard("album", idOf(it.s("uri")), it.s("name"), it.s("subtitle"), big(it.s("image"))) },
                songs = list("tracks").map { com.local.hive.mobile.stream.SpSong(idOf(it.s("uri")), it.s("title"), it.s("artist"), it.s("album"), it.s("duration").toLongOrNull() ?: 0, big(it.s("image")), "") },
            )
        }
    }

    /** One year's Wrap from Hive, as JSON (kept as is so the phone can show it offline). */
    suspend fun wrapJson(conn: Connection, year: Int): String = withContext(Dispatchers.IO) {
        http.newCall(authed(conn, "/api/wrap?year=$year").build()).execute().use { read(it) }
    }
    fun parseWrap(text: String): PcWrap = json.decodeFromString(PcWrap.serializer(), text)
    suspend fun wrapYears(conn: Connection): List<Int> = get(conn, "/api/wrap/years", WrapYears.serializer()).years

    suspend fun playlists(conn: Connection): List<PcPlaylist> = get(conn, "/api/playlists", PlaylistsResponse.serializer()).playlists

    suspend fun remoteState(conn: Connection): RemoteState = get(conn, "/api/remote", RemoteState.serializer())

    suspend fun remote(conn: Connection, command: String, positionMs: Long? = null, volume: Double? = null) = withContext(Dispatchers.IO) {
        val body = json.encodeToString(RemoteCommand.serializer(), RemoteCommand(command, positionMs, volume)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/remote").post(body).build()).execute().use { read(it) }
    }

    /** Streams a library song's file from the PC into [out]. */
    suspend fun downloadTrack(conn: Connection, id: String, out: java.io.OutputStream) = withContext(Dispatchers.IO) {
        val q = java.net.URLEncoder.encode(id, "UTF-8")
        transferHttp.newCall(authed(conn, "/api/stream/track?id=$q").build()).execute().use { res ->
            if (!res.isSuccessful) read(res)
            res.body.byteStream().use { it.copyTo(out, 1 shl 16) }
        }
    }

    /**
     * Sends a song file to Hive ([size] bytes from [open]), with its tags so
     * Hive can file it and check it doesn't already have it.
     */
    suspend fun uploadSong(conn: Connection, meta: Map<String, String>, ext: String, size: Long, open: () -> java.io.InputStream): SongUpload = withContext(Dispatchers.IO) {
        val query = (meta + ("ext" to ext)).entries.joinToString("&") { (k, v) -> "$k=" + java.net.URLEncoder.encode(v, "UTF-8") }
        val body = object : okhttp3.RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = size
            override fun writeTo(sink: okio.BufferedSink) { open().use { input -> sink.outputStream().let { input.copyTo(it, 1 shl 16); it.flush() } } }
        }
        transferHttp.newCall(authed(conn, "/api/songs?$query").put(body).build()).execute().use {
            json.decodeFromString(SongUpload.serializer(), read(it))
        }
    }

    // Song files take minutes on slow Wi-Fi; only a stalled connection should time out.
    private val transferHttp by lazy { http.newBuilder().readTimeout(2, TimeUnit.MINUTES).writeTimeout(2, TimeUnit.MINUTES).build() }

    suspend fun unpair(conn: Connection) = withContext(Dispatchers.IO) {
        runCatching { http.newCall(authed(conn, "/api/unpair").post(ByteArray(0).toRequestBody()).build()).execute().close() }
    }

    /** Live Love changes from the PC. Completes when the stream drops. */
    fun events(conn: Connection): Flow<LoveEvent> = callbackFlow {
        val streamHttp = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        val source = EventSources.createFactory(streamHttp).newEventSource(
            authed(conn, "/api/events").build(),
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (type == "love") runCatching { trySend(json.decodeFromString(LoveEvent.serializer(), data)) }
                }
                override fun onClosed(eventSource: EventSource) { close() }
                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    close(t ?: HiveLinkException("Event stream closed (${response?.code})", response?.code ?: 0))
                }
            },
        )
        awaitClose { source.cancel() }
    }

    private suspend fun <T> get(conn: Connection, path: String, serializer: kotlinx.serialization.KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            http.newCall(authed(conn, path).build()).execute().use { json.decodeFromString(serializer, read(it)) }
        }

    private fun authed(conn: Connection, path: String) =
        Request.Builder().url(base(conn.host, conn.port) + path).header("Authorization", "Bearer ${conn.token}")

    private fun read(response: Response): String {
        val text = response.body.string()
        if (!response.isSuccessful) {
            val message = runCatching { json.parseToJsonElement(text).let { (it as? kotlinx.serialization.json.JsonObject)?.get("error")?.toString()?.trim('"') } }.getOrNull()
            throw HiveLinkException(message ?: "Hive answered ${response.code}", response.code)
        }
        return text
    }

    private fun base(host: String, port: Int): String {
        val h = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        return "http://$h:$port"
    }

    data class Connection(val host: String, val port: Int, val token: String)

    companion object {
        const val DEFAULT_PORT = 47800
        /** Hive on the PC over a USB cable, through "adb reverse". */
        const val USB_HOST = "127.0.0.1"
        const val DISCOVERY_PORT = 47801
        const val DISCOVERY_REQUEST = "HIVELINK_DISCOVER"

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}
