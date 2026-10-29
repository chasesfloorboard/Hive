package com.local.hive.mobile.playback

import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos

/**
 * Hive's MusicBee-style crossfade, as on the PC: near the end of a song a
 * companion player keeps playing it and fades it out while the main player
 * moves on to the next song and fades it in. The session only ever sees the
 * main player, so the notification, lock screen and queue behave as usual.
 *
 * The companion is loaded a few seconds early, paused at the point where the
 * fade begins, so it takes over without a gap: it starts there, and only once
 * it is audible does the main player move on.
 *
 * Off at 0 s; not between songs of the same album when [EqState.crossfadeExcludeAlbums];
 * never with repeat-one, a sleep timer ending with the song, radio or podcasts.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class Crossfader(
    private val scope: CoroutineScope,
    private val main: ExoPlayer,
    private val mainProcessor: EqualiserProcessor,
    private val settings: StateFlow<EqState>,
    /** A fresh player for the outgoing song, with its own equaliser. */
    private val newCompanion: (EqualiserProcessor) -> ExoPlayer,
    private val stopsAtSongEnd: () -> Boolean,
) {
    /** The companion playing the outgoing song while it fades out. */
    private var companion: ExoPlayer? = null
    private var fadeJob: Job? = null
    /** The song (by index and id) already handed over, so it fades once. */
    private var handedOver: Pair<Int, String>? = null
    /** Where [start] itself moved the main player, so that seek isn't taken for the user's. */
    private var movedTo = -1

    /** A companion loaded ahead, paused at [Ready.at] in the playing song. */
    private class Ready(val player: ExoPlayer, val key: Pair<Int, String>, val at: Long, val ms: Int, val skip: Boolean)
    private var ready: Ready? = null

    init {
        scope.launch {
            while (isActive) {
                // Finer steps just before a handover, so the companion starts on time.
                delay(if (ready?.let { main.currentPosition >= it.at - 500 } == true) 5 else 40)
                if (fadeMs() > 0 || ready != null) tick()
            }
        }
        main.addListener(object : Player.Listener {
            // Pausing or seeking ends a fade at once: the outgoing song goes quiet quickly.
            // (Buffering the next song isn't a pause: playWhenReady stays on.)
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) { if (!playWhenReady) { drop(); finish(quick = true) } }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                val ours = newPosition.mediaItemIndex == movedTo && newPosition.positionMs == 0L
                movedTo = -1
                if (!ours && reason == Player.DISCONTINUITY_REASON_SEEK) { drop(); finish(quick = true) }
            }
        })
    }

    private fun fadeMs() = settings.value.crossfadeMs.coerceIn(0, MAX_MS)

    private fun key() = main.currentMediaItemIndex to main.currentMediaItem?.mediaId.orEmpty()

    private fun tick() {
        val r = ready
        if (r != null) {
            if (r.key != key()) { drop(); return }
            val position = main.currentPosition
            when {
                // Started a moment early: the companion's sound takes that long to come out.
                position >= r.at - START_LEAD_MS && r.player.playbackState == Player.STATE_READY -> { handedOver = r.key; start(r) }
                // It never loaded in time: no fade this once (a skip still skips).
                position >= r.at + GIVE_UP_MS -> { handedOver = r.key; drop(); if (r.skip) main.seekToNextMediaItem() }
            }
            return
        }
        val ms = fadeMs()
        val duration = main.duration
        if (!main.isPlaying || duration <= 0 || duration < ms * 2L + 1_000 || companion != null) return
        val key = key()
        if (handedOver == key) return
        val at = duration - ms
        if (main.currentPosition >= at - LOAD_AHEAD_MS) load(at, ms, skip = false)
    }

    /** "Crossfade when skipping": a skip forward while playing fades instead of cutting. */
    fun skip(): Boolean {
        if (!settings.value.crossfadeOnSkip || fadeMs() == 0 || !main.isPlaying || companion != null || ready != null) return false
        handedOver = key()
        // The companion needs a moment to load; the song carries on until then.
        return load(main.currentPosition + SKIP_LOAD_MS, fadeMs(), skip = true)
    }

    /** Loads the outgoing song into a paused companion at [at], ready to take over. */
    private fun load(at: Long, ms: Int, skip: Boolean): Boolean {
        val next = main.nextMediaItemIndex.takeIf { it != androidx.media3.common.C.INDEX_UNSET } ?: return false
        val current = main.currentMediaItem ?: return false
        if (!allowed(current, main.getMediaItemAt(next))) { handedOver = key(); return false }
        val processor = EqualiserProcessor().also { mainProcessor.copyTo(it) }
        val out = newCompanion(processor)
        out.setMediaItem(current, at)
        out.volume = 1f
        out.playWhenReady = false
        out.prepare()
        ready = Ready(out, key(), at, ms, skip)
        return true
    }

    private fun start(r: Ready) {
        ready = null
        finish(quick = true)
        val next = main.nextMediaItemIndex.takeIf { it != androidx.media3.common.C.INDEX_UNSET }
        if (next == null) { r.player.release(); return }
        android.util.Log.i("HiveSound", "Crossfade over ${r.ms} ms into queue item $next")
        val out = r.player
        companion = out
        out.play()
        fadeJob = scope.launch {
            // The main player moves on once the companion is actually sounding, so there's no gap.
            val begun = System.currentTimeMillis()
            while (isActive && out.currentPosition <= r.at && System.currentTimeMillis() - begun < 300) delay(5)
            movedTo = next
            // The main player moves on, fading the next song in from silence.
            mainProcessor.fadeInOnNextFlush(r.ms)
            main.seekTo(next, 0)
            val start = System.currentTimeMillis()
            while (isActive) {
                val t = ((System.currentTimeMillis() - start).toFloat() / r.ms).coerceIn(0f, 1f)
                out.volume = cos(t * PI / 2).toFloat()
                if (t >= 1f) break
                delay(30)
            }
            release(out)
        }
    }

    /** Lets go of a companion loaded ahead that hasn't started. */
    private fun drop() {
        ready?.player?.release()
        ready = null
    }

    private fun allowed(current: MediaItem, next: MediaItem): Boolean {
        if (main.repeatMode == Player.REPEAT_MODE_ONE || stopsAtSongEnd()) return false
        if (listOf(current, next).any { item -> item.mediaId.let { it.startsWith("radio:") || it.startsWith("pod:") } }) return false
        if (settings.value.crossfadeExcludeAlbums) {
            fun album(i: MediaItem) = i.mediaMetadata.let { m ->
                m.albumTitle?.toString()?.trim()?.lowercase().orEmpty() to (m.albumArtist ?: m.artist)?.toString()?.trim()?.lowercase().orEmpty()
            }
            val a = album(current)
            if (a.first.isNotEmpty() && a == album(next)) return false
        }
        return true
    }

    /** Ends a fade under way; [quick] fades the outgoing song out over a moment instead of cutting it. */
    fun finish(quick: Boolean) {
        val out = companion ?: return
        fadeJob?.cancel()
        companion = null
        if (!quick) { out.release(); return }
        scope.launch {
            val from = out.volume
            for (i in 1..6) { out.volume = from * (1f - i / 6f); delay(25) }
            out.release()
        }
    }

    private fun release(out: ExoPlayer) {
        out.release()
        if (companion === out) companion = null
    }

    fun close() { drop(); finish(quick = false) }

    companion object {
        /** The PC's limit. */
        const val MAX_MS = 15_000
        /** How far ahead the companion loads (a streamed song needs a few seconds). */
        const val LOAD_AHEAD_MS = 6_000L
        /** A skip waits this long for the companion to load before the fade begins. */
        const val SKIP_LOAD_MS = 400L
        /** The companion starts this much early, about how long its first sound takes to come out. */
        const val START_LEAD_MS = 60L
        /** If the companion still isn't loaded this long after the fade should have begun, there's no fade. */
        const val GIVE_UP_MS = 300L
    }
}
