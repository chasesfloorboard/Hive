package com.local.hive.mobile.link

import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.ZipFile

/**
 * Pure, unit-testable archive verification, shrink-guard, and transactional rollback
 * helpers for [PhoneBackup].
 *
 * Keeps backup integrity checks and safe restore staging independent of Android framework
 * classes so every corruption, tampering, path-traversal, shrink, and rollback case is
 * covered by fast JVM unit tests.
 */
object BackupArchiveVerifier {
    private const val META = "meta.json"
    private const val DB_ENTRY = "db/hive-library.db"
    private const val MIN_SQLITE_BYTES = 4096L
    private val SQLITE_HEADER = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
    private val json = Json { ignoreUnknownKeys = true }

    sealed class Result {
        data class Verified(
            val meta: PhoneBackup.Meta,
            val entryCount: Int,
            val totalBytes: Long,
            val archiveSha256: String,
        ) : Result()

        data class Invalid(val reason: String) : Result()
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun isValidSqliteHeader(bytes: ByteArray): Boolean {
        if (bytes.size < SQLITE_HEADER.size) return false
        for (i in SQLITE_HEADER.indices) {
            if (bytes[i] != SQLITE_HEADER[i]) return false
        }
        return true
    }

    fun isValidSqliteFile(file: File): Boolean {
        if (!file.isFile || file.length() < MIN_SQLITE_BYTES) return false
        val head = ByteArray(SQLITE_HEADER.size)
        file.inputStream().use { input ->
            if (input.read(head) != head.size) return false
        }
        return isValidSqliteHeader(head)
    }

    /**
     * Thoroughly verifies a Hive Mobile backup archive:
     * 1. Rejects path-traversal or absolute ZIP entry names.
     * 2. Streams EVERY entry to EOF (validating ZIP CRC-32 of every byte).
     * 3. Validates `meta.json` deserialization and `db/hive-library.db` SQLite magic header & minimum size.
     * 4. When `meta.checksums` is present (format >= 2), verifies every expected entry exists and its SHA-256 matches.
     */
    fun verify(file: File): Result {
        if (!file.isFile || file.length() <= 0L) return Result.Invalid("Backup file is missing or empty.")
        return runCatching {
            val archiveHash = sha256(file)
            ZipFile(file).use { zip ->
                val metaEntry = zip.getEntry(META) ?: return Result.Invalid("Backup is missing meta.json.")
                val metaText = zip.getInputStream(metaEntry).use { it.readBytes().decodeToString() }
                val meta = runCatching { json.decodeFromString(PhoneBackup.Meta.serializer(), metaText) }
                    .getOrElse { return Result.Invalid("Backup metadata could not be parsed.") }

                var sawDb = false
                var entryCount = 0
                var totalBytes = 0L
                val actualChecksums = LinkedHashMap<String, String>()

                for (entry in zip.entries().asSequence()) {
                    val name = entry.name
                    if (name.startsWith("/") || name.startsWith("\\") || name.split('/', '\\').any { it == ".." }) {
                        return Result.Invalid("Backup contains unsafe path: $name")
                    }
                    if (entry.isDirectory) continue
                    entryCount++

                    val entryDigest = MessageDigest.getInstance("SHA-256")
                    var entryBytes = 0L
                    val dbHead = if (name == DB_ENTRY) ByteArray(SQLITE_HEADER.size) else null
                    var dbHeadRead = 0

                    zip.getInputStream(entry).use { input ->
                        val buf = ByteArray(1 shl 16)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            entryDigest.update(buf, 0, n)
                            if (dbHead != null && dbHeadRead < dbHead.size) {
                                val take = minOf(n, dbHead.size - dbHeadRead)
                                System.arraycopy(buf, 0, dbHead, dbHeadRead, take)
                                dbHeadRead += take
                            }
                            entryBytes += n
                            totalBytes += n
                        }
                    }

                    if (name == DB_ENTRY) {
                        sawDb = true
                        if (entryBytes < MIN_SQLITE_BYTES || dbHead == null || dbHeadRead < dbHead.size || !isValidSqliteHeader(dbHead)) {
                            return Result.Invalid("Backup database is corrupted or not a valid SQLite file.")
                        }
                    }
                    if (name != META) {
                        actualChecksums[name] = entryDigest.digest().joinToString("") { "%02x".format(it) }
                    }
                }

                if (!sawDb) return Result.Invalid("Backup is missing the library database.")

                if (meta.checksums.isNotEmpty()) {
                    for ((expectedName, expectedHash) in meta.checksums) {
                        val actual = actualChecksums[expectedName]
                            ?: return Result.Invalid("Backup is missing expected file: $expectedName")
                        if (!actual.equals(expectedHash, ignoreCase = true)) {
                            return Result.Invalid("Checksum mismatch for $expectedName.")
                        }
                    }
                }

                Result.Verified(meta, entryCount, totalBytes, archiveHash)
            }
        }.getOrElse { err ->
            Result.Invalid(err.message ?: "Backup archive is damaged or unreadable.")
        }
    }

