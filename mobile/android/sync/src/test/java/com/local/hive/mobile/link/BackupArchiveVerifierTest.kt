package com.local.hive.mobile.link

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class BackupArchiveVerifierTest {
    @get:Rule val tmp = TemporaryFolder()
    private val json = Json { encodeDefaults = true }

    private fun fakeSqliteBytes(tag: String = "live"): ByteArray {
        val bytes = ByteArray(4096)
        val header = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
        System.arraycopy(header, 0, bytes, 0, header.size)
        val marker = tag.toByteArray()
        System.arraycopy(marker, 0, bytes, 64, marker.size)
        return bytes
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun buildBackupZip(
        out: File,
        entries: Map<String, ByteArray>,
        tamperChecksums: Map<String, String>? = null,
        metaCounts: PhoneBackup.Meta = PhoneBackup.Meta(
            format = 2,
            savedAt = 1_795_000_000_000L,
            versionCode = 252,
            versionName = "2.20.0",
            device = "Test Phone",
            trackCount = 120,
            loveCount = 42,
            playlistCount = 8,
            playCount = 500,
            pluginCount = 2,
        ),
    ) {
        val checksums = tamperChecksums ?: entries.mapValues { (_, bytes) -> sha256(bytes) }
        val meta = metaCounts.copy(checksums = checksums)
        ZipOutputStream(out.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("meta.json"))
            zip.write(json.encodeToString(PhoneBackup.Meta.serializer(), meta).toByteArray())
            zip.closeEntry()
            for ((name, bytes) in entries) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
    }

    @Test fun verifyAcceptsValidFormat2ArchiveAndChecksEveryEntry() {
        val zip = tmp.newFile("good.zip")
        val dbBytes = fakeSqliteBytes("v2")
        val prefBytes = "<map><boolean name=\"ok\" value=\"true\" /></map>".toByteArray()
        val pluginBytes = """{"seededBuiltin":true,"items":[]}""".toByteArray()
        buildBackupZip(zip, mapOf(
            "db/hive-library.db" to dbBytes,
            "prefs/settings.xml" to prefBytes,
            "files/hive-plugins.json" to pluginBytes,
        ))
        val res = BackupArchiveVerifier.verify(zip)
        assertTrue("Expected verified, got $res", res is BackupArchiveVerifier.Result.Verified)
        val ok = res as BackupArchiveVerifier.Result.Verified
        assertEquals(4, ok.entryCount)
        assertEquals(120, ok.meta.trackCount)
        assertEquals(42, ok.meta.loveCount)
        assertEquals(2, ok.meta.pluginCount)
    }

    @Test fun verifyRejectsChecksumMismatchCorruptSqliteAndPathTraversal() {
        val badChecksum = tmp.newFile("bad-sha.zip")
        buildBackupZip(
            badChecksum,
            mapOf("db/hive-library.db" to fakeSqliteBytes()),
            tamperChecksums = mapOf("db/hive-library.db" to "0".repeat(64)),
        )
        assertTrue(BackupArchiveVerifier.verify(badChecksum) is BackupArchiveVerifier.Result.Invalid)

        val badDb = tmp.newFile("bad-db.zip")
        buildBackupZip(badDb, mapOf("db/hive-library.db" to "not sqlite".toByteArray()))
        assertTrue(BackupArchiveVerifier.verify(badDb) is BackupArchiveVerifier.Result.Invalid)

        val traversal = tmp.newFile("escape.zip")
        ZipOutputStream(traversal.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("meta.json"))
            zip.write("""{"format":1,"savedAt":1}""".toByteArray())
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("db/hive-library.db"))
            zip.write(fakeSqliteBytes())
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("files/../../evil.txt"))
            zip.write("boom".toByteArray())
            zip.closeEntry()
        }
        assertTrue(BackupArchiveVerifier.verify(traversal) is BackupArchiveVerifier.Result.Invalid)
    }

    @Test fun shrinkGuardProtectsGoodBackupWhenCountsCollapse() {
        val healthy = PhoneBackup.Meta(savedAt = 1, trackCount = 200, loveCount = 50, playlistCount = 6, playCount = 400)
        val normalEdit = healthy.copy(savedAt = 2, trackCount = 198, loveCount = 49)
        val wiped = healthy.copy(savedAt = 3, trackCount = 0, loveCount = 0, playlistCount = 0, playCount = 0)
        val halfLoves = healthy.copy(savedAt = 4, loveCount = 10)
        assertFalse(BackupArchiveVerifier.shouldProtectExisting(healthy, normalEdit))
        assertTrue(BackupArchiveVerifier.shouldProtectExisting(healthy, wiped))
        assertTrue(BackupArchiveVerifier.shouldProtectExisting(healthy, halfLoves))
        assertFalse(BackupArchiveVerifier.shouldProtectExisting(null, wiped))
    }

    @Test fun transactionalRestoreReplacesOnSuccessAndRollsBackCompletelyOnFailure() {
        val root = tmp.newFolder("app")
        val dbDir = File(root, "databases").apply { mkdirs() }
        val prefsDir = File(root, "shared_prefs").apply { mkdirs() }
        val filesDir = File(root, "files").apply { mkdirs() }
        val dbFile = File(dbDir, "hive-library.db").apply { writeBytes(fakeSqliteBytes("ORIGINAL")) }
        val livePref = File(prefsDir, "settings.xml").apply { writeText("ORIGINAL_PREF") }
        val livePlugins = File(filesDir, "hive-plugins.json").apply { writeText("ORIGINAL_PLUGINS") }
        val keepPending = File(filesDir, "restore-pending.zip")

        val backupZip = tmp.newFile("restore.zip")
        buildBackupZip(backupZip, mapOf(
            "db/hive-library.db" to fakeSqliteBytes("RESTORED"),
            "prefs/settings.xml" to "RESTORED_PREF".toByteArray(),
            "files/hive-plugins.json" to "RESTORED_PLUGINS".toByteArray(),
        ))
        backupZip.copyTo(keepPending, overwrite = true)

        // First: simulate failure in afterSwap — original files MUST be rolled back untouched!
        var threw = false
        try {
            BackupArchiveVerifier.extractAndSwapWithRollback(
                zipFile = keepPending,
                dbFile = dbFile,
                prefsDir = prefsDir,
                filesDir = filesDir,
                skipPrefs = setOf("phone-backup.xml"),
                keepFilesInFilesDir = setOf("restore-pending.zip"),
                stagingDir = File(filesDir, ".restore-staging"),
                rollbackDir = File(filesDir, ".pre-restore-rollback"),
                afterSwap = { throw IOException("simulated disk error mid-restore") },
            )
        } catch (_: IOException) { threw = true }
        assertTrue(threw)
        assertEquals("ORIGINAL_PREF", livePref.readText())
        assertEquals("ORIGINAL_PLUGINS", livePlugins.readText())
        assertTrue(String(dbFile.readBytes()).contains("ORIGINAL"))

        // Second: clean restore replaces DB, prefs, and plugins cleanly with no staging dirs left behind.
        BackupArchiveVerifier.extractAndSwapWithRollback(
            zipFile = keepPending,
            dbFile = dbFile,
            prefsDir = prefsDir,
            filesDir = filesDir,
            skipPrefs = setOf("phone-backup.xml"),
            keepFilesInFilesDir = setOf("restore-pending.zip"),
            stagingDir = File(filesDir, ".restore-staging"),
            rollbackDir = File(filesDir, ".pre-restore-rollback"),
        )
        assertEquals("RESTORED_PREF", livePref.readText())
        assertEquals("RESTORED_PLUGINS", livePlugins.readText())
        assertTrue(String(dbFile.readBytes()).contains("RESTORED"))
        assertFalse(File(filesDir, ".restore-staging").exists())
        assertFalse(File(filesDir, ".pre-restore-rollback").exists())
    }
}
