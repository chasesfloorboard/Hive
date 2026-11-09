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

/** The proof a paired Hive gives for [nonce] (see HiveLinkClient.hello and hive-link.js /api/hello). */
/** The proof for the Hive's encrypted port and certificate (hive-link.js /api/hello, tlsProof). */
fun helloTlsProof(token: String, nonce: String, serverId: String, pin: String, port: Int): String {
    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    val key = hex(java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray()))
    val mac = javax.crypto.Mac.getInstance("HmacSHA256").apply { init(javax.crypto.spec.SecretKeySpec(key.toByteArray(), "HmacSHA256")) }
    return hex(mac.doFinal("hive-hello-tls\n$nonce\n$serverId\n$pin\n$port".toByteArray()))
}

fun helloProof(token: String, nonce: String, serverId: String): String {
    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    val key = hex(java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray()))
    val mac = javax.crypto.Mac.getInstance("HmacSHA256").apply { init(javax.crypto.spec.SecretKeySpec(key.toByteArray(), "HmacSHA256")) }
    return hex(mac.doFinal("hive-hello\n$nonce\n$serverId".toByteArray()))
}

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
    /** When the rating was set (0: before Hive kept that). */
    val ratedAt: Long = 0,
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
@Serializable private data class StreamLovesRequest(val changes: List<StreamLoveChange>)
/** Hive's streamed-song likes; [applied] false when this phone's changes wait for the user on the PC. */
@Serializable data class StreamLovesResponse(val loves: Map<String, StreamLove> = emptyMap(), val applied: Boolean = true)
@Serializable data class HiveAddress(val name: String = "", val address: String, val tailscale: Boolean = false)
@Serializable data class StreamCaps(val track: Boolean = false, val song: Boolean = false)
/** Phone changes waiting in Hive on the PC for the user to apply. */
@Serializable data class InboxSummary(val loves: Int = 0, val plays: Int = 0)
/** Song sync on the PC: whether Hive takes song files from the phone. */
@Serializable data class SongCaps(val receive: Boolean = false)
@Serializable data class AppUpdate(val versionCode: Long, val versionName: String, val size: Long, val sha256: String)
@Serializable data class InfoResponse(val serverId: String, val name: String, val port: Int, val seq: Long, val addresses: List<HiveAddress> = emptyList(), val streams: StreamCaps = StreamCaps(), val remote: Boolean = false, val plays: Boolean = false, val playsVersion: Int = 0, val inbox: InboxSummary = InboxSummary(), val songs: SongCaps = SongCaps(), val wrap: Boolean = false, val listening: Boolean = false, val files: Boolean = false, val fileTags: Boolean = false, val themes: Boolean = false, val playlistSync: Boolean = false, val ratings: Boolean = false, val phoneKeys: Boolean = false, val trackStats: Boolean = false, val coverKey: String = "")
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
/** [album] by [artist]: the genre's most listened album that year, for its picture. */
@Serializable data class PcWrapGenre(val name: String, val seconds: Double = 0.0, val album: String = "", val artist: String = "", val cover: String? = null)
@Serializable data class PcWrapDay(val date: String, val seconds: Double = 0.0)
@Serializable data class PcWrapMonth(val month: String, val seconds: Double = 0.0)
@Serializable data class WrapYears(val years: List<Int> = emptyList())

