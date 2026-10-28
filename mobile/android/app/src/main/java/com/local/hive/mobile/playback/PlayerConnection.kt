package com.local.hive.mobile.playback

import android.content.ComponentName
import android.content.Context
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** One song in the player's queue, described by what the player holds, so streamed songs show too. */
data class QueueItem(
    val mediaId: String,
    /** Set for songs in the library. */
    val trackId: Long?,
    val title: String,
    val artist: String,
    val artworkUri: String?,
    val durationMs: Long,
)

data class NowPlaying(
    val mediaId: String? = null,
    /** Set when the song is in the library (Love, album, artist apply). */
    val trackId: Long? = null,
    val title: String = "",
    val artist: String = "",
    val album: String = "",
    val artworkUri: String? = null,
    val isPlaying: Boolean = false,
    /** Where the song was at the last player event; for a live position use [PlayerConnection.position]. */
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val shuffle: Boolean = false,
    val repeatMode: Int = Player.REPEAT_MODE_OFF,
    val queue: List<QueueItem> = emptyList(),
    /** A radio station: no length, no seeking; the title is what the station is playing now. */
    val isLive: Boolean = false,
    /** For a station, its name. */
    val station: String = "",
    val speed: Float = 1f,
    val queueIndex: Int = -1,
    /** The covers of the songs a skip either way plays next (shuffle and repeat included), to load ahead. */
    val nextArtworkUri: String? = null,
    val previousArtworkUri: String? = null,
)

/** Pause at [endsAt] (fading out over the last seconds), or when the current song ends. */
data class SleepTimer(val endsAt: Long? = null, val endOfSong: Boolean = false)

