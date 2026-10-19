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
class HiveApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val database by lazy { LibraryDatabase.open(this) }
    val appleMusic by lazy { com.local.hive.mobile.stream.AppleMusic() }
    val spotify by lazy { com.local.hive.mobile.stream.Spotify() }
    val spotifyAccount by lazy { com.local.hive.mobile.stream.SpotifyAccount(this) }
    val linkStore by lazy { LinkStore(this) }
    val sync by lazy { SyncEngine(database.dao(), linkStore, HiveLinkClient(), scope) }
    val player by lazy { PlayerConnection(this, scope) }
    val themes by lazy { ThemeStore(this) }
    val playRecorder = PlayRecorder { trackId, listenedMs ->
        scope.launch { database.dao().insertPlay(Play(trackId = trackId, playedAt = System.currentTimeMillis(), listenedMs = listenedMs)) }
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
        // Live Hive Link updates while Hive is on screen; the periodic worker
        // covers the rest of the time.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                scope.launch { sync.syncNow() }
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
        scanMutex.withLock {
            _scanning.value = true
            try {
                val started = System.currentTimeMillis()
                val tracks = withContext(Dispatchers.IO) { LibraryScanner(contentResolver).scan() }
                database.dao().replaceLibrary(tracks)
                Log.i(TAG, "Library scan: ${tracks.size} tracks in ${System.currentTimeMillis() - started} ms")
            } finally {
                _scanning.value = false
            }
        }
        sync.rematch()
    }
}

private const val TAG = "Hive"

class SyncWorker(context: android.content.Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        (applicationContext as HiveApp).sync.syncNow()
        return Result.success()
    }
}
