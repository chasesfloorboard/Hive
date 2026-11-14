package com.local.hive.mobile.link

/**
 * Tiny contracts the app-side workers and receivers in this package use to reach the composition
 * root without naming HiveApp, so :sync depends only downward. HiveApp implements both.
 */

/** AppUpdater's install-result BroadcastReceiver reports the outcome back through this. */
interface InstallReporter {
    fun installEnded(cancelled: Boolean, message: String?)
}

/** The song-sync worker reaches the live SongSync through this. */
interface SongSyncHost {
    val songSync: SongSync
}
