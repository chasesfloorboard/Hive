package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Favorite albums are the albums the user hearts, and only those: loving a song doesn't favorite its
 * album. (Until 2.14.9 every album with a loved song was added; [start] clears those once, so only
 * albums hearted from now on show.)
 */
class LikedAlbums(context: Context, private val dao: LibraryDao) {
    private val prefs = context.getSharedPreferences("liked-albums", Context.MODE_PRIVATE)

    fun start(scope: CoroutineScope) = scope.launch {
        if (prefs.getBoolean("auto-albums-cleared", false)) return@launch
        dao.clearFavoriteAlbums()
        prefs.edit().putBoolean("auto-albums-cleared", true).remove("dismissed").apply()
    }
}
