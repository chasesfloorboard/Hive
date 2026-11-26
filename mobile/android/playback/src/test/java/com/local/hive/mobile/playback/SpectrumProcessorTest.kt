package com.local.hive.mobile.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class SpectrumProcessorTest {
    @Test
    fun silenceProducesZeroBands() {
        val bands = SpectrumFft.compute64Bands(FloatArray(SpectrumFft.FFT_SIZE), 48_000)
        assertEquals(64, bands.size)
        assertTrue("all bands silent", bands.all { it == 0f })
    }

    @Test
    fun sineWavePeaksInExpectedFrequencyBand() {
        val rate = 48_000
        val low = FloatArray(SpectrumFft.FFT_SIZE) { i -> sin(2.0 * PI * 100.0 * i / rate).toFloat() }
        val high = FloatArray(SpectrumFft.FFT_SIZE) { i -> sin(2.0 * PI * 4000.0 * i / rate).toFloat() }

        val lowBands = SpectrumFft.compute64Bands(low, rate)
        val highBands = SpectrumFft.compute64Bands(high, rate)

        val lowPeakIdx = lowBands.indices.maxByOrNull { lowBands[it] } ?: -1
        val highPeakIdx = highBands.indices.maxByOrNull { highBands[it] } ?: -1

        assertTrue("100 Hz peak should be loud (${lowBands[lowPeakIdx]})", lowBands[lowPeakIdx] > 0.8f)
        assertTrue("4 kHz peak should be loud (${highBands[highPeakIdx]})", highBands[highPeakIdx] > 0.8f)
        assertTrue("100 Hz band ($lowPeakIdx) should be well below 4 kHz band ($highPeakIdx)", lowPeakIdx in 10..20 && highPeakIdx in 45..58)
    }

    @Test
    fun spectrumBusTracksObserverLifecycle() {
        assertEquals(false, SpectrumBus.active)
        SpectrumBus.acquire()
        assertEquals(true, SpectrumBus.active)
        SpectrumBus.acquire()
        SpectrumBus.release()
        assertEquals(true, SpectrumBus.active)
        SpectrumBus.release()
        assertEquals(false, SpectrumBus.active)
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    @Test
    fun processorAccepts24Bit32BitFloatAndPassesThroughExoticWithoutThrowing() {
        val proc = SpectrumProcessor()
        val f24 = androidx.media3.common.audio.AudioProcessor.AudioFormat(96_000, 2, androidx.media3.common.C.ENCODING_PCM_24BIT)
        val f32 = androidx.media3.common.audio.AudioProcessor.AudioFormat(192_000, 2, androidx.media3.common.C.ENCODING_PCM_32BIT)
        val fFloat = androidx.media3.common.audio.AudioProcessor.AudioFormat(48_000, 2, androidx.media3.common.C.ENCODING_PCM_FLOAT)
        val exotic = androidx.media3.common.audio.AudioProcessor.AudioFormat(48_000, 2, androidx.media3.common.C.ENCODING_PCM_8BIT)
        assertEquals(f24, proc.configure(f24))
        assertEquals(f32, proc.configure(f32))
        assertEquals(fFloat, proc.configure(fFloat))
        assertEquals(androidx.media3.common.audio.AudioProcessor.AudioFormat.NOT_SET, proc.configure(exotic))
    }

    @Test
    fun timelinePreservesBurstFramesAndAlignsToOutputLatencyWithInterpolation() {
        val timeline = SpectrumTimeline()
        // Simulate ExoPlayer feeding a 300 ms refill burst in <1 ms wall time (15 frames, 20 ms apart).
        for (i in 1..15) {
            val bands = FloatArray(SpectrumBus.BANDS) { i / 15f }
            timeline.push(streamMs = i * 20.0, wallMs = 1_000L, bands = bands)
        }
        val out = FloatArray(SpectrumBus.BANDS)
        // With 240 ms target output lag, initial sample at wall=1000ms reads streamMs = 300 - 240 = 60 ms (frame 3 = 3/15 = 0.2).
        assertTrue(timeline.sample(nowWallMs = 1_000L, isPlaying = true, speed = 1f, targetLagMs = 240.0, out = out))
        assertEquals(3f / 15f, out[0], 0.01f)

        // 10 ms later (halfway between frame 3 at 60 ms and frame 4 at 80 ms) interpolates smoothly to 3.5/15.
        assertTrue(timeline.sample(nowWallMs = 1_010L, isPlaying = true, speed = 1f, targetLagMs = 240.0, out = out))
        assertEquals(3.5f / 15f, out[0], 0.01f)

        // 20 ms after start -> frame 4 (80 ms = 4/15). Burst frames were NOT discarded!
        assertTrue(timeline.sample(nowWallMs = 1_020L, isPlaying = true, speed = 1f, targetLagMs = 240.0, out = out))
        assertEquals(4f / 15f, out[0], 0.01f)

        // Pausing immediately returns silence (all zeros).
        assertEquals(false, timeline.sample(nowWallMs = 1_030L, isPlaying = false, speed = 1f, targetLagMs = 240.0, out = out))
        assertTrue(out.all { it == 0f })
    }

    @Test
    fun kickPitchSweepRollsSmoothlyFromRightToLeft() {
        val rate = 48_000
        val totalSamples = (rate * 0.4).toInt()
        val kickStart = (rate * 0.08).toInt()
        val pcm = FloatArray(totalSamples)
        var phase = 0.0
        for (i in kickStart until totalSamples) {
            val tMs = (i - kickStart) * 1000.0 / rate
            val freq = 46.0 + (220.0 - 46.0) * kotlin.math.exp(-tMs / 32.0)
            val amp = minOf(1.0, tMs / 1.5) * kotlin.math.exp(-tMs / 150.0)
            phase += 2.0 * PI * freq / rate
            pcm[i] = (0.9 * amp * sin(phase)).toFloat()
        }

        val win = FloatArray(SpectrumFft.FFT_SIZE)
        val half = SpectrumFft.FFT_SIZE / 2
        val peakBands = mutableListOf<Int>()
        for (tMs in 0..128 step 16) {
            val center = kickStart + (tMs * rate / 1000)
            for (i in 0 until SpectrumFft.FFT_SIZE) {
                val idx = center - half + i
                win[i] = if (idx in pcm.indices) pcm[idx] else 0f
            }
            val bands = SpectrumFft.compute64Bands(win, rate)
            peakBands += bands.indices.maxByOrNull { bands[it] } ?: -1
        }

        // Kick punch starts high (~band 15..20) and smoothly rolls left down to sub-bass (~band 2..5).
        assertTrue("kick starts at upper-bass band (${peakBands.first()})", peakBands.first() >= 14)
        assertTrue("kick ends at sub-bass band (${peakBands.last()})", peakBands.last() <= 5)
        for (i in 1 until peakBands.size) {
            assertTrue("peak rolls non-increasingly right-to-left: $peakBands", peakBands[i] <= peakBands[i - 1])
        }
        assertTrue("sweep traverses >= 4 distinct bands: $peakBands", peakBands.distinct().size >= 4)
    }
}