    /**
     * Shrink guard: returns true when [next] lost a large share of an existing healthy backup's
     * library/favorites/playlists/plays so the previous good archive should be preserved separately
     * as `.last-good` and never overwritten on `.daily`.
     */
    fun shouldProtectExisting(old: PhoneBackup.Meta?, next: PhoneBackup.Meta): Boolean {
        if (old == null) return false
        fun shrunk(prev: Int, curr: Int, minBase: Int): Boolean =
            prev >= minBase && (curr == 0 || curr < prev / 2)
        return shrunk(old.trackCount, next.trackCount, 5) ||
            shrunk(old.loveCount, next.loveCount, 5) ||
            shrunk(old.playlistCount, next.playlistCount, 2) ||
            shrunk(old.playCount, next.playCount, 10)
    }

    /**
     * Transactional staging & rollback extraction:
     * 1. Extracts all entries into [stagingDir] BEFORE touching live files.
     * 2. Moves current live targets into [rollbackDir].
     * 3. Moves staged files into live targets.
     * 4. If anything fails during swap, rolls back from [rollbackDir] automatically!
     */
    fun extractAndSwapWithRollback(
        zipFile: File,
        dbFile: File,
        prefsDir: File,
        filesDir: File,
        skipPrefs: Set<String>,
        keepFilesInFilesDir: Set<String>,
        stagingDir: File,
        rollbackDir: File,
        afterSwap: () -> Unit = {},
    ) {
        val verified = verify(zipFile)
        if (verified is Result.Invalid) throw IOException("Refusing to restore invalid backup: ${verified.reason}")

        stagingDir.deleteRecursively()
        rollbackDir.deleteRecursively()
        stagingDir.mkdirs()

        val stagedDb = File(stagingDir, "db/${dbFile.name}")
        val stagedPrefs = File(stagingDir, "prefs")
        val stagedFiles = File(stagingDir, "files")

        // Stage 1: Extract whole verified zip to stagingDir without touching live state.
        ZipFile(zipFile).use { zip ->
            for (e in zip.entries().asSequence().filter { !it.isDirectory }) {
                val target = when {
                    e.name == DB_ENTRY -> stagedDb
                    e.name.startsWith("prefs/") -> File(stagedPrefs, e.name.removePrefix("prefs/")).takeIf { it.name !in skipPrefs }
                    e.name.startsWith("files/") -> File(stagedFiles, e.name.removePrefix("files/"))
                    else -> null
                } ?: continue
                if (!target.canonicalPath.startsWith(stagingDir.canonicalPath + File.separator)) continue
                target.parentFile?.mkdirs()
                zip.getInputStream(e).use { input -> target.outputStream().use { input.copyTo(it) } }
            }
        }
        if (!isValidSqliteFile(stagedDb)) {
            stagingDir.deleteRecursively()
            throw IOException("Staged database failed validation.")
        }

        // Stage 2: Preserve current live state in rollbackDir before replacing.
        val rbDbDir = File(rollbackDir, "db").apply { mkdirs() }
        val rbPrefsDir = File(rollbackDir, "prefs").apply { mkdirs() }
        val rbFilesDir = File(rollbackDir, "files").apply { mkdirs() }

        fun moveOrCopy(src: File, dst: File) {
            dst.parentFile?.mkdirs()
            if (src.renameTo(dst)) return
            src.copyRecursively(dst, overwrite = true)
            src.deleteRecursively()
        }

        listOf(dbFile, File(dbFile.path + "-wal"), File(dbFile.path + "-shm")).forEach { f ->
            if (f.exists()) moveOrCopy(f, File(rbDbDir, f.name))
        }
        prefsDir.listFiles().orEmpty()
            .filter { it.isFile && it.name.endsWith(".xml") && it.name !in skipPrefs }
            .forEach { moveOrCopy(it, File(rbPrefsDir, it.name)) }
        filesDir.listFiles().orEmpty()
            .filter { it.name !in keepFilesInFilesDir && it != stagingDir && it != rollbackDir }
            .forEach { moveOrCopy(it, File(rbFilesDir, it.name)) }

        // Stage 3: Swap staged files into live locations; roll back completely on any error.
        try {
            moveOrCopy(stagedDb, dbFile)
            stagedPrefs.listFiles().orEmpty().forEach { f -> moveOrCopy(f, File(prefsDir, f.name)) }
            stagedFiles.listFiles().orEmpty().forEach { f -> moveOrCopy(f, File(filesDir, f.name)) }
            afterSwap()
        } catch (err: Throwable) {
            runCatching {
                listOf(dbFile, File(dbFile.path + "-wal"), File(dbFile.path + "-shm")).forEach { it.delete() }
                prefsDir.listFiles().orEmpty().filter { it.name.endsWith(".xml") && it.name !in skipPrefs }.forEach { it.delete() }
                filesDir.listFiles().orEmpty().filter { it.name !in keepFilesInFilesDir && it != stagingDir && it != rollbackDir }.forEach { it.deleteRecursively() }
                rbDbDir.listFiles().orEmpty().forEach { moveOrCopy(it, File(dbFile.parentFile!!, it.name)) }
                rbPrefsDir.listFiles().orEmpty().forEach { moveOrCopy(it, File(prefsDir, it.name)) }
                rbFilesDir.listFiles().orEmpty().forEach { moveOrCopy(it, File(filesDir, it.name)) }
            }
            stagingDir.deleteRecursively()
            rollbackDir.deleteRecursively()
            throw err
        }

        stagingDir.deleteRecursively()
        rollbackDir.deleteRecursively()
    }
}
