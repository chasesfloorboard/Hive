package com.local.hive.mobile.data

/**
 * M3U playlists, as Hive and MusicBee write them: #EXTM3U, then for each
 * song an #EXTINF line (seconds, "Artist - Title") and the file's path.
 */
object M3u {
    data class Entry(val path: String, val artist: String, val title: String, val seconds: Int)

    fun parse(text: String): List<Entry> {
        val out = mutableListOf<Entry>()
        var info: Triple<Int, String, String>? = null
        for (raw in text.removePrefix("﻿").lineSequence()) {
            val line = raw.trim()
            when {
                line.isEmpty() || line.startsWith("#EXTM3U") -> Unit
                line.startsWith("#EXTINF:", ignoreCase = true) -> {
                    val body = line.substringAfter(':')
                    val seconds = body.substringBefore(',').trim().toIntOrNull() ?: -1
                    val name = body.substringAfter(',', "").trim()
                    val dash = name.indexOf(" - ")
                    info = if (dash > 0) Triple(seconds, name.substring(0, dash).trim(), name.substring(dash + 3).trim()) else Triple(seconds, "", name)
                }
                line.startsWith("#") -> Unit
                else -> { out += Entry(line.replace('\\', '/'), info?.second.orEmpty(), info?.third.orEmpty(), info?.first ?: -1); info = null }
            }
        }
        return out
    }

    /** The library songs an M3U names: by file name first, then by artist and title. */
    fun match(entries: List<Entry>, library: List<Track>, byTags: (Entry) -> Track?): List<Track?> {
        val byFile = library.groupBy { it.fileName.lowercase() }
        return entries.map { e ->
            val file = e.path.substringAfterLast('/').lowercase()
            val candidates = byFile[file].orEmpty()
            // Same file name in two folders: the one whose folder ends the same way.
            candidates.singleOrNull() ?: candidates.firstOrNull { e.path.lowercase().endsWith((it.folder.trimEnd('/') + "/" + it.fileName).lowercase().substringAfterLast("/music/")) } ?: candidates.firstOrNull() ?: byTags(e)
        }
    }

    fun write(tracks: List<Track>): String = buildString {
        append("#EXTM3U\n")
        for (t in tracks) {
            append("#EXTINF:").append(t.durationMs / 1000).append(',').append(listOf(t.artist, t.title).filter { it.isNotBlank() }.joinToString(" - ")).append('\n')
            append(t.folder.trimEnd('/')).append('/').append(t.fileName).append('\n')
        }
    }
}