/** The app's handle on [PlaybackService], exposing playback as state. */
class PlayerConnection(private val context: Context, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(NowPlaying())
    /**
     * What is playing; changes only on player events. The position ticks in
     * [position] instead, so the many screens watching this don't recompose
     * twice a second during playback.
     */
    val state: StateFlow<NowPlaying> = _state.asStateFlow()
    private val _position = MutableStateFlow(0L)
    /** The playing position, updated twice a second while playing. */
    val position: StateFlow<Long> = _position.asStateFlow()
    // The queue as QueueItems, rebuilt only when the player's timeline changes
    // (a 6,000-song queue used to be rebuilt on every position tick).
    private var queue: List<QueueItem> = emptyList()
    private var queueStale = true
    private var controller: MediaController? = null
    private val pending = mutableListOf<(MediaController) -> Unit>()
    private val _sleep = MutableStateFlow<SleepTimer?>(null)
    val sleep: StateFlow<SleepTimer?> = _sleep.asStateFlow()
    private var sleepJob: Job? = null

    fun connect() {
        if (controller != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            val c = runCatching { future.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) {
                    if (events.contains(Player.EVENT_TIMELINE_CHANGED)) queueStale = true
                    publish()
                }
                override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                    val natural = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT
                    if (natural && _sleep.value?.endOfSong == true) { c.pause(); c.seekTo(c.currentMediaItemIndex, 0); _sleep.value = null }
                }
            })
            pending.forEach { it(c) }
            pending.clear()
            publish()
        }, ContextCompat.getMainExecutor(context))

        // MediaController may only be touched from the main thread.
        scope.launch(Dispatchers.Main) {
            while (isActive) {
                controller?.takeIf { it.isPlaying }?.let { _position.value = it.currentPosition.coerceAtLeast(0) }
                delay(500)
            }
        }
    }

    private fun withController(block: (MediaController) -> Unit) {
        val c = controller
        if (c != null) block(c) else { pending += block; connect() }
    }

    fun play(tracks: List<Track>, startIndex: Int = 0, shuffle: Boolean = false) = playMedia(tracks.map { it.toMediaItem() }, startIndex, shuffle)
    fun playNext(tracks: List<Track>) = playNextMedia(tracks.map { it.toMediaItem() })
    fun addToQueue(tracks: List<Track>) = addToQueueMedia(tracks.map { it.toMediaItem() })

    /** Plays library songs and streamed songs alike. */
    fun playMedia(items: List<MediaItem>, startIndex: Int = 0, shuffle: Boolean = false, startPositionMs: Long = 0) {
        if (items.isEmpty()) return
        // Taps on Shuffle while one is starting are the same shuffle; once it plays, the next tap reshuffles.
        if (shuffle) {
            if (System.currentTimeMillis() - shuffleStartedAt < SHUFFLE_SETTLE_MS) return
            shuffleStartedAt = System.currentTimeMillis()
        }
        withController { c ->
            // A shuffle starts on a song on the phone when it can, which plays at once;
            // a streamed song would wait on YouTube first.
            val start = if (shuffle) items.indices.filter { items[it].isOnPhone() }.ifEmpty { items.indices.toList() }.random() else startIndex.coerceIn(items.indices)
            if (shuffle) shuffleStart = items[start].mediaId
            c.shuffleModeEnabled = shuffle
            c.setMediaItems(items, start, startPositionMs)
            c.prepare()
            c.play()
        }
    }

    /** When a shuffle was last asked for, and the song it starts on; cleared once that plays (see [publish]). */
    private var shuffleStartedAt = 0L
    private var shuffleStart: String? = null

    fun playNextMedia(items: List<MediaItem>) = withController { c ->
        if (c.mediaItemCount == 0) { playMedia(items); return@withController }
        c.addMediaItems(c.currentMediaItemIndex + 1, items)
    }

    fun addToQueueMedia(items: List<MediaItem>) = withController { c ->
        if (c.mediaItemCount == 0) { playMedia(items); return@withController }
        c.addMediaItems(items)
    }

    fun togglePlay() = withController { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } }
    fun next() = withController { it.seekToNext() }
    fun previous() = withController { it.seekToPrevious() }
    fun seekTo(positionMs: Long) = withController { it.seekTo(positionMs) }
    fun skipToQueueIndex(index: Int) = withController { it.seekTo(index, 0L) }
    fun removeFromQueue(index: Int) = withController { c ->
        if (index !in 0 until c.mediaItemCount) return@withController
        keepForUndo(listOf(index to c.getMediaItemAt(index)))
        c.removeMediaItem(index)
    }
    fun moveInQueue(from: Int, to: Int) = withController { it.moveMediaItem(from, to) }

    /** Takes several songs out of the queue; the playing one stays. */
    fun removeFromQueue(indices: Collection<Int>) = withController { c ->
        val gone = indices.filter { it != c.currentMediaItemIndex && it in 0 until c.mediaItemCount }.sorted().map { it to c.getMediaItemAt(it) }
        keepForUndo(gone)
        gone.asReversed().forEach { c.removeMediaItem(it.first) }
    }

    /**
     * Reopens the playing song's file at the same moment, after Hive rewrote its
     * tags: a fresh copy of it takes its place in the queue.
     */
    fun reloadCurrent() = withController { c ->
        val i = c.currentMediaItemIndex
        if (i !in 0 until c.mediaItemCount) return@withController
        val item = c.getMediaItemAt(i)
        val position = c.currentPosition
        c.addMediaItem(i + 1, item)
        c.seekTo(i + 1, position)
        c.removeMediaItem(i)
    }

    // The songs last taken out of the queue, at their places, so Undo can put them back.
    private var removed: List<Pair<Int, MediaItem>> = emptyList()
    private val _undoable = MutableStateFlow(0)
    /** How many songs Undo would put back in the queue (0: nothing to undo). */
    val undoable: StateFlow<Int> = _undoable.asStateFlow()
    private fun keepForUndo(gone: List<Pair<Int, MediaItem>>) { removed = gone; _undoable.value = gone.size }
    fun forgetUndo() { removed = emptyList(); _undoable.value = 0 }

    /** Puts the songs last removed back where they were; what plays carries on. */
    fun undoRemove() = withController { c ->
        removed.forEach { (i, item) -> c.addMediaItem(i.coerceAtMost(c.mediaItemCount), item) }
        forgetUndo()
    }

    /** Moves several songs to play right after the current one, keeping their order. */
    fun playNextFromQueue(indices: Collection<Int>) = withController { c ->
        val current = c.currentMediaItemIndex
        val picked = indices.filter { it != current && it in 0 until c.mediaItemCount }.sorted()
        // The queue as the moves leave it, to find each song's place as the earlier moves shift it.
        val model = (0 until c.mediaItemCount).toMutableList()
        picked.forEachIndexed { n, original ->
            val from = model.indexOf(original)
            model.removeAt(from)
            val to = model.indexOf(current) + 1 + n
            model.add(to, original)
            c.moveMediaItem(from, to)
        }
    }
    fun setSleepTimer(minutes: Int) {
        cancelSleepTimer()
        val endsAt = System.currentTimeMillis() + minutes * 60_000L
        _sleep.value = SleepTimer(endsAt = endsAt)
        sleepJob = scope.launch(Dispatchers.Main) {
            delay((endsAt - System.currentTimeMillis() - SLEEP_FADE_MS).coerceAtLeast(0))
            val steps = 40
            for (i in 1..steps) { controller?.volume = 1f - i.toFloat() / steps; delay(SLEEP_FADE_MS / steps) }
            controller?.pause()
            controller?.volume = 1f
            _sleep.value = null
        }
    }

    fun sleepAtEndOfSong() { cancelSleepTimer(); _sleep.value = SleepTimer(endOfSong = true) }

    fun cancelSleepTimer() {
        if (sleepJob?.isActive == true) controller?.volume = 1f
        sleepJob?.cancel()
        sleepJob = null
        _sleep.value = null
    }

    fun setSpeed(speed: Float) = withController { it.setPlaybackSpeed(speed) }
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
        val radio = item?.mediaId?.startsWith("radio:") == true
        // A station's song comes from its ICY title ("Artist - Title"), which the player merges into its live metadata.
        val stationName = meta?.station?.toString().orEmpty()
        val icy = if (radio) c.mediaMetadata.title?.toString()?.trim()?.takeIf { it.isNotBlank() } else null
        val (liveArtist, liveTitle) = icy?.let { t -> t.indexOf(" - ").takeIf { it > 0 }?.let { t.substring(0, it).trim() to t.substring(it + 3).trim() } ?: ("" to t) } ?: ("" to "")
        // The shuffle asked for is under way: the next tap on Shuffle is a new one.
        if (shuffleStart != null && ((c.isPlaying && item?.mediaId == shuffleStart) || c.playerError != null)) { shuffleStartedAt = 0L; shuffleStart = null }
        if (queueStale) { queue = (0 until c.mediaItemCount).map { c.getMediaItemAt(it).toQueueItem() }; queueStale = false }
        _position.value = c.currentPosition.coerceAtLeast(0)
        _state.value = NowPlaying(
            mediaId = item?.mediaId,
            trackId = item?.mediaId?.toLongOrNull(),
            title = if (radio) liveTitle.ifBlank { stationName } else meta?.title?.toString().orEmpty(),
            artist = if (radio) liveArtist.ifBlank { if (liveTitle.isNotBlank()) stationName else "Live radio" } else meta?.artist?.toString().orEmpty(),
            isLive = radio || c.isCurrentMediaItemLive,
            station = stationName,
            speed = c.playbackParameters.speed,
            album = meta?.albumTitle?.toString().orEmpty(),
            artworkUri = meta?.artworkUri?.toString(),
            isPlaying = c.isPlaying,
            positionMs = c.currentPosition.coerceAtLeast(0),
            durationMs = c.duration.coerceAtLeast(0),
            shuffle = c.shuffleModeEnabled,
            repeatMode = c.repeatMode,
            queue = queue,
            queueIndex = c.currentMediaItemIndex,
            nextArtworkUri = c.nextMediaItemIndex.takeIf { it >= 0 }?.let { c.getMediaItemAt(it).mediaMetadata.artworkUri?.toString() },
            previousArtworkUri = c.previousMediaItemIndex.takeIf { it >= 0 }?.let { c.getMediaItemAt(it).mediaMetadata.artworkUri?.toString() },
        )
    }
}

