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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.debounce
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
    val playlistImages by lazy { com.local.hive.mobile.data.PlaylistImages(this) }
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
    /** Hive Mobile updates from Hive on the PC (see AppUpdater). */
    val appUpdater: com.local.hive.mobile.link.AppUpdater by lazy { com.local.hive.mobile.link.AppUpdater(this, HiveLinkClient(), scope) { sync.pcConnection() } }
    val sync: SyncEngine by lazy { SyncEngine(database.dao(), linkStore, HiveLinkClient(), scope, afterSync = { scope.launch { keepSafeOnPc() }; scope.launch { sync.pcConnection()?.let { pcEdits.send(it); appUpdater.check(it) } }; scope.launch { runCatching { pcLibrary.refreshPlaylists() }; syncPlaylists() }; if (linkStore.songSync) com.local.hive.mobile.link.SongSync.schedule(this, now = true) }, onThemes = { themes.setPcThemes(it.themes, it.current) }, streamLoves = streamLoves, saveListening = { com.local.hive.mobile.data.ListeningFile.save(this, it) }) }
    val streamLoves by lazy { com.local.hive.mobile.link.StreamLoves(this) }
    /** Tag and cover edits on their way to Hive on the PC. */
    val pcEdits by lazy { com.local.hive.mobile.link.PcEdits(this, database.dao(), linkStore, pcTracks = { pcLibrary.tracks.value }) }
    /** Smart playlists made on the phone. */
    val smartPlaylists by lazy { com.local.hive.mobile.data.SmartPlaylists(this) }
    /** Soulseek downloads: queued, coming in, and the latest done. */
    val downloads by lazy { com.local.hive.mobile.soulseek.Downloads(this) }
    /** Hive Mobile as it is, kept on the phone and the PC where an uninstall can't reach it (see PhoneBackup). */
    val phoneBackup by lazy { com.local.hive.mobile.data.PhoneBackup(this, database.dao(), { database }, HiveLinkClient()) }
    /** Love kept in the song files themselves, as on the PC (see LoveFiles). */
    val loveFiles by lazy {
        com.local.hive.mobile.data.LoveFiles(this, database.dao(), scope, paired = { linkStore.pairing != null }, inUse = { com.local.hive.mobile.playback.OpenSongs.ids },
            mirrored = { com.local.hive.mobile.link.FileMirror(this).mirroredPhonePaths() })
    }
    private var backupJob: Job? = null
    /** Saves the backup a little later, once a burst of changes has settled. */
    fun backupSoon(delayMs: Long = 10_000) {
        synchronized(this) {
            backupJob?.cancel()
            backupJob = scope.launch { delay(delayMs); phoneBackup.save() }
        }
    }
    /**
     * After a scan, a sync, and whenever Hive comes on screen (All files access may just have been
     * given): a fresh install looks for a backup to offer, Loves go into the files, a copy is saved.
     */
    private suspend fun keepSafe() {
        phoneBackup.lookForOffer(conn = null, ownDevice = null)
        loveFiles.request()
        backupSoon(delayMs = 2_000)
    }
    /** After a sync: a backup kept on the PC is offered to a fresh install, and the phone's copy goes there. */
    private suspend fun keepSafeOnPc() {
        val conn = sync.pcConnection() ?: return
        phoneBackup.lookForOffer(conn, linkStore.pairing?.deviceId)
        phoneBackup.save()
        phoneBackup.sendToPc(conn)
    }
    val songSync by lazy { com.local.hive.mobile.link.SongSync(this, database.dao(), linkStore, HiveLinkClient(), sync) }
    private val playerConnection = lazy { PlayerConnection(this, scope) }
    val player by playerConnection
    /** A sleep timer is set to stop at the end of this song (no crossfade into the next). */
    val stopsAtSongEnd: Boolean get() = playerConnection.isInitialized() && player.sleep.value?.endOfSong == true
    /** The phone's playlists and Hive's, kept the same (see [com.local.hive.mobile.link.PlaylistSync]). */
    val playlistSync by lazy { com.local.hive.mobile.link.PlaylistSync(this, database.dao(), HiveLinkClient(), pcLibrary) }
    private suspend fun syncPlaylists() {
        runCatching { sync.pcConnection()?.let { playlistSync.run(it) { line -> android.util.Log.i("HiveSync", line) } } }
            .onFailure { android.util.Log.w("HiveSync", "playlists: ${it.message}") }
    }

    val pcLibrary by lazy { com.local.hive.mobile.link.PcLibrary(this, HiveLinkClient(), linkStore, sync) }
    val themes by lazy { ThemeStore(this) }
    val playRecorder = object : PlayRecorder {
        override fun record(trackId: Long, listenedMs: Long) {
            scope.launch { database.dao().insertPlay(Play(trackId = trackId, playedAt = System.currentTimeMillis(), listenedMs = listenedMs)); backupSoon(30_000) }
        }
        override fun recordPc(pcId: String, listenedMs: Long) {
            scope.launch { database.dao().insertPlay(Play(trackId = 0, playedAt = System.currentTimeMillis(), listenedMs = listenedMs, pcId = pcId)); backupSoon(30_000) }
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

    @OptIn(kotlinx.coroutines.FlowPreview::class)
    override fun onCreate() {
        super.onCreate()
        // A restore asked for puts Hive's files back before anything opens them.
        com.local.hive.mobile.data.PhoneBackup.applyPending(this)
        // Plays missed between songs before 2.19.4 go back in from Recently played, once.
        scope.launch { runCatching { if (com.local.hive.mobile.data.PlayRepair.runOnce(this@HiveApp, database.dao()) > 0) backupSoon(30_000) } }
        // A playlist made, changed or deleted here reaches Hive a few seconds later, not at the next sync.
        scope.launch {
            database.dao().playlists().map { l -> l.map { it.id to it.updatedAt } }.distinctUntilChanged().drop(1).debounce(3_000)
                .collect { if (linkStore.pairing != null) syncPlaylists() }
        }
        // Hive's notifications put no number on its icon. A channel's badge can't be changed once it
        // exists, so the ones made before that are replaced by new ones (their ids end in -2).
        getSystemService(android.app.NotificationManager::class.java).let { nm ->
            listOf("hive-downloads", "hive-song-deletions", "hive-song-sync", "updates", "default_channel_id").forEach { runCatching { nm.deleteNotificationChannel(it) } }
            nm.createNotificationChannel(android.app.NotificationChannel(com.local.hive.mobile.playback.PLAYBACK_CHANNEL, "Playback", android.app.NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        }
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
        // Loves go into the song files, and everything into the backup, as they change.
        scope.launch {
            val dao = database.dao()
            kotlinx.coroutines.flow.merge(
                dao.loveStates().map { it.size.toLong() + it.sumOf { l -> l.changedAt } },
                dao.playlists().map { l -> l.sumOf { it.updatedAt + it.trackCount } },
                dao.ratings().map { it.sumOf { r -> r.changedAt } },
                dao.favoriteAlbums().map { it.size.toLong() }, dao.favoriteItems().map { it.size.toLong() },
            ).drop(5).collect { loveFiles.request(); backupSoon() }
        }
        // The scheduled theme (Settings › Appearance) switches by itself.
        themes.runSchedule(scope)
        // Live Hive Link updates while Hive is on screen; the periodic worker
        // covers the rest of the time.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                scope.launch { keepSafe() }
                scope.launch { sync.syncNow(); sync.autoConnect() }
                sync.startLive()
            }
            override fun onStop(owner: LifecycleOwner) { sync.stopLive(); backupSoon(0) }
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

    private val tagYears by lazy { com.local.hive.mobile.data.TagYears(this) }
    private var yearJob: Job? = null

    /** Re-reads MediaStore, then re-matches against Hive so new files sync too. */
    suspend fun rescanLibrary() {
        if (!canReadMusic) { Log.i(TAG, "Library scan skipped: no permission to read music"); return }
        // Before the first scan fills anything in: whether this is a fresh install (see PhoneBackup).
        phoneBackup.noteInstall()
        var changed = 0
        scanMutex.withLock {
            _scanning.value = true
            try {
                val started = System.currentTimeMillis()
                // The music volume can be away for a moment (while the phone starts,
                // during an update, a remount): keep the library as it is and look again.
                val scanner = LibraryScanner(contentResolver)
                val tracks = try {
                    withContext(Dispatchers.IO) { tagYears.apply(scanner.scan(), scanner.modified) }
                } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) {
                    Log.w(TAG, "Library scan failed, trying again soon: ${e.message}")
                    scope.launch { delay(30_000); requestRescan(delayMs = 0) }
                    return
                }
                changed = database.dao().replaceLibrary(tracks)
                Log.i(TAG, "Library scan: ${tracks.size} tracks, $changed changed, in ${System.currentTimeMillis() - started} ms")
                // Years Android didn't read, from the songs' own tags, without holding the scan up.
                yearJob?.cancel()
                yearJob = scope.launch(Dispatchers.IO) {
                    val found = runCatching { tagYears.fill(contentResolver, tracks, scanner.modified) { database.dao().setYears(it) } }.getOrDefault(0)
                    if (found > 0) Log.i(TAG, "Years read from tags: $found")
                }
            } finally {
                _scanning.value = false
            }
        }
        // Re-matching downloads Hive's whole library and matches every song, so
        // it only runs when the phone's library actually changed (or never has).
        keepSafe()
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
