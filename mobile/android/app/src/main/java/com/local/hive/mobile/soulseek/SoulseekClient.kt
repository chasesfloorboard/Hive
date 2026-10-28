package com.local.hive.mobile.soulseek

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Closeable
import java.io.File
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * A download-only Soulseek client: logs in, searches, and fetches files from
 * peers. It shares nothing (it tells the server so) and turns down anyone
 * asking it for files.
 *
 * Peers reach a phone in two ways: directly on its listening port when the
 * network lets them, or (on most networks) by asking the server to have Hive
 * connect out to them, answered with a PierceFirewall. Downloads follow the
 * protocol of today's clients: QueueUpload to the peer, the peer's
 * TransferRequest when its slot frees up, Hive's TransferResponse, then a
 * file connection on which the peer sends the token, Hive the offset, and the
 * peer the bytes.
 */
class SoulseekClient(
    private val username: String,
    private val password: String,
    private val serverHost: String = "server.slsknet.org",
    private val serverPort: Int = 2242,
    private val listenPorts: IntRange = 2234..2244,
    private val log: (String) -> Unit = {},
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var server: Socket? = null
    private var serverOut: OutputStream? = null
    private var listener: ServerSocket? = null
    private val tokens = AtomicLong((System.nanoTime() and 0x3fffffff) + 1)

    private val searches = ConcurrentHashMap<Long, (SearchResult) -> Unit>()
    private val addresses = ConcurrentHashMap<String, CompletableDeferred<Pair<String, Int>>>()
    private val indirect = ConcurrentHashMap<Long, CompletableDeferred<Socket>>()
    private val peers = ConcurrentHashMap<String, Peer>()
    private val queued = ConcurrentHashMap<Pair<String, String>, Transfer>()
    private val byToken = ConcurrentHashMap<Long, Transfer>()

    /** Set when the server closes the session, e.g. "logged in somewhere else". */
    @Volatile var ended: String? = null
        private set

    private fun token() = tokens.incrementAndGet() and 0xffffffffL

    // ---- server ----

    /** Logs in and announces Hive (sharing nothing). Returns the server's greeting. */
    suspend fun login(): String = withContext(Dispatchers.IO) {
        val s = Socket()
        s.keepAlive = true
        s.connect(InetSocketAddress(serverHost, serverPort), 15_000)
        s.soTimeout = 30_000
        server = s
        val out = s.getOutputStream()
        serverOut = out
        Frame.write(out, Messages.login(username, password))
        val input = s.getInputStream()
        var greeting: String? = null
        while (greeting == null) {
            val body = Frame.read(input) ?: throw SoulseekException("The Soulseek server closed the connection")
            val r = In(body)
            if (r.u32().toInt() != Code.LOGIN) continue
            if (!r.bool()) {
                val reason = r.str()
                throw SoulseekException(when (reason) {
                    "INVALIDPASS" -> "Wrong Soulseek password"
                    "INVALIDUSERNAME" -> "That Soulseek username isn't allowed"
                    "SVRFULL" -> "The Soulseek server is full; try again later"
                    else -> "Soulseek refused the login ($reason)"
                })
            }
            greeting = r.str()
        }
        s.soTimeout = 0
        val port = listen()
        Frame.write(out, Messages.setWaitPort(port))
        Frame.write(out, Messages.setStatusOnline())
        Frame.write(out, Messages.sharedFoldersFiles(0, 0))
        Frame.write(out, Messages.haveNoParent())
        scope.launch { readServer(s) }
        log("Logged in to Soulseek as $username (listening on $port)")
        greeting
    }

    private fun sendServer(bytes: ByteArray) {
        val out = serverOut ?: throw SoulseekException("Not logged in to Soulseek")
        Frame.write(out, bytes)
    }

    private fun readServer(s: Socket) {
        try {
            val input = s.getInputStream()
            while (true) {
                val body = Frame.read(input) ?: break
                val r = In(body)
                when (r.u32().toInt()) {
                    Code.GET_PEER_ADDRESS -> {
                        val user = r.str(); val ip = r.ip(); val port = r.u32().toInt()
                        addresses.remove(user)?.complete(ip to port)
                    }
                    Code.CONNECT_TO_PEER -> {
                        val user = r.str(); val type = r.str(); val ip = r.ip(); val port = r.u32().toInt(); val token = r.u32()
                        scope.launch { connectBack(user, type, ip, port, token) }
                    }
                    Code.CANT_CONNECT_TO_PEER -> indirect.remove(r.u32())?.completeExceptionally(SoulseekException("Peer can't connect"))
                    Code.RELOGGED -> { ended = "Logged in to Soulseek somewhere else (Seeker?)"; break }
                }
            }
        } catch (_: Throwable) {
        }
        if (ended == null) ended = "Lost the connection to the Soulseek server"
        log(ended!!)
    }

    // ---- connections ----

    private fun listen(): Int {
        for (port in listenPorts) {
            val ss = runCatching { ServerSocket(port) }.getOrNull() ?: continue
            listener = ss
            scope.launch {
                while (!ss.isClosed) {
                    val sock = runCatching { ss.accept() }.getOrNull() ?: break
                    launch { accept(sock) }
                }
            }
            return ss.localPort
        }
        return 0
    }

    /** A connection a peer opened to us: a direct PeerInit, or the PierceFirewall answering our ConnectToPeer. */
    private fun accept(sock: Socket) {
        try {
            sock.soTimeout = 30_000
            val body = Frame.read(sock.getInputStream(), 4096) ?: return sock.close()
            val r = In(body)
            when (r.u8()) {
                Code.PIERCE_FIREWALL -> indirect.remove(r.u32())?.complete(sock) ?: sock.close()
                Code.PEER_INIT -> {
                    val user = r.str(); val type = r.str()
                    when (type) { "P" -> Peer(user, sock).start(); "F" -> receiveFile(sock); else -> sock.close() }
                }
                else -> sock.close()
            }
        } catch (_: Exception) { runCatching { sock.close() } }
    }

    /** The server asks us to connect to a peer who couldn't reach us. */
    private fun connectBack(user: String, type: String, ip: String, port: Int, token: Long) {
        if (type != "P" && type != "F") return
        val sock = Socket()
        try {
            sock.connect(InetSocketAddress(ip, port), 10_000)
            Frame.write(sock.getOutputStream(), Messages.pierceFirewall(token))
            if (type == "P") Peer(user, sock).start() else receiveFile(sock)
        } catch (_: Exception) {
            runCatching { sock.close() }
            runCatching { sendServer(Messages.cantConnectToPeer(token, user)) }
        }
    }

    /** A message connection to [user]: direct to their address, else through the server's indirect connection. */
    private suspend fun peer(user: String): Peer {
        peers[user]?.takeIf { it.alive }?.let { return it }
        val (ip, port) = withTimeout(15_000) {
            val wait = CompletableDeferred<Pair<String, Int>>().also { addresses[user] = it }
            sendServer(Messages.getPeerAddress(user))
            wait.await()
        }
        val direct = if (port > 0 && ip != "0.0.0.0") withContext(Dispatchers.IO) {
            runCatching {
                Socket().apply { connect(InetSocketAddress(ip, port), 8_000) }.also { Frame.write(it.getOutputStream(), Messages.peerInit(username, "P")) }
            }.getOrNull()
        } else null
        val sock = direct ?: run {
            val token = token()
            val wait = CompletableDeferred<Socket>().also { indirect[token] = it }
            sendServer(Messages.connectToPeer(token, user, "P"))
            withTimeoutOrNull(20_000) { wait.await() }.also { indirect.remove(token) }
                ?: throw SoulseekException("Couldn't connect to $user")
        }
        return Peer(user, sock).also { it.start() }
    }

    private inner class Peer(val user: String, val sock: Socket) {
        private val out = sock.getOutputStream()
        @Volatile var alive = true

        fun start() {
            peers[user]?.takeIf { it !== this && !it.alive }?.let { peers.remove(user, it) }
            peers.putIfAbsent(user, this)
            scope.launch { read() }
        }

        fun send(bytes: ByteArray) = Frame.write(out, bytes)

        private fun read() {
            try {
                sock.soTimeout = 0
                val input = sock.getInputStream()
                while (true) {
                    val body = Frame.read(input, Frame.PEER_MAX) ?: break
                    handle(body)
                }
            } catch (_: Throwable) {
                // Whatever a peer sends (even enough to run out of memory) only ends its connection.
            } finally {
                alive = false
                peers.remove(user, this)
                runCatching { sock.close() }
            }
        }

        private fun handle(body: ByteArray) {
            val r = In(body)
            when (r.u32().toInt()) {
                Code.SEARCH_RESPONSE -> runCatching { Messages.parseSearchResult(body.copyOfRange(4, body.size)) }
                    .onSuccess { res -> searches[res.token]?.invoke(res.copy(user = user.ifBlank { res.user })) }
                Code.TRANSFER_REQUEST -> {
                    val direction = r.u32(); val token = r.u32(); val file = r.str()
                    val size = if (direction == 1L) r.u64() else 0L
                    val t = queued[user to file]
                    if (direction == 1L && t != null && !t.done.isCompleted && t.expected > 0 && size != t.expected) {
                        // Only the file the search showed: a peer can't make Hive take something else (or something endless).
                        send(Messages.transferRefused(token, "Cancelled"))
                        t.fail("$user offered a different file")
                    } else if (direction == 1L && t != null && !t.done.isCompleted) {
                        t.size = size
                        byToken[token] = t
                        send(Messages.transferAllowed(token))
                    } else send(Messages.transferRefused(token, if (direction == 1L) "Cancelled" else "File not shared."))
                }
                Code.QUEUE_UPLOAD -> send(Messages.uploadDenied(r.str(), "File not shared."))
                Code.PLACE_IN_QUEUE_RESPONSE -> { val file = r.str(); queued[user to file]?.place = r.u32() }
                Code.UPLOAD_DENIED -> { val file = r.str(); queued[user to file]?.fail("$user: ${r.str()}") }
                Code.UPLOAD_FAILED -> { val file = r.str(); queued[user to file]?.takeIf { !it.started.isCompleted }?.fail("$user couldn't send it") }
            }
        }
    }

    // ---- search ----

    /** Searches the network; [onResult] runs for each peer's answer (on a network thread) until [stopSearch]. */
    fun search(query: String, onResult: (SearchResult) -> Unit): Long {
        val token = token()
        searches[token] = onResult
        sendServer(Messages.fileSearch(token, query))
        return token
    }

    fun stopSearch(token: Long) { searches.remove(token) }

    // ---- downloads ----

    private inner class Transfer(val user: String, val file: String, val target: File, val expected: Long, val onProgress: (Long, Long) -> Unit) {
        @Volatile var size = 0L
        @Volatile var place = 0L
        val started = CompletableDeferred<Unit>()
        val done = CompletableDeferred<File>()
        fun fail(why: String) { started.completeExceptionally(SoulseekException(why)); done.completeExceptionally(SoulseekException(why)) }
    }

    /**
     * Asks [user] for [file] and waits for it into [target]: up to
     * [startWithinMs] for the peer to start sending (it may have a queue),
     * then as long as bytes keep coming.
     */
    suspend fun download(user: String, file: String, target: File, startWithinMs: Long, expectedSize: Long = 0, onProgress: (Long, Long) -> Unit = { _, _ -> }): File {
        val t = Transfer(user, file, target, expectedSize, onProgress)
        queued[user to file] = t
        try {
            var conn = peer(user).also { it.send(Messages.queueUpload(file)) }
            var resent = 0
            // A reused connection the peer was just closing loses the request: ask again on a new one.
            withTimeoutOrNull(startWithinMs) {
                while (withTimeoutOrNull(1_000) { t.started.await() } == null) {
                    if (!conn.alive && resent < 2) { resent++; conn = peer(user).also { it.send(Messages.queueUpload(file)) } }
                }
            } ?: throw SoulseekException("$user didn't start sending in time")
            return t.done.await()
        } finally {
            queued.remove(user to file, t)
            byToken.entries.removeIf { it.value === t }
        }
    }

    /** A file connection: the peer's token, our offset (0: always whole files), then the bytes. */
    private fun receiveFile(sock: Socket) {
        var t: Transfer? = null
        try {
            sock.soTimeout = 60_000
            val input = sock.getInputStream()
            val head = ByteArray(4)
            Frame.readFully(input, head)
            t = byToken.remove(In(head).u32()) ?: return sock.close()
            t.started.complete(Unit)
            Frame.write(sock.getOutputStream(), Out().u64(0).bytes())
            t.target.parentFile?.mkdirs()
            var got = 0L
            val buf = ByteArray(64 * 1024)
            var lastReport = 0L
            t.target.outputStream().use { fileOut ->
                while (got < t.size) {
                    val n = input.read(buf, 0, minOf(buf.size.toLong(), t.size - got).toInt())
                    if (n < 0) break
                    fileOut.write(buf, 0, n)
                    got += n
                    val now = System.currentTimeMillis()
                    if (now - lastReport > 500) { lastReport = now; t.onProgress(got, t.size) }
                }
            }
            if (got < t.size) throw SoulseekException("${t.user} stopped sending")
            t.onProgress(got, t.size)
            t.done.complete(t.target)
        } catch (e: Exception) {
            t?.fail(e.message ?: "Download failed")
        } finally {
            runCatching { sock.close() }
        }
    }

    override fun close() {
        scope.cancel()
        runCatching { listener?.close() }
        runCatching { server?.close() }
        peers.values.forEach { runCatching { it.sock.close() } }
        peers.clear()
    }
}
