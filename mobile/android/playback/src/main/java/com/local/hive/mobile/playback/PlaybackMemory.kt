package com.local.hive.mobile.playback

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.local.hive.mobile.data.LibraryDao

/**
 * Hive's playback-state on the phone: the queue, the current track and
 * position, shuffle and repeat, kept so a relaunch picks up where it left off.
 * The queue is written only when it changes; the cursor every few seconds.
 */
class PlaybackMemory(
    context: Context,
    private val dao: LibraryDao,
    /** Where a streamed song plays from: in full when it can be, else its preview; null when it can't play. */
    private val streamUri: (com.local.hive.mobile.data.StreamTrack) -> String? = { null },
    private val pcItems: suspend (List<String>) -> Map<String, MediaItem> = { emptyMap() },
) {
    private val prefs = context.getSharedPreferences("playback-state", Context.MODE_PRIVATE)

    data class Restored(val items: List<MediaItem>, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeatMode: Int)

    fun saveQueue(player: Player) {
        val ids = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
        // A radio station or podcast never replaces the music kept for resuming: plugging the phone in
        // (the car, headphones) after the radio picks the music back up, not the station.
        if (ids.isNotEmpty() && ids.all(::notMusic)) return
        prefs.edit().putString(KEY_QUEUE, ids.joinToString(SEPARATOR)).apply()
        saveCursor(player)
    }

    fun saveCursor(player: Player) {
        if (player.mediaItemCount == 0) return
        if (player.currentMediaItem?.mediaId?.let(::notMusic) == true) return
        prefs.edit()
            .putString(KEY_CURRENT, player.currentMediaItem?.mediaId)
            .putInt(KEY_INDEX, player.currentMediaItemIndex)
            .putLong(KEY_POSITION, player.currentPosition.coerceAtLeast(0))
            .putBoolean(KEY_SHUFFLE, player.shuffleModeEnabled)
            .putInt(KEY_REPEAT, player.repeatMode)
            .apply()
    }

    /** The saved queue as playable items, skipping songs no longer on the phone. */
    suspend fun restore(): Restored? {
        val ids = prefs.getString(KEY_QUEUE, null)?.split(SEPARATOR)?.filter { it.isNotBlank() }.orEmpty()
        if (ids.isEmpty()) return null
        val local = ids.mapNotNull { it.toLongOrNull() }.distinct().chunked(900).flatMap { dao.tracks(it) }.associate { it.id.toString() to it.toMediaItem() }
        val streamed = ids.filter { it.toLongOrNull() == null }.distinct().chunked(900).flatMap { dao.streamTracks(it) }
            .mapNotNull { s -> streamUri(s)?.let { s.key to s.toMediaItem(it) } }.toMap()
        val fromPc = pcItems(ids.filter { it.startsWith("pc:") }.distinct())
        val playable = local + streamed + fromPc
        val kept = ids.filter { it in playable }
        if (kept.isEmpty()) return null
        val current = prefs.getString(KEY_CURRENT, null)
        val savedIndex = prefs.getInt(KEY_INDEX, 0)
        val index = resumeIndex(ids, playable.keys, kept, current, savedIndex)
        // Keep the saved position only when we actually resumed on the saved song; if that song is
        // gone we start somewhere else, where the old position would be meaningless (or past the end).
        val position = if (kept.getOrNull(index) == current) prefs.getLong(KEY_POSITION, 0) else 0
        return Restored(
            items = kept.map { playable.getValue(it) },
            index = index,
            positionMs = position,
            shuffle = prefs.getBoolean(KEY_SHUFFLE, false),
            repeatMode = prefs.getInt(KEY_REPEAT, Player.REPEAT_MODE_OFF),
        )
    }

    companion object {
        /**
         * Where to resume in the playable queue, never out of range. `ids` is the full saved queue;
         * `playable` is which of those ids can still play; `kept` is the playable ids in order (what
         * the player will actually hold); `current`/`savedIndex` are the saved cursor.
         *
         * The same song can appear twice, so when the saved slot still holds the current (playable)
         * song, resume on that exact occurrence; otherwise fall back to its first occurrence. If the
         * saved song is gone the result is clamped into [0, kept.size-1] — the old code could return
         * `kept.size` (every playable id sat before a now-deleted current), which seeks past the end
         * and crashes media3 with IllegalSeekPositionException.
         */
        fun resumeIndex(ids: List<String>, playable: Set<String>, kept: List<String>, current: String?, savedIndex: Int): Int {
            if (kept.isEmpty()) return 0
            val raw = when {
                current == null -> 0
                ids.getOrNull(savedIndex) == current && current in playable -> ids.take(savedIndex).count { it in playable }
                else -> kept.indexOf(current)
            }
            return raw.coerceIn(0, kept.size - 1)
        }

        /** A radio station or podcast episode, not a song. */
        fun notMusic(mediaId: String) = mediaId.startsWith("radio:") || mediaId.startsWith("pod:")
        private const val SEPARATOR = "\n"
        private const val KEY_QUEUE = "queue"
        private const val KEY_CURRENT = "current"
        private const val KEY_INDEX = "index"
        private const val KEY_POSITION = "position"
        private const val KEY_SHUFFLE = "shuffle"
        private const val KEY_REPEAT = "repeat"
    }
}
