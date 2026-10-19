package com.local.hive.mobile.playback

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.MainActivity

/**
 * Background playback: ExoPlayer inside a MediaSession, which gives Hive the
 * media notification, lock-screen and Bluetooth controls, and audio focus.
 * ExoPlayer plays queued local files back to back without a gap.
 */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        player.addListener(PlayCounter((application as HiveApp).playRecorder, player))
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYER, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player).setSessionActivity(open).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0 || player.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
    }

    override fun onDestroy() {
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
