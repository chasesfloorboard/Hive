package com.local.hive.mobile

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.local.hive.mobile.data.LibraryDatabase
import com.local.hive.mobile.data.LibraryScanner
import com.local.hive.mobile.data.Play
import com.local.hive.mobile.link.HiveLinkClient
import com.local.hive.mobile.link.LinkStore
import com.local.hive.mobile.link.SyncEngine
import com.local.hive.mobile.playback.PlayRecorder
import com.local.hive.mobile.playback.PlayerConnection
import com.local.hive.mobile.ui.theme.ThemeStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** Owns the app-wide pieces: library database, Hive Link sync, playback and theme. */
class HiveApp : Application(), coil3.SingletonImageLoader.Factory {
    /** Coil, with album art read at full quality (see [com.local.hive.mobile.data.AlbumArtFetcher]). */
    override fun newImageLoader(context: coil3.PlatformContext): coil3.ImageLoader = coil3.ImageLoader.Builder(context)
        .components { add(com.local.hive.mobile.data.AlbumArtFetcher.Factory(this@HiveApp)) }
        // Room for many full-size covers, so ones already seen come back sharp instead of reloading.
        .memoryCache { coil3.memory.MemoryCache.Builder().maxSizePercent(context, 0.35).build() }
        .build()

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val database by lazy { LibraryDatabase.open(this) }
    val appleMusic by lazy { com.local.hive.mobile.stream.AppleMusic() }
    val spotify by lazy { com.local.hive.mobile.stream.Spotify() }
    val youTubeMusic by lazy { com.local.hive.mobile.stream.YouTubeMusic(this) }
    val likedAlbums by lazy { com.local.hive.mobile.data.LikedAlbums(this, database.dao()) }
    val spotifyAccount by lazy { com.local.hive.mobile.stream.SpotifyAccount(this) }
    val lyrics by lazy { com.local.hive.mobile.stream.LyricsProvider(this) }
    val equaliser by lazy { com.local.hive.mobile.playback.EqualiserStore(this) }
    val radio by lazy { com.local.hive.mobile.stream.RadioDirectory() }
    val radioStore by lazy { com.local.hive.mobile.stream.RadioStore(this) }
    val podcasts by lazy { com.local.hive.mobile.stream.PodcastDirectory() }
    val podcastStore by lazy { com.local.hive.mobile.stream.PodcastStore(this) }
    val scrobbler by lazy { com.local.hive.mobile.stream.Scrobbler(this) }
    val artistImages by lazy { com.local.hive.mobile.stream.ArtistImages(this) }
    val linkStore by lazy { LinkStore(this) }
    val sync: SyncEngine by lazy { SyncEngine(database.dao(), linkStore, HiveLinkClient(), scope, afterSync = { scope.launch { sync.pcConnection()?.let { pcEdits.send(it) } }; if (linkStore.songSync) com.local.hive.mobile.link.SongSync.schedule(this, now = true) }, onThemes = { themes.setPcThemes(it.themes, it.current) }, streamLoves = streamLoves, saveListening = { com.local.hive.mobile.data.ListeningFile.save(this, it) }) }
    val streamLoves by lazy { com.local.hive.mobile.link.StreamLoves(this) }
    /** Tag and cover edits on their way to Hive on the PC. */
    val pcEdits by lazy { com.local.hive.mobile.link.PcEdits(this, database.dao(), linkStore) }
    /** Smart playlists made on the phone. */
    val smartPlaylists by lazy { com.local.hive.mobile.data.SmartPlaylists(this) }
    /** Soulseek downloads: queued, coming in, and the latest done. */
    val downloads by lazy { com.local.hive.mobile.soulseek.Downloads(this) }
    val songSync by lazy { com.local.hive.mobile.link.SongSync(this, database.dao(), linkStore, HiveLinkClient(), sync) }
    private val playerConnection = lazy { PlayerConnection(this, scope) }
    val player by playerConnection
    /** A sleep timer is set to stop at the end of this song (no crossfade into the next). */
    val stopsAtSongEnd: Boolean get() = playerConnection.isInitialized() && player.sleep.value?.endOfSong == true
    val pcLibrary by lazy { com.local.hive.mobile.link.PcLibrary(this, HiveLinkClient(), linkStore, sync) }
    val themes by lazy { ThemeStore(this) }
    val playRecorder = object : PlayRecorder {
        override fun record(trackId: Long, listenedMs: Long) {
            scope.launch { database.dao().insertPlay(Play(trackId = trackId, playedAt = System.currentTimeMillis(), listenedMs = listenedMs)) }
        }
        override fun recordPc(pcId: String, listenedMs: Long) {
            scope.launch { database.dao().insertPlay(Play(trackId = 0, playedAt = System.currentTimeMillis(), listenedMs = listenedMs, pcId = pcId)) }
        }
        override fun history(item: androidx.media3.common.MediaItem) {
            // Android Auto lists songs as "<list>|<id>".
            val key = item.mediaId.substringAfterLast('|')
            // Radio and podcast episodes aren't songs.
            if (key.isBlank() || key.startsWith("radio:") || key.startsWith("pod:")) return
            scope.launch {
                val dao = database.dao()
                if (key.toLongOrNull() == null) {
                    val m = item.mediaMetadata
                    dao.insertStreamTrackIfAbsent(com.local.hive.mobile.data.StreamTrack(
                        key = key, source = key.substringBefore(':'), title = m.title?.toString().orEmpty(), artist = m.artist?.toString().orEmpty(),
                        album = m.albumTitle?.toString().orEmpty(), durationMs = m.durationMs ?: 0, artworkUrl = m.artworkUri?.toString().orEmpty(),
                        previewUrl = item.requestMetadata.extras?.getString(com.local.hive.mobile.playback.EXTRA_PREVIEW).orEmpty(), url = "",
                    ))
                }
                dao.upsertHistory(com.local.hive.mobile.data.HistoryEntry(key, System.currentTimeMillis()))
            }
        }
    }

