package com.local.hive.mobile.playback

import android.content.ComponentName
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.local.hive.mobile.data.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class NowPlaying(
    val trackId: Long? = null,
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val artworkUri: String? = null,
    val isPlaying: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val shuffle: Boolean = false,
    val repeatMode: Int = Player.REPEAT_MODE_OFF,
    val queue: List<Long> = emptyList(),
    val queueIndex: Int = -1,
)

/** The app's handle on [PlaybackService], exposing playback as state. */
class PlayerConnection(private val context: Context, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(NowPlaying())
    val state: StateFlow<NowPlaying> = _state.asStateFlow()
    private var controller: MediaController? = null
    private val pending = mutableListOf<(MediaController) -> Unit>()

    fun connect() {
        if (controller != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            val c = runCatching { future.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = publish()
            })
            pending.forEach { it(c) }
            pending.clear()
            publish()
        }, ContextCompat.getMainExecutor(context))

        // MediaController may only be touched from the main thread.
        scope.launch(Dispatchers.Main) {
            while (isActive) {
                if (controller?.isPlaying == true) publish()
                delay(500)
            }
        }
    }

    private fun withController(block: (MediaController) -> Unit) {
        val c = controller
        if (c != null) block(c) else { pending += block; connect() }
    }

    fun play(tracks: List<Track>, startIndex: Int = 0, shuffle: Boolean = false) = withController { c ->
        if (tracks.isEmpty()) return@withController
        c.shuffleModeEnabled = shuffle
        c.setMediaItems(tracks.map { it.toMediaItem() }, if (shuffle) (tracks.indices).random() else startIndex.coerceIn(tracks.indices), 0L)
        c.prepare()
        c.play()
    }

    fun playNext(tracks: List<Track>) = withController { c ->
        if (c.mediaItemCount == 0) { play(tracks); return@withController }
        c.addMediaItems(c.currentMediaItemIndex + 1, tracks.map { it.toMediaItem() })
    }

    fun addToQueue(tracks: List<Track>) = withController { c ->
        if (c.mediaItemCount == 0) { play(tracks); return@withController }
        c.addMediaItems(tracks.map { it.toMediaItem() })
    }

    fun togglePlay() = withController { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } }
    fun next() = withController { it.seekToNext() }
    fun previous() = withController { it.seekToPrevious() }
    fun seekTo(positionMs: Long) = withController { it.seekTo(positionMs) }
    fun skipToQueueIndex(index: Int) = withController { it.seekTo(index, 0L) }
    fun removeFromQueue(index: Int) = withController { it.removeMediaItem(index) }
    fun moveInQueue(from: Int, to: Int) = withController { it.moveMediaItem(from, to) }
    fun toggleShuffle() = withController { it.shuffleModeEnabled = !it.shuffleModeEnabled }
    fun cycleRepeat() = withController {
        it.repeatMode = when (it.repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    private fun publish() {
        val c = controller ?: return
        val item = c.currentMediaItem
        val meta = item?.mediaMetadata
        _state.value = NowPlaying(
            trackId = item?.mediaId?.toLongOrNull(),
            title = meta?.title?.toString().orEmpty(),
            artist = meta?.artist?.toString().orEmpty(),
            album = meta?.albumTitle?.toString().orEmpty(),
            artworkUri = meta?.artworkUri?.toString(),
            isPlaying = c.isPlaying,
            positionMs = c.currentPosition.coerceAtLeast(0),
            durationMs = c.duration.coerceAtLeast(0),
            shuffle = c.shuffleModeEnabled,
            repeatMode = c.repeatMode,
            queue = (0 until c.mediaItemCount).mapNotNull { c.getMediaItemAt(it).mediaId.toLongOrNull() },
            queueIndex = c.currentMediaItemIndex,
        )
    }
}

fun Track.toMediaItem(): MediaItem = MediaItem.Builder()
    .setMediaId(id.toString())
    .setUri(uri)
    .setMediaMetadata(
        MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setAlbumTitle(album)
            .setAlbumArtist(albumArtist.ifBlank { null })
            .setTrackNumber(trackNumber.takeIf { it > 0 })
            .setArtworkUri(artworkUri)
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .build(),
    )
    .build()
