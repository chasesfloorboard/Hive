package com.local.hive.mobile.link

import com.local.hive.mobile.data.writeTextAtomic
import com.local.hive.mobile.data.TrackMatcher
import com.local.hive.mobile.data.LinkStore

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
class PcEdits(
    context: Context, private val dao: LibraryDao, private val store: LinkStore, private val client: HiveLinkClient = HiveLinkClient(),
    /** The PC's songs as last fetched: finds the PC copy of a song that hasn't been matched yet. */
    private val pcTracks: () -> List<PcTrack> = { emptyList() },
) {
    @Serializable private data class Tags(val pcId: String, val tags: Map<String, String>, val tries: Int = 0)
    /** A front cover, or with [back] (its place among the back covers, from 0) a back cover; no [file] takes that back cover off. */
    @Serializable private data class Cover(val pcIds: List<String>, val file: String, val back: Int = -1, val tries: Int = 0)
    @Serializable private data class Pending(val tags: List<Tags> = emptyList(), val covers: List<Cover> = emptyList())

    private val file = File(context.filesDir, "pc-edits.json")
    private val coverDir = File(context.filesDir, "pc-edit-covers").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = Mutex()

    private fun load() = runCatching { json.decodeFromString(Pending.serializer(), file.readText()) }.getOrDefault(Pending())
    private fun save(p: Pending) { file.writeTextAtomic(json.encodeToString(Pending.serializer(), p)) }

    /** The PC copies of these phone songs, as last matched. */
    private suspend fun pcIds(trackIds: Collection<Long>): Map<Long, String> {
        if (store.pairing == null) return emptyMap()
        val wanted = trackIds.toHashSet()
        val found = dao.allMatches().filter { it.trackId in wanted }.associate { it.trackId to it.pcId }.toMutableMap()
        // A song the last sync didn't match (new on the phone, or tagged differently) is looked up in
        // the PC's library now, by the tags it had before this edit, so the edit isn't lost.
        val missing = wanted - found.keys
        if (missing.isNotEmpty()) {
            val index = TrackMatcher.Index(pcTracks().map { TrackMatcher.Candidate(it.id, it.title, it.artist, it.albumArtist, it.duration, it.album) })
            for (t in dao.tracks(missing.toList())) {
                (index.match(t.title, t.artist, t.albumArtist, t.durationMs, t.album)
                    ?: index.match(t.fileName.substringBeforeLast('.').replace(Regex("""^\d+[\s.-]+"""), ""), t.artist, t.albumArtist, t.durationMs))
                    ?.let { found[t.id] = it.key }
            }
        }
        if (found.size < wanted.size) android.util.Log.w("PcEdits", "no PC copy for ${wanted.size - found.size} edited song(s); the edit stays on the phone")
        return found
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

    suspend fun addBackCover(trackIds: List<Long>, place: Int, image: ByteArray?) = mutex.withLock {
        val ids = pcIds(trackIds).values.distinct()
        if (ids.isEmpty()) return@withLock
        val name = image?.let { File(coverDir, "${System.currentTimeMillis()}-${ids.hashCode()}-back$place.img").apply { writeBytes(it) }.name }.orEmpty()
        val p = load()
        save(p.copy(covers = p.covers + Cover(ids, name, back = place)))
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
                // Only edits Hive says it wrote are done; the rest are sent again next sync (a file
                // busy or read-only on the PC), and given up after MAX_TRIES so one bad file can't stick forever.
                val edited = client.editTags(conn, p.tags.map { SongTagEdit(it.pcId, it.tags) }).toSet()
                p = p.copy(tags = p.tags.filter { it.pcId !in edited }.map { it.copy(tries = it.tries + 1) }.filter { it.tries < MAX_TRIES }); save(p)
            }
        } catch (e: java.io.IOException) { return@withLock }
        for (c in p.covers) {
            val f = File(coverDir, c.file)
            // Hive no longer having the songs (404 below) counts as done: there's nothing to write.
            var edited: List<String> = c.pcIds
            try {
                edited = when {
                    c.back < 0 -> if (f.exists()) client.sendCover(conn, c.pcIds, f.readBytes()) else c.pcIds
                    c.file.isEmpty() -> client.sendBackCover(conn, c.pcIds, c.back, null)
                    f.exists() -> client.sendBackCover(conn, c.pcIds, c.back, f.readBytes())
                    else -> c.pcIds
                }
            } catch (e: HiveLinkException) {
                // Hive no longer has those songs: nothing to send. Anything else (a Hive too old
                // for back covers among it) waits.
                if (e.status != 404 || e.message?.contains("none of those") != true) return@withLock
            } catch (e: java.io.IOException) { return@withLock }
            // Songs Hive couldn't write stay waiting with this picture, up to MAX_TRIES sends.
            val left = c.pcIds - edited.toSet()
            val again = if (left.isNotEmpty() && c.tries + 1 < MAX_TRIES) c.copy(pcIds = left, tries = c.tries + 1) else null
            if (again == null && c.file.isNotEmpty()) f.delete()
            p = p.copy(covers = p.covers - c + listOfNotNull(again)); save(p)
        }
    }

    // Tried at many syncs before giving up (a file read-only on the PC): an edit dropped too soon could be
    // lost, as the phone's copy may already count as the same as the PC's (see MainViewModel.saveEdits).
    private companion object { const val MAX_TRIES = 30 }
}
