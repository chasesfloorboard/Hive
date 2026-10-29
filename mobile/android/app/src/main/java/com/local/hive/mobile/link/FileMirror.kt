package com.local.hive.mobile.link

import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.provider.MediaStore
import com.local.hive.mobile.data.MusicHome
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException

/** A file's size and modified time (ms), as one side last saw it. */
@Serializable data class FileStat(val size: Long, val modified: Long) {
    /**
     * The same file as when last seen. Times within 2 s count as the same: the PC keeps milliseconds,
     * while an SD card keeps whole seconds (exFAT 10 ms, FAT 2 s) and may round a time it was just given.
     */
    fun same(other: FileStat) = size == other.size && kotlin.math.abs(modified - other.modified) < 2_000
}

/** Both sides' copies of a file, the last time they were the same. */
@Serializable data class Agreed(val phone: FileStat, val pc: FileStat)

/**
 * What the file mirror does on this run. Paths are the PC's, relative to its library folder.
 * [keepPhoneFirst]: files where the phone's copy changed too but the PC's is newer; the
 * phone's goes to Hive's Deleted songs before the PC's replaces it.
 */
data class MirrorPlan(
    val toPhone: List<String>,
    val toPc: List<String>,
    val keepPhoneFirst: Set<String>,
    /** On both before, now gone from the PC (still on the phone), or from the phone (still on the PC). */
    val goneFromPc: List<String>,
    val goneFromPhone: List<String>,
    /** Files the same on both sides now, to remember as agreed. */
    val agreed: Map<String, Agreed>,
    val bytesToPhone: Long = 0,
    val bytesToPc: Long = 0,
)

/**
 * The phone's music folder kept one to one with Hive's library folder, file for file:
 * the same paths, the same bytes. Each side's copy is compared with how it was when
 * both last agreed: the side that changed since is copied to the other; when both
 * changed, the newer wins and the other is kept in Hive's Deleted songs. A file gone
 * from one side is never deleted on the other by itself: the user decides (SongSync.deletions).
 */
object MirrorPlanner {
    private val AUDIO = Regex("""\.(mp3|flac|m4a|aac|alac|wav|aiff?|ogg|oga|opus|wma|ape|wv|mpc|dsf|dff)$""", RegexOption.IGNORE_CASE)

    /**
     * Android hides files whose names start with a dot, so a song named "...And So It Was" can't
     * sit on the phone as is: its first dot is "_" there ("_..And So It Was"). Only songs;
     * ".nomedia" and the like keep their names.
     */
    fun phonePath(pcPath: String): String {
        val name = pcPath.substringAfterLast('/')
        if (!name.startsWith('.') || !AUDIO.containsMatchIn(name)) return pcPath
        return pcPath.dropLast(name.length) + "_" + name.drop(1)
    }

    /**
     * The PC's path of a phone file: "_X" is the PC's ".X" only when the PC has ".X" and no "_X"
     * (a song may really be called "_.mp3").
     */
    fun pcPath(phonePath: String, pcKeys: Set<String>): String {
        val name = phonePath.substringAfterLast('/')
        if (!name.startsWith('_') || !AUDIO.containsMatchIn(name) || phonePath.lowercase() in pcKeys) return phonePath
        val dotted = phonePath.dropLast(name.length) + "." + name.drop(1)
        return if (dotted.lowercase() in pcKeys) dotted else phonePath
    }