/** Hive's answer to a song sent from the phone: "saved", or "exists" (it already had it). */
@Serializable data class SongUpload(val status: String, val id: String = "")
/** A play, as sent to Hive ([clientId] is this phone's own id for it) or fetched from it. */
@Serializable data class PlayOut(val clientId: String, val id: String, val playedAt: Long, val listenedMs: Long)
/** A file in Hive's library folder (the file mirror): path relative to the folder, size, modified (ms). */
@Serializable data class RemoteFile(val p: String, val s: Long, val m: Long)
/** [unreadable]: folders or files the PC couldn't read this time; what's under them is unknown, not deleted. */
@Serializable data class FilesResponse(val files: List<RemoteFile> = emptyList(), val unreadable: List<String> = emptyList())
@Serializable data class FileSaved(val status: String = "", val s: Long = 0, val m: Long = 0)
@Serializable data class DeleteFiles(val p: List<String>)
/** A file's state for the tag sync: [sig] the audio's signature (null: Hive can't look inside, copy it whole). */
@Serializable data class FileTagState(val p: String, val s: Long = 0, val m: Long = 0, val sig: String? = null)
@Serializable data class FileTagStates(val files: List<FileTagState> = emptyList())
/** Everything in one of Hive's files but its audio: [head] before it, [tail] after; the whole file is [size] bytes with this [sha256]. */
class TagBytes(val head: ByteArray, val tail: ByteArray, val size: Long, val sha256: String, val modified: Long)
@Serializable data class DeletedFiles(val deleted: List<String> = emptyList())
@Serializable data class PlaysRequest(val plays: List<PlayOut>)
/** Hive's answer to phone plays: [counted] at once, or [staged] for review; [unknown] songs it doesn't have (by clientId). */
@Serializable data class PlaysStaged(val staged: Int = 0, val counted: Int = 0, val unknown: List<String> = emptyList())
@Serializable data class PlayIn(val id: String, val playedAt: Long, val listenedMs: Long = 0, val eventId: String = "")
@Serializable data class PlaysResponse(val plays: List<PlayIn> = emptyList())
/** A song in one of Hive's playlists: a library song ([id]) or a streamed one ([key] with its details). */
@Serializable data class PcPlaylistSong(val kind: String, val id: String = "", val key: String = "", val title: String = "", val artist: String = "", val album: String = "", val duration: Long = 0, val cover: String = "")
@Serializable data class PcPlaylist(val id: String, val name: String, val source: String = "", val cover: String = "", val artworkUrl: String = "", val updatedAt: Double = 0.0, val songs: List<PcPlaylistSong> = emptyList())
@Serializable data class PlaylistsResponse(val playlists: List<PcPlaylist> = emptyList())
/** A phone playlist as Hive keeps it: [id] is Hive's, blank for a new one. */
@Serializable data class PlaylistOut(val id: String, val name: String, val updatedAt: Long, val songs: List<PcPlaylistSong>)
@Serializable data class PlaylistSaved(val id: String, val updatedAt: Double = 0.0)
@Serializable data class PlaylistDeleted(val deleted: Boolean = false)

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
@Serializable private data class PairRequest(val code: String, val deviceName: String, val phoneKey: String = "")
@Serializable private data class ConnectRequest(val deviceName: String, val phoneKey: String = "")
@Serializable private data class PhoneKey(val phoneKey: String)
@Serializable private data class DeleteSongs(val ids: List<String>)
/** A song's rating (and when it was set, on Hive's clock or the phone's that sent it) and play count, from Hive. */
@Serializable data class TrackStat(val id: String, val rating: Double = 0.0, val ratedAt: Long = 0, val playCount: Int = 0)
@Serializable data class TrackStats(val now: Long = 0, val tracks: List<TrackStat> = emptyList())
@Serializable data class RatingOut(val id: String, val stars: Float, val at: Long)
@Serializable private data class RatingsOut(val changes: List<RatingOut>)
@Serializable private data class RatingResult(val id: String = "", val status: String = "")
@Serializable private data class RatingsIn(val results: List<RatingResult> = emptyList())
@Serializable data class SongTagEdit(val id: String, val tags: Map<String, String>)
@Serializable private data class SongTagEdits(val edits: List<SongTagEdit>)
@Serializable private data class EditedSongs(val edited: List<String> = emptyList())
@Serializable private data class DeletedSongs(val deleted: List<String> = emptyList(), val failed: Int = 0)
@Serializable data class ConnectTicket(val requestId: String, val secret: String)
@Serializable data class ConnectAnswer(val status: String = "", val token: String = "", val deviceId: String = "", val serverId: String = "", val name: String = "", val seq: Long = 0, val error: String? = null)
/** A theme from Hive's themes folder (stock, MusicBee skins, saved). */
@Serializable data class PcTheme(val name: String, val css: String, val stock: Boolean = false)
@Serializable data class ThemesResponse(val themes: List<PcTheme> = emptyList(), val current: PcTheme? = null)
@Serializable private data class DiscoveryReply(val hivelink: Int, val serverId: String, val name: String, val port: Int)

