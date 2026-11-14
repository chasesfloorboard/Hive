package com.local.hive.mobile.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer

/**
 * Caps hi-res playback (above [maxHz]) down to [maxHz] inside the app, so the AudioTrack is never
 * opened above the output device's own rate.
 *
 * Why this exists: a 96 kHz/24-bit FLAC played to a 48 kHz-only route (Bluetooth, LE Audio, the
 * phone speaker — none of them do 96 kHz) makes the platform resample 2:1 in its own mixer. On that
 * route the renderer could wedge part-way through a long song: the AudioTrack stopped draining while
 * ExoPlayer still reported PLAYING, so the position froze (observed sticking at ~4:13 of a 5:09
 * track; nudging past it recreated the AudioTrack timeline and it carried on). Resampling to the
 * device rate ourselves means the AudioTrack opens at 48 kHz and that fragile 2:1 platform resample
 * never happens.
 *
 * [SonicAudioProcessor] is `final`, so this wraps one rather than subclassing it. Sources at or below
 * [maxHz] (the ordinary 44.1/48 kHz library) are left bit-identical: the wrapper reports itself
 * inactive and the sink's processing pipeline bypasses it entirely.
 */
@UnstableApi
class DeviceRateCap(private val maxHz: Int = 48_000) : AudioProcessor {
    private val sonic = SonicAudioProcessor()
    private var active = false

    override fun configure(inputAudioFormat: AudioFormat): AudioFormat =
        // Only engage for hi-res 16-bit PCM — the one encoding SonicAudioProcessor handles, and the
        // one the sink delivers today (float output is off). Anything else passes through untouched,
        // so this can never fail a stream it doesn't understand.
        if (inputAudioFormat.sampleRate > maxHz && inputAudioFormat.encoding == C.ENCODING_PCM_16BIT) {
            sonic.setOutputSampleRateHz(maxHz)
            val out = sonic.configure(inputAudioFormat)
            active = sonic.isActive()
            out
        } else {
            // Leave it untouched: pass the format straight through so the pipeline skips us. The
            // inner Sonic is not configured here (it would reject a format it can't handle, and it is
            // reinitialised the next time a hi-res track makes us active anyway).
            active = false
            inputAudioFormat
        }

    override fun isActive(): Boolean = active

    override fun queueInput(inputBuffer: ByteBuffer) = sonic.queueInput(inputBuffer)

    override fun queueEndOfStream() = sonic.queueEndOfStream()

    override fun getOutput(): ByteBuffer = sonic.getOutput()

    override fun isEnded(): Boolean = sonic.isEnded()

    override fun flush(streamMetadata: StreamMetadata) = sonic.flush(streamMetadata)

    override fun reset() = sonic.reset()

    override fun getDurationAfterProcessorApplied(durationUs: Long): Long =
        sonic.getDurationAfterProcessorApplied(durationUs)
}
