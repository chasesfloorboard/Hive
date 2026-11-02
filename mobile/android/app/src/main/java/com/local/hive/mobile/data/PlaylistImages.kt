package com.local.hive.mobile.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Pictures the user chose for playlists (Favorites, the phone's, smart ones, the PC's), copied into
 * Hive's own files so they stay when the original is moved or deleted. Keyed like
 * "favorites", "user:12", "smart:3", "pc:<id>". Removing one brings back the playlist's own cover.
 */
class PlaylistImages(private val context: Context) {
    private val prefs = context.getSharedPreferences("playlist-images", Context.MODE_PRIVATE)
    private val dir get() = File(context.filesDir, "playlist-images").apply { mkdirs() }
    private val _images = MutableStateFlow(load())
    /** Key to picture, as a file URI (a new file each time, so a changed picture shows at once). */
    val images: StateFlow<Map<String, String>> = _images.asStateFlow()

    private fun load(): Map<String, String> = prefs.all.mapNotNull { (key, name) ->
        (name as? String)?.let { File(dir, it) }?.takeIf { it.exists() }?.let { key to Uri.fromFile(it).toString() }
    }.toMap()

    suspend fun set(key: String, source: Uri) = withContext(Dispatchers.IO) {
        val name = key.replace(Regex("[^A-Za-z0-9._-]"), "_") + "-" + System.currentTimeMillis() + ".img"
        val file = File(dir, name)
        context.contentResolver.openInputStream(source)?.use { input -> file.outputStream().use { input.copyTo(it) } } ?: return@withContext
        prefs.getString(key, null)?.let { File(dir, it).delete() }
        prefs.edit().putString(key, name).apply()
        _images.value = _images.value + (key to Uri.fromFile(file).toString())
    }

    suspend fun remove(key: String) = withContext(Dispatchers.IO) {
        prefs.getString(key, null)?.let { File(dir, it).delete() }
        prefs.edit().remove(key).apply()
        _images.value = _images.value - key
    }

    companion object {
        const val FAVORITES = "favorites"
        fun user(id: Long) = "user:$id"
        fun smart(id: Long) = "smart:$id"
        fun pc(id: String) = "pc:$id"
    }
}
