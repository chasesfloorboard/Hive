package com.local.hive.mobile.data

import android.content.Context
import android.os.StatFs
import android.provider.MediaStore

/**
 * Where this phone's music lives: the storage and the folder in Music/
 * holding the most songs (an SD card's library folder, say). New songs go
 * there, from Soulseek downloads and from song sync, so the phone's library
 * folder grows like the PC's.
 */
object MusicHome {
    data class Place(val volume: String, val folder: String) {
        /** "Music/<folder>", or "Music" when the songs sit in Music itself. */
        val base get() = listOf("Music", folder).filter { it.isNotBlank() }.joinToString("/")
    }

    @Volatile private var cached: Pair<Long, Place?>? = null

    /** The place with the most songs, or null with no music yet. Worked out at most every 10 minutes. */
    fun find(context: Context): Place? {
        cached?.let { (at, place) -> if (System.currentTimeMillis() - at < 10 * 60_000) return place }
        val counts = HashMap<Place, Int>()
        // Songs straight inside Music/<folder>/: a library kept in one folder, or one artist's folder.
        val loose = HashMap<Place, Int>()
        var total = 0
        runCatching {
            context.contentResolver.query(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL),
                arrayOf(MediaStore.Audio.Media.VOLUME_NAME, MediaStore.Audio.Media.RELATIVE_PATH), "${MediaStore.Audio.Media.IS_MUSIC} != 0", null, null)?.use { c ->
                while (c.moveToNext()) {
                    val parts = c.getString(1).orEmpty().split('/').filter { it.isNotBlank() }
                    val volume = c.getString(0).orEmpty()
                    if (parts.firstOrNull() != "Music" || volume.isBlank()) continue
                    total++
                    // Music/<library>/<Artist>/<Album>/ makes <library> the folder; Music/<Artist>/<Album>/ is Music itself.
                    if (parts.size == 2) { Place(volume, parts[1]).let { loose[it] = (loose[it] ?: 0) + 1 }; continue }
                    val place = Place(volume, if (parts.size >= 4) parts[1] else "")
                    counts[place] = (counts[place] ?: 0) + 1
                }
            }
        }
        // A folder holding most of the phone's songs loose is the library (Music/My Music/<song>);
        // fewer, and it's more likely one artist's folder.
        for ((p, n) in loose) (if (n * 2 > total) p else Place(p.volume, "")).let { counts[it] = (counts[it] ?: 0) + n }
        val place = counts.maxByOrNull { it.value }?.key?.takeIf { it.volume in MediaStore.getExternalVolumeNames(context) }
        cached = System.currentTimeMillis() to place
        return place
    }

    /** Free space on a storage, by MediaStore volume name, or null when it can't be told. */
    fun freeBytes(context: Context, volume: String): Long? = runCatching {
        val dir = if (android.os.Build.VERSION.SDK_INT >= 30)
            context.getSystemService(android.os.storage.StorageManager::class.java).getStorageVolume(MediaStore.Files.getContentUri(volume))?.directory
        else if (volume == MediaStore.VOLUME_EXTERNAL_PRIMARY) android.os.Environment.getExternalStorageDirectory() else null
        dir?.let { StatFs(it.path).availableBytes }
    }.getOrNull()
}