/** A song file on the phone, which starts without waiting on the network. */
private fun MediaItem.isOnPhone() = localConfiguration?.uri?.scheme.let { it == "content" || it == "file" }

/** How long taps on Shuffle count as the shuffle already starting, if it hasn't started playing sooner. */
private const val SHUFFLE_SETTLE_MS = 8_000L

private fun MediaItem.toQueueItem() = QueueItem(
    mediaId = mediaId,
    trackId = mediaId.toLongOrNull(),
    title = (mediaMetadata.title ?: mediaMetadata.station)?.toString().orEmpty(),
    artist = mediaMetadata.artist?.toString().orEmpty(),
    artworkUri = mediaMetadata.artworkUri?.toString(),
    durationMs = mediaMetadata.durationMs ?: 0,
)

/** Where a streamed song's preview is kept, for when the full song through the PC fails. */
const val EXTRA_PREVIEW = "hive.preview"

/** A streamed song (Apple Music, Spotify) played from [uri]: its preview, or the full song through Hive on the PC. */
fun StreamTrack.toMediaItem(uri: String): MediaItem = MediaItem.Builder()
    .setMediaId(key)
    .setUri(uri)
    .setRequestMetadata(MediaItem.RequestMetadata.Builder().setExtras(android.os.Bundle().apply { putString(EXTRA_PREVIEW, previewUrl) }).build())
    .setMediaMetadata(
        MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .setAlbumTitle(album.ifBlank { null })
            .setArtworkUri(artworkUrl.ifBlank { null }?.let(android.net.Uri::parse))
            .setDurationMs(durationMs.takeIf { it > 0 })
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .build(),
    )
    .build()

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
            .setGenre(genre.ifBlank { null })
            .setArtworkUri(artworkUri)
            .setDurationMs(durationMs.takeIf { it > 0 })
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .build(),
    )
    .build()

private const val SLEEP_FADE_MS = 10_000L
