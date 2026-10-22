package com.local.hive.mobile.link

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.local.hive.mobile.data.LibraryDao
import com.local.hive.mobile.data.SyncedSong
import com.local.hive.mobile.data.Track
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

/** What song sync would copy: PC songs this phone lacks, and phone songs Hive lacks. */
data class SongPlan(
    val toPhone: List<PcTrack>,
    val toPc: List<Track>,
    /** Ledger keys of songs on both sides right now. */
    val onBoth: Set<String>,
    /** Each PC song's ledger key, and each phone song's. */
    val pcKeys: Map<String, String> = emptyMap(),
    val phoneKeys: Map<Long, String> = emptyMap(),
    /** For each phone song to send: how many copies of it Hive holds for the phone's other files. */
    val pcCopies: Map<Long, Int> = emptyMap(),
) {
    val bytesToPhone: Long get() = toPhone.sumOf { it.size }
    val bytesToPc: Long get() = toPc.sumOf { it.sizeBytes }
}

/**
 * Song sync's decisions, kept free of Android so they can be tested.
 *
 * The phone and the PC are kept one to one, file for file: each phone file is
 * paired with at most one PC file that is the same song ([TrackMatcher]: tags,
 * not files, as the phone keeps m4a where Hive keeps mp3), closest in length
 * first. Every file left without a partner is copied to the other side, so a
 * single and its album version, a remaster, or a song kept twice, are kept
 * twice on both. A file that has been on both before (the ledger) was deleted
 * on the side that lacks it, and stays deleted.
 */
object SongPlanner {
    /** A song as one side tags it, without its length (see [versionKey] for ledger keys). */
    fun keyOf(title: String, artist: String, albumArtist: String): String =
        TrackMatcher.normalize(title) + "|" + TrackMatcher.artistParts(albumArtist.ifBlank { artist }).sorted().joinToString(",")

    /** One version of a song: its key and length in whole seconds. */
    fun versionKey(title: String, artist: String, albumArtist: String, durationMs: Long): String =
        keyOf(title, artist, albumArtist) + "|" + (durationMs + 500) / 1000

    fun plan(phone: List<Track>, pc: List<PcTrack>, ledger: Set<String>): SongPlan {
        // Ledger keys per file; files that are the same version get #2, #3... in a fixed order.
        fun <T> numbered(items: List<T>, prefix: String, id: (T) -> Comparable<*>, key: (T) -> String): Map<T, String> {
            val count = HashMap<String, Int>()
            return items.sortedWith(compareBy { id(it) }).associateWith { t ->
                val k = prefix + key(t)
                val n = count.merge(k, 1, Int::plus)!!
                if (n == 1) k else "$k#$n"
            }
        }
        val phoneKeys = numbered(phone, "p:", { it.id }) { versionKey(it.title, it.artist, it.albumArtist, it.durationMs) }
        val pcKeys = numbered(pc, "c:", { it.id }) { versionKey(it.title, it.artist, it.albumArtist, it.duration) }

        // Pairs, closest in length first, each file used once.
        val pcIndex = TrackMatcher.Index(pc.map { TrackMatcher.Candidate(it.id, it.title, it.artist, it.albumArtist, it.duration) })
        val pcById = pc.associateBy { it.id }
        val candidates = ArrayList<Triple<Track, String, Long>>()
        val copiesOf = HashMap<Long, List<String>>()
        for (t in phone) {
            val found = pcIndex.matches(t.title, t.artist, t.albumArtist, t.durationMs)
            copiesOf[t.id] = found.map { it.key }
            found.forEach { c -> candidates += Triple(t, c.key, kotlin.math.abs(c.durationMs - t.durationMs)) }
        }
        candidates.sortWith(compareBy({ it.third }, { it.first.id }, { it.second }))
        val pairedPhone = HashSet<Long>()
        val pairedPc = HashSet<String>()
        val onBoth = HashSet<String>()
        for ((t, pcId, _) in candidates) {
            if (t.id in pairedPhone || pcId in pairedPc) continue
            pairedPhone += t.id; pairedPc += pcId
            onBoth += phoneKeys.getValue(t)
            pcById[pcId]?.let { onBoth += pcKeys.getValue(it) }
        }
        val toPc = phone.filter { it.id !in pairedPhone && phoneKeys.getValue(it) !in ledger && it.sizeBytes > 0 }
        val toPhone = pc.filter { it.id !in pairedPc && pcKeys.getValue(it) !in ledger }
        return SongPlan(
            toPhone, toPc, onBoth,
            pcKeys = pcKeys.mapKeys { it.key.id }, phoneKeys = phoneKeys.mapKeys { it.key.id },
            pcCopies = toPc.associate { it.id to copiesOf[it.id].orEmpty().size },
        )
    }
}

