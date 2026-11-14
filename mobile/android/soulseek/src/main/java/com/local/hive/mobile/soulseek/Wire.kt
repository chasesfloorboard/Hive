package com.local.hive.mobile.soulseek

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.Inflater

/*
 * Soulseek's wire format (as Nicotine+ documents it in slskmessages.py):
 * little-endian integers, strings as a uint32 byte count then UTF-8 (older
 * clients send Latin-1). Server and peer messages are framed as uint32
 * length, uint32 code, body; peer init messages as uint32 length, uint8
 * code, body; file connections carry raw values.
 */

internal class Out {
    private val b = ByteArrayOutputStream()
    fun u8(v: Int) = apply { b.write(v and 0xff) }
    fun bool(v: Boolean) = u8(if (v) 1 else 0)
    fun u32(v: Long) = apply { for (i in 0 until 4) b.write(((v shr (8 * i)) and 0xff).toInt()) }
    fun u32(v: Int) = u32(v.toLong() and 0xffffffffL)
    fun u64(v: Long) = apply { for (i in 0 until 8) b.write(((v shr (8 * i)) and 0xff).toInt()) }
    fun str(s: String) = apply { val bytes = s.toByteArray(Charsets.UTF_8); u32(bytes.size); b.write(bytes) }
    fun bytes(): ByteArray = b.toByteArray()
}

internal class In(private val d: ByteArray, var pos: Int = 0) {
    val remaining get() = d.size - pos
    private fun need(n: Int) { if (remaining < n) throw SoulseekException("Message ended early") }
    fun u8(): Int { need(1); return d[pos++].toInt() and 0xff }
    fun bool() = u8() != 0
    fun u32(): Long { need(4); var v = 0L; for (i in 0 until 4) v = v or ((d[pos + i].toLong() and 0xff) shl (8 * i)); pos += 4; return v }
    fun u64(): Long { need(8); var v = 0L; for (i in 0 until 8) v = v or ((d[pos + i].toLong() and 0xff) shl (8 * i)); pos += 8; return v }
    fun str(): String {
        val n = u32().toInt()
        if (n < 0) throw SoulseekException("Bad string")
        need(n)
        val bytes = d.copyOfRange(pos, pos + n)
        pos += n
        val utf8 = Charsets.UTF_8.newDecoder()
        return runCatching { utf8.decode(java.nio.ByteBuffer.wrap(bytes)).toString() }.getOrElse { String(bytes, Charsets.ISO_8859_1) }
    }
    /** An IPv4 address, sent with its bytes reversed. */
    fun ip(): String { need(4); val s = (3 downTo 0).joinToString(".") { (d[pos + it].toInt() and 0xff).toString() }; pos += 4; return s }
    /** A file size; Soulseek NS sends sizes over 2 GiB with garbage in the top half. */
    fun fileSize(): Long { need(8); return if ((d[pos + 7].toInt() and 0xff) == 255) u32().also { pos += 4 } else u64() }
    fun skip(n: Int) { need(n); pos += n }
}

internal object Frame {
    const val MAX = 64 * 1024 * 1024
    /** Peers send search results (compressed) and short messages; anything bigger isn't a real client. */
    const val PEER_MAX = 8 * 1024 * 1024

    fun message(code: Int, body: ByteArray): ByteArray = Out().u32(body.size + 4).u32(code).bytes() + body
    fun init(code: Int, body: ByteArray): ByteArray = Out().u32(body.size + 1).u8(code).bytes() + body

    /** One length-prefixed frame's content (after the length), or null at a clean end of stream. */
    fun read(input: InputStream, max: Int = MAX): ByteArray? {
        val head = ByteArray(4)
        if (!readFully(input, head, allowEof = true)) return null
        val len = In(head).u32()
        if (len < 1 || len > max) throw SoulseekException("Message of $len bytes")
        val body = ByteArray(len.toInt())
        readFully(input, body)
        return body
    }

    fun readFully(input: InputStream, into: ByteArray, allowEof: Boolean = false): Boolean {
        var got = 0
        while (got < into.size) {
            val n = input.read(into, got, into.size - got)
            if (n < 0) { if (allowEof && got == 0) return false; throw EOFException() }
            got += n
        }
        return true
    }

    fun write(out: OutputStream, bytes: ByteArray) = synchronized(out) { out.write(bytes); out.flush() }

    /** Inflates a zlib body, refusing more than [limit] bytes. */
    fun inflate(data: ByteArray, limit: Int = 32 * 1024 * 1024): ByteArray {
        val inflater = Inflater()
        inflater.setInput(data)
        val out = ByteArrayOutputStream(minOf(data.size * 4, 1024 * 1024))
        val buf = ByteArray(64 * 1024)
        try {
            while (!inflater.finished()) {
                val n = inflater.inflate(buf)
                if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) throw SoulseekException("Truncated search result")
                out.write(buf, 0, n)
                if (out.size() > limit) throw SoulseekException("Search result too large")
            }
        } finally { inflater.end() }
        return out.toByteArray()
    }
}

class SoulseekException(message: String) : java.io.IOException(message)
