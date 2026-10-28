package com.local.hive.mobile.link

import android.content.Context
import androidx.core.content.edit

/** The paired Hive: where it is, the device token, and how far sync has read. */
data class Pairing(
    val serverId: String,
    val name: String,
    val port: Int,
    val token: String,
    val deviceId: String,
    /** Last address that worked first, then every LAN/Tailscale address Hive reported. */
    val hosts: List<String>,
)

class LinkStore(context: Context) {
    private val prefs = context.getSharedPreferences("hive-link", Context.MODE_PRIVATE)

    var pairing: Pairing?
        get() {
            val token = prefs.getString("token", null) ?: return null
            return Pairing(
                serverId = prefs.getString("serverId", "").orEmpty(),
                name = prefs.getString("name", "Hive").orEmpty(),
                port = prefs.getInt("port", HiveLinkClient.DEFAULT_PORT),
                token = token,
                deviceId = prefs.getString("deviceId", "").orEmpty(),
                hosts = prefs.getString("hosts", "").orEmpty().split('\n').filter { it.isNotBlank() },
            )
        }
        set(value) = prefs.edit {
            if (value == null) {
                remove("token"); remove("serverId"); remove("name"); remove("port"); remove("deviceId"); remove("hosts")
                remove("lastSeq"); remove("lastSyncAt"); remove("fullSyncDone"); remove("lastFullSyncAt"); remove("lastPcPlayAt"); remove("songSync")
            } else {
                putString("token", value.token)
                putString("serverId", value.serverId)
                putString("name", value.name)
                putInt("port", value.port)
                putString("deviceId", value.deviceId)
                putString("hosts", value.hosts.distinct().joinToString("\n"))
            }
        }

    /**
     * Whether the phone has matched itself against the whole PC library at
     * least once. Kept apart from [lastSeq]: a PC with no Love changes yet
     * really is at sequence 0.
     */
    var fullSyncDone: Boolean
        get() = prefs.getBoolean("fullSyncDone", false)
        set(value) = prefs.edit { putBoolean("fullSyncDone", value) }

    /** When every favorite was last compared with Hive's (see SyncEngine.fullSync). */
    var lastFullSyncAt: Long
        get() = prefs.getLong("lastFullSyncAt", 0)
        set(value) = prefs.edit { putLong("lastFullSyncAt", value) }

    /** The time of the newest Hive (PC) play brought to this phone. */
    var lastPcPlayAt: Long
        get() = prefs.getLong("lastPcPlayAt", 0)
        set(value) = prefs.edit { putLong("lastPcPlayAt", value) }

    /** Highest PC change sequence applied here. */
    var lastSeq: Long
        get() = prefs.getLong("lastSeq", 0)
        set(value) = prefs.edit { putLong("lastSeq", value) }

    /**
     * Song sync is on: songs on one side only are copied to the other on
     * Wi-Fi. Off until the user has seen the first plan and started it.
     */
    var songSync: Boolean
        get() = prefs.getBoolean("songSync", false)
        set(value) = prefs.edit { putBoolean("songSync", value) }

    /** Songs deleted on one side that the user chose to leave as they are: not asked about again. */
    var leftDeleted: Set<String>
        get() = prefs.getStringSet("leftDeleted", emptySet()).orEmpty()
        set(value) = prefs.edit { putStringSet("leftDeleted", value) }

    /**
     * Songs whose YouTube copy a Soulseek download replaced on this phone, as SongPlanner.versionKey:
     * the same copy on the PC goes to its Trash too, without asking, before song sync pairs anything.
     */
    var replacedSongs: Set<String>
        get() = prefs.getStringSet("replacedSongs", emptySet()).orEmpty()
        set(value) = prefs.edit { putStringSet("replacedSongs", value) }

    /** Deleted songs already announced in a notification, so each is announced once. */
    var announcedDeleted: Set<String>
        get() = prefs.getStringSet("announcedDeleted", emptySet()).orEmpty()
        set(value) = prefs.edit { putStringSet("announcedDeleted", value) }

    /** Plays of phone-only songs that older versions dropped have been queued again (once). */
    var droppedPlaysRequeued: Boolean
        get() = prefs.getBoolean("droppedPlaysRequeued", false)
        set(value) = prefs.edit { putBoolean("droppedPlaysRequeued", value) }

    /** Hive opening on the same Wi-Fi as the PC finds it and connects (asking the PC once to allow this phone). */
    var autoConnect: Boolean
        get() = prefs.getBoolean("autoConnect", true)
        set(value) = prefs.edit { putBoolean("autoConnect", value) }

    var lastSyncAt: Long
        get() = prefs.getLong("lastSyncAt", 0)
        set(value) = prefs.edit { putLong("lastSyncAt", value) }
}
