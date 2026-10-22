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
    private val streamUri: (com.local.hive.mobile.data.StreamTrack) -> String? = { it.previewUrl.ifBlank { null } },
    private val pcItems: suspend (List<String>) -> Map<String, MediaItem> = { emptyMap() },
) {
    private val prefs = context.getSharedPreferences("playback-state", Context.MODE_PRIVATE)

    data class Restored(val items: List<MediaItem>, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeatMode: Int)

    fun saveQueue(player: Player) {
        val ids = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
        prefs.edit().putString(KEY_QUEUE, ids.joinToString(SEPARATOR)).apply()
        saveCursor(player)
    }

    fun saveCursor(player: Player) {
        if (player.mediaItemCount == 0) return
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
        // The same song can sit in the queue twice; prefer the saved slot if it still holds it.
        val index = when {
            current == null -> 0
            ids.getOrNull(savedIndex) == current -> ids.take(savedIndex).count { it in playable }
            else -> kept.indexOf(current)
        }
        val position = if (index >= 0) prefs.getLong(KEY_POSITION, 0) else 0
        return Restored(
            items = kept.map { playable.getValue(it) },
            index = index.coerceAtLeast(0),
            positionMs = position,
            shuffle = prefs.getBoolean(KEY_SHUFFLE, false),
            repeatMode = prefs.getInt(KEY_REPEAT, Player.REPEAT_MODE_OFF),
        )
    }

    private companion object {
        const val SEPARATOR = "\n"
        const val KEY_QUEUE = "queue"
        const val KEY_CURRENT = "current"
        const val KEY_INDEX = "index"
        const val KEY_POSITION = "position"
        const val KEY_SHUFFLE = "shuffle"
        const val KEY_REPEAT = "repeat"
    }
}
