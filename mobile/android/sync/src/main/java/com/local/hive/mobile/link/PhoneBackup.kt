package com.local.hive.mobile.link
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.LibraryDatabase

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.util.Log
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
 * playlists), every setting, installed plugins & settings, and the app's own files.
 *
 * Format v2 guarantees:
 * - Every archive embeds per-entry SHA-256 checksums + semantic counts inside `meta.json`.
 * - SQLite `VACUUM INTO` copies are verified (`PRAGMA quick_check` + SQLite header) before zipping.
 * - Shrink-guard preserves `.last-good` and protects `.daily` whenever counts drop sharply.
 * - Restore verifies ZIP CRC-32 + SQLite header + SHA-256 BEFORE staging & swapping with automatic rollback.
 * - PC uploads include `X-Backup-Sha256` for end-to-end transfer integrity.
 */
class PhoneBackup(
    private val context: Context,
    private val dao: LibraryDao,
    private val database: () -> LibraryDatabase,
    private val client: HiveLinkClient,
) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val lock = Mutex()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The copy on the phone. */
    val file: File get() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "Hive Mobile/Hive Mobile backup.zip")
    /** The latest copy made, for the PC (outside the folders it copies). */
    private val latest get() = File(context.noBackupFilesDir, "latest-backup.zip")

    private val canUseFile get() = Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()

    @Serializable data class Meta(
        val format: Int = 2,
        val savedAt: Long,
        val versionCode: Long = 0,
        val versionName: String = "",
        val device: String = "",
        val trackCount: Int = 0,
        val loveCount: Int = 0,
        val playlistCount: Int = 0,
        val playCount: Int = 0,
        val pluginCount: Int = 0,
        val checksums: Map<String, String> = emptyMap(),
    )

    /** A copy a fresh install may restore. [pcDevice] is set for one kept on the PC. */
    data class Offer(val savedAt: Long, val versionName: String, val deviceName: String, val pcDevice: String? = null, val local: File? = null, val picked: android.net.Uri? = null, val replaces: Boolean = false)

    /** Where the copies are, for Settings › Backup. Times are 0 when there's none yet. */
    data class Status(
        val phoneAt: Long,
        val canUsePhone: Boolean,
        val pcAt: Long,
        val cloudName: String?,
        val cloudAt: Long,
        val cloudError: String?,
        val trackCount: Int = 0,
        val loveCount: Int = 0,
        val playlistCount: Int = 0,
        val pluginCount: Int = 0,
        val verifiedAt: Long = 0,
        val lastVerifyMessage: String? = null,
    )
    private val _status = MutableStateFlow(readStatus())
    val status: StateFlow<Status> = _status.asStateFlow()
    private fun readStatus() = Status(
        phoneAt = if (canUseFile && file.isFile) file.lastModified() else if (latest.isFile) latest.lastModified() else 0,
        canUsePhone = canUseFile,
        pcAt = prefs.getLong("pcSentAt", 0),
        cloudName = prefs.getString("cloudName", null),
        cloudAt = prefs.getLong("cloudAt", 0),
        cloudError = prefs.getString("cloudError", null),
        trackCount = prefs.getInt("lastTrackCount", 0),
        loveCount = prefs.getInt("lastLoveCount", 0),
        playlistCount = prefs.getInt("lastPlaylistCount", 0),
        pluginCount = prefs.getInt("lastPluginCount", 0),
        verifiedAt = prefs.getLong("verifiedAt", 0),
        lastVerifyMessage = prefs.getString("lastVerifyMessage", null),
    )
    fun refreshStatus() { _status.value = readStatus() }

    private val _offer = MutableStateFlow<Offer?>(null)
    /** A backup this fresh install could restore, shown to the user until they answer. */
    val offer: StateFlow<Offer?> = _offer.asStateFlow()

    private val fresh get() = prefs.getBoolean("freshInstall", false)
    private val answered get() = prefs.getBoolean("answered", false)
    @Volatile private var lastBuilt = 0L

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

    /** A fresh install looks for a verified copy to offer: on the phone, and on the PC ([conn], when paired). */
    suspend fun lookForOffer(conn: HiveLinkClient.Connection?, ownDevice: String?) {
        if (!fresh || answered) return
        val found = listOfNotNull(_offer.value).toMutableList()
        // The phone's copy, unless this install made it (it then has nothing older to offer).
        if (canUseFile && !prefs.getBoolean("ownsLocal", false)) withContext(Dispatchers.IO) {
            listOf(file, File(file.path + ".previous"), File(file.path + ".last-good"), File(file.path + ".daily"))
                .mapNotNull { f ->
                    val res = BackupArchiveVerifier.verify(f)
                    if (res is BackupArchiveVerifier.Result.Verified) Offer(res.meta.savedAt, res.meta.versionName, res.meta.device, local = f) else null
                }
                .maxByOrNull { it.savedAt }
                ?.let(found::add)
        }
        if (conn != null) runCatching { client.phoneBackups(conn) }.getOrNull()
            ?.filter { it.device != ownDevice }?.maxByOrNull { it.savedAt }
            ?.let { found += Offer(it.savedAt, it.versionName, it.deviceName, pcDevice = it.device) }
        _offer.value = found.maxByOrNull { it.savedAt }
    }

    /** Starts this install as it is, keeping the copy where it was. */
    fun decline() {
        if (_offer.value?.picked == null) prefs.edit().putBoolean("answered", true).apply()
        _offer.value = null
    }

    /**
     * Restores [offer]: the copy is fetched and thoroughly verified (CRC-32 + SQLite header + SHA-256),
     * then Hive starts again and puts every file back atomically with rollback before anything opens them.
     * Throws when the copy can't be verified.
     */
    suspend fun restore(offer: Offer, conn: HiveLinkClient.Connection?) = withContext(Dispatchers.IO) {
        val pending = File(context.filesDir, PENDING)
        val part = File(pending.path + ".part")
        when {
            offer.local != null -> offer.local.copyTo(part, overwrite = true)
            offer.picked != null -> context.contentResolver.openInputStream(offer.picked)!!.use { input -> part.outputStream().use { input.copyTo(it) } }
            offer.pcDevice != null -> part.outputStream().use { out -> client.downloadPhoneBackup(conn ?: throw java.io.IOException("Hive on the PC can't be reached"), offer.pcDevice, out) }
        }
        val check = BackupArchiveVerifier.verify(part)
        if (check is BackupArchiveVerifier.Result.Invalid) {
            part.delete()
            throw java.io.IOException(check.reason)
        }
        if (!part.renameTo(pending)) {
            pending.delete()
            if (!part.renameTo(pending)) {
                part.copyTo(pending, overwrite = true)
                part.delete()
            }
        }
        // The file restored from is the cloud copy from now on (these settings outlive the restore).
        offer.picked?.let { keepCloud(it) }
        prefs.edit().putBoolean("answered", true).putLong("restoredFrom", offer.savedAt).commit()
        Log.i(TAG, "Restoring verified backup of ${offer.savedAt}: starting again")
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

    /** Runs a full integrity verification on the newest local backup (phone copy or internal latest). */
    suspend fun verifyLatest(): BackupArchiveVerifier.Result = lock.withLock {
        val result = withContext(Dispatchers.IO) {
            val target = when {
                canUseFile && file.isFile -> file
                latest.isFile -> latest
                else -> return@withContext BackupArchiveVerifier.Result.Invalid("No backup has been created yet.")
            }
            BackupArchiveVerifier.verify(target)
        }
        val msg = when (result) {
            is BackupArchiveVerifier.Result.Verified ->
                "Verified ${result.entryCount} files (${result.totalBytes / 1024} KB · ${result.meta.trackCount} songs, ${result.meta.loveCount} favorites, ${result.meta.playlistCount} playlists)"
            is BackupArchiveVerifier.Result.Invalid -> "Verification failed: ${result.reason}"
        }
        prefs.edit()
            .putLong("verifiedAt", if (result is BackupArchiveVerifier.Result.Verified) System.currentTimeMillis() else 0L)
            .putString("lastVerifyMessage", msg)
            .apply()
        refreshStatus()
        result
    }

    /** Forces an immediate verified backup locally and (when configured) to cloud. */
    suspend fun saveNow(conn: HiveLinkClient.Connection? = null): BackupArchiveVerifier.Result {
        save(atMostEveryMs = 0, force = true)
        if (conn != null) sendToPc(conn, everyMs = 0)
        return verifyLatest()
    }

    /** Makes a verified copy as things are now, and keeps it on the phone. Unchanged since the last: nothing is written. */
    suspend fun save(atMostEveryMs: Long = 0, force: Boolean = false) = lock.withLock {
        if (!maySave) return@withLock
        if (!force && atMostEveryMs > 0 && System.currentTimeMillis() - lastBuilt < atMostEveryMs) return@withLock
        lastBuilt = System.currentTimeMillis()
        withContext(Dispatchers.IO) {
            runCatching {
                val made = File(context.cacheDir, "backup.zip.part")
                val (hash, meta) = write(made)
                val verified = BackupArchiveVerifier.verify(made)
                if (verified is BackupArchiveVerifier.Result.Invalid) {
                    made.delete()
                    throw java.io.IOException("Newly built backup failed self-check: ${verified.reason}")
                }
                if (!force && hash == prefs.getString("hash", null) && latest.isFile && (!canUseFile || !mayWriteLocal() || file.isFile)) {
                    made.delete()
                    writeCloud()
                    return@runCatching
                }
                val prevMeta = readMeta(if (canUseFile && file.isFile) file else latest)
                val shrunk = BackupArchiveVerifier.shouldProtectExisting(prevMeta, meta)

                val latestTmp = File(latest.path + ".tmp")
                made.copyTo(latestTmp, overwrite = true)
                if (!latestTmp.renameTo(latest)) { latest.delete(); latestTmp.renameTo(latest) }

                if (canUseFile && mayWriteLocal()) {
                    val dir = file.parentFile!!.apply { mkdirs() }
                    val temp = File(dir, file.name + ".tmp")
                    made.copyTo(temp, overwrite = true)
                    if (file.isFile) {
                        if (shrunk) {
                            // Shrink guard: preserve the healthy archive before overwriting.
                            val lastGood = File(file.path + ".last-good")
                            file.copyTo(lastGood, overwrite = true)
                            Log.w(TAG, "Backup shrink detected (${prevMeta?.trackCount}→${meta.trackCount} tracks, ${prevMeta?.loveCount}→${meta.loveCount} loves); preserved .last-good")
                        }
                        file.copyTo(File(file.path + ".previous"), overwrite = true)
                    }
                    if (!temp.renameTo(file)) { file.delete(); temp.renameTo(file) }
                    // Rolling daily snapshot (refreshed at most once per 24h, NEVER overwritten by a shrunk archive).
                    val daily = File(file.path + ".daily")
                    if (!shrunk && (!daily.isFile || System.currentTimeMillis() - daily.lastModified() >= DAILY_MS)) {
                        val dailyTmp = File(daily.path + ".tmp")
                        file.copyTo(dailyTmp, overwrite = true)
                        if (!dailyTmp.renameTo(daily)) { daily.delete(); dailyTmp.renameTo(daily) }
                    }
                    prefs.edit().putBoolean("ownsLocal", true).apply()
                }
                made.delete()
                prefs.edit()
                    .putString("hash", hash)
                    .putInt("lastTrackCount", meta.trackCount)
                    .putInt("lastLoveCount", meta.loveCount)
                    .putInt("lastPlaylistCount", meta.playlistCount)
                    .putInt("lastPluginCount", meta.pluginCount)
                    .putLong("verifiedAt", System.currentTimeMillis())
                    .putBoolean("pcBehind", true)
                    .putBoolean("cloudBehind", true)
                    .apply()
                Log.i(TAG, "Verified backup saved (${latest.length() / 1024} KB · ${meta.trackCount} songs, ${meta.loveCount} loves, ${meta.playlistCount} playlists)")
                writeCloud(force = force)
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
     * A backup file the user picked (from a cloud, another phone, a download): thoroughly verified
     * and shown as the restore offer. Throws when it isn't a valid Hive Mobile backup.
     */
    suspend fun offerFile(uri: android.net.Uri) = withContext(Dispatchers.IO) {
        val copy = File(context.cacheDir, "picked-backup.zip")
        context.contentResolver.openInputStream(uri)!!.use { input -> copy.outputStream().use { input.copyTo(it) } }
        val check = BackupArchiveVerifier.verify(copy)
        copy.delete()
        if (check is BackupArchiveVerifier.Result.Invalid) throw java.io.IOException(check.reason)
        val meta = (check as BackupArchiveVerifier.Result.Verified).meta
        _offer.value = Offer(meta.savedAt, meta.versionName, meta.device, picked = uri, replaces = !(fresh && !answered))
    }

    /** Sends the latest verified copy to the PC with SHA-256 verification header. */
    suspend fun sendToPc(conn: HiveLinkClient.Connection, everyMs: Long = 15 * 60_000) = lock.withLock {
        if (!maySave || (!prefs.getBoolean("pcBehind", false) && everyMs > 0) || !latest.isFile) return@withLock
        if (everyMs > 0 && System.currentTimeMillis() - prefs.getLong("pcSentAt", 0) < everyMs) return@withLock
        runCatching {
            val check = BackupArchiveVerifier.verify(latest)
            if (check !is BackupArchiveVerifier.Result.Verified) return@runCatching
            client.sendPhoneBackup(conn, latest, check.meta.savedAt, check.meta.versionName, check.archiveSha256)
            prefs.edit().putBoolean("pcBehind", false).putLong("pcSentAt", System.currentTimeMillis()).apply()
            refreshStatus()
        }.onFailure { Log.w(TAG, "Backup not sent to the PC: ${it.message}") }
    }

    /** Writes a format v2 backup with per-entry SHA-256 checksums + counts; returns (contentHash, meta). */
    private suspend fun write(out: File): Pair<String, Meta> {
        val digest = MessageDigest.getInstance("SHA-256")
        val dbCopy = File(context.cacheDir, "backup-db.sqlite").apply { delete() }
        copyDatabase(dbCopy)
        if (!BackupArchiveVerifier.isValidSqliteFile(dbCopy)) {
            dbCopy.delete()
            throw java.io.IOException("Database snapshot failed SQLite header check.")
        }

        // Gather semantic counts for shrink-guard & backup health display.
        val trackCount = runCatching { dao.allTracks().size }.getOrDefault(0)
        val loveCount = runCatching { dao.allLove().count { it.loved } }.getOrDefault(0)
        val playlistCount = runCatching { dao.allPlaylistsOnce().size }.getOrDefault(0)
        val playCount = runCatching {
            database().openHelper.readableDatabase.query("SELECT COUNT(*) FROM plays").use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
        }.getOrDefault(0)
        val pluginCount = runCatching {
            val f = File(context.filesDir, "hive-plugins.json")
            if (f.isFile) org.json.JSONObject(f.readText()).optJSONArray("items")?.length() ?: 0 else 0
        }.getOrDefault(0)

        // Stage entries first so we compute exact per-entry SHA-256 checksums for meta.json.
        val payloadEntries = ArrayList<Pair<String, ByteArray>>()
        val fileEntries = ArrayList<Pair<String, File>>()
        val checksums = LinkedHashMap<String, String>()

        fun sha256Bytes(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        checksums["db/$DB"] = BackupArchiveVerifier.sha256(dbCopy)
        fileEntries += ("db/$DB" to dbCopy)

        prefsDir().listFiles().orEmpty()
            .filter { it.isFile && it.name.endsWith(".xml") && it.name !in SKIP_PREFS }
            .sortedBy { it.name }
            .forEach { f ->
                val name = "prefs/${f.name}"
                val stripped: ByteArray? = when {
                    f.name == LINK_PREFS -> PairingPrefs.strip(f.readText()).toByteArray()
                    Secrets.keysFor(f.name) != null -> Secrets.strip(f.readText(), Secrets.keysFor(f.name)!!).toByteArray()
                    else -> null
                }
                if (stripped != null) {
                    checksums[name] = sha256Bytes(stripped)
                    payloadEntries += (name to stripped)
                } else {
                    checksums[name] = BackupArchiveVerifier.sha256(f)
                    fileEntries += (name to f)
                }
            }

        context.filesDir.walkTopDown()
            .filter {
                it.isFile &&
                    it.name != PENDING &&
                    !it.path.contains("${File.separator}.restore-staging") &&
                    !it.path.contains("${File.separator}.pre-restore-rollback") &&
                    !it.name.endsWith(".apk") &&
                    !it.name.endsWith(".tmp") &&
                    !it.name.endsWith(".part") &&
                    !it.name.startsWith("profileInstalled") &&
                    !it.name.startsWith("profileinstaller") &&
                    it.length() < MAX_FILE
            }
            .sortedBy { it.path }
            .forEach { f ->
                val name = "files/" + f.relativeTo(context.filesDir).invariantSeparatorsPath
                checksums[name] = BackupArchiveVerifier.sha256(f)
                fileEntries += (name to f)
            }

        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val meta = Meta(
            format = 2,
            savedAt = System.currentTimeMillis(),
            versionCode = info.longVersionCode,
            versionName = info.versionName.orEmpty(),
            device = "${Build.MANUFACTURER} ${Build.MODEL}",
            trackCount = trackCount,
            loveCount = loveCount,
            playlistCount = playlistCount,
            playCount = playCount,
            pluginCount = pluginCount,
            checksums = checksums,
        )

        ZipOutputStream(out.outputStream().buffered()).use { zip ->
            zip.putNextEntry(ZipEntry(META))
            zip.write(json.encodeToString(Meta.serializer(), meta).toByteArray())
            zip.closeEntry()

            for ((name, bytes) in payloadEntries) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                digest.update(bytes)
                digest.update(name.toByteArray())
                zip.closeEntry()
            }
            for ((name, f) in fileEntries) {
                zip.putNextEntry(ZipEntry(name))
                f.inputStream().use { input ->
                    val buf = ByteArray(1 shl 16)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        zip.write(buf, 0, n)
                        digest.update(buf, 0, n)
                    }
                }
                digest.update(name.toByteArray())
                zip.closeEntry()
            }
        }
        dbCopy.delete()
        return digest.digest().joinToString("") { "%02x".format(it) } to meta
    }

    /** A consistent, integrity-checked copy of the library database while it's open. */
    private fun copyDatabase(to: File) {
        val db = database().openHelper.writableDatabase
        // Quick sanity check on live DB before copying.
        runCatching {
            db.query("PRAGMA quick_check(1)").use { c ->
                if (c.moveToFirst() && !c.getString(0).equals("ok", ignoreCase = true)) {
                    throw java.io.IOException("Live database failed PRAGMA quick_check")
                }
            }
        }.getOrThrow()
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
        private const val DAILY_MS = 24 * 60 * 60_000L
        /** This install's own answers, and what Android's job scheduler keeps, stay this install's. */
        private val SKIP_PREFS = setOf("$PREFS.xml", "androidx.work.util.preferences.xml", "WebViewChromiumPrefs.xml")

        /**
         * At the very start of Hive, before anything opens the database or settings: verifies the
         * pending backup archive completely, stages extraction, and swaps atomically with automatic
         * rollback if anything goes wrong. Called from HiveApp.onCreate.
         */
        fun applyPending(context: Context) {
            val pending = File(context.filesDir, PENDING)
            if (!pending.isFile) return
            runCatching {
                val prefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
                val ownPairing = File(prefsDir, LINK_PREFS).takeIf { it.isFile }?.readText()?.let(PairingPrefs::entries).orEmpty()
                val ownSecrets = Secrets.FILES.mapNotNull { (file, keys) -> File(prefsDir, file).takeIf { it.isFile }?.readText()?.let { file to Secrets.entries(it, keys) } }.toMap()

                BackupArchiveVerifier.extractAndSwapWithRollback(
                    zipFile = pending,
                    dbFile = context.getDatabasePath(DB),
                    prefsDir = prefsDir,
                    filesDir = context.filesDir,
                    skipPrefs = SKIP_PREFS,
                    keepFilesInFilesDir = setOf(PENDING),
                    stagingDir = File(context.filesDir, ".restore-staging"),
                    rollbackDir = File(context.filesDir, ".pre-restore-rollback"),
                    afterSwap = {
                        File(prefsDir, LINK_PREFS).takeIf { it.isFile }?.let { f -> f.writeText(PairingPrefs.put(f.readText(), ownPairing)) }
                        for ((file, own) in ownSecrets) {
                            if (own.isEmpty()) continue
                            val f = File(prefsDir, file)
                            f.writeText(Secrets.put(if (f.isFile) f.readText() else "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n</map>\n", own, Secrets.FILES.getValue(file)))
                        }
                    },
                )
                Log.i(TAG, "Restored verified Hive Mobile backup cleanly")
            }.onFailure { Log.e(TAG, "Restore aborted & rolled back: ${it.message}", it) }
            pending.delete()
        }
    }
}

/** The PC pairing's entries in Hive Link's settings file (Android's shared-preferences XML). */
internal object PairingPrefs {
    private val KEYS = listOf("token", "serverId", "name", "port", "deviceId", "hosts", "keyGivenFor", "coverKey", "helloSeenFor", "tlsPin", "tlsPort", "tlsFor")
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

/** Passwords and sign-ins in Hive's settings files: never in a backup copy (see PhoneBackup.write). */
internal object Secrets {
    val FILES = mapOf(
        "soulseek.xml" to listOf("password"),
        "spotify.xml" to listOf("access", "refresh", "verifier", "state"),
        "apple-music.xml" to listOf("mediaUserToken"),
        // The scrobbling settings hold the ListenBrainz token and the Last.fm session in one value.
        "scrobbling.xml" to listOf("settings"),
    )
    fun keysFor(file: String) = FILES[file]
    private fun entry(keys: List<String>) = Regex("""<(\w+) name="(${keys.joinToString("|") { Regex.escape(it) }})"(?: value="[^"]*" />|>[\s\S]*?</\1>)""")
    fun entries(xml: String, keys: List<String>): List<String> = entry(keys).findAll(xml).map { it.value }.toList()
    fun strip(xml: String, keys: List<String>): String = entry(keys).replace(xml, "")
    fun put(xml: String, own: List<String>, keys: List<String>): String {
        val bare = strip(xml, keys)
        val end = bare.lastIndexOf("</map>")
        return if (end < 0) bare else bare.substring(0, end) + own.joinToString("") { "$it\n" } + bare.substring(end)
    }
}
