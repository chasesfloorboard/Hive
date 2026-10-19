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
                remove("lastSeq"); remove("lastSyncAt"); remove("fullSyncDone")
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

    /** Highest PC change sequence applied here. */
    var lastSeq: Long
        get() = prefs.getLong("lastSeq", 0)
        set(value) = prefs.edit { putLong("lastSeq", value) }

    var lastSyncAt: Long
        get() = prefs.getLong("lastSyncAt", 0)
        set(value) = prefs.edit { putLong("lastSyncAt", value) }
}
