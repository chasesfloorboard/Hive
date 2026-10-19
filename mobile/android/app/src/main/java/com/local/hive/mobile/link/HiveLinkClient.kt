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
@Serializable data class InfoResponse(val serverId: String, val name: String, val port: Int, val seq: Long, val addresses: List<HiveAddress> = emptyList(), val streams: StreamCaps = StreamCaps())
@Serializable private data class PairRequest(val code: String, val deviceName: String)
@Serializable private data class DiscoveryReply(val hivelink: Int, val serverId: String, val name: String, val port: Int)

class HiveLinkException(message: String, val status: Int = 0) : IOException(message)

class HiveLinkClient(private val http: OkHttpClient = defaultHttp()) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** Asks every Hive on the local network to answer, for [timeoutMs]. */
    suspend fun discover(timeoutMs: Int = 1500): List<DiscoveredHive> = withContext(Dispatchers.IO) {
        val found = LinkedHashMap<String, DiscoveredHive>()
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
        const val DISCOVERY_PORT = 47801
        const val DISCOVERY_REQUEST = "HIVELINK_DISCOVER"

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}
