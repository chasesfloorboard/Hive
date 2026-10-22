package com.local.hive.mobile.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch

/**
 * Every album with a liked song is a favorite album: the album of each loved
 * song is added to Favorites › Albums, now and whenever more songs are loved
 * (here or from Hive on the PC). An album the user takes out of Favorites
 * stays out; hearting it again lifts that.
 */
class LikedAlbums(context: Context, private val dao: LibraryDao) {
    private val prefs = context.getSharedPreferences("liked-albums", Context.MODE_PRIVATE)

    /** Albums taken out of Favorites by hand, which loving their songs no longer brings back. */
    private fun dismissed(): Set<String> = prefs.getStringSet("dismissed", emptySet()).orEmpty()

    fun setDismissed(key: String, dismissed: Boolean) {
        val next = if (dismissed) dismissed() + key else dismissed() - key
        prefs.edit().putStringSet("dismissed", next).apply()
    }

    @OptIn(FlowPreview::class)
    fun start(scope: CoroutineScope) = scope.launch {
        combine(dao.lovedTracks(), dao.albums(), dao.favoriteAlbums()) { loved, albums, favorites -> Triple(loved, albums, favorites) }
            .debounce(1_000)
            .collect { (loved, albums, favorites) ->
                val byId = albums.associateBy { it.albumId }
                val have = favorites.mapTo(HashSet()) { it.key }
                val skip = dismissed()
                val now = System.currentTimeMillis()
                loved.mapNotNull { byId[it.albumId] }.filter { it.album.isNotBlank() }.distinctBy { it.albumId }.forEach { a ->
                    val key = FavoriteAlbum.keyOf(a.album, a.artist)
                    if (key !in have && key !in skip) { dao.upsertFavoriteAlbum(FavoriteAlbum(key, a.album, a.artist, now)); have += key }
                }
            }
    }
}
