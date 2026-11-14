package com.local.hive.mobile.data

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore

/**
 * The listening history as a file anyone can open later: Documents/Hive/listening-events.json,
 * a byte-for-byte copy of the one Hive keeps on the PC (every play, the phone's included).
 */
object ListeningFile {
    const val NAME = "listening-events.json"
    val FOLDER = Environment.DIRECTORY_DOCUMENTS + "/Hive/"

    fun save(context: Context, bytes: ByteArray) {
        val resolver = context.contentResolver
        val files = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val existing = resolver.query(
            files, arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME}=?", arrayOf(FOLDER, NAME), null,
        )?.use { if (it.moveToFirst()) ContentUris.withAppendedId(files, it.getLong(0)) else null }
        val uri = existing ?: resolver.insert(files, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, NAME)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
            put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER)
        }) ?: return
        resolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
    }
}
