package com.local.hive.mobile.soulseek

import android.content.ContentValues
import android.content.Context
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
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Google Drive links and pages, as Hive on the PC reads them (drive-import.js):
 * a folder shared as "Anyone with the link" is read from Drive's public folder
 * view, a file from its download address. No Google account is needed.
 */
object DriveLinks {
    data class Link(val kind: String, val id: String)
    data class Entry(val id: String, val name: String)
    data class Page(val title: String, val files: List<Entry>, val folders: List<Entry>)

    private const val ID = "[A-Za-z0-9_-]{10,}"
    val AUDIO = setOf("mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif", "wma", "alac")

    /** What a pasted link points at ("folder", "file", or "unknown" for an ?id= that could be either), or null. */
    fun parse(text: String): Link? {
        val s = text.trim()
        Regex("/folders/($ID)").find(s)?.let { return Link("folder", it.groupValues[1]) }
        Regex("/file/d/($ID)").find(s)?.let { return Link("file", it.groupValues[1]) }
        val q = Regex("[?&]id=($ID)").find(s) ?: return null
        if (!Regex("drive\\.google\\.com|docs\\.google\\.com|drive\\.usercontent\\.google\\.com").containsMatchIn(s)) return null
        return Link(if (Regex("/(uc|download)\\b").containsMatchIn(s)) "file" else "unknown", q.groupValues[1])
    }

    private fun decode(s: String) = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
        .replace(Regex("&#(\\d+);")) { String(Character.toChars(it.groupValues[1].toInt())) }

    /** Drive's public folder view: its title, files and subfolders. */
    fun page(html: String): Page {
        val title = decode(Regex("<title>([^<]*)</title>").find(html)?.groupValues?.get(1).orEmpty()).trim()
        val files = mutableListOf<Entry>(); val folders = mutableListOf<Entry>()
        Regex("<div class=\"flip-entry\" id=\"entry-([^\"]+)\"[\\s\\S]*?<a href=\"([^\"]+)\"[\\s\\S]*?class=\"flip-entry-title\">([^<]*)<").findAll(html).forEach { m ->
            val e = Entry(m.groupValues[1], decode(m.groupValues[3]).trim())
            if (m.groupValues[2].contains("/folders/")) folders += e else files += e
        }
        return Page(title, files, folders)
    }

    fun isAudio(name: String) = name.substringAfterLast('.', "").lowercase() in AUDIO
    fun safe(s: String) = s.replace(Regex("""[\\/:*?"<>|\u0000-\u001f]"""), "_").trim().trimEnd('.').take(120).ifBlank { "Untitled" }
    private val natural = Comparator<Entry> { a, b -> naturalCompare(a.name, b.name) }
    private fun naturalCompare(a: String, b: String): Int {
        val split = Regex("(\\d+)|(\\D+)")
        val x = split.findAll(a.lowercase()).map { it.value }.toList(); val y = split.findAll(b.lowercase()).map { it.value }.toList()
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]; val q = y[i]
            val c = if (p[0].isDigit() && q[0].isDigit()) (p.toBigInteger().compareTo(q.toBigInteger())) else p.compareTo(q)
            if (c != 0) return c
        }
        return x.size - y.size
    }
    fun sorted(list: List<Entry>) = list.sortedWith(natural)
}

/**
 * Imports a Google Drive folder (or one song) in the background: lists it, downloads each song
 * into Music/<downloads folder>/<Drive folder>/ (subfolders kept), shown in the download list
 * where it can be cancelled, then makes the songs a playlist named after the folder, in Drive's order.
 */
class DriveImportWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val app get() = applicationContext as com.local.hive.mobile.HiveApp
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
    private data class Song(val id: String, val name: String, val dir: String)

    override suspend fun doWork(): Result {
        val linkText = inputData.getString(KEY).orEmpty()
        val jobId = "drive:$linkText"
        val link = DriveLinks.parse(linkText) ?: return Result.success()
        if (app.downloads.isCancelled(jobId)) return Result.success()
        runCatching { setForeground(foreground("Looking in the Google Drive folder", "")) }
        val (title, songs) = try { list(link) } catch (e: Exception) {
            app.downloads.update(jobId) { it.copy(state = "failed", message = e.message ?: "Couldn't read that Google Drive link") }
            return Result.success()
        }
        if (songs.isEmpty()) { app.downloads.update(jobId) { it.copy(state = "failed", message = "There are no songs in that Google Drive folder") }; return Result.success() }
        val name = title.ifBlank { "Google Drive" }
        app.downloads.update(jobId) { it.copy(label = name, album = name, songs = songs.map { s -> DownloadSong(s.name.ifBlank { "Song" }) }, state = "downloading", message = "From Google Drive") }
        val settings = SoulseekSettings(applicationContext)
        val temp = File(applicationContext.cacheDir, "drive").apply { mkdirs() }
        val saved = mutableListOf<Long>()
        for ((i, s) in songs.withIndex()) {
            if (app.downloads.isCancelled(jobId)) break
            app.downloads.song(jobId, i) { it.copy(state = "downloading", percent = 0, from = "Google Drive") }
            runCatching { setForeground(foreground("Importing $name from Google Drive", "${i + 1} of ${songs.size}: ${s.name}")) }
            val part = File(temp, "${s.id}.part")
            val result = runCatching {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    val fileName = download(s, part) { got, size -> if (size > 0) app.downloads.song(jobId, i) { it.copy(percent = (got * 100 / size).toInt()) } }
                    save(part, settings, name, s.dir, fileName)
                }
            }
            part.delete()
            (result.exceptionOrNull() as? kotlinx.coroutines.CancellationException)?.let { throw it }
            result.onSuccess { uri -> saved += android.content.ContentUris.parseId(uri); app.downloads.song(jobId, i) { it.copy(state = "done", percent = 100) } }
                .onFailure { e -> app.downloads.song(jobId, i) { it.copy(state = "missing", percent = 0, from = e.message.orEmpty()) } }
        }
        if (saved.isNotEmpty()) {
            runCatching { app.rescanLibrary() }
            val have = app.database.dao().allTracks().mapTo(HashSet()) { it.id }
            val ids = saved.filter { it in have }
            if (ids.isNotEmpty()) {
                val now = System.currentTimeMillis()
                app.database.dao().createPlaylist(com.local.hive.mobile.data.Playlist(name = name, createdAt = now, updatedAt = now, source = "Google Drive", sourceUrl = linkText), ids)
            }
            if (app.linkStore.songSync) com.local.hive.mobile.link.SongSync.schedule(app, now = true)
        }
        val missing = songs.size - saved.size
        app.downloads.update(jobId) { it.copy(
            state = when { missing == 0 -> "done"; saved.isEmpty() -> "failed"; else -> "partial" },
            message = when { saved.isEmpty() -> "Couldn't download the songs from Google Drive"; missing == 0 -> "Imported as the playlist “$name”"; else -> "Imported ${saved.size} of ${songs.size} as the playlist “$name”" },
        ) }
        return Result.success()
    }

    private fun get(url: String) = http.newCall(Request.Builder().url(url).header("Accept-Language", "en").build()).execute()

    private fun folder(id: String): DriveLinks.Page = get("https://drive.google.com/embeddedfolderview?id=$id").use { res ->
        if (res.code == 404 || res.code == 403) throw IOException("That Google Drive folder isn't shared. Set it to “Anyone with the link” in Drive, then try again.")
        if (!res.isSuccessful) throw IOException("Google Drive answered ${res.code}")
        DriveLinks.page(res.body.string()).also { if (it.title.isBlank() && it.files.isEmpty() && it.folders.isEmpty()) throw IOException("That Google Drive folder isn't shared, or it's empty.") }
    }

    /** Every song in the folder and its subfolders (three levels down), in Drive's order. */
    private suspend fun list(link: DriveLinks.Link): Pair<String, List<Song>> = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        if (link.kind == "file") return@withContext "" to listOf(Song(link.id, "", ""))
        val top = runCatching { folder(link.id) }.getOrElse { if (link.kind == "unknown") return@withContext "" to listOf(Song(link.id, "", "")) else throw it }
        val songs = mutableListOf<Song>()
        fun walk(p: DriveLinks.Page, dir: String, depth: Int) {
            DriveLinks.sorted(p.files).filter { DriveLinks.isAudio(it.name) }.forEach { songs += Song(it.id, it.name, dir) }
            if (depth >= 3) return
            DriveLinks.sorted(p.folders).forEach { sub -> runCatching { walk(folder(sub.id), listOf(dir, DriveLinks.safe(sub.name)).filter { it.isNotBlank() }.joinToString("/"), depth + 1) } }
        }
        walk(top, "", 0)
        top.title to songs
    }

    /** Downloads one song to [to]; returns its file name. */
    private fun download(s: Song, to: File, progress: (Long, Long) -> Unit): String =
        get("https://drive.usercontent.google.com/download?id=${s.id}&export=download&confirm=t").use { res ->
            if (!res.isSuccessful) throw IOException(if (res.code == 404) "not shared" else "Google Drive answered ${res.code}")
            if (res.header("Content-Type").orEmpty().startsWith("text/html")) throw IOException("Google Drive is limiting downloads of it")
            val fromHeader = Regex("filename\\*?=(?:UTF-8'')?\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(res.header("Content-Disposition").orEmpty())?.groupValues?.get(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") }
            val name = s.name.ifBlank { fromHeader ?: "${s.id}.mp3" }
            if (!DriveLinks.isAudio(name)) throw IOException("not a song")
            val size = res.body.contentLength()
            var got = 0L
            to.outputStream().use { out -> res.body.byteStream().use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) { val n = input.read(buf); if (n < 0) break; out.write(buf, 0, n); got += n; progress(got, size) }
            } }
            if (size > 0 && got != size) throw IOException("stopped at $got of $size bytes")
            name
        }

    private fun save(part: File, settings: SoulseekSettings, title: String, dir: String, name: String): android.net.Uri {
        val base = settings.folder.split('/').filter { it.isNotBlank() }.joinToString("/") { DriveLinks.safe(it) }
        val folder = (listOf("Music", base, DriveLinks.safe(title)) + dir.split('/').filter { it.isNotBlank() }).filter { it.isNotBlank() }.joinToString("/", postfix = "/")
        val ext = name.substringAfterLast('.').lowercase()
        val mime = when (ext) { "flac" -> "audio/flac"; "mp3" -> "audio/mpeg"; "m4a", "aac", "alac" -> "audio/mp4"; "ogg", "oga" -> "audio/ogg"; "opus" -> "audio/opus"; "wav" -> "audio/wav"; else -> "audio/*" }
        val resolver = applicationContext.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Audio.Media.DISPLAY_NAME, DriveLinks.safe(name.substringBeforeLast('.')) + "." + ext)
            put(MediaStore.Audio.Media.MIME_TYPE, mime)
            put(MediaStore.Audio.Media.RELATIVE_PATH, folder)
            put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Audio.Media.getContentUri(settings.volumeNow(applicationContext)), values) ?: throw IOException("Couldn't save $name")
        try {
            resolver.openOutputStream(uri)!!.use { out -> part.inputStream().use { it.copyTo(out) } }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
        return uri
    }

    private fun foreground(title: String, line: String): ForegroundInfo {
        val nm = applicationContext.getSystemService(android.app.NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(android.app.NotificationChannel(CHANNEL, "Downloads", android.app.NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        val n = NotificationCompat.Builder(applicationContext, CHANNEL).setSmallIcon(com.local.hive.mobile.R.drawable.ic_stat_hive)
            .setContentTitle(title).setContentText(line).setProgress(0, 0, true).setOngoing(true).setSilent(true).build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(PROGRESS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(PROGRESS_ID, n)
    }

    companion object {
        private const val KEY = "link"
        private const val CHANNEL = "hive-downloads-2"
        private const val PROGRESS_ID = 4721

        /** Starts importing [link]; its progress shows in the download list. Returns false when it isn't a Google Drive link. */
        fun enqueue(context: Context, link: String): Boolean {
            if (DriveLinks.parse(link) == null) return false
            val text = link.trim()
            (context.applicationContext as com.local.hive.mobile.HiveApp).downloads.add(
                DownloadJob("drive:$text", "Google Drive", "Google Drive", "Google Drive folder", emptyList(), state = "searching", message = "Looking in the folder"))
            val work = OneTimeWorkRequestBuilder<DriveImportWorker>()
                .setInputData(Data.Builder().putString(KEY, text).build())
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("drive-import", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
            return true
        }
    }
}
