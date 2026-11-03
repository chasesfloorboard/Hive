package com.local.hive.mobile.data

import com.local.hive.mobile.playback.HISTORY_MS

/**
 * Before 2.19.4 a song that followed straight on from the one before (no pause, no skip) was never
 * counted: the counter didn't learn its length. Recently played still has each of those songs, so
 * the plays are put back from it, once. A song counts only when the next one started after it had
 * played for at least the counting rule (half its length or four minutes) and no later than its end
 * plus a minute, so a pause, a skip or a gap leaves it out. A song with a counted play already
 * around that time is left as it is.
 */
object PlayRepair {
    private const val SLACK = 60_000L

    fun missed(history: List<HistoryEntry>, plays: List<Play>, lengths: Map<Long, Long>): List<Play> {
        val byTrack = plays.groupBy { it.trackId }
        val sorted = history.sortedBy { it.playedAt }
        return sorted.zipWithNext().mapNotNull { (h, next) ->
            val id = h.key.toLongOrNull() ?: return@mapNotNull null
            val length = lengths[id]?.takeIf { it > 0 } ?: return@mapNotNull null
            // History is written HISTORY_MS into a song, so this gap is how long it played.
            val heard = next.playedAt - h.playedAt
            if (heard < minOf(length / 2, 4 * 60_000L) || heard > length + SLACK) return@mapNotNull null
            val started = h.playedAt - HISTORY_MS
            val ended = next.playedAt - HISTORY_MS
            if (byTrack[id].orEmpty().any { it.playedAt in (started - SLACK)..(ended + SLACK) }) return@mapNotNull null
            Play(trackId = id, playedAt = ended, listenedMs = minOf(heard, length))
        }
    }

    /** Once per phone: the plays go in like any other and reach Hive on the PC at the next sync. */
    suspend fun runOnce(context: android.content.Context, dao: LibraryDao): Int {
        val prefs = context.getSharedPreferences("repairs", android.content.Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY, false)) return 0
        val history = dao.allHistory()
        val since = (history.minOfOrNull { it.playedAt } ?: 0) - 60 * 60_000L
        val found = missed(history, dao.phonePlaysSince(since), dao.trackLengths().associate { it.id to it.durationMs })
        if (found.isNotEmpty()) dao.insertPlays(found)
        prefs.edit().putBoolean(KEY, true).apply()
        android.util.Log.i("HivePlays", "put back ${found.size} plays missed between songs")
        return found.size
    }

    private const val KEY = "gaplessPlays.v1"
}
