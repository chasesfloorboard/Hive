package com.local.hive.mobile.soulseek

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The client against a fake Soulseek server and peer on this machine, along
 * the path a phone behind a router takes: the search answer and the file both
 * arrive over connections the server asks Hive to open (ConnectToPeer, then
 * PierceFirewall), while Hive reaches the peer directly to queue the download.
 */
class SoulseekClientTest {
    private val song = ByteArray(300_000) { (it * 31 % 251).toByte() }
    private val path = "Music\\Peggy Gou\\I Hear You (2024) [FLAC]\\05 - (It Goes Like) Nanana.flac"

    private fun ipBytes() = byteArrayOf(1, 0, 0, 127) // 127.0.0.1, reversed as Soulseek sends it

    private fun message(input: InputStream): Pair<Int, In>? = Frame.read(input)?.let { In(it).let { r -> r.u32().toInt() to r } }

    /** The peer keeps the search connection open and takes the download request on it, as most do. */
    @Test fun downloadsOverTheConnectionTheSearchAnswerCameOn() = scenario(closeSearchConnection = false)

    /** The peer closes it: Hive asks the server where the peer is and connects directly. */
    @Test fun downloadsOverADirectConnectionWhenThePeerHungUp() = scenario(closeSearchConnection = true)

    private fun scenario(closeSearchConnection: Boolean) = runBlocking<Unit> {
        val serverSocket = ServerSocket(0)
        val peerSocket = ServerSocket(0)
        val serverSaw = CopyOnWriteArrayList<Int>()
        val peerSaw = CopyOnWriteArrayList<String>()
        val toClient = LinkedBlockingQueue<ByteArray>()

        // The peer: answers a pierced search connection, takes the QueueUpload on a direct one, and sends the file on a pierced F connection.
        thread(isDaemon = true) {
            while (true) {
                val s = runCatching { peerSocket.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    val input = s.getInputStream(); val out = s.getOutputStream()
                    // A peer message connection: the download request, the go-ahead, then the file over a relayed F connection.
                    fun serve() {
                        val (code, r) = message(input) ?: return
                        assertEquals(Code.QUEUE_UPLOAD, code)
                        assertEquals(path, r.str())
                        peerSaw += "queued"
                        Frame.write(out, Frame.message(Code.TRANSFER_REQUEST, Out().u32(1).u32(55).str(path).u64(song.size.toLong()).bytes()))
                        val (code2, r2) = message(input)!!
                        assertEquals(Code.TRANSFER_RESPONSE, code2)
                        assertEquals(55L, r2.u32()); assertTrue(r2.bool())
                        peerSaw += "allowed"
                        // The peer can't reach the phone: it asks the server to have the phone connect for the file.
                        toClient += Frame.message(Code.CONNECT_TO_PEER, Out().str("alice").str("F").bytes() + ipBytes() + Out().u32(peerSocket.localPort).u32(888).u8(0).u32(0).u32(0).bytes())
                        runCatching { while (Frame.read(input) != null) Unit }
                    }
                    val init = In(Frame.read(input)!!)
                    when (init.u8()) {
                        Code.PIERCE_FIREWALL -> when (init.u32()) {
                            777L -> {
                                peerSaw += "search"
                                Frame.write(out, Frame.message(Code.SEARCH_RESPONSE, searchResultBody("alice", searchToken, listOf(
                                    SharedFile(path, song.size.toLong(), bitrate = 900, lengthSec = 201, sampleRate = 44100, bitDepth = 16)), true, 500_000, 0)))
                                if (closeSearchConnection) s.close() else serve()
                            }
                            888L -> {
                                peerSaw += "file"
                                Frame.write(out, Out().u32(55).bytes())
                                val offset = ByteArray(8); Frame.readFully(input, offset)
                                assertEquals(0L, In(offset).u64())
                                out.write(song); out.flush(); s.close()
                            }
                        }
                        Code.PEER_INIT -> {
                            assertEquals("hiveuser", init.str()); assertEquals("P", init.str())
                            peerSaw += "direct"
                            serve()
                        }
                    }
                }
            }
        }

        // The server.
        thread(isDaemon = true) {
            val s = serverSocket.accept()
            val input = s.getInputStream(); val out = s.getOutputStream()
            thread(isDaemon = true) { while (true) { val m = toClient.poll(10, TimeUnit.SECONDS) ?: continue; Frame.write(out, m) } }
            while (true) {
                val (code, r) = message(input) ?: break
                serverSaw += code
                when (code) {
                    Code.LOGIN -> {
                        assertEquals("hiveuser", r.str()); assertEquals("secret", r.str()); assertEquals(CLIENT_VERSION.toLong(), r.u32())
                        toClient += Frame.message(Code.LOGIN, Out().bool(true).str("Welcome").bytes() + ipBytes() + Out().str("x").bool(false).bytes())
                    }
                    Code.FILE_SEARCH -> {
                        searchToken = r.u32(); assertEquals("Peggy Gou I Hear You", r.str())
                        toClient += Frame.message(Code.CONNECT_TO_PEER, Out().str("alice").str("P").bytes() + ipBytes() + Out().u32(peerSocket.localPort).u32(777).u8(0).u32(0).u32(0).bytes())
                    }
                    Code.GET_PEER_ADDRESS -> {
                        assertEquals("alice", r.str())
                        toClient += Frame.message(Code.GET_PEER_ADDRESS, Out().str("alice").bytes() + ipBytes() + Out().u32(peerSocket.localPort).u32(0).bytes() + byteArrayOf(0, 0))
                    }
                }
            }
        }

        val client = SoulseekClient("hiveuser", "secret", "127.0.0.1", serverSocket.localPort, listenPorts = 0..0)
        try {
            assertEquals("Welcome", client.login())
            val results = CopyOnWriteArrayList<SearchResult>()
            client.search("Peggy Gou I Hear You") { results += it }
            withTimeout(10_000) { while (results.isEmpty()) kotlinx.coroutines.delay(50) }
            if (closeSearchConnection) kotlinx.coroutines.delay(300) // the hang-up reaches Hive
            val result = results.single()
            assertEquals("alice", result.user)
            assertEquals(201, result.files.single().lengthSec)

            val picks = AlbumPicker.candidates("Peggy Gou", listOf(WantedTrack("(It Goes Like) Nanana", 201_000)), results)
            assertEquals(path, picks.single().files[0]!!.path)

            val target = File.createTempFile("nanana", ".flac")
            var progress = 0L
            client.download("alice", path, target, startWithinMs = 10_000) { got, _ -> progress = got }
            assertArrayEquals(song, target.readBytes())
            assertEquals(song.size.toLong(), progress)
            assertEquals(if (closeSearchConnection) listOf("search", "direct", "queued", "allowed", "file") else listOf("search", "queued", "allowed", "file"), peerSaw.toList())
            assertEquals(closeSearchConnection, Code.GET_PEER_ADDRESS in serverSaw)
            assertTrue(serverSaw.containsAll(listOf(Code.LOGIN, Code.SET_WAIT_PORT, Code.SET_STATUS, Code.SHARED_FOLDERS_FILES, Code.HAVE_NO_PARENT)))
            target.delete()
        } finally {
            client.close(); serverSocket.close(); peerSocket.close()
        }
    }

