package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Albums whose cover the user cleared, so the album falls back to the placeholder
 * instead of a stray picture embedded in one of its (often untagged) songs. A
 * display-only override: the song files and Hive's album-art cache are never
 * touched, so "Show cover" brings the picture straight back. Kept as album ids.
 */
class AlbumCovers(context: Context) {
    private val prefs = context.getSharedPreferences("album-covers", Context.MODE_PRIVATE)
    private val _hidden = MutableStateFlow(
        prefs.getStringSet("hidden", emptySet()).orEmpty().mapNotNull { it.toLongOrNull() }.toSet(),
    )
    /** The album ids whose cover is cleared. */
    val hidden: StateFlow<Set<Long>> = _hidden.asStateFlow()

    fun hide(albumId: Long) = update(_hidden.value + albumId)
    fun show(albumId: Long) = update(_hidden.value - albumId)

    private fun update(set: Set<Long>) {
        _hidden.value = set
        prefs.edit().putStringSet("hidden", set.map(Long::toString).toSet()).apply()
    }

    companion object {
        /**
         * The cover model for an album: none (the placeholder shows) when the album's
         * cover is cleared, otherwise its MediaStore album-art address. A String, so it
         * is unit-testable without Android's Uri; the caller parses it to a Uri.
         */
        fun model(albumId: Long, hidden: Set<Long>): String? =
            if (albumId in hidden) null else "content://media/external/audio/albumart/$albumId"
    }
}
