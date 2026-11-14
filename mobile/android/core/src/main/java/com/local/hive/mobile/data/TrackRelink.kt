package com.local.hive.mobile.data

/**
 * Songs are kept by Android's number for the file. That number is the phone's own: a new phone, a
 * restored backup or Android rebuilding its music index gives the same files other numbers, and a
 * number once used for one song may now be a different song. So at each scan, a song that is no
 * longer under its old number is found again under its new one, and everything kept for it (plays,
 * Love, ratings, playlist places, Recently played) goes with it:
 * - by its file (folder and name), else
 * - by its tags (title, artist, album, length to the second) when exactly one song has them.
 * A song not found again keeps its things aside, under a number no song can have, so a different
 * song that now has its old number doesn't take them.
 */
object TrackRelink {
    data class Result(val moved: Map<Long, Long>, val aside: Set<Long>) {
        val isEmpty get() = moved.isEmpty() && aside.isEmpty()
    }

    private fun path(t: Track) = t.folder.trim('/').lowercase() + "/" + t.fileName.lowercase()
    private fun tags(t: Track) = listOf(t.title, t.artist, t.album).joinToString("\u0000") { it.trim().lowercase() } + "\u0000" + (t.durationMs + 500) / 1000

    /** The same song under the same number: its file, or (moved or retagged) at least its title. */
    private fun same(a: Track, b: Track) = path(a) == path(b) || a.title.trim().equals(b.title.trim(), ignoreCase = true)

    fun find(before: Collection<Track>, scanned: List<Track>): Result {
        val now = scanned.associateBy { it.id }
        // Songs no longer under their number, and numbers that are new or now another song.
        val lost = before.filter { old -> now[old.id]?.let { same(old, it) } != true }
        if (lost.isEmpty()) return Result(emptyMap(), emptySet())
        val beforeIds = before.associateBy { it.id }
        val arrived = scanned.filter { new -> beforeIds[new.id]?.let { same(it, new) } != true }
        val byPath = arrived.groupBy(::path)
        val byTags = arrived.groupBy(::tags)
        val taken = HashSet<Long>()
        val moved = LinkedHashMap<Long, Long>()
        fun take(old: Track, candidates: List<Track>?): Boolean {
            val c = candidates?.filter { it.id !in taken } ?: return false
            if (c.size != 1) return false
            moved[old.id] = c[0].id; taken += c[0].id; return true
        }
        val rest = lost.filterNot { take(it, byPath[path(it)]) }
        val unfound = rest.filterNot { take(it, byTags[tags(it)]) }
        // A lost song's number that now belongs to another song: its things go aside.
        val aside = unfound.mapTo(HashSet()) { it.id }.filterTo(HashSet()) { it in now }
        // A song "moved" to its own number is nothing to do.
        return Result(moved.filter { (a, b) -> a != b }, aside)
    }

    /**
     * Each song keeps the day it first came to the phone. Android dates a file by when it was last
     * written: a song whose tags were rewritten (its plays or rating saved into the file, a fresh
     * copy from the PC) comes back dated today, under its number or a new one, and would be
     * "Recently added" though it's been here for years.
     */
    fun keepAdded(before: Map<Long, Track>, lost: Map<Long, LostTrack>, r: Result, scanned: List<Track>): List<Track> {
        val from = HashMap<Long, Long>()
        for ((old, new) in r.moved) (before[old]?.dateAdded ?: lost[old]?.dateAdded)?.let { from[new] = it }
        return scanned.map { t ->
            val was = from[t.id] ?: before[t.id]?.takeIf { t.id !in r.moved && t.id !in r.aside }?.dateAdded
            if (was != null && was > 0 && was < t.dateAdded) t.copy(dateAdded = was) else t
        }
    }
}
