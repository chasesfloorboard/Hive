package com.local.hive.mobile.soulseek

import java.security.MessageDigest

/** Message codes Hive uses (Nicotine+'s slskmessages.py has them all). */
internal object Code {
    // Server
    const val LOGIN = 1
    const val SET_WAIT_PORT = 2
    const val GET_PEER_ADDRESS = 3
    const val CONNECT_TO_PEER = 18
    const val FILE_SEARCH = 26
    const val SET_STATUS = 28
    const val SHARED_FOLDERS_FILES = 35
    const val RELOGGED = 41
    const val HAVE_NO_PARENT = 71
    const val CANT_CONNECT_TO_PEER = 1001
    // Peer init
    const val PIERCE_FIREWALL = 0
    const val PEER_INIT = 1
    // Peer
    const val SHARED_FILE_LIST_REQUEST = 4
    const val SEARCH_RESPONSE = 9
    const val TRANSFER_REQUEST = 40
    const val TRANSFER_RESPONSE = 41
    const val QUEUE_UPLOAD = 43
    const val PLACE_IN_QUEUE_RESPONSE = 44
    const val UPLOAD_FAILED = 46
    const val UPLOAD_DENIED = 50
}

/** Experimental clients identify as major version 177 (see Nicotine+'s Login notes); the minor is Hive's own. */
internal const val CLIENT_VERSION = 177
internal const val CLIENT_MINOR_VERSION = 1

/** One file in a search result. [path] uses backslashes, as peers send it; [lengthSec] etc. are 0 when not given. */
data class SharedFile(
    val path: String,
    val size: Long,
    val bitrate: Int = 0,
    val lengthSec: Int = 0,
    val vbr: Boolean = false,
    val sampleRate: Int = 0,
    val bitDepth: Int = 0,
) {
    val name get() = path.substringAfterLast('\\')
    val folder get() = path.substringBeforeLast('\\', "")
    val extension get() = name.substringAfterLast('.', "").lowercase()
}

/** A peer's answer to a search. */
data class SearchResult(val user: String, val token: Long, val files: List<SharedFile>, val freeSlot: Boolean, val speed: Long, val queue: Long)

internal object Messages {
    fun login(user: String, pass: String) = Frame.message(Code.LOGIN, Out().str(user).str(pass).u32(CLIENT_VERSION)
        .str(MessageDigest.getInstance("MD5").digest((user + pass).toByteArray()).joinToString("") { "%02x".format(it) })
        .u32(CLIENT_MINOR_VERSION).bytes())
    fun setWaitPort(port: Int) = Frame.message(Code.SET_WAIT_PORT, Out().u32(port).bytes())
    fun getPeerAddress(user: String) = Frame.message(Code.GET_PEER_ADDRESS, Out().str(user).bytes())
    fun connectToPeer(token: Long, user: String, type: String) = Frame.message(Code.CONNECT_TO_PEER, Out().u32(token).str(user).str(type).bytes())
    fun fileSearch(token: Long, query: String) = Frame.message(Code.FILE_SEARCH, Out().u32(token).str(query).bytes())
    fun setStatusOnline() = Frame.message(Code.SET_STATUS, Out().u32(2).bytes())
    fun sharedFoldersFiles(folders: Int, files: Int) = Frame.message(Code.SHARED_FOLDERS_FILES, Out().u32(folders).u32(files).bytes())
    fun haveNoParent() = Frame.message(Code.HAVE_NO_PARENT, Out().bool(true).bytes())
    fun cantConnectToPeer(token: Long, user: String) = Frame.message(Code.CANT_CONNECT_TO_PEER, Out().u32(token).str(user).bytes())

    fun pierceFirewall(token: Long) = Frame.init(Code.PIERCE_FIREWALL, Out().u32(token).bytes())
    fun peerInit(me: String, type: String) = Frame.init(Code.PEER_INIT, Out().str(me).str(type).u32(0).bytes())

    fun queueUpload(file: String) = Frame.message(Code.QUEUE_UPLOAD, Out().str(file).bytes())
    fun transferAllowed(token: Long) = Frame.message(Code.TRANSFER_RESPONSE, Out().u32(token).bool(true).bytes())
    fun transferRefused(token: Long, reason: String) = Frame.message(Code.TRANSFER_RESPONSE, Out().u32(token).bool(false).str(reason).bytes())
    fun uploadDenied(file: String, reason: String) = Frame.message(Code.UPLOAD_DENIED, Out().str(file).str(reason).bytes())

    /** A FileSearchResponse body (zlib-compressed). */
    fun parseSearchResult(body: ByteArray): SearchResult {
        val r = In(Frame.inflate(body))
        val user = r.str()
        val token = r.u32()
        val files = parseFiles(r)
        val free = r.bool()
        val speed = r.u32()
        val queue = r.u32()
        return SearchResult(user, token, files, free, speed, queue)
    }

    private fun parseFiles(r: In): List<SharedFile> {
        val n = r.u32().toInt().coerceAtMost(100_000)
        return List(n) {
            r.u8()
            val name = r.str().replace('/', '\\')
            val size = r.fileSize()
            r.skip(r.u32().toInt()) // extension, obsolete
            var bitrate = 0; var length = 0; var vbr = false; var rate = 0; var depth = 0
            repeat(r.u32().toInt().coerceAtMost(64)) {
                val code = r.u32().toInt(); val value = r.u32().toInt()
                when (code) { 0 -> bitrate = value; 1 -> length = value; 2 -> vbr = value != 0; 4 -> rate = value; 5 -> depth = value }
            }
            SharedFile(name, size, bitrate, length, vbr, rate, depth)
        }
    }
}
