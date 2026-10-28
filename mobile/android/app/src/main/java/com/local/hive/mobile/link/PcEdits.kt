package com.local.hive.mobile.link

import android.content.Context
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.TagEdit
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Tag and cover edits made on the phone, on their way to the same songs in
 * Hive on the PC. They wait here (in the app's files) until the PC can be
 * reached and trusts this phone, then go in Hive's own files through its tag
 * editor. Songs the PC doesn't have are left out: song sync takes the edited
 * file over instead.
 */
class PcEdits(context: Context, private val dao: LibraryDao, private val store: LinkStore, private val client: HiveLinkClient = HiveLinkClient()) {
    @Serializable private data class Tags(val pcId: String, val tags: Map<String, String>)
    @Serializable private data class Cover(val pcIds: List<String>, val file: String)
    @Serializable private data class Pending(val tags: List<Tags> = emptyList(), val covers: List<Cover> = emptyList())

    private val file = File(context.filesDir, "pc-edits.json")
    private val coverDir = File(context.filesDir, "pc-edit-covers").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = Mutex()

    private fun load() = runCatching { json.decodeFromString(Pending.serializer(), file.readText()) }.getOrDefault(Pending())
    private fun save(p: Pending) { file.writeText(json.encodeToString(Pending.serializer(), p)) }

    /** The PC copies of these phone songs, as last matched. */
    private suspend fun pcIds(trackIds: Collection<Long>): Map<Long, String> {
        if (store.pairing == null) return emptyMap()
        val wanted = trackIds.toHashSet()
        return dao.allMatches().filter { it.trackId in wanted }.associate { it.trackId to it.pcId }
    }

    /** Remembers tag edits for the PC; a newer edit of a field replaces an older one. */
    suspend fun addTags(edits: Map<Long, TagEdit>) = mutex.withLock {
        val ids = pcIds(edits.keys)
        if (ids.isEmpty()) return@withLock
        val p = load()
        val merged = p.tags.associate { it.pcId to it.tags }.toMutableMap()
        for ((trackId, edit) in edits) ids[trackId]?.let { pc -> merged[pc] = merged[pc].orEmpty() + edit.pcTags() }
        save(p.copy(tags = merged.map { (k, v) -> Tags(k, v) }))
    }

    suspend fun addCover(trackIds: List<Long>, image: ByteArray) = mutex.withLock {
        val ids = pcIds(trackIds).values.distinct()
        if (ids.isEmpty()) return@withLock
        val f = File(coverDir, "${System.currentTimeMillis()}-${ids.hashCode()}.img").apply { writeBytes(image) }
        val p = load()
        save(p.copy(covers = p.covers + Cover(ids, f.name)))
    }

    /**
     * Sends what waits. An older Hive, or one that doesn't trust this phone yet,
     * keeps them waiting; anything else that fails is tried at the next sync.
     */
    suspend fun send(conn: HiveLinkClient.Connection) = mutex.withLock {
        var p = load()
        if (p.tags.isEmpty() && p.covers.isEmpty()) return@withLock
        try {
            if (p.tags.isNotEmpty()) {
                client.editTags(conn, p.tags.map { SongTagEdit(it.pcId, it.tags) })
                p = p.copy(tags = emptyList()); save(p)
            }
        } catch (e: java.io.IOException) { return@withLock }
        for (c in p.covers) {
            val f = File(coverDir, c.file)
            try {
                if (f.exists()) client.sendCover(conn, c.pcIds, f.readBytes())
            } catch (e: HiveLinkException) {
                // Hive no longer has those songs: nothing to send. Anything else waits.
                if (e.status != 404) return@withLock
            } catch (e: java.io.IOException) { return@withLock }
            f.delete()
            p = p.copy(covers = p.covers - c); save(p)
        }
    }
}
