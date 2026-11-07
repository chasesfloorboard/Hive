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
import kotlinx.coroutines.sync.withLock

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
    /**
     * Phone files (by the phone's own path) that are a PC file in another folder: the same name and
     * size, met for the first time (song sync before the mirror filed them as Artist/Album). They're
     * moved to the PC's path on the phone instead of being copied both ways.
     */
    val moves: Map<String, String> = emptyMap(),
    /**
     * Files renamed or moved on the PC (old PC path to new): the same size and modified time under a new
     * name, the old one gone. The phone's copy is renamed to match instead of deleted and copied again.
     */
    val renames: Map<String, String> = emptyMap(),
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

    /**
     * A path from the PC that stays inside the music folder: relative, no "." or ".." parts, no empty
     * parts, nothing a PC (or something posing as one) could use to reach elsewhere on the phone.
     */
    fun safe(path: String): Boolean {
        if (path.isEmpty() || path.length > 1024 || path.startsWith("/") || '\\' in path || '\u0000' in path) return false
        return path.split('/').none { it.isEmpty() || it == "." || it == ".." }
    }

    /** Whether [key] (lowercase) is [prefixes] or inside one of them. */
    fun under(key: String, prefixes: Collection<String>) = prefixes.any { val p = it.lowercase().trimEnd('/'); key == p || key.startsWith("$p/") }

    /**
     * [phone] by the phone's own paths, [pc] by the PC's; [left]: paths the user chose to leave on one side;
     * [unreadable]: PC folders or files that couldn't be read this time. Nothing under them is copied or
     * deleted either way: their songs are unknown this run, not gone.
     */
    fun plan(phoneFiles: Map<String, FileStat>, pcListed: Map<String, FileStat>, ledger: Map<String, Agreed>, left: Set<String>, unreadable: Collection<String> = emptyList()): MirrorPlan {
        // Paths that would leave the music folder are never acted on (see [safe]).
        val pc = pcListed.filterKeys(::safe)
        val pcKeys = pc.keys.mapTo(HashSet()) { it.lowercase() }
        val ledgerKeys = ledger.keys.mapTo(HashSet()) { it.lowercase() }
        val leftKeys = left.mapTo(HashSet()) { it.lowercase() }
        val phoneRaw = phoneFiles.keys.associateBy { pcPath(it, pcKeys).lowercase() }
        var phone = phoneFiles.mapKeys { pcPath(it.key, pcKeys) }
        // The same file in another folder, met for the first time: same name, same size.
        val moves = HashMap<String, String>()
        run {
            val phoneKeys = phone.keys.mapTo(HashSet()) { it.lowercase() }
            fun loose(k: String) = k !in ledgerKeys && k !in leftKeys
            // Song sync stripped a leading dot (".Dot Song.flac" came as "Dot Song.flac"); the phone spells it "_".
            fun name(p: String) = p.substringAfterLast('/').lowercase().trimStart('.', '_')
            val pcOnly = pc.entries.filter { it.key.lowercase().let { k -> k !in phoneKeys && loose(k) } }
                .groupBy { name(it.key) to it.value.size }.mapValues { it.value.toMutableList() }
            // Hive may file a phone's song under another name ("Phone Artist/Album/Song.mp3"): then the
            // only unmatched file of that type and exact size on each side is the same file.
            fun ext(p: String) = p.substringAfterLast('.', "").lowercase()
            val phoneOnly = phone.entries.filter { it.key.lowercase().let { k -> k !in pcKeys && loose(k) } }
            val phoneBySize = phoneOnly.groupBy { ext(it.key) to it.value.size }
            val pcBySize = pcOnly.values.flatten().groupBy { ext(it.key) to it.value.size }
            for ((path, stat) in phoneOnly) {
                val twin = pcOnly[name(path) to stat.size]?.removeFirstOrNull()
                    ?: (ext(path) to stat.size).let { key -> pcBySize[key]?.singleOrNull()?.takeIf { phoneBySize[key]?.size == 1 && it.key !in moves.values } }
                    ?: continue
                pcOnly[name(twin.key) to twin.value.size]?.remove(twin)
                moves[phoneRaw.getValue(path.lowercase())] = twin.key
            }
            if (moves.isNotEmpty()) phone = phone.entries.associate { (p, st) -> (moves[phoneRaw[p.lowercase()]] ?: p) to st }
        }
        val toPhone = ArrayList<String>(); val toPc = ArrayList<String>(); val keepFirst = HashSet<String>()
        val goneFromPc = ArrayList<String>(); val goneFromPhone = ArrayList<String>()
        val agreed = HashMap<String, Agreed>()
        // Both drives ignore letter case: "Artist/Song.mp3" and "artist/song.mp3" are one file.
        val phoneByKey = phone.entries.associateBy { it.key.lowercase() }
        val pcByKey = pc.entries.associateBy { it.key.lowercase() }
        val ledgerByKey = ledger.entries.associateBy { it.key.lowercase() }
        for (key in (phoneByKey.keys + pcByKey.keys).sorted()) {
            if (key in leftKeys || (unreadable.isNotEmpty() && under(key, unreadable))) continue
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
        // Renamed on the PC: gone from one path (the phone's copy unchanged since), and at a new path a file
        // never seen before with the size and modified time the old one had (a rename keeps both). Only
        // a match that's the one possible either way counts; anything else stays a delete and a copy.
        val renames = HashMap<String, String>()
        run {
            fun ext(p: String) = p.substringAfterLast('.', "").lowercase()
            data class Sig(val ext: String, val size: Long, val second: Long)
            fun sig(p: String, st: FileStat) = Sig(ext(p), st.size, st.modified / 2_000)
            val newOnPc = toPhone.filter { it.lowercase() !in ledgerByKey && it.lowercase() !in phoneByKey }
                .groupBy { sig(it, pcByKey.getValue(it.lowercase()).value) }
            val gone = goneFromPc.filter { p -> val k = p.lowercase(); ledgerByKey[k]?.value?.phone?.same(phoneByKey.getValue(k).value) == true }
                .groupBy { sig(it, ledgerByKey.getValue(it.lowercase()).value.pc) }
            for ((sg, olds) in gone) {
                val news = newOnPc[sg] ?: continue
                if (olds.size != 1 || news.size != 1) continue
                renames[olds[0]] = news[0]
            }
            goneFromPc.removeAll(renames.keys); toPhone.removeAll(renames.values.toSet())
        }
        return MirrorPlan(toPhone, toPc, keepFirst, goneFromPc, goneFromPhone, agreed, moves, renames,
            bytesToPhone = toPhone.sumOf { pcByKey[it.lowercase()]?.value?.size ?: 0 }, bytesToPc = toPc.sumOf { phoneByKey[it.lowercase()]?.value?.size ?: 0 })
    }
}

