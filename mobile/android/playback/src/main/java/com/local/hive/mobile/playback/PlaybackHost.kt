package com.local.hive.mobile.playback

import android.app.PendingIntent
import android.content.Context
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.PlayRecorder
import com.local.hive.mobile.data.RemoteMediaSource
import com.local.hive.mobile.data.StreamLoveState
import com.local.hive.mobile.data.SyncBridge
import com.local.hive.mobile.data.LinkStore
import com.local.hive.mobile.data.PodcastStorePort
import com.local.hive.mobile.data.ScrobblerPort
import com.local.hive.mobile.data.YouTubeMusicPort
import kotlinx.coroutines.flow.StateFlow

/**
 * Everything the playback service needs from the rest of the app, as one narrow contract the
 * composition root (HiveApp) implements. The service casts applicationContext to this instead of
 * reaching into HiveApp, so :playback depends only on :core — never on :streaming or :sync.
 * The paired-PC pieces come in through the :core contracts (RemoteMediaSource / SyncBridge /
 * StreamLoveState), which :sync's classes implement.
 */
interface PlaybackHost {
    val youTubeMusic: YouTubeMusicPort
    val scrobbler: ScrobblerPort
    val podcastStore: PodcastStorePort
    val equaliser: EqualiserStore
    val linkStore: LinkStore
    val dao: LibraryDao
    val playRecorder: PlayRecorder
    val stopsAtSongEnd: Boolean
    val remoteMedia: RemoteMediaSource
    val sync: SyncBridge
    val streamLoves: StreamLoveState
    /** The live theme accent as an ARGB int, for the home-screen widget. */
    val accentArgb: StateFlow<Int>
}

/**
 * The app-level UI the playback service touches (the launcher Activity and the lock-screen player),
 * behind a contract so :playback need not see MainActivity / LockPlayerActivity, which stay in :app.
 */
interface PlaybackUiBridge {
    /** A PendingIntent that opens the app on the now-playing screen (the media session's activity). */
    fun sessionActivityIntent(context: Context): PendingIntent
    /** Whether the app's own UI was the foreground app just before the screen locked. */
    fun wasRecentlyForeground(): Boolean
    /** Show Hive's lock-screen player if it's enabled and wanted. */
    fun showLockPlayerIfWanted(context: Context, hiveForeground: Boolean)
    /** The screen went off or came on while locked. */
    fun lockScreenChanged()
}
