package com.local.hive.mobile.soulseek

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** The Soulseek account Hive downloads with, and the format it prefers. Kept on this phone only. */
class SoulseekSettings(context: Context) {
    private val app = context.applicationContext
    private val prefs = context.getSharedPreferences("soulseek", Context.MODE_PRIVATE)
    var username: String
        get() = prefs.getString("username", "").orEmpty()
        set(v) = prefs.edit().putString("username", v.trim()).apply()
    var password: String
        get() = prefs.getString("password", "").orEmpty()
        set(v) = prefs.edit().putString("password", v).apply()
    var quality: Quality
        get() = runCatching { Quality.valueOf(prefs.getString("quality", null) ?: "") }.getOrDefault(Quality.Lossless)
        set(v) = prefs.edit().putString("quality", v.name).apply()
    /** The storage downloads go to: MediaStore's volume name (the phone, or an SD card's id). Unchosen: where most music is. */
    var volume: String
        get() = prefs.getString("volume", null) ?: mostMusic.first
        set(v) = prefs.edit().putString("volume", v).apply()
    /** The folder inside Music/ that downloads go to, as <folder>/<artist>/<album>; blank for Music itself. Unchosen: where most music is. */
    var folder: String
        get() = prefs.getString("folder", null) ?: mostMusic.second
        set(v) = prefs.edit().putString("folder", v.trim().trim('/')).apply()

    /** Until chosen, downloads join the music already on the phone (MusicHome), else Music/Hive Downloads on the phone. */
    private val mostMusic: Pair<String, String> by lazy {
        com.local.hive.mobile.data.MusicHome.find(app)?.let { it.volume to it.folder } ?: (MediaStore.VOLUME_EXTERNAL_PRIMARY to "Hive Downloads")
    }
    val configured get() = username.isNotBlank() && password.isNotBlank()

    /** Where downloads go, said plainly: "Music/beautiful sounds pc on the SD card". */
    fun where(context: Context): String {
        val volume = volumeNow(context)
        val storage = if (volume == MediaStore.VOLUME_EXTERNAL_PRIMARY) "the phone" else storages(context).firstOrNull { it.first == volume }?.second?.let { "the $it" } ?: "the SD card"
        return "${listOf("Music", folder).filter { it.isNotBlank() }.joinToString("/")} on $storage"
    }

    /** Where downloads go, for the storage that's there now (an SD card taken out falls back to the phone). */
    fun volumeNow(context: Context) = volume.takeIf { it in MediaStore.getExternalVolumeNames(context) } ?: MediaStore.VOLUME_EXTERNAL_PRIMARY

    companion object {
        /** The phone's storage and any SD card, as (volume, name). */
        fun storages(context: Context): List<Pair<String, String>> {
            val sm = context.getSystemService(android.os.storage.StorageManager::class.java)
            return MediaStore.getExternalVolumeNames(context).sortedBy { it != MediaStore.VOLUME_EXTERNAL_PRIMARY }.map { v ->
                val volume = runCatching { sm.getStorageVolume(MediaStore.Files.getContentUri(v)) }.getOrNull()
                v to if (v == MediaStore.VOLUME_EXTERNAL_PRIMARY) "Phone" else (volume?.getDescription(context)?.takeIf { it.isNotBlank() } ?: "SD card")
            }
        }
    }
}

/** An album or song to download: who and what, and the tracklist to match folders against. */
@Serializable data class SoulseekRequest(
    val artist: String,
    val album: String,
    val tracks: List<Track>,
    /** "album" or "track". */
    val kind: String = "album",
    val id: String = java.util.UUID.randomUUID().toString(),
    /** Only a lossless copy will do: the song being replaced is already Hive's best lossy one. */
    val losslessOnly: Boolean = false,
) {
    /** [replaces]: the library song (a lossy download of Hive's) this download takes the place of. */
    @Serializable data class Track(val title: String, val durationMs: Long = 0, val replaces: Long? = null)
    val label get() = if (kind == "track") "${tracks.firstOrNull()?.title.orEmpty()} by $artist" else "$album by $artist"
}

