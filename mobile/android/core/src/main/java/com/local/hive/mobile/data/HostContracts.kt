package com.local.hive.mobile.data

import android.net.Uri
import androidx.media3.common.MediaItem
import kotlinx.coroutines.flow.StateFlow

/*
 * Narrow contracts that let feature modules depend on :core instead of reaching into each other or
 * the concrete HiveApp. The paired-PC classes in :sync (PcLibrary, SyncEngine, StreamLoves) implement
 * the first three; PlayerConnection (:playback), and HiveApp (the composition root), implement the rest.
 * This is what breaks the old playback <-> link cycle: playback consumes these, never link directly.
 */

/** The paired PC's library as a media source (implemented by link.PcLibrary). */
interface RemoteMediaSource {
    /** Ids (without prefix) of PC-library songs currently loved, for the heart button. */
    val lovedIds: StateFlow<Set<String>>
    /** Resolve "pc:"-prefixed media ids to playable items. */
    suspend fun mediaItems(ids: List<String>): Map<String, MediaItem>
    /** Make sure the PC library is loaded (a no-op once it is). */
    suspend fun load()
    /** The player mediaId prefix for PC songs ("pc:"). */
    val mediaPrefix: String
}

/** The paired-PC sync operations the player needs (implemented by link.SyncEngine). */
interface SyncBridge {
    suspend fun setLoved(trackIds: Collection<Long>, loved: Boolean)
    fun setStreamLoved(title: String, artist: String, album: String, durationMs: Long, artworkUrl: String, mediaId: String, loved: Boolean)
    /** Whether [uri] is a stream served by the currently-paired PC. */
    fun isPcStream(uri: Uri): Boolean
}

/** Likes for streamed songs, reactive (implemented by link.StreamLoves). */
interface StreamLoveState {
    val loves: StateFlow<Map<String, StreamLove>>
}

/** The minimal transport the home-screen widget drives (implemented by playback.PlayerConnection). */
interface PlayerControls {
    fun togglePlay()
    fun next()
    fun previous()
}

/** The current theme accent as an ARGB int, reactive (implemented by HiveApp from its ThemeStore). */
interface AccentSource {
    val accentArgb: StateFlow<Int>
}

/** Asks the app to re-read the on-device library (implemented by HiveApp). */
interface RescanTrigger {
    fun requestRescan(delayMs: Long)
    suspend fun rescanLibrary()
}