/** Runs the file mirror between this phone's music folder and Hive's library folder. */
class FileMirror(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val ledgerFile = File(context.filesDir, "file-mirror.json")
    private val ledgerSerializer = MapSerializer(String.serializer(), Agreed.serializer())

    /** The phone's music folder: MusicHome's place, as a folder Hive may write in (All files access). */
    private val prefs = context.getSharedPreferences("file-mirror", Context.MODE_PRIVATE)

    /**
     * The folder mirrored, chosen once (the first time it's needed) and kept: worked out afresh it could
     * change as songs come and go (Music/My Music one day, Music the next), and every file would look new.
     */
    fun root(): File? {
        if (!available(context)) return null
        val kept = prefs.getString("root", null)
        // The folder chosen before is away (an SD card not mounted yet, mid-restart): no sync until
        // it's back. Picking another folder meanwhile copied the whole PC library into the phone's
        // own storage and forgot everything agreed about the real one.
        if (kept != null) return File(kept).takeIf { it.isDirectory }
        val chosen = chooseRoot() ?: return null
        prefs.edit().putString("root", chosen.path).apply()
        return chosen
    }

    private fun chooseRoot(): File? {
        val home = MusicHome.find(context) ?: return null
        val volume = runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 30)
                context.getSystemService(android.os.storage.StorageManager::class.java).getStorageVolume(MediaStore.Files.getContentUri(home.volume))?.directory
            else if (home.volume == MediaStore.VOLUME_EXTERNAL_PRIMARY) Environment.getExternalStorageDirectory() else null
        }.getOrNull() ?: return null
        return File(volume, home.base).takeIf { it.isDirectory }
    }

    /**
     * The phone files the mirror shares with the PC (full paths, lowercase). Their Love is written on the
     * PC and comes back with the file, so the phone doesn't rewrite them itself (see LoveFiles).
     */
    fun mirroredPhonePaths(): Set<String> {
        val root = root() ?: return emptySet()
        return ledger().keys.mapTo(HashSet()) { File(root, MirrorPlanner.phonePath(it)).path.lowercase() }
    }

    /**
     * What both sides last agreed on. A ledger that's there but can't be read stops the sync (the
     * last good copy is tried first): read as empty, every difference would look new, deletions would
     * come back and the safety check on mass copies would be skipped.
     */
    fun ledger(): Map<String, Agreed> {
        if (!ledgerFile.exists()) return emptyMap()
        return runCatching { json.decodeFromString(ledgerSerializer, ledgerFile.readText()) }.getOrElse {
            runCatching { json.decodeFromString(ledgerSerializer, File(ledgerFile.path + ".bak").readText()) }
                .getOrElse { throw IOException("Song sync stopped: its record of what's on both sides couldn't be read. Nothing was copied.") }
        }
    }

    private fun saveLedger(ledger: Map<String, Agreed>) {
        val tmp = File(ledgerFile.path + ".tmp")
        java.io.FileOutputStream(tmp).use { out -> out.write(json.encodeToString(ledgerSerializer, ledger).toByteArray()); out.fd.sync() }
        if (ledgerFile.exists()) ledgerFile.copyTo(File(ledgerFile.path + ".bak"), overwrite = true)
        if (!tmp.renameTo(ledgerFile)) { ledgerFile.delete(); tmp.renameTo(ledgerFile) }
    }

    /**
     * A copy cut off by Hive itself being stopped (no code ran to tidy up): its half file goes now. Called when
     * Hive starts, before any sync can begin a new copy.
     */
    fun clearUnfinishedCopy() {
        val path = prefs.getString(PART_IN_PROGRESS, null) ?: return
        if (path.endsWith(".hive-mirror-part")) runCatching { File(path).delete() }
        prefs.edit().remove(PART_IN_PROGRESS).commit()
    }

    /** Forgets that these were on both sides, so the next run copies them across again. */
    fun forget(paths: Collection<String>) { val keys = paths.mapTo(HashSet()) { it.lowercase() }; saveLedger(ledger().filterKeys { it.lowercase() !in keys }) }


    data class Result(val plan: MirrorPlan, val copied: Int, val failed: Int)

    /** A run that would copy unusually many files: it waits for the user to say go ahead (SongSync.allowManyOnce). */
    class TooManyCopies(val copies: Int, message: String) : IOException(message)

    /** Whether a music folder was chosen for the mirror before (it may be away now). */
    fun rootChosen(): Boolean = prefs.getString("root", null) != null

    /** Works out the plan without copying anything. */
    suspend fun check(client: HiveLinkClient, conn: HiveLinkClient.Connection, left: Set<String>): MirrorPlan = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        // Walking the whole music folder and reading the ledger: never on the screen's thread.
        val root = root() ?: throw IOException("Hive can't reach this phone's music folder (allow All files access).")
        val listed = client.files(conn)
        val pc = listed.files.associate { it.p to FileStat(it.s, it.m) }
        MirrorPlanner.plan(phoneFiles(root), pc, ledger(), left, listed.unreadable)
    }

    /**
     * Copies everything the plan holds, a file at a time, remembering each one done, so a run cut
     * short picks up where it left off. [budget]: bytes the phone may still take.
     */
    suspend fun run(
        client: HiveLinkClient, conn: HiveLinkClient.Connection, left: Set<String>, budget: Long,
        step: suspend (label: String, work: suspend () -> Unit) -> Boolean,
        allowMany: Boolean = false,
        /** Hive takes tags without the file: songs whose audio is the same on both sides go by their tags. */
        tagSync: Boolean = false,
    ): Result {
        val root = root() ?: throw IOException("Hive can't reach this phone's music folder (allow All files access).")
        // One run at a time (the ledger is held in memory for the run and saved by it).
        return gate.withLock { runLocked(client, conn, left, budget, root, step, allowMany, tagSync) }
    }

    private suspend fun runLocked(
        client: HiveLinkClient, conn: HiveLinkClient.Connection, left: Set<String>, budget: Long, root: File,
        step: suspend (label: String, work: suspend () -> Unit) -> Boolean,
        allowMany: Boolean,
        tagSync: Boolean,
    ): Result {
        pruneDeleted(root)
        val listed = client.files(conn)
        val pc = listed.files.associate { it.p to FileStat(it.s, it.m) }
        val phoneNow = phoneFiles(root)
        val plan = MirrorPlanner.plan(phoneNow, pc, ledger(), left, listed.unreadable)
        // Songs the player has open now (playing, just played, next up) are left as they are this
        // run: replaced or moved under the player, it skips or stops. They're done on a later run.
        val open = openPaths()
        fun inUse(path: String) = File(root, MirrorPlanner.phonePath(path)).path.lowercase() in open
        // Far more to copy than a day's changes, after the two sides have agreed before: more likely a
        // folder read wrong than real changes. Nothing is copied; the user is told.
        // Files on both sides that changed on one can go by their tags alone (checked below): they aren't
        // the mistaken mass copies this guards against (a folder read wrong lacks them on one side).
        val phoneHere = phoneNow.keys.mapTo(HashSet()) { it.lowercase() }
        fun onBoth(path: String) = path in pc && MirrorPlanner.phonePath(path).lowercase() in phoneHere
        fun tooMany(copies: Int) = !allowMany && ledger().isNotEmpty() && copies > maxOf(UNUSUAL_COPIES, pc.size / 4)
        val sureCopies = (plan.toPc + plan.toPhone).count { !onBoth(it) }
        if (tooMany(sureCopies))
            throw TooManyCopies(sureCopies, "Song sync is waiting: it would copy $sureCopies files at once, more than usual. Nothing was copied. If the phone's music folder is the right one, tap Copy them anyway.")
        val ledger = HashMap(ledger()).apply {
            // Files gone from both sides are forgotten; those agreed on now are remembered.
            val live = (pc.keys + phoneNow.keys).mapTo(HashSet()) { it.lowercase() }
            // What's under a PC folder that couldn't be read is unknown this run: still remembered.
            keys.removeAll { it.lowercase() !in live && !MirrorPlanner.under(it.lowercase(), listed.unreadable) }
            putAll(plan.agreed)
        }
        saveLedger(ledger)
        val scan = ArrayList<String>()
        var copied = 0; var failed = 0; var room = budget
        val rootCanonical = root.canonicalPath + File.separator
        fun phoneFile(path: String): File {
            val f = File(root, MirrorPlanner.phonePath(path))
            // A second check on the real path (links included): nothing outside the music folder, ever.
            if (!MirrorPlanner.safe(path) || !f.canonicalPath.startsWith(rootCanonical)) throw IOException("Refused a path outside the music folder: $path")
            return f
        }
        // Same audio on both sides, other tags: only the tags (and the cover) go across, not the file.
        // If the tag sync can't be done this run (the PC busy, the network gone), files on both sides wait for the next
        // run rather than going whole: a whole copy over a song whose tags differ is what lost the PC's play counts.
        val byTags = if (tagSync) runCatching { syncTags(client, conn, plan, pc, ledger, ::phoneFile, ::inUse, scan) }
            .onFailure { android.util.Log.w("HiveSongSync", "tag sync: ${it.message}") }
            .getOrElse { (plan.toPc + plan.toPhone).filterTo(HashSet()) { onBoth(it) } } else emptySet()
        if (byTags.isNotEmpty()) saveLedger(ledger)
        val copies = (plan.toPc + plan.toPhone).count { it !in byTags }
        if (tooMany(copies))
            throw TooManyCopies(copies, "Song sync is waiting: it would copy $copies files at once, more than usual. Nothing was copied. If the phone's music folder is the right one, tap Copy them anyway.")
        // Files already here in another folder are moved to the PC's path, not copied.
        for ((from, to) in plan.moves) {
            val source = File(root, from); val target = phoneFile(to)
            target.parentFile?.mkdirs()
            if (!target.exists() && source.renameTo(target)) {
                ledger[to] = Agreed(FileStat(target.length(), target.lastModified()), pc.getValue(to))
                scan += source.path; scan += target.path
                source.parentFile?.takeIf { it != root && it.list()?.isEmpty() == true }?.let { it.delete(); it.parentFile?.takeIf { p -> p != root && p.list()?.isEmpty() == true }?.delete() }
            }
        }
        // Renamed on the PC: the phone's copy takes the new name (nothing copied, nothing deleted).
        // A rename that can't be done here (the name taken, the card refusing) is copied instead, as before
        // renames were noticed: otherwise it would be tried, and fail, at every run.
        val renameFailed = ArrayList<String>()
        for ((from, to) in plan.renames) {
            if (inUse(from)) continue
            val source = phoneFile(from); val target = phoneFile(to)
            target.parentFile?.mkdirs()
            if (target.exists() || !source.renameTo(target)) { renameFailed += to; continue }
            ledger.remove(from)
            ledger[to] = Agreed(FileStat(target.length(), target.lastModified()), pc.getValue(to))
            scan += source.path; scan += target.path
            source.parentFile?.takeIf { it != root && it.list()?.isEmpty() == true }?.let { it.delete(); it.parentFile?.takeIf { p -> p != root && p.list()?.isEmpty() == true }?.delete() }
        }
        for (path in plan.toPhone + renameFailed) {
            if (path in byTags) continue
            val size = pc[path]?.size ?: continue
            if (inUse(path)) continue
            if (size > room) break
            val ok = step(path.substringAfterLast('/')) {
                val target = phoneFile(path)
                // The phone's own changes to it lost to the PC's newer ones: kept in Hive's Deleted songs first.
                if (path in plan.keepPhoneFirst && target.isFile) client.uploadFile(conn, path, target.lastModified(), target.length(), keep = true) { target.inputStream() }
                target.parentFile?.mkdirs()
                val part = File(target.parentFile, ".${target.name}.hive-mirror-part")
                // Noted before the first byte: if Hive is stopped mid-copy (closed, killed by the system), its next
                // start removes this half file at once (see clearUnfinishedCopy).
                prefs.edit().putString(PART_IN_PROGRESS, part.path).commit()
                val modified = try {
                    part.outputStream().use { client.downloadFile(conn, path, it) }
                } catch (e: Exception) { part.delete(); throw e }
                finally { prefs.edit().remove(PART_IN_PROGRESS).apply() }
                if (part.length() != size) { part.delete(); throw IOException("The copy of $path was cut off.") }
                // A copy that doesn't play never replaces one that does.
                if (!SongCheck.playable(part, target.takeIf { it.isFile })) { part.delete(); throw IOException("The PC's copy of $path doesn't look like a whole song; the phone's was kept.") }
                // Renamed straight over the old copy (one step): deleting first left nothing if the rename failed.
                if (!part.renameTo(target)) {
                    if (target.exists() && !target.delete()) { part.delete(); throw IOException("Couldn't replace $path on the phone.") }
                    if (!part.renameTo(target)) { part.delete(); throw IOException("Couldn't save $path on the phone.") }
                }
                if (modified > 0) target.setLastModified(modified)
                ledger[path] = Agreed(FileStat(target.length(), target.lastModified()), pc.getValue(path))
                scan += target.path
            }
            if (ok) { copied++; room -= size; if (copied % 50 == 0) saveLedger(ledger) } else failed++
        }
        for (path in plan.toPc) {
            if (path in byTags) continue
            val ok = step(path.substringAfterLast('/')) {
                val source = phoneFile(path)
                // A broken or cut-off file on the phone (a tag write the app didn't finish) never goes over the PC's copy.
                val agreedSize = ledger[path]?.phone?.size
                if (!SongCheck.playable(source, null) || (agreedSize != null && SongCheck.shrunk(agreedSize, source.length())))
                    throw IOException("The phone's copy of $path doesn't look like a whole song; the PC's was kept.")
                val before = FileStat(source.length(), source.lastModified())
                val saved = client.uploadFile(conn, path, before.modified, before.size) { source.inputStream() }
                if (saved.status != "saved") throw IOException("Hive didn't take $path.")
                // Changed while it was being sent: what was sent isn't what's here now, so the next run sends it again.
                if (FileStat(source.length(), source.lastModified()).same(before)) ledger[path] = Agreed(before, FileStat(saved.s, saved.m))
            }
            if (ok) { copied++; if (copied % 50 == 0) saveLedger(ledger) } else failed++
        }
        saveLedger(ledger)
        // Android's music library learns of the new and changed files.
        scan.chunked(500).forEach { MediaScannerConnection.scanFile(context, it.toTypedArray(), null, null) }
        return Result(plan, copied, failed)
    }

    /**
     * The changed files on both sides whose audio is the same: the changed side's whole file minus its
     * audio (every tag and picture) goes across, and the other side's copy is rebuilt around its own
     * audio, checked byte for byte against the changed file. The two files are then one and the same,
     * and the song itself never travels. Returns the paths it took care of: those done, and phone files
     * Hive couldn't take this time (tried again next run, never sent whole). The rest are copied whole.
     */
    private suspend fun syncTags(
        client: HiveLinkClient, conn: HiveLinkClient.Connection, plan: MirrorPlan, pc: Map<String, FileStat>,
        ledger: HashMap<String, Agreed>, phoneFile: (String) -> File, inUse: (String) -> Boolean, scan: MutableList<String>,
    ): Set<String> {
        fun here(path: String) = path in pc && runCatching { phoneFile(path).isFile }.getOrDefault(false)
        // Changed on both sides since they agreed: the PC's copy wins (it has taken the phone's own edits as
        // edits already, PcEdits, so it holds both sides' changes); the phone's is kept aside on the PC.
        fun bothChanged(path: String) = ledger[path]?.let { was -> pc[path]?.let { !was.pc.same(it) } } == true
        val toPc = plan.toPc.filter { here(it) && !bothChanged(it) }
        val keepFirst = plan.keepPhoneFirst + plan.toPc.filter { here(it) && bothChanged(it) }
        val toPhone = (plan.toPhone + plan.toPc.filter { here(it) && bothChanged(it) }).filter { here(it) && !inUse(it) }
        if (toPc.isEmpty() && toPhone.isEmpty()) return emptySet()
        val states = client.fileTagStates(conn, (toPc + toPhone).distinct()).associateBy { it.p }
        fun sameAudio(path: String): Pair<File, AudioSignature.Place>? {
            val sig = states[path]?.sig ?: return null
            val file = phoneFile(path)
            if (AudioSignature.of(file) != sig) return null
            return file to (AudioSignature.place(file) ?: return null)
        }
        fun bytes(f: File, from: Long, to: Long): ByteArray = java.io.RandomAccessFile(f, "r").use { r -> ByteArray((to - from).toInt()).also { r.seek(from); r.readFully(it) } }
        val done = HashSet<String>(); val waiting = HashSet<String>()
        // Phone to PC.
        for (path in toPc) {
            val (file, place) = sameAudio(path) ?: continue
            waiting += path
            try {
                val before = FileStat(file.length(), file.lastModified())
                val saved = client.uploadTags(conn, path, bytes(file, 0, place.start), bytes(file, place.end, place.size), place.size, AudioSignature.sha256(file), before.modified)
                if (saved.status == "saved" && FileStat(file.length(), file.lastModified()).same(before)) { ledger[path] = Agreed(before, FileStat(saved.s, saved.m)); done += path }
            } catch (e: HiveLinkException) {
                // The audio isn't the same after all: the whole file goes, as before.
                if (e.status == 409) waiting -= path
                android.util.Log.w("HiveSongSync", "tags of $path not sent: ${e.message}")
            } catch (e: IOException) { android.util.Log.w("HiveSongSync", "tags of $path not sent: ${e.message}") }
        }
        // PC to phone: the phone's copy rebuilt from Hive's tags and its own audio, next to it, then renamed over it.
        for (path in toPhone) {
            val (file, place) = sameAudio(path) ?: continue
            // Both changed, the phone's copy the newer: never sent whole over the PC's if this doesn't work out.
            if (path in plan.toPc) waiting += path
            val part = File(file.parentFile, ".${file.name}.hive-mirror-part")
            try {
                if (path in keepFirst) client.uploadTags(conn, path, bytes(file, 0, place.start), bytes(file, place.end, place.size), place.size, AudioSignature.sha256(file), file.lastModified(), keep = true)
                val t = client.downloadTags(conn, path)
                if (t.size - t.head.size - t.tail.size != place.end - place.start) continue
                prefs.edit().putString(PART_IN_PROGRESS, part.path).commit()
                java.io.FileOutputStream(part).use { out ->
                    out.write(t.head)
                    java.io.RandomAccessFile(file, "r").use { r ->
                        r.seek(place.start)
                        val buf = ByteArray(1 shl 20); var left = place.end - place.start
                        while (left > 0) { val n = r.read(buf, 0, minOf(buf.size.toLong(), left).toInt()); if (n < 0) break; out.write(buf, 0, n); left -= n }
                    }
                    out.write(t.tail); out.fd.sync()
                }
                if (part.length() != t.size || AudioSignature.sha256(part) != t.sha256) { part.delete(); continue }
                if (!part.renameTo(file)) { part.delete(); continue }
                if (t.modified > 0) file.setLastModified(t.modified)
                ledger[path] = Agreed(FileStat(file.length(), file.lastModified()), FileStat(t.size, t.modified))
                scan += file.path; done += path
            } catch (e: Exception) {
                part.delete()
                android.util.Log.w("HiveSongSync", "tags of $path not taken: ${e.message}")
            } finally { prefs.edit().remove(PART_IN_PROGRESS).apply() }
        }
        android.util.Log.i("HiveSongSync", "tag sync: ${done.size} of ${toPc.size + toPhone.size} by tags, ${(waiting - done).size} waiting")
        return done + waiting
    }

    /**
     * Takes these off the phone (deleted on the PC). Never erased outright: each is moved into the
     * music folder's hidden "$DELETED_FOLDER" (same path inside), kept [KEEP_DELETED_DAYS] days, so a
     * deletion that shouldn't have happened can be undone. Songs the player has open are left for
     * a later run. Returns the ones taken off.
     */
    fun deleteOnPhone(paths: List<String>): List<String> {
        val root = root() ?: return emptyList()
        val open = openPaths()
        val bin = File(root, DELETED_FOLDER)
        if (bin.mkdirs() || bin.isDirectory) runCatching { File(bin, ".nomedia").createNewFile() }
        val rootCanonical = root.canonicalPath + File.separator
        val gone = paths.filter(MirrorPlanner::safe).filter { p ->
            val file = File(root, MirrorPlanner.phonePath(p)).takeIf { it.canonicalPath.startsWith(rootCanonical) } ?: return@filter false
            when {
                !file.exists() -> true
                file.path.lowercase() in open -> false
                else -> {
                    val first = File(bin, MirrorPlanner.phonePath(p))
                    var kept = first
                    var n = 2
                    while (kept.exists()) kept = File(first.parentFile, first.nameWithoutExtension + " (${n++})" + (if (first.extension.isEmpty()) "" else "." + first.extension))
                    kept.parentFile?.mkdirs()
                    // Kept with today's time: the clock for its days in the bin starts now.
                    file.renameTo(kept).also { if (it) kept.setLastModified(System.currentTimeMillis()) }
                }
            }
        }
        MediaScannerConnection.scanFile(context, gone.map { File(root, MirrorPlanner.phonePath(it)).path }.toTypedArray(), null, null)
        forget(gone)
        return gone
    }

    /** Songs kept in the hidden deleted folder for longer than [KEEP_DELETED_DAYS] are erased now. */
    private fun pruneDeleted(root: File) {
        val bin = File(root, DELETED_FOLDER).takeIf { it.isDirectory } ?: return
        val cutoff = System.currentTimeMillis() - KEEP_DELETED_DAYS * 24L * 3_600_000L
        bin.walkBottomUp().forEach { f ->
            if (f == bin) return@forEach
            if (f.isFile && f.name != ".nomedia" && f.lastModified() < cutoff) f.delete()
            else if (f.isDirectory && f.list()?.isEmpty() == true) f.delete()
        }
    }

    /** Full paths (lowercase) of the library songs the player has open now (see OpenSongs). */
    private fun openPaths(): Set<String> {
        val ids = com.local.hive.mobile.playback.OpenSongs.ids
        if (ids.isEmpty()) return emptySet()
        return runCatching {
            context.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.MediaColumns.DATA),
                "${MediaStore.MediaColumns._ID} IN (${ids.joinToString(",")})", null, null)?.use { c ->
                buildSet { while (c.moveToNext()) c.getString(0)?.let { add(it.lowercase()) } }
            }
        }.getOrNull().orEmpty()
    }

    companion object {
        /** Every file in the phone's music folder, by its own paths. Unfinished downloads and Android's own files are left out. */
        fun phoneFiles(root: File): Map<String, FileStat> {
            val out = HashMap<String, FileStat>()
            val base = root.path.length + 1
            root.walkTopDown()
                .onEnter { dir -> dir == root || dir.name !in SKIPPED_FOLDERS }
                .filter { it.isFile && !SKIPPED_FILE.containsMatchIn(it.name).also { skipped -> if (skipped) dropStalePart(it) } }
                .forEach { f -> out[f.path.substring(base)] = FileStat(f.length(), f.lastModified()) }
            return out
        }

        /** The music folder's hidden folder for songs taken off the phone because they were deleted on the PC. */
        const val DELETED_FOLDER = ".Hive deleted songs"
        private const val PART_IN_PROGRESS = "partInProgress"
        /** Held by a run: two runs never overlap. */
        val gate = kotlinx.coroutines.sync.Mutex()
        const val KEEP_DELETED_DAYS = 30

        /** More copies than this in one run (and over a quarter of the library), once agreed before, is taken for a mistake. */
        private const val UNUSUAL_COPIES = 300
        /** Android's own folders and files, Soulseek downloads still coming in, and half-copied files. */
        private val SKIPPED_FOLDERS = setOf("Soulseek Incomplete", ".thumbnails", ".Trash", "LOST.DIR", DELETED_FOLDER)
        // Hive's own half-written files (as file-mirror.js on the PC leaves out) aren't mirrored either.
        /**
         * A half-copied file left by a copy that never finished (the app stopped mid-copy): gone once
         * it's had no writes for a minute (a live copy gives up after 30 s without data).
         */
        private fun dropStalePart(f: java.io.File) {
            if (f.name.endsWith(".hive-mirror-part", ignoreCase = true) && System.currentTimeMillis() - f.lastModified() > 60_000L) f.delete()
        }

        private val SKIPPED_FILE = Regex("""^\.(pending|trashed)-|\.hive-mirror-part$|\.hive-edit$|\.hivelink-part$|\.beehive-[a-z-]+-[0-9a-f]{6,}(\.[a-z0-9]+)?$""", RegexOption.IGNORE_CASE)

        /** Whether Hive may write anywhere in the phone's storage (All files access): the mirror needs it. */
        fun available(context: Context): Boolean = android.os.Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()
    }
}

/** Whether a song file is whole, before it replaces another copy. */
internal object SongCheck {
    /**
     * [file] has audio Android can read, and (with [old]) isn't clearly shorter than the copy it replaces:
     * a tag or cover change never shortens a song; a copy cut off part-way does.
     */
    fun playable(file: File, old: File?): Boolean {
        if (file.length() <= 0) return false
        val ms = duration(file) ?: return isUnreadableKind(file)
        if (ms <= 0) return false
        val was = old?.let(::duration) ?: return true
        return ms >= was - maxOf(3_000L, was / 20)
    }

    /** Far smaller than the copy both sides agreed on: a cut-off write, not an edit (a cover is a few MB at most). */
    fun shrunk(agreed: Long, now: Long) = now < agreed / 2 && agreed - now > 2L * 1024 * 1024

    private fun duration(file: File): Long? = runCatching {
        val r = android.media.MediaMetadataRetriever()
        try { r.setDataSource(file.path); r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() } finally { r.release() }
    }.getOrNull()

    /** Kinds Android can't read the length of (not songs, or rare formats): not judged, only their size. */
    private fun isUnreadableKind(file: File) = file.extension.lowercase() !in setOf("mp3", "m4a", "mp4", "flac", "ogg", "opus", "wav", "aac")
}
