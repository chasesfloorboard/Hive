package com.local.hive.mobile.data

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.util.Log
import com.local.hive.mobile.link.HiveLinkClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * Hive Mobile exactly as it is, kept where an uninstall can't reach it, so a
 * reinstall comes back the same: the library database (Loves, playlists,
 * plays and Yearly Wrap, history, ratings, favorite albums, artists and
 * playlists), every setting, and the app's own files (the PC pairing, the file
 * mirror's memory, playlist pictures...).
 *
 * The copy is a zip, kept in up to three places:
 * - `Documents/Hive Mobile/Hive Mobile backup.zip` on the phone (needs All
 *   files access, as a new install has to read a file an old one made);
 * - Hive on the PC, through Hive Link: one per phone, even if the phone's
 *   storage is wiped;
 * - a file the user picks in a cloud (Google Drive, OneDrive, Dropbox... any
 *   storage app on the phone), for a new phone or a lost one. A fresh install
 *   restores from it with "Restore from a file", and keeps that file up to date.
 *
 * A fresh install that finds one (on the phone, or on the PC once paired)
 * offers to restore it ([offer]); restoring puts every file back as it was and
 * starts Hive again. Until a fresh install has answered, it saves nothing over
 * the phone's copy.
 */
class PhoneBackup(
    private val context: Context,
    private val dao: LibraryDao,
    private val database: () -> LibraryDatabase,
    private val client: HiveLinkClient,
) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val lock = Mutex()
    private val json = Json { ignoreUnknownKeys = true }

    /** The copy on the phone. */
    val file: File get() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "Hive Mobile/Hive Mobile backup.zip")
    /** The latest copy made, for the PC (outside the folders it copies). */
    private val latest get() = File(context.noBackupFilesDir, "latest-backup.zip")

    private val canUseFile get() = Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()

    @Serializable data class Meta(val format: Int = 1, val savedAt: Long, val versionCode: Long = 0, val versionName: String = "", val device: String = "")

    /** A copy a fresh install may restore. [pcDevice] is set for one kept on the PC. */
    data class Offer(val savedAt: Long, val versionName: String, val deviceName: String, val pcDevice: String? = null, val local: File? = null, val picked: android.net.Uri? = null, val replaces: Boolean = false)

    /** Where the copies are, for Settings › Backup. Times are 0 when there's none yet. */
    data class Status(val phoneAt: Long, val canUsePhone: Boolean, val pcAt: Long, val cloudName: String?, val cloudAt: Long, val cloudError: String?)
    private val _status = MutableStateFlow(readStatus())
    val status: StateFlow<Status> = _status.asStateFlow()
    private fun readStatus() = Status(
        phoneAt = if (canUseFile && file.isFile) file.lastModified() else 0, canUsePhone = canUseFile,
        pcAt = prefs.getLong("pcSentAt", 0), cloudName = prefs.getString("cloudName", null),
        cloudAt = prefs.getLong("cloudAt", 0), cloudError = prefs.getString("cloudError", null),
    )
    fun refreshStatus() { _status.value = readStatus() }

    private val _offer = MutableStateFlow<Offer?>(null)
    /** A backup this fresh install could restore, shown to the user until they answer. */
    val offer: StateFlow<Offer?> = _offer.asStateFlow()

    private val fresh get() = prefs.getBoolean("freshInstall", false)
    private val answered get() = prefs.getBoolean("answered", false)

    /**
     * At the very first start of this install, before anything is read in: whether the app had
     * nothing of its own (just installed: a backup may be restored) or was already in use (an update
     * to a version with backups: nothing to restore, saving starts at once).
     */
    suspend fun noteInstall() {
        if (prefs.contains("freshInstall")) return
        val fresh = withContext(Dispatchers.IO) { dao.allTracks().isEmpty() && dao.allLove().isEmpty() && dao.allPlaylistsOnce().isEmpty() }
        prefs.edit().putBoolean("freshInstall", fresh).putBoolean("answered", !fresh).apply()
    }

    /** A fresh install looks for a copy to offer: on the phone, and on the PC ([conn], when paired). */
    suspend fun lookForOffer(conn: HiveLinkClient.Connection?, ownDevice: String?) {
        if (!fresh || answered) return
        val found = listOfNotNull(_offer.value).toMutableList()
        // The phone's copy, unless this install made it (it then has nothing older to offer).
        if (canUseFile && !prefs.getBoolean("ownsLocal", false)) withContext(Dispatchers.IO) {
            listOf(file, File(file.path + ".previous")).firstNotNullOfOrNull { f -> readMeta(f)?.let { Offer(it.savedAt, it.versionName, it.device, local = f) } }?.let(found::add)
        }
        if (conn != null) runCatching { client.phoneBackups(conn) }.getOrNull()
            ?.filter { it.device != ownDevice }?.maxByOrNull { it.savedAt }
            ?.let { found += Offer(it.savedAt, it.versionName, it.deviceName, pcDevice = it.device) }
        _offer.value = found.maxByOrNull { it.savedAt }
    }

    /** Starts this install as it is, keeping the copy where it was. */
    fun decline() {
        // A file picked by hand and then not wanted leaves this install's answer as it was.
        if (_offer.value?.picked == null) prefs.edit().putBoolean("answered", true).apply()
        _offer.value = null
    }

    /**
     * Restores [offer]: the copy is fetched and checked, then Hive starts again and puts every file
     * back before anything opens them (see [applyPending]). Throws when the copy can't be used.
     */
    suspend fun restore(offer: Offer, conn: HiveLinkClient.Connection?) = withContext(Dispatchers.IO) {
        val pending = File(context.filesDir, PENDING)
        val part = File(pending.path + ".part")
        when {
            offer.local != null -> offer.local.copyTo(part, overwrite = true)
            offer.picked != null -> context.contentResolver.openInputStream(offer.picked)!!.use { input -> part.outputStream().use { input.copyTo(it) } }
            offer.pcDevice != null -> part.outputStream().use { out -> client.downloadPhoneBackup(conn ?: throw java.io.IOException("Hive on the PC can't be reached"), offer.pcDevice, out) }
        }
        if (readMeta(part) == null) { part.delete(); throw java.io.IOException("That backup can't be read") }
        part.renameTo(pending)
        // The file restored from is the cloud copy from now on (these settings outlive the restore).
        offer.picked?.let { keepCloud(it) }
        prefs.edit().putBoolean("answered", true).putLong("restoredFrom", offer.savedAt).commit()
        Log.i(TAG, "Restoring the backup of ${offer.savedAt}: starting again")
        val start = context.packageManager.getLaunchIntentForPackage(context.packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        withContext(Dispatchers.Main) { start?.let(context::startActivity) }
        Runtime.getRuntime().exit(0)
    }

    /** Whether this install has worked out yet if it is a fresh one (see [noteInstall]). */
    private val noted get() = prefs.contains("freshInstall")
    /**
     * Whether the phone's copy may be written: never over one an earlier install made before this
     * fresh install has answered whether to restore it. A fresh install with none there starts its own.
     */
    private fun mayWriteLocal() = noted && (answered || !fresh || prefs.getBoolean("ownsLocal", false) ||
        (canUseFile && !file.isFile && !File(file.path + ".previous").isFile))
    /** The PC keeps one copy per phone, so this install's own never replaces an earlier one's there. */
    private val maySave get() = noted

    /** Makes a copy as things are now, and keeps it on the phone. Unchanged since the last: nothing is written. */
    suspend fun save() = lock.withLock {
        if (!maySave) return@withLock
        withContext(Dispatchers.IO) {
            runCatching {
                val made = File(context.cacheDir, "backup.zip.part")
                val hash = write(made)
                if (hash == prefs.getString("hash", null) && latest.isFile && (!canUseFile || !mayWriteLocal() || file.isFile)) { made.delete(); writeCloud(); return@runCatching }
                made.copyTo(latest, overwrite = true)
                if (canUseFile && mayWriteLocal()) {
                    val dir = file.parentFile!!.apply { mkdirs() }
                    val temp = File(dir, file.name + ".tmp")
                    made.copyTo(temp, overwrite = true)
                    if (file.isFile) file.copyTo(File(file.path + ".previous"), overwrite = true)
                    if (!temp.renameTo(file)) { file.delete(); temp.renameTo(file) }
                    prefs.edit().putBoolean("ownsLocal", true).apply()
                }
                made.delete()
                prefs.edit().putString("hash", hash).putBoolean("pcBehind", true).putBoolean("cloudBehind", true).apply()
                Log.i(TAG, "Backup saved (${latest.length() / 1024} KB)")
                writeCloud()
            }.onFailure { Log.w(TAG, "Backup not saved: ${it.message}") }
        }
        refreshStatus()
    }

    // ---- the cloud copy ----

    /** A file picked to keep the copy in (made with "Back up to the cloud", or restored from). */
    private fun keepCloud(uri: android.net.Uri) {
        runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        val name = runCatching {
            val app = context.packageManager.resolveContentProvider(uri.authority.orEmpty(), 0)?.loadLabel(context.packageManager)?.toString()
            val file = context.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
            listOfNotNull(app, file).joinToString(" › ")
        }.getOrNull()?.ifBlank { null } ?: "the file you picked"
        // A file picked before stays the user's; Hive just stops writing to it.
        prefs.getString("cloudUri", null)?.takeIf { it != uri.toString() }?.let { old ->
            runCatching { context.contentResolver.releasePersistableUriPermission(android.net.Uri.parse(old), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        }
        prefs.edit().putString("cloudUri", uri.toString()).putString("cloudName", name).putBoolean("cloudBehind", true).putLong("cloudAt", 0).remove("cloudError").commit()
    }

    /** Starts keeping the copy in [uri] and writes it there now. */
    suspend fun setCloud(uri: android.net.Uri) {
        keepCloud(uri)
        save()
        lock.withLock { withContext(Dispatchers.IO) { writeCloud(force = true) } }
        refreshStatus()
    }

    fun stopCloud() {
        prefs.getString("cloudUri", null)?.let { runCatching { context.contentResolver.releasePersistableUriPermission(android.net.Uri.parse(it), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } }
        prefs.edit().remove("cloudUri").remove("cloudName").remove("cloudAt").remove("cloudError").apply()
        refreshStatus()
    }

    /**
     * The latest copy into the cloud file when it has changed, at most every [CLOUD_EVERY_MS] (a
     * cloud app uploads the whole file each time). Called with the lock held.
     */
    private fun writeCloud(force: Boolean = false) {
        val uri = prefs.getString("cloudUri", null)?.let(android.net.Uri::parse) ?: return
        if (!latest.isFile || !maySave) return
        if (!force && (!prefs.getBoolean("cloudBehind", false) || System.currentTimeMillis() - prefs.getLong("cloudAt", 0) < CLOUD_EVERY_MS)) return
        runCatching {
            (context.contentResolver.openOutputStream(uri, "wt") ?: throw java.io.IOException("can't open it")).use { out -> latest.inputStream().use { it.copyTo(out) } }
            prefs.edit().putBoolean("cloudBehind", false).putLong("cloudAt", System.currentTimeMillis()).remove("cloudError").apply()
            Log.i(TAG, "Backup saved to the cloud file")
        }.onFailure {
            Log.w(TAG, "Backup not saved to the cloud file: ${it.message}")
            prefs.edit().putString("cloudError", "Hive couldn't save to ${prefs.getString("cloudName", "the cloud file")}: ${it.message ?: "it can't be reached"}. Pick it again if it keeps failing.").apply()
        }
    }

    /**
     * The newest backup Hive on the PC keeps from another install (this phone before a reinstall,
     * or another phone), shown as the restore offer. Null when it keeps none.
     */
    suspend fun offerFromPc(conn: HiveLinkClient.Connection, ownDevice: String?): Offer? {
        val b = client.phoneBackups(conn).filter { it.device != ownDevice }.maxByOrNull { it.savedAt } ?: return null
        return Offer(b.savedAt, b.versionName, b.deviceName, pcDevice = b.device, replaces = !(fresh && !answered)).also { _offer.value = it }
    }

    /**
     * A backup file the user picked (from a cloud, another phone, a download): checked and shown as
     * the restore offer. Throws when it isn't a Hive Mobile backup.
     */
    suspend fun offerFile(uri: android.net.Uri) = withContext(Dispatchers.IO) {
        val copy = File(context.cacheDir, "picked-backup.zip")
        context.contentResolver.openInputStream(uri)!!.use { input -> copy.outputStream().use { input.copyTo(it) } }
        val meta = readMeta(copy) ?: run { copy.delete(); throw java.io.IOException("That isn't a Hive Mobile backup") }
        copy.delete()
        _offer.value = Offer(meta.savedAt, meta.versionName, meta.device, picked = uri, replaces = !(fresh && !answered))
    }

    /** Sends the latest copy to the PC when it has changed, at most every [everyMs]. */
    suspend fun sendToPc(conn: HiveLinkClient.Connection, everyMs: Long = 15 * 60_000) = lock.withLock {
        if (!maySave || !prefs.getBoolean("pcBehind", false) || !latest.isFile) return@withLock
        if (System.currentTimeMillis() - prefs.getLong("pcSentAt", 0) < everyMs) return@withLock
        runCatching {
            val meta = readMeta(latest) ?: return@runCatching
            client.sendPhoneBackup(conn, latest, meta.savedAt, meta.versionName)
            prefs.edit().putBoolean("pcBehind", false).putLong("pcSentAt", System.currentTimeMillis()).apply()
            refreshStatus()
        }.onFailure { Log.w(TAG, "Backup not sent to the PC: ${it.message}") }
    }

    /** Writes the copy into [out]; returns a hash of what's in it (not when it was made). */
    private fun write(out: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val dbCopy = File(context.cacheDir, "backup-db.sqlite").apply { delete() }
        copyDatabase(dbCopy)
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val meta = Meta(savedAt = System.currentTimeMillis(), versionCode = info.longVersionCode, versionName = info.versionName.orEmpty(), device = "${Build.MANUFACTURER} ${Build.MODEL}")
        ZipOutputStream(out.outputStream().buffered()).use { zip ->
            fun add(name: String, f: File) {
                zip.putNextEntry(ZipEntry(name))
                // The pairing with the PC (its key for this phone) never goes into a copy: it belongs to
                // this install, and a copy that carried it would let another phone act as this one.
                if (f.name == LINK_PREFS) {
                    val bytes = Pairing.strip(f.readText()).toByteArray()
                    zip.write(bytes); digest.update(bytes); digest.update(name.toByteArray()); zip.closeEntry(); return
                }
                f.inputStream().use { input ->
                    val buf = ByteArray(1 shl 16)
                    while (true) { val n = input.read(buf); if (n < 0) break; zip.write(buf, 0, n); digest.update(buf, 0, n) }
                }
                digest.update(name.toByteArray())
                zip.closeEntry()
            }
            zip.putNextEntry(ZipEntry(META)); zip.write(json.encodeToString(Meta.serializer(), meta).toByteArray()); zip.closeEntry()
            add("db/$DB", dbCopy)
            prefsDir().listFiles().orEmpty().filter { it.isFile && it.name.endsWith(".xml") && it.name !in SKIP_PREFS }.sortedBy { it.name }.forEach { add("prefs/${it.name}", it) }
            context.filesDir.walkTopDown().filter { it.isFile && it.name != PENDING && !it.name.endsWith(".apk") && !it.name.startsWith("profileInstalled") && !it.name.startsWith("profileinstaller") && it.length() < MAX_FILE }
                .sortedBy { it.path }.forEach { add("files/" + it.relativeTo(context.filesDir).invariantSeparatorsPath, it) }
        }
        dbCopy.delete()
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** A consistent copy of the library database while it's open. */
    private fun copyDatabase(to: File) {
        val db = database().openHelper.writableDatabase
        if (Build.VERSION.SDK_INT >= 30) {
            db.execSQL("VACUUM INTO '" + to.path.replace("'", "''") + "'")
        } else {
            db.query("PRAGMA wal_checkpoint(FULL)").use { it.moveToFirst() }
            context.getDatabasePath(DB).copyTo(to, overwrite = true)
        }
    }

    private fun prefsDir() = File(context.applicationInfo.dataDir, "shared_prefs")

    private fun readMeta(f: File): Meta? = runCatching {
        if (!f.isFile) return null
        ZipFile(f).use { z ->
            if (z.getEntry("db/$DB") == null) return null
            z.getInputStream(z.getEntry(META) ?: return null).use { json.decodeFromString(Meta.serializer(), it.readBytes().decodeToString()) }
        }
    }.getOrNull()

    companion object {
        private const val TAG = "HiveBackup"
        private const val PREFS = "phone-backup"
        private const val PENDING = "restore-pending.zip"
        private const val META = "meta.json"
        private const val DB = "hive-library.db"
        private const val MAX_FILE = 200L * 1024 * 1024
        private const val LINK_PREFS = "hive-link.xml"
        private const val CLOUD_EVERY_MS = 15 * 60_000L
        /** This install's own answers, and what Android's job scheduler keeps, stay this install's. */
        private val SKIP_PREFS = setOf("$PREFS.xml", "androidx.work.util.preferences.xml", "WebViewChromiumPrefs.xml")

        /**
         * At the very start of Hive, before anything opens the database or settings: a restore asked
         * for puts every file back from the copy. Called from HiveApp.onCreate.
         */
        fun applyPending(context: Context) {
            val pending = File(context.filesDir, PENDING)
            if (!pending.isFile) return
            runCatching {
                val prefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
                // This install's own pairing stays: the copy's (an older install's, or none) would be
                // refused by the PC, and the phone would unpair itself.
                val ownPairing = File(prefsDir, LINK_PREFS).takeIf { it.isFile }?.readText()?.let(Pairing::entries).orEmpty()
                ZipFile(pending).use { zip ->
                    // Only what the copy has replaces what's here; nothing outside the app's folders is written.
                    context.getDatabasePath(DB).let { db -> listOf(db, File(db.path + "-wal"), File(db.path + "-shm")).forEach { it.delete() } }
                    prefsDir.listFiles().orEmpty().filter { it.name.endsWith(".xml") && it.name !in SKIP_PREFS }.forEach { it.delete() }
                    context.filesDir.listFiles().orEmpty().filter { it.name != PENDING }.forEach { it.deleteRecursively() }
                    for (e in zip.entries().asSequence().filter { !it.isDirectory }) {
                        val target = when {
                            e.name == "db/$DB" -> context.getDatabasePath(DB)
                            e.name.startsWith("prefs/") -> File(prefsDir, e.name.removePrefix("prefs/")).takeIf { it.name !in SKIP_PREFS }
                            e.name.startsWith("files/") -> File(context.filesDir, e.name.removePrefix("files/"))
                            else -> null
                        } ?: continue
                        val inside = listOf(context.getDatabasePath(DB).parentFile!!, prefsDir, context.filesDir).any { target.canonicalPath.startsWith(it.canonicalPath + File.separator) }
                        if (!inside) continue
                        target.parentFile?.mkdirs()
                        zip.getInputStream(e).use { input -> target.outputStream().use { input.copyTo(it) } }
                    }
                }
                File(prefsDir, LINK_PREFS).takeIf { it.isFile }?.let { f -> f.writeText(Pairing.put(f.readText(), ownPairing)) }
                Log.i(TAG, "Restored Hive Mobile from its backup")
            }.onFailure { Log.e(TAG, "Restore failed: ${it.message}", it) }
            pending.delete()
        }
    }
}

/** The PC pairing's entries in Hive Link's settings file (Android's shared-preferences XML). */
internal object Pairing {
    private val KEYS = listOf("token", "serverId", "name", "port", "deviceId", "hosts", "keyGivenFor")
    private val ENTRY = Regex("""<(\w+) name="(${KEYS.joinToString("|")})"(?: value="[^"]*" />|>[\s\S]*?</\1>)""")

    fun entries(xml: String): List<String> = ENTRY.findAll(xml).map { it.value }.toList()
    fun strip(xml: String): String = ENTRY.replace(xml, "")
    /** [xml] with its own pairing taken out and [own] put in. */
    fun put(xml: String, own: List<String>): String {
        val bare = strip(xml)
        val end = bare.lastIndexOf("</map>")
        return if (end < 0) bare else bare.substring(0, end) + own.joinToString("") { "$it\n" } + bare.substring(end)
    }
}