class HiveLinkException(message: String, val status: Int = 0) : IOException(message)

@kotlinx.serialization.Serializable
data class PhoneBackupInfo(val device: String, val deviceName: String = "", val savedAt: Long = 0, val versionName: String = "", val size: Long = 0)

@kotlinx.serialization.Serializable
data class PhoneBackupList(val backups: List<PhoneBackupInfo> = emptyList())

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

    enum class Hello { PROVED, OLD_HIVE, NOT_IT, UNPAIRED }
    /** [tlsPin]/[tlsPort]: the Hive's own certificate and encrypted port, when it proved those too. */
    data class HelloResult(val kind: Hello, val tlsPin: String? = null, val tlsPort: Int = 0)

    /**
     * Whether the Hive at [host] is the one this phone paired with, before the token goes anywhere: it
     * signs a random challenge with the pairing (the hash of the token, known only to the two), so a
     * device that only claims the Hive's id can't pass. A Hive from before this check answers 401.
     */
    suspend fun hello(host: String, port: Int, pairing: Pairing): HelloResult = withContext(Dispatchers.IO) {
        runCatching {
            val nonce = ByteArray(24).also { java.security.SecureRandom().nextBytes(it) }
                .let { android.util.Base64.encodeToString(it, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP) }
            val url = base(host, port) + "/api/hello?device=" + java.net.URLEncoder.encode(pairing.deviceId, "UTF-8") + "&nonce=" + nonce
            http.newCall(Request.Builder().url(url).build()).execute().use { res ->
                when (res.code) {
                    401 -> HelloResult(Hello.OLD_HIVE)
                    // The paired Hive no longer knows this phone (unpaired there, or replaced by a re-pair).
                    410 -> {
                        val o = Json.parseToJsonElement(res.body.string()) as? kotlinx.serialization.json.JsonObject
                        HelloResult(if ((o?.get("serverId") as? kotlinx.serialization.json.JsonPrimitive)?.content == pairing.serverId) Hello.UNPAIRED else Hello.NOT_IT)
                    }
                    200 -> {
                        val o = Json.parseToJsonElement(res.body.string()) as? kotlinx.serialization.json.JsonObject
                        fun str(k: String) = (o?.get(k) as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()
                        if (str("serverId") != pairing.serverId) return@use HelloResult(Hello.NOT_IT)
                        val expected = helloProof(pairing.token, nonce, pairing.serverId)
                        if (!java.security.MessageDigest.isEqual(expected.toByteArray(), str("proof").toByteArray())) return@use HelloResult(Hello.NOT_IT)
                        // The encrypted port and certificate, signed with the pairing: taken only if the signature holds.
                        val tls = o?.get("tls") as? kotlinx.serialization.json.JsonObject
                        val pin = (tls?.get("pin") as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()
                        val tlsPort = (tls?.get("port") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
                        val tlsOk = pin.matches(Regex("[0-9a-f]{64}")) && tlsPort in 1..65535 &&
                            java.security.MessageDigest.isEqual(helloTlsProof(pairing.token, nonce, pairing.serverId, pin, tlsPort).toByteArray(), str("tlsProof").toByteArray())
                        if (tlsOk) HelloResult(Hello.PROVED, pin, tlsPort) else HelloResult(Hello.PROVED)
                    }
                    else -> HelloResult(Hello.NOT_IT)
                }
            }
        }.getOrDefault(HelloResult(Hello.NOT_IT))
    }

    suspend fun ping(host: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url(base(host, port) + "/api/ping").build()).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    /** Can a TCP connection be opened to [host]:[port]? (Used to confirm the encrypted port is really there.) */
    suspend fun reachable(host: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        runCatching { java.net.Socket().use { it.connect(java.net.InetSocketAddress(host, port), 1500); true } }.getOrDefault(false)
    }

    suspend fun pair(host: String, port: Int, code: String, deviceName: String, phoneKey: String = ""): PairResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(code.trim(), deviceName, phoneKey)).toRequestBody(jsonType)
        http.newCall(Request.Builder().url(base(host, port) + "/api/pair").post(body).build()).execute().use {
            json.decodeFromString(PairResponse.serializer(), read(it))
        }
    }

    /** Asks Hive to let this phone connect without a code; the person at the PC answers. */
    suspend fun requestConnect(host: String, port: Int, deviceName: String, phoneKey: String = ""): ConnectTicket = withContext(Dispatchers.IO) {
        val body = json.encodeToString(ConnectRequest.serializer(), ConnectRequest(deviceName, phoneKey)).toRequestBody(jsonType)
        http.newCall(Request.Builder().url(base(host, port) + "/api/pair/request").post(body).build()).execute().use {
            json.decodeFromString(ConnectTicket.serializer(), read(it))
        }
    }

    /** "pending", "allowed" (with the pairing), or "refused"/"expired". */
    suspend fun connectAnswer(host: String, port: Int, ticket: ConnectTicket): ConnectAnswer = withContext(Dispatchers.IO) {
        val url = base(host, port) + "/api/pair/request?id=${java.net.URLEncoder.encode(ticket.requestId, "UTF-8")}&secret=${java.net.URLEncoder.encode(ticket.secret, "UTF-8")}"
        http.newCall(Request.Builder().url(url).build()).execute().use { res ->
            val text = res.body.string()
            runCatching { json.decodeFromString(ConnectAnswer.serializer(), text) }.getOrNull()?.let { if (res.code == 404) it.copy(status = "expired") else it }
                ?: ConnectAnswer(status = "expired")
        }
    }

    /** Hive's themes, and the one it shows now. */
    suspend fun themes(conn: Connection): ThemesResponse = get(conn, "/api/themes", ThemesResponse.serializer())

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

    /** Hive's streamed-song likes, after sending this phone's [changes] (fetched only when there are none). */
    suspend fun streamLoves(conn: Connection, changes: List<StreamLoveChange>): StreamLovesResponse = withContext(Dispatchers.IO) {
        val request = if (changes.isEmpty()) authed(conn, "/api/streamloves")
            else authed(conn, "/api/streamloves").post(json.encodeToString(StreamLovesRequest.serializer(), StreamLovesRequest(changes)).toRequestBody(jsonType))
        http.newCall(request.build()).execute().use { json.decodeFromString(StreamLovesResponse.serializer(), read(it)) }
    }

    suspend fun sendPlays(conn: Connection, plays: List<PlayOut>): PlaysStaged = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PlaysRequest.serializer(), PlaysRequest(plays)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/plays").post(body).build()).execute().use { json.decodeFromString(PlaysStaged.serializer(), read(it)) }
    }

    /** Songs whose rating or play count changed in Hive after [since] (Hive's clock). */
    suspend fun trackStats(conn: Connection, since: Long): TrackStats = get(conn, "/api/track-stats?since=$since", TrackStats.serializer())

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
    /**
     * Hive's listening history file exactly as Hive saves it, with its version;
     * null when the phone's copy ([have]) is still that version.
     */
    suspend fun listening(conn: Connection, have: String?): Pair<String, ByteArray>? = withContext(Dispatchers.IO) {
        val query = have?.let { "?have=" + java.net.URLEncoder.encode(it, "UTF-8") }.orEmpty()
        http.newBuilder().readTimeout(60, java.util.concurrent.TimeUnit.SECONDS).build()
            .newCall(authed(conn, "/api/listening$query").build()).execute().use { res ->
                if (res.code == 304) return@use null
                if (!res.isSuccessful) read(res)
                res.header("X-Hive-Version").orEmpty() to res.body.bytes()
            }
    }

    suspend fun wrapYears(conn: Connection): List<Int> = get(conn, "/api/wrap/years", WrapYears.serializer()).years

    suspend fun playlists(conn: Connection): List<PcPlaylist> = get(conn, "/api/playlists", PlaylistsResponse.serializer()).playlists

    /** Makes or changes one of Hive's playlists to match the phone's (trusted phones, see [InfoResponse.playlistSync]). */
    suspend fun savePlaylist(conn: Connection, playlist: PlaylistOut): PlaylistSaved = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PlaylistOut.serializer(), playlist).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/playlist").put(body).build()).execute().use { json.decodeFromString(PlaylistSaved.serializer(), read(it)) }
    }

    /** Deletes one of Hive's playlists (it's kept aside on the PC). */
    suspend fun deletePlaylist(conn: Connection, id: String): Boolean = withContext(Dispatchers.IO) {
        http.newCall(authed(conn, "/api/playlist?id=${android.net.Uri.encode(id)}").delete().build()).execute().use { json.decodeFromString(PlaylistDeleted.serializer(), read(it)).deleted }
    }

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
    /** Songs deleted on the phone that the user chose to delete on the PC too: to the Trash there. Returns the ids deleted. */
    suspend fun deleteSongs(conn: Connection, ids: List<String>): List<String> = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DeleteSongs.serializer(), DeleteSongs(ids)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/songs/delete").post(body).build()).execute().use { json.decodeFromString(DeletedSongs.serializer(), read(it)).deleted }
    }

    /** Gives Hive this phone's key (see LinkStore.phoneKey). */
    suspend fun sendPhoneKey(conn: Connection, phoneKey: String) = withContext(Dispatchers.IO) {
        val body = json.encodeToString(PhoneKey.serializer(), PhoneKey(phoneKey)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/phone-key").post(body).build()).execute().use { read(it) }
    }

    /** Star ratings made on the phone (0 takes one off). Each answer: applied, unchanged, not-found, waiting (not trusted yet) or failed. */
    suspend fun sendRatings(conn: Connection, changes: List<RatingOut>): Map<String, String> = withContext(Dispatchers.IO) {
        val body = json.encodeToString(RatingsOut.serializer(), RatingsOut(changes)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/ratings").post(body).build()).execute().use { r -> json.decodeFromString(RatingsIn.serializer(), read(r)).results.associate { it.id to it.status } }
    }

    /** Tags edited on the phone, written into Hive's own files (trusted phones only). Returns the ids edited. */
    suspend fun editTags(conn: Connection, edits: List<SongTagEdit>): List<String> = withContext(Dispatchers.IO) {
        val body = json.encodeToString(SongTagEdits.serializer(), SongTagEdits(edits)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/songs/tags").post(body).build()).execute().use { json.decodeFromString(EditedSongs.serializer(), read(it)).edited }
    }

    /** A cover chosen on the phone, written as the front cover of those songs in Hive (trusted phones only). */
    suspend fun sendCover(conn: Connection, ids: List<String>, image: ByteArray): List<String> = withContext(Dispatchers.IO) {
        val query = java.net.URLEncoder.encode(ids.joinToString(","), "UTF-8")
        transferHttp.newCall(authed(conn, "/api/songs/cover?ids=$query").put(image.toRequestBody("application/octet-stream".toMediaType())).build()).execute().use {
            json.decodeFromString(EditedSongs.serializer(), read(it)).edited
        }
    }

    /** A back cover for these songs: [place] among their back covers (from 0; past the last adds one), or null to take it off. */
    suspend fun sendBackCover(conn: Connection, ids: List<String>, place: Int, image: ByteArray?): List<String> = withContext(Dispatchers.IO) {
        val query = java.net.URLEncoder.encode(ids.joinToString(","), "UTF-8")
        val path = "/api/songs/back-cover?ids=$query&place=$place"
        val request = if (image == null) authed(conn, path).delete() else authed(conn, path).put(image.toRequestBody("application/octet-stream".toMediaType()))
        transferHttp.newCall(request.build()).execute().use {
            json.decodeFromString(EditedSongs.serializer(), read(it)).edited
        }
    }

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

    // ---- the file mirror: the phone's music folder one to one with Hive's library folder ----

    /** Every file in Hive's library folder. */
    suspend fun files(conn: Connection): FilesResponse =
        withContext(Dispatchers.IO) { transferHttp.newCall(authed(conn, "/api/files").build()).execute().use { json.decodeFromString(FilesResponse.serializer(), read(it)) } }

    /** Writes one of Hive's files to [out]; returns its modified time on the PC. */
    suspend fun downloadFile(conn: Connection, rel: String, out: java.io.OutputStream): Long = withContext(Dispatchers.IO) {
        val call = transferHttp.newCall(authed(conn, "/api/files/get?p=" + java.net.URLEncoder.encode(rel, "UTF-8")).build())
        // A copy that stops arriving (the PC gone mid-copy, a connection that died without saying so) is ended
        // after STALL_MS with no data, so its half file is removed at once rather than waiting on the socket.
        val lastData = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())
        val watchdog = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
        watchdog.scheduleWithFixedDelay({ if (System.currentTimeMillis() - lastData.get() > STALL_MS) call.cancel() }, 2, 2, TimeUnit.SECONDS)
        try {
            call.execute().use { res ->
                if (!res.isSuccessful) read(res)
                res.body.byteStream().use { input ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        lastData.set(System.currentTimeMillis())
                    }
                }
                res.header("X-Mtime")?.toLongOrNull() ?: 0L
            }
        } catch (e: java.io.IOException) {
            android.util.Log.w("HiveSongSync", "copy of $rel stopped: ${e.message}")
            throw if (call.isCanceled()) java.io.IOException("The copy of $rel stalled and was stopped.") else e
        } finally { watchdog.shutdownNow() }
    }

    /** Sends a file to Hive at [rel] (Hive keeps any file already there); [keep]: only keep it aside there. */
    suspend fun uploadFile(conn: Connection, rel: String, modified: Long, size: Long, keep: Boolean = false, open: () -> java.io.InputStream): FileSaved = withContext(Dispatchers.IO) {
        val body = object : okhttp3.RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = size
            override fun writeTo(sink: okio.BufferedSink) { open().use { input -> sink.outputStream().let { input.copyTo(it, 1 shl 16); it.flush() } } }
        }
        val q = java.net.URLEncoder.encode(rel, "UTF-8")
        val request = if (keep) authed(conn, "/api/files/keep?p=$q").post(body) else authed(conn, "/api/files?p=$q&m=$modified").put(body)
        transferHttp.newCall(request.build()).execute().use { json.decodeFromString(FileSaved.serializer(), read(it)) }
    }

    /** Sends a copy of Hive Mobile as it is (see AppSnapshot) to keep on the PC. */
    suspend fun sendPhoneBackup(conn: Connection, file: java.io.File, savedAt: Long, versionName: String) = withContext(Dispatchers.IO) {
        val body = object : okhttp3.RequestBody() {
            override fun contentType() = "application/zip".toMediaType()
            override fun contentLength() = file.length()
            override fun writeTo(sink: okio.BufferedSink) { file.inputStream().use { input -> sink.outputStream().let { input.copyTo(it, 1 shl 16); it.flush() } } }
        }
        transferHttp.newCall(authed(conn, "/api/phone-backup").header("X-Saved-At", savedAt.toString()).header("X-Version-Name", versionName).put(body).build()).execute().use { read(it) }
    }

    /** The copies of Hive Mobile the PC keeps, newest first; none from a Hive that keeps none. */
    suspend fun phoneBackups(conn: Connection): List<PhoneBackupInfo> =
        runCatching { get(conn, "/api/phone-backups", PhoneBackupList.serializer()).backups }.getOrElse { if (it is HiveLinkException && it.status == 404) emptyList() else throw it }

    suspend fun downloadPhoneBackup(conn: Connection, device: String, out: java.io.OutputStream) = withContext(Dispatchers.IO) {
        transferHttp.newCall(authed(conn, "/api/phone-backup?device=" + java.net.URLEncoder.encode(device, "UTF-8")).build()).execute().use { res ->
            if (!res.isSuccessful) read(res)
            res.body.byteStream().use { it.copyTo(out, 1 shl 16) }
        }
    }

    // ---- tags without the song: a file whose audio is the same on both sides is made the same file ----

    /** Hive's state of these files (missing ones left out), for the tag sync. */
    suspend fun fileTagStates(conn: Connection, rels: List<String>): List<FileTagState> = withContext(Dispatchers.IO) {
        rels.chunked(200).flatMap { part ->
            val body = json.encodeToString(DeleteFiles.serializer(), DeleteFiles(part)).toRequestBody(jsonType)
            http.newCall(authed(conn, "/api/files/info").post(body).build()).execute().use { json.decodeFromString(FileTagStates.serializer(), read(it)).files }
        }
    }

    /** One of Hive's files without its audio (every tag and picture), to rebuild the phone's copy around its own audio. */
    suspend fun downloadTags(conn: Connection, rel: String): TagBytes = withContext(Dispatchers.IO) {
        transferHttp.newCall(authed(conn, "/api/files/tags?p=" + java.net.URLEncoder.encode(rel, "UTF-8")).build()).execute().use { res ->
            if (!res.isSuccessful) read(res)
            val bytes = res.body.bytes()
            val head = res.header("X-Head")?.toIntOrNull()?.takeIf { it in 0..bytes.size } ?: throw IOException("Hive's answer had no tag lengths")
            TagBytes(bytes.copyOfRange(0, head), bytes.copyOfRange(head, bytes.size), res.header("X-Size")?.toLongOrNull() ?: -1,
                res.header("X-Sha256").orEmpty().lowercase(), res.header("X-Mtime")?.toLongOrNull() ?: 0)
        }
    }

    /** The phone's file without its audio, for Hive to rebuild its copy around its own audio; a 409 means the audio differs. */
    suspend fun uploadTags(conn: Connection, rel: String, head: ByteArray, tail: ByteArray, size: Long, sha256: String, modified: Long, keep: Boolean = false): FileSaved = withContext(Dispatchers.IO) {
        val q = "p=" + java.net.URLEncoder.encode(rel, "UTF-8") + "&head=${head.size}&size=$size&h=$sha256&m=$modified" + if (keep) "&keep=1" else ""
        val body = (head + tail).toRequestBody("application/octet-stream".toMediaType())
        transferHttp.newCall(authed(conn, "/api/files/tags?$q").put(body).build()).execute().use { json.decodeFromString(FileSaved.serializer(), read(it)) }
    }

    /** Files deleted on the phone: Hive moves them into its Deleted songs. Returns the ones it moved. */
    suspend fun deleteFiles(conn: Connection, rels: List<String>): List<String> = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DeleteFiles.serializer(), DeleteFiles(rels)).toRequestBody(jsonType)
        http.newCall(authed(conn, "/api/files/delete").post(body).build()).execute().use { json.decodeFromString(DeletedFiles.serializer(), read(it)).deleted }
    }

    // Song files take minutes on slow Wi-Fi; only a stalled connection should time out.
    // 30 s without a byte is a dead connection (Hive on the PC closed, the network gone): the copy
    // stops and its half file is deleted, rather than hanging on for minutes.
    private val transferHttp by lazy { http.newBuilder().readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).build() }

    suspend fun unpair(conn: Connection) = withContext(Dispatchers.IO) {
        runCatching { http.newCall(authed(conn, "/api/unpair").post(ByteArray(0).toRequestBody()).build()).execute().close() }
    }

    /** Live Love changes from the PC. Completes when the stream drops. */
    fun events(conn: Connection, onStreamLoves: () -> Unit = {}): Flow<LoveEvent> = callbackFlow {
        val streamHttp = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        val source = EventSources.createFactory(streamHttp).newEventSource(
            authed(conn, "/api/events").build(),
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (type == "love") runCatching { trySend(json.decodeFromString(LoveEvent.serializer(), data)) }
                    if (type == "streamloves") onStreamLoves()
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

    /** A request carrying the token: on the Hive's encrypted port whenever it has one (see Connection.tlsPort). */
    private fun authed(conn: Connection, path: String) =
        Request.Builder().url((if (conn.tlsPort > 0) base(conn.host, conn.tlsPort, tls = true) else base(conn.host, conn.port)) + path).header("Authorization", "Bearer ${conn.token}")

    private fun read(response: Response): String {
        val text = response.body.string()
        if (!response.isSuccessful) {
            val message = runCatching { json.parseToJsonElement(text).let { (it as? kotlinx.serialization.json.JsonObject)?.get("error")?.toString()?.trim('"') } }.getOrNull()
            throw HiveLinkException(message ?: "Hive answered ${response.code}", response.code)
        }
        return text
    }

    private fun base(host: String, port: Int, tls: Boolean = false): String {
        val h = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        return "${if (tls) "https" else "http"}://$h:$port"
    }

    /** The newest Hive Mobile on the PC, or null when it has none for this phone. */
    suspend fun appUpdate(conn: Connection): AppUpdate? = withContext(Dispatchers.IO) {
        http.newCall(authed(conn, "/api/app").build()).execute().use { res ->
            if (res.code == 404) null else json.decodeFromString(AppUpdate.serializer(), read(res))
        }
    }

    /** Fetches that APK into [out]. */
    suspend fun downloadApp(conn: Connection, out: java.io.OutputStream) = withContext(Dispatchers.IO) {
        transferHttp.newCall(authed(conn, "/api/app/apk").build()).execute().use { res ->
            if (!res.isSuccessful) read(res)
            res.body.byteStream().use { it.copyTo(out, 1 shl 16) }
        }
    }

    /** [tlsPort] > 0: the Hive's encrypted port, its certificate pinned (see pinnedCerts); every authenticated call goes there. */
    data class Connection(val host: String, val port: Int, val token: String, val tlsPort: Int = 0)

    companion object {
        const val DEFAULT_PORT = 47800
        /** A file copy with no data for this long is stopped (see downloadFile). */
        const val STALL_MS = 20_000L
        /** Hive on the PC over a USB cable, through "adb reverse". */
        const val USB_HOST = "127.0.0.1"
        const val DISCOVERY_PORT = 47801
        const val DISCOVERY_REQUEST = "HIVELINK_DISCOVER"

        /**
         * SHA-256 (hex) of the paired Hive's certificate, learned through hello (signed with the pairing): the
         * only certificate Hive Link's encrypted connections accept. A self-signed certificate checked this way
         * needs no certificate authority; anything else, even a valid public certificate, is refused.
         */
        @Volatile var pinnedCerts: Set<String> = emptySet()
        private val pinningTrust = object : javax.net.ssl.X509TrustManager {
            override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) = throw java.security.cert.CertificateException("No client certificates here")
            override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw java.security.cert.CertificateException("No certificate")
                val fp = java.security.MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
                if (fp !in pinnedCerts) throw java.security.cert.CertificateException("Not the paired Hive's certificate")
            }
            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
        }
        private val pinningSsl by lazy { javax.net.ssl.SSLContext.getInstance("TLS").apply { init(null, arrayOf(pinningTrust), java.security.SecureRandom()) } }

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            // Hive Link's own clients talk to Hive only: by address (no names to check), its pinned certificate.
            .sslSocketFactory(pinningSsl.socketFactory, pinningTrust)
            .hostnameVerifier { _, _ -> true }
            .build()
    }
}
