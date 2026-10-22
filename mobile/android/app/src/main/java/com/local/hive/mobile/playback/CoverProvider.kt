package com.local.hive.mobile.playback

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.ParcelFileDescriptor
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import kotlinx.coroutines.runBlocking
import java.io.File

/**
 * Album covers for Android Auto. The car can't read Android's own album-art
 * addresses, so each cover is handed over from here instead, at full quality
 * (through [com.local.hive.mobile.data.AlbumArtFetcher]) and kept as a JPEG.
 * Not exported: the car gets read access to each cover it's shown ([grant]).
 */
class CoverProvider : ContentProvider() {
    override fun onCreate() = true

    override fun getType(uri: Uri) = "image/jpeg"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val albumId = uri.lastPathSegment?.toLongOrNull() ?: return null
        val context = context ?: return null
        val file = File(File(context.cacheDir, "car-art").apply { mkdirs() }, "$albumId.jpg")
        if (file.length() == 0L) {
            val request = ImageRequest.Builder(context).data("content://media/external/audio/albumart/$albumId").size(SIZE_PX).allowHardware(false).build()
            val bitmap = runBlocking { (SingletonImageLoader.get(context).execute(request) as? SuccessResult)?.image?.toBitmap() } ?: return null
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?) = null
    override fun insert(uri: Uri, values: ContentValues?) = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        /** Sharp on a car screen without being heavy to send. */
        private const val SIZE_PX = 720

        fun uriFor(context: Context, albumId: Long): Uri = Uri.parse("content://${context.packageName}.covers/album/$albumId")

        /** Lets [packageName] (the car) read the covers among [items]. */
        fun grant(context: Context, packageName: String, items: List<androidx.media3.common.MediaItem>) {
            val prefix = "content://${context.packageName}.covers/"
            for (item in items) {
                val art = item.mediaMetadata.artworkUri ?: continue
                if (art.toString().startsWith(prefix)) runCatching { context.grantUriPermission(packageName, art, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            }
        }
    }
}