    /** [phone] by the phone's own paths, [pc] by the PC's; [left]: paths the user chose to leave on one side. */
    fun plan(phoneFiles: Map<String, FileStat>, pc: Map<String, FileStat>, ledger: Map<String, Agreed>, left: Set<String>): MirrorPlan {
        val pcKeys = pc.keys.mapTo(HashSet()) { it.lowercase() }
        val phone = phoneFiles.mapKeys { pcPath(it.key, pcKeys) }
        val toPhone = ArrayList<String>(); val toPc = ArrayList<String>(); val keepFirst = HashSet<String>()
        val goneFromPc = ArrayList<String>(); val goneFromPhone = ArrayList<String>()
        val agreed = HashMap<String, Agreed>()
        // Both drives ignore letter case: "Artist/Song.mp3" and "artist/song.mp3" are one file.
        val phoneByKey = phone.entries.associateBy { it.key.lowercase() }
        val pcByKey = pc.entries.associateBy { it.key.lowercase() }
        val ledgerByKey = ledger.entries.associateBy { it.key.lowercase() }
        val leftKeys = left.mapTo(HashSet()) { it.lowercase() }
        for (key in (phoneByKey.keys + pcByKey.keys).sorted()) {
            if (key in leftKeys) continue
            val ph = phoneByKey[key]; val c = pcByKey[key]; val was = ledgerByKey[key]?.value
            val path = c?.key ?: ph!!.key
            when {
                ph != null && c != null -> {
                    val phoneChanged = was == null || !was.phone.same(ph.value)
                    val pcChanged = was == null || !was.pc.same(c.value)
                    when {
                        !phoneChanged && !pcChanged -> agreed[path] = was!!
                        // Met for the first time (or both changed) with the same size: taken as the same file.
                        (was == null || (phoneChanged && pcChanged)) && ph.value.size == c.value.size -> agreed[path] = Agreed(ph.value, c.value)
                        pcChanged && !phoneChanged -> toPhone += path
                        phoneChanged && !pcChanged -> toPc += path
                        // Both changed (or first met, different): the newer wins; the phone's copy is kept if it loses.
                        c.value.modified >= ph.value.modified -> { toPhone += path; keepFirst += path }
                        else -> toPc += path
                    }
                }
                c != null -> if (was != null) goneFromPhone += path else toPhone += path
                else -> if (was != null) goneFromPc += path else toPc += path
            }
        }
        return MirrorPlan(toPhone, toPc, keepFirst, goneFromPc, goneFromPhone, agreed,
            bytesToPhone = toPhone.sumOf { pcByKey[it.lowercase()]?.value?.size ?: 0 }, bytesToPc = toPc.sumOf { phoneByKey[it.lowercase()]?.value?.size ?: 0 })
    }
}