data class SongSyncState(
    val running: Boolean = false,
    val checking: Boolean = false,
    /** The last plan looked at, for the first-run preview and the status line. */
    val plan: PlanSummary? = null,
    val done: Int = 0,
    val total: Int = 0,
    val current: String = "",
    val failed: Int = 0,
    val message: String? = null,
)

data class PlanSummary(val toPhone: Int, val bytesToPhone: Long, val toPc: Int, val bytesToPc: Long, val pcTakesSongs: Boolean)

/**
 * Copies songs between this phone and Hive on the PC (see [SongPlanner]).
 * PC songs are saved through MediaStore under Music/Hive/<Artist>/<Album>/;
 * phone songs go to Hive's PUT /api/songs, which files them in the library
 * and refuses ones it already has.
 */
class SongSync(
    private val context: Context,
    private val dao: LibraryDao,
    private val store: LinkStore,
    private val client: HiveLinkClient,
    private val sync: SyncEngine,
) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(SongSyncState())
    val state: StateFlow<SongSyncState> = _state.asStateFlow()

    /** Works out what would be copied, without copying anything. */
    suspend fun check(): SongPlan? = mutex.withLock {
        _state.update { it.copy(checking = true, message = null) }
        try { planNow().first } catch (e: CancellationException) { throw e } catch (e: Exception) {
            _state.update { it.copy(message = e.message ?: e.javaClass.simpleName) }; null
        } finally { _state.update { it.copy(checking = false) } }
    }

    private suspend fun planNow(): Pair<SongPlan, HiveLinkClient.Connection> {
        val conn = sync.pcConnection() ?: throw IOException("Can't reach Hive on the PC. Is it open?")
        val info = client.info(conn)
        val plan = SongPlanner.plan(dao.allTracks(), client.library(conn).tracks, dao.syncedSongKeys().toHashSet())
        val now = System.currentTimeMillis()
        dao.addSyncedSongs(plan.onBoth.map { SyncedSong(it, now) })
        _state.update { it.copy(plan = PlanSummary(plan.toPhone.size, plan.bytesToPhone, plan.toPc.size, plan.bytesToPc, info.songs.receive)) }
        return plan to conn
    }

    /** Copies everything the plan holds. Returns false when it should be tried again later. */
    suspend fun run(onProgress: suspend (SongSyncState) -> Unit = {}): Boolean = mutex.withLock {
        if (!store.songSync) return true
        _state.update { it.copy(running = true, done = 0, total = 0, failed = 0, current = "", message = null) }
        try {
            val (plan, conn) = planNow()
            val pcTakesSongs = _state.value.plan?.pcTakesSongs == true
            val uploads = if (pcTakesSongs) plan.toPc else emptyList()
            _state.update { it.copy(total = plan.toPhone.size + uploads.size) }
            val free = StatFs(Environment.getExternalStorageDirectory().path).availableBytes
            // Leave room for the phone itself; downloads stop well before the disk is full.
            var budget = free - 2L * 1024 * 1024 * 1024
            for (song in plan.toPhone) {
                if (song.size > budget) { _state.update { it.copy(message = "This phone is nearly full, so some songs from the PC weren't copied.") }; break }
                step("${song.title} — ${song.artist}", onProgress) { download(conn, song, plan) }
                budget -= song.size
            }
            for (track in uploads) step("${track.title} — ${track.artist}", onProgress) { upload(conn, track, plan) }
            // Songs Hive just took are new there: matching again (once Hive has
            // scanned them) lets plays waiting on them count in Hive's Wrap.
            if (uploads.isNotEmpty()) sync.matchAgainNextSync()
            if (!pcTakesSongs && plan.toPc.isNotEmpty()) _state.update { it.copy(message = "Hive on the PC isn't taking songs from the phone (Settings › Connections there).") }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(message = e.message ?: e.javaClass.simpleName) }
            false
        } finally {
            _state.update { it.copy(running = false, current = "") }
        }
    }

    private suspend fun step(label: String, onProgress: suspend (SongSyncState) -> Unit, work: suspend () -> Unit) {
        _state.update { it.copy(current = label) }
        onProgress(_state.value)
        try { work() } catch (e: CancellationException) { throw e } catch (e: Exception) {
            android.util.Log.w("HiveSongSync", "$label: ${e.message}")
            _state.update { it.copy(failed = it.failed + 1) }
        }
        _state.update { it.copy(done = it.done + 1) }
    }

    private suspend fun download(conn: HiveLinkClient.Connection, song: PcTrack, plan: SongPlan) {
        val resolver = context.contentResolver
        val clean = { v: String, fallback: String -> v.replace(Regex("""[\\/:*?"<>|\x00-\x1f]+"""), "_").trim().trimStart('.').take(120).ifBlank { fallback } }
        val ext = song.file.substringAfterLast('.', "mp3").lowercase()
        val name = clean(song.file, "${clean(song.title, "Untitled")}.$ext")
        val folder = "Music/Hive/${clean(song.albumArtist.ifBlank { song.artist }, "Unknown Artist")}/${clean(song.album, "Unknown Album")}"
        val values = ContentValues().apply {
            put(MediaStore.Audio.Media.DISPLAY_NAME, name)
            put(MediaStore.Audio.Media.MIME_TYPE, MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "audio/mpeg")
            put(MediaStore.Audio.Media.RELATIVE_PATH, folder)
            put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
            ?: throw IOException("Android wouldn't make room for the song.")
        try {
            resolver.openOutputStream(uri)?.use { client.downloadTrack(conn, song.id, it) } ?: throw IOException("Couldn't write the song.")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        // The PC's file is on both now; the phone's copy is entered when the next plan pairs it.
        plan.pcKeys[song.id]?.let { dao.addSyncedSongs(listOf(SyncedSong(it, System.currentTimeMillis()))) }
    }

    private suspend fun upload(conn: HiveLinkClient.Connection, track: Track, plan: SongPlan) {
        val meta = buildMap {
            // How many copies of this song Hive holds for the phone's other files: one more is a version Hive keeps.
            put("have", (plan.pcCopies[track.id] ?: 0).toString())
            put("title", track.title); put("artist", track.artist); put("albumArtist", track.albumArtist); put("album", track.album)
            put("duration", track.durationMs.toString())
            if (track.trackNumber > 0) put("track", track.trackNumber.toString())
            if (track.discNumber > 0) put("disc", track.discNumber.toString())
            if (track.year > 0) put("year", track.year.toString())
        }
        val ext = track.fileName.substringAfterLast('.', "").lowercase()
        val result = client.uploadSong(conn, meta, ext, track.sizeBytes) {
            context.contentResolver.openInputStream(track.uri) ?: throw IOException("Couldn't read ${track.fileName}.")
        }
        if (result.status == "saved" || result.status == "exists") {
            plan.phoneKeys[track.id]?.let { dao.addSyncedSongs(listOf(SyncedSong(it, System.currentTimeMillis()))) }
        }
    }

    companion object {
        private const val WORK = "hive-song-sync"

        /** Runs song sync in the background on Wi-Fi (or any unmetered network). */
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK, ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<SongSyncWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build())
                    .build(),
            )
        }

        fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork(WORK)
    }
}

/** Song sync as a foreground data-sync job, so a long copy survives the app being closed. */
class SongSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as com.local.hive.mobile.HiveApp
        runCatching { setForeground(foreground(SongSyncState())) }
        val ok = app.songSync.run { state -> runCatching { setForeground(foreground(state)) } }
        return if (ok) Result.success() else Result.retry()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground(SongSyncState())

    private fun foreground(state: SongSyncState): ForegroundInfo {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Song sync", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Copying songs between this phone and Hive on your PC"
            })
        }
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(com.local.hive.mobile.R.drawable.ic_stat_hive)
            .setContentTitle(if (state.total > 0) "Syncing songs with Hive · ${state.done} of ${state.total}" else "Syncing songs with Hive")
            .setContentText(state.current)
            .setProgress(state.total, state.done, state.total == 0)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTIFICATION_ID, notification)
    }

    private companion object {
        const val CHANNEL = "hive-song-sync"
        const val NOTIFICATION_ID = 4711
    }
}