/**
 * Downloads an album (or song) from Soulseek in the background: logs in,
 * searches, picks the best folder (AlbumPicker), and fetches the songs one by
 * one into Music/<folder>/<artist>/<album> on the phone or SD card (Settings › Soulseek). If a peer stops answering,
 * the songs still missing come from the next best folder. Hive's library picks
 * the files up from the phone's music index; song sync sends them to the PC.
 * One download runs at a time; more wait their turn.
 */
class SoulseekWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val json = Json { ignoreUnknownKeys = true }
    private var title = ""
    private var line = ""
    private var done = 0
    private var total = 0

    private val downloads get() = (applicationContext as com.local.hive.mobile.HiveApp).downloads

    override suspend fun doWork(): Result {
        val request = runCatching { json.decodeFromString(SoulseekRequest.serializer(), inputData.getString(KEY).orEmpty()) }.getOrNull() ?: return Result.success()
        val settings = SoulseekSettings(applicationContext)
        runCatching { logFile()?.writeText("") }
        log("Download: ${request.label} (${request.tracks.size} songs, prefer ${settings.quality}, to ${settings.volumeNow(applicationContext)} Music/${settings.folder})")
        if (downloads.jobs.value.none { it.id == request.id }) downloads.add(jobFor(request))
        // A run that was stopped (Hive closed by the system) starts over on the songs not yet done.
        downloads.update(request.id) { j -> j.copy(state = "searching", message = "Searching Soulseek…", songs = j.songs.map { if (it.state == "done") it else DownloadSong(it.title) }) }
        if (!settings.configured) { finish("Sign in to Soulseek to download", request, "failed"); return Result.success() }
        title = "Finding ${request.label}"
        line = "Searching Soulseek…"
        runCatching { setForeground(foreground()) }
        val client = SoulseekClient(settings.username, settings.password, log = ::log)
        try {
            client.login()
            val wanted = request.tracks.map { WantedTrack(it.title, it.durationMs) }
            val results = java.util.Collections.synchronizedList(mutableListOf<SearchResult>())
            var picks = emptyList<Pick>()
            for (query in queries(request)) {
                val token = client.search(query) { results += it }
                // Answers come in over several seconds; stop early once there's a good choice.
                for (i in 0 until 20) {
                    delay(1_000)
                    if (i >= 6) {
                        picks = synchronized(results) { AlbumPicker.candidates(request.artist, wanted, results.toList(), settings.quality) }
                        if (picks.count { it.freeSlot && it.files.size == wanted.size } >= 2) break
                    }
                }
                client.stopSearch(token)
                picks = synchronized(results) { AlbumPicker.candidates(request.artist, wanted, results.toList(), settings.quality) }
                if (request.losslessOnly) picks = picks.filter { it.format.startsWith("lossless") }
                log("\"$query\": ${results.size} peers answered, ${picks.size} folders fit; best: " + picks.take(3).joinToString { "${it.user} ${it.format} ${it.files.size}/${wanted.size} free=${it.freeSlot}" })
                if (picks.isNotEmpty()) break
            }
            if (picks.isEmpty() && request.losslessOnly) { finish("Nobody on Soulseek is sharing a lossless copy of ${request.label} right now", request, "failed"); return Result.success() }
            if (picks.isEmpty()) { finish("Couldn't find ${request.label} on Soulseek", request, "failed", offerSeeker = true); return Result.success() }

            val already = downloads.jobs.value.firstOrNull { it.id == request.id }?.songs.orEmpty()
            val needed = wanted.indices.filter { already.getOrNull(it)?.state != "done" }.toMutableSet()
            done = wanted.size - needed.size
            downloads.update(request.id) { it.copy(state = "downloading", message = "From ${picks.first().user} · ${formatName(picks.first().format)}") }
            total = needed.size
            title = "Downloading ${request.label}"
            val temp = File(applicationContext.cacheDir, "soulseek").apply { mkdirs() }
            for (pick in picks.take(6)) {
                if (needed.isEmpty()) break
                var fromPeer = 0
                for (i in needed.sorted()) {
                    val file = pick.files[i] ?: continue
                    line = "${file.name} · from ${pick.user}"
                    runCatching { setForeground(foreground()) }
                    downloads.song(request.id, i) { it.copy(state = "downloading", percent = 0, from = pick.user) }
                    downloads.update(request.id) { it.copy(message = "From ${pick.user} · ${formatName(pick.format)}") }
                    val part = File(temp, "${System.nanoTime()}.${file.extension}")
                    val got = runCatching {
                        client.download(pick.user, file.path, part, startWithinMs = if (fromPeer == 0) FIRST_START_MS else NEXT_START_MS, expectedSize = file.size) { bytes, size ->
                            line = "${file.name} · ${percent(bytes, size)} · from ${pick.user}"
                            runCatching { setForegroundAsync(foreground(bytes, size)) }
                            if (size > 0) downloads.song(request.id, i) { it.copy(percent = (bytes * 100 / size).toInt()) }
                        }
                    }
                    (got.exceptionOrNull() as? kotlinx.coroutines.CancellationException)?.let { part.delete(); throw it }
                    if (got.isFailure) {
                        log("${file.name} from ${pick.user} failed: ${got.exceptionOrNull()?.message}")
                        part.delete()
                        downloads.song(request.id, i) { it.copy(state = "waiting", percent = 0, from = "") }
                        client.ended?.let { throw SoulseekException(it) }
                        break
                    }
                    log("Got ${file.name} from ${pick.user}")
                    // A song that can't be saved is missed on its own; the rest of the album carries on.
                    val saved = runCatching { save(part, request, file, settings) }
                    part.delete()
                    if (saved.isFailure) {
                        log("Couldn't save ${file.name}: ${saved.exceptionOrNull()?.message}")
                        downloads.song(request.id, i) { it.copy(state = "waiting", percent = 0, from = "") }
                        continue
                    }
                    request.tracks[i].replaces?.let { old -> takeOver(old, saved.getOrThrow(), request) }
                    downloads.song(request.id, i) { it.copy(state = "done", percent = 100) }
                    fromPeer++
                    needed -= i
                    done++
                }
            }
            val missing = needed.size
            for (i in needed) downloads.song(request.id, i) { it.copy(state = "missing", percent = 0) }
            finish(when {
                missing == 0 -> "Downloaded ${request.label}"
                done == 0 -> "Couldn't download ${request.label}: nobody sharing it answered"
                else -> "Downloaded $done of $total songs of ${request.label}"
            }, request, when { missing == 0 -> "done"; done == 0 -> "failed"; else -> "partial" }, offerSeeker = missing > 0,
                // One song missing: look for that song; more: the album.
                seekerQuery = needed.singleOrNull()?.let { com.local.hive.mobile.stream.Seeker.albumQuery(request.artist, request.tracks[it].title) })
            if (done > 0) newSongs()
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Stopped by Android (it runs again later, keeping the songs already in): not a failure.
            log("Paused: $e")
            downloads.update(request.id) { j -> j.copy(state = "queued", message = "Waiting", songs = j.songs.map { if (it.state == "downloading") it.copy(state = "waiting", percent = 0) else it }) }
            throw e
        } catch (e: Exception) {
            log("Stopped: $e")
            downloads.update(request.id) { j -> j.copy(songs = j.songs.map { if (it.state == "done") it else it.copy(state = "missing", percent = 0) }) }
            finish("Soulseek: ${e.message ?: "download failed"}", request, if (done > 0) "partial" else "failed", offerSeeker = true)
            if (done > 0) newSongs()
        } finally {
            client.close()
        }
        return Result.success()
    }

    /** "Artist Album", then the album alone (some folders leave the artist out). */
    private fun queries(r: SoulseekRequest): List<String> {
        val first = com.local.hive.mobile.stream.Seeker.albumQuery(r.artist, if (r.kind == "track") r.tracks.firstOrNull()?.title.orEmpty() else r.album)
        val alone = com.local.hive.mobile.stream.Seeker.albumQuery("", if (r.kind == "track") r.tracks.firstOrNull()?.title.orEmpty() else r.album)
        return listOf(first, alone).distinct().filter { it.length >= 3 }
    }

    /**
     * The new songs into the library now, then song sync: it takes them to
     * Hive on the PC as soon as the phone is on Wi-Fi and the PC is reachable.
     */
    private suspend fun newSongs() {
        val app = applicationContext as com.local.hive.mobile.HiveApp
        runCatching { app.rescanLibrary() }
        if (app.linkStore.songSync) com.local.hive.mobile.link.SongSync.schedule(app, now = true)
    }

    private fun formatName(format: String) = when (format) {
        "lossless" -> "FLAC"; "lossless-hi" -> "FLAC 24-bit"; "mp3-320" -> "MP3 320"; "mp3-v0" -> "MP3 V0"; "mp3-256" -> "MP3 256"; "aac" -> "AAC"; else -> format.uppercase()
    }

    private fun jobFor(r: SoulseekRequest) = DownloadJob(r.id, r.artist, r.album, r.label, r.tracks.map { DownloadSong(it.title) }, message = "Waiting")

    /** Into Music/<folder>/<artist>/<album>/ on the chosen storage, through MediaStore, where the library (and song sync) find it. */
    private fun save(part: File, request: SoulseekRequest, file: SharedFile, settings: SoulseekSettings): android.net.Uri {
        fun safe(s: String) = s.replace(Regex("""[\\/:*?"<>|]"""), "_").trim().trimEnd('.').ifBlank { "Unknown" }.take(80)
        val base = settings.folder.split('/').filter { it.isNotBlank() }.joinToString("/") { safe(it) }
        val folder = listOf("Music", base, safe(request.artist), safe(if (request.kind == "track") "Singles" else request.album)).filter { it.isNotBlank() }.joinToString("/", postfix = "/")
        val mime = when (file.extension) { "flac" -> "audio/flac"; "mp3" -> "audio/mpeg"; "m4a", "aac", "alac" -> "audio/mp4"; "ogg" -> "audio/ogg"; "opus" -> "audio/opus"; "wav" -> "audio/wav"; else -> "audio/*" }
        val resolver = applicationContext.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Audio.Media.DISPLAY_NAME, safe(file.name.substringBeforeLast('.')).take(120) + "." + file.extension)
            put(MediaStore.Audio.Media.MIME_TYPE, mime)
            put(MediaStore.Audio.Media.RELATIVE_PATH, folder)
            put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Audio.Media.getContentUri(settings.volumeNow(applicationContext)), values) ?: throw SoulseekException("Couldn't save ${file.name}")
        try {
            resolver.openOutputStream(uri)!!.use { out -> part.inputStream().use { it.copyTo(out) } }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return uri
    }

    /**
     * The new copy takes the old one's place: its Favorites date and its playlist slots. Then the
     * old file is deleted (Hive saved it, so Android lets Hive delete it), and song sync sends its
     * copy on the PC to the PC's Trash.
     */
    private suspend fun takeOver(oldId: Long, newUri: android.net.Uri, request: SoulseekRequest) {
        val app = applicationContext as com.local.hive.mobile.HiveApp
        val dao = app.database.dao()
        val newId = android.content.ContentUris.parseId(newUri)
        val old = dao.allTracks().firstOrNull { it.id == oldId }
        dao.love(oldId)?.let { dao.upsertLove(listOf(it.copy(trackId = newId, pending = true))) }
        dao.moveTrackInPlaylists(oldId, newId)
        val gone = runCatching {
            applicationContext.contentResolver.delete(android.content.ContentUris.withAppendedId(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL), oldId), null, null) > 0
        }.getOrElse { log("Couldn't delete the old copy: $it"); false }
        log(if (gone) "Replaced ${old?.fileName ?: oldId}" else "Kept the old copy of ${old?.fileName ?: oldId}")
        if (gone && old != null) app.linkStore.replacedSongs = app.linkStore.replacedSongs +
            com.local.hive.mobile.link.SongPlanner.versionKey(old.title, old.artist, old.albumArtist, old.durationMs)
    }

    /** Kept in logcat (tag HiveSoulseek) and download-log.txt, for when a download doesn't go as planned. */
    private fun log(line: String) {
        android.util.Log.i("HiveSoulseek", line)
        runCatching { logFile()?.appendText("${java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())} $line\n") }
    }

    /** The latest download's log (download-log.txt, readable over USB); each download starts it afresh. */
    private fun logFile() = applicationContext.getExternalFilesDir(null)?.let { File(it, "download-log.txt") }

    private fun percent(bytes: Long, size: Long) = if (size > 0) "${bytes * 100 / size}%" else ""

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground()

    private fun channel(): NotificationManager {
        val nm = applicationContext.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Albums and songs downloading from Soulseek"
            })
        }
        return nm
    }

    private fun foreground(bytes: Long = 0, size: Long = 0): ForegroundInfo {
        channel()
        val progress = if (total > 0) ((done + if (size > 0) bytes.toDouble() / size else 0.0) * 1000 / total).toInt() else 0
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(com.local.hive.mobile.R.drawable.ic_stat_hive)
            .setContentTitle(if (total > 0) "$title · ${done + 1} of $total" else title)
            .setContentText(line)
            .setProgress(1000, progress, total == 0)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(PROGRESS_ID, notification)
    }

    /** The outcome, as its own notification; when songs are missing, a tap opens Seeker's search to pick them by hand. */
    private fun finish(message: String, request: SoulseekRequest, state: String, offerSeeker: Boolean = false, seekerQuery: String? = null) {
        downloads.update(request.id) { it.copy(state = state, message = message) }
        val nm = channel()
        val ctx = applicationContext
        val query = seekerQuery ?: com.local.hive.mobile.stream.Seeker.albumQuery(request.artist, if (request.kind == "track") request.tracks.firstOrNull()?.title.orEmpty() else request.album)
        // Not found here: Seeker opens on it, to pick by hand. Android lets Hive open it from the
        // background with "Display over other apps" (the lock player's permission); else the notification does.
        if (offerSeeker) com.local.hive.mobile.stream.Seeker.search(ctx, query)
        val seeker = if (offerSeeker && com.local.hive.mobile.stream.Seeker.installed(ctx)) PendingIntent.getActivity(
            ctx, request.id.hashCode(),
            Intent(Intent.ACTION_SEND).setType("text/plain").setPackage(com.local.hive.mobile.stream.Seeker.PACKAGE)
                .putExtra(Intent.EXTRA_SUBJECT, "$query - SoundCloud").putExtra(Intent.EXTRA_TEXT, query).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ) else null
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(com.local.hive.mobile.R.drawable.ic_stat_hive)
            .setContentTitle(message)
            .setContentText(if (seeker != null) "Tap to look for it in Seeker" else "In ${SoulseekSettings(ctx).where(ctx)}; song sync takes it to Hive on Wi-Fi")
            .setAutoCancel(true)
            .apply { if (seeker != null) setContentIntent(seeker) }
            .build()
        runCatching { nm.notify(request.id.hashCode(), n) }
    }

    companion object {
        private const val KEY = "request"
        private const val CHANNEL = "hive-downloads"
        // Not 4712-4713: song sync's.
        private const val PROGRESS_ID = 4720
        /** How long a peer that hasn't sent anything yet may take to start: past this, the next folder is tried. */
        private const val FIRST_START_MS = 40_000L
        /** Once a peer is sending the album, its later songs may wait in its queue longer. */
        private const val NEXT_START_MS = 300_000L

        /** Queues [request] behind any download already running. */
        fun enqueue(context: Context, request: SoulseekRequest) {
            (context.applicationContext as com.local.hive.mobile.HiveApp).downloads.add(
                DownloadJob(request.id, request.artist, request.album, request.label, request.tracks.map { DownloadSong(it.title) }, message = "Waiting"))
            val work = OneTimeWorkRequestBuilder<SoulseekWorker>()
                .setInputData(Data.Builder().putString(KEY, Json.encodeToString(SoulseekRequest.serializer(), request)).build())
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("soulseek", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
        }
    }
}
