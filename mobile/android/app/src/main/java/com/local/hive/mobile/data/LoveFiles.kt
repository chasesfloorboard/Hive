package com.local.hive.mobile.data

import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Keeps each song's Love in its file, as Hive on the PC does, so uninstalling
 * Hive Mobile never loses a favorite:
 *
 * - **File to app:** a song whose file says Loved, and that the app has no
 *   word on yet (a fresh install, a song just copied over), becomes Loved
 *   here, and goes to the PC like any phone Love.
 * - **App to file:** every Love and un-Love made here, or brought from the PC,
 *   is written into the file. This needs "All files access" (otherwise Android
 *   asks before each file); without it, Loves wait and are written once it is
 *   given.
 *
 * What each file says is remembered (by size, so a file changed elsewhere is
 * read again), so a pass only opens the files whose Love may differ. The song
 * playing now is left until it isn't: rewriting a file mid-play could break it.
 */
class LoveFiles(
    private val context: Context,
    private val dao: LibraryDao,
    private val scope: CoroutineScope,
    /** Whether a new Love found in a file should go to the PC (the phone is paired). */
    private val paired: () -> Boolean,
    /** Library song ids the player has loaded now (playing, or next). */
    private val inUse: () -> Set<Long>,
    /** Files (full paths, lowercase) whose Love the PC writes and the file mirror brings back. */
    private val mirrored: () -> Set<String> = { emptySet() },
) {
    private val lock = Mutex()
    private val memoryFile = File(context.filesDir, "love-files.txt")
    private var job: Job? = null
    private var again = false

    /** Asks for a pass soon; requests during a pass are folded into one more. */
    fun request(delayMs: Long = 2_000) {
        synchronized(this) {
            if (job?.isActive == true) { again = true; return }
            job = scope.launch {
                delay(delayMs)
                do {
                    synchronized(this@LoveFiles) { again = false }
                    val retry = runCatching { pass() }.onFailure { if (it is CancellationException) throw it; Log.w(TAG, "Love in files: ${it.message}") }.getOrDefault(false)
                    if (retry) { delay(60_000); synchronized(this@LoveFiles) { again = true } }
                } while (synchronized(this@LoveFiles) { again })
            }
        }
    }

    /** One pass; true when some files were left for later (in use, or briefly unwritable). */
    private suspend fun pass(): Boolean = lock.withLock {
        withContext(Dispatchers.IO) {
            val tracks = dao.allTracks().filter { TagWriter.canWrite(it) }
            if (tracks.isEmpty()) return@withContext false
            val paths = paths()
            val memory = load()
            val love = dao.allLove().associateBy { it.trackId }
            val canWrite = android.os.Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()
            val busy = inUse()
            val viaPc = if (canWrite) runCatching { mirrored() }.getOrDefault(emptySet()) else emptySet()
            // Only songs the PC has a match for: their Love reaches the PC's copy too. Others are written here
            // and their tags go up with the mirror, so nothing is lost.
            val onPc = if (viaPc.isEmpty()) emptySet() else dao.allMatches().mapTo(HashSet()) { it.trackId }
            val found = mutableListOf<LoveState>()
            var leftOver = false
            var read = 0; var written = 0
            for (t in tracks) {
                val file = paths[t.id]?.let(::File) ?: continue
                val size = file.length().takeIf { it > 0 } ?: continue
                val wanted = love[t.id]
                var known = memory[t.id]?.takeIf { it.size == size }?.loved
                if (known == null) {
                    known = LoveTag.readFile(file) ?: continue
                    memory[t.id] = Known(size, known); read++
                }
                when {
                    // The app has no word on this song: the file's Love is the song's.
                    wanted == null -> if (known) found += LoveState(t.id, true, file.lastModified(), pending = paired())
                    wanted.loved == known -> Unit
                    !canWrite -> leftOver = true
                    // A copy kept one to one with the PC's: the PC writes Love into its copy and the file mirror makes
                    // this one the same file again (only the tags travel). Written here too, the two copies would
                    // differ, and the newer one's tags would win over the other's.
                    file.path.lowercase() in viaPc && t.id in onPc -> Unit
                    t.id in busy -> leftOver = true
                    else -> try {
                        TagWriter.write(context, t, TagEdit(loved = wanted.loved))
                        memory[t.id] = Known(file.length(), wanted.loved); written++
                    } catch (e: CancellationException) { throw e } catch (e: Exception) {
                        Log.w(TAG, "Love not written into ${t.fileName}: ${e.message}")
                        leftOver = true
                    }
                }
            }
            if (found.isNotEmpty()) dao.upsertLove(found)
            save(memory)
            if (read + written + found.size > 0) Log.i(TAG, "Love in files: read $read, wrote $written, ${found.size} Loved from their files")
            // Without All files access, waiting songs are tried again when it is given (Settings), not every minute.
            leftOver && canWrite
        }
    }

    private fun paths(): Map<Long, String> {
        val out = HashMap<Long, String>()
        context.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DATA), null, null, null)?.use { c ->
            while (c.moveToNext()) c.getString(1)?.let { out[c.getLong(0)] = it }
        }
        return out
    }

    private data class Known(val size: Long, val loved: Boolean)

    private fun load(): MutableMap<Long, Known> = runCatching {
        memoryFile.readLines().mapNotNull { line ->
            val p = line.split(' ')
            if (p.size != 3) null else p[0].toLongOrNull()?.let { id -> p[1].toLongOrNull()?.let { id to Known(it, p[2] == "1") } }
        }.toMap(HashMap())
    }.getOrElse { HashMap() }

    private fun save(memory: Map<Long, Known>) = runCatching {
        val temp = File(memoryFile.path + ".tmp")
        temp.writeText(memory.entries.joinToString("\n") { (id, k) -> "$id ${k.size} ${if (k.loved) 1 else 0}" })
        temp.renameTo(memoryFile)
    }

    private companion object { const val TAG = "HiveLove" }
}
