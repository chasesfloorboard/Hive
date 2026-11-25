package com.local.hive.mobile.ui

import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.link.BackupArchiveVerifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Phone backup and restore (local verified copy, PC copy, cloud copy, or a picked file),
 *  lifted out of MainViewModel, which delegates the backup calls here. */
class BackupVm(private val app: HiveApp, private val scope: CoroutineScope) {
    /** A backup a fresh install could restore (see PhoneBackup). */
    val restoreOffer = app.phoneBackup.offer
    fun declineRestore() = app.phoneBackup.decline()
    /** Where the backup copies are (Settings › Backup). */
    val backupStatus = app.phoneBackup.status
    fun refreshBackupStatus() = app.phoneBackup.refreshStatus()
    fun backUpNow(onResult: (String) -> Unit) = scope.launch {
        runCatching {
            val conn = runCatching { app.sync.pcConnection() }.getOrNull()
            when (val res = app.phoneBackup.saveNow(conn)) {
                is BackupArchiveVerifier.Result.Verified ->
                    "Verified backup saved (${res.entryCount} files · ${res.meta.trackCount} songs, ${res.meta.loveCount} favorites, ${res.meta.playlistCount} playlists)."
                is BackupArchiveVerifier.Result.Invalid -> "Backup check warning: ${res.reason}"
            }
        }.onSuccess(onResult).onFailure { onResult("Backup failed: ${it.message ?: it.javaClass.simpleName}") }
    }
    fun verifyBackup(onResult: (String) -> Unit) = scope.launch {
        runCatching {
            when (val res = app.phoneBackup.verifyLatest()) {
                is BackupArchiveVerifier.Result.Verified ->
                    "Integrity OK: ${res.entryCount} files matched SHA-256 & SQLite check (${res.meta.trackCount} songs, ${res.meta.loveCount} favorites, ${res.meta.playlistCount} playlists)."
                is BackupArchiveVerifier.Result.Invalid -> "Integrity issue: ${res.reason}"
            }
        }.onSuccess(onResult).onFailure { onResult("Verify failed: ${it.message ?: it.javaClass.simpleName}") }
    }
    fun backUpToCloud(uri: android.net.Uri) = scope.launch { app.phoneBackup.setCloud(uri) }
    fun stopCloudBackup() = app.phoneBackup.stopCloud()
    /** The newest backup the PC keeps from another install, shown as the restore offer; false when there's none. */
    fun offerPcBackup(onResult: (String?) -> Unit) = scope.launch {
        runCatching {
            val conn = app.sync.pcConnection() ?: return@runCatching "Hive on your PC can't be reached right now."
            if (app.phoneBackup.offerFromPc(conn, app.linkStore.pairing?.deviceId) == null) "Hive on your PC has no other backup of this phone." else null
        }.onSuccess(onResult).onFailure { onResult(it.message ?: it.javaClass.simpleName) }
    }
    /** A backup file picked to restore from: shown as the restore offer once checked. */
    fun offerBackupFile(uri: android.net.Uri, onError: (String) -> Unit) = scope.launch {
        runCatching { app.phoneBackup.offerFile(uri) }.onFailure { onError(it.message ?: it.javaClass.simpleName) }
    }
    fun restoreBackup(offer: com.local.hive.mobile.link.PhoneBackup.Offer, onError: (String) -> Unit) = scope.launch {
        runCatching { app.phoneBackup.restore(offer, if (offer.pcDevice != null) app.sync.pcConnection() else null) }
            .onFailure { onError(it.message ?: it.javaClass.simpleName) }
    }
}
