package com.local.hive.mobile.data

/**
 * Records plays and listening history. Implemented by HiveApp (the composition root) and consumed by
 * the playback service, so it lives in :core beside [HISTORY_MS] rather than in the playback module.
 */
fun interface PlayRecorder {
    fun record(trackId: Long, listenedMs: Long)
    /** A song streamed from Hive on the PC, by its id there. */
    fun recordPc(pcId: String, listenedMs: Long) {}
    /** A song listened to for [HISTORY_MS]: it goes into Recently played. */
    fun history(item: androidx.media3.common.MediaItem) {}
}
