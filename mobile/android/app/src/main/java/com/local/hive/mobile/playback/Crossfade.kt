package com.local.hive.mobile.playback

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos

/**
 * Hive's crossfade, the way music players built on Android's players do it: two players take turns,
 * and a song plays start to finish on one of them. Near a song's end the next one starts on the other
 * player, fading in, while this one fades out. No song ever moves from one player to the other while
 * it plays, so nothing is heard twice or cut.
 *
 * The main player is the one everything else sees (the notification, the lock screen, the car, the
 * queue, play counts). When the other player (the "voice") is the one sounding, the main player sits
 * on the same song with its sound off, kept in step with it, so all of that stays right; pausing,
 * seeking and skipping on the main player are passed on to the voice.
 *
 * Off at 0 s; not between songs of the same album when [EqState.crossfadeExcludeAlbums]; never with
 * repeat-one, a sleep timer ending with the song, radio or podcasts.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class Crossfader(
    private val scope: CoroutineScope,
    private val main: ExoPlayer,
    private val mainProcessor: EqualiserProcessor,
    private val settings: StateFlow<EqState>,
    /** A fresh player for the other turn, with its own equaliser. */
    private val newCompanion: (EqualiserProcessor) -> ExoPlayer,
    private val stopsAtSongEnd: () -> Boolean,
    /** A song's ReplayGain factor from its tags (as the main player's is worked out). */
    private val songGain: (Tracks) -> Float = { 1f },
) {
    /** The other player, while it's sounding a song (the main player silent on the same song), or fading one out. */
    private var voice: ExoPlayer? = null
    private var voiceProcessor: EqualiserProcessor? = null
    /** The voice carries the current song (the main player is silent and follows it). */
    private var voiceLeads = false
    private var fadeJob: Job? = null
    /** The song (by index and id) whose end has been crossfaded, so it fades once. */
    private var handedOver: Pair<Int, String>? = null
    /** Seeks the crossfade makes on the main player itself: not taken for the user's. */
    private var ownSeek = false
    /**
     * The queue item the voice is fading in while the main player fades out and is still on the old
     * song (the main player catches up when the fade ends). Null when no such fade is running.
     */
    private var incoming: Int? = null
    private val _handover = kotlinx.coroutines.flow.MutableStateFlow<Handover?>(null)
    /** The crossfade under way, for the screens (they show the song fading out until it's done). */
    val handover: kotlinx.coroutines.flow.StateFlow<Handover?> = _handover

    init {
        scope.launch {
            while (isActive) {
                delay(if (nearEnd()) 10 else 50)
                tick()
            }
        }
        // The equaliser follows on the voice when it's changed.
        scope.launch { settings.collect { voiceProcessor?.let { mainProcessor.copyCurveTo(it) } } }
        main.addListener(object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                // Paused or played (the user, a call, headphones out): the voice does the same.
                voice?.let { v -> if (voiceLeads) v.playWhenReady = playWhenReady else if (!playWhenReady) fadeOutVoice(quick = true) }
            }
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                // The queue changed under the song the voice is sounding (it was removed, say): the main
                // player takes what's current now, and the voice goes quiet.
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED && voiceLeads) fadeOutVoice(quick = true)
            }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (ownSeek) return
                if (reason != Player.DISCONTINUITY_REASON_SEEK) return
                val v = voice ?: return
                if (voiceLeads && newPosition.mediaItemIndex == oldPosition.mediaItemIndex) {
                    // A seek within the song: the voice goes there too.
                    v.seekTo(newPosition.positionMs)
                } else {
                    // Another song chosen: the main player takes it, and the voice goes quiet.
                    stopLeading()
                    fadeOutVoice(quick = true)
                }
            }
        })
    }

    private fun fadeMs() = settings.value.crossfadeMs.coerceIn(0, MAX_MS)

    /**
     * The crossfade for a song of [durationMs]: the chosen length, or as much as fits a short song
     * (half of it, and half of the next song when its length is known), 0 when not even [MIN_MS] fits.
     */
    private fun fitted(durationMs: Long): Int {
        val nextLength = main.nextMediaItemIndex.takeIf { it != C.INDEX_UNSET }?.let { main.getMediaItemAt(it).mediaMetadata.durationMs } ?: 0L
        return fit(fadeMs(), durationMs, nextLength)
    }

    /** The player sounding the current song. */
    private fun sounding(): Player = voice?.takeIf { voiceLeads } ?: main

    /**
     * The sounding song's length: the player's, unless the library knows the song is longer. An MP3
     * whose VBR header counts too few frames reads as shorter than it plays, and the fade used to
     * start minutes early (a 15-minute song cut at 13).
     */
    private fun lengthOf(p: Player): Long {
        val known = p.currentMediaItem?.mediaMetadata?.durationMs ?: 0L
        return if (p.duration > 0 && known > p.duration + LENGTH_SLACK_MS) known else p.duration
    }

    private fun nearEnd(): Boolean {
        val p = sounding(); val d = lengthOf(p)
        return d > 0 && fadeMs() > 0 && p.currentPosition >= d - fitted(d) - 1_500
    }

    private fun key() = main.currentMediaItemIndex to main.currentMediaItem?.mediaId.orEmpty()

    private fun tick() {
        val v = voice
        if (voiceLeads && v != null) {
            // The silent main player kept in step with the voice (it drifts a little over a song).
            if (main.playWhenReady && v.isPlaying && abs(main.currentPosition - v.currentPosition) > RESYNC_MS) seekMain(main.currentMediaItemIndex, v.currentPosition)
            // The voice's song ended without a next one to fade into: the main player stops there too.
            if (v.playbackState == Player.STATE_ENDED) { stopLeading(); release(v); main.pause(); return }
        }
        val p = sounding()
        val duration = lengthOf(p)
        if (!p.isPlaying || duration <= 0) return
        val ms = fitted(duration)
        if (ms == 0) return
        if (handedOver == key()) return
        if (p.currentPosition >= duration - ms) crossfade(ms)
    }

    /** "Crossfade when skipping": a skip forward while playing fades instead of cutting. */
    fun skip(): Boolean {
        // Skipping again while a fade is bringing the next song in: that song is the current one now,
        // so this skip goes past it. (Each skip used to fade into the same song again: the main player
        // was still on the old one, so "next" was the song already fading in.)
        finishHandover()
        if (!settings.value.crossfadeOnSkip || !sounding().isPlaying) return false
        // A skip fades over the chosen length, or what's left of the song, if that's less.
        val p = sounding()
        val length = lengthOf(p)
        val ms = minOf(fitted(length.coerceAtLeast(0)).toLong(), (length - p.currentPosition).coerceAtLeast(0)).toInt()
        return ms >= MIN_MS && crossfade(ms)
    }

    /**
     * The next song starts on the other player, fading in over [ms], while the sounding one fades out.
     * Returns false when there's nothing to fade into (or a crossfade isn't wanted here).
     */
    private fun crossfade(ms: Int): Boolean {
        val next = main.nextMediaItemIndex.takeIf { it != C.INDEX_UNSET } ?: return false
        val current = main.currentMediaItem ?: return false
        handedOver = key()
        if (!allowed(current, main.getMediaItemAt(next))) return false
        val outgoing = voice?.takeIf { voiceLeads }
        android.util.Log.i("HiveSound", "Crossfade over $ms ms into queue item $next (${if (outgoing != null) "back on the main player" else "on the other player"})")
        val from = sounding()
        val handing = Handover(current.mediaId, main.getMediaItemAt(next).mediaId, from.currentPosition.coerceAtLeast(0), from.duration.coerceAtLeast(0), android.os.SystemClock.elapsedRealtime(), ms)
        if (outgoing != null) {
            // The voice has this song: the main player starts the next one, fading in, and the voice fades out.
            voiceLeads = false
            mainProcessor.fadeInOnNextFlush(ms)
            seekMain(next, 0)
            main.volume = 1f
            fadeOut(outgoing, ms)
            _handover.value = handing
        } else {
            // The main player has this song: the next one starts on a fresh voice, fading in.
            voice?.let { release(it) }
            val processor = EqualiserProcessor().also { mainProcessor.copyCurveTo(it) }
            val v = newCompanion(processor)
            voice = v; voiceProcessor = processor
            v.addListener(object : Player.Listener {
                override fun onTracksChanged(tracks: Tracks) { processor.setSongGain(songGain(tracks)) }
            })
            processor.fadeInOnNextFlush(ms)
            incoming = next
            _handover.value = handing
            v.setMediaItem(main.getMediaItemAt(next))
            v.volume = 1f
            v.prepare()
            v.play()
            // The main player fades this song out; when it's silent it moves to the next song too, and
            // follows the voice there with its sound off.
            fadeJob?.cancel()
            fadeJob = scope.launch {
                ramp(ms) { t -> main.volume = cos(t * PI / 2).toFloat() }
                if (voice !== v) return@launch
                finishHandover()
            }
        }
        return true
    }

    /** Fades [out] to silence over [ms], then lets it go. */
    private fun fadeOut(out: ExoPlayer, ms: Int) {
        fadeJob?.cancel()
        fadeJob = scope.launch {
            ramp(ms) { t -> out.volume = cos(t * PI / 2).toFloat() }
            _handover.value = null
            release(out)
        }
    }

    private suspend fun ramp(ms: Int, set: (Float) -> Unit) {
        val start = System.currentTimeMillis()
        while (true) {
            val t = ((System.currentTimeMillis() - start).toFloat() / ms).coerceIn(0f, 1f)
            set(t)
            if (t >= 1f) return
            delay(25)
        }
    }

    /**
     * The main player's listeners hear about a seek during seekTo() itself, so the flag only covers
     * this seek; left set, it would have hidden the user's next one.
     */
    private fun seekMain(index: Int, positionMs: Long) {
        ownSeek = true
        try { main.seekTo(index, positionMs) } finally { ownSeek = false }
    }

    /**
     * A fade from the main player to the voice still running: end it now. The main player goes
     * silent and joins the voice on the song it's fading in, which becomes the current song.
     */
    private fun finishHandover() {
        val v = voice ?: return
        val target = incoming ?: return
        incoming = null
        _handover.value = null
        fadeJob?.cancel()
        main.volume = 0f
        voiceLeads = true
        seekMain(target, v.currentPosition)
    }

    /** The main player sounds the current song itself again. */
    private fun stopLeading() {
        voiceLeads = false
        incoming = null
        _handover.value = null
        main.volume = 1f
    }

    /** The voice goes quiet ([quick]: over a moment, not cut) and is let go. */
    private fun fadeOutVoice(quick: Boolean) {
        val v = voice ?: return
        if (voiceLeads) stopLeading()
        incoming = null
        _handover.value = null
        fadeJob?.cancel()
        main.volume = 1f
        if (!quick) { release(v); return }
        scope.launch {
            val from = v.volume
            for (i in 1..6) { v.volume = from * (1f - i / 6f); delay(25) }
            release(v)
        }
    }

    private fun release(v: ExoPlayer) {
        v.release()
        if (voice === v) { voice = null; voiceProcessor = null; voiceLeads = false; incoming = null; _handover.value = null }
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

    fun close() { fadeJob?.cancel(); voice?.let { release(it) }; main.volume = 1f }

    companion object {
        /** The PC's limit. */
        const val MAX_MS = 15_000
        /** Shorter than this isn't a crossfade worth making: the songs just follow each other. */
        const val MIN_MS = 500L

        /**
         * The crossfade between a song of [songMs] and the next of [nextMs] (0: not known yet): the
         * [chosenMs] length, or as much as fits (half of each song), or 0 when not even [MIN_MS] does.
         */
        fun fit(chosenMs: Int, songMs: Long, nextMs: Long): Int {
            if (chosenMs <= 0 || songMs <= 0) return 0
            var fits = minOf(chosenMs.toLong(), (songMs - 500) / 2)
            if (nextMs > 0) fits = minOf(fits, nextMs / 2)
            return if (fits >= MIN_MS) fits.toInt() else 0
        }
        /** A library length this much past the player's means the player's is wrong. */
        const val LENGTH_SLACK_MS = 5_000L
        /** The silent main player is brought back in step with the voice when it drifts this far. */
        const val RESYNC_MS = 400L
    }
}