/** Runs the file mirror between this phone's music folder and Hive's library folder. */
class FileMirror(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ledgerFile = File(context.filesDir, "file-mirror.json")
    private val ledgerSerializer = MapSerializer(String.serializer(), Agreed.serializer())

    /** The phone's music folder: MusicHome's place, as a folder Hive may write in (All files access). */
    fun root(): File? {
        if (!available(context)) return null
        val home = MusicHome.find(context) ?: return null
        val volume = runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 30)
                context.getSystemService(android.os.storage.StorageManager::class.java).getStorageVolume(MediaStore.Files.getContentUri(home.volume))?.directory
            else if (home.volume == MediaStore.VOLUME_EXTERNAL_PRIMARY) Environment.getExternalStorageDirectory() else null
        }.getOrNull() ?: return null
        return File(volume, home.base).takeIf { it.isDirectory }
    }

    fun ledger(): Map<String, Agreed> = runCatching { json.decodeFromString(ledgerSerializer, ledgerFile.readText()) }.getOrDefault(emptyMap())

    private fun saveLedger(ledger: Map<String, Agreed>) {
        val tmp = File(ledgerFile.path + ".tmp")
        tmp.writeText(json.encodeToString(ledgerSerializer, ledger))
        if (!tmp.renameTo(ledgerFile)) { ledgerFile.delete(); tmp.renameTo(ledgerFile) }
    }

    /** Forgets that these were on both sides, so the next run copies them across again. */
    fun forget(paths: Collection<String>) { val keys = paths.mapTo(HashSet()) { it.lowercase() }; saveLedger(ledger().filterKeys { it.lowercase() !in keys }) }

    /** Every file in the phone's music folder, by its own paths. Unfinished downloads and Android's own files are left out. */
    fun phoneFiles(root: File): Map<String, FileStat> {
        val out = HashMap<String, FileStat>()
        val base = root.path.length + 1
        root.walkTopDown()
            .onEnter { dir -> dir == root || dir.name !in SKIPPED_FOLDERS }
            .filter { it.isFile && !SKIPPED_FILE.containsMatchIn(it.name) }
            .forEach { f -> out[f.path.substring(base)] = FileStat(f.length(), f.lastModified()) }
        return out
    }

    data class Result(val plan: MirrorPlan, val copied: Int, val failed: Int)

    /** Works out the plan without copying anything. */
    suspend fun check(client: HiveLinkClient, conn: HiveLinkClient.Connection, left: Set<String>): MirrorPlan {
        val root = root() ?: throw IOException("Hive can't reach this phone's music folder (allow All files access).")
        val pc = client.files(conn).associate { it.p to FileStat(it.s, it.m) }
        return MirrorPlanner.plan(phoneFiles(root), pc, ledger(), left)
    }

    /**
     * Copies everything the plan holds, a file at a time, remembering each one done, so a run cut
     * short picks up where it left off. [budget]: bytes the phone may still take.
     */
    suspend fun run(
        client: HiveLinkClient, conn: HiveLinkClient.Connection, left: Set<String>, budget: Long,
        step: suspend (label: String, work: suspend () -> Unit) -> Boolean,
    ): Result {
        val root = root() ?: throw IOException("Hive can't reach this phone's music folder (allow All files access).")
        val pcList = client.files(conn)
        val pc = pcList.associate { it.p to FileStat(it.s, it.m) }
        val plan = MirrorPlanner.plan(phoneFiles(root), pc, ledger(), left)
        val ledger = HashMap(ledger()).apply {
            // Files gone from both sides are forgotten; those agreed on now are remembered.
            val live = (pc.keys + phoneFiles(root).keys).mapTo(HashSet()) { it.lowercase() }
            keys.removeAll { it.lowercase() !in live }
            putAll(plan.agreed)
        }
        saveLedger(ledger)
        val scan = ArrayList<String>()
        var copied = 0; var failed = 0; var room = budget
        fun phoneFile(path: String) = File(root, MirrorPlanner.phonePath(path))
        for (path in plan.toPhone) {
            val size = pc[path]?.size ?: continue
            if (size > room) break
            val ok = step(path.substringAfterLast('/')) {
                val target = phoneFile(path)
                // The phone's own changes to it lost to the PC's newer ones: kept in Hive's Deleted songs first.
                if (path in plan.keepPhoneFirst && target.isFile) client.uploadFile(conn, path, target.lastModified(), target.length(), keep = true) { target.inputStream() }
                target.parentFile?.mkdirs()
                val part = File(target.parentFile, ".${target.name}.hive-mirror-part")
                val modified = try {
                    part.outputStream().use { client.downloadFile(conn, path, it) }
                } catch (e: Exception) { part.delete(); throw e }
                if (part.length() != size) { part.delete(); throw IOException("The copy of $path was cut off.") }
                if (target.exists() && !target.delete()) { part.delete(); throw IOException("Couldn't replace $path on the phone.") }
                if (!part.renameTo(target)) { part.delete(); throw IOException("Couldn't save $path on the phone.") }
                if (modified > 0) target.setLastModified(modified)
                ledger[path] = Agreed(FileStat(target.length(), target.lastModified()), pc.getValue(path))
                scan += target.path
            }
            if (ok) { copied++; room -= size } else failed++
            if (copied % 50 == 0) saveLedger(ledger)
        }
        for (path in plan.toPc) {
            val ok = step(path.substringAfterLast('/')) {
                val source = phoneFile(path)
                val saved = client.uploadFile(conn, path, source.lastModified(), source.length()) { source.inputStream() }
                if (saved.status != "saved") throw IOException("Hive didn't take $path.")
                ledger[path] = Agreed(FileStat(source.length(), source.lastModified()), FileStat(saved.s, saved.m))
            }
            if (ok) copied++ else failed++
            if (copied % 50 == 0) saveLedger(ledger)
        }
        saveLedger(ledger)
        // Android's music library learns of the new and changed files.
        scan.chunked(500).forEach { MediaScannerConnection.scanFile(context, it.toTypedArray(), null, null) }
        return Result(plan, copied, failed)
    }

    /** Deletes these from the phone (deleted on the PC, the user agreeing). Returns the ones deleted. */
    fun deleteOnPhone(paths: List<String>): List<String> {
        val root = root() ?: return emptyList()
        val gone = paths.filter { p -> File(root, MirrorPlanner.phonePath(p)).let { !it.exists() || it.delete() } }
        MediaScannerConnection.scanFile(context, gone.map { File(root, MirrorPlanner.phonePath(it)).path }.toTypedArray(), null, null)
        forget(gone)
        return gone
    }

    companion object {
        /** Android's own folders and files, Soulseek downloads still coming in, and half-copied files. */
        private val SKIPPED_FOLDERS = setOf("Soulseek Incomplete", ".thumbnails", ".Trash", "LOST.DIR")
        // Hive's own half-written files (as file-mirror.js on the PC leaves out) aren't mirrored either.
        private val SKIPPED_FILE = Regex("""^\.(pending|trashed)-|\.hive-mirror-part$|\.hivelink-part$|\.beehive-[a-z-]+-[0-9a-f]{6,}(\.[a-z0-9]+)?$""", RegexOption.IGNORE_CASE)

        /** Whether Hive may write anywhere in the phone's storage (All files access): the mirror needs it. */
        fun available(context: Context): Boolean = android.os.Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()
    }
}
