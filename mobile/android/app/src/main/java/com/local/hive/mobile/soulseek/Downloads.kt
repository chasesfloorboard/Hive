package com.local.hive.mobile.soulseek

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** One song of a download: [state] is "waiting", "downloading" ([percent]), "done", or "missing" (nobody had it, or it failed). */
@Serializable data class DownloadSong(val title: String, val state: String = "waiting", val percent: Int = 0, val from: String = "")

/** An album or song being (or done being) downloaded: [state] is "queued", "searching", "downloading", "done", "partial" or "failed". */
@Serializable data class DownloadJob(
    val id: String,
    val artist: String,
    val album: String,
    val label: String,
    val songs: List<DownloadSong>,
    val state: String = "queued",
    val message: String = "",
    val at: Long = System.currentTimeMillis(),
) {
    val finished get() = state == "done" || state == "partial" || state == "failed"
    val doneCount get() = songs.count { it.state == "done" }
    /** 0..1 across the album, counting the song in progress. */
    val progress get() = if (songs.isEmpty()) 0f else (doneCount + songs.filter { it.state == "downloading" }.sumOf { it.percent } / 100f) / songs.size
}

/**
 * The download list: what is queued, what is coming in (song by song), and
 * the last downloads finished. Kept in a file so it survives Hive closing;
 * SoulseekWorker updates it as it goes.
 */
class Downloads(context: Context) {
    private val file = File(context.filesDir, "downloads.json")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val _jobs = MutableStateFlow(runCatching { json.decodeFromString<List<DownloadJob>>(file.readText()) }.getOrDefault(emptyList()))
    val jobs: StateFlow<List<DownloadJob>> = _jobs.asStateFlow()

    fun add(job: DownloadJob) = change { listOf(job) + it.filter { j -> j.id != job.id } }

    fun update(id: String, block: (DownloadJob) -> DownloadJob) = change { list -> list.map { if (it.id == id) block(it) else it } }

    fun song(id: String, index: Int, block: (DownloadSong) -> DownloadSong) =
        update(id) { j -> j.copy(songs = j.songs.mapIndexed { i, s -> if (i == index) block(s) else s }) }

    fun clearFinished() = change { list -> list.filterNot { it.finished } }

    private var lastSave = 0L

    @Synchronized private fun change(block: (List<DownloadJob>) -> List<DownloadJob>) {
        // Finished downloads beyond the latest 30 are forgotten.
        val before = _jobs.value
        val next = block(before).let { l -> l.filterNot { it.finished } + l.filter { it.finished }.take(30) }.sortedByDescending { it.at }
        _jobs.value = next
        // Progress ticks come often; the file is rewritten at most every 2 seconds, and whenever a download or song changes state.
        val now = System.currentTimeMillis()
        fun states(l: List<DownloadJob>) = l.map { j -> j.id + j.state + j.songs.joinToString("") { it.state } }
        if (now - lastSave > 2_000 || states(before) != states(next)) {
            lastSave = now
            runCatching { file.writeText(json.encodeToString(kotlinx.serialization.builtins.ListSerializer(DownloadJob.serializer()), next)) }
        }
    }
}