/**
 * A crossfade under way: [fromId] fades out (it was at [fromPositionMs] of [fromDurationMs] when the
 * fade began) while [toId] fades in, over [ms] from [startedAt] (SystemClock.elapsedRealtime).
 */
data class Handover(val fromId: String, val toId: String, val fromPositionMs: Long, val fromDurationMs: Long, val startedAt: Long, val ms: Int) {
    fun toBundle() = android.os.Bundle().apply {
        putString(KEY_FROM, fromId); putString(KEY_TO, toId)
        putLong(KEY_FROM_POSITION, fromPositionMs); putLong(KEY_FROM_DURATION, fromDurationMs)
        putLong(KEY_STARTED, startedAt); putInt(KEY_MS, ms)
    }
    companion object {
        private const val KEY_FROM = "hive.handover.from"
        private const val KEY_TO = "hive.handover.to"
        private const val KEY_FROM_POSITION = "hive.handover.fromPosition"
        private const val KEY_FROM_DURATION = "hive.handover.fromDuration"
        private const val KEY_STARTED = "hive.handover.started"
        private const val KEY_MS = "hive.handover.ms"
        fun from(b: android.os.Bundle?): Handover? {
            val from = b?.getString(KEY_FROM) ?: return null
            val to = b.getString(KEY_TO) ?: return null
            return Handover(from, to, b.getLong(KEY_FROM_POSITION), b.getLong(KEY_FROM_DURATION), b.getLong(KEY_STARTED), b.getInt(KEY_MS))
        }
    }
}
