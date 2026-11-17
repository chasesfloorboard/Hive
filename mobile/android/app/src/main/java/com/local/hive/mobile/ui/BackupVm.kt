package com.local.hive.mobile.ui

import com.local.hive.mobile.HiveApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Phone backup and restore (a cloud copy, the PC's copy of this phone, or a picked file),
 *  lifted out of MainViewModel, which delegates the backup calls here. */
class BackupVm(private val app: HiveApp, private val scope: CoroutineScope) {
    /** A backup a fresh install could restore (see PhoneBackup). */
    val restoreOffer = app.phoneBackup.offer
    fun declineRestore() = app.phoneBackup.decline()
    /** Where the backup copies are (Settings › Backup). */
    val backupStatus = app.phoneBackup.status
    fun refreshBackupStatus() = app.phoneBackup.refreshStatus()
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
