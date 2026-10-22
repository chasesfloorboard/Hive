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
    private var companion: ExoPlayer? = null
    private var fadeJob: Job? = null
    /** The song (by index and id) already handed over, so it fades once. */
    private var handedOver: Pair<Int, String>? = null
    /** Where [handOver] itself moved the main player, so that seek isn't taken for the user's. */
    private var movedTo = -1

    init {
        scope.launch {
            while (isActive) {
                delay(40)
                if (fadeMs() > 0) tick()
            }
        }
        main.addListener(object : Player.Listener {
            // Pausing or seeking ends a fade at once: the outgoing song goes quiet quickly.
            // (Buffering the next song isn't a pause: playWhenReady stays on.)
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) { if (!playWhenReady) finish(quick = true) }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                val ours = newPosition.mediaItemIndex == movedTo && newPosition.positionMs == 0L
                movedTo = -1
                if (!ours && reason == Player.DISCONTINUITY_REASON_SEEK) finish(quick = true)
            }
        })
    }

    private fun fadeMs() = settings.value.crossfadeMs.coerceIn(0, MAX_MS)

    private fun tick() {
        val ms = fadeMs()
        val duration = main.duration
        if (!main.isPlaying || duration <= 0 || duration < ms * 2L + 1_000) return
        val key = main.currentMediaItemIndex to main.currentMediaItem?.mediaId.orEmpty()
        if (handedOver == key) return
        if (main.currentPosition >= duration - ms) { handedOver = key; handOver(ms) }
    }

    /** "Crossfade when skipping": a skip forward while playing fades instead of cutting. */
    fun skip(): Boolean {
        if (!settings.value.crossfadeOnSkip || fadeMs() == 0 || !main.isPlaying || companion != null) return false
        handedOver = main.currentMediaItemIndex to main.currentMediaItem?.mediaId.orEmpty()
        return handOver(fadeMs())
    }

    private fun handOver(ms: Int): Boolean {
        val next = main.nextMediaItemIndex.takeIf { it != androidx.media3.common.C.INDEX_UNSET } ?: return false
        val current = main.currentMediaItem ?: return false
        if (!allowed(current, main.getMediaItemAt(next))) return false
        finish(quick = true)
        android.util.Log.i("HiveSound", "Crossfade over $ms ms into queue item $next")
        // The outgoing song carries on in the companion from where the main player is.
        val processor = EqualiserProcessor().also { mainProcessor.copyTo(it) }
        val out = newCompanion(processor)
        companion = out
        out.setMediaItem(current, main.currentPosition)
        out.volume = 1f
        out.prepare()
        out.play()
        // The main player moves on, fading the next song in from silence.
        movedTo = next
        mainProcessor.fadeInOnNextFlush(ms)
        main.seekTo(next, 0)
        fadeJob = scope.launch {
            val start = System.currentTimeMillis()
            while (isActive) {
                val t = ((System.currentTimeMillis() - start).toFloat() / ms).coerceIn(0f, 1f)
                out.volume = cos(t * PI / 2).toFloat()
                if (t >= 1f) break
                delay(30)
            }
            release(out)
        }
        return true
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

    fun close() = finish(quick = false)

    companion object {
        /** The PC's limit. */
        const val MAX_MS = 15_000
    }
}
