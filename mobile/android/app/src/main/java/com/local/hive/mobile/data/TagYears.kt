package com.local.hive.mobile.data

import android.content.ContentResolver
import android.content.Context
import java.io.File

/**
 * Release years Android's music index leaves out. It reads an MP3's year only from the old ID3v2.3
 * field (TYER), so a song tagged the current way (ID3v2.4's TDRC, as Hive on the PC and most taggers
 * write it) shows no year, even right after the year was edited. Hive reads those songs' years from
 * their own tags, in the background after a scan, and remembers each by the file's size and change
 * time, so a file is read again only when it changes.
 */
class TagYears(context: Context) {
    private val file = File(context.filesDir, "tag-years.txt")
    private data class Known(val size: Long, val modified: Long, val year: Int)

    private fun load(): Map<Long, Known> = runCatching {
        file.readLines().mapNotNull { line ->
            val p = line.split('\t'); if (p.size != 4) return@mapNotNull null
            p[0].toLong() to Known(p[1].toLong(), p[2].toLong(), p[3].toInt())
        }.toMap()
    }.getOrDefault(emptyMap())

    private fun save(known: Map<Long, Known>) {
        val tmp = File(file.path + ".tmp")
        tmp.writeText(known.entries.joinToString("\n") { (id, k) -> "$id\t${k.size}\t${k.modified}\t${k.year}" })
        tmp.renameTo(file)
    }

    private fun needs(t: Track) = t.year <= 0 && t.fileName.endsWith(".mp3", ignoreCase = true)

    /** The years already read, put on the songs Android gave none (before the library is saved). */
    fun apply(tracks: List<Track>, modified: Map<Long, Long>): List<Track> {
        if (tracks.none(::needs)) return tracks
        val known = load()
        return tracks.map { t ->
            val k = known[t.id]
            if (needs(t) && k != null && k.year > 0 && k.size == t.sizeBytes && k.modified == modified[t.id]) t.copy(year = k.year) else t
        }
    }

    /** Reads the songs not read yet; [set] gets each year found. Returns how many were found. */
    suspend fun fill(resolver: ContentResolver, tracks: List<Track>, modified: Map<Long, Long>, set: suspend (Map<Long, Int>) -> Unit): Int {
        val known = load().toMutableMap()
        val todo = tracks.filter { t -> needs(t) && known[t.id]?.let { it.size == t.sizeBytes && it.modified == modified[t.id] } != true }
        if (todo.isEmpty()) return 0
        var found = 0
        for (chunk in todo.chunked(200)) {
            val years = HashMap<Long, Int>()
            for (t in chunk) {
                val year = runCatching { resolver.openInputStream(t.uri)?.use(WavTags::readId3)?.year }.getOrNull() ?: 0
                known[t.id] = Known(t.sizeBytes, modified[t.id] ?: 0, year)
                if (year > 0) years[t.id] = year
            }
            if (years.isNotEmpty()) { set(years); found += years.size }
            // Gone songs are forgotten; kept as it goes, so a long first pass isn't read twice.
            save(known)
        }
        val ids = tracks.mapTo(HashSet()) { it.id }
        save(known.filterKeys { it in ids })
        return found
    }
}
