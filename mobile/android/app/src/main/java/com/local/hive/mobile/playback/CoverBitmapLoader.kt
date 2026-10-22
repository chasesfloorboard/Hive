package com.local.hive.mobile.playback

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.media3.common.util.BitmapLoader
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Covers for the notification, the system lock screen, Bluetooth and cars
 * through Hive's own image loader, so they get the full-quality cover (see
 * [com.local.hive.mobile.data.AlbumArtFetcher]) instead of Android's ~512 px
 * album thumbnail, and share the covers already loaded on screen.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class CoverBitmapLoader(private val context: Context, private val scope: CoroutineScope) : BitmapLoader {
    override fun supportsMimeType(mimeType: String) = mimeType.startsWith("image/")

    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = future {
        BitmapFactory.decodeByteArray(data, 0, data.size) ?: error("Not a picture")
    }

    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = future {
        val request = ImageRequest.Builder(context).data(uri).size(SIZE_PX).allowHardware(false).build()
        val result = SingletonImageLoader.get(context).execute(request)
        (result as? SuccessResult)?.image?.toBitmap() ?: error("No cover for $uri")
    }

    private fun future(block: suspend () -> Bitmap): ListenableFuture<Bitmap> = SettableFuture.create<Bitmap>().also { f ->
        scope.launch { runCatching { block() }.fold({ f.set(it) }, { f.setException(it) }) }
    }

    private companion object {
        /** Big enough for a full-width lock screen cover. */
        const val SIZE_PX = 1080
    }
}