    private val scanMutex = Mutex()
    private val _scanning = MutableStateFlow(false)
    val scanning = _scanning.asStateFlow()
    private var pendingRescan: Job? = null

    val canReadMusic: Boolean
        get() = ContextCompat.checkSelfPermission(
            this,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE,
        ) == PackageManager.PERMISSION_GRANTED

    override fun onCreate() {
        super.onCreate()
        // Read the library at every start and whenever MediaStore changes
        // (new downloads, files copied over USB, deletions), like Samsung Music.
        contentResolver.registerContentObserver(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true,
            object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) = requestRescan(delayMs = 3_000)
            },
        )
        requestRescan(delayMs = 0)
        likedAlbums.start(scope)
        // The scheduled theme (Settings › Appearance) switches by itself.
        themes.runSchedule(scope)
        // Live Hive Link updates while Hive is on screen; the periodic worker
        // covers the rest of the time.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                scope.launch { sync.syncNow(); sync.autoConnect() }
                sync.startLive()
            }
            override fun onStop(owner: LifecycleOwner) = sync.stopLive()
        })
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "hive-link-sync",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }

    /**
     * Schedules a rescan, coalescing bursts of MediaStore changes into one.
     * Only the wait is restarted: a scan already under way always finishes,
     * otherwise a busy MediaStore (it notifies often while indexing a large
     * library) would keep cancelling it.
     */
    fun requestRescan(delayMs: Long) {
        synchronized(this) {
            if (pendingRescan?.isActive == true && !scanStarted) pendingRescan?.cancel()
            else if (pendingRescan?.isActive == true) { rescanAgain = true; return }
            scanStarted = false
            pendingRescan = scope.launch {
                delay(delayMs)
                synchronized(this@HiveApp) { scanStarted = true }
                rescanLibrary()
                val again = synchronized(this@HiveApp) { rescanAgain.also { rescanAgain = false } }
                if (again) requestRescan(delayMs = 3_000)
            }
        }
    }
    private var scanStarted = false
    private var rescanAgain = false

    /** Re-reads MediaStore, then re-matches against Hive so new files sync too. */
    suspend fun rescanLibrary() {
        if (!canReadMusic) { Log.i(TAG, "Library scan skipped: no permission to read music"); return }
        var changed = 0
        scanMutex.withLock {
            _scanning.value = true
            try {
                val started = System.currentTimeMillis()
                // The music volume can be away for a moment (while the phone starts,
                // during an update, a remount): keep the library as it is and look again.
                val tracks = try {
                    withContext(Dispatchers.IO) { LibraryScanner(contentResolver).scan() }
                } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) {
                    Log.w(TAG, "Library scan failed, trying again soon: ${e.message}")
                    scope.launch { delay(30_000); requestRescan(delayMs = 0) }
                    return
                }
                changed = database.dao().replaceLibrary(tracks)
                Log.i(TAG, "Library scan: ${tracks.size} tracks, $changed changed, in ${System.currentTimeMillis() - started} ms")
            } finally {
                _scanning.value = false
            }
        }
        // Re-matching downloads Hive's whole library and matches every song, so
        // it only runs when the phone's library actually changed (or never has).
        if (changed > 0 || !linkStore.fullSyncDone) sync.rematch()
    }
}

private const val TAG = "Hive"

class SyncWorker(context: android.content.Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        (applicationContext as HiveApp).sync.syncNow()
        return Result.success()
    }
}