    /** Hive only downloads: a peer asking for files, the old way or the new, or for the share list, gets nothing. */
    @Test fun neverSendsAnything() = runBlocking<Unit> {
        val serverSocket = ServerSocket(0)
        val waitPort = LinkedBlockingQueue<Int>()
        val shares = LinkedBlockingQueue<Pair<Long, Long>>()
        thread(isDaemon = true) {
            val s = serverSocket.accept()
            val input = s.getInputStream(); val out = s.getOutputStream()
            while (true) {
                val (code, r) = message(input) ?: break
                when (code) {
                    Code.LOGIN -> Frame.write(out, Frame.message(Code.LOGIN, Out().bool(true).str("Welcome").bytes() + ipBytes() + Out().str("x").bool(false).bytes()))
                    Code.SET_WAIT_PORT -> waitPort += r.u32().toInt()
                    Code.SHARED_FOLDERS_FILES -> shares += r.u32() to r.u32()
                }
            }
        }
        val client = SoulseekClient("hiveuser", "secret", "127.0.0.1", serverSocket.localPort, listenPorts = 0..0)
        try {
            client.login()
            assertEquals(0L to 0L, shares.poll(5, TimeUnit.SECONDS))
            val peer = Socket("127.0.0.1", waitPort.poll(5, TimeUnit.SECONDS)!!)
            peer.soTimeout = 3_000
            val out = peer.getOutputStream(); val input = peer.getInputStream()
            Frame.write(out, Messages.peerInit("bob", "P"))
            Frame.write(out, Frame.message(Code.QUEUE_UPLOAD, Out().str("Music\\anything.flac").bytes()))
            Frame.write(out, Frame.message(Code.TRANSFER_REQUEST, Out().u32(0).u32(9).str("Music\\other.mp3").bytes()))
            Frame.write(out, Frame.message(Code.SHARED_FILE_LIST_REQUEST, ByteArray(0)))
            val (c1, r1) = message(input)!!
            assertEquals(Code.UPLOAD_DENIED, c1); assertEquals("Music\\anything.flac", r1.str()); assertEquals("File not shared.", r1.str())
            val (c2, r2) = message(input)!!
            assertEquals(Code.TRANSFER_RESPONSE, c2); assertEquals(9L, r2.u32()); assertEquals(false, r2.bool())
            // Nothing more: no share list, no file connection.
            assertEquals(null, runCatching { Frame.read(input) }.getOrNull())
            peer.close()
        } finally {
            client.close(); serverSocket.close()
        }
    }

    @Test fun aWrongPasswordSaysSo() = runBlocking<Unit> {
        val serverSocket = ServerSocket(0)
        thread(isDaemon = true) {
            val s = serverSocket.accept()
            message(s.getInputStream())
            Frame.write(s.getOutputStream(), Frame.message(Code.LOGIN, Out().bool(false).str("INVALIDPASS").bytes()))
        }
        val client = SoulseekClient("hiveuser", "nope", "127.0.0.1", serverSocket.localPort, listenPorts = 0..0)
        val e = runCatching { client.login() }.exceptionOrNull()
        assertEquals("Wrong Soulseek password", e?.message)
        client.close(); serverSocket.close()
    }

    @Volatile private var searchToken = 0L
}

/** A search response as a peer sends it. */
internal fun searchResultBody(user: String, token: Long, files: List<SharedFile>, freeSlot: Boolean, speed: Long, queue: Long): ByteArray {
    val o = Out().str(user).u32(token).u32(files.size)
    for (f in files) {
        o.u8(1).str(f.path).u64(f.size).str("")
        val attrs = listOfNotNull(0 to f.bitrate, 1 to f.lengthSec, (4 to f.sampleRate).takeIf { f.sampleRate > 0 }, (5 to f.bitDepth).takeIf { f.bitDepth > 0 })
        o.u32(attrs.size); attrs.forEach { (c, v) -> o.u32(c).u32(v) }
    }
    o.bool(freeSlot).u32(speed).u32(queue).u32(0)
    val raw = o.bytes()
    val deflater = java.util.zip.Deflater()
    deflater.setInput(raw); deflater.finish()
    val buf = ByteArray(raw.size + 64)
    val n = deflater.deflate(buf); deflater.end()
    return buf.copyOf(n)
}
