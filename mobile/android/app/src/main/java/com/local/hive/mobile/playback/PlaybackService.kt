package com.local.hive.mobile.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.common.audio.AudioProcessor
import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.MediaSession.MediaItemsWithStartPosition
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.MainActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Background playback: ExoPlayer inside a MediaSession, which gives Hive the
 * media notification, lock-screen and Bluetooth controls, and audio focus.
 * ExoPlayer plays queued local files back to back without a gap.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val scope = MainScope()
    private lateinit var memory: PlaybackMemory
    private val equaliser = EqualiserProcessor()
    private val genre = MutableStateFlow("")
    private val replayGainTags = MutableStateFlow<Map<String, String>>(emptyMap())
    private val queueTick = MutableStateFlow(0)

    override fun onCreate() {
        super.onCreate()
        val app = application as HiveApp
        // Streams from Hive on the PC carry the pairing token; nothing else does.
        val dataSources = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, DefaultHttpDataSource.Factory().setUserAgent("HiveMobile"))) { spec ->
            val pairing = app.linkStore.pairing
            val toPc = pairing != null && spec.uri.scheme == "http" && spec.uri.port == pairing.port && spec.uri.host in pairing.hosts
            if (toPc) spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer ${pairing!!.token}")) else spec
        }
        // Hive's equaliser runs inside the audio sink, ahead of every output.
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf<AudioProcessor>(equaliser)).build()
        }
        val player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        player.addListener(PlayCounter(app.playRecorder, player))
        memory = PlaybackMemory(this, app.database.dao())
        player.addListener(object : Player.Listener {
            // A song streamed through the PC that fails (PC gone, no match) falls back to its preview.
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                val item = player.currentMediaItem ?: return
                val preview = item.requestMetadata.extras?.getString(EXTRA_PREVIEW)?.takeIf { it.isNotBlank() } ?: return
                if (item.localConfiguration?.uri?.toString() == preview) return
                player.replaceMediaItem(player.currentMediaItemIndex, item.buildUpon().setUri(preview).build())
                player.prepare()
                player.play()
            }
            override fun onMediaMetadataChanged(mediaMetadata: androidx.media3.common.MediaMetadata) { genre.value = mediaMetadata.genre?.toString().orEmpty() }
            override fun onTracksChanged(tracks: androidx.media3.common.Tracks) { replayGainTags.value = ReplayGain.tagsOf(tracks); queueTick.value++ }
            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) memory.saveQueue(player)
            }
            override fun onEvents(player: Player, events: Player.Events) {
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_POSITION_DISCONTINUITY,
                        Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED)) memory.saveCursor(player)
            }
        })
        scope.launch {
            while (isActive) { delay(5_000); if (player.isPlaying) memory.saveCursor(player) }
        }
        // The curve follows the settings, and for "Auto-Select by Genre" the playing song's genre.
        scope.launch {
            combine(app.equaliser.state, genre) { eq, g -> if (eq.enabled) eq.curve(g) else null }.collect { equaliser.setCurve(it) }
        }
        scope.launch {
            combine(app.equaliser.state, replayGainTags, queueTick) { eq, tags, _ ->
                val mode = if (eq.replayGain == "smart") (if (ReplayGain.smartUsesAlbum(player)) "album" else "track") else eq.replayGain
                ReplayGain.linear(tags, mode, eq.clippingGuard)
            }.distinctUntilChanged().collect { gain ->
                android.util.Log.i("HiveSound", "ReplayGain ${app.equaliser.state.value.replayGain}: x%.3f".format(gain))
                equaliser.setSongGain(gain)
            }
        }
        // Pick up where the last session left off, paused, unless something was queued meanwhile.
        scope.launch {
            val saved = withContext(Dispatchers.IO) { memory.restore() } ?: return@launch
            if (player.mediaItemCount > 0) return@launch
            player.setMediaItems(saved.items, saved.index, saved.positionMs)
            player.shuffleModeEnabled = saved.shuffle
            player.repeatMode = saved.repeatMode
            player.prepare()
        }
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYER, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(open).setCallback(object : MediaSession.Callback {
            // Bluetooth play or the system's media controls after a reboot resume the saved queue.
            override fun onPlaybackResumption(mediaSession: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaItemsWithStartPosition> {
                val future = SettableFuture.create<MediaItemsWithStartPosition>()
                scope.launch {
                    val saved = withContext(Dispatchers.IO) { memory.restore() }
                    if (saved == null) future.setException(UnsupportedOperationException("Nothing to resume"))
                    else future.set(MediaItemsWithStartPosition(saved.items, saved.index, saved.positionMs))
                }
                return future
            }
        }).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        session?.player?.let { memory.saveCursor(it) }
        scope.cancel()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}

/**
 * Counts a play once a track has been listened to for half its length or four
 * minutes, whichever comes first (the Last.fm rule Hive's scrobbler uses).
 */
private class PlayCounter(private val recorder: PlayRecorder, private val player: Player) : Player.Listener {
    private var currentId: Long? = null
    private var listenedMs = 0L
    private var resumedAt = 0L
    private var counted = false
    private var durationMs = 0L

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
            resumedAt = System.currentTimeMillis()
            player.duration.takeIf { it > 0 }?.let { durationMs = it }
        } else accumulate()
        check()
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
        // Gapless transitions never pause, so the length is taken once loaded.
        if (playbackState == Player.STATE_READY) player.duration.takeIf { it > 0 }?.let { durationMs = it }
    }

    override fun onMediaItemTransition(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
        accumulate()
        check()
        currentId = mediaItem?.mediaId?.toLongOrNull()
        listenedMs = 0
        durationMs = 0
        counted = false
        resumedAt = if (player.isPlaying) System.currentTimeMillis() else 0
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
        accumulate()
        check()
        if (player.isPlaying) resumedAt = System.currentTimeMillis()
    }

    private fun accumulate() {
        if (resumedAt > 0) listenedMs += System.currentTimeMillis() - resumedAt
        resumedAt = 0
    }

    private fun check() {
        val id = currentId ?: return
        if (counted) return
        val duration = durationMs.takeIf { it > 0 } ?: return
        if (listenedMs >= minOf(duration / 2, 4 * 60_000L)) {
            counted = true
            recorder.record(id, listenedMs)
        }
    }
}

fun interface PlayRecorder {
    fun record(trackId: Long, listenedMs: Long)
}
